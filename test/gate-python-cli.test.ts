import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectRoot } from "../scripts/gate-fixture.ts";
import { preparePython } from "../scripts/python-prepare.ts";
import type { AgentNodeDefinition } from "../src/types.ts";

const invalidSource = "def add(a, b):\n    return a - b\n";
const repairedSource = "def add(a, b):\n    return a + b\n";

test("installed Pi CLI loads python-gate and repairs code with actual unittest checks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gatenode-cli-"));
	try {
		await cp(join(projectRoot, "python-input"), join(directory, "python-input"), { recursive: true });
		const { workspace, graph: definition } = await preparePython(directory);
		definition.policy = { allowNonInteractive: true, allowNonInteractiveMutations: true, confirmProjectGraph: false, confirmMutatingNodes: false };
		(definition.nodes.implementer as AgentNodeDefinition).model = "gatenode-cli/offline";
		const graphDir = join(directory, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(join(graphDir, "python-gate.json"), JSON.stringify(definition));
		const extensionPath = join(directory, "offline-provider.mjs");
		await writeFile(extensionPath, `import { createFauxCore, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function setup(pi) {
  const faux = createFauxCore({ api: "gatenode-cli-api", provider: "gatenode-cli", models: [{ id: "offline", name: "Offline Gate CLI", reasoning: false, input: ["text"] }], tokenSize: { min: 1000, max: 1000 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pi_graph_run", { graph: "python-gate", task: "Fix add", checkpoint: true }, { id: "run-gate" }), { stopReason: "toolUse", timestamp: 1 }),
    fauxAssistantMessage(fauxToolCall("write", { path: "src/main.py", content: ${JSON.stringify(invalidSource)} }, { id: "bad-code" }), { stopReason: "toolUse", timestamp: 2 }),
    fauxAssistantMessage("First candidate", { timestamp: 3 }),
    fauxAssistantMessage(fauxToolCall("write", { path: "src/main.py", content: ${JSON.stringify(repairedSource)} }, { id: "fixed-code" }), { stopReason: "toolUse", timestamp: 4 }),
    fauxAssistantMessage("Repaired candidate", { timestamp: 5 }),
    fauxAssistantMessage("gatenode-cli-complete", { timestamp: 6 }),
  ]);
  pi.registerProvider(faux.provider, { name: "Offline CLI", baseUrl: "http://localhost:0", apiKey: "offline-test", api: faux.api, models: faux.models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({ id, name, reasoning, input, cost, contextWindow, maxTokens })), streamSimple: faux.streamSimple });
}
`);
		const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
		const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
		delete env.NODE_OPTIONS;
		delete env.NODE_TEST_CONTEXT;
		const output = spawnSync(process.execPath, [cli, "--mode", "json", "-p", "--approve", "--no-session", "--no-extensions", "-e", extensionPath,
			"-e", fileURLToPath(new URL("../extensions/pi-graph.ts", import.meta.url)), "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--offline", "--tools", "pi_graph_run", "--model", "gatenode-cli/offline", "Run the coding gate graph"], {
			cwd: directory, env, input: "", encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
		});
		assert.equal(output.status, 0, `${output.error ?? ""}\n${output.stderr}\n${output.stdout}`);
		assert.ok(output.stdout.includes("outputFiles"), "The CLI result must expose the generated code paths");
		const events = output.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
		assert.ok(output.stdout.includes("gatenode-cli-complete"), JSON.stringify(events.filter((event) => event.type === "tool_execution_end" || event.type === "agent_end").map((event) => ({ type: event.type, result: event.result, messages: event.messages }))).slice(-9000));
		assert.equal(await readFile(join(workspace, "src", "main.py"), "utf8"), repairedSource);
		const reportsDir = join(directory, "agent", "gatenode", "reports");
		const paths = (await readdir(reportsDir)).filter((name) => name.endsWith(".json"));
		assert.equal(paths.length, 1);
		const report = JSON.parse(await readFile(join(reportsDir, paths[0]), "utf8"));
		assert.equal(report.status, "passed");
		assert.equal(report.rounds.length, 2);
		assert.equal(report.rounds[0].checks[1].status, "rejected");
	} finally { await rm(directory, { recursive: true, force: true }); }
});
