/**
 * Live driver for examples/repo-inspect.json.
 *
 * Usage:  npx tsx scripts/run-repo-inspect.ts <repo-path> ["task framing"]
 *
 * Runs the graph with cwd = the target repo. Agent nodes use invocation-local
 * in-process Pi sessions. Prints every graph event, the projected result, and
 * the final Markdown report artifact.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, isAbsolute } from "node:path";
import { FileCheckpointStore } from "../src/checkpoint.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import { PiNodeExecutor } from "../src/pi-executor.ts";
import type { GraphDefinition, GraphRunEvent, JsonObject, TokenUsageLedger } from "../src/types.ts";
import { getPath, isJsonObject, usageTokens } from "../src/utils.ts";

const here = import.meta.dirname;
const definition = JSON.parse(readFileSync(join(here, "..", "examples", "repo-inspect.json"), "utf8")) as GraphDefinition;

const repoArg = process.argv[2];
if (!repoArg) {
	console.error("Usage: npx tsx scripts/run-repo-inspect.ts <repo-path> [\"task framing\"]");
	process.exit(1);
}
const repo = isAbsolute(repoArg) ? repoArg : resolve(process.cwd(), repoArg);
const task = process.argv[3] ?? "Inspect this repository and summarize its main modules.";

function fmtUsage(usage: TokenUsageLedger | undefined): string {
	if (!usage) return "";
	return `${usageTokens(usage)} tok`;
}

function logEvent(event: GraphRunEvent): void {
	const step = event.step !== undefined ? ` s${event.step}` : "";
	const node = event.nodeId ? ` [${event.nodeId}]` : "";
	const status = event.status ? ` ${event.status}` : "";
	const usage = fmtUsage(event.usage);
	const message = event.message ? ` — ${event.message}` : "";
	console.log(`${event.type}${step}${node}${status}${usage ? ` (${usage})` : ""}${message}`);
}

async function main(): Promise<void> {
	console.log(`Graph: ${definition.name}`);
	console.log(`Repo: ${repo}`);
	console.log(`Task: ${task}\n`);

	const workDir = await mkdtemp(join(tmpdir(), "repo-inspect-"));
	const store = new FileCheckpointStore(join(workDir, "checkpoints"));
	const graph = compileGraph(definition);
	const executor = new PiNodeExecutor({
		cwd: repo,
		hasUI: false,
		threadSessionsDir: resolve(join(workDir, "thread-sessions")),
		artifactsDir: resolve(join(workDir, "artifacts")),
	});

	const start = Date.now();
	const engine = new GraphEngine(graph, executor, { checkpointStore: store });
	const result = await engine.run({ input: { repo, task } satisfies JsonObject, checkpoint: true, onEvent: logEvent });
	const elapsed = ((Date.now() - start) / 1000).toFixed(1);

	console.log(`\n=== FINAL (elapsed ${elapsed}s) ===`);
	console.log(`status: ${result.status}  step: ${result.step}  nodeRuns: ${result.nodeRuns}`);
	if (result.error) console.log(`error: ${result.error}`);
	console.log(`usage: ${fmtUsage(result.usage)}  state bytes: ${result.stateBytes}`);

	if (result.result) {
		console.log("\n--- projected result ---");
		console.log(JSON.stringify(result.result, null, 2));
	}
	const report = getPath(result.state, "result.report_artifact");
	if (isJsonObject(report) && typeof report.uri === "string") {
		console.log("\n--- report artifact ---");
		console.log(await readFile(report.uri, "utf8"));
	}
	console.log(`\nworkDir (artifacts/checkpoints): ${workDir}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
