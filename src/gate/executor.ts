import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentNodeDefinition, NodeDefinition, NodeExecutionContext, NodeExecutionResult, NodeExecutor } from "../types.ts";
import { addUsage, emptyUsage, errorMessage } from "../utils.ts";
import { runChecks, type CheckResult } from "./checker.ts";
import { gatePolicyProblems } from "./policy.ts";
import { protectedChanges, resolveWorkspace, snapshotWorkspace } from "./workspace.ts";

export interface GateRound {
	attempt: number;
	executionId: string;
	startedAt: string;
	checks: CheckResult[];
	changedFiles: string[];
}

export interface GateReport {
	version: 1;
	runId: string;
	nodeId: string;
	status: "running" | "passed" | "failed";
	maxAttempts: number;
	rounds: GateRound[];
	reason: string | null;
}

export interface GateExecutorOptions {
	cwd: string;
	reportsDir: string;
}

/** No scheduler mutations: only validated candidate writes leave this executor. */
export class GateNodeExecutor implements NodeExecutor {
	private readonly inner: NodeExecutor;
	private readonly options: GateExecutorOptions;

	constructor(inner: NodeExecutor, options: GateExecutorOptions) {
		this.inner = inner;
		this.options = options;
	}

	async execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
		if (node.type !== "agent" || !node.gate) return this.inner.execute(node, context);
		return this.executeGated(node, context);
	}

	private async executeGated(node: AgentNodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
		const policy = node.gate!;
		const startedAt = new Date().toISOString();
		const usage = emptyUsage();
		const report: GateReport = { version: 1, runId: context.runId, nodeId: context.nodeId, status: "running", maxAttempts: policy.maxAttempts ?? 3, rounds: [], reason: null };
		let reportPath: string | undefined;
		let ownsReport = false;
		const persist = async () => {
			if (!reportPath || !ownsReport) return;
			const temporary = `${reportPath}.${randomUUID()}.tmp`;
			await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
			await rename(temporary, reportPath);
		};
		const fail = async (code: string, reason: string): Promise<NodeExecutionResult> => {
			report.status = "failed";
			report.reason = reason;
			try { await persist(); } catch (error) { reason += `; report persistence failed: ${errorMessage(error)}`; }
			return { kind: "failure", code, error: `${reason}${reportPath ? `\nGate report: ${reportPath}` : ""}`, retryable: false,
				usage, attempts: 1, startedAt, endedAt: new Date().toISOString() };
		};
		const activity = async (message: string) => {
			await context.onEvent?.({ type: "node_activity", runId: context.runId, nodeId: context.nodeId, step: context.step, timestamp: new Date().toISOString(), message });
		};
		try {
			const problems = gatePolicyProblems(node, context.graph.definition);
			if (problems.length) return await fail("GATE_CONFIG", problems.join("; "));
			const cwd = await resolveWorkspace(this.options.cwd, node.cwd);
			const reportsDir = resolve(this.options.reportsDir);
			const reportRelative = relative(cwd, reportsDir);
			if (!isAbsolute(reportRelative) && reportRelative !== ".." && !reportRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
				return await fail("GATE_CONFIG", "Gate reports must be stored outside the candidate workspace");
			}
			const baseline = await snapshotWorkspace(cwd);
			for (const file of policy.writableFiles) {
				if (!baseline.has(file)) return await fail("GATE_CONFIG", `Writable file does not exist: ${file}`);
			}
			if (policy.checks.includes("typecheck") && !baseline.has("tsconfig.json")) return await fail("GATE_CONFIG", "Missing tsconfig.json");
			if (policy.checks.includes("test") && ![...baseline.keys()].some((file) => /^tests\/[A-Za-z0-9_.-]+\.test\.ts$/.test(file))) {
				return await fail("GATE_CONFIG", "Missing tests/*.test.ts");
			}
			if (policy.checks.includes("python-test") && ![...baseline.keys()].some((file) => /^tests\/test_[A-Za-z0-9_]+\.py$/.test(file))) {
				return await fail("GATE_CONFIG", "Missing tests/test_*.py (Python unittest)");
			}
			const identity = context.executionId ?? `${context.runId}:${context.step}:${context.nodeId}:${context.attempt ?? 1}`;
			await mkdir(reportsDir, { recursive: true });
			reportPath = join(reportsDir, `${createHash("sha256").update(identity).digest("hex")}.json`);
			try {
				await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
				ownsReport = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					return await fail("GATE_RECOVERY_REQUIRED", "A gate attempt already exists. Mid-repair recovery is not supported; inspect the saved report and start a new run after checking the workspace.");
				}
				throw error;
			}
			let feedback = "";
			for (let attempt = 1; attempt <= report.maxAttempts; attempt++) {
				if (context.signal?.aborted) return await fail("ABORTED", "Gate cancelled");
				const executionId = `${identity}:gate:${attempt}`;
				const round: GateRound = { attempt, executionId, startedAt: new Date().toISOString(), checks: [], changedFiles: [] };
				report.rounds.push(round);
				await persist();
				await activity(`GateNode ${attempt}/${report.maxAttempts}: ${attempt === 1 ? "implementing" : "repairing"}`);
				// Only the feedback state is projected, so diagnostic text is not parsed as a prompt template.
				const prompt = `${node.prompt}\n\nGateNode acceptance: modify only ${policy.writableFiles.join(", ")}. Keep tests and configuration unchanged. Checks: ${policy.checks.join(", ")}.\n{{gatenodeFeedback}}`;
				const result = await this.inner.execute({ ...node, gate: undefined, prompt }, {
					...context, executionId,
					state: { ...context.state, gatenodeFeedback: feedback },
					...(context.recordTurn ? { recordTurn: (turn) => context.recordTurn!({ ...turn, id: `${executionId}:${turn.id}` }) } : {}),
				});
				addUsage(usage, result.usage);
				if (result.kind !== "success") return await fail(result.kind === "failure" ? result.code ?? "AGENT_FAILED" : "GATE_AGENT_INTERRUPTED", result.kind === "failure" ? result.error : "Agent interrupted before acceptance");
				if (context.signal?.aborted) return await fail("ABORTED", "Gate cancelled");
				const afterAgent = await snapshotWorkspace(cwd);
				round.changedFiles = [...new Set([...baseline.keys(), ...afterAgent.keys()])].filter((file) => baseline.get(file) !== afterAgent.get(file));
				const violations = protectedChanges(baseline, afterAgent, policy.writableFiles);
				if (violations.length) return await fail("GATE_PROTECTED_FILES", `Protected files changed: ${violations.join(", ")}. No checks were executed.`);
				await activity(`GateNode ${attempt}/${report.maxAttempts}: checking ${policy.checks.join(" + ")}`);
				round.checks = await runChecks(cwd, policy, context.signal);
				await persist();
				if (context.signal?.aborted) return await fail("ABORTED", "Gate cancelled");
				const afterChecks = await snapshotWorkspace(cwd);
				if (context.signal?.aborted) return await fail("ABORTED", "Gate cancelled");
				if ([...new Set([...afterAgent.keys(), ...afterChecks.keys()])].some((file) => afterAgent.get(file) !== afterChecks.get(file))) {
					return await fail("GATE_WORKSPACE_CHANGED", "Workspace changed during validation; the checked candidate cannot be accepted");
				}
				if (round.checks.length === policy.checks.length && round.checks.every((check) => check.status === "passed")) {
					report.status = "passed";
					await persist();
					await activity(`GateNode passed after ${attempt} attempt(s). Report: ${reportPath}`);
					if (context.signal?.aborted) return await fail("ABORTED", "Gate cancelled");
					return { ...result, usage, startedAt, endedAt: new Date().toISOString() };
				}
				feedback = formatFeedback(round.checks);
				if (round.checks.some((check) => check.status === "error")) return await fail("GATE_CHECK_ERROR", feedback);
				await activity(`GateNode ${attempt}/${report.maxAttempts}: rejected — ${feedback.slice(0, 350)}`);
				if (attempt === report.maxAttempts) return await fail("GATE_EXHAUSTED", `Automatic repair failed after ${attempt} total attempts.\n${feedback}`);
			}
			return await fail("GATE_INTERNAL", "Gate ended without an acceptance decision");
		} catch (error) {
			return await fail(context.signal?.aborted ? "ABORTED" : "GATE_ERROR", errorMessage(error));
		}
	}
}

function formatFeedback(checks: CheckResult[]): string {
	return `Previous candidate failed deterministic validation. Fix the code using these diagnostics:\n${checks
		.filter((check) => check.status !== "passed")
		.flatMap((check) => check.diagnostics.map((item) => `${check.check}: ${item.file ?? ""}${item.line ? `:${item.line}:${item.column}` : ""} ${item.code}: ${item.message}`))
		.join("\n").slice(0, 6000)}`;
}
