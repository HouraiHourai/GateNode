import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTypeScriptDiagnostics, runChecks, runCommand } from "../src/gate/checker.ts";

test("compiler diagnostics preserve Windows paths, positions and continuation messages", () => {
	const diagnostics = parseTypeScriptDiagnostics("C:\\repo\\src\\items.ts(12,3): error TS2322: Type 'string' is not assignable.\r\n  Additional detail\r\n");
	assert.equal(diagnostics[0].file, "C:\\repo\\src\\items.ts");
	assert.equal(diagnostics[0].line, 12);
	assert.equal(diagnostics[0].column, 3);
	assert.match(diagnostics[0].message, /Additional detail/);
});

test("missing executables are errors", async () => {
	const result = await runCommand("gatenode-nonexistent-command", [], process.cwd(), { timeoutMs: 2000, maxOutputBytes: 1024 });
	assert.ok(result.error);
	assert.equal(result.exitCode, null);
});

test("checker timeout terminates the command", async () => {
	const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), { timeoutMs: 100, maxOutputBytes: 1024 });
	assert.match(result.error ?? "", /timed out/);
});

test("output overflow is a failure with bounded retained output", async () => {
	const result = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], process.cwd(), { timeoutMs: 3000, maxOutputBytes: 1024 });
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.output) <= 1024);
	assert.match(result.error ?? "", /byte limit/);
});

test("cancellation propagates to a running checker", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 100);
	try {
		const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), { timeoutMs: 10000, maxOutputBytes: 1024, signal: controller.signal });
		assert.match(result.error ?? "", /cancelled/);
	} finally { clearTimeout(timer); }
});

test("a hanging Node test cannot outlive its checker timeout", async () => {
	const root = await mkdtemp(join(tmpdir(), "gatenode-hanging-test-"));
	try {
		await mkdir(join(root, "tests"));
		await writeFile(join(root, "tests", "hang.test.ts"), "setInterval(() => {}, 1000);\n");
		const started = Date.now();
		const checks = await runChecks(root, { checks: ["test"], writableFiles: ["src/items.ts"], timeoutMs: 200 });
		assert.equal(checks[0].status, "error");
		assert.match(checks[0].diagnostics[0].message, /timed out/);
		assert.ok(Date.now() - started < 5000);
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const { name, source, expected } of [
	{ name: "skipped tests", source: "test('skipped', { skip: true }, () => {});", expected: "error" },
	{ name: "todo tests", source: "test('pending', { todo: true }, () => {});", expected: "error" },
	{ name: "empty suites", source: "describe('empty suite', () => {});", expected: "error" },
	{ name: "a real nested test", source: "describe('suite', () => { test('works', () => assert.equal(1 + 1, 2)); test.skip('later', () => {}); });", expected: "passed" },
	{ name: "a test with a filename in its title", source: "test('items.test.ts', () => assert.equal(1 + 1, 2));", expected: "passed" },
]) {
	test(`empty files combined with ${name} do not distort acceptance`, async () => {
		const root = await mkdtemp(join(tmpdir(), "gatenode-test-presence-"));
		try {
			await mkdir(join(root, "tests"));
			await writeFile(join(root, "tests", "empty.test.ts"), "// No registered tests\n");
			await writeFile(join(root, "tests", "case.test.ts"), `import { test, describe } from 'node:test';\nimport assert from 'node:assert/strict';\n${source}\n`);
			const checks = await runChecks(root, { checks: ["test"], writableFiles: ["src/items.ts"] });
			assert.equal(checks[0].status, expected, checks[0].output);
			if (expected === "error") assert.match(checks[0].diagnostics[0].message, /did not run any passing tests/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}
