import { fileURLToPath } from "node:url";
import type { CheckResult, GateDiagnostic } from "./checker.ts";

export const defaultPythonExecutable = process.platform === "win32" ? "python" : "python3";

export function pythonCheckCommand(check: "python-syntax" | "python-test", executable = defaultPythonExecutable): { executable: string; args: string[] } {
	return { executable, args: ["-I", "-B", "-X", "utf8", fileURLToPath(new URL("./python-runner.py", import.meta.url)), check] };
}

export function readPythonReport(result: { output: string; exitCode: number | null; error?: string }): Pick<CheckResult, "status" | "diagnostics"> {
	const failure = (message: string): Pick<CheckResult, "status" | "diagnostics"> => ({ status: "error", diagnostics: [{ file: null, line: null, column: null, code: "CHECK_ERROR", message }] });
	if (result.error) return failure(result.error);
	const lines = result.output.split(/\r?\n/).filter((line) => line.startsWith("GATENODE_PYTHON_RESULT="));
	if (lines.length !== 1) return failure(`Python checker did not produce one completion report.\n${result.output.slice(-3000)}`);
	try {
		const value = JSON.parse(lines[0].slice("GATENODE_PYTHON_RESULT=".length)) as Record<string, unknown>;
		const status = value.status;
		if (value.version !== 1 || (status !== "passed" && status !== "rejected" && status !== "error")) throw new Error("Invalid Python checker status");
		if (result.exitCode !== (status === "passed" ? 0 : status === "rejected" ? 1 : 2)) throw new Error("Python checker exit code disagrees with its report");
		if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 20) throw new Error("Invalid Python diagnostics");
		const diagnostics = value.diagnostics.map((item: unknown): GateDiagnostic => {
			if (!item || typeof item !== "object") throw new Error("Invalid Python diagnostic");
			const d = item as Record<string, unknown>;
			if ((d.file !== null && typeof d.file !== "string") || (d.line !== null && (!Number.isInteger(d.line) || Number(d.line) < 1)) || (d.column !== null && (!Number.isInteger(d.column) || Number(d.column) < 1)) || typeof d.code !== "string" || typeof d.message !== "string") throw new Error("Invalid Python diagnostic fields");
			return { file: d.file as string | null, line: d.line as number | null, column: d.column as number | null, code: d.code, message: d.message };
		});
		if (status !== "passed" && !diagnostics.length) throw new Error("Python failure without diagnostics");
		return { status, diagnostics };
	} catch (error) { return failure(`Invalid Python completion report: ${String(error)}`); }
}
