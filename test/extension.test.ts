import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import { FileCheckpointStore } from "../src/checkpoint.ts";
import piGraphExtension, { formatResultProjection, formatRunNotice, renderGraphResult, renderPigEntry } from "../src/extension.ts";
import type { CheckpointSnapshot, GraphRunResult, JsonObject } from "../src/types.ts";
import { emptyUsage } from "../src/utils.ts";

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<unknown>;
}

interface CapturedCommand {
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler?: (args: string, ctx: unknown) => Promise<void>;
}

function captureTools(onEntry?: (entry: unknown) => void): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerTool(tool: unknown) {
			const captured = tool as CapturedTool;
			tools.set(captured.name, captured);
		},
		registerCommand() {},
		registerEntryRenderer() {},
		on() {},
		appendEntry(_type: string, entry: unknown) {
			onEntry?.(entry);
		},
		getThinkingLevel() {
			return "off";
		},
		getActiveTools() {
			return ["read", "bash", "edit", "write"];
		},
	} as unknown as ExtensionAPI;
	piGraphExtension(pi);
	return tools;
}

function tool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
	const captured = tools.get(name);
	assert.ok(captured, `Expected ${name} to be registered`);
	return captured;
}

test("Pi graph tools throw caught errors so Pi marks tool results as failed", async () => {
	const tools = captureTools();
	const context = {
		cwd: process.cwd(),
		hasUI: false,
		isProjectTrusted: () => true,
		ui: { setStatus() {} },
	};

	await assert.rejects(
		tool(tools, "pi_graph_run").execute("run", { graph: "missing", checkpoint: false }, undefined, undefined, context),
		/pig failed: Unknown graph/,
	);
	await assert.rejects(
		tool(tools, "pi_graph_resume").execute(
			"resume",
			{ runId: "missing", value: "yes", valueJson: "true" },
			undefined,
			undefined,
			context,
		),
		/pig resume failed: Provide only one of value or valueJson/,
	);
	await assert.rejects(
		tool(tools, "pi_graph_inspect").execute("inspect", { runId: "missing" }, undefined, undefined, context),
		/pig inspect failed:/,
	);
});

test("autonomous tool run blocks mutating graphs without allowNonInteractiveMutations", async () => {
	// A model-driven pi_graph_run call is autonomous: no synchronous human can
	// consent to file edits. Such a call must refuse a mutating graph that has
	// not opted in via allowNonInteractiveMutations, even in an interactive
	// (hasUI) session where the old check was skipped.
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-autonomous-mutating-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const project = join(directory, "project");
		const graphDir = join(project, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "autonomous-mutating.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "autonomous-mutating",
				entry: "worker",
				nodes: { worker: { type: "agent", prompt: "noop", tools: ["bash"] } },
				policy: { allowNonInteractive: true, confirmProjectGraph: false },
			}),
			"utf8",
		);
		const context = {
			cwd: project,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { setStatus() {}, confirm: async () => true },
		};
		await assert.rejects(
			tool(captureTools(), "pi_graph_run").execute(
				"run",
				{ graph: "autonomous-mutating", scope: "project", checkpoint: false },
				undefined,
				undefined,
				context,
			),
			/cannot be run autonomously without allowNonInteractiveMutations/,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("command graph completions use trusted cwd-aware discovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-completions-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = join(directory, "agent");
		const project = join(directory, "project");
		const nested = join(project, "packages", "app");
		await mkdir(join(agentDir, "graphs"), { recursive: true });
		await mkdir(join(project, ".pi", "graphs"), { recursive: true });
		await mkdir(nested, { recursive: true });
		await writeCompletionGraph(join(agentDir, "graphs", "user-file.json"), "user-graph");
		await writeCompletionGraph(join(project, ".pi", "graphs", "project-file.json"), "project-graph");
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const captured = captureCommand();
		captured.start({ cwd: nested, isProjectTrusted: () => true });
		const trusted = await captured.command.getArgumentCompletions?.("run ");
		assert.deepEqual(trusted?.map((item) => item.value), ["run project-graph", "run user-graph"]);
		const partial = await captured.command.getArgumentCompletions?.("run user-");
		assert.deepEqual(partial?.map((item) => item.value), ["run user-graph"]);

		captured.start({ cwd: nested, isProjectTrusted: () => false });
		const untrusted = await captured.command.getArgumentCompletions?.("run ");
		assert.deepEqual(untrusted?.map((item) => item.value), ["run user-graph"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("/pig list surfaces diagnostics for invalid graphs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-list-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = join(directory, "agent");
		const graphDir = join(agentDir, "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeCompletionGraph(join(graphDir, "good.json"), "good-graph");
		await writeFile(
			join(graphDir, "bad.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "bad-graph",
				entry: "done",
				nodes: { done: { type: "set", assign: [{ path: "result.done", value: true }] } },
				routes: [],
			}),
			"utf8",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const notifications: Array<{ message: string; tone: string }> = [];
		const { command } = captureCommand();
		assert.ok(command.handler);
		await command.handler("list", {
			cwd: directory,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				notify(message: string, tone: string) {
					notifications.push({ message, tone });
				},
			},
		});

		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /good-graph\s+\[user\]/);
		assert.match(notifications[0].message, /ERROR\s+UNKNOWN_FIELD/);
		assert.match(notifications[0].message, /bad\.json:routes/);
		assert.equal(notifications[0].tone, "warning");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("/pig list aligns columns and omits empty descriptions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-list-format-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = join(directory, "agent");
		const graphDir = join(agentDir, "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "alpha.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "alpha",
				description: "Short-named graph with a description",
				entry: "done",
				nodes: { done: { type: "set", assign: [{ path: "result.done", value: true }] } },
			}),
			"utf8",
		);
		await writeFile(
			join(graphDir, "longer-name-beta.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "longer-name-beta",
				entry: "a",
				nodes: {
					a: { type: "set", assign: [{ path: "x", value: 1 }] },
					b: { type: "set", assign: [{ path: "y", value: 2 }] },
				},
			}),
			"utf8",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const notifications: Array<{ message: string; tone: string }> = [];
		const { command } = captureCommand();
		assert.ok(command.handler);
		await command.handler("list", {
			cwd: directory,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				notify(message: string, tone: string) {
					notifications.push({ message, tone });
				},
			},
		});

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].tone, "info");
		const message = notifications[0].message;

		// Header counts the discovered graphs.
		assert.match(message, /^Graphs \(2\)$/m);
		// Pluralization differs by node count.
		assert.match(message, /\b1 node\b/);
		assert.match(message, /\b2 nodes\b/);
		// Description present where defined; omitted (no dangling separator) where not.
		assert.match(message, /Short-named graph with a description/);
		assert.doesNotMatch(message, /longer-name-beta.*·\s*$/m);
		// Columns align: [user] starts at the same offset on every graph row.
		const graphLines = message.split("\n").filter((line) => /\[user\]/.test(line));
		assert.equal(graphLines.length, 2);
		const scopeOffsets = graphLines.map((line) => line.indexOf("[user]"));
		assert.equal(scopeOffsets[0], scopeOffsets[1]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("/pig delete confirms before removing checkpoint, thread history, and artifacts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-delete-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = join(directory, "agent");
		const runId = "delete-command-run";
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const store = new FileCheckpointStore(join(agentDir, "pi-graph", "runs"));
		const run = await store.open({ mode: "create", snapshot: commandSnapshot(runId) });
		await run.close();
		const threadDir = join(agentDir, "pi-graph", "threads", runId);
		const artifactDir = join(agentDir, "pi-graph", "artifacts", runId);
		const threadFile = join(threadDir, "thread.jsonl");
		const artifactFile = join(artifactDir, "artifact.txt");
		await mkdir(threadDir, { recursive: true });
		await mkdir(artifactDir, { recursive: true });
		await writeFile(threadFile, "thread", "utf8");
		await writeFile(artifactFile, "artifact", "utf8");

		let approved = false;
		const notifications: string[] = [];
		const { command } = captureCommand();
		assert.ok(command.handler);
		const context = {
			cwd: directory,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				confirm: async () => approved,
				notify: (message: string) => notifications.push(message),
			},
		};

		await command.handler(`delete ${runId}`, context);
		assert.equal((await store.load(runId)).snapshot.runId, runId);
		await access(threadFile);
		await access(artifactFile);

		approved = true;
		await command.handler(`delete ${runId}`, context);
		await assert.rejects(store.load(runId), /checkpoint does not exist/);
		await assert.rejects(access(threadFile), { code: "ENOENT" });
		await assert.rejects(access(artifactFile), { code: "ENOENT" });
		assert.ok(notifications.some((message) => message.includes(`Deleted Pi graph run ${runId}`)));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("run authorization and status text use the compiled graph identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-source-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const project = join(directory, "project");
		const graphPath = join(project, ".pi", "graphs", "different-file-name.json");
		await mkdir(join(project, ".pi", "graphs"), { recursive: true });
		await writeCompletionGraph(graphPath, "compiled-name");

		const confirmations: Array<{ title: string; message: string }> = [];
		const statuses: Array<string | undefined> = [];
		const context = {
			cwd: project,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				setStatus(_key: string, value: string | undefined) {
					statuses.push(value);
				},
				setWidget() {},
				async confirm(title: string, message: string) {
					confirmations.push({ title, message });
					return true;
				},
			},
		};

		const output = (await tool(captureTools(), "pi_graph_run").execute(
			"run",
			{ graph: "compiled-name", scope: "project", checkpoint: false },
			undefined,
			undefined,
			context,
		)) as { details: { graph: string } };
		assert.equal(output.details.graph, "compiled-name");
		assert.deepEqual(confirmations.map(({ title }) => title), ["Run project-local Pi graph?"]);
		assert.match(confirmations[0].message, /Graph: compiled-name/);
		assert.match(confirmations[0].message, new RegExp(escapeRegExp(graphPath)));
		assert.ok(statuses.some((status) => status === "compiled-name: starting"));
		assert.ok(statuses.some((status) => status?.startsWith("compiled-name: step ")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("pi_graph_run throws when the engine returns a cancelled terminal result", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-cancelled-"));
	try {
		const graphDir = join(directory, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "cancelled.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "cancelled",
				entry: "marker",
				nodes: { marker: { type: "set", assign: [{ path: "reached", value: true }] } },
				policy: { allowNonInteractive: true },
			}),
			"utf8",
		);
		const tools = captureTools();
		const controller = new AbortController();
		controller.abort();
		const context = {
			cwd: directory,
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { setStatus() {} },
		};

		await assert.rejects(
			tool(tools, "pi_graph_run").execute(
				"run",
				{ graph: "cancelled", scope: "project", checkpoint: false },
				controller.signal,
				undefined,
				context,
			),
			/pig failed: pig run .*status: cancelled/s,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("/pig run forwards its command abort signal to the graph", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-command-cancelled-"));
	try {
		const graphDir = join(directory, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "cancelled.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "cancelled",
				entry: "done",
				nodes: { done: { type: "set", assign: [{ path: "result.done", value: true }] } },
				policy: { allowNonInteractive: true },
			}),
			"utf8",
		);
		const controller = new AbortController();
		controller.abort();
		const notifications: string[] = [];
		const { command } = captureCommand();
		assert.ok(command.handler);

		await command.handler("run cancelled", {
			cwd: directory,
			hasUI: false,
			isProjectTrusted: () => true,
			signal: controller.signal,
			ui: { setStatus() {}, notify: (message: string) => notifications.push(message) },
		});

		assert.match(notifications[0] ?? "", /cancelled/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("run and inspect tool details do not duplicate full graph state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-light-details-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const graphDir = join(directory, "project", ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		const wideKey = "研究".repeat(30);
		await writeFile(
			join(graphDir, "compact-result.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "compact-result",
				entry: "finish",
				nodes: {
					finish: {
						type: "set",
						assign: [
							{ path: "working.large", value: "x".repeat(20_000) },
							{ path: `working.${wideKey}`, value: "wide" },
							{ path: "result.summary", value: "ok" },
						],
					},
				},
				result: { paths: ["result.summary"], includeState: false },
				policy: { allowNonInteractive: true, confirmProjectGraph: false },
				limits: {
					maxSteps: 2,
					maxNodeRuns: 2,
					maxConcurrency: 1,
					maxCostUsd: 1,
					timeoutMs: 10_000,
					maxStateBytes: 100_000,
				},
			}),
			"utf8",
		);
		const tools = captureTools();
		const context = {
			cwd: join(directory, "project"),
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { setStatus() {} },
		};

		const runOutput = (await tool(tools, "pi_graph_run").execute(
			"run",
			{ graph: "compact-result", scope: "project", checkpoint: true },
			undefined,
			undefined,
			context,
		)) as { content: Array<{ text: string }>; details: { result: Record<string, unknown> } };
		assert.equal("state" in runOutput.details.result, false);
		assert.match(runOutput.content[0].text, /result\.summary|"summary": "ok"/);
		assert.doesNotMatch(runOutput.content[0].text, /x{100}/);
		const runId = String(runOutput.details.result.runId);

		const inspectOutput = (await tool(tools, "pi_graph_inspect").execute(
			"inspect",
			{ runId, view: "summary" },
			undefined,
			undefined,
			context,
		)) as { content: Array<{ text: string }>; details: Record<string, unknown> };
		assert.equal("record" in inspectOutput.details, false);
		assert.equal("snapshot" in inspectOutput.details, false);
		assert.equal("checkpoint" in inspectOutput.details, true);
		assert.match(inspectOutput.content[0].text, /state inventory:/);
		assert.match(inspectOutput.content[0].text, /19\.5KB/);
		assert.doesNotMatch(inspectOutput.content[0].text, /x{100}/);
		const wideInventoryLine = inspectOutput.content[0].text.split("\n").find((line) => line.includes("研究"));
		assert.ok(wideInventoryLine);
		assert.ok(visibleWidth(wideInventoryLine) <= 70);
		assert.match(wideInventoryLine, /…/);

		const pathOutput = (await tool(tools, "pi_graph_inspect").execute(
			"inspect-path",
			{ runId, view: "path", path: "result.summary" },
			undefined,
			undefined,
			context,
		)) as { content: Array<{ text: string }> };
		assert.match(pathOutput.content[0].text, /result\.summary:\n"ok"/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("inspect marks an expired running lease as resumable without claiming it", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-stale-inspect-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let owner: Awaited<ReturnType<FileCheckpointStore["open"]>> | undefined;
	try {
		let clock = Date.now();
		t.mock.method(Date, "now", () => clock);
		const agentDir = join(directory, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const store = new FileCheckpointStore(join(agentDir, "pi-graph", "runs"));
		owner = await store.open({ mode: "create", snapshot: commandSnapshot("expired-inspect-run") });
		clock += 30_001;

		const tools = captureTools();
		const context = { cwd: directory, hasUI: false, isProjectTrusted: () => true, ui: { setStatus() {} } };
		const single = (await tool(tools, "pi_graph_inspect").execute(
			"inspect-stale",
			{ runId: "expired-inspect-run" },
			undefined,
			undefined,
			context,
		)) as { content: Array<{ text: string }>; details: { checkpoint: { lease: { status: string } } } };
		const listed = (await tool(tools, "pi_graph_inspect").execute(
			"list-stale",
			{},
			undefined,
			undefined,
			context,
		)) as { content: Array<{ text: string }> };

		assert.match(single.content[0].text, /status: running/);
		assert.match(single.content[0].text, /lease: expired .* \(resumable\)/);
		assert.equal(single.details.checkpoint.lease.status, "expired");
		assert.match(listed.content[0].text, /running · lease expired .* \(resumable\)/);
		assert.equal((await store.inspect("expired-inspect-run")).lease.status, "expired");
		assert.equal((await store.load("expired-inspect-run")).revision, 1);
	} finally {
		await owner?.close();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Pi graph user-facing surfaces expose token usage without cost estimates", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-token-usage-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const project = join(directory, "project");
		const graphDir = join(project, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "token-only.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "token-only",
				entry: "finish",
				nodes: { finish: { type: "set", assign: [{ path: "result.done", value: true }] } },
				result: { paths: ["result.done"] },
				policy: { allowNonInteractive: true, confirmProjectGraph: false },
			}),
			"utf8",
		);
		const entries: unknown[] = [];
		const updates: unknown[] = [];
		const tools = captureTools((entry) => entries.push(entry));
		const context = {
			cwd: project,
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { setStatus() {} },
		};

		const runOutput = (await tool(tools, "pi_graph_run").execute(
			"run",
			{ graph: "token-only", scope: "project", checkpoint: true },
			undefined,
			(partial) => updates.push(partial),
			context,
		)) as { details: { result: { runId: string; usage: Record<string, unknown> } } };
		assert.equal("inputTokens" in runOutput.details.result.usage, true);
		const runId = runOutput.details.result.runId;
		const inspectSummary = await tool(tools, "pi_graph_inspect").execute(
			"inspect-summary",
			{ runId, view: "summary" },
			undefined,
			undefined,
			context,
		);
		const inspectFull = await tool(tools, "pi_graph_inspect").execute(
			"inspect-full",
			{ runId, view: "full" },
			undefined,
			undefined,
			context,
		);
		const runList = await tool(tools, "pi_graph_inspect").execute(
			"inspect-list",
			{ limit: 10 },
			undefined,
			undefined,
			context,
		);

		for (const [label, surface] of [
			["run", runOutput],
			["stream updates", updates],
			["inspect summary", inspectSummary],
			["inspect full", inspectFull],
			["run list", runList],
			["session entry", entries],
		] as const) {
			assertNoCostEstimate(surface, label);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

function captureCommand(onEntry?: (entry: unknown) => void): { command: CapturedCommand; start: (ctx: { cwd: string; isProjectTrusted(): boolean }) => void } {
	let command: CapturedCommand | undefined;
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		registerTool() {},
		registerCommand(_name: string, value: CapturedCommand) {
			command = value;
		},
		registerEntryRenderer() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			if (event === "session_start") sessionStart = handler;
		},
		appendEntry(_type: string, entry: unknown) {
			onEntry?.(entry);
		},
		getThinkingLevel() {
			return "off";
		},
		getActiveTools() {
			return ["read", "bash", "edit", "write"];
		},
	} as unknown as ExtensionAPI;
	piGraphExtension(pi);
	assert.ok(command);
	assert.ok(sessionStart);
	return {
		command,
		start(ctx) {
			sessionStart?.({}, ctx);
		},
	};
}

async function writeCompletionGraph(path: string, name: string): Promise<void> {
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 2,
			name,
			entry: "done",
			nodes: { done: { type: "set", assign: [{ path: "result.done", value: true }] } },
			policy: { confirmProjectGraph: true },
		}),
		"utf8",
	);
}

function commandSnapshot(runId: string): CheckpointSnapshot {
	const timestamp = new Date().toISOString();
	return {
		version: 2,
		runId,
		graphName: "delete-command-graph",
		graphHash: "a".repeat(64),
		status: "running",
		createdAt: timestamp,
		updatedAt: timestamp,
		startedAt: timestamp,
		activeTimeMs: 0,
		step: 0,
		nodeRuns: 0,
		state: {},
		pending: ["worker"],
		completionCounts: {},
		barrierConsumed: {},
		usage: emptyUsage(),
		history: [],
		threads: {},
	};
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoCostEstimate(value: unknown, label: string): void {
	assert.doesNotMatch(JSON.stringify(value), /costUsd|cost:|\$\d/i, label);
}

function plainTheme(): Theme {
	return { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
}

function makeRunResult(overrides: Partial<GraphRunResult> = {}): GraphRunResult {
	return {
		runId: "notice-run-1",
		status: "completed",
		state: {},
		result: { report: "# Findings\n\n- alpha\n- beta" },
		stateBytes: 16,
		includeState: false,
		resultMaxBytes: 4096,
		usage: emptyUsage(),
		step: 2,
		nodeRuns: 3,
		...overrides,
	};
}

test("formatResultProjection keeps string leaves as markdown and arrays as fenced JSON", () => {
	const projection: JsonObject = {
		report: "# Findings\n\n- alpha\n- beta",
		stats: { runs: 3 },
		tags: ["a", "b"],
		done: true,
	};
	const text = formatResultProjection(projection, 4096);
	assert.match(text, /## report/);
	assert.ok(text.includes("# Findings\n\n- alpha"));
	assert.ok(!text.includes("\\n"));
	assert.ok(text.includes("## stats.runs\n\n3"));
	assert.ok(text.includes('## tags\n\n```json\n[\n  "a",\n  "b"\n]\n```'));
	assert.ok(text.includes("## done\n\ntrue"));
});

test("formatResultProjection recurses into nested projections like result.report", () => {
	const text = formatResultProjection({ result: { report_artifact: "# Report\n\nbody" } }, 4096);
	assert.ok(text.includes("## result.report_artifact\n\n# Report\n\nbody"));
	assert.ok(!text.includes("\\n"));
});

test("formatResultProjection marks truncated projections", () => {
	const text = formatResultProjection({ report: "x".repeat(500) }, 100);
	assert.ok(text.includes("… content omitted"));
	assert.ok(Buffer.byteLength(text, "utf8") <= 100 + Buffer.byteLength("… content omitted", "utf8"));
});

test("formatRunNotice summarizes a run without a JSON body", () => {
	const notice = formatRunNotice(makeRunResult());
	assert.match(notice, /pig notice-run-1 · completed · 2 steps · 3 node runs/);
	assert.match(notice, /\/pig inspect notice-run-1/);
	assert.ok(!notice.includes('{"'));
	assert.ok(!notice.includes("\\n"));
});

test("formatRunNotice keeps resume hints for interrupted and failed runs", () => {
	const interrupted = formatRunNotice(
		makeRunResult({ status: "interrupted", interrupt: { nodeId: "review", kind: "confirm", prompt: "OK?", createdAt: new Date().toISOString() } }),
	);
	assert.match(interrupted, /Interrupted at review: OK\?/);
	assert.match(interrupted, /\/pig resume notice-run-1/);
	const failed = formatRunNotice(makeRunResult({ status: "failed", error: "boom" }));
	assert.match(failed, /error: boom/);
});

test("renderGraphResult expanded renders markdown results without escaped newlines", () => {
	initTheme();
	const result = makeRunResult();
	const view = {
		runId: result.runId,
		status: result.status,
		result: result.result,
		stateBytes: result.stateBytes,
		includeState: false,
		resultMaxBytes: result.resultMaxBytes,
		usage: result.usage,
		step: result.step,
		nodeRuns: result.nodeRuns,
		stateInventory: "(empty)",
	};
	const lines = renderGraphResult({ result: view }, true, plainTheme()).render(80);
	const joined = lines.join("\n");
	assert.ok(joined.includes("Findings"));
	assert.ok(joined.includes("alpha"));
	assert.ok(!joined.includes("\\n"));
});

test("renderPigEntry shows a status line plus markdown result automatically, with legacy fallback", () => {
	initTheme();
	const data = {
		graph: "science-research",
		runId: "notice-run-1",
		status: "completed",
		step: 2,
		nodeRuns: 3,
		tokens: 120,
		error: null,
		resultPreview: "## report\n\n# Findings\n\n- alpha",
	};
	const theme = plainTheme();
	const collapsed = renderPigEntry(data, false, theme)?.render(80).join("\n") ?? "";
	assert.ok(collapsed.includes("science-research"));
	assert.ok(collapsed.includes("Findings"));
	const expanded = renderPigEntry(data, true, theme)?.render(80).join("\n") ?? "";
	assert.ok(expanded.includes("Findings"));
	assert.ok(!expanded.includes("\\n"));
	const legacy = renderPigEntry({ ...data, resultPreview: null }, true, theme)?.render(80).join("\n") ?? "";
	assert.ok(legacy.includes("science-research"));
	assert.ok(!legacy.includes("Findings"));
});

test("pig run entry carries a markdown result preview and notifies without a JSON body", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-entry-preview-"));
	try {
		const graphDir = join(directory, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "markdown-result.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "markdown-result",
				entry: "done",
				nodes: { done: { type: "set", assign: [{ path: "result.report", value: "# Findings\n\n- alpha\n- beta" }] } },
				result: { paths: ["result.report"] },
				policy: { allowNonInteractive: true, confirmProjectGraph: false },
			}),
			"utf8",
		);
		const entries: Array<Record<string, unknown>> = [];
		const notifications: string[] = [];
	const { command } = captureCommand((entry) => entries.push(entry as Record<string, unknown>));
		assert.ok(command.handler);
		await command.handler("run markdown-result", {
			cwd: directory,
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { setStatus() {}, notify: (message: string) => notifications.push(message) },
		});

		const entry = entries.at(-1);
		assert.ok(entry, "expected a pig entry");
		const preview = entry.resultPreview;
		assert.equal(typeof preview, "string");
		assert.ok((preview as string).includes("## result.report"));
		assert.ok((preview as string).includes("# Findings\n\n- alpha"));
		assert.ok(!(preview as string).includes("\\n"));
		assert.match(notifications[0] ?? "", /completed/);
		assert.ok(!notifications[0]?.includes('{"'));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
