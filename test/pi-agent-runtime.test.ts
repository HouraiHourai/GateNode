import assert from "node:assert/strict";
import { ChildProcess, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { compileGraph } from "../src/compile.ts";
import { InProcessPiAgentRuntime } from "../src/pi-agent-runtime.ts";
import type {
	AgentNodeDefinition,
	AgentThreadState,
	ExecutionBudget,
	NodeExecutionContext,
	NodeLimits,
	UsageLedger,
} from "../src/types.ts";
import { addUsage, emptyUsage, hashJson } from "../src/utils.ts";

const OUTPUT_TOOL = "pi_graph_node_output";
const GIT_DIFF_TOOL = "pi_graph_git_diff";
let fixtureSequence = 0;

test("production runtime executes text agents in-process and reports usage", async (testContext) => {
	const childProcessPrototype = ChildProcess.prototype as ChildProcess & {
		spawn(options: unknown): boolean;
	};
	const spawn = testContext.mock.method(childProcessPrototype, "spawn", () => {
		throw new Error("The in-process runtime must not spawn a child process");
	});

	await withRuntime("text", async ({ faux, model, runtime }) => {
		faux.setResponses([fauxAssistantMessage("offline in-process answer", { timestamp: 1 })]);
		const node = agentNode(model);
		const budget = new RecordingBudget();
		const outcome = await runtime.invoke(node, executionContext(node, budget), {
			text: "Return the offline answer.",
			systemPrompt: "This is an offline integration test.",
		});

		assert.equal(outcome.runtimeError, undefined);
		assert.equal(outcome.outputText, "offline in-process answer");
		assert.deepEqual(outcome.messages, [
			{ role: "assistant", content: "offline in-process answer", name: null },
		]);
		assert.equal(outcome.usage.model, "offline");
		assert.equal(outcome.usage.turns, 1);
		assert.ok(outcome.usage.inputTokens > 0);
		assert.ok(outcome.usage.outputTokens > 0);
		assert.equal(budget.usage.inputTokens, outcome.usage.inputTokens);
		assert.equal(budget.usage.outputTokens, outcome.usage.outputTokens);
		assert.equal(budget.usage.turns, 1);
		assert.equal(faux.state.callCount, 1);
	});

	assert.equal(spawn.mock.callCount(), 0, "createAgentSession path must not launch a Pi child process");
});

test("durable isolated turns rebuild a completed outcome without another model call", async () => {
	await withRuntime("durable-isolated", async ({ faux, model, runtime, runtimeOptions, threadSessionsDir }) => {
		faux.setResponses([fauxAssistantMessage("durable answer", { timestamp: 41 })]);
		const node = agentNode(model);
		const budget = new RecordingBudget();
		const context = executionContext(node, budget);
		context.attempt = 1;
		context.executionId = "pig:durable-isolated:1:agent:1";
		const seen = new Set<string>();
		context.recordTurn = async (turn) => {
			const sessionDirectory = join(threadSessionsDir, context.runId, "attempts");
			const files = await readdir(sessionDirectory);
			assert.equal(files.length, 1);
			assert.match(await readFile(join(sessionDirectory, files[0]), "utf8"), /durable answer/);
			if (seen.has(turn.id)) return;
			seen.add(turn.id);
			budget.report(turn.usage);
		};

		const first = await runtime.invoke(node, context, { text: "answer once", systemPrompt: "" });
		assert.equal(first.outputText, "durable answer");
		assert.equal(budget.usage.turns, 1);
		assert.equal(faux.state.callCount, 1);

		const restarted = new InProcessPiAgentRuntime(runtimeOptions);
		const recovered = await restarted.invoke(node, context, { text: "must not be repeated", systemPrompt: "" });
		assert.equal(recovered.outputText, "durable answer");
		assert.equal(budget.usage.turns, 1);
		assert.equal(faux.state.callCount, 1);
	});
});

test("recovery replays a persisted unfinished bash call", async () => {
	await withRuntime("durable-bash", async ({ faux, model, runtime, runtimeOptions, threadSessionsDir }) => {
		const node = agentNode(model, { tools: ["bash"], readOnly: false });
		const context = executionContext(node, new RecordingBudget());
		context.attempt = 1;
		context.executionId = "pig:durable-bash:1:agent:1";
		const sessionDirectory = join(threadSessionsDir, context.runId, "attempts");
		await mkdir(sessionDirectory, { recursive: true });
		const digest = hashJson(context.executionId).slice(0, 16);
		const sessionFile = join(sessionDirectory, `${context.step}-${context.nodeId}-1-${digest}.jsonl`);
		await writeFile(sessionFile, "", { mode: 0o600 });
		const manager = SessionManager.open(sessionFile, sessionDirectory, runtimeOptions.cwd);
		manager.appendCustomEntry("pi-graph-invocation", { executionId: context.executionId });
		manager.appendMessage(fauxAssistantMessage(
			fauxToolCall("bash", {
				command: "printf x >> effect.log",
			}, { id: "stable-bash-call" }),
			{ stopReason: "toolUse", timestamp: 77 },
		));
		const seen = new Set<string>();
		context.recordTurn = async (turn) => {
			if (seen.has(turn.id)) return;
			seen.add(turn.id);
			context.budget.report(turn.usage);
		};
		faux.setResponses([fauxAssistantMessage("recovered after bash")]);

		const outcome = await runtime.invoke(node, context, { text: "must not be re-prompted", systemPrompt: "" });
		assert.equal(outcome.runtimeError, undefined);
		assert.equal(outcome.outputText, "recovered after bash");
		assert.equal(await readFile(join(runtimeOptions.cwd, "effect.log"), "utf8"), "x");
		assert.equal(context.budget.usage.turns, 2);
		assert.equal(faux.state.callCount, 1);
	});
});

test("in-process runtime streams live node activity through context.onEvent", async () => {
	await withRuntime("live-activity", async ({ faux, model, runtime }) => {
		const longText = `Analyzing the repository now.\nFirst finding appears here.\nSecond line of the streaming narration ${"x".repeat(2000)}`;
		faux.setResponses([
			fauxAssistantMessage(longText, { stopReason: "stop", timestamp: 1 }),
		]);
		const node = agentNode(model);
		const context = executionContext(node);
		context.attempt = 1;
		const activities: Array<{ type: string; nodeId?: string; step?: number; message?: string }> = [];
		context.onEvent = (event) => {
			if (event.type === "node_activity") activities.push(event);
		};

		const outcome = await runtime.invoke(node, context, {
			text: "Stream a long answer.",
			systemPrompt: "",
		});

		assert.equal(outcome.runtimeError, undefined);
		assert.ok(activities.length > 0, "at least the message_start activity must be published");
		assert.ok(activities.every((event) => event.nodeId === "agent" && event.step === 0));
		assert.ok(activities.some((event) => event.message === "thinking…"), "message_start publishes an immediate thinking marker");
	});
});

test("in-process runtime publishes tool invocations as node activity", async () => {
	await withRuntime("tool-activity", async ({ faux, model, runtime }) => {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(OUTPUT_TOOL, { data: { answer: 42 } }, { id: "output-call" }),
				{ stopReason: "toolUse", timestamp: 1 },
			),
		]);
		const node = agentNode(model, {
			response: {
				schema: {
					type: "object",
					properties: { answer: { type: "integer" } },
					required: ["answer"],
					additionalProperties: false,
				},
			},
		});
		const context = executionContext(node);
		const activities: string[] = [];
		context.onEvent = (event) => {
			if (event.type === "node_activity" && event.message) activities.push(event.message);
		};

		const outcome = await runtime.invoke(node, context, {
			text: "Submit an integer answer.",
			systemPrompt: "",
		});

		assert.equal(outcome.runtimeError, undefined);
		assert.equal(outcome.structuredOutputSucceeded, true);
		assert.ok(
			activities.some((message) => message.startsWith(`pi_graph_node_output(`)),
			"tool_execution_start must publish a compact live preview of the call",
		);
	});
});

test("structured output rejects an invalid call and terminates on the first schema-valid call", async () => {
	await withRuntime("structured", async ({ faux, model, runtime }) => {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(OUTPUT_TOOL, { data: { answer: "not-an-integer" } }, { id: "invalid-output" }),
				{ stopReason: "toolUse", timestamp: 1 },
			),
			fauxAssistantMessage(
				fauxToolCall(OUTPUT_TOOL, { data: { answer: 42 } }, { id: "valid-output" }),
				{ stopReason: "toolUse", timestamp: 2 },
			),
		]);
		const node = agentNode(model, {
			response: {
				schema: {
					type: "object",
					properties: { answer: { type: "integer" } },
					required: ["answer"],
					additionalProperties: false,
				},
			},
		});
		const outcome = await runtime.invoke(node, executionContext(node), {
			text: "Submit an integer answer.",
			systemPrompt: "Use the node output tool.",
		});

		assert.equal(outcome.runtimeError, undefined);
		assert.equal(outcome.structuredOutputSucceeded, true);
		assert.deepEqual(outcome.structuredOutput, { answer: 42 });
		assert.equal(outcome.usage.turns, 2);
		assert.equal(faux.state.callCount, 2, "terminate: true must prevent a third model turn");
		assert.equal(faux.getPendingResponseCount(), 0);
		assert.ok(
			outcome.messages.some(
				(message) => message.role === "tool" && /integer|schema|valid/i.test(message.content),
			),
			"the transcript should retain evidence that tool output was schema-checked",
		);
	});
});

test("concurrent structured nodes keep incompatible schemas invocation-local", async () => {
	await withRuntime("concurrent", async ({ faux, model, runtime }) => {
		const responseForPrompt = (context: Context) => {
			const transcript = JSON.stringify(context.messages);
			return transcript.includes("alpha request")
				? fauxAssistantMessage(
					fauxToolCall(OUTPUT_TOOL, { data: { kind: "alpha", count: 3 } }),
					{ stopReason: "toolUse" },
				)
				: fauxAssistantMessage(
					fauxToolCall(OUTPUT_TOOL, { data: ["beta", "result"] }),
					{ stopReason: "toolUse" },
				);
		};
		faux.setResponses([responseForPrompt, responseForPrompt]);

		const alpha = agentNode(model, {
			response: {
				schema: {
					type: "object",
					properties: {
						kind: { const: "alpha" },
						count: { type: "integer" },
					},
					required: ["kind", "count"],
					additionalProperties: false,
				},
			},
		});
		const beta = agentNode(model, {
			response: {
				schema: { type: "array", items: { type: "string" }, minItems: 2 },
			},
		});

		const environmentKey = "PI_GRAPH_NODE_OUTPUT_SCHEMA_FILE";
		const hadEnvironmentValue = Object.hasOwn(process.env, environmentKey);
		const previousEnvironmentValue = process.env[environmentKey];
		process.env[environmentKey] = "/poisoned/legacy/schema-path.json";
		try {
			const [alphaOutcome, betaOutcome] = await Promise.all([
				runtime.invoke(alpha, executionContext(alpha, undefined, "alpha"), {
					text: "alpha request",
					systemPrompt: "Return the alpha object.",
				}),
				runtime.invoke(beta, executionContext(beta, undefined, "beta"), {
					text: "beta request",
					systemPrompt: "Return the beta array.",
				}),
			]);

			assert.equal(alphaOutcome.runtimeError, undefined);
			assert.equal(betaOutcome.runtimeError, undefined);
			assert.equal(alphaOutcome.structuredOutputSucceeded, true);
			assert.equal(betaOutcome.structuredOutputSucceeded, true);
			assert.deepEqual(alphaOutcome.structuredOutput, { kind: "alpha", count: 3 });
			assert.deepEqual(betaOutcome.structuredOutput, ["beta", "result"]);
			assert.equal(faux.state.callCount, 2);
			assert.equal(process.env[environmentKey], "/poisoned/legacy/schema-path.json");
		} finally {
			if (hadEnvironmentValue) process.env[environmentKey] = previousEnvironmentValue;
			else delete process.env[environmentKey];
		}
	});
});

test("thread mode reopens private history in a new in-process runtime", async () => {
	await withRuntime("thread", async ({ faux, model, runtime, runtimeOptions, threadSessionsDir }) => {
		faux.setResponses([
			fauxAssistantMessage("first private answer"),
			(context) => {
				assert.match(JSON.stringify(context.messages), /first private answer/);
				return fauxAssistantMessage("reopened private history");
			},
		]);
		const node = agentNode(model, { context: { mode: "thread", threadKey: "researcher" } });
		const timestamp = new Date().toISOString();
		const thread: AgentThreadState = {
			key: "researcher",
			sessionId: "11111111-1111-4111-8111-111111111111",
			createdAt: timestamp,
			updatedAt: timestamp,
			nodes: ["agent"],
			invocationCount: 0,
		};
		const firstContext = executionContext(node);
		firstContext.thread = thread;
		const first = await runtime.invoke(node, firstContext, {
			text: "first thread request",
			systemPrompt: "Keep private thread context.",
		});
		assert.equal(first.runtimeError, undefined);
		assert.equal(first.outputText, "first private answer");

		thread.invocationCount = 1;
		const restartedRuntime = new InProcessPiAgentRuntime(runtimeOptions);
		const secondContext = executionContext(node);
		secondContext.thread = thread;
		const second = await restartedRuntime.invoke(node, secondContext, {
			text: "second thread request",
			systemPrompt: "Keep private thread context.",
		});
		assert.equal(second.runtimeError, undefined);
		assert.equal(second.outputText, "reopened private history");
		assert.equal(faux.state.callCount, 2);

		const sessionFile = join(threadSessionsDir, firstContext.runId, `${thread.sessionId}.jsonl`);
		assert.match(await readFile(sessionFile, "utf8"), /first private answer/);
		if (process.platform !== "win32") assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
	});
});

test("thread mode reports a stable error code instead of silently resetting missing history", async () => {
	await withRuntime("thread-missing", async ({ faux, model, runtime }) => {
		const node = agentNode(model, { context: { mode: "thread", threadKey: "researcher" } });
		const timestamp = new Date().toISOString();
		const context = executionContext(node);
		context.thread = {
			key: "researcher",
			sessionId: "22222222-2222-4222-8222-222222222222",
			createdAt: timestamp,
			updatedAt: timestamp,
			nodes: ["agent"],
			invocationCount: 1,
		};
		const outcome = await runtime.invoke(node, context, {
			text: "must not run",
			systemPrompt: "must not run",
		});
		assert.equal(outcome.runtimeErrorCode, "THREAD_SESSION_MISSING");
		assert.match(outcome.runtimeError ?? "", /Refusing to silently reset/);
		assert.equal(faux.state.callCount, 0);
	});
});

test("runtime inherits the parent model and thinking level until the node overrides them", async () => {
	await withRuntime("parent-profile", async ({ faux, model, runtimeOptions }) => {
		const parentModel = faux.getModel("parent");
		assert.ok(parentModel);
		const runtime = new InProcessPiAgentRuntime({
			...runtimeOptions,
			model: parentModel,
			thinkingLevel: "high",
		});
		const inheritedNode = agentNode(model, { model: undefined, thinking: undefined });
		faux.setResponses([
			(_context, options, _state, selectedModel) => {
				assert.equal(selectedModel.id, "parent");
				assert.equal((options as { reasoning?: string } | undefined)?.reasoning, "high");
				return fauxAssistantMessage("used parent profile");
			},
		]);
		const inherited = await runtime.invoke(inheritedNode, executionContext(inheritedNode), {
			text: "Use the parent profile.",
			systemPrompt: "",
		});
		assert.equal(inherited.outputText, "used parent profile");

		const explicitNode = agentNode(model);
		faux.setResponses([
			(_context, options, _state, selectedModel) => {
				assert.equal(selectedModel.id, "offline");
				assert.equal((options as { reasoning?: string } | undefined)?.reasoning, undefined);
				return fauxAssistantMessage("used node profile");
			},
		]);
		const explicit = await runtime.invoke(explicitNode, executionContext(explicitNode), {
			text: "Use the node profile.",
			systemPrompt: "",
		});
		assert.equal(explicit.outputText, "used node profile");
	});
});

test("runtime inherits direct Pi resource defaults and explicit false opts out", async () => {
	await withRuntime("resource-defaults", async ({ faux, model, runtime, runtimeOptions }) => {
		const marker = `__piGraphResourceParity_${process.pid}_${fixtureSequence++}`;
		const globalState = globalThis as typeof globalThis & Record<string, number | undefined>;
		const agentDir = runtimeOptions.agentDir;
		assert.ok(agentDir);
		try {
			await mkdir(join(agentDir, "extensions"), { recursive: true });
			await mkdir(join(agentDir, "skills"), { recursive: true });
			await mkdir(join(agentDir, "prompts"), { recursive: true });
			await writeFile(
				join(agentDir, "extensions", "parity.ts"),
				`globalThis[${JSON.stringify(marker)}] = (globalThis[${JSON.stringify(marker)}] ?? 0) + 1;\nexport default function() {}`,
				"utf8",
			);
			await writeFile(
				join(agentDir, "skills", "parity.md"),
				"---\nname: resource-parity\ndescription: resource parity skill\n---\nUse only for this test.\n",
				"utf8",
			);
			await writeFile(
				join(agentDir, "prompts", "parity.md"),
				"expanded-template $1\n",
				"utf8",
			);

			const inheritedNode = agentNode(model, {
				prompt: "/parity value",
				tools: undefined,
				loadExtensions: undefined,
				loadSkills: undefined,
				loadPromptTemplates: undefined,
			});
			faux.setResponses([
				(context) => {
					assert.match(context.systemPrompt ?? "", /resource-parity/);
					assert.match(JSON.stringify(context.messages), /expanded-template value/);
					return fauxAssistantMessage("inherited resources");
				},
			]);
			const inherited = await runtime.invoke(inheritedNode, executionContext(inheritedNode), {
				text: inheritedNode.prompt,
				systemPrompt: "",
			});
			assert.equal(inherited.outputText, "inherited resources");
			assert.equal(globalState[marker], 1, "the default extension should be initialized");

			const disabledNode = agentNode(model, {
				prompt: "/parity value",
				tools: undefined,
				loadExtensions: false,
				loadSkills: false,
				loadPromptTemplates: false,
			});
			faux.setResponses([
				(context) => {
					assert.doesNotMatch(context.systemPrompt ?? "", /resource-parity/);
					assert.match(JSON.stringify(context.messages), /\/parity value/);
					assert.doesNotMatch(JSON.stringify(context.messages), /expanded-template/);
					return fauxAssistantMessage("disabled resources");
				},
			]);
			const disabled = await runtime.invoke(disabledNode, executionContext(disabledNode), {
				text: disabledNode.prompt,
				systemPrompt: "",
			});
			assert.equal(disabled.runtimeError, undefined);
			assert.equal(disabled.errorMessage, undefined);
			assert.equal(disabled.outputText, "disabled resources");
			assert.equal(globalState[marker], 1, "explicit false must prevent extension initialization");
		} finally {
			delete globalState[marker];
		}
	});
});

test("runtime consumes the parent Pi child-session profile", async () => {
	await withRuntime("child-profile", async ({ faux, runtimeOptions }) => {
		const parentModel = faux.getModel("parent");
		assert.ok(parentModel);
		const runtime = new InProcessPiAgentRuntime({
			...runtimeOptions,
			modelRuntime: undefined,
			parentProfile: {
				modelRuntime: runtimeOptions.modelRuntime!,
				model: parentModel,
				thinkingLevel: "high",
				scopedModels: [{ model: parentModel, thinkingLevel: "high" }],
				activeTools: ["read", "grep", "write", "pi_graph_run"],
				extensionFlagValues: new Map(),
				resources: {
					additionalExtensionPaths: [],
					additionalSkillPaths: [],
					additionalPromptTemplatePaths: [],
					additionalThemePaths: [],
					extensionFactories: [],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					appendSystemPrompt: ["parent append marker"],
				},
			},
		});
		const node = agentNode("unused", {
			model: undefined,
			thinking: undefined,
			tools: undefined,
			readOnly: false,
			loadExtensions: undefined,
			loadSkills: undefined,
			loadPromptTemplates: undefined,
			includeContextFiles: undefined,
		});
		faux.setResponses([
			(context, options, _state, selectedModel) => {
				assert.equal(selectedModel, parentModel);
				assert.equal((options as { reasoning?: string } | undefined)?.reasoning, "high");
				assert.deepEqual(context.tools?.map((tool) => tool.name).sort(), ["grep", "read", "write"]);
				assert.match(context.systemPrompt ?? "", /parent append marker/);
				return fauxAssistantMessage("matched parent profile");
			},
		]);

		const outcome = await runtime.invoke(node, executionContext(node), { text: "parity", systemPrompt: "" });
		assert.equal(outcome.outputText, "matched parent profile");
	});
});

test("runtime inherits outer active tools only for non-read-only nodes without tools", async () => {
	await withRuntime("active-tools", async ({ faux, model, runtimeOptions }) => {
		const runtime = new InProcessPiAgentRuntime({
			...runtimeOptions,
			activeTools: ["read", "grep", "write", "pi_graph_run"],
		});
		const inheritedNode = agentNode(model, { readOnly: false, tools: undefined });
		faux.setResponses([
			(context) => {
				assert.deepEqual(
					context.tools?.map((tool) => tool.name).sort(),
					["grep", "read", "write"],
				);
				return fauxAssistantMessage("inherited tools");
			},
		]);
		await runtime.invoke(inheritedNode, executionContext(inheritedNode), {
			text: "Use inherited tools.",
			systemPrompt: "",
		});

		const explicitNode = agentNode(model, { readOnly: false, tools: ["ls"] });
		faux.setResponses([
			(context) => {
				assert.deepEqual(context.tools?.map((tool) => tool.name), ["ls"]);
				return fauxAssistantMessage("explicit tools");
			},
		]);
		await runtime.invoke(explicitNode, executionContext(explicitNode), {
			text: "Use explicit tools.",
			systemPrompt: "",
		});

		const readOnlyNode = agentNode(model, { tools: undefined });
		faux.setResponses([
			(context) => {
				assert.deepEqual(
					context.tools?.map((tool) => tool.name).sort(),
					["find", "grep", "ls", "read"],
				);
				return fauxAssistantMessage("read-only tools");
			},
		]);
		await runtime.invoke(readOnlyNode, executionContext(readOnlyNode), {
			text: "Use read-only tools.",
			systemPrompt: "",
		});
	});
});

test("read-only git diff tool reports the current worktree without exposing bash", async () => {
	await withRuntime("git-diff", async ({ faux, model, runtime, runtimeOptions }) => {
		const cwd = runtimeOptions.cwd;
		execFileSync("git", ["init", "--quiet"], { cwd });
		await writeFile(join(cwd, "tracked.txt"), "before\n", "utf8");
		execFileSync("git", ["add", "tracked.txt"], { cwd });
		await writeFile(join(cwd, "tracked.txt"), "after\n", "utf8");

		faux.setResponses([
			(context) => {
				assert.deepEqual(context.tools?.map((tool) => tool.name), [GIT_DIFF_TOOL]);
				return fauxAssistantMessage(fauxToolCall(GIT_DIFF_TOOL, {}, { id: "inspect-diff" }), {
					stopReason: "toolUse",
					timestamp: 1,
				});
			},
			fauxAssistantMessage("review complete", { timestamp: 2 }),
		]);
		const node = agentNode(model, { purpose: "reviewer", tools: [GIT_DIFF_TOOL] });
		const outcome = await runtime.invoke(node, executionContext(node), {
			text: "Inspect the actual diff.",
			systemPrompt: "",
		});

		assert.equal(outcome.runtimeError, undefined);
		assert.ok(outcome.messages.some((message) => message.role === "tool" && /tracked\.txt/.test(message.content)));
	});
});

interface RuntimeFixture {
	faux: ReturnType<typeof createFauxCore>;
	model: string;
	runtime: InProcessPiAgentRuntime;
	runtimeOptions: ConstructorParameters<typeof InProcessPiAgentRuntime>[0];
	threadSessionsDir: string;
}

async function withRuntime<T>(label: string, run: (fixture: RuntimeFixture) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), `pi-graph-agent-runtime-${label}-`));
	const agentDir = join(directory, "agent");
	await mkdir(agentDir, { recursive: true });
	const provider = `pi-graph-runtime-${process.pid}-${fixtureSequence++}`;
	const faux = createFauxCore({
		api: `${provider}-api`,
		provider,
		models: [
			{ id: "offline", name: "Offline Runtime Model", reasoning: true, input: ["text"] },
			{ id: "parent", name: "Parent Runtime Model", reasoning: true, input: ["text"] },
		],
		tokenSize: { min: 1000, max: 1000 },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(provider, {
		name: "Pi Graph Offline Runtime Provider",
		baseUrl: "http://localhost:0",
		apiKey: "offline-test-key",
		api: faux.api,
		models: faux.models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
		streamSimple: faux.streamSimple,
	});
	await modelRuntime.refresh({ allowNetwork: false });
	const threadSessionsDir = join(directory, "threads");
	const runtimeOptions = {
		cwd: directory,
		agentDir,
		projectTrusted: false,
		modelRuntime,
		threadSessionsDir,
	};
	const runtime = new InProcessPiAgentRuntime(runtimeOptions);

	try {
		return await run({ faux, model: `${provider}/offline`, runtime, runtimeOptions, threadSessionsDir });
	} finally {
		modelRuntime.unregisterProvider(provider);
		await rm(directory, { recursive: true, force: true });
	}
}

function agentNode(
	model: string,
	overrides: Partial<AgentNodeDefinition> = {},
): AgentNodeDefinition {
	return {
		type: "agent",
		prompt: "offline runtime test",
		model,
		thinking: "off",
		tools: [],
		readOnly: true,
		loadExtensions: false,
		loadSkills: false,
		loadPromptTemplates: false,
		includeContextFiles: false,
		limits: { timeoutMs: 5_000 },
		...overrides,
	};
}

function executionContext(
	node: AgentNodeDefinition,
	budget: ExecutionBudget = new RecordingBudget(),
	nodeId = "agent",
): NodeExecutionContext {
	const graph = compileGraph({
		schemaVersion: 2,
		name: `runtime-${nodeId}`,
		entry: nodeId,
		nodes: { [nodeId]: node },
		limits: boundedLimits(),
	});
	return {
		runId: `run-${nodeId}`,
		step: 0,
		nodeId,
		state: {},
		graph,
		budget,
	};
}

class RecordingBudget implements ExecutionBudget {
	readonly usage = emptyUsage();

	report(delta: Partial<UsageLedger>): void {
		addUsage(this.usage, delta);
	}

	assertWithinLimits(_nodeId: string, _nodeUsage: UsageLedger, _nodeLimits?: NodeLimits): void {
		// Runtime integration tests only need to observe report() calls.
	}
}

function boundedLimits(): Record<string, number> {
	return {
		maxSteps: 2,
		maxNodeRuns: 2,
		maxConcurrency: 2,
		maxCostUsd: 1,
		timeoutMs: 10_000,
		maxStateBytes: 100_000,
	};
}
