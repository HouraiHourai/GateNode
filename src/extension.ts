import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	formatSize as formatBytes,
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	Container,
	Markdown,
	Text,
	truncateToWidth,
	visibleWidth,
	type AutocompleteItem,
	type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { FileCheckpointStore, type CheckpointInspection } from "./checkpoint.ts";
import { graphUsesMutatingTools } from "./compile.ts";
import { discoverGraphs, findGraph } from "./discovery.ts";
import { GraphEngine } from "./engine.ts";
import { PiNodeExecutor } from "./pi-executor.ts";
import type { ParentSessionProfile } from "./pi-agent-runtime.ts";
import {
	RuntimeGraphMonitor,
	renderRuntimeGraph,
	type RuntimeGraphView,
} from "./runtime-visualization.ts";
import type {
	Condition,
	CheckpointLeaseView,
	CheckpointSummary,
	CheckpointSnapshot,
	GraphDefinition,
	GraphRunEvent,
	GraphRunResult,
	GraphScope,
	GraphSource,
	HumanInputKind,
	JsonObject,
	JsonValue,
	TokenUsageLedger,
} from "./types.ts";

/** An interrupted human node whose answer is captured directly from chat input. */
interface PendingAsk {
	runId: string;
	graphName: string;
	nodeId: string;
	kind: HumanInputKind;
	options?: string[];
}

// Module-level: survives tool/command call boundaries; cleared on session shutdown.
let pendingAsk: PendingAsk | undefined;
/** Clears the held (paused) board widget for the pending ask. */
let holdBoardClear: (() => void) | undefined;
/** Cancels the previous run's lingering board timer without touching its widget. */
let cancelPendingLinger: (() => void) | undefined;

function clearPendingAsk(disposeBoard: boolean): void {
	pendingAsk = undefined;
	if (disposeBoard && holdBoardClear) {
		holdBoardClear();
		holdBoardClear = undefined;
	}
}

/** Registers the interrupt for chat capture. Returns true when the board should be held. */
function noteInterrupt(result: GraphRunResult, graphName: string): boolean {
	if (result.status !== "interrupted" || !result.interrupt) return false;
	pendingAsk = {
		runId: result.runId,
		graphName,
		nodeId: result.interrupt.nodeId,
		kind: result.interrupt.kind,
		options: result.interrupt.options,
	};
	return true;
}

/** Maps free chat text to a resume value; undefined means "cannot map, let the main agent see it". */
function coerceResumeValue(text: string, kind: HumanInputKind, options?: string[]): JsonValue | undefined {
	if (kind === "input") return text;
	if (kind === "confirm") {
		const t = text.toLowerCase();
		if (["y", "yes", "ok", "true", "approve", "是", "好", "确认"].includes(t)) return true;
		if (["n", "no", "false", "reject", "否", "不", "拒绝"].includes(t)) return false;
		return undefined;
	}
	if (kind === "select" && options) return options.find((option) => option.toLowerCase() === text.toLowerCase());
	return undefined;
}
import {
	deepMergeObjects,
	errorMessage,
	getPath,
	isJsonObject,
	parseJsonObject,
	parseJsonOrText,
	parseJsonValue,
	stateSizeBytes,
	usageTokens,
} from "./utils.ts";

// StringEnum (not Type.Union/Type.Literal) so the scope parameter serializes as a
// JSON Schema `enum`, which is required for Google API compatibility.
const GraphScopeSchema = StringEnum(["user", "project", "both"] as const);
const InspectViewSchema = StringEnum(["summary", "inventory", "path", "full"] as const);
const RUNTIME_WIDGET_KEY = "pi-graph-runtime";
/** Board re-render tick; activity streams never re-render faster than this. */
const RENDER_INTERVAL_MS = 1_000;
/** How long the final board snapshot stays on screen after a run ends. */
const BOARD_LINGER_MS = 30_000;

const RunGraphParameters = Type.Object({
	graph: Type.String({ description: "Installed graph name" }),
	task: Type.Optional(Type.String({ description: "Task text, exposed as state.input.task" })),
	inputJson: Type.Optional(Type.String({ description: "Additional JSON object merged into state.input" })),
	scope: Type.Optional(GraphScopeSchema),
	checkpoint: Type.Optional(Type.Boolean({ description: "Persist checkpoints for resume; default true" })),
});

const ResumeGraphParameters = Type.Object({
	runId: Type.String({ description: "Run id returned by pi_graph_run" }),
	value: Type.Optional(Type.String({ description: "Plain-text human response" })),
	valueJson: Type.Optional(Type.String({ description: "JSON human response, such as true or an object" })),
	forceGraphVersion: Type.Optional(
		Type.Boolean({ description: "Resume after graph definition changed. Review idempotency and state compatibility first." }),
	),
	scope: Type.Optional(GraphScopeSchema),
});

const InspectGraphParameters = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run id. Omit to list recent runs." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum recent runs to list" })),
	view: Type.Optional(InspectViewSchema),
	path: Type.Optional(Type.String({ description: "State path when view=path" })),
	maxBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 200000, description: "Maximum UTF-8 bytes rendered" })),
});

interface GraphToolDetails {
	graph?: string;
	source?: string;
	event?: GraphRunEventView;
	/** Live, bounded runtime projection used by the TUI and streaming tool card. */
	runtime?: RuntimeGraphView;
	/** Lightweight view only; full graph state remains in the graph checkpoint. */
	result?: GraphRunView;
	/** Lightweight checkpoint metadata only; inspect content carries the requested projection. */
	checkpoint?: CheckpointView;
	runs?: CheckpointSummary[];
}

type GraphRunEventView = Omit<GraphRunEvent, "usage"> & { usage?: TokenUsageLedger };
type GraphRunView = Omit<GraphRunResult, "state" | "usage"> & { usage: TokenUsageLedger; stateInventory: string };

interface CheckpointView {
	runId: string;
	graphName: string;
	status: CheckpointSnapshot["status"];
	revision: number;
	step: number;
	nodeRuns: number;
	stateBytes: number;
	usage: TokenUsageLedger;
	pending: string[];
	inFlight: string[];
	threadCount: number;
	interruptNodeId?: string;
	error?: string;
	lease: CheckpointLeaseView;
	stateInventory: string;
}

interface RunRequest {
	graphName: string;
	input: JsonObject;
	scope: GraphScope;
	checkpoint: boolean;
	/** True when driven autonomously (LLM tool call) with no synchronous human to answer gates. */
	autonomous?: boolean;
	ctx: ExtensionContext;
	outerModel?: ExtensionContext["model"];
	outerThinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	outerActiveTools?: string[];
	outerSessionProfile?: ParentSessionProfile;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: GraphToolDetails }) => void;
}

interface ResumeRequest {
	runId: string;
	resumeValue?: JsonValue;
	forceGraphVersion: boolean;
	scope: GraphScope;
	/** True when driven autonomously (LLM tool call) with no synchronous human to answer gates. */
	autonomous?: boolean;
	ctx: ExtensionContext;
	outerModel?: ExtensionContext["model"];
	outerThinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	outerActiveTools?: string[];
	outerSessionProfile?: ParentSessionProfile;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: GraphToolDetails }) => void;
}

export default function piGraphExtension(pi: ExtensionAPI): void {
	const checkpointStore = new FileCheckpointStore(join(getAgentDir(), "pi-graph", "runs"));
	const confirmedProjectGraphs = new Set<string>();
	const confirmedMutatingGraphs = new Set<string>();
	const activeRuntimeDisposers = new Set<() => void>();
	let completionContext: Pick<ExtensionContext, "cwd" | "isProjectTrusted"> | undefined;

	pi.registerTool({
		name: "pi_graph_run",
		label: "Pi Graph Run",
		description:
			"Run a named, bounded Pi agent graph with isolated, persistent-thread, or shared-message context; explicit state; routing; fan-out/fan-in; checkpoints; and human interrupts.",
		promptSnippet: "Run a preconfigured bounded multi-node Pi agent graph",
		promptGuidelines: [
			"Use pi_graph_run only when the work genuinely needs specialized handoffs, parallel fan-out/fan-in, distinct tools/models, failure isolation, or an independent reviewer.",
			"Prefer the normal Pi agent loop for a single well-scoped task; do not create graph complexity merely to sequence trivial steps.",
		],
		parameters: RunGraphParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				completionContext = ctx;
				const input = buildInput(params.task, params.inputJson);
				const result = await runGraph(
					{
						graphName: params.graph,
						input,
						scope: params.scope ?? "both",
						checkpoint: params.checkpoint ?? true,
						autonomous: true,
						ctx,
						outerModel: ctx.model,
						outerThinkingLevel: pi.getThinkingLevel(),
						outerActiveTools: pi.getActiveTools(),
						outerSessionProfile: getParentSessionProfile(ctx),
						signal,
						onUpdate,
					},
					checkpointStore,
					confirmedProjectGraphs,
					confirmedMutatingGraphs,
					activeRuntimeDisposers,
				);
				pi.appendEntry("pig", runSummary(result, params.graph));
				throwForTerminalGraphFailure(result, "pig failed");
				return {
					content: [{ type: "text", text: formatRunResult(result) }],
					details: { graph: params.graph, result: toGraphRunView(result) } satisfies GraphToolDetails,
				};
			} catch (error) {
				throw toolExecutionError("pig failed", error);
			}
		},
		renderCall(args, theme) {
			return renderGraphCall("pi_graph_run", args.graph ?? "", theme);
		},
		renderResult(result, { expanded }, theme) {
			return renderGraphResult(result.details as GraphToolDetails | undefined, expanded, theme);
		},
	});

	pi.registerTool({
		name: "pi_graph_resume",
		label: "Pi Graph Resume",
		description: "Resume a durable pig run after interruption, failure, cancellation, or process restart.",
		promptSnippet: "Resume a checkpointed Pi graph run",
		promptGuidelines: [
			"Use pi_graph_resume with the exact runId returned by pi_graph_run.",
			"Supply valueJson for booleans or structured approval data; use value for plain text.",
		],
		parameters: ResumeGraphParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				completionContext = ctx;
				if (params.value !== undefined && params.valueJson !== undefined) {
					throw new Error("Provide only one of value or valueJson");
				}
				const resumeValue =
					params.valueJson !== undefined
						? parseJsonValue(params.valueJson, "valueJson")
						: params.value !== undefined
							? params.value
							: undefined;
				const result = await resumeGraph(
					{
						runId: params.runId,
						resumeValue,
						forceGraphVersion: params.forceGraphVersion ?? false,
						scope: params.scope ?? "both",
						autonomous: true,
						ctx,
						outerModel: ctx.model,
						outerThinkingLevel: pi.getThinkingLevel(),
						outerActiveTools: pi.getActiveTools(),
						outerSessionProfile: getParentSessionProfile(ctx),
						signal,
						onUpdate,
					},
					checkpointStore,
					confirmedProjectGraphs,
					confirmedMutatingGraphs,
					activeRuntimeDisposers,
				);
				const resumedSnapshot = (await checkpointStore.load(result.runId)).snapshot;
				pi.appendEntry("pig", runSummary(result, resumedSnapshot.graphName));
				throwForTerminalGraphFailure(result, "pig resume failed");
				return {
					content: [{ type: "text", text: formatRunResult(result) }],
					details: { result: toGraphRunView(result) } satisfies GraphToolDetails,
				};
			} catch (error) {
				throw toolExecutionError("pig resume failed", error);
			}
		},
		renderCall(args, theme) {
			return renderGraphCall("pi_graph_resume", args.runId ?? "", theme);
		},
		renderResult(result, { expanded }, theme) {
			return renderGraphResult(result.details as GraphToolDetails | undefined, expanded, theme);
		},
	});

	pi.registerTool<typeof InspectGraphParameters, GraphToolDetails>({
		name: "pi_graph_inspect",
		label: "Pi Graph Inspect",
		description: "Inspect a durable pig checkpoint or list recent runs without executing nodes.",
		promptSnippet: "Inspect Pi graph runs and checkpoints",
		parameters: InspectGraphParameters,
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			try {
				if (params.runId) {
					const inspection = await checkpointStore.inspect(params.runId);
					return {
						content: [
							{
								type: "text",
								text: formatCheckpointRecord(inspection, params.view ?? (params.path ? "path" : "summary"), params.path, params.maxBytes),
							},
						],
						details: { checkpoint: toCheckpointView(inspection) } satisfies GraphToolDetails,
					};
				}
				const runs = await checkpointStore.list(params.limit ?? 20);
				return {
					content: [{ type: "text", text: formatRunList(runs) }],
					details: { runs } satisfies GraphToolDetails,
				};
			} catch (error) {
				throw toolExecutionError("pig inspect failed", error);
			}
		},
		renderCall(args, theme) {
			return renderGraphCall("pi_graph_inspect", args.runId ?? "(recent)", theme);
		},
		renderResult(result, { expanded }, theme) {
			return renderGraphResult(result.details as GraphToolDetails | undefined, expanded, theme);
		},
	});

	pi.registerEntryRenderer<PigEntryData>("pig", (entry, { expanded }, theme) =>
		renderPigEntry(entry.data, expanded, theme),
	);

	pi.registerEntryRenderer<PigInspectEntryData>("pig-inspect", (entry, _options, theme) =>
		renderPigInspectEntry(entry.data, false, theme),
	);

	pi.registerCommand("pig", {
		description: "List, validate, run, resume, inspect, or delete Pi agent graphs",
		getArgumentCompletions: (argumentPrefix) =>
			resolvePiGraphCompletions(
				argumentPrefix,
				completionContext ?? { cwd: process.cwd(), isProjectTrusted: () => false },
				getAgentDir(),
				checkpointStore,
			),
		handler: async (args, ctx) => {
			try {
				completionContext = ctx;
				await handleCommand(
					args,
					ctx,
					pi,
					checkpointStore,
					confirmedProjectGraphs,
					confirmedMutatingGraphs,
					activeRuntimeDisposers,
				);
			} catch (error) {
				ctx.ui.notify(`pig: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		const ask = pendingAsk;
		if (!ask || event.source !== "interactive") return;
		const text = event.text.trim();
		// Slash commands pass through so /pig resume and /pig skip always work.
		if (!text || text.startsWith("/")) return;
		const value = coerceResumeValue(text, ask.kind, ask.options);
		if (value === undefined) return; // cannot map; let the main agent handle it
		pendingAsk = undefined;
		ctx.ui.notify(`→ ${ask.graphName} · ${ask.nodeId}: ${truncateToWidth(text, 80, "…")}`, "info");
		void resumeGraph(
				{
					runId: ask.runId,
					resumeValue: value,
					forceGraphVersion: false,
					scope: "both",
					autonomous: false,
					ctx,
					outerModel: ctx.model,
					outerThinkingLevel: pi.getThinkingLevel(),
					outerActiveTools: pi.getActiveTools(),
					outerSessionProfile: getParentSessionProfile(ctx),
					signal: ctx.signal,
				},
				checkpointStore,
				confirmedProjectGraphs,
				confirmedMutatingGraphs,
				activeRuntimeDisposers,
			)
			.then(async (result) => {
				pi.appendEntry("pig", runSummary(result, ask.graphName));
				ctx.ui.notify(formatRunNotice(result), result.status === "completed" ? "info" : result.status === "interrupted" ? "warning" : "error");
			})
			.catch((error) => {
				pendingAsk = ask; // keep capture so the user can retry
				ctx.ui.notify(`pig resume failed: ${errorMessage(error)}`, "error");
			});
		return { action: "handled" };
	});

	pi.on("session_start", (_event, ctx) => {
		completionContext = ctx;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearPendingAsk(true);
		for (const dispose of [...activeRuntimeDisposers]) dispose();
		ctx.ui.setStatus("pig", undefined);
		ctx.ui.setWidget(RUNTIME_WIDGET_KEY, undefined);
	});
}

function throwForTerminalGraphFailure(result: GraphRunResult, prefix: string): void {
	if (result.status === "failed" || result.status === "cancelled") {
		throw new Error(`${prefix}: ${formatRunResult(result)}`);
	}
}

function toolExecutionError(prefix: string, error: unknown): Error {
	const message = errorMessage(error);
	if (message.startsWith(`${prefix}:`)) return error instanceof Error ? error : new Error(message);
	return new Error(`${prefix}: ${message}`, { cause: error });
}

async function runGraph(
	request: RunRequest,
	checkpointStore: FileCheckpointStore,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
	activeRuntimeDisposers: Set<() => void>,
): Promise<GraphRunResult> {
	const graph = resolveGraph(request.ctx, request.graphName, request.scope);
	await authorizeGraph(request.ctx, graph, request.checkpoint, request.autonomous ?? false, confirmedProjectGraphs, confirmedMutatingGraphs);
	const { compiled } = graph;
	const graphName = compiled.definition.name;
	const executor = new PiNodeExecutor({
		cwd: request.ctx.cwd,
		hasUI: request.ctx.hasUI,
		ui: request.ctx.ui,
		projectTrusted: request.ctx.isProjectTrusted(),
		autonomous: request.autonomous ?? false,
		agentDir: getAgentDir(),
		threadSessionsDir: join(getAgentDir(), "pi-graph", "threads"),
		artifactsDir: join(getAgentDir(), "pi-graph", "artifacts"),
		parentModel: request.outerModel,
		parentThinkingLevel: request.outerThinkingLevel,
		parentActiveTools: request.outerActiveTools,
		parentSessionProfile: request.outerSessionProfile,
	});
	const engine = new GraphEngine(compiled, executor, { checkpointStore, graphSource: graph.filePath });
	const progress = createRuntimeProgress(request.ctx, graph, request.onUpdate, activeRuntimeDisposers);
	let holdBoard = false;
	try {
		request.ctx.ui.setStatus("pig", `${graphName}: starting`);
		const result = await engine.run({
			input: request.input,
			checkpoint: request.checkpoint,
			signal: request.signal,
			onEvent: progress.onEvent,
		});
		holdBoard = noteInterrupt(result, graphName);
		if (holdBoard) {
			progress.pause(`${graphName}: ⏸ ${result.interrupt?.nodeId} — 直接在聊天里回答（/pig skip 释放捕获）`);
			holdBoardClear = () => progress.clear();
		}
		return result;
	} finally {
		if (!holdBoard) {
			holdBoardClear = undefined;
			progress.finish();
		}
	}
}

async function resumeGraph(
	request: ResumeRequest,
	checkpointStore: FileCheckpointStore,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
	activeRuntimeDisposers: Set<() => void>,
): Promise<GraphRunResult> {
	const snapshot = (await checkpointStore.load(request.runId)).snapshot;
	const graph = resolveGraph(request.ctx, snapshot.graphName, request.scope);
	await authorizeGraph(request.ctx, graph, true, request.autonomous ?? false, confirmedProjectGraphs, confirmedMutatingGraphs);
	const { compiled } = graph;
	const graphName = compiled.definition.name;
	const executor = new PiNodeExecutor({
		cwd: request.ctx.cwd,
		hasUI: request.ctx.hasUI,
		ui: request.ctx.ui,
		projectTrusted: request.ctx.isProjectTrusted(),
		autonomous: request.autonomous ?? false,
		agentDir: getAgentDir(),
		threadSessionsDir: join(getAgentDir(), "pi-graph", "threads"),
		artifactsDir: join(getAgentDir(), "pi-graph", "artifacts"),
		parentModel: request.outerModel,
		parentThinkingLevel: request.outerThinkingLevel,
		parentActiveTools: request.outerActiveTools,
		parentSessionProfile: request.outerSessionProfile,
	});
	const engine = new GraphEngine(compiled, executor, { checkpointStore, graphSource: graph.filePath });
	const progress = createRuntimeProgress(request.ctx, graph, request.onUpdate, activeRuntimeDisposers, snapshot);
	let holdBoard = false;
	try {
		request.ctx.ui.setStatus("pig", `${graphName}: resuming`);
		const result = await engine.run({
			runId: request.runId,
			resumeValue: request.resumeValue,
			forceGraphVersion: request.forceGraphVersion,
			checkpoint: true,
			signal: request.signal,
			onEvent: progress.onEvent,
		});
		holdBoard = noteInterrupt(result, graphName);
		if (holdBoard) {
			progress.pause(`${graphName}: ⏸ ${result.interrupt?.nodeId} — 直接在聊天里回答（/pig skip 释放捕获）`);
			holdBoardClear = () => progress.clear();
		}
		return result;
	} finally {
		if (!holdBoard) {
			holdBoardClear = undefined;
			progress.finish();
		}
	}
}

function resolveGraph(ctx: ExtensionContext, name: string, scope: GraphScope): GraphSource {
	const discovery = discoverGraphs({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		configDirName: CONFIG_DIR_NAME,
		scope,
		projectTrusted: ctx.isProjectTrusted(),
	});
	return findGraph(discovery, name);
}

async function authorizeGraph(
	ctx: ExtensionContext,
	graph: GraphSource,
	checkpoint: boolean,
	autonomous: boolean,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
): Promise<void> {
	const { definition, hash } = graph.compiled;
	const graphName = definition.name;
	const policy = definition.policy ?? {};
	const mutating = graphUsesMutatingTools(definition);
	const confirmationKey = `${graph.filePath}:${hash}`;
	// Headless process: enforce both non-interactive policies.
	if (!ctx.hasUI) {
		if (policy.allowNonInteractive !== true) {
			throw new Error(`Graph ${graphName} does not allow non-interactive execution`);
		}
		if (mutating && policy.allowNonInteractiveMutations !== true) {
			throw new Error(`Graph ${graphName} uses mutating tools and does not allow non-interactive mutations`);
		}
	}
	// Model-driven tool call: no synchronous human can consent to file edits,
	// so a mutating graph must opt in via allowNonInteractiveMutations. (Base
	// allowNonInteractive is left to the headless case; read-only graphs are
	// safe and their human nodes interrupt rather than auto-answering.)
	if (autonomous && mutating && policy.allowNonInteractiveMutations !== true) {
		throw new Error(`Graph ${graphName} uses mutating tools and cannot be run autonomously without allowNonInteractiveMutations`);
	}
	if (graph.scope === "project") {
		if (!ctx.isProjectTrusted()) throw new Error(`Project graph ${graphName} requires a trusted project`);
		if (ctx.hasUI && policy.confirmProjectGraph === true && !confirmedProjectGraphs.has(confirmationKey)) {
			const approved = await ctx.ui.confirm(
				"Run project-local Pi graph?",
				`Graph: ${graphName}\nSource: ${graph.filePath}\n\nProject graphs are repository-controlled orchestration code. Continue only for a trusted repository.`,
			);
			if (!approved) throw new Error("Project graph was not approved");
			confirmedProjectGraphs.add(confirmationKey);
		}
	}
	if (mutating && ctx.hasUI && policy.confirmMutatingNodes === true && !confirmedMutatingGraphs.has(confirmationKey)) {
		const approved = await ctx.ui.confirm(
			"Allow mutating graph nodes?",
			`Graph ${graphName} can run bash, edit, write, or extension tools in Pi agent nodes. Review ${graph.filePath} before continuing.`,
		);
		if (!approved) throw new Error("Mutating graph execution was not approved");
		confirmedMutatingGraphs.add(confirmationKey);
	}
	const hasHumanNode = Object.values(definition.nodes).some((node) => node.type === "human");
	if (hasHumanNode && !checkpoint) {
		throw new Error(`Graph ${graphName} contains a human node and requires checkpoint: true for durable resume`);
	}
}

export function createRuntimeProgress(
	ctx: ExtensionContext,
	graph: GraphSource,
	onUpdate: RunRequest["onUpdate"],
	activeRuntimeDisposers: Set<() => void>,
	checkpoint?: CheckpointSnapshot,
): { onEvent: (event: GraphRunEvent) => void; clear: () => void; pause: (status?: string) => void; finish: () => void } {
	const graphName = graph.compiled.definition.name;
	const monitor = new RuntimeGraphMonitor(graph.compiled.definition, { checkpoint });
	// A new run cancels only the previous run's lingering timer. The previous clear()
	// must NOT run here: it would wipe this board because widgets share RUNTIME_WIDGET_KEY.
	cancelPendingLinger?.();
	cancelPendingLinger = undefined;
	let cleared = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let lingerTimer: ReturnType<typeof setTimeout> | undefined;
	let lastRenderedWidget: string | undefined;
	let pendingStatus: string | undefined;
	const renderWidget = (lines: string[]) => {
		if (cleared || !ctx.hasUI) return;
		const joined = lines.join("\n");
		if (joined === lastRenderedWidget) return;
		lastRenderedWidget = joined;
		ctx.ui.setWidget(RUNTIME_WIDGET_KEY, runtimeBoardWidget(lines), { placement: "belowEditor" });
	};
	const showWidget = () => renderWidget(renderRuntimeGraph(monitor.view()));
	const flushStatus = () => {
		if (cleared || pendingStatus === undefined) return;
		ctx.ui.setStatus("pig", pendingStatus);
		pendingStatus = undefined;
	};
	const stopTick = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
	};
	const cancelLinger = () => {
		if (lingerTimer) clearTimeout(lingerTimer);
		lingerTimer = undefined;
	};
	const clear = () => {
		if (cleared) return;
		cleared = true;
		stopTick();
		cancelLinger();
		if (cancelPendingLinger === cancelLinger) cancelPendingLinger = undefined;
		if (ctx.hasUI) ctx.ui.setWidget(RUNTIME_WIDGET_KEY, undefined);
		ctx.ui.setStatus("pig", undefined);
		activeRuntimeDisposers.delete(clear);
	};
	activeRuntimeDisposers.add(clear);
	const pause = (status?: string) => {
		if (cleared) return;
		stopTick();
		pendingStatus = undefined;
		if (status && ctx.hasUI) ctx.ui.setStatus("pig", status);
	};
	/** Freezes the final snapshot on screen, then auto-clears board and status after BOARD_LINGER_MS. */
	const finish = () => {
		if (cleared) return;
		stopTick();
		pendingStatus = undefined;
		showWidget();
		ctx.ui.setStatus("pig", `${graphName}: ${monitor.view().status}`);
		lingerTimer = setTimeout(() => {
			lingerTimer = undefined;
			if (cancelPendingLinger === cancelLinger) cancelPendingLinger = undefined;
			clear();
		}, BOARD_LINGER_MS);
		lingerTimer.unref();
		cancelPendingLinger = cancelLinger;
	};
	try {
		showWidget();
		// Throttled tick: high-frequency activity streams re-render only here (~1/s);
		// milestone events (node start/settle, graph end, interrupts) render immediately.
		refreshTimer = ctx.hasUI
			? setInterval(() => {
					showWidget();
					flushStatus();
				}, RENDER_INTERVAL_MS)
			: undefined;
		refreshTimer?.unref();
	} catch (error) {
		clear();
		throw error;
	}
	return {
		onEvent: (event) => {
			if (cleared) return;
			monitor.apply(event);
			const runtime = monitor.view();
			const lines = renderRuntimeGraph(runtime);
			if (event.type === "node_activity" && event.nodeId && event.message) {
				// Buffered; the next tick renders the board and flushes this status.
				pendingStatus = `${graphName}: ${event.nodeId} · ${truncateToWidth(event.message, 90, "…")}`;
			} else {
				renderWidget(lines);
				pendingStatus = event.nodeId
					? `${graphName}: step ${event.step ?? "?"} · ${event.nodeId} · ${event.type.replaceAll("_", " ")}`
					: `${graphName}: ${event.type.replaceAll("_", " ")}`;
				flushStatus();
			}
			onUpdate?.({
				content: [{ type: "text", text: lines.join("\n") }],
					details: { graph: graphName, source: graph.filePath, event: toGraphRunEventView(event), runtime },
			});
		},
		clear,
		pause,
		finish,
	};
}

const BOARD_PANEL_MAX_WIDTH = Number.POSITIVE_INFINITY;
const BOARD_PANEL_TITLE_WIDTH = visibleWidth("◈ pi-graph · live board");

/** Minimal structural slice of Theme the board panel needs. */
export interface RuntimeBoardTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Wrap plain board lines in a framed, theme-colored panel component. */
function runtimeBoardWidget(lines: string[]): (tui: unknown, theme: RuntimeBoardTheme) => Component {
	return (_tui, theme) => ({
		render: (width: number) => renderRuntimeBoardPanel(lines, width, theme),
		invalidate: () => {},
	});
}

/** Render the live board as a modern framed panel with a branded banner row. */
export function renderRuntimeBoardPanel(lines: string[], width: number, theme: RuntimeBoardTheme): string[] {
	const panelWidth = Math.max(36, Math.min(width, BOARD_PANEL_MAX_WIDTH));
	const innerWidth = panelWidth - 4;
	const running = lines[0]?.includes("RUNNING") ?? false;
	const border = (text: string) => theme.fg(running ? "borderAccent" : "borderMuted", text);
	const title = `${theme.fg("accent", theme.bold("◈ pi-graph"))} ${theme.fg("dim", "· live board")}`;
	const fill = Math.max(1, panelWidth - 5 - BOARD_PANEL_TITLE_WIDTH);
	const top = `${border("╭─ ")}${title} ${border(`${"─".repeat(fill)}╮`)}`;
	const rows = lines.map((line, index) => {
		const content = truncateToWidth(line, innerWidth, "…");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return `${border("│ ")}${styleBoardLine(content, index, theme)}${padding}${border(" │")}`;
	});
	const bottom = border(`╰${"─".repeat(panelWidth - 2)}╯`);
	return [top, ...rows, bottom];
}

function styleBoardLine(line: string, index: number, theme: RuntimeBoardTheme): string {
	if (index === 0) return theme.fg("accent", theme.bold(line));
	if (line.includes("✗") || line.includes("!")) return theme.fg("error", line);
	if (line.includes("●") || line.includes("↻")) return theme.fg("accent", line);
	if (line.includes("✓")) return theme.fg("success", line);
	return theme.fg("dim", line);
}

function buildInput(task: string | undefined, inputJson: string | undefined): JsonObject {
	let input: JsonObject = {};
	if (inputJson !== undefined) input = parseJsonObject(inputJson, "inputJson");
	if (task !== undefined) input = deepMergeObjects(input, { task });
	return input;
}

async function handleCommand(
	args: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	checkpointStore: FileCheckpointStore,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
	activeRuntimeDisposers: Set<() => void>,
): Promise<void> {
	const trimmed = args.trim();
	const firstSpace = trimmed.search(/\s/);
	const action = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)) || "list";
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();

	if (action === "list" || action === "validate") {
		const discovery = discoverGraphs({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			scope: "both",
			projectTrusted: ctx.isProjectTrusted(),
		});
		if (action === "list") {
			const sections = [formatGraphList(discovery.graphs)];
			if (discovery.diagnostics.length) {
				sections.push("Diagnostics");
				for (const diagnostic of discovery.diagnostics) {
					sections.push(
						`  ${padVisible(diagnostic.level.toUpperCase(), 7)}${diagnostic.code}: ${diagnostic.message}${diagnostic.path ? `  (${diagnostic.path})` : ""}`,
					);
				}
			}
			const tone = discovery.diagnostics.some((item) => item.level === "error") ? "warning" : "info";
			ctx.ui.notify(sections.join("\n\n"), tone);
			return;
		}
		const selected = rest ? discovery.graphs.filter((graph) => graph.compiled.definition.name === rest) : discovery.graphs;
		if (rest && selected.length === 0) throw new Error(`Unknown graph ${rest}`);
		const lines = selected.flatMap((graph) => {
			const { definition, diagnostics } = graph.compiled;
			return [
				`${definition.name}: ${diagnostics.some((item) => item.level === "error") ? "invalid" : "valid"}`,
				...diagnostics.map((item) => `  ${item.level.toUpperCase()} ${item.code}: ${item.message}`),
			];
		});
		for (const diagnostic of discovery.diagnostics) lines.push(`${diagnostic.level.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
		ctx.ui.notify(lines.join("\n") || "All discovered graphs are valid.", "info");
		return;
	}

	if (action === "visualize") {
		if (!rest) throw new Error("Usage: /pig visualize <graph>");
		const discovery = discoverGraphs({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			scope: "both",
			projectTrusted: ctx.isProjectTrusted(),
		});
		const graph = findGraph(discovery, rest);
		const { compiled } = graph;
		const mermaid = generateMermaid(compiled.definition);
		const errorCount = compiled.diagnostics.filter((item) => item.level === "error").length;
		const header = errorCount > 0
			? `${compiled.definition.name} — ⚠ ${errorCount} compile error(s); rendering structure anyway`
			: `${compiled.definition.name} — ${Object.keys(compiled.definition.nodes).length} nodes · ${compiled.definition.edges?.length ?? 0} edges`;
		ctx.ui.notify(`${header}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``, "info");
		return;
	}

	if (action === "inspect") {
		if (rest) {
			const [runId, viewArg] = splitFirst(rest);
			const inspection = await checkpointStore.inspect(runId);
			const view = viewArg === "--full" ? "full" : viewArg === "--inventory" ? "inventory" : viewArg ? "path" : "summary";
			const path = view === "path" ? viewArg : undefined;
			const text = formatCheckpointRecord(inspection, view, path, 12_000);
			if (view === "path") {
				// Long state values read best as rendered Markdown, not raw JSON.
				const value = getPath(inspection.record.snapshot.state, path as string);
				pi.appendEntry("pig-inspect", {
					runId,
					path: path as string,
					status: inspection.record.snapshot.status,
					graph: inspection.record.snapshot.graphName,
					value: value ?? null,
				} satisfies JsonObject);
			} else {
				ctx.ui.notify(text, "info");
			}
		} else {
			ctx.ui.notify(formatRunList(await checkpointStore.list(20)), "info");
		}
		return;
	}

	if (action === "delete") {
		const [runId, extra] = splitFirst(rest);
		if (!runId || extra) throw new Error("Usage: /pig delete <runId>");
		const record = await checkpointStore.load(runId);
		const approved = await ctx.ui.confirm(
			"Delete Pi graph run?",
			`${runId}\n${record.snapshot.graphName} · ${record.snapshot.status}\n\nThis permanently removes its checkpoint, thread history, and artifacts.`,
		);
		if (!approved) return;
		await checkpointStore.delete(runId);
		const graphDataDir = join(getAgentDir(), "pi-graph");
		await Promise.all([
			rm(join(graphDataDir, "threads", runId), { recursive: true, force: true }),
			rm(join(graphDataDir, "artifacts", runId), { recursive: true, force: true }),
		]);
		ctx.ui.notify(`Deleted Pi graph run ${runId}.`, "info");
		return;
	}

	if (action === "skip") {
		if (!pendingAsk) throw new Error("No pending graph ask in this session");
		const ask = pendingAsk;
		clearPendingAsk(true);
		ctx.ui.setStatus("pig", undefined);
		ctx.ui.notify(`Released chat capture for ${ask.graphName} · ${ask.nodeId}. Run still paused — /pig resume ${ask.runId} <value> to continue.`, "info");
		return;
	}

	if (action === "run") {
		const [graphName, payload] = splitFirst(rest);
		if (!graphName) throw new Error("Usage: /pig run <graph> [task or JSON object]");
		const input = payload.trim().startsWith("{") ? parseJsonObject(payload, "command input") : payload ? { task: payload } : {};
		const result = await runGraph(
			{
				graphName,
				input,
				scope: "both",
				checkpoint: true,
				ctx,
				outerModel: ctx.model,
				outerThinkingLevel: pi.getThinkingLevel(),
				outerActiveTools: pi.getActiveTools(),
				outerSessionProfile: getParentSessionProfile(ctx),
				signal: ctx.signal,
			},
			checkpointStore,
			confirmedProjectGraphs,
			confirmedMutatingGraphs,
			activeRuntimeDisposers,
		);
		pi.appendEntry("pig", runSummary(result, graphName));
		ctx.ui.notify(formatRunNotice(result), result.status === "completed" ? "info" : result.status === "interrupted" ? "warning" : "error");
		return;
	}

	if (action === "resume") {
		const force = /(^|\s)--force(\s|$)/.test(rest);
		const cleaned = force ? rest.replace(/(^|\s)--force(\s|$)/, " ").trim() : rest;
		const [runId, payload] = splitFirst(cleaned);
		if (!runId) throw new Error("Usage: /pig resume <runId> [value or JSON] [--force]");
		const result = await resumeGraph(
			{
				runId,
				resumeValue: payload ? parseJsonOrText(payload) : undefined,
				forceGraphVersion: force,
				scope: "both",
				ctx,
				outerModel: ctx.model,
				outerThinkingLevel: pi.getThinkingLevel(),
				outerActiveTools: pi.getActiveTools(),
				outerSessionProfile: getParentSessionProfile(ctx),
				signal: ctx.signal,
			},
			checkpointStore,
			confirmedProjectGraphs,
			confirmedMutatingGraphs,
			activeRuntimeDisposers,
		);
		const resumedSnapshot = (await checkpointStore.load(result.runId)).snapshot;
		pi.appendEntry("pig", runSummary(result, resumedSnapshot.graphName));
		ctx.ui.notify(formatRunNotice(result), result.status === "completed" ? "info" : result.status === "interrupted" ? "warning" : "error");
		return;
	}

	throw new Error("Usage: /pig [list|validate [graph]|run <graph> [input]|resume <runId> [value]|skip|inspect [runId]|delete <runId>|visualize <graph>]");
}

function splitFirst(text: string): [string, string] {
	const trimmed = text.trim();
	const index = trimmed.search(/\s/);
	if (index === -1) return [trimmed, ""];
	return [trimmed.slice(0, index), trimmed.slice(index).trim()];
}

const PI_GRAPH_ACTIONS = ["list", "validate", "run", "resume", "skip", "inspect", "delete", "visualize"] as const;
const PI_GRAPH_ACTION_DESCRIPTIONS: Record<string, string> = {
	list: "List discovered graphs",
	validate: "Validate a graph (or all)",
	run: "Run a graph with a task",
	resume: "Resume an interrupted run",
	skip: "Release pending graph ask capture",
	inspect: "Inspect a run checkpoint or list recent runs",
	delete: "Delete a run checkpoint, thread history, and artifacts",
	visualize: "Render a graph as a Mermaid diagram",
};

function completeActions(prefix: string): AutocompleteItem[] {
	const lower = prefix.toLowerCase();
	return PI_GRAPH_ACTIONS.filter((action) => action.startsWith(lower)).map((action) => ({
		value: action,
		label: action,
		description: PI_GRAPH_ACTION_DESCRIPTIONS[action],
	}));
}

function completeGraphNames(
	context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	agentDir: string,
	prefix: string,
): AutocompleteItem[] {
	const discovery = discoverGraphs({
		cwd: context.cwd,
		agentDir,
		configDirName: CONFIG_DIR_NAME,
		scope: "both",
		projectTrusted: context.isProjectTrusted(),
	});
	return discovery.graphs
		.filter((graph) => graph.compiled.definition.name.startsWith(prefix))
		.map((graph) => ({
			value: graph.compiled.definition.name,
			label: graph.compiled.definition.name,
			description: `${Object.keys(graph.compiled.definition.nodes).length} nodes · ${graph.scope}`,
		}));
}

async function resolvePiGraphCompletions(
	argumentPrefix: string,
	context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	agentDir: string,
	store: FileCheckpointStore,
): Promise<AutocompleteItem[] | null> {
	const trimmed = argumentPrefix.trimStart();
	const spaceIndex = trimmed.search(/\s/);
	if (spaceIndex === -1) {
		const items = completeActions(trimmed);
		return items.length > 0 ? items : null;
	}
	const action = trimmed.slice(0, spaceIndex);
	const rest = trimmed.slice(spaceIndex + 1).trimStart();
	// The TUI replaces the ENTIRE argument text with item.value, so each value must
	// re-include everything before the token being completed (e.g. the "run " action).
	const keep = argumentPrefix.slice(0, argumentPrefix.length - rest.length);
	if (action === "run" || action === "validate" || action === "visualize") {
		const items = completeGraphNames(context, agentDir, rest).map((item) => ({ ...item, value: keep + item.value }));
		return items.length > 0 ? items : null;
	}
	if (action === "resume" || action === "inspect" || action === "delete") {
		const runs = await store.list(20);
		const items = runs
			.filter((run) => run.runId.startsWith(rest))
			.map((run) => ({ value: keep + run.runId, label: run.runId.slice(0, 8), description: `${run.graphName} · ${run.status}` }));
		return items.length > 0 ? items : null;
	}
	return null;
}

function renderGraphCall(toolName: string, keyArg: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`${toolName} `)) + theme.fg("muted", keyArg), 0, 0);
}

export function renderGraphResult(details: GraphToolDetails | undefined, expanded: boolean, theme: Theme): Component {
	const runtime = details?.runtime;
	if (runtime) {
		const text = renderRuntimeGraph(runtime)
			.map((line, index) => {
				if (index === 0) return theme.fg("accent", theme.bold(line));
				if (line.includes("✗")) return theme.fg("error", line);
				if (line.includes("↻") || line.includes("!")) return theme.fg("warning", line);
				if (line.includes("●")) return theme.fg("accent", line);
				if (line.includes("✓")) return theme.fg("success", line);
				return theme.fg("dim", line);
			})
			.join("\n");
		return new Text(text, 0, 0);
	}
	const result = details?.result;
	if (result) {
		const tone = result.status === "completed" ? "success" : result.status === "interrupted" ? "warning" : "error";
		let text =
			theme.fg(tone, result.status) +
			theme.fg(
				"muted",
				` · ${result.step} steps · ${result.nodeRuns} node runs · ${usageTokens(result.usage)} tok · ${formatBytes(result.stateBytes)} state`,
			);
		if (result.error) text += `\n${theme.fg("error", result.error)}`;
		if (expanded && result.result) {
			const container = new Container();
			container.addChild(new Text(`${text}\n`, 0, 0));
			container.addChild(new Markdown(formatResultProjection(result.result, Math.min(result.resultMaxBytes, 4000)), 0, 0, getMarkdownTheme()));
			return container;
		}
		if (expanded) text += `\n${theme.fg("dim", result.stateInventory)}`;
		return new Text(text, 0, 0);
	}
	const checkpoint = details?.checkpoint;
	if (checkpoint) {
		const tone = checkpoint.status === "completed" ? "success" : checkpoint.status === "interrupted" ? "warning" : "error";
		let text =
			theme.fg("accent", checkpoint.graphName) +
			" " +
			theme.fg(tone, checkpoint.status) +
			theme.fg(
				"muted",
				` · step ${checkpoint.step} · ${checkpoint.nodeRuns} runs · rev ${checkpoint.revision} · ${formatBytes(checkpoint.stateBytes)} state`,
			);
		if (expanded) text += `\n${theme.fg("dim", checkpoint.stateInventory)}`;
		return new Text(text, 0, 0);
	}
	const runs = details?.runs;
	if (runs && runs.length > 0) {
		let text = theme.fg("muted", `${runs.length} run(s)`);
		const display = expanded ? runs : runs.slice(0, 5);
		for (const run of display) {
			text += `\n${theme.fg("accent", run.runId.slice(0, 8))} ${theme.fg("dim", `${run.graphName} · ${run.status} · step ${run.step}`)}`;
		}
		if (!expanded && runs.length > 5) text += `\n${theme.fg("dim", `… ${runs.length - 5} more`)}`;
		return new Text(text, 0, 0);
	}
	if (details?.event) return new Text(theme.fg("muted", formatEvent(details.event)), 0, 0);
	return new Text("", 0, 0);
}

const MERMAID_OP: Record<string, string> = {
	eq: "==",
	ne: "!=",
	gt: ">",
	gte: "≥",
	lt: "<",
	lte: "≤",
	exists: "exists",
	truthy: "truthy",
	includes: "includes",
	matches: "matches",
};

function conditionLabel(cond: Condition): string {
	if ("all" in cond) return cond.all.map(conditionLabel).join(" ∧ ");
	if ("any" in cond) return cond.any.map(conditionLabel).join(" ∨ ");
	if ("not" in cond) return "¬" + conditionLabel(cond.not);
	const op = MERMAID_OP[cond.op] ?? cond.op;
	const valuePart = cond.value === undefined ? "" : ` ${JSON.stringify(cond.value)}`;
	return `${cond.path} ${op}${valuePart}`;
}

export function generateMermaid(def: GraphDefinition): string {
	const lines: string[] = ["flowchart LR"];
	const referenced = new Set<string>();
	const edgeLines: string[] = [];
	for (const edge of def.edges ?? []) {
		if ("cases" in edge) {
			for (const edgeCase of edge.cases) {
				const label = conditionLabel(edgeCase.when).replace(/"/g, "'");
				const tos = Array.isArray(edgeCase.to) ? edgeCase.to : [edgeCase.to];
				for (const to of tos) {
					edgeLines.push(`  ${edge.from} -. "${label}" .-> ${to}`);
					referenced.add(edge.from);
					referenced.add(to);
				}
			}
			if (edge.default !== undefined) {
				const tos = Array.isArray(edge.default) ? edge.default : [edge.default];
				for (const to of tos) {
					edgeLines.push(`  ${edge.from} -. "else" .-> ${to}`);
					referenced.add(edge.from);
					referenced.add(to);
				}
			}
		} else {
			const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
			const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
			for (const from of froms) {
				for (const to of tos) {
					edgeLines.push(`  ${from} --> ${to}`);
					referenced.add(from);
					referenced.add(to);
				}
			}
		}
	}
	for (const [id, node] of Object.entries(def.nodes)) {
		const decl = node.type === "human" ? `${id}{${id}}` : node.type === "set" ? `${id}[[${id}]]` : `${id}([${id}])`;
		lines.push(`  ${decl}`);
	}
	if (referenced.has("__end__")) lines.push("  __end__((end))");
	lines.push(...edgeLines);
	const entry = Array.isArray(def.entry) ? def.entry : def.entry ? [def.entry] : [];
	const entryIds = entry.filter((id) => def.nodes[id]);
	if (entryIds.length > 0) {
		lines.push("  classDef entry stroke:#2a2,stroke-width:3px;");
		lines.push(`  class ${entryIds.join(",")} entry;`);
	}
	return lines.join("\n");
}

function formatEvent(event: GraphRunEventView): string {
	const parts = [`[${event.runId}]`, event.type.replaceAll("_", " ")];
	if (event.step !== undefined) parts.push(`step ${event.step}`);
	if (event.nodeId) parts.push(event.nodeId);
	if (event.attempt !== undefined) parts.push(`attempt ${event.attempt}`);
	if (event.message) parts.push(event.message);
	return parts.join(" · ");
}

/** Human-readable markdown document for a result projection: string values stay markdown, structured values stay fenced JSON. */
export function formatResultProjection(result: JsonObject | undefined, maxBytes: number): string {
	if (!result) return "";
	const sections: string[] = [];
	const visit = (path: string, value: JsonValue) => {
		if (typeof value === "string") sections.push(`## ${path}\n\n${value}`);
		else if (isJsonObject(value)) {
			for (const [key, child] of Object.entries(value)) visit(path ? `${path}.${key}` : key, child);
		} else if (Array.isArray(value)) sections.push(`## ${path}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
		else sections.push(`## ${path}\n\n${JSON.stringify(value)}`);
	};
	for (const [key, child] of Object.entries(result)) visit(key, child);
	return truncateUtf8Text(sections.join("\n\n"), maxBytes);
}

/** Short run-completion notice; the readable result renders in the chat/tool card. */
export function formatRunNotice(result: GraphRunResult): string {
	const header = `pig ${result.runId} · ${result.status} · ${result.step} steps · ${result.nodeRuns} node runs · ${usageTokens(result.usage)} tok`;
	if (result.status === "interrupted" && result.interrupt) {
		const hint = pendingAsk?.runId === result.runId
			? "直接在聊天里输入回答即可（/pig skip 释放捕获；或 /pig resume <runId> <value>）"
			: `Resume with /pig resume ${result.runId} <value> or pi_graph_resume.`;
		return `${header}\nInterrupted at ${result.interrupt.nodeId}: ${result.interrupt.prompt}\n${hint}`;
	}
	if (result.error) return `${header}\nerror: ${result.error}`;
	return `${header}\n${result.result ? "Result rendered in the pig card · " : ""}/pig inspect ${result.runId} for details`;
}

/** LLM-facing exact format; also the fallback for debugging surfaces. */
function formatRunResult(result: GraphRunResult): string {
	const header = [
		`pig run ${result.runId}`,
		`status: ${result.status}`,
		`steps: ${result.step}`,
		`node runs: ${result.nodeRuns}`,
		`tokens: ${usageTokens(result.usage)}`,
		`state: ${formatBytes(result.stateBytes)}`,
	].join("\n");
	if (result.status === "interrupted" && result.interrupt) {
		const hint = pendingAsk?.runId === result.runId
			? "直接在聊天里输入回答即可（/pig skip 释放捕获；或 /pig resume <runId> <value>）"
			: `Resume with /pig resume ${result.runId} <value> or pi_graph_resume.`;
		return `${header}\n\nInterrupted at ${result.interrupt.nodeId}: ${result.interrupt.prompt}\n${hint}`;
	}
	if (result.error) return `${header}\n\nerror: ${result.error}`;
	const sections = [header];
	if (result.result) sections.push(`result:\n${truncateUtf8Text(JSON.stringify(result.result, null, 2), result.resultMaxBytes)}`);
	else sections.push(`state inventory:\n${formatStateInventory(result.state, 12)}`);
	if (result.includeState) {
		sections.push(`state:\n${truncateUtf8Text(JSON.stringify(result.state, null, 2), result.resultMaxBytes)}`);
	}
	return sections.join("\n\n");
}

function toGraphRunView(result: GraphRunResult): GraphRunView {
	return {
		runId: result.runId,
		status: result.status,
		result: result.result,
		stateBytes: result.stateBytes,
		includeState: result.includeState,
		resultMaxBytes: result.resultMaxBytes,
		usage: toTokenUsage(result.usage),
		step: result.step,
		nodeRuns: result.nodeRuns,
		interrupt: result.interrupt,
		error: result.error,
		stateInventory: formatStateInventory(result.state, 12),
	};
}

function toCheckpointView({ record, lease }: CheckpointInspection): CheckpointView {
	const snapshot = record.snapshot;
	return {
		runId: snapshot.runId,
		graphName: snapshot.graphName,
		status: snapshot.status,
		revision: record.revision,
		step: snapshot.step,
		nodeRuns: snapshot.nodeRuns,
		stateBytes: stateSizeBytes(snapshot.state),
		usage: toTokenUsage(snapshot.usage),
		pending: [...snapshot.pending],
		inFlight: [...(snapshot.inFlight?.unresolved ?? [])],
		threadCount: Object.keys(snapshot.threads).length,
		interruptNodeId: snapshot.interrupt?.nodeId,
		error: snapshot.error,
		lease,
		stateInventory: formatStateInventory(snapshot.state, 12),
	};
}

type InspectView = "summary" | "inventory" | "path" | "full";

function formatCheckpointRecord(
	inspection: CheckpointInspection,
	view: InspectView,
	path: string | undefined,
	maxBytes = 80_000,
): string {
	const { record, lease } = inspection;
	if (view === "full") return truncateUtf8Text(JSON.stringify(toCheckpointRecordView(inspection), null, 2), maxBytes);
	if (view === "path") {
		if (!path) throw new Error("inspect view=path requires path");
		const value = getPath(record.snapshot.state, path);
		if (value === undefined) throw new Error(`State path ${path} does not exist in run ${record.snapshot.runId}`);
		return truncateUtf8Text(`${path}:\n${JSON.stringify(value, null, 2)}`, maxBytes);
	}
	const snapshot = record.snapshot;
	const header = [
		`run: ${snapshot.runId}`,
		`graph: ${snapshot.graphName}`,
		`status: ${snapshot.status}`,
		`lease: ${formatLease(lease, snapshot.status)}`,
		`revision: ${record.revision}`,
		`step: ${snapshot.step}`,
		`node runs: ${snapshot.nodeRuns}`,
		`state bytes: ${formatBytes(stateSizeBytes(snapshot.state))}`,
		`tokens: ${usageTokens(snapshot.usage)}`,
		`pending: ${snapshot.pending.join(", ") || "none"}`,
	];
	if (snapshot.inFlight) header.push(`in flight: ${snapshot.inFlight.unresolved.join(", ") || "none"}`);
	if (snapshot.interrupt) header.push(`interrupt: ${snapshot.interrupt.nodeId} (${snapshot.interrupt.kind})`);
	if (snapshot.error) header.push(`error: ${snapshot.error}`);
	const inventory = formatStateInventory(snapshot.state, view === "inventory" ? 100 : 16);
	return truncateUtf8Text(`${header.join("\n")}\n\nstate inventory:\n${inventory}`, maxBytes);
}

interface StateInventoryEntry {
	path: string;
	type: string;
	bytes: number;
}

function formatStateInventory(state: JsonObject, limit: number): string {
	const entries = collectStateInventory(state)
		.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
		.slice(0, limit);
	if (entries.length === 0) return "(empty)";
	const pathWidth = Math.min(52, Math.max(4, ...entries.map((entry) => visibleWidth(entry.path))));
	return entries
		.map((entry) => {
			const path = truncateToWidth(entry.path, pathWidth, "…");
			const padding = " ".repeat(Math.max(0, pathWidth - visibleWidth(path)));
			return `${path}${padding}  ${entry.type.padEnd(7)}  ${formatBytes(entry.bytes)}`;
		})
		.join("\n");
}

function collectStateInventory(state: JsonObject): StateInventoryEntry[] {
	const entries: StateInventoryEntry[] = [];
	const visit = (value: JsonValue, path: string, depth: number) => {
		if (path) entries.push({ path, type: jsonType(value), bytes: Buffer.byteLength(JSON.stringify(value), "utf8") });
		if (depth >= 3) return;
		if (Array.isArray(value)) {
			for (let index = 0; index < Math.min(value.length, 20); index++) visit(value[index], `${path}[${index}]`, depth + 1);
			return;
		}
		if (isJsonObject(value)) {
			for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key, depth + 1);
		}
	};
	visit(state, "", 0);
	return entries;
}

function jsonType(value: JsonValue): string {
	if (Array.isArray(value)) return "array";
	if (isJsonObject(value)) return "object";
	if (value === null) return "null";
	return typeof value;
}

function truncateUtf8Text(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "\n… content omitted";
	const available = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	let end = Math.min(text.length, available);
	let prefix = text.slice(0, end);
	while (Buffer.byteLength(prefix, "utf8") > available && end > 0) {
		end -= 1;
		prefix = text.slice(0, end);
	}
	return `${prefix}${marker}`;
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function formatGraphList(graphs: GraphSource[]): string {
	if (graphs.length === 0) return "No graphs found.";
	const rows = graphs.map((graph) => {
		const definition = graph.compiled.definition;
		const nodeCount = Object.keys(definition.nodes).length;
		return {
			name: definition.name,
			scope: graph.scope,
			nodes: `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}`,
			description: (definition.description ?? "").replace(/\s+/g, " ").trim(),
		};
	});
	const nameWidth = Math.min(40, Math.max(8, ...rows.map((row) => visibleWidth(row.name))));
	const nodesWidth = Math.max(5, ...rows.map((row) => visibleWidth(row.nodes)));
	const lines = [`Graphs (${rows.length})`, ""];
	for (const row of rows) {
		const name = padVisible(truncateToWidth(row.name, nameWidth, "…"), nameWidth);
		const scope = padVisible(`[${row.scope}]`, 10);
		const nodes = padVisible(row.nodes, nodesWidth);
		const tail = row.description ? `  ${truncateToWidth(row.description, 60, "…")}` : "";
		lines.push(`  ${name}  ${scope}${nodes}${tail}`);
	}
	return lines.join("\n");
}

function formatRunList(runs: CheckpointSummary[]): string {
	if (runs.length === 0) return "No pig checkpoints found.";
	return runs
		.map(
			(run) =>
				`${run.runId} · ${run.graphName} · ${run.status} · lease ${formatLease(run.lease, run.status)} · rev ${run.revision} · step ${run.step} · ${run.nodeRuns} node runs · ${run.tokens} tok · ${run.updatedAt}`,
		)
		.join("\n");
}

/** Data persisted with each "pig" chat entry; resultPreview feeds the markdown entry card. */
export interface PigEntryData {
	graph: string;
	runId: string;
	status: string;
	step: number;
	nodeRuns: number;
	tokens: number;
	error: string | null;
	resultPreview?: string | null;
}

function runSummary(result: GraphRunResult, graph: string): JsonObject {
	return {
		graph,
		runId: result.runId,
		status: result.status,
		step: result.step,
		nodeRuns: result.nodeRuns,
		tokens: usageTokens(result.usage),
		error: result.error ?? null,
		resultPreview: result.result ? formatResultProjection(result.result, Math.min(result.resultMaxBytes, 8000)) : null,
	};
}

export interface PigInspectEntryData {
	runId: string;
	path: string;
	status: string;
	graph: string;
	value: unknown;
}

export function renderPigInspectEntry(data: PigInspectEntryData | undefined, _expanded: boolean, theme: Theme): Component | undefined {
	if (!data) return undefined;
	const text =
		theme.fg("accent", "pig inspect") +
		" " +
		theme.fg("muted", `${data.graph} · ${data.status} · ${data.path}`);
	const container = new Container();
	container.addChild(new Text(text, 0, 0));
	if (typeof data.value === "string") {
		// Model-written state strings often contain literal "\n" escapes and inline
		// (N) enumerations instead of block layout; restore line breaks so the
		// Markdown renderer can lay them out. Display-only heuristic.
		const normalized = data.value
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/([。；;])\s*\((\d{1,2})\)\s*/g, "$1\n\n($2) ");
		container.addChild(new Markdown(normalized, 0, 0, getMarkdownTheme()));
	} else {
		container.addChild(
			new Markdown("```json\n" + JSON.stringify(data.value, null, 2) + "\n```", 0, 0, getMarkdownTheme()),
		);
	}
	return container;
}

export function renderPigEntry(data: PigEntryData | undefined, _expanded: boolean, theme: Theme): Component | undefined {
	if (!data) return undefined;
	const tone = data.status === "completed" ? "success" : data.status === "interrupted" ? "warning" : "error";
	let text =
		theme.fg("accent", "pig") +
		" " +
		theme.fg(tone, data.status) +
		theme.fg("muted", ` · ${data.graph} · ${data.step} steps · ${data.nodeRuns} node runs · ${data.tokens} tok`);
	if (data.error) text += `\n${theme.fg("error", data.error)}`;
	if (!data.resultPreview) return new Text(text, 0, 0);
	const container = new Container();
	container.addChild(new Text(`${text}\n`, 0, 0));
	container.addChild(new Markdown(data.resultPreview, 0, 0, getMarkdownTheme()));
	return container;
}

function toGraphRunEventView(event: GraphRunEvent): GraphRunEventView {
	return event.usage ? { ...event, usage: toTokenUsage(event.usage) } : { ...event };
}

function toTokenUsage(usage: GraphRunResult["usage"]): TokenUsageLedger {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		turns: usage.turns,
	};
}

function toCheckpointRecordView({ record, lease }: CheckpointInspection): Record<string, unknown> {
	const source = record.snapshot;
	const snapshot: Record<string, unknown> = {
		...source,
		usage: toTokenUsage(source.usage),
		history: source.history.map((entry) => ({ ...entry, usage: toTokenUsage(entry.usage) })),
	};
	if (source.inFlight) {
		snapshot.inFlight = {
			...source.inFlight,
			completed: Object.fromEntries(
				Object.entries(source.inFlight.completed).map(([nodeId, result]) => [
					nodeId,
					{ ...result, usage: toTokenUsage(result.usage) },
				]),
			),
		};
	}
	return { ...record, lease, snapshot };
}

function formatLease(lease: CheckpointLeaseView, status: CheckpointSnapshot["status"]): string {
	if (lease.status === "released") return status === "running" ? "released (resumable)" : "released";
	if (lease.status === "expired") return `expired at ${lease.expiresAt}${status === "running" ? " (resumable)" : ""}`;
	return `held until ${lease.expiresAt}`;
}

function getParentSessionProfile(ctx: ExtensionContext): ParentSessionProfile | undefined {
	return (ctx as ExtensionContext & { getChildSessionProfile?: () => ParentSessionProfile }).getChildSessionProfile?.();
}
