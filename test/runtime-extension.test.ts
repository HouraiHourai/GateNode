import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compileGraph } from "../src/compile.ts";
import piGraphExtension, { createRuntimeProgress, renderRuntimeBoardPanel, type RuntimeBoardTheme } from "../src/extension.ts";
import type { GraphDefinition, GraphRunEvent, GraphSource } from "../src/types.ts";

interface ToolPartial {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: ToolPartial) => void) | undefined,
		ctx: unknown,
	) => Promise<unknown>;
	renderResult: (result: ToolPartial, options: { expanded: boolean }, theme: Theme) => Text;
}

test("run tool publishes and clears a live graph widget and renders non-empty partials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-runtime-widget-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const project = join(directory, "project");
		const graphDir = join(project, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "visible-run.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "visible-run",
				entry: "marker",
				nodes: { marker: { type: "set", assign: [{ path: "result.done", value: true }] } },
				policy: { confirmProjectGraph: false },
			}),
			"utf8",
		);

		const tools = captureTools();
		const runTool = tools.get("pi_graph_run");
		assert.ok(runTool);
		const widgets: Array<{ key: string; content: string[] | undefined }> = [];
		const partials: ToolPartial[] = [];
		const context = {
			cwd: project,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				setStatus() {},
				setWidget(key: string, content: unknown) {
					if (typeof content === "function") {
					const component = (content as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
						null,
						identityTheme(),
					);
					widgets.push({ key, content: component.render(100) });
					return;
					}
					widgets.push({ key, content: content as string[] | undefined });
				},
				confirm: async () => true,
			},
		};

		await runTool.execute(
			"run",
			{ graph: "visible-run", scope: "project", checkpoint: false },
			undefined,
			(partial) => partials.push(partial),
			context,
		);

		assert.ok(widgets.some((widget) => widget.key === "pi-graph-runtime" && widget.content?.some((line) => line.includes("● marker"))));
		const framed = widgets.find((widget) => widget.key === "pi-graph-runtime" && widget.content?.[0]?.includes("◈ pi-graph"));
		assert.ok(framed, "the live widget is framed by the branded banner panel");
		assert.ok(framed?.content?.[0]?.startsWith("╭─ "));
		assert.ok(framed?.content?.at(-1)?.endsWith("╯"));
		for (const line of framed?.content ?? []) {
			assert.ok(visibleWidth(line) <= 100, `panel line exceeds width: ${line}`);
		}
		// The board now lingers with the final snapshot instead of vanishing instantly.
		const finalWidget = widgets.at(-1);
		assert.equal(finalWidget?.key, "pi-graph-runtime");
		assert.ok(finalWidget?.content?.some((line) => line.includes("✓ marker")), "final snapshot keeps terminal node state");
		assert.ok(finalWidget?.content?.some((line) => line.includes("COMPLETED")));
		const activePartial = partials.find((partial) => partial.content[0]?.text.includes("● marker"));
		assert.ok(activePartial);
		assert.ok(activePartial.details.runtime);
		const rendered = runTool.renderResult(activePartial, { expanded: false }, identityTheme()).render(120).join("\n");
		assert.match(rendered, /visible-run · RUNNING/);
		assert.match(rendered, /● marker/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

function captureTools(): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerTool(value: unknown) {
			const captured = value as CapturedTool;
			tools.set(captured.name, captured);
		},
		registerCommand() {},
		registerEntryRenderer() {},
		on() {},
		appendEntry() {},
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

function identityTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

test("runtime board panel frames content with aligned borders and CJK-safe padding", () => {
	const colors: string[] = [];
	const theme: RuntimeBoardTheme = {
		fg(color, text) {
			colors.push(color);
			return text;
		},
		bold: (text) => text,
	};
	const lines = [
		"⠦ pig · 研究面板 · RUNNING · step 2 · abcd1234 · 20s",
		"active 1 · done 1/3 · runs 2 · 66k tok",
		"✓ plan · completed → 研究",
		"● researcher · running · 10s · thinking: 正在分析实验数据与图表",
	];
	const panel = renderRuntimeBoardPanel(lines, 60, theme);

	assert.equal(panel.length, lines.length + 2);
	assert.match(panel[0], /^╭─ ◈ pi-graph · live board ─+╮$/);
	assert.ok(panel.at(-1)?.startsWith("╰") && panel.at(-1)?.endsWith("╯"));
	for (const line of panel) {
		assert.equal(visibleWidth(line), 60, `unaligned panel line: ${line}`);
	}
	for (const [index, line] of panel.slice(1, -1).entries()) {
		assert.ok(line.startsWith("│ ") && line.endsWith(" │"), `unframed row ${index}: ${line}`);
	}
	assert.ok(colors.includes("borderAccent"), "running board uses the accent border");
	assert.deepEqual(
		renderRuntimeBoardPanel(["pig · done · COMPLETED · step 3 · 12s"], 60, theme).filter((line) =>
			line.startsWith("╰"),
		).length,
		1,
	);
	assert.ok(colors.includes("borderMuted"), "settled board uses the muted border");
});

test("runtime board panel caps width and stays aligned for long streamed activity", () => {
	const theme: RuntimeBoardTheme = { fg: (_color, text) => text, bold: (text) => text };
	const lines = ["pig · wide · RUNNING · step 1 · 0s", `● worker · 0s · ${"x".repeat(300)}`];
	for (const width of [36, 60, 140, 300]) {
		const panel = renderRuntimeBoardPanel(lines, width, theme);
		const expected = Math.max(width, 36);
		for (const line of panel) {
			assert.equal(visibleWidth(line), expected, `unaligned at width ${width}: ${line}`);
		}
	}
});

test("interrupted human ask captures chat input, resumes, and holds the board", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-ask-capture-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const project = join(directory, "project");
		const graphDir = join(project, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "ask-capture.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "ask-capture",
				entry: "ask",
				nodes: {
					ask: { type: "human", kind: "input", prompt: "What is the answer?", output: "working.answer", pause: true },
					done: { type: "set", assign: [{ path: "result.answer", from: "working.answer" }] },
				},
				edges: [{ from: "ask", to: "done" }],
				policy: { allowNonInteractive: true },
			}),
			"utf8",
		);

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
		const tools = new Map<string, CapturedTool>();
		const pi = {
			registerTool(value: unknown) {
				const captured = value as CapturedTool;
				tools.set(captured.name, captured);
			},
			registerCommand() {},
			on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			appendEntry() {},
			registerEntryRenderer() {},
			getThinkingLevel: () => "off",
			getActiveTools: () => ["read", "bash", "edit", "write"],
		} as unknown as ExtensionAPI;
		piGraphExtension(pi);

		const widgets: Array<{ key: string; content: string[] | undefined }> = [];
		const statuses: Array<string | undefined> = [];
		const context = {
			cwd: project,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				setStatus(_key: string, value: string | undefined) {
					statuses.push(value);
				},
	setWidget(key: string, content: unknown) {
					if (typeof content === "function") {
						const component = (content as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
							null,
							identityTheme(),
						);
						widgets.push({ key, content: component.render(100) });
						return;
					}
					widgets.push({ key, content: content as string[] | undefined });
				},
				notify() {},
				confirm: async () => true,
			},
		};

		const runTool = tools.get("pi_graph_run");
		assert.ok(runTool);
		const runOutput = (await runTool.execute(
			"run",
			{ graph: "ask-capture", scope: "project", checkpoint: true, inputJson: "{}" },
			undefined,
			undefined,
			context,
		)) as { details: { result: { runId: string; status: string; interrupt?: { nodeId: string } } } };
		const runResult = runOutput.details.result;
		assert.equal(runResult.status, "interrupted");
		assert.equal(runResult.interrupt?.nodeId, "ask");
		// Board is held while waiting for the human answer.
		assert.notEqual(widgets.at(-1)?.content, undefined, "board widget must stay visible while paused");
		assert.ok(statuses.some((status) => status?.includes("⏸")), "status line shows paused hint");

		const inputHandler = handlers.get("input")?.[0];
		assert.ok(inputHandler, "input handler registered");
		// Slash commands are never captured.
		assert.deepEqual(await inputHandler({ text: "/pig skip", source: "interactive" }, context), undefined);
		// Free text is swallowed and routed into the graph.
		assert.deepEqual(await inputHandler({ text: "42", source: "interactive" }, context), { action: "handled" });

		const inspectTool = tools.get("pi_graph_inspect");
		assert.ok(inspectTool);
		let snapshotStatus = "";
		let lastInspectText = "";
		for (let attempt = 0; attempt < 100 && snapshotStatus !== "completed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			const inspection = (await inspectTool.execute("inspect", { runId: runResult.runId, view: "full" }, undefined, undefined, context)) as {
				content: Array<{ type: "text"; text: string }>;
				details: { checkpoint?: { status?: string } };
			};
			snapshotStatus = inspection.details.checkpoint?.status ?? "";
			lastInspectText = inspection.content[0]?.text ?? "";
			if (snapshotStatus === "completed") {
				assert.match(inspection.content[0]?.text ?? "", /"answer":\s*"42"/);
			}
		}
		assert.equal(snapshotStatus, "completed", "resumed run must complete with the captured answer");
		assert.match(lastInspectText, /"answer":\s*"42"/, "state must carry the captured answer");
		// The resumed run finishes: the board keeps its final snapshot (30s linger).
		for (let attempt = 0; attempt < 100 && !widgets.at(-1)?.content?.some((line) => line.includes("✓ done")); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(
			widgets.at(-1)?.content?.some((line) => line.includes("✓ done")),
			"final snapshot must linger after the resumed run completes",
		);
		// Session shutdown disposes the lingering board immediately.
		const shutdownHandler = handlers.get("session_shutdown")?.[0];
		assert.ok(shutdownHandler, "session_shutdown handler registered");
		await shutdownHandler(undefined, context);
		assert.deepEqual(widgets.at(-1), { key: "pi-graph-runtime", content: undefined });
		// After completion, free text is no longer captured.
		assert.deepEqual(await inputHandler({ text: "hello again", source: "interactive" }, context), undefined);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

function boardEvent(type: GraphRunEvent["type"], overrides: Partial<GraphRunEvent> = {}): GraphRunEvent {
	return { type, runId: "12345678-abcd", timestamp: new Date().toISOString(), ...overrides };
}

function boardGraphSource(name: string): GraphSource {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name,
		entry: "worker",
		nodes: { worker: { type: "agent", prompt: "work", readOnly: true } },
	};
	return { filePath: `/virtual/${name}.json`, scope: "user", compiled: compileGraph(definition) };
}

interface BoardCapture {
	ctx: ExtensionContext;
	widgets: Array<{ key: string; content: string[] | undefined }>;
	statuses: Array<string | undefined>;
}

function boardContext(): BoardCapture {
	const widgets: Array<{ key: string; content: string[] | undefined }> = [];
	const statuses: Array<string | undefined> = [];
	const ctx = {
		cwd: "/tmp",
		hasUI: true,
		isProjectTrusted: () => true,
		ui: {
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
			setWidget(key: string, content: unknown) {
				if (typeof content === "function") {
					const component = (content as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
						null,
						identityTheme(),
					);
					widgets.push({ key, content: component.render(100) });
					return;
				}
				widgets.push({ key, content: content as string[] | undefined });
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionContext, widgets, statuses };
}

test("board re-renders activity streams at most once per second", () => {
	mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	try {
		const { ctx, widgets, statuses } = boardContext();
		const disposers = new Set<() => void>();
		const progress = createRuntimeProgress(ctx, boardGraphSource("throttled"), undefined, disposers);
		progress.onEvent(boardEvent("node_start", { step: 1, nodeId: "worker", attempt: 1 }));
		const before = widgets.length;
		for (let index = 1; index <= 5; index++) {
			progress.onEvent(boardEvent("node_activity", { step: 1, nodeId: "worker", message: `doing ${index}` }));
		}
		assert.equal(widgets.length, before, "activity events must not re-render immediately");
		mock.timers.tick(1_000);
		assert.equal(widgets.length, before + 1, "exactly one throttled re-render per tick");
		assert.ok(widgets.at(-1)?.content?.some((line) => line.includes("doing 5")), "latest activity lands on the board");
		assert.ok(statuses.some((status) => status?.includes("doing 5")), "buffered status flushes on the tick");
		progress.clear();
	} finally {
		mock.timers.reset();
	}
});

test("finished runs keep the final snapshot for 30s then clear board and status", () => {
	mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	try {
		const { ctx, widgets, statuses } = boardContext();
		const disposers = new Set<() => void>();
		const progress = createRuntimeProgress(ctx, boardGraphSource("linger"), undefined, disposers);
		progress.onEvent(boardEvent("node_start", { step: 1, nodeId: "worker", attempt: 1 }));
		progress.onEvent(boardEvent("node_settled", { step: 1, nodeId: "worker", attempt: 1, status: "completed" }));
		progress.onEvent(boardEvent("node_end", { step: 1, nodeId: "worker", status: "completed" }));
		progress.onEvent(boardEvent("graph_end", { step: 1, status: "completed", message: "done" }));
		const widgetsAtFinish = widgets.length;
		progress.finish();
		assert.equal(widgets.length, widgetsAtFinish, "graph_end milestone already rendered the final frame");
		const snapshot = widgets.at(-1)?.content?.join("\n") ?? "";
		assert.ok(snapshot.includes("COMPLETED"));
		assert.ok(snapshot.includes("✓ worker"));
		assert.equal(statuses.at(-1), "linger: completed");
		mock.timers.tick(29_999);
		assert.notEqual(widgets.at(-1)?.content, undefined, "snapshot still on screen after 29.999s");
		mock.timers.tick(1);
		assert.deepEqual(widgets.at(-1), { key: "pi-graph-runtime", content: undefined });
		assert.equal(statuses.at(-1), undefined, "status line cleared with the board");
		assert.equal(disposers.size, 0, "disposer removed after linger expiry");
	} finally {
		mock.timers.reset();
	}
});

test("a new run cancels the previous run's lingering clear and keeps the new board", () => {
	mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	try {
		const { ctx, widgets } = boardContext();
		const disposers = new Set<() => void>();
		const first = createRuntimeProgress(ctx, boardGraphSource("first-graph"), undefined, disposers);
		first.onEvent(boardEvent("graph_end", { step: 1, status: "completed" }));
		first.finish();
		const second = createRuntimeProgress(ctx, boardGraphSource("second-graph"), undefined, disposers);
		assert.ok(widgets.at(-1)?.content?.some((line) => line.includes("second-graph")), "new board replaces the lingering one");
		mock.timers.tick(60_000);
		assert.notEqual(widgets.at(-1)?.content, undefined, "old linger timer must not clear the new board");
		assert.ok(widgets.at(-1)?.content?.some((line) => line.includes("second-graph")));
		first.clear();
		second.clear();
	} finally {
		mock.timers.reset();
	}
});

test("session shutdown disposes a lingering board immediately without a dangling timer", () => {
	mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	try {
		const { ctx, widgets, statuses } = boardContext();
		const disposers = new Set<() => void>();
		const progress = createRuntimeProgress(ctx, boardGraphSource("shutdown"), undefined, disposers);
		progress.onEvent(boardEvent("graph_end", { step: 1, status: "failed", message: "boom" }));
		progress.finish();
		for (const dispose of [...disposers]) dispose();
		assert.deepEqual(widgets.at(-1), { key: "pi-graph-runtime", content: undefined });
		assert.equal(statuses.at(-1), undefined);
		const count = widgets.length;
		mock.timers.tick(60_000);
		assert.equal(widgets.length, count, "linger timer must be cancelled by clear()");
	} finally {
		mock.timers.reset();
	}
});
