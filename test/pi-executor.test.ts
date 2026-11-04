import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCheckpointStore } from "../src/checkpoint.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import type {
	AgentRuntimeOutcome,
	AgentRuntimePrompt,
	NodeAgentRuntime,
} from "../src/pi-agent-runtime.ts";
import { PiNodeExecutor } from "../src/pi-executor.ts";
import type { AgentNodeDefinition, JsonValue, NodeExecutionContext, NodeUsage } from "../src/types.ts";
import { emptyUsage, getPath } from "../src/utils.ts";

interface RuntimeCall {
	node: AgentNodeDefinition;
	context: NodeExecutionContext;
	prompt: AgentRuntimePrompt;
}

type RuntimeHandler = (call: RuntimeCall, index: number) => AgentRuntimeOutcome | Promise<AgentRuntimeOutcome>;

class FakeAgentRuntime implements NodeAgentRuntime {
	readonly calls: RuntimeCall[] = [];
	private readonly handler: RuntimeHandler;

	constructor(handler: RuntimeHandler) {
		this.handler = handler;
	}

	invoke(node: AgentNodeDefinition, context: NodeExecutionContext, prompt: AgentRuntimePrompt): Promise<AgentRuntimeOutcome> {
		const call = { node, context, prompt };
		this.calls.push(call);
		return Promise.resolve(this.handler(call, this.calls.length));
	}
}

function usage(overrides: Partial<NodeUsage> = {}): NodeUsage {
	return { ...emptyUsage(), ...overrides };
}

function textOutcome(text: string, overrides: Partial<AgentRuntimeOutcome> = {}): AgentRuntimeOutcome {
	return {
		outputText: text,
		usage: usage({ inputTokens: 1, outputTokens: 1, turns: 1, model: "fake/model" }),
		messages: text ? [{ role: "assistant", content: text, name: null }] : [],
		stopReason: "stop",
		timedOut: false,
		aborted: false,
		structuredOutputSucceeded: false,
		...overrides,
	};
}

function structuredOutcome(value: JsonValue): AgentRuntimeOutcome {
	return textOutcome("", {
		structuredOutput: value,
		structuredOutputSucceeded: true,
		messages: [{ role: "tool", content: "Schema-validated node output recorded.", name: "pi_graph_node_output" }],
	});
}

test("Pi node executor delegates agent nodes to the injected in-process runtime", async () => {
	const runtime = new FakeAgentRuntime(({ prompt }) =>
		textOutcome(JSON.stringify({ approved: prompt.text.includes("ship") }), {
			usage: usage({
				inputTokens: 10,
				outputTokens: 4,
				cacheReadTokens: 1,
				costUsd: 0.002,
				turns: 1,
				model: "fake/model",
			}),
		}),
	);
	const graph = compileGraph({
		schemaVersion: 2,
		name: "fake-runtime",
		entry: "review",
		nodes: {
			review: {
				type: "agent",
				prompt: "Review {{input.task}}",
				systemPrompt: "Be exact.",
				readOnly: true,
				tools: [],
				output: "review",
				response: { format: "json" },
			},
		},
		limits: {
			maxSteps: 2,
			maxNodeRuns: 2,
			maxConcurrency: 1,
			maxCostUsd: 1,
			timeoutMs: 10000,
			maxStateBytes: 100000,
		},
	});
	const result = await new GraphEngine(graph, new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime })).run({
		input: { task: "ship it" },
		checkpoint: false,
	});
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(getPath(result.state, "review"), { approved: true });
	assert.equal(result.usage.inputTokens, 10);
	assert.equal(result.usage.outputTokens, 4);
	assert.equal(result.usage.cacheReadTokens, 1);
	assert.equal("costUsd" in result.usage, false);
	assert.equal(runtime.calls.length, 1);
	assert.match(runtime.calls[0]?.prompt.text ?? "", /Review ship it/);
	assert.equal(runtime.calls[0]?.prompt.systemPrompt, "Be exact.");
});

test("Pi node executor does not add a hidden graph system prompt", async () => {
	const runtime = new FakeAgentRuntime(() => textOutcome("done"));
	const graph = compileGraph({
		schemaVersion: 2,
		name: "no-hidden-system-prompt",
		entry: "review",
		nodes: {
			review: {
				type: "agent",
				purpose: "reviewer",
				description: "independent review",
				prompt: "Review the work",
				readOnly: true,
				tools: [],
			},
		},
	});
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(result.status, "completed", result.error);
	assert.equal(runtime.calls[0]?.prompt.systemPrompt, "");
});

test("schema response commits only the runtime's validated structured handoff", async () => {
	const runtime = new FakeAgentRuntime(() => structuredOutcome({ approved: true, issues: [] }));
	const graph = compileGraph({
		schemaVersion: 2,
		name: "schema-output",
		entry: "review",
		nodes: {
			review: {
				type: "agent",
				prompt: "Review the change",
				readOnly: true,
				tools: [],
				output: "handoff.review",
				response: {
					schema: {
						type: "object",
						properties: { approved: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
						required: ["approved", "issues"],
						additionalProperties: false,
					},
				},
			},
			consume: { type: "set", assign: [{ path: "result", from: "handoff.review" }] },
		},
		edges: [{ from: "review", to: "consume" }],
	});
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(getPath(result.state, "result"), { approved: true, issues: [] });
	assert.equal(runtime.calls[0]?.node.response?.schema !== undefined, true);
});

test("schema response rejects invalid structured data before committing the handoff", async () => {
	const runtime = new FakeAgentRuntime(() => structuredOutcome({ approved: "yes" }));
	const graph = compileGraph({
		schemaVersion: 2,
		name: "schema-invalid-output",
		entry: "review",
		nodes: {
			review: {
				type: "agent",
				prompt: "Review",
				readOnly: true,
				tools: [],
				output: "handoff.review",
				response: {
					schema: {
						type: "object",
						properties: { approved: { type: "boolean" } },
						required: ["approved"],
						additionalProperties: false,
					},
				},
			},
		},
	});
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /Schema validation failed.*approved.*boolean/);
	assert.equal(getPath(result.state, "handoff.review"), undefined);
});

test("shared context appends messages to graph state and injects them into the next node", async () => {
	const runtime = new FakeAgentRuntime(({ prompt }, index) => {
		if (index === 1) return textOutcome("first-response");
		const occurrences = prompt.text.split("first-response").length - 1;
		return textOutcome(occurrences === 1 ? "saw-first-response-once" : `duplicate-count-${occurrences}`);
	});
	const graph = compileGraph({
		schemaVersion: 2,
		name: "shared-history",
		entry: "first",
		nodes: {
			first: {
				type: "agent",
				prompt: "first instruction",
				readOnly: true,
				tools: [],
				output: "outputs.first",
				context: { mode: "shared", messagesPath: "conversation.messages" },
			},
			second: {
				type: "agent",
				prompt: "second instruction",
				readOnly: true,
				tools: [],
				output: "outputs.second",
				reads: ["outputs.first"],
				context: { mode: "shared", messagesPath: "conversation.messages" },
			},
		},
		edges: [{ from: "first", to: "second" }],
	});
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(result.status, "completed", result.error);
	assert.equal(getPath(result.state, "outputs.second"), "saw-first-response-once");
	const messages = getPath(result.state, "conversation.messages") as Array<Record<string, unknown>>;
	assert.deepEqual(
		messages.map((message) => [message.role, message.statePath]),
		[
			["assistant", "outputs.first"],
			["assistant", "outputs.second"],
		],
	);
	assert.ok(messages.every((message) => typeof message.content === "string" && !message.content.includes("first-response")));
	assert.ok(messages.every((message) => typeof message.stateHash === "string" && message.stateHash.length === 64));
});

test("compact shared references do not replay a newer value as historical output", async () => {
	const runtime = new FakeAgentRuntime(({ prompt }, index) => {
		if (index === 1) return textOutcome("old-value");
		if (index === 2) return textOutcome("new-value");
		return textOutcome(
			JSON.stringify({
				oldCount: prompt.text.split("old-value").length - 1,
				newCount: prompt.text.split("new-value").length - 1,
				overwrittenMarker: prompt.text.includes("state path was overwritten"),
			}),
		);
	});
	const graph = compileGraph({
		schemaVersion: 2,
		name: "shared-reference-integrity",
		entry: "first",
		nodes: {
			first: {
				type: "agent",
				prompt: "first",
				readOnly: true,
				tools: [],
				output: "shared.latest",
				context: { mode: "shared", messagesPath: "conversation.messages" },
			},
			second: {
				type: "agent",
				prompt: "second",
				readOnly: true,
				tools: [],
				output: "shared.latest",
				context: { mode: "shared", messagesPath: "conversation.messages" },
			},
			observer: {
				type: "agent",
				prompt: "observe",
				readOnly: true,
				tools: [],
				output: "result.observation",
				response: { format: "json" },
				context: { mode: "shared", messagesPath: "conversation.messages", capture: "none" },
			},
		},
		edges: [
			{ from: "first", to: "second" },
			{ from: "second", to: "observer" },
		],
	});
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(getPath(result.state, "result.observation"), {
		oldCount: 0,
		newCount: 1,
		overwrittenMarker: true,
	});
});

test("shared message retention prunes the durable channel after each commit", async () => {
	const runtime = new FakeAgentRuntime((_call, index) => textOutcome(`turn-${index}`));
	const graph = compileGraph({
		schemaVersion: 2,
		name: "shared-retention",
		entry: "worker",
		nodes: {
			worker: {
				type: "agent",
				prompt: "continue",
				readOnly: true,
				tools: [],
				response: { storeOutput: false },
				context: {
					mode: "shared",
					messagesPath: "conversation.messages",
					capture: "assistant-only",
					maxStoredMessages: 2,
				},
			},
		},
		edges: [{ from: "worker", to: "worker" }],
		limits: {
			maxSteps: 4,
			maxNodeRuns: 8,
			maxConcurrency: 1,
			maxCostUsd: 1,
			timeoutMs: 10000,
			maxStateBytes: 100000,
		},
	});
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	const messages = getPath(result.state, "conversation.messages") as Array<Record<string, unknown>>;
	assert.deepEqual(messages.map((message) => message.content), ["turn-3", "turn-4"]);
});

test("shared assistant-only capture can be the canonical output without duplicating a node output path", async () => {
	const runtime = new FakeAgentRuntime(() => textOutcome("only-copy"));
	const graph = compileGraph({
		schemaVersion: 2,
		name: "shared-canonical",
		entry: "debater",
		nodes: {
			debater: {
				type: "agent",
				prompt: "debate",
				readOnly: true,
				tools: [],
				response: { storeOutput: false },
				context: { mode: "shared", messagesPath: "debate.messages", capture: "assistant-only" },
			},
		},
	});
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(getPath(result.state, "outputs.debater"), undefined);
	assert.deepEqual(
		(getPath(result.state, "debate.messages") as Array<Record<string, unknown>>).map((message) => message.content),
		["only-copy"],
	);
});

test("prompt construction omits reads already interpolated by the template", async () => {
	const runtime = new FakeAgentRuntime(({ prompt }) =>
		textOutcome(String(prompt.text.split("UNIQUE-EVIDENCE").length - 1)),
	);
	const graph = compileGraph({
		schemaVersion: 2,
		name: "prompt-dedupe",
		entry: "worker",
		initialState: { evidence: "UNIQUE-EVIDENCE" },
		nodes: {
			worker: {
				type: "agent",
				prompt: "Evidence={{evidence}}",
				reads: ["evidence"],
				readOnly: true,
				tools: [],
				output: "count",
			},
		},
	});
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(getPath(result.state, "count"), "1");
});

test("prompt byte budgets fail before invoking the agent runtime", async () => {
	const runtime = new FakeAgentRuntime(() => textOutcome("should-not-run"));
	const graph = compileGraph({
		schemaVersion: 2,
		name: "prompt-budget",
		entry: "worker",
		initialState: { evidence: "x".repeat(2000) },
		nodes: {
			worker: {
				type: "agent",
				prompt: "Review",
				reads: ["evidence"],
				readOnly: true,
				tools: [],
				limits: { maxPromptBytes: 510 },
			},
		},
	});
	assert.deepEqual(graph.definition.nodes.worker.limits, { maxPromptBytes: 510 });
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /maxPromptBytes/);
	assert.equal(runtime.calls.length, 0);
});

test("artifact response storage keeps full output out of graph state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-artifact-"));
	try {
		const report = `# Report\n\n${"evidence ".repeat(1000)}`;
		const runtime = new FakeAgentRuntime(() => textOutcome(report));
		const graph = compileGraph({
			schemaVersion: 2,
			name: "artifact-output",
			entry: "reporter",
			nodes: {
				reporter: {
					type: "agent",
					prompt: "report",
					readOnly: true,
					tools: [],
					output: "result.report",
					response: { storage: "artifact", mediaType: "text/markdown", previewBytes: 64, maxBytes: 20000 },
				},
			},
			result: { paths: ["result.report"] },
		});
		const artifactsDir = join(directory, "artifacts");
		const result = await new GraphEngine(
			graph,
			new PiNodeExecutor({ cwd: directory, hasUI: false, agentRuntime: runtime, artifactsDir }),
		).run({ checkpoint: false });
		const reference = getPath(result.state, "result.report") as Record<string, unknown>;
		assert.equal(reference.kind, "artifact");
		assert.equal(reference.bytes, Buffer.byteLength(report, "utf8"));
		assert.equal(await readFile(String(reference.uri), "utf8"), report);
		assert.ok(Buffer.byteLength(JSON.stringify(result.state), "utf8") < 1000);
		assert.deepEqual(result.result, { result: { report: reference } });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

class DurableThreadFakeRuntime implements NodeAgentRuntime {
	readonly calls: RuntimeCall[] = [];
	private readonly sessions: Map<string, number>;

	constructor(sessions: Map<string, number>) {
		this.sessions = sessions;
	}

	invoke(node: AgentNodeDefinition, context: NodeExecutionContext, prompt: AgentRuntimePrompt): Promise<AgentRuntimeOutcome> {
		this.calls.push({ node, context, prompt });
		if (!context.thread) return Promise.resolve(textOutcome("missing-thread-metadata", { runtimeError: "missing thread metadata" }));
		const key = `${context.runId}/${context.thread.sessionId}`;
		const prior = this.sessions.get(key);
		if (context.thread.invocationCount > 0 && prior === undefined) {
			return Promise.resolve(
				textOutcome("", {
					runtimeError: `Durable Pi session for thread ${JSON.stringify(context.thread.key)} is missing. Refusing to silently reset private agent memory.`,
				}),
			);
		}
		const count = (prior ?? 0) + 1;
		this.sessions.set(key, count);
		return Promise.resolve(textOutcome(`thread-turn-${count}`));
	}
}

test("thread context resumes the same private agent session identity after a graph interrupt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-thread-"));
	try {
		const store = new FileCheckpointStore(join(directory, "checkpoints"));
		const sessions = new Map<string, number>();
		const graph = compileGraph({
			schemaVersion: 2,
			name: "thread-resume",
			entry: "first",
			nodes: {
				first: {
					type: "agent",
					prompt: "first",
					readOnly: true,
					tools: [],
					output: "outputs.first",
					context: { mode: "thread", threadKey: "coder" },
				},
				approval: { type: "human", kind: "confirm", prompt: "continue?", output: "approved", pause: true },
				second: {
					type: "agent",
					prompt: "second",
					readOnly: true,
					tools: [],
					output: "outputs.second",
					context: { mode: "thread", threadKey: "coder" },
				},
			},
			edges: [
				{ from: "first", to: "approval" },
				{ from: "approval", to: "second" },
			],
			limits: {
				maxSteps: 4,
				maxNodeRuns: 4,
				maxConcurrency: 1,
				maxCostUsd: 1,
				maxStateBytes: 100000,
			},
		});
		const interrupted = await new GraphEngine(
			graph,
			new PiNodeExecutor({ cwd: directory, hasUI: false, agentRuntime: new DurableThreadFakeRuntime(sessions) }),
			{ checkpointStore: store },
		).run({ checkpoint: true });
		assert.equal(interrupted.status, "interrupted");
		assert.equal(getPath(interrupted.state, "outputs.first"), "thread-turn-1");

		const resumed = await new GraphEngine(
			graph,
			new PiNodeExecutor({ cwd: directory, hasUI: false, agentRuntime: new DurableThreadFakeRuntime(sessions) }),
			{ checkpointStore: store },
		).run({ runId: interrupted.runId, resumeValue: true, checkpoint: true });
		assert.equal(resumed.status, "completed", resumed.error);
		assert.equal(getPath(resumed.state, "outputs.second"), "thread-turn-2");
		const { snapshot } = await store.load(interrupted.runId);
		assert.equal(snapshot.threads?.coder?.nodes.includes("first"), true);
		assert.equal(snapshot.threads?.coder?.nodes.includes("second"), true);
		assert.match(snapshot.threads?.coder?.sessionId ?? "", /^[0-9a-f-]{36}$/i);
		assert.equal(snapshot.threads?.coder?.invocationCount, 2);
		assert.equal(snapshot.threads?.coder?.lastNodeId, "second");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("thread context refuses to silently reset a missing private session", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-thread-missing-"));
	try {
		const store = new FileCheckpointStore(join(directory, "checkpoints"));
		const sessions = new Map<string, number>();
		const graph = compileGraph({
			schemaVersion: 2,
			name: "thread-missing",
			entry: "worker",
			nodes: {
				worker: {
					type: "agent",
					prompt: "work",
					readOnly: true,
					tools: [],
					output: "result",
					context: { mode: "thread" },
				},
				approval: { type: "human", kind: "confirm", prompt: "continue?", pause: true },
				second: {
					type: "agent",
					prompt: "continue work",
					readOnly: true,
					tools: [],
					output: "secondResult",
					context: { mode: "thread", threadKey: "worker" },
				},
			},
			edges: [
				{ from: "worker", to: "approval" },
				{ from: "approval", to: "second" },
			],
			limits: {
				maxSteps: 4,
				maxNodeRuns: 4,
				maxConcurrency: 1,
				maxCostUsd: 1,
				maxStateBytes: 100000,
			},
		});
		const executor = new PiNodeExecutor({
			cwd: directory,
			hasUI: false,
			agentRuntime: new DurableThreadFakeRuntime(sessions),
		});
		const interrupted = await new GraphEngine(graph, executor, { checkpointStore: store }).run({ checkpoint: true });
		assert.equal(interrupted.status, "interrupted");
		sessions.clear();

		const failed = await new GraphEngine(graph, executor, { checkpointStore: store }).run({
			runId: interrupted.runId,
			resumeValue: true,
			checkpoint: true,
		});
		assert.equal(failed.status, "failed");
		assert.match(failed.error ?? "", /missing|silently reset/i);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared context rejects malformed message state without invoking the agent runtime", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "shared-invalid-state",
		entry: "worker",
		initialState: { conversation: { messages: { invalid: true } } },
		nodes: {
			worker: {
				type: "agent",
				prompt: "work",
				readOnly: true,
				tools: [],
				context: { mode: "shared", messagesPath: "conversation.messages" },
				retry: { maxAttempts: 2 },
				idempotent: true,
			},
		},
		limits: {
			maxSteps: 2,
			maxNodeRuns: 3,
			maxConcurrency: 1,
			maxCostUsd: 1,
			timeoutMs: 10000,
			maxStateBytes: 100000,
		},
	});
	const runtime = new FakeAgentRuntime(() => textOutcome("should-not-run"));
	const result = await new GraphEngine(
		graph,
		new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, agentRuntime: runtime }),
	).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /must be an array/);
	assert.equal(result.nodeRuns, 1);
	assert.equal(runtime.calls.length, 0);
});
