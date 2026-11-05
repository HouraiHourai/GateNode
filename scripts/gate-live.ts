import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileCheckpointStore, GateNodeExecutor, GraphEngine, PiNodeExecutor, compileGraph } from "../src/index.ts";
import type { AgentNodeDefinition } from "../src/types.ts";
import { demoGraph, prepareFixture, projectRoot } from "./gate-fixture.ts";

const modelIndex = process.argv.indexOf("--model");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined;
if (!model || model.startsWith("--")) throw new Error("Usage: npm run demo:live -- --model provider/model-id (uses your Pi credentials)");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const directory = join(projectRoot, "demo-output", "live-runs", stamp);
const workspace = await prepareFixture(directory);
const definition = await demoGraph(directory, workspace);
(definition.nodes.implementer as AgentNodeDefinition).model = model;
const executor = new GateNodeExecutor(new PiNodeExecutor({ cwd: directory, hasUI: false, projectTrusted: false, threadSessionsDir: join(directory, "sessions") }), {
	cwd: directory, reportsDir: join(directory, "reports"),
});
const engine = new GraphEngine(compileGraph(definition), executor, { checkpointStore: new FileCheckpointStore(join(directory, "checkpoints")) });
console.log(`Real model run: ${model}\nWorkspace: ${workspace}`);
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
try {
	const result = await engine.run({ checkpoint: true, input: { task: "Add optional pagination parameters to listItems while preserving the legacy call." }, signal: controller.signal, onEvent: (event) => {
		if (event.type === "node_end" || (event.type === "node_activity" && event.message?.startsWith("GateNode"))) console.log(`${event.nodeId}: ${event.message ?? event.status}`);
	} });
	await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
	console.log(`Result: ${result.status}\nCandidate code: ${join(workspace, "src", "items.ts")}\nArtifacts: ${directory}`);
	if (result.interrupt) console.log(result.interrupt.prompt);
	if (result.error) console.error(result.error);
	if (result.status !== "completed") process.exitCode = 1;
} finally { process.removeListener("SIGINT", cancel); }
