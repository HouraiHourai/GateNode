import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileCheckpointStore, GateNodeExecutor, GraphEngine, PiNodeExecutor, compileGraph } from "../src/index.ts";
import { demoGraph, prepareFixture, projectRoot, ScriptedRepairRuntime } from "./gate-fixture.ts";

console.log("GateNode offline demo: scripted Agent responses + real TypeScript compiler and tests. No LLM calls.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = join(projectRoot, "demo-output", "demos", stamp);
await mkdir(root, { recursive: true });
for (const scenario of ["pass", "repair", "exhaust", "tool-error"] as const) {
	const directory = join(root, scenario);
	const workspace = await prepareFixture(directory);
	if (scenario === "tool-error") await writeFile(join(workspace, "tsconfig.json"), '{"compilerOptions":{"nonexistentOption":true}}');
	const runtime = new ScriptedRepairRuntime(workspace, scenario === "tool-error" ? "pass" : scenario);
	const inner = new PiNodeExecutor({ cwd: directory, hasUI: false, agentRuntime: runtime });
	const executor = new GateNodeExecutor(inner, { cwd: directory, reportsDir: join(directory, "reports") });
	const engine = new GraphEngine(compileGraph(await demoGraph(directory, workspace)), executor, { checkpointStore: new FileCheckpointStore(join(directory, "checkpoints")) });
	console.log(`\n[${scenario}]`);
	const result = await engine.run({ checkpoint: true, input: { task: "Add backward-compatible pagination." }, onEvent: (event) => {
		if (event.type === "node_activity" && event.message?.startsWith("GateNode")) console.log(event.message);
	} });
	const expectedAttempts = scenario === "pass" || scenario === "tool-error" ? 1 : scenario === "repair" ? 2 : 3;
	assert.equal(runtime.calls.length, expectedAttempts);
	assert.equal(result.status, scenario === "pass" || scenario === "repair" ? "completed" : "interrupted");
	console.log(`Result: ${result.status}; Agent calls: ${runtime.calls.length}; report directory: ${join(directory, "reports")}`);
	console.log(`Candidate code: ${join(workspace, "src", "items.ts")}`);
	if (result.interrupt) console.log(`Human handoff: ${result.interrupt.nodeId}`);
}
console.log(`\nAll four scenarios passed. Artifacts: ${root}`);
