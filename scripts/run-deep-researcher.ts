/**
 * End-to-end live driver for examples/deep-researcher.json.
 *
 * Runs in a FRESH tsx process, so it picks up the CURRENT src/*.ts (engine.ts
 * autoCompact-style node handling, utils.ts lenient JSON parsing). The in-pi
 * pi_graph_run tool loads the extension once at session start and does NOT
 * hot-reload source edits — use this script to test source changes live.
 *
 * Headless graph: single engine.run() to completion (no human interrupt).
 *
 * Run:  npx tsx scripts/run-deep-researcher.ts ["research question"]
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FileCheckpointStore } from "../src/checkpoint.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import { PiNodeExecutor } from "../src/pi-executor.ts";
import type { GraphDefinition, GraphRunEvent, JsonObject, TokenUsageLedger } from "../src/types.ts";
import { getPath, isJsonObject, usageTokens } from "../src/utils.ts";

const here = import.meta.dirname;
const definition = JSON.parse(readFileSync(join(here, "..", "examples", "deep-researcher.json"), "utf8")) as GraphDefinition;

const researchQuestion =
	process.argv[2] ??
	"Are GLP-1 receptor agonist drugs (semaglutide/Ozempic, tirzepatide) a sustainable solution to the obesity epidemic, or are their long-term risks, dependency, and costs being underestimated?";

function fmtUsage(usage: TokenUsageLedger | undefined): string {
	if (!usage) return "";
	return `${usageTokens(usage)} tok`;
}

function logEvent(event: GraphRunEvent): void {
	const step = event.step !== undefined ? ` s${event.step}` : "";
	const node = event.nodeId ? ` [${event.nodeId}]` : "";
	const attempt = event.attempt !== undefined ? ` #${event.attempt}` : "";
	const status = event.status ? ` ${event.status}` : "";
	const usage = fmtUsage(event.usage);
	const message = event.message ? ` — ${event.message}` : "";
	console.log(`${event.type}${step}${node}${attempt}${status}${usage ? ` (${usage})` : ""}${message}`);
}

async function main(): Promise<void> {
	console.log(`Graph: ${definition.name}`);
	console.log(`Research question: ${researchQuestion}\n`);

	const workDir = await mkdtemp(join(tmpdir(), "deep-researcher-"));
	const store = new FileCheckpointStore(join(workDir, "checkpoints"));
	const graph = compileGraph(definition);
	const executor = new PiNodeExecutor({
		cwd: process.cwd(),
		hasUI: false,
		threadSessionsDir: resolve(join(workDir, "thread-sessions")),
		artifactsDir: resolve(join(workDir, "artifacts")),
	});

	const start = Date.now();
	const engine = new GraphEngine(graph, executor, { checkpointStore: store });
	const result = await engine.run({ input: { task: researchQuestion } satisfies JsonObject, checkpoint: true, onEvent: logEvent });
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
