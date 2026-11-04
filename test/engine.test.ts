import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckpointLeaseError, FileCheckpointStore } from "../src/checkpoint.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import { PiNodeExecutor } from "../src/pi-executor.ts";
import type {
	AgentNodeDefinition,
	GraphDefinition,
	JsonValue,
	NodeDefinition,
	NodeExecutionContext,
	NodeExecutionFailure,
	NodeExecutionResult,
	NodeExecutionSuccess,
	NodeExecutor,
	NodeUsage,
	StateWrite,
} from "../src/types.ts";
import { emptyUsage, getPath } from "../src/utils.ts";

class FunctionExecutor implements NodeExecutor {
	private readonly handler: (node: NodeDefinition, context: NodeExecutionContext) => Promise<NodeExecutionResult> | NodeExecutionResult;

	constructor(handler: (node: NodeDefinition, context: NodeExecutionContext) => Promise<NodeExecutionResult> | NodeExecutionResult) {
		this.handler = handler;
	}

	execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
		return Promise.resolve(this.handler(node, context));
	}
}

test("fan-out nodes join through a fan-in barrier", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "fan-in",
		entry: ["left", "right"],
		nodes: {
			left: agentNode(),
			right: agentNode(),
			join: agentNode(),
		},
		edges: [
			{ from: ["left", "right"], to: "join" },
			{ from: "join", to: "__end__" },
		],
		limits: boundedLimits(),
	});
	const calls: string[] = [];
	const executor = new FunctionExecutor((_node, context) => {
		calls.push(context.nodeId);
		if (context.nodeId === "join") {
			return success(context, "outputs.join", {
				left: getPath(context.state, "outputs.left") ?? null,
				right: getPath(context.state, "outputs.right") ?? null,
			});
		}
		return success(context, `outputs.${context.nodeId}`, context.nodeId);
	});
	const result = await new GraphEngine(graph, executor).run({ input: { task: "x" }, checkpoint: false });
	assert.equal(result.status, "completed");
	assert.equal(result.step, 2);
	assert.deepEqual(new Set(calls.slice(0, 2)), new Set(["left", "right"]));
	assert.equal(calls[2], "join");
	assert.deepEqual(getPath(result.state, "outputs.join"), { left: "left", right: "right" });
});

test("explicit reviewer decisions loop through repeated rejections until approval", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "review-loop",
		entry: "writer",
		nodes: {
			writer: agentNode(),
			reviewer: { ...agentNode(), purpose: "reviewer", readOnly: true },
		},
		edges: [
			{ from: "writer", to: "reviewer" },
			{
				from: "reviewer",
				cases: [
					{ when: { path: "review.approved", op: "eq", value: true }, to: "__end__" },
					{ when: { path: "review.approved", op: "eq", value: false }, to: "writer" },
				],
			},
		],
		limits: boundedLimits(),
	});
	const executor = new FunctionExecutor((_node, context) => {
		const currentVersion = Number(getPath(context.state, "draft.version") ?? 0);
		if (context.nodeId === "writer") return success(context, "draft.version", currentVersion + 1);
		return success(context, "review", { approved: currentVersion >= 4, version: currentVersion });
	});
	const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
	assert.equal(result.status, "completed");
	assert.equal(getPath(result.state, "draft.version"), 4);
	assert.equal(getPath(result.state, "review.approved"), true);
	assert.equal(result.step, 8);
});

test("omitted structural limits do not cap valid review revisions", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "unbounded-review-loop",
		entry: "writer",
		nodes: {
			writer: agentNode(),
			reviewer: { ...agentNode(), purpose: "reviewer", readOnly: true },
		},
		edges: [
			{ from: "writer", to: "reviewer" },
			{
				from: "reviewer",
				cases: [
					{ when: { path: "review.approved", op: "eq", value: true }, to: "__end__" },
					{ when: { path: "review.approved", op: "eq", value: false }, to: "writer" },
				],
			},
		],
		limits: { timeoutMs: 10_000, maxCostUsd: 1 },
	});
	const targetVersion = 65;
	const executor = new FunctionExecutor((_node, context) => {
		const currentVersion = Number(getPath(context.state, "draft.version") ?? 0);
		if (context.nodeId === "writer") return success(context, "draft.version", currentVersion + 1);
		return success(context, "review", { approved: currentVersion >= targetVersion });
	});
	const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
	assert.equal(result.status, "completed", result.error);
	assert.equal(getPath(result.state, "draft.version"), targetVersion);
	assert.equal(result.step, targetVersion * 2);
	assert.equal(result.nodeRuns, targetVersion * 2);
});

test("explicit structural limits remain hard guardrails", async () => {
	for (const [limits, expectedError] of [
		[{ maxSteps: 3, maxNodeRuns: 10 }, /maxSteps \(3\)/],
		[{ maxSteps: 10, maxNodeRuns: 3 }, /maxNodeRuns \(3\)/],
	] as const) {
		const graph = compileGraph({
			schemaVersion: 2,
			name: "bounded-loop",
			entry: "worker",
			nodes: { worker: agentNode() },
			edges: [{ from: "worker", to: "worker" }],
			limits: { ...limits, timeoutMs: 10_000, maxCostUsd: 1 },
		});
		const result = await new GraphEngine(
			graph,
			new FunctionExecutor((_node, context) => success(context, "output", context.step)),
		).run({ checkpoint: false });
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", expectedError);
	}
});

test("reviewer execution failure never becomes a solver revision", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "review-failure",
		entry: "writer",
		nodes: {
			writer: agentNode(),
			reviewer: { ...agentNode(), purpose: "reviewer", readOnly: true },
		},
		edges: [
			{ from: "writer", to: "reviewer" },
			{
				from: "reviewer",
				cases: [
					{ when: { path: "review.approved", op: "eq", value: true }, to: "__end__" },
					{ when: { path: "review.approved", op: "eq", value: false }, to: "writer" },
				],
			},
		],
		limits: boundedLimits(),
	});
	let writerRuns = 0;
	let reviewerRuns = 0;
	const executor = new FunctionExecutor((_node, context) => {
		if (context.nodeId === "writer") {
			writerRuns += 1;
			return success(context, "draft.version", writerRuns);
		}
		reviewerRuns += 1;
		return reviewerRuns === 1
			? success(context, "review", { approved: false })
			: failure("reviewer infrastructure failure", false);
	});
	const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /reviewer infrastructure failure/);
	assert.equal(writerRuns, 2);
	assert.equal(reviewerRuns, 2);
	assert.equal(getPath(result.state, "review.approved"), false);
});

test("parallel writes require a reducer", async () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "conflict",
		entry: ["a", "b"],
		nodes: { a: agentNode(), b: agentNode() },
		limits: boundedLimits(),
	};
	const executor = new FunctionExecutor((_node, context) => success(context, "shared.values", context.nodeId));
	const failed = await new GraphEngine(compileGraph(definition), executor).run({ checkpoint: false });
	assert.equal(failed.status, "failed");
	assert.match(failed.error ?? "", /Parallel state conflict/);

	definition.reducers = { "shared.values": "append" };
	const completed = await new GraphEngine(compileGraph(definition), executor).run({ checkpoint: false });
	assert.equal(completed.status, "completed");
	assert.deepEqual(getPath(completed.state, "shared.values"), ["a", "b"]);
});

test("retry policy re-runs a retryable idempotent node", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "retry",
		entry: "flaky",
		nodes: {
			flaky: { ...agentNode(), idempotent: true, retry: { maxAttempts: 2 } },
		},
		limits: boundedLimits(),
	});
	let attempts = 0;
	const executor = new FunctionExecutor((_node, context) => {
		attempts += 1;
		return attempts === 1 ? failure("temporary", true) : success(context, "outputs.flaky", "ok");
	});
	const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
	assert.equal(result.status, "completed");
	assert.equal(attempts, 2);
	assert.equal(result.nodeRuns, 2);
	assert.equal(getPath(result.state, "outputs.flaky"), "ok");
});

test("engine applies node timeout signals to custom executors", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "custom-executor-timeout",
		entry: "slow",
		nodes: { slow: { ...agentNode(), limits: { timeoutMs: 20 } } },
		limits: { ...boundedLimits(), timeoutMs: 250 },
	});
	let signalAborted = false;
	const executor = new FunctionExecutor(async (_node, context) => {
		await new Promise<void>((_resolve, reject) => {
			const abort = () => {
				signalAborted = true;
				reject(new Error("executor observed abort"));
			};
			if (context.signal?.aborted) abort();
			else context.signal?.addEventListener("abort", abort, { once: true });
		});
		return success(context, "outputs.slow", "late");
	});

	const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /Node slow exceeded timeoutMs \(20\)/);
	assert.equal(signalAborted, true);
});

test("retry backoff is cancelled with the run signal", async () => {
	const controller = new AbortController();
	const graph = compileGraph({
		schemaVersion: 2,
		name: "cancel-retry-backoff",
		entry: "flaky",
		nodes: {
			flaky: { ...agentNode(), idempotent: true, retry: { maxAttempts: 2, backoffMs: 10_000 } },
		},
		limits: boundedLimits(),
	});
	let attempts = 0;
	const executor = new FunctionExecutor(() => {
		attempts += 1;
		return failure("temporary", true);
	});
	const result = await new GraphEngine(graph, executor).run({
		checkpoint: false,
		signal: controller.signal,
		onEvent: (event) => {
			if (event.type === "node_retry") controller.abort();
		},
	});
	assert.equal(result.status, "cancelled");
	assert.match(result.error ?? "", /aborted/i);
	assert.equal(attempts, 1);
});

test("zero retry backoff preserves immediate retry cancellation semantics", async () => {
	const controller = new AbortController();
	const graph = compileGraph({
		schemaVersion: 2,
		name: "cancel-zero-retry-backoff",
		entry: "flaky",
		nodes: {
			flaky: { ...agentNode(), idempotent: true, retry: { maxAttempts: 2, backoffMs: 0 } },
		},
		limits: boundedLimits(),
	});
	let attempts = 0;
	const executor = new FunctionExecutor(() => {
		attempts += 1;
		return failure("temporary", true);
	});
	const result = await new GraphEngine(graph, executor).run({
		checkpoint: false,
		signal: controller.signal,
		onEvent: (event) => {
			if (event.type === "node_retry") controller.abort();
		},
	});
	assert.equal(result.status, "cancelled");
	assert.equal(result.error, "Graph run aborted");
	assert.equal(attempts, 1);
});

test("onError continue isolates a failed node", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "isolation",
		entry: "bad",
		nodes: {
			bad: { ...agentNode(), onError: { strategy: "continue" } },
			next: agentNode(),
		},
		edges: [{ from: "bad", to: "next" }],
		limits: boundedLimits(),
	});
	const executor = new FunctionExecutor((_node, context) =>
		context.nodeId === "bad" ? failure("upstream unavailable", false) : success(context, "outputs.next", "continued"),
	);
	const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
	assert.equal(result.status, "completed");
	assert.equal(getPath(result.state, "errors.bad.message"), "upstream unavailable");
	assert.equal(getPath(result.state, "outputs.next"), "continued");
	assert.equal(result.nodeRuns, 2);
});

test("an executor-reported abort preserves external cancellation semantics", async () => {
	const controller = new AbortController();
	const graph = compileGraph({
		schemaVersion: 2,
		name: "external-cancellation",
		entry: "worker",
		nodes: { worker: agentNode() },
		limits: boundedLimits(),
	});
	const executor = new FunctionExecutor(() => {
		controller.abort(new Error("cancelled by caller"));
		return {
			...failure("worker observed abort", false),
			code: "ABORTED",
		};
	});

	const result = await new GraphEngine(graph, executor).run({ checkpoint: false, signal: controller.signal });
	assert.equal(result.status, "cancelled");
	assert.match(result.error ?? "", /cancelled|aborted/i);
});

test("cancellation persists usage and does not replay settled peers", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-cancel-accounting-"));
	try {
		const controller = new AbortController();
		const store = new FileCheckpointStore(directory);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "cancel-accounting",
			entry: ["done", "blocked"],
			nodes: { done: agentNode(), blocked: agentNode() },
			limits: boundedLimits(),
		});
		let doneCalls = 0;
		let blockedCalls = 0;
		let markBlockedStarted: (() => void) | undefined;
		const blockedStarted = new Promise<void>((resolve) => {
			markBlockedStarted = resolve;
		});
		const executor = new FunctionExecutor(async (_node, context) => {
			if (context.nodeId === "done") {
				doneCalls += 1;
				await blockedStarted;
				const usage: NodeUsage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, costUsd: 0 };
				context.budget.report(usage);
				return {
					kind: "success",
					writes: [{ path: "outputs.done", value: true, nodeId: context.nodeId }],
					usage,
					attempts: 1,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
			}

			blockedCalls += 1;
			const usage: NodeUsage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, costUsd: 0 };
			context.budget.report(usage);
			markBlockedStarted?.();
			if (blockedCalls > 1) {
				return {
					kind: "success",
					writes: [{ path: "outputs.blocked", value: true, nodeId: context.nodeId }],
					usage,
					attempts: 1,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
			}
			await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { ...failure("worker observed cancellation", false), code: "ABORTED", usage };
		});

		const cancelled = await new GraphEngine(graph, executor, { checkpointStore: store }).run({
			checkpoint: true,
			signal: controller.signal,
			onEvent: (event) => {
				if (event.type === "node_settled" && event.nodeId === "done") controller.abort();
			},
		});
		assert.equal(cancelled.status, "cancelled");
		const first = await store.load(cancelled.runId);
		assert.equal(first.snapshot.usage.inputTokens, 12);
		assert.equal(first.snapshot.usage.outputTokens, 5);
		assert.deepEqual(first.snapshot.history.map((item) => [item.nodeId, item.status]), [
			["done", "completed"],
			["blocked", "cancelled"],
		]);
		assert.deepEqual(Object.keys(first.snapshot.inFlight?.completed ?? {}), ["done"]);
		assert.deepEqual(first.snapshot.inFlight?.unresolved, ["blocked"]);

		const resumed = await new GraphEngine(graph, executor, { checkpointStore: store }).run({
			runId: cancelled.runId,
			checkpoint: true,
		});
		assert.equal(resumed.status, "completed");
		assert.equal(doneCalls, 1);
		assert.equal(blockedCalls, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("durable turns and execution ids survive recovery without double accounting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-durable-turn-"));
	try {
		const controller = new AbortController();
		const store = new FileCheckpointStore(directory);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "durable-turn",
			entry: "worker",
			nodes: { worker: agentNode() },
			limits: boundedLimits(),
		});
		const executionIds: string[] = [];
		let calls = 0;
		const usage: NodeUsage = {
			inputTokens: 7,
			outputTokens: 3,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			turns: 1,
			costUsd: 0,
		};
		const executor = new FunctionExecutor(async (_node, context) => {
			calls += 1;
			assert.ok(context.executionId);
			executionIds.push(context.executionId);
			await context.recordTurn?.({ id: "assistant-entry-1", usage });
			if (calls === 1) {
				controller.abort();
				return { ...failure("process stopped", false), code: "ABORTED", usage };
			}
			return {
				kind: "success",
				writes: [{ path: "outputs.worker", value: true, nodeId: context.nodeId }],
				usage,
				attempts: 1,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			};
		});

		const first = await new GraphEngine(graph, executor, { checkpointStore: store }).run({
			checkpoint: true,
			signal: controller.signal,
		});
		assert.equal(first.status, "cancelled");
		const cancelled = await store.load(first.runId);
		assert.equal(cancelled.snapshot.usage.turns, 1);
		assert.deepEqual(cancelled.snapshot.inFlight?.progress?.worker.accountedTurnIds, ["assistant-entry-1"]);

		const resumed = await new GraphEngine(graph, executor, { checkpointStore: store }).run({
			runId: first.runId,
			checkpoint: true,
		});
		assert.equal(resumed.status, "completed");
		assert.equal(resumed.usage.turns, 1);
		assert.equal(calls, 2);
		assert.deepEqual(executionIds, [executionIds[0], executionIds[0]]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("graph timeout persists partial usage and node history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-timeout-accounting-"));
	try {
		const store = new FileCheckpointStore(directory);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "timeout-accounting",
			entry: "worker",
			nodes: { worker: agentNode() },
			limits: { ...boundedLimits(), timeoutMs: 10_000 },
		});
		const executor = new FunctionExecutor(async (_node, context) => {
			const usage: NodeUsage = { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, costUsd: 0 };
			context.budget.report(usage);
			await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { ...failure("worker observed timeout", false), usage };
		});

		const result = await new GraphEngine(graph, executor, { checkpointStore: store }).run({ checkpoint: true });
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /timeoutMs \(10000\)/);
		const { snapshot } = await store.load(result.runId);
		assert.equal(snapshot.usage.inputTokens, 9);
		assert.equal(snapshot.usage.outputTokens, 4);
		assert.deepEqual(snapshot.history.map((item) => [item.nodeId, item.status]), [["worker", "failed"]]);
		assert.equal(snapshot.history[0]?.usage.inputTokens, 9);
		assert.deepEqual(snapshot.inFlight?.unresolved, ["worker"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("human interrupt persists and resumes from the same step", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-test-"));
	try {
		const store = new FileCheckpointStore(directory);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "approval",
			entry: "approval",
			nodes: {
				approval: { type: "human", kind: "confirm", prompt: "Approve?", output: "approval.accepted" },
				done: { type: "set", assign: [{ path: "done", value: true }] },
			},
			edges: [{ from: "approval", to: "done" }],
			limits: boundedLimits(),
		});
		const executor = new PiNodeExecutor({ cwd: process.cwd(), hasUI: false });
		const engine = new GraphEngine(graph, executor, { checkpointStore: store });
		const interrupted = await engine.run({ checkpoint: true });
		assert.equal(interrupted.status, "interrupted");
		assert.equal(interrupted.interrupt?.nodeId, "approval");

		const resumed = await engine.run({ runId: interrupted.runId, resumeValue: true, checkpoint: true });
		assert.equal(resumed.status, "completed");
		assert.equal(getPath(resumed.state, "approval.accepted"), true);
		assert.equal(getPath(resumed.state, "done"), true);
		assert.equal(resumed.step, 2);
		const { snapshot } = await store.load(interrupted.runId);
		assert.equal(snapshot.status, "completed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a run lease prevents two engine instances from resuming the same run", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-concurrent-resume-"));
	let releaseWorker: (() => void) | undefined;
	try {
		const graph = compileGraph({
			schemaVersion: 2,
			name: "exclusive-resume",
			entry: "approval",
			nodes: {
				approval: { type: "human", kind: "confirm", prompt: "Approve?", output: "approved" },
				worker: agentNode(),
			},
			edges: [{ from: "approval", to: "worker" }],
			limits: boundedLimits(),
		});
		const initialStore = new FileCheckpointStore(directory);
		const interrupted = await new GraphEngine(
			graph,
			new PiNodeExecutor({ cwd: process.cwd(), hasUI: false }),
			{ checkpointStore: initialStore },
		).run({ checkpoint: true });
		assert.equal(interrupted.status, "interrupted");

		let workerCalls = 0;
		let markWorkerStarted: (() => void) | undefined;
		const workerStarted = new Promise<void>((resolve) => {
			markWorkerStarted = resolve;
		});
		const workerGate = new Promise<void>((resolve) => {
			releaseWorker = resolve;
		});
		const executor = new FunctionExecutor(async (_node, context) => {
			if (context.nodeId === "approval") return success(context, "approved", true);
			workerCalls += 1;
			markWorkerStarted?.();
			await workerGate;
			return success(context, "result", "done");
		});
		const firstResume = new GraphEngine(graph, executor, {
			checkpointStore: new FileCheckpointStore(directory),
		}).run({ runId: interrupted.runId, resumeValue: true, checkpoint: true });
		await workerStarted;

		await assert.rejects(
			new GraphEngine(graph, executor, { checkpointStore: new FileCheckpointStore(directory) }).run({
				runId: interrupted.runId,
				resumeValue: true,
				checkpoint: true,
			}),
			(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_HELD",
		);
		releaseWorker?.();
		releaseWorker = undefined;
		const completed = await firstResume;
		assert.equal(completed.status, "completed");
		assert.equal(workerCalls, 1);
	} finally {
		releaseWorker?.();
		await rm(directory, { recursive: true, force: true });
	}
});

test("result projection keeps large internal state out of the user-facing result", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "project-result",
		entry: "writer",
		nodes: { writer: agentNode() },
		result: { paths: ["result.summary"], includeState: false, maxBytes: 4096 },
		limits: boundedLimits(),
	});
	const executor = new FunctionExecutor((_node, context) => ({
		kind: "success",
		writes: [
			{ path: "working.transcript", value: "x".repeat(40_000), nodeId: context.nodeId },
			{ path: "result.summary", value: "compact", nodeId: context.nodeId },
		],
		output: "compact",
		usage: zeroNodeUsage(),
		attempts: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
	}));
	const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
	assert.equal(result.status, "completed");
	assert.ok(result.stateBytes > 40_000);
	assert.deepEqual(result.result, { result: { summary: "compact" } });
	assert.equal(result.includeState, false);
});

test("state path budgets fail the graph immediately after an oversized commit", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "state-path-budget",
		entry: "writer",
		nodes: { writer: agentNode() },
		statePolicy: { paths: { "working.summary": { maxBytes: 32 } } },
		limits: boundedLimits(),
	});
	const result = await new GraphEngine(
		graph,
		new FunctionExecutor((_node, context) => success(context, "working.summary", "x".repeat(100))),
	).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /working\.summary.*10[02] bytes.*maxBytes is 32/i);
});

test("graph state budgets fail before oversized state can advance the graph", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "hot-state-budget",
		entry: "writer",
		nodes: { writer: agentNode() },
		limits: { ...boundedLimits(), maxStateBytes: 64 },
	});
	const result = await new GraphEngine(
		graph,
		new FunctionExecutor((_node, context) => success(context, "working.large", "x".repeat(100))),
	).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /graph state is .*bytes.*maxStateBytes is 64/i);
});

function agentNode(): AgentNodeDefinition {
	return { type: "agent", prompt: "test", readOnly: true };
}

function boundedLimits(): GraphDefinition["limits"] {
	return {
		maxSteps: 12,
		maxNodeRuns: 24,
		maxConcurrency: 4,
		maxCostUsd: 1,
		timeoutMs: 30_000,
		maxStateBytes: 1_000_000,
	};
}

function success(context: NodeExecutionContext, path: string, value: JsonValue): NodeExecutionSuccess {
	const usage = zeroNodeUsage();
	context.budget.report(usage);
	const writes: StateWrite[] = [{ path, value, nodeId: context.nodeId }];
	return {
		kind: "success",
		writes,
		output: value,
		usage,
		attempts: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
	};
}

function failure(message: string, retryable: boolean): NodeExecutionFailure {
	return {
		kind: "failure",
		error: message,
		code: "TEST_FAILURE",
		retryable,
		usage: zeroNodeUsage(),
		attempts: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
	};
}

function zeroNodeUsage(): NodeUsage {
	return { ...emptyUsage() };
}
