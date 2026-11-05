import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FileCheckpointStore, GateNodeExecutor, GraphEngine, PiNodeExecutor, compileGraph } from "../src/index.ts";
import { InProcessPiAgentRuntime } from "../src/pi-agent-runtime.ts";
import { projectRoot } from "../scripts/gate-fixture.ts";
import { preparePython } from "../scripts/python-prepare.ts";
import type { AgentNodeDefinition } from "../src/types.ts";

const invalidSource = "def add(a, b):\n    return a - b\n";
const repairedSource = "def add(a, b):\n    return a + b\n";
import { getPath } from "../src/utils.ts";

test("real Pi sessions repair a Python file from unittest feedback and expose the output path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gatenode-pi-"));
	const agentDir = join(directory, "agent");
	await mkdir(agentDir);
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
	const provider = `gatenode-offline-${process.pid}`;
	try {
		await cp(join(projectRoot, "python-input"), join(directory, "python-input"), { recursive: true });
		const { workspace, graph: definition } = await preparePython(directory);
		const faux = createFauxCore({ provider, api: `${provider}-api`, models: [{ id: "offline", name: "Gate test", reasoning: false, input: ["text"] }], tokenSize: { min: 1000, max: 1000 } });
		modelRuntime.registerProvider(provider, {
			name: "Offline gate integration", baseUrl: "http://localhost:0", apiKey: "offline-test", api: faux.api,
			models: faux.models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({ id, name, reasoning, input, cost, contextWindow, maxTokens })),
			streamSimple: faux.streamSimple,
		});
		await modelRuntime.refresh({ allowNetwork: false });
		let repairPromptSeen = false;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "src/main.py", content: invalidSource }, { id: "first-write" }), { stopReason: "toolUse", timestamp: 1 }),
			fauxAssistantMessage("First candidate is ready.", { timestamp: 2 }),
			(context) => {
				const serialized = JSON.stringify(context.messages);
				assert.match(serialized, /AssertionError/);
				assert.doesNotMatch(serialized, /First candidate is ready/, "isolated repair must receive diagnostics, not prior private conversation");
				repairPromptSeen = true;
				return fauxAssistantMessage(fauxToolCall("write", { path: "src/main.py", content: repairedSource }, { id: "second-write" }), { stopReason: "toolUse", timestamp: 3 });
			},
			fauxAssistantMessage("Repaired candidate is ready.", { timestamp: 4 }),
		]);

		(definition.nodes.implementer as AgentNodeDefinition).model = `${provider}/offline`;
		const agentRuntime = new InProcessPiAgentRuntime({ cwd: directory, agentDir, modelRuntime, projectTrusted: false, threadSessionsDir: join(directory, "sessions") });
		const executor = new GateNodeExecutor(new PiNodeExecutor({ cwd: directory, hasUI: false, agentRuntime }), { cwd: directory, reportsDir: join(directory, "reports") });
		const engine = new GraphEngine(compileGraph(definition), executor, { checkpointStore: new FileCheckpointStore(join(directory, "checkpoints")) });
		const result = await engine.run({ checkpoint: true, input: { task: "Fix add so it returns the sum" } });
		assert.equal(result.status, "completed", JSON.stringify(result));
		assert.equal(getPath(result.state, "result.status"), "accepted");
		assert.deepEqual(getPath(result.state, "result.outputFiles"), [join(workspace, "src/main.py")]);
		assert.equal(faux.state.callCount, 4);
		assert.equal(result.usage.turns, 4);
		assert.equal(repairPromptSeen, true);
		assert.equal(await readFile(join(workspace, "src", "main.py"), "utf8"), repairedSource);
		assert.equal((await readdir(join(directory, "sessions", result.runId, "attempts"))).length, 2);
	} finally {
		modelRuntime.unregisterProvider(provider);
		await rm(directory, { recursive: true, force: true });
	}
});
