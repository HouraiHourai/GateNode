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
// compiler with a deterministic executor (no model calls). Exercises the
// auto-only control flow that differs from science-research.json:
//   - the isolated scope_review auto-gate (no human interrupt / resume),
//   - the planner <-> scope_review refine loop,
//   - the round-2 gate skip (control.scope.decision persists as "approve"),
//   - the conflict-triggered debate detour,
//   - the integrator insufficient -> bump_round refine loop,
//   - per-superstep collect reducers and compact cross-round memory.
const here = import.meta.dirname;
const definition = JSON.parse(readFileSync(join(here, "..", "examples", "science-research-auto.json"), "utf8")) as GraphDefinition;

function nowIso(): string {
	return new Date().toISOString();
}

/** Deterministic executor that scripts a specific path through the graph. */
class ScenarioExecutor implements NodeExecutor {
	readonly calls: string[] = [];
	round = 0;
	scopeCalls = 0;

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
			case "planner": {
				// bump_round sets memory.last_integration -> we are now in round 2.
				this.round = getPath(context.state, "memory.last_integration") ? 2 : 1;
				return this.ok([{ path: "working.plan", value: { round: this.round }, nodeId: id }], { round: this.round });
			}
			case "scope_review": {
				// Auto-gate: refine once, then approve.
				this.scopeCalls += 1;
				const decision = this.scopeCalls >= 2 ? "approve" : "refine";
				return this.ok(
					[{ path: "control.scope", value: { decision, rationale: "auto" }, nodeId: id }],
					{ decision },
				);
			}
			case "branch_a":
			case "branch_b":
			case "branch_c":
				return this.ok([{ path: "working.branch_results", value: { angle: id, round: this.round }, nodeId: id }], { angle: id });
			case "evidence_critic": {
				// Round 1: a critical conflict triggers the debate detour.
				const hasCriticalConflicts = this.round === 1;
				return this.ok(
					[{ path: "working.reviewed_evidence", value: { has_critical_conflicts: hasCriticalConflicts }, nodeId: id }],
					{ has_critical_conflicts: hasCriticalConflicts },
				);
			}
			case "devil_advocate":
				return this.ok(
					[{ path: "working.debate.messages", value: [{ role: "assistant", content: "skeptic", nodeId: id, createdAt: nowIso(), name: null }], nodeId: id }],
					{ position: "skeptic" },
				);
			case "defender":
				return this.ok(
					[{ path: "working.debate.messages", value: [{ role: "assistant", content: "defender", nodeId: id, createdAt: nowIso(), name: null }], nodeId: id }],
					{ position: "defender" },
				);
			case "arbiter":
				return this.ok(
					[{ path: "working.debate.verdict", value: { resolved: true, fatal_conflict: false }, nodeId: id }],
					{ resolved: true },
				);
			case "integrator": {
				// Round 1: insufficient -> refine. Round 2: sufficient -> report.
				const sufficient = this.round >= 2;
				const integration = { sufficient, fatal_conflict: false, round: this.round };
				return this.ok([{ path: "working.integration", value: integration, nodeId: id }], integration);
			}
			case "reporter":
				return this.ok(
					[{ path: "result.report_artifact", value: { kind: "artifact", uri: "/tmp/report.md", mediaType: "text/markdown", bytes: 10, sha256: "abc", preview: "report" }, nodeId: id }],
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

test("science-research-auto: fully non-interactive control flow (auto gate, debate detour, refine loop)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-science-auto-"));
	const store = new FileCheckpointStore(directory);
	try {
		const graph = compileGraph(definition);
		const executor = new ScenarioExecutor();
		const engine = new GraphEngine(graph, executor, { checkpointStore: store });

		// The auto graph never interrupts: a single run drives it to completion.
		const completed = await engine.run({ input: { task: "Is X better than Y?" }, checkpoint: true });
		assert.equal(completed.status, "completed");
		assert.equal(completed.interrupt, undefined, "no human interrupt on the fully non-interactive graph");

		// --- Auto gate: scope_review refined once, then approved; no human node ran ---
		assert.equal(getPath(completed.state, "control.scope.decision"), "approve");
		assert.equal(count(executor.calls, "scope_review"), 2, "scope_review runs twice: refine then approve");

		// planner ran 3x: twice in round 1 (around the refine loop) and once in round 2.
		assert.equal(count(executor.calls, "planner"), 3);

		// --- Round-2 gate skip: once approved, control.scope.decision persists, so the
		//     round-2 planner routes straight to the branches and never re-enters scope_review. ---
		const lastPlanner = executor.calls.lastIndexOf("planner");
		const hasScopeAfterLastPlanner = executor.calls.slice(lastPlanner).includes("scope_review");
		assert.equal(hasScopeAfterLastPlanner, false, "round-2 planner skips the auto gate");

		// --- Refinement loop: evidence_critic and integrator each ran twice ---
		assert.equal(count(executor.calls, "evidence_critic"), 2);
		assert.equal(count(executor.calls, "integrator"), 2);

		// collect is scoped to one superstep: only round-2 branch cards remain.
		const branchResults = getPath(completed.state, "working.branch_results");
		assert.ok(Array.isArray(branchResults), "working.branch_results is a current-round collection");
		assert.equal(branchResults.length, 3);
		assert.ok(branchResults.every((item) => getPath(item as JsonObject, "round") === 2), "only round-2 branch cards remain");

		// --- Conflict-triggered debate ran in round 1, in order, then bump_round cleared it ---
		assert.equal(count(executor.calls, "devil_advocate"), 1);
		assert.equal(count(executor.calls, "defender"), 1);
		assert.equal(count(executor.calls, "arbiter"), 1);
		const idxAdvocate = executor.calls.indexOf("devil_advocate");
		const idxDefender = executor.calls.indexOf("defender");
		const idxArbiter = executor.calls.indexOf("arbiter");
		assert.ok(idxAdvocate < idxDefender && idxDefender < idxArbiter, "debate chain order: advocate -> defender -> arbiter");
		assert.equal(getPath(completed.state, "working.debate"), undefined, "stale round-1 debate was cleaned");

		// bump_round archived exactly the round-1 integration into compact cross-round memory.
		assert.equal(getPath(completed.state, "memory.last_integration.round"), 1);
		const firstIntegrator = executor.calls.indexOf("integrator");
		const bumpRound = executor.calls.indexOf("bump_round");
		assert.ok(firstIntegrator < bumpRound, "insufficient integrator precedes bump_round");
		assert.ok(bumpRound < lastPlanner, "bump_round precedes the round-2 planner");

		// --- Terminal: integrator round 2 sufficient -> reporter, artifact stored, result projected ---
		assert.equal(getPath(completed.state, "working.integration.sufficient"), true);
		assert.equal(getPath(completed.state, "working.integration.round"), 2);
		assert.equal(count(executor.calls, "reporter"), 1);
		assert.equal(getPath(completed.state, "result.report_artifact.kind"), "artifact");
		assert.equal(completed.includeState, false);
		assert.equal(getPath(completed.result ?? {}, "result.report_artifact.kind"), "artifact");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
