import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import { RuntimeGraphMonitor, renderRuntimeGraph } from "../src/runtime-visualization.ts";
import type {
	AgentNodeDefinition,
	GraphDefinition,
	GraphRunEvent,
	NodeDefinition,
	NodeExecutionContext,
	NodeExecutionResult,
	NodeExecutionSuccess,
	NodeExecutor,
} from "../src/types.ts";
import { emptyUsage } from "../src/utils.ts";

const graphDefinition: GraphDefinition = {
	schemaVersion: 2,
	name: "live-board",
	entry: "plan",
	nodes: {
		plan: agentNode(),
		research: agentNode(),
		implement: agentNode(),
		review: agentNode(),
	},
	edges: [
		{ from: "plan", to: ["research", "implement"] },
		{ from: ["research", "implement"], to: "review" },
		{ from: "review", cases: [], default: "plan" },
	],
};

test("runtime monitor renders the active graph location, retries, topology, and bounded output", () => {
	let now = 1_000;
	const monitor = new RuntimeGraphMonitor(graphDefinition, { now: () => now });
	monitor.apply(event("graph_start", { runId: "12345678-abcd", status: "running", step: 0 }));
	monitor.apply(event("step_start", { step: 1, scheduled: ["plan"] }));
	monitor.apply(event("node_start", { step: 1, nodeId: "plan", attempt: 1 }));
	now += 2_500;

	let lines = renderRuntimeGraph(monitor.view());
	assert.ok(lines.length <= 16);
	assert.match(lines[0], /live-board · RUNNING · step 1 · 12345678/);
	// Whole graph is one strongly connected component: chips render on one row joined by ⇄.
	const shapeRow = lines.find((line) => line.includes("plan") && line.includes("review"));
	assert.ok(shapeRow, `shape row missing: ${JSON.stringify(lines)}`);
	assert.ok((shapeRow?.match(/⇄/g) ?? []).length >= 3, `cycle members join with ⇄: ${shapeRow}`);
	assert.ok(/● plan(·|\s|$)/.test(shapeRow ?? ""), `running chip with elapsed missing: ${shapeRow}`);

	monitor.apply(event("node_settled", { step: 1, nodeId: "plan", attempt: 1, status: "completed" }));
	monitor.apply(event("node_end", { step: 1, nodeId: "plan", status: "completed" }));
	monitor.apply(event("step_start", { step: 2, scheduled: ["research", "implement"] }));
	monitor.apply(event("node_start", { step: 2, nodeId: "research", attempt: 1 }));
	monitor.apply(event("node_retry", { step: 2, nodeId: "research", attempt: 2, message: "temporary timeout" }));
	monitor.apply(event("node_start", { step: 2, nodeId: "implement", attempt: 1 }));

	lines = renderRuntimeGraph(monitor.view());
	assert.ok(lines.length <= 16);
	assert.ok(
		lines.some((line) => line.includes("temporary timeout")),
		"retrying node surfaces its activity message",
	);
	assert.ok(lines.some((line) => line.includes("↻ research")), "retrying chip keeps its glyph");
	assert.ok(lines.some((line) => /● implement/.test(line)), "running node keeps a chip");
	assert.match(lines[1], /active 2 · done 1\/4 · runs 3/);
});

test("runtime graph truncation respects terminal width for wide characters", () => {
	const definition: GraphDefinition = {
		...graphDefinition,
		name: "研究".repeat(30),
	};
	const monitor = new RuntimeGraphMonitor(definition);
	monitor.apply(event("graph_start", { status: "running" }));
	const lines = renderRuntimeGraph(monitor.view(), { maxLineLength: 40 });

	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.ok(lines[0].includes("…"));
});

test("runtime dashboard exposes token usage without cost estimates", () => {
	const monitor = new RuntimeGraphMonitor(graphDefinition);
	monitor.apply(event("graph_start", { status: "running" }));
	monitor.apply(
		event("usage_update", {
			usage: {
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				turns: 1,
			},
		}),
	);

	const view = monitor.view();
	const rendered = renderRuntimeGraph(view).join("\n");
	assert.equal("costUsd" in view.usage, false);
	assert.match(rendered, /120 tok/);
	assert.doesNotMatch(rendered, /\$|cost/i);
});

test("engine exposes structured scheduling and actual node settlement before bulk reconciliation", async () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "live-events",
		entry: ["first", "comma,node"],
		nodes: { first: agentNode(), "comma,node": agentNode() },
		limits: {
			maxSteps: 2,
			maxNodeRuns: 4,
			maxConcurrency: 1,
			maxCostUsd: 1,
			timeoutMs: 10_000,
			maxStateBytes: 100_000,
		},
	};
	let releaseSecond: (() => void) | undefined;
	let markSecondStarted: (() => void) | undefined;
	const secondStarted = new Promise<void>((resolve) => {
		markSecondStarted = resolve;
	});
	const secondGate = new Promise<void>((resolve) => {
		releaseSecond = resolve;
	});
	const events: GraphRunEvent[] = [];
	const executor: NodeExecutor = {
		async execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
			if (context.nodeId === "comma,node") {
				markSecondStarted?.();
				await secondGate;
			}
			return success(context);
		},
	};

	const run = new GraphEngine(compileGraph(definition), executor).run({
		checkpoint: false,
		onEvent: (runtimeEvent) => {
			events.push(runtimeEvent);
		},
	});
	await secondStarted;

	const stepStart = events.find((runtimeEvent) => runtimeEvent.type === "step_start");
	assert.deepEqual(stepStart?.scheduled, ["first", "comma,node"]);
	assert.ok(events.some((runtimeEvent) => runtimeEvent.type === "node_settled" && runtimeEvent.nodeId === "first"));
	assert.ok(events.some((runtimeEvent) => runtimeEvent.type === "node_start" && runtimeEvent.nodeId === "comma,node"));
	assert.equal(events.some((runtimeEvent) => runtimeEvent.type === "node_end"), false);

	releaseSecond?.();
	await run;
	assert.deepEqual(
		events.filter((runtimeEvent) => runtimeEvent.type === "node_settled").map((runtimeEvent) => runtimeEvent.nodeId),
		["first", "comma,node"],
	);
	assert.deepEqual(
		events.filter((runtimeEvent) => runtimeEvent.type === "node_end").map((runtimeEvent) => runtimeEvent.nodeId),
		["first", "comma,node"],
	);
});

test("runtime board shows live in-node agent activity with an animated running header", async () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "live-activity",
		entry: "worker",
		nodes: { worker: agentNode() },
		limits: {
			maxSteps: 2,
			maxNodeRuns: 2,
			maxConcurrency: 1,
			maxCostUsd: 1,
			timeoutMs: 10_000,
			maxStateBytes: 100_000,
		},
	};
	let releaseWorker: (() => void) | undefined;
	const workerGate = new Promise<void>((resolve) => {
		releaseWorker = resolve;
	});
	const monitor = new RuntimeGraphMonitor(definition);
	const executor: NodeExecutor = {
		async execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
			context.onEvent?.({
				type: "node_activity",
				runId: context.runId,
				timestamp: new Date().toISOString(),
				step: context.step,
				nodeId: context.nodeId,
				message: "bash(git status --short)",
			});
			await workerGate;
			return success(context);
		},
	};
	const run = new GraphEngine(compileGraph(definition), executor).run({
		checkpoint: false,
		onEvent: (runtimeEvent) => monitor.apply(runtimeEvent),
	});

	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		let lines = renderRuntimeGraph(monitor.view());
		assert.ok(lines.some((line) => line.includes("bash(git status --short)")));
		const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		assert.ok(spinnerFrames.some((frame) => lines[0].startsWith(frame)));
		assert.match(lines[0], /pig · live-activity · RUNNING/);
	} finally {
		releaseWorker?.();
		await run;
	}
	const settled = renderRuntimeGraph(monitor.view());
	assert.ok(settled.some((line) => line.includes("✓ worker")));
	assert.ok(settled[0].includes("COMPLETED"));
	assert.equal(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(settled[0]), false);
});

test("runtime dashboard updates token usage while an agent node is still running", async () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "live-usage",
		entry: "worker",
		nodes: { worker: agentNode() },
		limits: {
			maxSteps: 2,
			maxNodeRuns: 2,
			maxConcurrency: 1,
			maxCostUsd: 1,
			timeoutMs: 10_000,
			maxStateBytes: 100_000,
		},
	};
	let markReported: (() => void) | undefined;
	let releaseWorker: (() => void) | undefined;
	const reported = new Promise<void>((resolve) => {
		markReported = resolve;
	});
	const workerGate = new Promise<void>((resolve) => {
		releaseWorker = resolve;
	});
	const monitor = new RuntimeGraphMonitor(definition);
	const executor: NodeExecutor = {
		async execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
			context.budget.report({ inputTokens: 100, outputTokens: 20 });
			markReported?.();
			await workerGate;
			return success(context);
		},
	};
	const run = new GraphEngine(compileGraph(definition), executor).run({
		checkpoint: false,
		onEvent: (runtimeEvent) => monitor.apply(runtimeEvent),
	});

	try {
		await reported;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.match(renderRuntimeGraph(monitor.view())[1], /120 tok/);
		assert.equal(monitor.view().nodes[0]?.status, "running");
	} finally {
		releaseWorker?.();
		await run;
	}
});

test("engine events and results expose token usage without internal cost estimates", async () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "public-usage",
		entry: "worker",
		nodes: { worker: agentNode() },
		limits: {
			maxSteps: 2,
			maxNodeRuns: 2,
			maxConcurrency: 1,
			maxCostUsd: 1,
			timeoutMs: 10_000,
			maxStateBytes: 100_000,
		},
	};
	const events: GraphRunEvent[] = [];
	const executor: NodeExecutor = {
		async execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
			context.budget.report({ inputTokens: 100, outputTokens: 20, costUsd: 0.42 });
			return success(context);
		},
	};

	const result = await new GraphEngine(compileGraph(definition), executor).run({
		checkpoint: false,
		onEvent: (runtimeEvent) => {
			events.push(runtimeEvent);
		},
	});
	assert.equal("costUsd" in result.usage, false);
	assert.equal(result.usage.inputTokens + result.usage.outputTokens, 120);
	assert.ok(events.filter((runtimeEvent) => runtimeEvent.usage).every((runtimeEvent) => !("costUsd" in runtimeEvent.usage!)));
});

test("cancellation waits for active workers and never emits events after graph_end", async () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "cancel-events",
		entry: ["retrying", "slow"],
		nodes: {
			retrying: { ...agentNode(), retry: { maxAttempts: 2, backoffMs: 60_000 } },
			slow: agentNode(),
		},
		limits: {
			maxSteps: 2,
			maxNodeRuns: 4,
			maxConcurrency: 2,
			maxCostUsd: 1,
			timeoutMs: 10_000,
			maxStateBytes: 100_000,
		},
	};
	let releaseSlow: (() => void) | undefined;
	let markSlowStarted: (() => void) | undefined;
	let markRetry: (() => void) | undefined;
	const slowStarted = new Promise<void>((resolve) => {
		markSlowStarted = resolve;
	});
	const retrySeen = new Promise<void>((resolve) => {
		markRetry = resolve;
	});
	const slowGate = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	const events: GraphRunEvent[] = [];
	const executor: NodeExecutor = {
		async execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
			if (context.nodeId === "retrying") return retryableFailure();
			markSlowStarted?.();
			await slowGate;
			return success(context);
		},
	};
	const controller = new AbortController();
	const run = new GraphEngine(compileGraph(definition), executor).run({
		checkpoint: false,
		signal: controller.signal,
		onEvent: (runtimeEvent) => {
			events.push(runtimeEvent);
			if (runtimeEvent.type === "node_retry") markRetry?.();
		},
	});
	await Promise.all([slowStarted, retrySeen]);
	controller.abort();
	let runCompleted = false;
	void run.then(() => {
		runCompleted = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(runCompleted, false);

	releaseSlow?.();
	const result = await run;
	assert.equal(result.status, "cancelled");
	const graphEndIndex = events.findLastIndex((runtimeEvent) => runtimeEvent.type === "graph_end");
	assert.ok(graphEndIndex >= 0);
	assert.ok(
		events.every((runtimeEvent, index) => runtimeEvent.type !== "node_settled" || index < graphEndIndex),
	);
	const eventCount = events.length;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(events.length, eventCount);
});

test("graph failure marks never-started queued nodes as cancelled, not failed", () => {
	const monitor = new RuntimeGraphMonitor(graphDefinition);
	monitor.apply(event("graph_start", { status: "running" }));
	monitor.apply(event("step_start", { step: 1, scheduled: ["plan"] }));
	monitor.apply(event("graph_end", { step: 1, status: "failed", message: "scheduler failed" }));
	assert.equal(monitor.view().nodes.find((node) => node.id === "plan")?.status, "cancelled");
});

test("node activity keeps a bounded trail with the latest message inline", () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "trail",
		entry: "worker",
		nodes: { worker: agentNode() },
	};
	const monitor = new RuntimeGraphMonitor(definition);
	monitor.apply(event("graph_start", { status: "running" }));
	monitor.apply(event("node_start", { step: 1, nodeId: "worker", attempt: 1 }));
	for (const message of ["one", "two", "three", "four"]) {
		monitor.apply(event("node_activity", { step: 1, nodeId: "worker", message }));
	}
	assert.deepEqual(monitor.view().nodes[0]?.activities, ["two", "three", "four"]);
	monitor.apply(event("node_activity", { step: 1, nodeId: "worker", message: "four" }));
	assert.deepEqual(monitor.view().nodes[0]?.activities, ["two", "three", "four"], "consecutive duplicates collapse");

	const lines = renderRuntimeGraph(monitor.view());
	assert.ok(lines.some((line) => line.trim() === "four"), "latest activity stays visible");
	assert.equal(
		lines.some((line) => line.includes("● worker") && line.includes("one")),
		false,
		"activities beyond the rolling window are dropped",
	);

	monitor.apply(event("node_settled", { step: 1, nodeId: "worker", attempt: 1, status: "completed" }));
	monitor.apply(event("node_end", { step: 1, nodeId: "worker", status: "completed" }));
	const settled = renderRuntimeGraph(monitor.view());
	assert.ok(settled.some((line) => line.includes("✓ worker")));
	assert.equal(settled.some((line) => line.trim() === "four"), false, "completed nodes drop the trail");
});

test("activity trails respect the maxLines budget and per-line width", () => {
	const ids = ["n1", "n2", "n3", "n4", "n5", "n6"];
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "budget",
		entry: ids,
		nodes: Object.fromEntries(ids.map((id) => [id, agentNode()])),
	};
	const monitor = new RuntimeGraphMonitor(definition);
	monitor.apply(event("graph_start", { status: "running" }));
	for (const id of ids) {
		monitor.apply(event("node_start", { step: 1, nodeId: id, attempt: 1 }));
		for (const index of [1, 2, 3]) {
			monitor.apply(event("node_activity", { step: 1, nodeId: id, message: `${id} step ${index} ${"x".repeat(200)}` }));
		}
	}
	const lines = renderRuntimeGraph(monitor.view());
	assert.ok(lines.length <= 16, `line budget exceeded: ${lines.length}`);
	assert.ok(lines.every((line) => visibleWidth(line) <= 120));
	// All six parallel entry nodes share one shape row; trails fill the rest.
	const shapeRow = lines.find((line) => line.includes("● n1"));
	assert.ok(shapeRow?.includes("n6"), `parallel chips share a row: ${shapeRow}`);
	assert.ok(lines.some((line) => /^● n\d$/.test(line)), "single active node omits the group header");
	assert.ok(lines.some((line) => /^  n\d step/.test(line)), "activities render indented under their node");
	assert.ok(lines.some((line) => line.startsWith("────")), "a rule separates the shape from the activity log");
});

function agentNode(): AgentNodeDefinition {
	return { type: "agent", prompt: "test", readOnly: true };
}

function event(type: GraphRunEvent["type"], overrides: Partial<GraphRunEvent> = {}): GraphRunEvent {
	return {
		type,
		runId: "12345678-abcd",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

function success(context: NodeExecutionContext): NodeExecutionSuccess {
	return {
		kind: "success",
		writes: [],
		usage: emptyUsage(),
		attempts: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		output: context.nodeId,
	};
}

function retryableFailure(): NodeExecutionResult {
	return {
		kind: "failure",
		error: "temporary failure",
		code: "TEMPORARY",
		retryable: true,
		usage: emptyUsage(),
		attempts: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
	};
}
