import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { FileCheckpointStore, GateNodeExecutor, GraphEngine, PiNodeExecutor, compileGraph } from "../src/index.ts";
import { runChecks } from "../src/gate/checker.ts";
import { readPythonReport } from "../src/gate/python-checker.ts";
import { snapshotWorkspace } from "../src/gate/workspace.ts";
import type { GateReport } from "../src/gate/executor.ts";
import type { AgentNodeDefinition, GatePolicy, GraphDefinition } from "../src/types.ts";
import type { NodeAgentRuntime } from "../src/pi-agent-runtime.ts";
import { emptyUsage, getPath } from "../src/utils.ts";
import { projectRoot } from "../scripts/gate-fixture.ts";
import { preparePython } from "../scripts/python-prepare.ts";

const correctSource = "def add(a, b):\n    return a + b\n";
const policy: GatePolicy = { checks: ["python-syntax", "python-test"], writableFiles: ["src/main.py"] };

async function fixture(run: (root: string, workspace: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "gatenode-python-test-"));
	try {
		const workspace = join(root, "workspace");
		await cp(join(projectRoot, "python-input"), workspace, { recursive: true });
		await run(root, workspace);
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("Python checks execute real unittest assertions without writing bytecode into the workspace", async () => {
	await fixture(async (_root, workspace) => {
		await writeFile(join(workspace, "src/main.py"), correctSource);
		const before = await snapshotWorkspace(workspace);
		const checks = await runChecks(workspace, policy);
		assert.deepEqual(checks.map((check) => check.status), ["passed", "passed"], JSON.stringify(checks));
		assert.match(checks[1].output, /Ran 3 tests/);
		assert.deepEqual(await snapshotWorkspace(workspace), before);
	});
});

test("Python syntax failures contain the source filename and line for repair", async () => {
	await fixture(async (_root, workspace) => {
		await writeFile(join(workspace, "src/main.py"), "def add(a, b)\n    return a + b\n");
		const checks = await runChecks(workspace, policy);
		assert.equal(checks.length, 1);
		assert.equal(checks[0].status, "rejected");
		assert.equal(checks[0].diagnostics[0].file, "src/main.py");
		assert.equal(checks[0].diagnostics[0].line, 1);
		assert.equal(checks[0].diagnostics[0].code, "SyntaxError");
	});
});

test("Python behavioral failures are rejected with assertion diagnostics", async () => {
	await fixture(async (_root, workspace) => {
		const checks = await runChecks(workspace, policy);
		assert.equal(checks[0].status, "passed");
		assert.equal(checks[1].status, "rejected");
		assert.equal(checks[1].diagnostics[0].code, "AssertionError");
		assert.match(checks[1].diagnostics[0].message, /AddTests/);
	});
});

for (const [name, source] of [
	["empty", "# No test cases\n"],
	["pytest-only", "def test_add():\n    assert True\n"],
	["all-skipped", "import unittest\n@unittest.skip('later')\nclass Tests(unittest.TestCase):\n    def test_skip(self): pass\n"],
	["all-expected-failures", "import unittest\nclass Tests(unittest.TestCase):\n    @unittest.expectedFailure\n    def test_pending(self): self.fail('pending')\n"],
]) {
	test(`Python ${name} tests cannot count as acceptance`, async () => {
		await fixture(async (_root, workspace) => {
			await writeFile(join(workspace, "tests/test_main.py"), source);
			const checks = await runChecks(workspace, { ...policy, checks: ["python-test"] });
			assert.equal(checks[0].status, "error", checks[0].output);
		});
	});
}

test("Python import failures and missing interpreters stop as tool errors", async () => {
	await fixture(async (root, workspace) => {
		await writeFile(join(workspace, "tests/test_main.py"), "import nonexistent_gatenode_dependency\n");
		const checks = await runChecks(workspace, { ...policy, checks: ["python-test"] });
		assert.equal(checks[0].status, "error");
		assert.equal(checks[0].diagnostics[0].code, "PYTHON_TEST_IMPORT");
		const missing = await runChecks(workspace, { ...policy, pythonExecutable: join(root, "missing-python") });
		assert.equal(missing[0].status, "error");
	});
});

test("Python early exit and checker timeout cannot accept a candidate", async () => {
	await fixture(async (_root, workspace) => {
		await writeFile(join(workspace, "tests/test_main.py"), "import os\nos._exit(0)\n");
		const exited = await runChecks(workspace, { ...policy, checks: ["python-test"] });
		assert.equal(exited[0].status, "error");
		assert.match(exited[0].diagnostics[0].message, /completion report/);
		await writeFile(join(workspace, "tests/test_main.py"), "import time\ntime.sleep(60)\n");
		const timed = await runChecks(workspace, { ...policy, checks: ["python-test"], timeoutMs: 300 });
		assert.equal(timed[0].status, "error");
		assert.match(timed[0].diagnostics[0].message, /timed out/);
	});
});

test("Python reports must agree with the process exit code", () => {
	const output = 'GATENODE_PYTHON_RESULT={"version":1,"status":"passed","diagnostics":[]}';
	assert.equal(readPythonReport({ output, exitCode: 1 }).status, "error");
	assert.equal(readPythonReport({ output: output + "\n" + output, exitCode: 0 }).status, "error");
});

async function graphFixture(root: string, workspace: string): Promise<GraphDefinition> {
	const graph = JSON.parse(await readFile(join(projectRoot, "examples/python-gate.json"), "utf8")) as GraphDefinition;
	(graph.nodes.implementer as AgentNodeDefinition).cwd = relative(root, workspace).split("\\").join("/");
	return graph;
}

for (const mode of ["repair", "exhaust", "tamper"] as const) {
	test(`Python graph ${mode} preserves the gate success/failure boundary`, async () => {
		await fixture(async (root, workspace) => {
			const graph = await graphFixture(root, workspace);
			let calls = 0;
			const runtime: NodeAgentRuntime = { async invoke(_node, context, prompt) {
				calls++;
				if (calls > 1) assert.match(prompt.text, /AssertionError/);
				if (mode === "repair" && calls > 1) await writeFile(join(workspace, "src/main.py"), correctSource);
				if (mode === "tamper") await writeFile(join(workspace, "tests/test_main.py"), "# removed tests\n");
				const usage = { ...emptyUsage(), turns: 1 };
				await context.recordTurn?.({ id: "test-turn", usage });
				return { outputText: `Candidate ${calls}`, usage, messages: [], stopReason: "stop", timedOut: false, aborted: false, structuredOutputSucceeded: false };
			} };
			const reportsDir = join(root, "reports");
			const engine = new GraphEngine(compileGraph(graph), new GateNodeExecutor(new PiNodeExecutor({ cwd: root, hasUI: false, agentRuntime: runtime }), { cwd: root, reportsDir }), { checkpointStore: new FileCheckpointStore(join(root, "checkpoints")) });
			const result = await engine.run({ checkpoint: true });
			if (mode === "repair") {
				assert.equal(getPath(result.state, "result.status"), "accepted");
				assert.equal(getPath(result.state, "outputs.implementer"), "Candidate 2");
				assert.equal(calls, 2);
			} else {
				assert.equal(result.interrupt?.nodeId, "manual");
				assert.equal(getPath(result.state, "outputs.implementer"), undefined);
				assert.equal(getPath(result.state, "errors.implementer.code"), mode === "exhaust" ? "GATE_EXHAUSTED" : "GATE_PROTECTED_FILES");
				assert.equal(calls, mode === "exhaust" ? 3 : 1);
			}
			const names = (await readdir(reportsDir)).filter((file) => file.endsWith(".json"));
			const report = JSON.parse(await readFile(join(reportsDir, names[0]), "utf8")) as GateReport;
			assert.equal(report.rounds.length, calls);
			if (mode === "tamper") assert.equal(report.rounds[0].checks.length, 0);
		});
	});
}

test("Python graph policy rejects mixed languages, test edits and executable arguments", async () => {
	await fixture(async (root, workspace) => {
		for (const change of [
			(node: AgentNodeDefinition) => { node.gate!.checks = ["python-test", "typecheck"]; },
			(node: AgentNodeDefinition) => { node.gate!.writableFiles = ["tests/test_main.py"]; },
			(node: AgentNodeDefinition) => { node.gate!.pythonExecutable = "python -c arbitrary"; },
		]) {
			const graph = await graphFixture(root, workspace);
			change(graph.nodes.implementer as AgentNodeDefinition);
			assert.throws(() => compileGraph(graph), /gate|writable|python/i);
		}
	});
});

test("Python preparation discovers custom filenames, preserves input and exposes output paths", async () => {
	await fixture(async (root) => {
		const input = join(root, "python-input");
		await mkdir(join(input, "src"), { recursive: true });
		await mkdir(join(input, "tests"));
		await writeFile(join(input, "src/custom.py"), "def double(n): return n * 2\n");
		await writeFile(join(input, "tests/test_custom.py"), "import unittest\nfrom src.custom import double\nclass Tests(unittest.TestCase):\n    def test_double(self): self.assertEqual(double(3), 6)\n");
		const before = await snapshotWorkspace(input);
		const prepared = await preparePython(root);
		assert.deepEqual(prepared.sources, ["src/custom.py"]);
		assert.match(prepared.workspace, /demo-output[\\/]python[\\/]/);
		assert.deepEqual(await snapshotWorkspace(input), before);
		const graph = JSON.parse(await readFile(join(root, ".pi/graphs/python-gate.json"), "utf8")) as GraphDefinition;
		const node = graph.nodes.implementer as AgentNodeDefinition;
		assert.equal(node.gate!.pythonExecutable, prepared.interpreter);
		const runtime: NodeAgentRuntime = { async invoke() { return { outputText: "Already correct", usage: emptyUsage(), messages: [], stopReason: "stop", timedOut: false, aborted: false, structuredOutputSucceeded: false }; } };
		const engine = new GraphEngine(compileGraph(graph), new GateNodeExecutor(new PiNodeExecutor({ cwd: root, hasUI: false, agentRuntime: runtime }), { cwd: root, reportsDir: join(root, "reports") }));
		const result = await engine.run({ checkpoint: false });
		assert.equal(getPath(result.state, "result.status"), "accepted");
		assert.deepEqual(getPath(result.state, "result.outputFiles"), [join(prepared.workspace, "src/custom.py")]);
	});
});
