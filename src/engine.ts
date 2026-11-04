import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	CheckpointConflictError,
	CheckpointDurabilityError,
	CheckpointLeaseError,
	CheckpointValidationError,
	type CheckpointRun,
	type CheckpointStore,
} from "./checkpoint.ts";
import { evaluateCondition } from "./condition.ts";
import type {
	AgentNodeDefinition,
	AgentThreadState,
	CheckpointSnapshot,
	CompiledGraph,
	ExecutionBudget,
	GraphDefinition,
	GraphLimits,
	GraphRunEvent,
	GraphRunOptions,
	GraphRunResult,
	InFlightNodeProgress,
	InFlightStep,
	JsonObject,
	NodeDefinition,
	NodeExecutionContext,
	NodeExecutionFailure,
	NodeExecutionResult,
	NodeExecutionSuccess,
	NodeExecutor,
	NodeLimits,
	NodeRunHistory,
	NodeUsage,
	StateWrite,
	TokenUsageLedger,
	UsageLedger,
} from "./types.ts";
import { END } from "./types.ts";
import {
	addUsage,
	applyStateWrites,
	asStringArray,
	deepCloneJson,
	deepMergeObjects,
	emptyUsage,
	errorMessage,
	getPath,
	isJsonObject,
	setPath,
	stateSizeBytes,
	uniqueStrings,
} from "./utils.ts";

type ResolvedGraphLimits = Required<Omit<GraphLimits, "maxSteps" | "maxNodeRuns" | "timeoutMs">> &
	Pick<GraphLimits, "maxSteps" | "maxNodeRuns" | "timeoutMs">;

const DEFAULT_LIMITS: ResolvedGraphLimits = {
	maxConcurrency: 4,
	maxCostUsd: 10,
	timeoutMs: undefined,
	maxStateBytes: 2 * 1024 * 1024,
	maxPromptBytes: 256 * 1024,
};

export interface GraphEngineConfig {
	checkpointStore?: CheckpointStore;
	graphSource?: string;
}

interface FailureResolution {
	success?: NodeExecutionSuccess;
	fatal?: NodeExecutionFailure;
	historyStatus: "completed" | "failed" | "interrupted";
	historyError?: string;
}

export class GraphLimitError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "GraphLimitError";
		this.code = code;
	}
}

export class GraphEngine {
	readonly graph: CompiledGraph;
	readonly executor: NodeExecutor;
	readonly checkpointStore: CheckpointStore | undefined;
	readonly graphSource: string | undefined;

	constructor(graph: CompiledGraph, executor: NodeExecutor, config: GraphEngineConfig = {}) {
		this.graph = graph;
		this.executor = executor;
		this.checkpointStore = config.checkpointStore;
		this.graphSource = config.graphSource;
	}

	async run(options: GraphRunOptions = {}): Promise<GraphRunResult> {
		const limits = resolveLimits(this.graph.definition.limits);
		const checkpointRequested = options.checkpoint ?? true;
		if (options.runId && !checkpointRequested) throw new Error("Cannot resume with checkpoint: false");
		const checkpointEnabled = checkpointRequested && this.checkpointStore !== undefined;
		const invocationStartedAt = Date.now();
		let baseActiveTimeMs = 0;
		let checkpointRun: CheckpointRun | undefined;
		let resumeInterruptNodeId: string | undefined;
		try {
			let snapshot: CheckpointSnapshot;
			if (options.runId) {
				if (!this.checkpointStore) throw new Error("Cannot resume without a checkpoint store");
				checkpointRun = await this.checkpointStore.open({ mode: "resume", runId: options.runId });
				snapshot = checkpointRun.snapshot;
				baseActiveTimeMs = snapshot.activeTimeMs;
				this.assertCheckpointGraph(snapshot, options.forceGraphVersion ?? false);
				if (snapshot.status === "completed") return resultFromSnapshot(snapshot, this.graph.definition);
				if (snapshot.interrupt && options.resumeValue === undefined) return resultFromSnapshot(snapshot, this.graph.definition);
				resumeInterruptNodeId = snapshot.interrupt?.nodeId;
				snapshot.interrupt = undefined;
				snapshot.status = "running";
				snapshot.error = undefined;
				snapshot.endedAt = undefined;
				snapshot.updatedAt = nowIso();
			} else {
				snapshot = this.createSnapshot(options.input ?? {});
				if (checkpointEnabled && this.checkpointStore) {
					checkpointRun = await this.checkpointStore.open({ mode: "create", snapshot });
				}
			}

			const runOptions = checkpointRun
				? { ...options, signal: options.signal ? AbortSignal.any([options.signal, checkpointRun.signal]) : checkpointRun.signal }
				: options;
			const budget = new GraphBudget(snapshot.usage, limits, (usage) => {
				snapshot.usage = copyUsage(usage);
			});

			try {
				this.assertStateWithinPolicy(snapshot.state, limits);
				await this.emit(runOptions, {
					type: "graph_start",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					status: "running",
					usage: copyTokenUsage(snapshot.usage),
				});
				if (options.runId) {
					await this.save(snapshot, checkpointRun, runOptions, baseActiveTimeMs, invocationStartedAt);
				}

				while (true) {
					this.assertRunActive(snapshot, runOptions.signal, limits, baseActiveTimeMs, invocationStartedAt);
					budget.assertGraphWithinLimits();

					if (!snapshot.inFlight) {
						const scheduled = uniqueStrings(snapshot.pending.filter((nodeId) => nodeId !== END));
						if (scheduled.length === 0) {
							return await this.finish(
								snapshot,
								"completed",
								undefined,
								checkpointRun,
								runOptions,
								baseActiveTimeMs,
								invocationStartedAt,
							);
						}
						if (limits.maxSteps !== undefined && snapshot.step >= limits.maxSteps) {
							throw new GraphLimitError("MAX_STEPS", `Graph exceeded maxSteps (${limits.maxSteps})`);
						}
						snapshot.step += 1;
						snapshot.pending = [];
						snapshot.inFlight = {
							step: snapshot.step,
							scheduled,
							unresolved: [...scheduled],
							completed: {},
						};
						this.prepareThreadStates(snapshot, scheduled);
						await this.emit(runOptions, {
							type: "step_start",
							runId: snapshot.runId,
							timestamp: nowIso(),
							step: snapshot.step,
							scheduled: [...scheduled],
							message: scheduled.join(", "),
						});
						await this.save(snapshot, checkpointRun, runOptions, baseActiveTimeMs, invocationStartedAt);
					}

					const stepResult = await this.executeInFlight(
						snapshot,
						resumeInterruptNodeId,
						budget,
						limits,
						runOptions,
						checkpointRun,
						baseActiveTimeMs,
						invocationStartedAt,
					);
					resumeInterruptNodeId = undefined;
					if (stepResult) return stepResult;
				}
			} catch (error) {
				if (isCheckpointControlError(error)) throw error;
				if (checkpointRun?.signal.aborted) {
					throw checkpointRun.signal.reason ?? new CheckpointLeaseError("RUN_LEASE_LOST", `Lease for ${snapshot.runId} was lost`);
				}
				const status = runOptions.signal?.aborted ? "cancelled" : "failed";
				return await this.finish(
					snapshot,
					status,
					errorMessage(error),
					checkpointRun,
					runOptions,
					baseActiveTimeMs,
					invocationStartedAt,
					false,
				);
			}
		} finally {
			await closeCheckpointRun(checkpointRun);
		}
	}

	private async executeInFlight(
		snapshot: CheckpointSnapshot,
		resumeInterruptNodeId: string | undefined,
		budget: GraphBudget,
		limits: ResolvedGraphLimits,
		options: GraphRunOptions,
		checkpointRun: CheckpointRun | undefined,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
	): Promise<GraphRunResult | undefined> {
		const inFlight = snapshot.inFlight;
		if (!inFlight) throw new Error("Missing in-flight step");
		const threadsChanged = this.prepareThreadStates(snapshot, inFlight.scheduled);
		this.assertNoConcurrentThreadContexts(inFlight.scheduled);
		if (threadsChanged) {
			await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
		}
		let checkpointWork = Promise.resolve();
		const saveProgress = (): Promise<void> => {
			checkpointWork = checkpointWork.then(() =>
				this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt),
			);
			return checkpointWork;
		};
		const unresolved = [...inFlight.unresolved];
		const results = await mapWithConcurrencyLimit(unresolved, limits.maxConcurrency, async (nodeId) => {
			const node = this.graph.definition.nodes[nodeId];
			const result = node
				? await this.executeNodeWithRetry(
						snapshot,
						nodeId,
						node,
						resumeInterruptNodeId,
						budget,
						limits,
						options,
						saveProgress,
						baseActiveTimeMs,
						invocationStartedAt,
					)
				: failureResult(`Unknown scheduled node ${nodeId}`, "UNKNOWN_NODE", false, 1, nowIso(), nowIso());
			await this.emit(options, {
				type: "node_settled",
				runId: snapshot.runId,
				timestamp: nowIso(),
				step: snapshot.step,
				nodeId,
				attempt: result.attempts,
				status:
					options.signal?.aborted
						? "cancelled"
						: result.kind === "success"
							? "completed"
							: result.kind === "interrupt"
								? "interrupted"
								: "failed",
				message:
					result.kind === "failure"
						? result.error
						: result.kind === "interrupt"
							? result.interrupt.prompt
							: undefined,
				usage: copyTokenUsage(budget.usage),
			});
			return result;
		});
		snapshot.usage = copyUsage(budget.usage);
		let terminalError: unknown;
		try {
			this.assertRunActive(snapshot, options.signal, limits, baseActiveTimeMs, invocationStartedAt);
		} catch (error) {
			terminalError = error;
		}
		if (
			terminalError &&
			!checkpointRun?.signal.aborted &&
			(options.signal?.aborted || (terminalError instanceof GraphLimitError && terminalError.code === "TIMEOUT"))
		) {
			const historyStatus: NodeRunHistory["status"] = options.signal?.aborted ? "cancelled" : "failed";
			for (let index = 0; index < unresolved.length; index++) {
				const nodeId = unresolved[index];
				const result = results[index];
				if (result.kind === "success") {
					inFlight.completed[nodeId] = result;
					inFlight.unresolved = inFlight.unresolved.filter((item) => item !== nodeId);
					if (inFlight.progress) delete inFlight.progress[nodeId];
					this.appendHistory(snapshot, nodeId, result, "completed");
					await this.emit(options, {
						type: "node_end",
						runId: snapshot.runId,
						timestamp: nowIso(),
						step: snapshot.step,
						nodeId,
						status: "completed",
						usage: copyTokenUsage(snapshot.usage),
					});
					continue;
				}
				if (result.attempts === 0) continue;
				const historyError = result.kind === "failure" ? result.error : errorMessage(terminalError);
				const durableUsage = inFlight.progress?.[nodeId]?.usage;
				const historyResult = durableUsage
					? { ...result, usage: usageDifference(result.usage, durableUsage) }
					: result;
				this.appendHistory(snapshot, nodeId, historyResult, historyStatus, historyError);
				await this.emit(options, {
					type: "node_end",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					status: historyStatus,
					message: historyError,
					usage: copyTokenUsage(snapshot.usage),
				});
			}
			throw terminalError;
		}
		if (terminalError) throw terminalError;

		const fatalFailures: Array<{ nodeId: string; failure: NodeExecutionFailure }> = [];
		const interrupts: Array<{ nodeId: string; result: Extract<NodeExecutionResult, { kind: "interrupt" }> }> = [];

		for (let index = 0; index < unresolved.length; index++) {
			const nodeId = unresolved[index];
			const result = results[index];
			const node = this.graph.definition.nodes[nodeId];
			if (!node) continue;

			if (result.kind === "interrupt") {
				interrupts.push({ nodeId, result });
				if (inFlight.progress) delete inFlight.progress[nodeId];
				this.appendHistory(snapshot, nodeId, result, "interrupted");
				await this.emit(options, {
					type: "node_end",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					status: "interrupted",
				});
				continue;
			}

			const resolution = result.kind === "failure" ? resolveFailure(nodeId, node, result) : successResolution(result);
			if (resolution.success) {
				inFlight.completed[nodeId] = resolution.success;
				inFlight.unresolved = inFlight.unresolved.filter((item) => item !== nodeId);
				if (inFlight.progress) delete inFlight.progress[nodeId];
				this.appendHistory(
					snapshot,
					nodeId,
					resolution.success,
					resolution.historyStatus,
					resolution.historyError,
				);
				await this.emit(options, {
					type: "node_end",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					status: resolution.historyStatus,
					message: resolution.historyError,
					usage: copyTokenUsage(snapshot.usage),
				});
				await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
			} else if (resolution.fatal) {
				if (inFlight.progress) delete inFlight.progress[nodeId];
				fatalFailures.push({ nodeId, failure: resolution.fatal });
				this.appendHistory(snapshot, nodeId, resolution.fatal, "failed", resolution.fatal.error);
				await this.emit(options, {
					type: "node_end",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					status: "failed",
					message: resolution.fatal.error,
					usage: copyTokenUsage(snapshot.usage),
				});
			}
		}

		snapshot.usage = copyUsage(budget.usage);

		if (fatalFailures.length > 0) {
			const error = fatalFailures.map((item) => `${item.nodeId}: ${item.failure.error}`).join("; ");
			return await this.finish(
				snapshot,
				"failed",
				error,
				checkpointRun,
				options,
				baseActiveTimeMs,
				invocationStartedAt,
				false,
			);
		}

		if (interrupts.length > 0) {
			const first = inFlight.scheduled
				.map((nodeId) => interrupts.find((item) => item.nodeId === nodeId))
				.find((item) => item !== undefined);
			if (!first) throw new Error("Interrupt result disappeared");
			snapshot.status = "interrupted";
			snapshot.interrupt = first.result.interrupt;
			snapshot.error = undefined;
			snapshot.updatedAt = nowIso();
			await this.emit(options, {
				type: "interrupt",
				runId: snapshot.runId,
				timestamp: nowIso(),
				step: snapshot.step,
				nodeId: first.nodeId,
				status: "interrupted",
				message: first.result.interrupt.prompt,
			});
			await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
			await this.emit(options, {
				type: "graph_end",
				runId: snapshot.runId,
				timestamp: nowIso(),
				step: snapshot.step,
				status: "interrupted",
				usage: copyTokenUsage(snapshot.usage),
			});
			return resultFromSnapshot(snapshot, this.graph.definition);
		}

		await this.commitStep(snapshot, inFlight, limits);
		await this.emit(options, {
			type: "step_end",
			runId: snapshot.runId,
			timestamp: nowIso(),
			step: snapshot.step,
			status: "completed",
			usage: copyTokenUsage(snapshot.usage),
		});
		if (snapshot.pending.length === 0) {
			return await this.finish(
				snapshot,
				"completed",
				undefined,
				checkpointRun,
				options,
				baseActiveTimeMs,
				invocationStartedAt,
			);
		}
		await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
		return undefined;
	}

	private async executeNodeWithRetry(
		snapshot: CheckpointSnapshot,
		nodeId: string,
		node: NodeDefinition,
		resumeInterruptNodeId: string | undefined,
		budget: GraphBudget,
		limits: ResolvedGraphLimits,
		options: GraphRunOptions,
		saveProgress: () => Promise<void>,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
	): Promise<NodeExecutionResult> {
		const maxAttempts = Math.max(1, node.retry?.maxAttempts ?? 1);
		const initialBackoff = Math.max(0, node.retry?.backoffMs ?? 0);
		const multiplier = Math.max(1, node.retry?.backoffMultiplier ?? 2);
		const inFlight = snapshot.inFlight;
		if (!inFlight) throw new Error("Missing in-flight step");
		inFlight.progress ??= {};
		let resumedProgress: InFlightNodeProgress | undefined = inFlight.progress[nodeId];
		const aggregate: NodeUsage = resumedProgress ? copyNodeUsage(resumedProgress.priorUsage) : emptyUsage();
		const startedAt = nowIso();
		let lastFailure: NodeExecutionFailure | undefined;

		for (let attempt = resumedProgress?.attempt ?? 1; attempt <= maxAttempts; attempt++) {
			let attemptStarted = false;
			let scopedBudget: ScopedExecutionBudget | undefined;
			let mergedAttemptUsage = false;
			const mergeAttemptUsage = () => {
				if (mergedAttemptUsage || !scopedBudget) return;
				mergeNodeUsage(aggregate, scopedBudget.usage);
				mergedAttemptUsage = true;
			};
			try {
				this.assertRunActive(snapshot, options.signal, limits, baseActiveTimeMs, invocationStartedAt);
				let progress: InFlightNodeProgress;
				if (resumedProgress && resumedProgress.attempt === attempt) {
					if (limits.maxNodeRuns !== undefined && snapshot.nodeRuns >= limits.maxNodeRuns) {
						throw new GraphLimitError("MAX_NODE_RUNS", `Graph exceeded maxNodeRuns (${limits.maxNodeRuns})`);
					}
					snapshot.nodeRuns += 1;
					progress = resumedProgress;
					await saveProgress();
				} else {
					if (limits.maxNodeRuns !== undefined && snapshot.nodeRuns >= limits.maxNodeRuns) {
						throw new GraphLimitError("MAX_NODE_RUNS", `Graph exceeded maxNodeRuns (${limits.maxNodeRuns})`);
					}
					snapshot.nodeRuns += 1;
					progress = {
						attempt,
						executionId: executionId(snapshot.runId, snapshot.step, nodeId, attempt),
						accountedTurnIds: [],
						priorUsage: copyNodeUsage(aggregate),
						usage: emptyUsage(),
					};
					inFlight.progress[nodeId] = progress;
					await saveProgress();
				}
				attemptStarted = true;
				await this.emit(options, {
					type: "node_start",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					attempt,
					message: resumedProgress ? "resumed durable attempt" : undefined,
				});

				const executionBudget = new ScopedExecutionBudget(budget, nodeId, node.limits, (usage) => {
					void this.emit(options, {
						type: "usage_update",
						runId: snapshot.runId,
						timestamp: nowIso(),
						step: snapshot.step,
						nodeId,
						attempt,
						status: "running",
						usage: copyTokenUsage(usage),
					});
				}, progress.usage);
				scopedBudget = executionBudget;
				const activeTime = baseActiveTimeMs + Math.max(0, Date.now() - invocationStartedAt);
				const nodeTimeoutMs = node.limits?.timeoutMs;
				const graphTimeoutMs = limits.timeoutMs;
				const remainingGraphTime = graphTimeoutMs !== undefined ? graphTimeoutMs - activeTime : undefined;
				const effectiveTimeoutMs =
					remainingGraphTime !== undefined
						? Math.max(1, Math.min(remainingGraphTime, nodeTimeoutMs ?? remainingGraphTime))
						: nodeTimeoutMs;
				const timeoutController = new AbortController();
				let timeoutKind: "node" | "graph" | undefined;
				const timeout =
						effectiveTimeoutMs !== undefined
						? setTimeout(() => {
								timeoutKind = nodeTimeoutMs !== undefined && (remainingGraphTime === undefined || nodeTimeoutMs < remainingGraphTime) ? "node" : "graph";
								timeoutController.abort();
						}, effectiveTimeoutMs)
						: undefined;
				const forwardAbort = () => timeoutController.abort();
				if (options.signal?.aborted) forwardAbort();
				else options.signal?.addEventListener("abort", forwardAbort, { once: true });
				const context: NodeExecutionContext = {
					runId: snapshot.runId,
					step: snapshot.step,
					nodeId,
					attempt,
					executionId: progress.executionId,
					state: deepCloneJson(snapshot.state),
					graph: this.graph,
					thread: this.threadForNode(snapshot, nodeId, node),
					resumeValue: resumeInterruptNodeId === nodeId ? options.resumeValue : undefined,
					signal: timeoutController.signal,
					budget: executionBudget,
					recordTurn: async (turn) => {
						if (progress.accountedTurnIds.includes(turn.id)) return;
						executionBudget.report(turn.usage);
						progress.accountedTurnIds.push(turn.id);
						progress.usage = copyNodeUsage(executionBudget.usage);
						await saveProgress();
					},
					onEvent: options.onEvent,
				};
				let result: NodeExecutionResult | undefined;
				let executionFailed = false;
				let executionError: unknown;
				try {
					result = await this.executor.execute(node, context);
				} catch (error) {
					executionFailed = true;
					executionError = error;
				} finally {
					if (context.thread) {
						context.thread.invocationCount += 1;
						context.thread.lastNodeId = nodeId;
						context.thread.updatedAt = nowIso();
						context.thread.nodes = uniqueStrings([...context.thread.nodes, nodeId]);
					}
					clearTimeout(timeout);
					options.signal?.removeEventListener("abort", forwardAbort);
				}
				if (timeoutKind === "node") {
					throw new GraphLimitError("NODE_TIMEOUT", `Node ${nodeId} exceeded timeoutMs (${nodeTimeoutMs})`);
				}
				if (timeoutKind === "graph") throw new GraphLimitError("TIMEOUT", `Graph exceeded timeoutMs (${graphTimeoutMs})`);
				if (executionFailed) throw executionError;
				if (!result) throw new Error(`Node executor returned no result for ${nodeId}`);
				executionBudget.reconcile(result.usage);
				executionBudget.assertWithinLimits(nodeId, executionBudget.usage, node.limits);
				mergeAttemptUsage();

				if (result.kind === "success") {
					return { ...result, attempts: attempt, usage: withModel(aggregate, result.usage.model), startedAt, endedAt: nowIso() };
				}
				if (result.kind === "interrupt") {
					return { ...result, attempts: attempt, usage: withModel(aggregate, result.usage.model), startedAt, endedAt: nowIso() };
				}
				lastFailure = {
					...result,
					attempts: attempt,
					usage: withModel(aggregate, result.usage.model),
					startedAt,
					endedAt: nowIso(),
				};
				resumedProgress = undefined;
			} catch (error) {
				if (
					!attemptStarted &&
					(options.signal?.aborted || (error instanceof GraphLimitError && error.code === "TIMEOUT"))
				) {
					return failureResult(errorMessage(error), "ABORTED", false, 0, startedAt, nowIso(), aggregate);
				}
				mergeAttemptUsage();
				const retryable = (!(error instanceof GraphLimitError) || error.code === "NODE_TIMEOUT") && !options.signal?.aborted;
				lastFailure = failureResult(
					errorMessage(error),
					error instanceof GraphLimitError ? error.code : "EXECUTION_ERROR",
					retryable,
					attempt,
					startedAt,
					nowIso(),
					aggregate,
				);
				resumedProgress = undefined;
			}

			if (!lastFailure.retryable || attempt >= maxAttempts) return lastFailure;
			const backoff = Math.round(initialBackoff * multiplier ** (attempt - 1));
			await this.emit(options, {
				type: "node_retry",
				runId: snapshot.runId,
				timestamp: nowIso(),
				step: snapshot.step,
				nodeId,
				attempt: attempt + 1,
				message: lastFailure.error,
			});
			if (backoff > 0) {
				try {
					await delay(backoff, undefined, { signal: options.signal });
				} catch (error) {
					return failureResult(errorMessage(error), "ABORTED", false, attempt, startedAt, nowIso(), aggregate);
				}
			}
		}

		return lastFailure ?? failureResult("Node failed without a result", "UNKNOWN", false, maxAttempts, startedAt, nowIso(), aggregate);
	}

	private async commitStep(snapshot: CheckpointSnapshot, inFlight: InFlightStep, limits: ResolvedGraphLimits): Promise<void> {
		const orderedResults = inFlight.scheduled.map((nodeId) => {
			const result = inFlight.completed[nodeId];
			if (!result) throw new Error(`Step ${inFlight.step} is missing result for ${nodeId}`);
			return { nodeId, result };
		});
		const writes: StateWrite[] = orderedResults.flatMap((item) => item.result.writes);
		snapshot.state = applyStateWrites(snapshot.state, writes, this.graph.reducers);
		this.pruneSharedMessageChannels(snapshot.state);
		this.assertStateWithinPolicy(snapshot.state, limits);

		for (const nodeId of inFlight.scheduled) snapshot.completionCounts[nodeId] = (snapshot.completionCounts[nodeId] ?? 0) + 1;
		const next: string[] = [];
		for (const { nodeId, result } of orderedResults) {
			if (result.next !== undefined) {
				next.push(...result.next);
				continue;
			}
			const conditionalEdge = this.graph.conditionalEdgesByNode.get(nodeId);
			if (conditionalEdge) {
				const selected = conditionalEdge.cases.find((item) => evaluateCondition(item.when, snapshot.state));
				if (selected) next.push(...asStringArray(selected.to));
				else if (conditionalEdge.default !== undefined) next.push(...asStringArray(conditionalEdge.default));
			}
			for (const edge of this.graph.staticEdges) {
				if (!edge.barrier && edge.from[0] === nodeId) next.push(...edge.to);
			}
		}

		for (const edge of this.graph.staticEdges.filter((item) => item.barrier)) {
			const consumed = snapshot.barrierConsumed[edge.id] ?? {};
			if (edge.from.every((source) => (snapshot.completionCounts[source] ?? 0) > (consumed[source] ?? 0))) {
				for (const source of edge.from) consumed[source] = (consumed[source] ?? 0) + 1;
				snapshot.barrierConsumed[edge.id] = consumed;
				next.push(...edge.to);
			}
		}

		snapshot.pending = uniqueStrings(next.filter((nodeId) => nodeId !== END));
		snapshot.inFlight = undefined;
		snapshot.interrupt = undefined;
		snapshot.status = "running";
		snapshot.error = undefined;
		snapshot.updatedAt = nowIso();
	}

	private pruneSharedMessageChannels(state: JsonObject): void {
		const limits = new Map<string, number>();
		for (const node of Object.values(this.graph.definition.nodes)) {
			if (node.type !== "agent" || (node.context?.mode ?? "isolated") !== "shared") continue;
			if ((node.context?.capture ?? "compact") === "none") continue;
			const maxStoredMessages = node.context?.maxStoredMessages;
			if (maxStoredMessages === undefined) continue;
			const path = node.context?.messagesPath ?? "messages";
			const current = limits.get(path);
			limits.set(path, current === undefined ? maxStoredMessages : Math.min(current, maxStoredMessages));
		}

		for (const [path, maxStoredMessages] of limits) {
			const value = getPath(state, path);
			if (value === undefined) continue;
			if (!Array.isArray(value)) {
				throw new GraphLimitError("SHARED_CONTEXT_INVALID", `Shared messages state at ${path} must be an array`);
			}
			if (value.length > maxStoredMessages) {
				setPath(state, path, deepCloneJson(value.slice(-maxStoredMessages)));
			}
		}
	}

	private assertStateWithinPolicy(state: JsonObject, limits: ResolvedGraphLimits): void {
		const stateBytes = stateSizeBytes(state);
		if (stateBytes > limits.maxStateBytes) {
			throw new GraphLimitError("MAX_STATE_BYTES", `Graph state is ${stateBytes} bytes; maxStateBytes is ${limits.maxStateBytes}`);
		}
		const policy = this.graph.definition.statePolicy;
		for (const [path, pathPolicy] of Object.entries(policy?.paths ?? {})) {
			if (pathPolicy.maxBytes === undefined) continue;
			const value = getPath(state, path);
			if (value === undefined) continue;
			const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
			if (bytes > pathPolicy.maxBytes) {
				throw new GraphLimitError(
					"MAX_STATE_PATH_BYTES",
					`Graph state path ${path} is ${bytes} bytes; configured maxBytes is ${pathPolicy.maxBytes}`,
				);
			}
		}
	}

	private prepareThreadStates(snapshot: CheckpointSnapshot, nodeIds: string[]): boolean {
		snapshot.threads ??= {};
		let changed = false;
		for (const nodeId of nodeIds) {
			const node = this.graph.definition.nodes[nodeId];
			if (!isThreadNode(node)) continue;
			const key = node.context?.threadKey ?? nodeId;
			const existing = snapshot.threads[key];
			if (existing) {
				if (!Number.isInteger(existing.invocationCount) || existing.invocationCount < 0) {
					existing.invocationCount = 0;
					changed = true;
				}
				const nodes = uniqueStrings([...existing.nodes, nodeId]);
				if (nodes.length !== existing.nodes.length) {
					existing.nodes = nodes;
					existing.updatedAt = nowIso();
					changed = true;
				}
				continue;
			}
			const timestamp = nowIso();
			snapshot.threads[key] = {
				key,
				sessionId: randomUUID(),
				createdAt: timestamp,
				updatedAt: timestamp,
				nodes: [nodeId],
				invocationCount: 0,
			};
			changed = true;
		}
		return changed;
	}

	private assertNoConcurrentThreadContexts(nodeIds: string[]): void {
		const byKey = new Map<string, string[]>();
		for (const nodeId of nodeIds) {
			const node = this.graph.definition.nodes[nodeId];
			if (!isThreadNode(node)) continue;
			const key = node.context?.threadKey ?? nodeId;
			const nodes = byKey.get(key) ?? [];
			nodes.push(nodeId);
			byKey.set(key, nodes);
		}
		for (const [key, nodes] of byKey) {
			if (nodes.length > 1) {
				throw new Error(
					`Thread context ${JSON.stringify(key)} is scheduled concurrently by ${nodes.join(", ")} in step ${nodeIds.join(", ")}.`,
				);
			}
		}
	}

	private threadForNode(
		snapshot: CheckpointSnapshot,
		nodeId: string,
		node: NodeDefinition,
	): AgentThreadState | undefined {
		if (!isThreadNode(node)) return undefined;
		const key = node.context?.threadKey ?? nodeId;
		const thread = snapshot.threads?.[key];
		if (!thread) throw new Error(`Missing durable thread state for ${JSON.stringify(key)}`);
		return thread;
	}

	private createSnapshot(input: JsonObject): CheckpointSnapshot {
		const timestamp = nowIso();
		const initial = deepMergeObjects(this.graph.definition.initialState ?? {}, { input: deepCloneJson(input) });
		return {
			version: 2,
			runId: randomUUID(),
			graphName: this.graph.definition.name,
			graphHash: this.graph.hash,
			graphSource: this.graphSource,
			status: "running",
			createdAt: timestamp,
			updatedAt: timestamp,
			startedAt: timestamp,
			activeTimeMs: 0,
			step: 0,
			nodeRuns: 0,
			state: initial,
			pending: uniqueStrings(asStringArray(this.graph.definition.entry).filter((nodeId) => nodeId !== END)),
			completionCounts: {},
			barrierConsumed: {},
			usage: emptyUsage(),
			history: [],
			threads: {},
		};
	}

	private assertCheckpointGraph(snapshot: CheckpointSnapshot, force: boolean): void {
		if (snapshot.graphName !== this.graph.definition.name) {
			throw new Error(`Checkpoint graph is ${snapshot.graphName}, not ${this.graph.definition.name}`);
		}
		if (snapshot.graphHash !== this.graph.hash && !force) {
			throw new Error(
				`Graph definition changed since checkpoint ${snapshot.runId}. Re-run with forceGraphVersion only after reviewing idempotency and state compatibility.`,
			);
		}
	}

	private assertRunActive(
		snapshot: CheckpointSnapshot,
		signal: AbortSignal | undefined,
		limits: ResolvedGraphLimits,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
	): void {
		if (signal?.aborted) throw new Error("Graph run aborted");
		const active = baseActiveTimeMs + Math.max(0, Date.now() - invocationStartedAt);
		if (limits.timeoutMs !== undefined && active > limits.timeoutMs) throw new GraphLimitError("TIMEOUT", `Graph exceeded timeoutMs (${limits.timeoutMs})`);
		if (limits.maxNodeRuns !== undefined && snapshot.nodeRuns > limits.maxNodeRuns) {
			throw new GraphLimitError("MAX_NODE_RUNS", `Graph exceeded maxNodeRuns (${limits.maxNodeRuns})`);
		}
	}

	private appendHistory(
		snapshot: CheckpointSnapshot,
		nodeId: string,
		result: NodeExecutionResult,
		status: NodeRunHistory["status"],
		error?: string,
	): void {
		snapshot.history.push({
			step: snapshot.step,
			nodeId,
			status,
			attempts: result.attempts,
			startedAt: result.startedAt,
			endedAt: result.endedAt,
			usage: result.usage,
			error,
		});
	}

	private async finish(
		snapshot: CheckpointSnapshot,
		status: "completed" | "failed" | "cancelled",
		error: string | undefined,
		checkpointRun: CheckpointRun | undefined,
		options: GraphRunOptions,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
		clearInFlight = true,
	): Promise<GraphRunResult> {
		snapshot.status = status;
		snapshot.error = error;
		snapshot.endedAt = nowIso();
		snapshot.updatedAt = snapshot.endedAt;
		if (status === "completed" || clearInFlight) {
			snapshot.inFlight = undefined;
			snapshot.pending = status === "completed" ? [] : snapshot.pending;
		}
		if (status !== "completed") snapshot.interrupt = undefined;
		await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
		await this.emit(options, {
			type: "graph_end",
			runId: snapshot.runId,
			timestamp: nowIso(),
			step: snapshot.step,
			status,
			message: error,
			usage: copyTokenUsage(snapshot.usage),
		});
		return resultFromSnapshot(snapshot, this.graph.definition);
	}

	private async save(
		snapshot: CheckpointSnapshot,
		checkpointRun: CheckpointRun | undefined,
		options: GraphRunOptions,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
	): Promise<void> {
		snapshot.activeTimeMs = baseActiveTimeMs + Math.max(0, Date.now() - invocationStartedAt);
		snapshot.updatedAt = nowIso();
		if (!checkpointRun) return;
		await checkpointRun.commit(snapshot);
		await this.emit(options, {
			type: "checkpoint",
			runId: snapshot.runId,
			timestamp: nowIso(),
			step: snapshot.step,
			status: snapshot.status,
		});
	}

	private async emit(options: GraphRunOptions, event: GraphRunEvent): Promise<void> {
		if (!options.onEvent) return;
		try {
			await options.onEvent(event);
		} catch {
			// Observability callbacks are non-critical and must not alter graph control flow.
		}
	}
}

class GraphBudget implements ExecutionBudget {
	readonly usage: UsageLedger;
	private readonly limits: ResolvedGraphLimits;
	private readonly onUsage: ((usage: UsageLedger) => void) | undefined;

	constructor(initial: UsageLedger, limits: ResolvedGraphLimits, onUsage?: (usage: UsageLedger) => void) {
		this.usage = copyUsage(initial);
		this.limits = limits;
		this.onUsage = onUsage;
	}

	report(delta: Partial<UsageLedger>): void {
		try {
			addUsage(this.usage, delta);
			this.assertGraphWithinLimits();
		} finally {
			this.onUsage?.(copyUsage(this.usage));
		}
	}

	assertWithinLimits(_nodeId: string, _nodeUsage: UsageLedger, _nodeLimits?: NodeLimits): void {
		this.assertGraphWithinLimits();
	}

	assertGraphWithinLimits(): void {
		if (this.usage.costUsd > this.limits.maxCostUsd) {
			throw new GraphLimitError("MAX_COST", `Graph cost $${this.usage.costUsd.toFixed(4)} exceeded maxCostUsd $${this.limits.maxCostUsd}`);
		}
	}
}

class ScopedExecutionBudget implements ExecutionBudget {
	readonly usage: UsageLedger;
	private readonly parent: GraphBudget;
	private readonly nodeId: string;
	private readonly nodeLimits: NodeLimits | undefined;
	private readonly onUsage: ((usage: UsageLedger) => void) | undefined;

	constructor(
		parent: GraphBudget,
		nodeId: string,
		nodeLimits: NodeLimits | undefined,
		onUsage?: (usage: UsageLedger) => void,
		initial: UsageLedger = emptyUsage(),
	) {
		this.parent = parent;
		this.nodeId = nodeId;
		this.nodeLimits = nodeLimits;
		this.onUsage = onUsage;
		this.usage = copyUsage(initial);
	}

	report(delta: Partial<UsageLedger>): void {
		addUsage(this.usage, delta);
		try {
			this.parent.report(delta);
		} finally {
			this.onUsage?.(copyUsage(this.parent.usage));
		}
		this.assertWithinLimits(this.nodeId, this.usage, this.nodeLimits);
	}

	assertWithinLimits(nodeId: string, nodeUsage: UsageLedger, nodeLimits = this.nodeLimits): void {
		this.parent.assertGraphWithinLimits();
		if (nodeLimits?.maxCostUsd !== undefined && nodeUsage.costUsd > nodeLimits.maxCostUsd) {
			throw new GraphLimitError(
				"NODE_MAX_COST",
				`Node ${nodeId} cost $${nodeUsage.costUsd.toFixed(4)} exceeded maxCostUsd $${nodeLimits.maxCostUsd}`,
			);
		}
		if (nodeLimits?.maxTurns !== undefined && nodeUsage.turns > nodeLimits.maxTurns) {
			throw new GraphLimitError("NODE_MAX_TURNS", `Node ${nodeId} used ${nodeUsage.turns} turns; maxTurns is ${nodeLimits.maxTurns}`);
		}
	}

	reconcile(expected: UsageLedger): void {
		const delta: Partial<UsageLedger> = {};
		for (const key of usageKeys()) {
			const missing = expected[key] - this.usage[key];
			if (missing > 0) delta[key] = missing;
		}
		this.report(delta);
	}
}

function isThreadNode(node: NodeDefinition | undefined): node is AgentNodeDefinition {
	return node?.type === "agent" && (node.context?.mode ?? "isolated") === "thread";
}

function resolveFailure(nodeId: string, node: NodeDefinition, failure: NodeExecutionFailure): FailureResolution {
	const strategy = node.onError?.strategy ?? "fail";
	if (strategy === "fail") return { fatal: failure, historyStatus: "failed", historyError: failure.error };
	const errorValue: JsonObject = {
		message: failure.error,
		code: failure.code ?? "NODE_FAILED",
		retryable: failure.retryable,
		attempts: failure.attempts,
	};
	const outputPath = node.onError?.output ?? `errors.${nodeId}`;
	return {
		success: {
			kind: "success",
			writes: [{ path: outputPath, value: errorValue, nodeId }],
			output: errorValue,
			usage: failure.usage,
			next: strategy === "route" && node.onError?.to !== undefined ? asStringArray(node.onError.to) : undefined,
			attempts: failure.attempts,
			startedAt: failure.startedAt,
			endedAt: failure.endedAt,
		},
		historyStatus: "failed",
		historyError: failure.error,
	};
}

function successResolution(success: NodeExecutionSuccess): FailureResolution {
	return { success, historyStatus: "completed" };
}

function failureResult(
	error: string,
	code: string,
	retryable: boolean,
	attempts: number,
	startedAt: string,
	endedAt: string,
	usage: NodeUsage = emptyUsage(),
): NodeExecutionFailure {
	return { kind: "failure", error, code, retryable, usage, attempts, startedAt, endedAt };
}

function resolveLimits(configured: GraphLimits | undefined): ResolvedGraphLimits {
	return {
		maxSteps: configured?.maxSteps,
		maxNodeRuns: configured?.maxNodeRuns,
		maxConcurrency: configured?.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
		maxCostUsd: configured?.maxCostUsd ?? DEFAULT_LIMITS.maxCostUsd,
		timeoutMs: configured?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
		maxStateBytes: configured?.maxStateBytes ?? DEFAULT_LIMITS.maxStateBytes,
		maxPromptBytes: configured?.maxPromptBytes ?? DEFAULT_LIMITS.maxPromptBytes,
	};
}

function mergeNodeUsage(target: NodeUsage, source: NodeUsage): void {
	addUsage(target, source);
	if (source.model) target.model = source.model;
}

function withModel(usage: NodeUsage, model: string | undefined): NodeUsage {
	return { ...copyUsage(usage), model: model ?? usage.model };
}

function copyNodeUsage(usage: NodeUsage): NodeUsage {
	return { ...copyUsage(usage), model: usage.model };
}

function usageDifference(usage: NodeUsage, alreadyDurable: UsageLedger): NodeUsage {
	const difference = emptyUsage();
	for (const key of usageKeys()) difference[key] = Math.max(0, usage[key] - alreadyDurable[key]);
	return { ...difference, model: usage.model };
}

function executionId(runId: string, step: number, nodeId: string, attempt: number): string {
	return `pig:${runId}:${step}:${nodeId}:${attempt}`;
}

function copyUsage(usage: UsageLedger): UsageLedger {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		turns: usage.turns,
		costUsd: usage.costUsd,
	};
}

function copyTokenUsage(usage: UsageLedger): TokenUsageLedger {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		turns: usage.turns,
	};
}

function usageKeys(): Array<keyof UsageLedger> {
	return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "turns", "costUsd"];
}

function resultFromSnapshot(snapshot: CheckpointSnapshot, definition: GraphDefinition): GraphRunResult {
	const resultPolicy = definition.result;
	const includeState = resultPolicy?.includeState ?? false;
	return {
		runId: snapshot.runId,
		status: snapshot.status,
		state: deepCloneJson(snapshot.state),
		result: projectResult(snapshot.state, resultPolicy?.paths),
		stateBytes: stateSizeBytes(snapshot.state),
		includeState,
		resultMaxBytes: resultPolicy?.maxBytes ?? 16 * 1024,
		usage: copyTokenUsage(snapshot.usage),
		step: snapshot.step,
		nodeRuns: snapshot.nodeRuns,
		interrupt: snapshot.interrupt,
		error: snapshot.error,
	};
}

function projectResult(state: JsonObject, configuredPaths: string[] | undefined): JsonObject | undefined {
	const paths = configuredPaths ?? defaultResultPaths(state);
	if (paths.length === 0) return undefined;
	const projected: JsonObject = {};
	for (const path of paths) {
		const value = getPath(state, path);
		if (value === undefined) continue;
		setPath(projected, path, deepCloneJson(value));
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function defaultResultPaths(state: JsonObject): string[] {
	if (getPath(state, "result") !== undefined) return ["result"];
	if (getPath(state, "report") !== undefined) return ["report"];
	const outputs = getPath(state, "outputs");
	if (isJsonObject(outputs) && Object.keys(outputs).length === 1) return ["outputs"];
	return [];
}

function isCheckpointControlError(error: unknown): boolean {
	return (
		error instanceof CheckpointLeaseError ||
		error instanceof CheckpointConflictError ||
		error instanceof CheckpointDurabilityError ||
		error instanceof CheckpointValidationError
	);
}

async function closeCheckpointRun(checkpointRun: CheckpointRun | undefined): Promise<void> {
	try {
		await checkpointRun?.close();
	} catch {
		// Lease release is best-effort; expiry remains the recovery path. Cleanup must not
		// replace a committed result or the primary execution/control error.
	}
}

async function mapWithConcurrencyLimit<TInput, TOutput>(
	items: TInput[],
	concurrency: number,
	execute: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<TOutput>(items.length);
	let nextIndex = 0;
	let failure: { error: unknown } | undefined;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			if (failure) return;
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) return;
			try {
				results[index] = await execute(items[index], index);
			} catch (error) {
				failure ??= { error };
				return;
			}
		}
	});
	await Promise.all(workers);
	if (failure) throw failure.error;
	return results;
}

function nowIso(): string {
	return new Date().toISOString();
}
