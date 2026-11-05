import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCheckpointStore, GateNodeExecutor, GraphEngine, PiNodeExecutor, compileGraph } from "../src/index.ts";
import type { GateReport } from "../src/gate/executor.ts";
import type { AgentNodeDefinition, GraphDefinition } from "../src/types.ts";
import { getPath } from "../src/utils.ts";
import { demoGraph, prepareFixture, ScriptedRepairRuntime } from "../scripts/gate-fixture.ts";

async function scenario(kind: "pass" | "repair" | "exhaust" | "tamper", run: (fixture: {
	root: string; workspace: string; runtime: ScriptedRepairRuntime; definition: GraphDefinition;
	engine: GraphEngine; store: FileCheckpointStore; reports: () => Promise<GateReport[]>;
}) => Promise<void>, configure?: (definition: GraphDefinition) => void) {
	const root = await mkdtemp(join(tmpdir(), "gatenode-test-"));
	try {
		const workspace = await prepareFixture(root);
		const runtime = new ScriptedRepairRuntime(workspace, kind);
		const definition = await demoGraph(root, workspace);
		configure?.(definition);
		const store = new FileCheckpointStore(join(root, "checkpoints"));
		const inner = new PiNodeExecutor({ cwd: root, hasUI: false, agentRuntime: runtime });
		const executor = new GateNodeExecutor(inner, { cwd: root, reportsDir: join(root, "reports") });
		const engine = new GraphEngine(compileGraph(definition), executor, { checkpointStore: store });
		const reports = async () => Promise.all((await readdir(join(root, "reports"))).filter((name) => name.endsWith(".json"))
			.map(async (name) => JSON.parse(await readFile(join(root, "reports", name), "utf8")) as GateReport));
		await run({ root, workspace, runtime, definition, engine, store, reports });
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("gate accepts an immediately valid candidate and executes the success branch", async () => {
	await scenario("pass", async ({ engine, runtime, reports }) => {
		const result = await engine.run({ checkpoint: true });
		assert.equal(result.status, "completed");
		assert.equal(getPath(result.state, "result.status"), "accepted");
		assert.equal(runtime.calls.length, 1);
		assert.equal((await reports())[0].status, "passed");
	});
});

test("cancelling during final gate notification does not record a successful node", async () => {
	await scenario("pass", async ({ engine, store, reports }) => {
		const controller = new AbortController();
		const result = await engine.run({ checkpoint: true, signal: controller.signal, onEvent(event) {
			if (event.type === "node_activity" && event.message?.startsWith("GateNode passed")) controller.abort();
		} });
		assert.equal(result.status, "cancelled");
		assert.equal(getPath(result.state, "outputs.implementer"), undefined);
		const { snapshot } = await store.load(result.runId);
		assert.ok(!snapshot.history.some((item) => item.nodeId === "implementer" && item.status === "completed"));
		assert.equal((await reports())[0].status, "failed");
	});
});

test("gate feeds real compiler diagnostics into a new invocation and commits only the accepted candidate", async () => {
	await scenario("repair", async ({ engine, runtime, store, reports }) => {
		const result = await engine.run({ checkpoint: true });
		assert.equal(result.status, "completed");
		assert.equal(runtime.calls.length, 2);
		assert.notEqual(runtime.calls[0].context.executionId, runtime.calls[1].context.executionId);
		assert.match(runtime.calls[1].prompt.text, /TS2322/);
		assert.match(runtime.calls[1].prompt.text, /src[\\/]items.ts/);
		assert.equal(getPath(runtime.calls[1].context.state, "outputs.implementer"), undefined);
		assert.equal(getPath(result.state, "outputs.implementer"), "Scripted candidate 2");
		assert.equal(result.usage.turns, 2, "all repair turns must count even when their local turn ids match");
		const { snapshot } = await store.load(result.runId);
		assert.equal(snapshot.history.filter((item) => item.nodeId === "implementer" && item.status === "completed").length, 1);
		const report = (await reports())[0];
		assert.equal(report.rounds.length, 2);
		assert.equal(report.rounds[0].checks[0].status, "rejected");
		assert.ok(report.rounds[1].checks.every((check) => check.status === "passed"));
	});
});

test("exhaustion preserves failure history, skips success downstream and resumes human acknowledgement without acceptance", async () => {
	await scenario("exhaust", async ({ engine, runtime, store, reports }) => {
		const result = await engine.run({ checkpoint: true });
		assert.equal(runtime.calls.length, 3);
		assert.equal(result.status, "interrupted");
		assert.equal(result.interrupt?.nodeId, "manual");
		assert.equal(getPath(result.state, "errors.implementer.code"), "GATE_EXHAUSTED");
		assert.equal(getPath(result.state, "outputs.implementer"), undefined);
		assert.equal(getPath(result.state, "result"), undefined);
		const { snapshot } = await store.load(result.runId);
		assert.equal(snapshot.history.find((item) => item.nodeId === "implementer")?.status, "failed");
		assert.ok(!snapshot.history.some((item) => item.nodeId === "accepted"));
		const resumed = await engine.run({ runId: result.runId, resumeValue: "acknowledge", checkpoint: true });
		assert.equal(getPath(resumed.state, "result.status"), "needs_manual_repair");
		assert.equal(runtime.calls.length, 3);
		assert.equal((await reports())[0].status, "failed");
	});
});

test("protected test edits fail before executing the modified tests", async () => {
	await scenario("tamper", async ({ engine, runtime, reports }) => {
		const result = await engine.run({ checkpoint: true });
		assert.equal(getPath(result.state, "errors.implementer.code"), "GATE_PROTECTED_FILES");
		assert.equal(runtime.calls.length, 1);
		assert.equal((await reports())[0].rounds[0].checks.length, 0);
	});
});

test("broken checker configuration is a tool error, never a successful check or repeated repair", async () => {
	await scenario("pass", async ({ engine, workspace, runtime }) => {
		await writeFile(join(workspace, "tsconfig.json"), '{"compilerOptions":{"nonexistentOption":true}}');
		const result = await engine.run({ checkpoint: true });
		assert.equal(getPath(result.state, "errors.implementer.code"), "GATE_CHECK_ERROR");
		assert.equal(result.status, "interrupted");
		assert.equal(runtime.calls.length, 1);
	});
});

test("unused-source diagnostics are repairable code errors, not checker configuration failures", async () => {
	await scenario("repair", async ({ engine, workspace, runtime, reports }) => {
		const config = JSON.parse(await readFile(join(workspace, "tsconfig.json"), "utf8"));
		config.compilerOptions.noUnusedLocals = true;
		await writeFile(join(workspace, "tsconfig.json"), JSON.stringify(config));
		const result = await engine.run({ checkpoint: true });
		assert.equal(getPath(result.state, "result.status"), "accepted");
		assert.equal(runtime.calls.length, 2);
		assert.match(runtime.calls[1].prompt.text, /TS6133/);
		assert.equal((await reports())[0].rounds[0].checks[0].status, "rejected");
	});
});

test("a compiler configuration selecting no inputs stops without attempting code repair", async () => {
	await scenario("pass", async ({ engine, workspace, runtime }) => {
		await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ include: ["missing/**/*.ts"] }));
		const result = await engine.run({ checkpoint: true });
		assert.equal(getPath(result.state, "errors.implementer.code"), "GATE_CHECK_ERROR");
		assert.equal(runtime.calls.length, 1);
	});
});

test("node turn budget covers the entire repair loop", async () => {
	await scenario("exhaust", async ({ engine, runtime }) => {
		const result = await engine.run({ checkpoint: true });
		assert.notEqual(getPath(result.state, "result.status"), "accepted");
		assert.equal(runtime.calls.length, 2);
		assert.equal(result.usage.turns, 2);
	}, (definition) => { definition.nodes.implementer.limits = { maxTurns: 1, timeoutMs: 30000 }; });
});

test("an empty test file cannot count as behavioral verification", async () => {
	await scenario("pass", async ({ engine, workspace, runtime }) => {
		await writeFile(join(workspace, "tests", "items.test.ts"), "// No actual tests\n");
		const result = await engine.run({ checkpoint: true });
		assert.equal(getPath(result.state, "errors.implementer.code"), "GATE_CHECK_ERROR");
		assert.equal(runtime.calls.length, 1);
	});
});

test("a plain PiNodeExecutor refuses gated nodes instead of bypassing validation", async () => {
	await scenario("pass", async ({ root, runtime, definition }) => {
		const engine = new GraphEngine(compileGraph(definition), new PiNodeExecutor({ cwd: root, hasUI: false, agentRuntime: runtime }));
		const result = await engine.run({ checkpoint: false });
		assert.equal(runtime.calls.length, 0);
		assert.equal(getPath(result.state, "errors.implementer.code"), "GATE_EXECUTOR_REQUIRED");
	});
});

test("re-entering an existing gate identity fails closed instead of silently replaying or resetting attempts", async () => {
	await scenario("pass", async ({ root, runtime, definition, engine }) => {
		await engine.run({ checkpoint: true });
		const previous = runtime.calls[0].context;
		const context = { ...previous, executionId: previous.executionId!.replace(/:gate:1$/, "") };
		const inner = new PiNodeExecutor({ cwd: root, hasUI: false, agentRuntime: runtime });
		const executor = new GateNodeExecutor(inner, { cwd: root, reportsDir: join(root, "reports") });
		const result = await executor.execute(definition.nodes.implementer, context);
		assert.equal(result.kind, "failure");
		if (result.kind === "failure") assert.equal(result.code, "GATE_RECOVERY_REQUIRED");
		assert.equal(runtime.calls.length, 1);
	});
});

test("compilation rejects nested retries, shared history, unsafe paths and bypass error routes", async () => {
	const root = await mkdtemp(join(tmpdir(), "gatenode-policy-"));
	try {
		const source = await demoGraph(root, join(root, "workspace"));
		for (const mutate of [
			(node: AgentNodeDefinition) => { node.retry = { maxAttempts: 2 }; },
			(node: AgentNodeDefinition) => { node.context = { mode: "thread" }; },
			(node: AgentNodeDefinition) => { node.gate!.writableFiles = ["../tsconfig.json"]; },
			(node: AgentNodeDefinition) => { node.onError = { strategy: "continue" }; },
			(node: AgentNodeDefinition) => { node.onError = { strategy: "route", to: "accepted" }; },
		]) {
			const definition = structuredClone(source);
			mutate(definition.nodes.implementer as AgentNodeDefinition);
			assert.throws(() => compileGraph(definition), /gate|writable/i);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});
