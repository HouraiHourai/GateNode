import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraph } from "../src/compile.ts";
import { runCommand } from "../src/gate/checker.ts";
import { defaultPythonExecutable } from "../src/gate/python-checker.ts";
import { snapshotWorkspace } from "../src/gate/workspace.ts";
import type { AgentNodeDefinition, GraphDefinition, SetNodeDefinition } from "../src/types.ts";
import { projectRoot } from "./gate-fixture.ts";

export async function preparePython(root = projectRoot, python = defaultPythonExecutable) {
	const input = join(root, "python-input");
	const snapshot = await snapshotWorkspace(input);
	const sources = [...snapshot.keys()].filter((path) => path.startsWith("src/") && path.endsWith(".py")).sort();
	if (!sources.length) throw new Error(`Place your Python source files in ${join(input, "src")}`);
	if (![...snapshot.keys()].some((path) => /^tests\/test_[A-Za-z0-9_]+\.py$/.test(path))) throw new Error(`Place unittest test files in ${join(input, "tests")} (test_*.py)`);
	if (!isAbsolute(python) && !["python", "python3"].includes(python)) throw new Error("Use python, python3, or an absolute interpreter path without arguments");
	const probe = await runCommand(python, ["-I", "-B", "-X", "utf8", "-c", 'import json,sys; print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:3])}))'], root, { timeoutMs: 10000, maxOutputBytes: 4096 });
	if (probe.error || probe.exitCode !== 0) throw new Error(`Python could not start: ${probe.error ?? probe.output}`);
	const info = JSON.parse(probe.output) as { executable: string; version: number[] };
	if (info.version[0] !== 3 || info.version[1] < 10) throw new Error("Python 3.10 or newer is required");
	const interpreter = await realpath(info.executable);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const relativeWorkspace = `demo-output/python/${stamp}/workspace`;
	const workspace = join(root, relativeWorkspace);
	const graph = JSON.parse(await readFile(new URL("../examples/python-gate.json", import.meta.url), "utf8")) as GraphDefinition;
	const node = graph.nodes.implementer as AgentNodeDefinition;
	node.cwd = relativeWorkspace;
	node.gate!.writableFiles = sources;
	node.gate!.pythonExecutable = interpreter;
	for (const id of ["accepted", "unresolved"]) {
		const target = graph.nodes[id] as SetNodeDefinition;
		const assignment = target.assign[0];
		if (!("value" in assignment) || !assignment.value || typeof assignment.value !== "object" || Array.isArray(assignment.value)) throw new Error("Python graph result must be an object");
		assignment.value = { ...assignment.value, outputDirectory: join(workspace, "src"), outputFiles: sources.map((source) => join(workspace, source)) };
	}
	compileGraph(graph);
	await mkdir(dirname(workspace), { recursive: true });
	await cp(input, workspace, { recursive: true, force: false, errorOnExist: true, filter: (source) => !source.split(/[\\/]/).some((part) => ["__pycache__", ".git", "node_modules"].includes(part)) && !source.endsWith(".pyc") });
	const graphsDir = join(root, ".pi", "graphs");
	await mkdir(graphsDir, { recursive: true });
	await writeFile(join(graphsDir, "python-gate.json"), JSON.stringify(graph, null, 2) + "\n");
	return { workspace, sources, interpreter, graph };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 2 || args[0] !== "--python")) throw new Error('Usage: npm run python:prepare [-- --python "absolute/path/to/python"]');
	const { workspace, sources, interpreter } = await preparePython(projectRoot, args[1]);
	console.log(`Python interpreter: ${interpreter}\nInput: ${join(projectRoot, "python-input")}\nCode output after the Pi run:\n${sources.map((source) => join(workspace, source)).join("\n")}\n\nStart/restart Pi using npm start, then enter your request:\n/pig run python-gate 根据 tests 中的验收要求修复 src 下的代码`);
}
