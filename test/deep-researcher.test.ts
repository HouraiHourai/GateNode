import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCheckpointStore } from "../src/checkpoint.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import type {
	GraphDefinition,
	JsonObject,
	JsonValue,
	NodeDefinition,
	NodeExecutionContext,
	NodeExecutionResult,
	NodeExecutor,
	StateWrite,
} from "../src/types.ts";
import { emptyUsage, getPath } from "../src/utils.ts";

// Loads the REAL shipped example and drives it through the actual engine +
// compiler with a deterministic executor (no model calls, no web). Locks down
// deep-researcher's non-linear control flow:
//   - browser -> planner -> plan_reviewer auto-gate (reject once, then approve),
//   - the plan_review reject -> planner revision loop,
//   - 3-way parallel section fan-out + per-superstep collect at the writer barrier,
//   - writer -> fact_checker gate (reject once, then approve),
//   - the fact_check reject -> writer revision loop,
//   - terminal publisher artifact + result projection.
const here = import.meta.dirname;
const definition = JSON.parse(readFileSync(join(here, "..", "examples", "deep-researcher.json"), "utf8")) as GraphDefinition;

function nowIso(): string {
	return new Date().toISOString();
}

class ScenarioExecutor implements NodeExecutor {
	readonly calls: string[] = [];
	planReviewCalls = 0;
	factCheckCalls = 0;

	execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
		this.calls.push(context.nodeId);
		return Promise.resolve(this.handle(node, context));
	}

	private ok(writes: StateWrite[], output: JsonValue): NodeExecutionResult {
		return { kind: "success", writes, output, usage: emptyUsage(), attempts: 1, startedAt: nowIso(), endedAt: nowIso() };
	}

	private handle(node: NodeDefinition, context: NodeExecutionContext): NodeExecutionResult {
		const id = context.nodeId;

		if (node.type === "set") {
			const writes: StateWrite[] = [];
			for (const assign of node.assign) {
				const mode = assign.mode ?? "reduce";
				if (mode === "unset") {
					writes.push({ path: assign.path, nodeId: id, mode });
					continue;
				}
				const value = assign.from !== undefined ? getPath(context.state, assign.from) ?? null : assign.value ?? null;
				writes.push({ path: assign.path, value, nodeId: id, mode });
			}
			return this.ok(writes, null);
		}

		switch (id) {
			case "browser":
				return this.ok([{ path: "working.sketch", value: { landscape: "sketched", urls: ["https://example.test/a"] }, nodeId: id }], { landscape: "sketched" });
			case "planner":
				return this.ok([{ path: "working.plan", value: { title: "T", sections: ["s1", "s2", "s3"], date: "2025-01-01" }, nodeId: id }], { planned: true });
			case "plan_reviewer": {
				this.planReviewCalls += 1;
				const approved = this.planReviewCalls >= 2;
				return this.ok([{ path: "control.plan_review", value: { approved, feedback: approved ? "ok" : "tighten section 2" }, nodeId: id }], { approved });
			}
			case "section_a":
			case "section_b":
			case "section_c":
				return this.ok([{ path: "working.section_research", value: { section: id, body: "research", urls: [`https://example.test/${id}`] }, nodeId: id }], { section: id });
			case "writer":
				return this.ok([{ path: "working.draft", value: { markdown: "# Draft", urls: ["https://example.test/a"] }, nodeId: id }], { drafted: true });
			case "fact_checker": {
				this.factCheckCalls += 1;
				const approved = this.factCheckCalls >= 2;
				return this.ok([{ path: "working.fact_check", value: { approved, issues: approved ? [] : ["claim X unverified"] }, nodeId: id }], { approved });
			}
			case "publisher":
				return this.ok(
					[{ path: "result.report_artifact", value: { kind: "artifact", uri: "/tmp/report.md", mediaType: "text/markdown", bytes: 10, sha256: "abc", preview: "# Report" }, nodeId: id }],
					{ done: true },
				);
			default:
				return this.ok([], null);
		}
	}
}

function count(calls: readonly string[], nodeId: string): number {
	return calls.filter((item) => item === nodeId).length;
}

test("deep-researcher: non-interactive control flow (plan gate + fact-check gate + fan-out/collect)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-deep-researcher-"));
	const store = new FileCheckpointStore(directory);
	try {
		const graph = compileGraph(definition);
		const executor = new ScenarioExecutor();
		const engine = new GraphEngine(graph, executor, { checkpointStore: store });

		// Headless graph: a single run drives it to completion (no human interrupt).
		const completed = await engine.run({ input: { task: "Is X better than Y?" }, checkpoint: true });
		assert.equal(completed.status, "completed");
		assert.equal(completed.interrupt, undefined, "no human interrupt on the headless deep-researcher graph");

		// --- browser scout runs once and feeds the planner ---
		assert.equal(count(executor.calls, "browser"), 1);

		// --- Plan gate: plan_reviewer rejected once then approved -> planner revised once ---
		assert.equal(count(executor.calls, "plan_reviewer"), 2);
		assert.equal(count(executor.calls, "planner"), 2, "planner runs once, then once more after plan reject");
		assert.equal(getPath(completed.state, "control.plan_review.approved"), true);
		const firstReview = executor.calls.indexOf("plan_reviewer");
		const secondPlanner = executor.calls.indexOf("planner", firstReview);
		const secondReview = executor.calls.indexOf("plan_reviewer", secondPlanner);
		assert.ok(firstReview < secondPlanner && secondPlanner < secondReview, "reject -> planner revise -> re-review order");

		// --- 3-way parallel section fan-out + per-superstep collect at the writer barrier ---
		assert.equal(count(executor.calls, "section_a"), 1);
		assert.equal(count(executor.calls, "section_b"), 1);
		assert.equal(count(executor.calls, "section_c"), 1);
		const sections = getPath(completed.state, "working.section_research");
		assert.ok(Array.isArray(sections), "working.section_research is a collected array");
		assert.equal(sections.length, 3, "all three section cards collected at the barrier");
		assert.ok(sections.every((item) => typeof getPath(item as JsonObject, "section") === "string"));

		// --- Fact-check gate: rejected once then approved -> writer revised once ---
		assert.equal(count(executor.calls, "writer"), 2, "writer runs once, then once more after fact-check reject");
		assert.equal(count(executor.calls, "fact_checker"), 2);
		assert.equal(getPath(completed.state, "working.fact_check.approved"), true);
		const firstFact = executor.calls.indexOf("fact_checker");
		const writerRevise = executor.calls.indexOf("writer", firstFact);
		const secondFact = executor.calls.indexOf("fact_checker", writerRevise);
		assert.ok(firstFact < writerRevise && writerRevise < secondFact, "reject -> writer revise -> re-check order");

		// sections must precede the first writer; fact-check precedes publisher.
		assert.ok(executor.calls.lastIndexOf("section_c") < executor.calls.indexOf("writer"), "sections complete before the writer barrier");
		assert.equal(count(executor.calls, "publisher"), 1);
		assert.ok(executor.calls.indexOf("fact_checker") < executor.calls.indexOf("publisher"));

		// --- Terminal artifact + result projection ---
		assert.equal(getPath(completed.state, "result.report_artifact.kind"), "artifact");
		assert.equal(completed.includeState, false);
		assert.equal(getPath(completed.result ?? {}, "result.report_artifact.kind"), "artifact");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
