import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GatePolicy } from "../types.ts";
import { pythonCheckCommand, readPythonReport } from "./python-checker.ts";

export interface GateDiagnostic {
	file: string | null;
	line: number | null;
	column: number | null;
	code: string;
	message: string;
}

export interface CheckResult {
	check: string;
	status: "passed" | "rejected" | "error";
	exitCode: number | null;
	durationMs: number;
	output: string;
	truncated: boolean;
	diagnostics: GateDiagnostic[];
}

const require = createRequire(import.meta.url);

export function parseTypeScriptDiagnostics(output: string): GateDiagnostic[] {
	const diagnostics: GateDiagnostic[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
		if (match) diagnostics.push({ file: match[1], line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5] });
		else {
			const global = /^error (TS\d+): (.*)$/.exec(line);
			if (global) diagnostics.push({ file: null, line: null, column: null, code: global[1], message: global[2] });
			else if (line.trim() && diagnostics.length > 0) {
				const last = diagnostics[diagnostics.length - 1];
				last.message = `${last.message}\n${line.trim()}`.slice(0, 1500);
			}
		}
		if (diagnostics.length >= 20) break;
	}
	return diagnostics;
}

export function runCommand(
	file: string, args: string[], cwd: string,
	options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<{ exitCode: number | null; output: string; error?: string; truncated: boolean }> {
	return new Promise((resolve) => {
		if (options.signal?.aborted) return resolve({ exitCode: null, output: "", error: "Check cancelled", truncated: false });
		const commandEnv = { ...process.env };
		delete commandEnv.NODE_OPTIONS;
		delete commandEnv.NODE_TEST_CONTEXT;
		const child = spawn(file, args, {
			cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
			// A verifier is a separate CLI, not a child node:test worker or a loader-injected process.
			env: commandEnv,
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let problem: string | undefined;
		let truncated = false;
		let settled = false;
		const stop = (reason: string) => { problem ??= reason; child.kill("SIGKILL"); };
		const abort = () => stop("Check cancelled");
		const timer = setTimeout(() => stop(`Check timed out after ${options.timeoutMs}ms`), options.timeoutMs);
		const collect = (chunk: Buffer) => {
			const remaining = options.maxOutputBytes - size;
			if (remaining > 0) { const kept = chunk.subarray(0, remaining); chunks.push(kept); size += kept.length; }
			if (chunk.length > remaining) { truncated = true; stop("Check output exceeded byte limit"); }
		};
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			let output = Buffer.concat(chunks).toString("utf8");
			while (Buffer.byteLength(output) > options.maxOutputBytes) output = output.slice(0, -1);
			resolve({ exitCode, output, ...(problem ? { error: problem } : {}), truncated });
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (error) => { problem = error.message; finish(null); });
		child.on("close", (code, signal) => { if (signal) problem ??= `Check terminated by ${signal}`; finish(code); });
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}

export async function runChecks(cwd: string, policy: GatePolicy, signal?: AbortSignal): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of policy.checks) {
		const started = Date.now();
		try {
			let args: string[];
			let executable = process.execPath;
			let testFiles: string[] = [];
			if (check === "typecheck") {
				args = [require.resolve("typescript/bin/tsc"), "--noEmit", "--pretty", "false", "--incremental", "false", "--project", join(cwd, "tsconfig.json")];
			} else if (check === "test") {
				const tests = (await readdir(join(cwd, "tests"))).filter((name) => /^[A-Za-z0-9_.-]+\.test\.ts$/.test(name)).sort();
				if (!tests.length) throw new Error("No tests/*.test.ts files found");
				testFiles = tests.map((name) => resolve(cwd, "tests", name));
				// Keep fixed fixture tests in this checker process so cancellation also
				// stops the tests, rather than leaving node:test worker subprocesses alive.
				args = ["--test", "--experimental-test-isolation=none", "--test-concurrency=1", "--test-reporter=tap", ...testFiles];
			} else if (check === "python-syntax" || check === "python-test") {
				({ executable, args } = pythonCheckCommand(check, policy.pythonExecutable));
			} else throw new Error(`Unknown check: ${String(check)}`);
			const result = await runCommand(executable, args, cwd, {
				timeoutMs: policy.timeoutMs ?? 30000, maxOutputBytes: policy.maxOutputBytes ?? 32768, signal,
			});
			if (check === "python-syntax" || check === "python-test") {
				const report = readPythonReport(result);
				results.push({ check, ...report, exitCode: result.exitCode, durationMs: Date.now() - started, output: result.output, truncated: result.truncated });
				if (report.status !== "passed") break;
				continue;
			}
			const diagnostics = check === "typecheck" ? parseTypeScriptDiagnostics(result.output) : [];
			// Code ranges overlap: TS6133 is a repairable unused declaration, while
			// TS18003 is a global no-inputs error. Diagnostics in config JSON or
			// without a source location are not repairable by editing allowed .ts files.
			const configError = diagnostics.some((item) => item.file === null || item.file.toLowerCase().endsWith(".json"));
			const noTests = check === "test" && result.exitCode === 0 && !hasPassingTests(result.output, testFiles);
			const problem = result.error ?? (configError ? "TypeScript configuration error" : noTests ? "Test command did not run any passing tests" : undefined);
			const status = problem || result.exitCode === null ? "error" : result.exitCode === 0 ? "passed" : "rejected";
			if (status !== "passed" && (problem || diagnostics.length === 0)) {
				diagnostics.unshift({ file: null, line: null, column: null, code: problem ? "CHECK_ERROR" : "CHECK_FAILED", message: problem ?? (result.output.slice(-4000) || "Check failed without diagnostics") });
			}
			results.push({ check, status, exitCode: result.exitCode, durationMs: Date.now() - started, output: result.output, truncated: result.truncated, diagnostics });
			if (status !== "passed") break;
		} catch (error) {
			results.push({ check, status: "error", exitCode: null, durationMs: Date.now() - started, output: "", truncated: false,
				diagnostics: [{ file: null, line: null, column: null, code: "CHECK_ERROR", message: String(error) }] });
			break;
		}
	}
	return results;
}

function hasPassingTests(output: string, testFiles: string[]): boolean {
	// TAP's pass summary excludes suites, skip and todo, but includes synthetic
	// successes for empty files. Subtract only those exact file labels; a skipped
	// named test alongside an empty file must never qualify as a passing test.
	const summary = /^# pass (\d+)\s*$/m.exec(output);
	if (!summary) return false;
	const fileLabels = new Set(testFiles.map((file) => file.replaceAll("\\", "\\\\").replaceAll("#", "\\#")));
	const emptyFilePasses = [...output.matchAll(/^ok \d+ - ([^\r\n]+)\r?$/gm)]
		.filter((match) => fileLabels.has(match[1])).length;
	return Number(summary[1]) > emptyFilePasses;
}
