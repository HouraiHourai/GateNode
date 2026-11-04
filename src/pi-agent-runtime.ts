import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	createAgentSession,
	createAgentSessionServices,
	defineTool,
	getAgentDir,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type InlineExtension,
	type ModelRuntime,
	type ScopedModel,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { validateSchemaOutput } from "./output-schema.ts";
import {
	DEFAULT_AGENT_TOOL_NAMES,
	READ_ONLY_BUILTIN_TOOL_NAMES,
	READ_ONLY_TOOL_SET,
} from "./tool-policy.ts";
import type {
	AgentNodeDefinition,
	DurableAgentTurn,
	JsonSchema,
	JsonValue,
	NodeExecutionContext,
	NodeUsage,
	UsageLedger,
} from "./types.ts";
import { addUsage, emptyUsage, errorMessage, hashJson, isJsonObject, toJsonValue } from "./utils.ts";

const GRAPH_TOOL_NAMES = ["pi_graph_run", "pi_graph_resume", "pi_graph_inspect"] as const;
const NODE_OUTPUT_TOOL_NAME = "pi_graph_node_output";
const GIT_DIFF_TOOL_NAME = "pi_graph_git_diff";
const INVOCATION_ENTRY_TYPE = "pi-graph-invocation";
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_GIT_DIFF_BYTES = 256 * 1024;
const STREAM_ACTIVITY_MIN_INTERVAL_MS = 150;
const ACTIVITY_PREVIEW_CHARS = 100;
const TOOL_ARG_KEYS = [
	"command",
	"cmd",
	"script",
	"path",
	"file_path",
	"file",
	"pattern",
	"query",
	"url",
	"graph",
	"runId",
	"name",
	"prompt",
] as const;
const execFileAsync = promisify(execFile);

export interface AgentRuntimePrompt {
	text: string;
	systemPrompt: string;
}

interface PersistedInvocation {
	messages: AgentRuntimeMessage[];
	turns: DurableAgentTurn[];
	usage: NodeUsage;
	outputText: string;
	stopReason?: string;
	assistantError?: string;
	structuredOutput?: JsonValue;
	structuredOutputSucceeded: boolean;
	hasPersistedMessages: boolean;
	canContinue: boolean;
	complete: boolean;
	pendingToolCalls: ToolCall[];
	interruptedAssistant: boolean;
}

function prepareInvocation(sessionManager: SessionManager, executionId: string): PersistedInvocation {
	let entries = sessionManager.getEntries();
	let boundary = entries.findLastIndex((entry) =>
		entry.type === "custom"
		&& entry.customType === INVOCATION_ENTRY_TYPE
		&& isJsonObject(entry.data)
		&& entry.data.executionId === executionId,
	);
	if (boundary < 0) {
		sessionManager.appendCustomEntry(INVOCATION_ENTRY_TYPE, { executionId });
		entries = sessionManager.getEntries();
		boundary = entries.length - 1;
	}

	const invocationEntries = entries.slice(boundary + 1).filter((entry) => entry.type === "message");
	const messages: AgentRuntimeMessage[] = [];
	const turns: DurableAgentTurn[] = [];
	const usage: NodeUsage = emptyUsage();
	let outputText = "";
	let stopReason: string | undefined;
	let assistantError: string | undefined;
	let structuredOutput: JsonValue | undefined;
	let structuredOutputSucceeded = false;

	for (const entry of invocationEntries) {
		const message = entry.message;
		if (message.role === "assistant") {
			const text = extractMessageText(message.content);
			if (text !== undefined) outputText = text;
			if (text?.trim()) messages.push({ role: "assistant", content: text, name: null });
			stopReason = message.stopReason;
			assistantError = message.errorMessage;
			usage.model = message.model;
			const delta = extractUsage(message.usage);
			addUsage(usage, delta);
			turns.push({ id: entry.id, usage: delta });
			continue;
		}
		if (message.role !== "toolResult") continue;
		const text = extractMessageText(message.content);
		if (text?.trim()) messages.push({ role: "tool", content: text, name: message.toolName ?? null });
		if (isJsonObject(message.details) && message.details.kind === "pi-graph-node-output" && "data" in message.details) {
			structuredOutput = toJsonValue(message.details.data, "persisted node output");
			structuredOutputSucceeded = true;
		}
	}

	const last = invocationEntries.at(-1)?.message;
	const lastToolTurn = findLastToolTurn(invocationEntries);
	const completedToolCalls = new Set(lastToolTurn.results.map((result) => result.toolCallId));
	const pendingToolCalls = lastToolTurn.calls.filter((call) => !completedToolCalls.has(call.id));
	const interruptedAssistant = last?.role === "assistant"
		&& (last.stopReason === "aborted" || last.stopReason === "error");
	const complete = last?.role === "assistant" && lastToolTurn.calls.length === 0 && !interruptedAssistant;
	return {
		messages,
		turns,
		usage,
		outputText,
		stopReason,
		assistantError,
		structuredOutput,
		structuredOutputSucceeded,
		hasPersistedMessages: invocationEntries.length > 0,
		canContinue: last?.role === "user" || last?.role === "toolResult",
		complete,
		pendingToolCalls,
		interruptedAssistant,
	};
}

function findLastToolTurn(entries: Array<Extract<SessionEntry, { type: "message" }>>): {
	calls: ToolCall[];
	results: ToolResultMessage[];
} {
	for (let index = entries.length - 1; index >= 0; index--) {
		const message = entries[index]?.message;
		if (message?.role !== "assistant") continue;
		const calls = Array.isArray(message.content)
			? message.content.filter((item): item is ToolCall => isJsonObject(item) && item.type === "toolCall")
			: [];
		if (calls.length === 0) return { calls: [], results: [] };
		const results = entries.slice(index + 1)
			.map((entry) => entry.message)
			.filter((item): item is ToolResultMessage => item.role === "toolResult");
		return { calls, results };
	}
	return { calls: [], results: [] };
}

function findPersistedAssistantEntry(sessionManager: SessionManager, timestamp: number): Extract<SessionEntry, { type: "message" }> | undefined {
	return sessionManager.getEntries().findLast((entry): entry is Extract<SessionEntry, { type: "message" }> =>
		entry.type === "message" && entry.message.role === "assistant" && entry.message.timestamp === timestamp,
	);
}

async function recoverToolCalls(
	session: AgentSession,
	sessionManager: SessionManager,
	calls: ToolCall[],
	signal: AbortSignal | undefined,
): Promise<boolean> {
	let allTerminate = calls.length > 0;
	for (const call of calls) {
		const tool = session.agent.state.tools.find((candidate) => candidate.name === call.name);
		if (!tool) throw new AgentRuntimeExecutionError("RECOVERY_TOOL_MISSING", `Cannot recover missing tool ${JSON.stringify(call.name)}`);
		let result: Awaited<ReturnType<typeof tool.execute>>;
		let isError = false;
		try {
			const params = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
			if (!Value.Check(tool.parameters, params)) throw new Error(`Invalid arguments for recovered tool ${call.name}`);
			result = await tool.execute(call.id, params, signal);
		} catch (error) {
			isError = true;
			result = { content: [{ type: "text", text: errorMessage(error) }], details: undefined };
		}
		allTerminate &&= result.terminate === true;
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: result.content,
			details: result.details,
			usage: result.usage,
			addedToolNames: result.addedToolNames,
			isError,
			timestamp: Date.now(),
		};
		sessionManager.appendMessage(message);
		session.agent.state.messages = [...session.agent.state.messages, message];
	}
	return allTerminate;
}

export interface AgentRuntimeMessage {
	role: "assistant" | "tool";
	content: string;
	name: string | null;
}

export interface AgentRuntimeOutcome {
	outputText: string;
	usage: NodeUsage;
	messages: AgentRuntimeMessage[];
	stopReason?: string;
	errorMessage?: string;
	runtimeError?: string;
	runtimeErrorCode?: string;
	runtimeErrorRetryable?: boolean;
	timedOut: boolean;
	aborted: boolean;
	budgetError?: string;
	structuredOutput?: JsonValue;
	structuredOutputSucceeded: boolean;
}

export interface NodeAgentRuntime {
	invoke(
		node: AgentNodeDefinition,
		context: NodeExecutionContext,
		prompt: AgentRuntimePrompt,
	): Promise<AgentRuntimeOutcome>;
}

export interface InProcessPiAgentRuntimeOptions {
	cwd: string;
	agentDir?: string;
	projectTrusted?: boolean;
	/** Root directory for durable per-run Pi sessions used by thread context nodes. */
	threadSessionsDir?: string;
	/** Optional caller-owned runtime, primarily for embedding and deterministic tests. */
	modelRuntime?: ModelRuntime;
	/** Active model from the parent Pi session, used unless the node selects one. */
	model?: Model<Api>;
	/** Active thinking level from the parent Pi session, used unless the node selects one. */
	thinkingLevel?: AgentNodeDefinition["thinking"];
	/** Active parent-session tools, used by non-read-only nodes without an explicit tools field. */
	activeTools?: string[];
	/** Full parent-session runtime profile when hosted by a Pi version that exposes it. */
	parentProfile?: ParentSessionProfile;
}

export interface ParentSessionProfile {
	modelRuntime: ModelRuntime;
	model: Model<Api> | undefined;
	thinkingLevel: AgentNodeDefinition["thinking"];
	scopedModels: readonly ScopedModel[];
	activeTools: readonly string[];
	extensionFlagValues: ReadonlyMap<string, boolean | string>;
	resources?: {
		additionalExtensionPaths: readonly string[];
		additionalSkillPaths: readonly string[];
		additionalPromptTemplatePaths: readonly string[];
		additionalThemePaths: readonly string[];
		extensionFactories: readonly InlineExtension[];
		noExtensions: boolean;
		noSkills: boolean;
		noPromptTemplates: boolean;
		noThemes: boolean;
		noContextFiles: boolean;
		systemPrompt?: string;
		appendSystemPrompt: readonly string[];
	};
}

/**
 * Invocation-local Pi adapter. Every graph node gets its own in-process
 * AgentSession; no CLI process or JSON event protocol is involved.
 */
export class InProcessPiAgentRuntime implements NodeAgentRuntime {
	private readonly options: InProcessPiAgentRuntimeOptions;

	constructor(options: InProcessPiAgentRuntimeOptions) {
		this.options = options;
	}

	async invoke(
		node: AgentNodeDefinition,
		context: NodeExecutionContext,
		prompt: AgentRuntimePrompt,
	): Promise<AgentRuntimeOutcome> {
		const usage: NodeUsage = emptyUsage();
		const messages: AgentRuntimeMessage[] = [];
		let outputText = "";
		let stopReason: string | undefined;
		let assistantError: string | undefined;
		let runtimeError: string | undefined;
		let runtimeErrorCode: string | undefined;
		let runtimeErrorRetryable: boolean | undefined;
		let timedOut = false;
		let aborted = false;
		let budgetError: string | undefined;
		let structuredOutput: JsonValue | undefined;
		let structuredOutputSucceeded = false;
		let session: AgentSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abortPromise: Promise<void> | undefined;
		let removeAbortListener: (() => void) | undefined;
		let threadSessionFile: string | undefined;
		let durabilityError: AgentRuntimeExecutionError | undefined;
		const captureRuntimeError = (error: unknown) => {
			runtimeError ??= errorMessage(error);
			if (error instanceof AgentRuntimeExecutionError) {
				runtimeErrorCode ??= error.code;
				runtimeErrorRetryable ??= error.retryable;
			}
		};

		const nodeCwd = resolveNodeCwd(this.options.cwd, node.cwd);
		try {
			const stableExecutionId = context.executionId ?? `pig:ephemeral:${randomUUID()}`;
			const sessionManager = await this.createSessionManager(node, context, nodeCwd, stableExecutionId);
			threadSessionFile = sessionManager.getSessionFile();
			const invocation = prepareInvocation(sessionManager, stableExecutionId);
			for (const turn of invocation.turns) await context.recordTurn?.(turn);
			addUsage(usage, invocation.usage);
			messages.push(...invocation.messages);
			outputText = invocation.outputText;
			stopReason = invocation.stopReason;
			assistantError = invocation.assistantError;
			structuredOutput = invocation.structuredOutput;
			structuredOutputSucceeded = invocation.structuredOutputSucceeded;
			const durabilityExtension: InlineExtension = {
				name: "pi-graph-durable-turns",
				hidden: true,
				factory: (pi) => {
					pi.on("turn_end", async (event) => {
						if (!context.recordTurn || event.message.role !== "assistant") return;
						try {
							const entry = findPersistedAssistantEntry(sessionManager, event.message.timestamp);
							if (!entry) throw new Error("Pi assistant turn was not persisted before turn_end");
							await context.recordTurn({ id: entry.id, usage: extractUsage(event.message.usage) });
						} catch (error) {
							durabilityError ??= new AgentRuntimeExecutionError(
								"TURN_CHECKPOINT_FAILED",
								`Failed to checkpoint completed Pi turn: ${errorMessage(error)}`,
							);
							void session?.abort();
						}
					});
				},
			};
			const agentDir = this.options.agentDir ?? getAgentDir();
			const settingsManager = SettingsManager.create(nodeCwd, agentDir, {
				projectTrusted: this.options.projectTrusted ?? false,
			});
			const parent = this.options.parentProfile;
			const parentResources = parent?.resources;
			const services = await createAgentSessionServices({
				cwd: nodeCwd,
				agentDir,
				settingsManager,
				modelRuntime: parent?.modelRuntime ?? this.options.modelRuntime,
				extensionFlagValues: parent ? new Map(parent.extensionFlagValues) : undefined,
				resourceLoaderOptions: {
					additionalExtensionPaths: parentResources ? [...parentResources.additionalExtensionPaths] : undefined,
					additionalSkillPaths: parentResources ? [...parentResources.additionalSkillPaths] : undefined,
					additionalPromptTemplatePaths: parentResources ? [...parentResources.additionalPromptTemplatePaths] : undefined,
					additionalThemePaths: parentResources ? [...parentResources.additionalThemePaths] : undefined,
					noExtensions: node.loadExtensions === false ? true : node.loadExtensions === true ? false : parentResources?.noExtensions,
					noSkills: node.loadSkills === false ? true : node.loadSkills === true ? false : parentResources?.noSkills,
					noPromptTemplates: node.loadPromptTemplates === false
						? true
						: node.loadPromptTemplates === true ? false : parentResources?.noPromptTemplates,
					noThemes: parentResources?.noThemes ?? true,
					noContextFiles: node.includeContextFiles === false ? true : parentResources?.noContextFiles,
					systemPromptOverride: parentResources ? () => parentResources.systemPrompt : undefined,
					appendSystemPromptOverride: parentResources
						? () => [...parentResources.appendSystemPrompt, ...(prompt.systemPrompt ? [prompt.systemPrompt] : [])]
						: undefined,
					appendSystemPrompt: parentResources ? undefined : prompt.systemPrompt ? [prompt.systemPrompt] : [],
					extensionFactories: [...(parentResources?.extensionFactories ?? []), durabilityExtension],
				},
			});

			let model = parent?.model ?? this.options.model;
			let thinkingLevel = node.thinking ?? parent?.thinkingLevel ?? this.options.thinkingLevel;
			if (node.model) {
				const resolvedModel = resolveCliModel({
					cliModel: node.model,
					cliThinking: node.thinking,
					modelRuntime: services.modelRuntime,
				});
				if (resolvedModel.error || !resolvedModel.model) {
					throw new Error(resolvedModel.error ?? `Model ${JSON.stringify(node.model)} could not be resolved`);
				}
				model = resolvedModel.model;
				thinkingLevel = resolvedModel.thinkingLevel ?? node.thinking ?? this.options.thinkingLevel;
			}

			const outputCapture = { value: structuredOutput, succeeded: structuredOutputSucceeded };
			const outputTool = node.response?.schema !== undefined
				? createNodeOutputTool(node.response.schema, outputCapture)
				: undefined;
			const tools = resolveAgentTools(node, parent ? [...parent.activeTools] : this.options.activeTools);
			const gitDiffTool = tools.includes(GIT_DIFF_TOOL_NAME) ? createGitDiffTool(nodeCwd) : undefined;
			const customTools = [outputTool, gitDiffTool].filter((tool): tool is ToolDefinition => tool !== undefined);
			const created = await createAgentSession({
				cwd: nodeCwd,
				agentDir,
				modelRuntime: services.modelRuntime,
				model,
				thinkingLevel,
				scopedModels: parent ? [...parent.scopedModels] : undefined,
				tools,
				excludeTools: node.loadExtensions !== false ? [...GRAPH_TOOL_NAMES] : undefined,
				customTools: customTools.length > 0 ? customTools : undefined,
				resourceLoader: services.resourceLoader,
				sessionManager,
				settingsManager,
				sessionStartEvent: { type: "session_start", reason: "startup" },
			});
			session = created.session;
			await session.bindExtensions({
				mode: "json",
				onError: () => undefined,
			});

			const requestAbort = (): Promise<void> => {
				abortPromise ??= session?.abort().catch((error: unknown) => {
					captureRuntimeError(error);
				}) ?? Promise.resolve();
				return abortPromise;
			};
			let lastActivityEmitMs = 0;
			const emitActivity = (message: string | undefined, throttled = false) => {
				if (!message || !context.onEvent) return;
				const nowMs = Date.now();
				if (throttled && nowMs - lastActivityEmitMs < STREAM_ACTIVITY_MIN_INTERVAL_MS) return;
				lastActivityEmitMs = nowMs;
				try {
					void context.onEvent({
						type: "node_activity",
						runId: context.runId,
						timestamp: new Date().toISOString(),
						step: context.step,
						nodeId: context.nodeId,
						attempt: context.attempt,
						message,
					});
				} catch {
					// Observability only; never affect the node invocation.
				}
			};

			unsubscribe = session.subscribe((event) => {
				if (event.type === "message_start") {
					if (event.message.role === "assistant") emitActivity("thinking…");
					return;
				}
				if (event.type === "message_update") {
					if (event.message.role === "assistant") emitActivity(streamActivityPreview(event.message), true);
					return;
				}
				if (event.type === "tool_execution_start") {
					emitActivity(`${event.toolName}(${describeToolArgs(event.args)})`);
					return;
				}
				if (event.type !== "message_end") return;
				if (event.message.role === "assistant") {
					const text = extractMessageText(event.message.content);
					if (text !== undefined) outputText = text;
					if (text?.trim()) messages.push({ role: "assistant", content: text, name: null });
					stopReason = event.message.stopReason;
					assistantError = event.message.errorMessage;
					usage.model = event.message.model;
					const delta = extractUsage(event.message.usage);
					addUsage(usage, delta);
					if (!context.recordTurn) {
						try {
							context.budget.report(delta);
						} catch (error) {
							budgetError ??= errorMessage(error);
							void requestAbort();
						}
					}
					return;
				}
				if (event.message.role === "toolResult") {
					const text = extractMessageText(event.message.content);
					if (text?.trim()) {
						messages.push({ role: "tool", content: text, name: event.message.toolName ?? null });
					}
				}
			});

			const abort = () => {
				aborted = true;
				void requestAbort();
			};
			if (context.signal?.aborted) abort();
			else if (context.signal) {
				context.signal.addEventListener("abort", abort, { once: true });
				removeAbortListener = () => context.signal?.removeEventListener("abort", abort);
			}
			// GraphEngine owns graph/node deadlines when it supplies a signal.
			if (!context.signal) {
				timeout = setTimeout(() => {
					timedOut = true;
					void requestAbort();
				}, node.limits?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS);
				timeout.unref?.();
			}

			if (!aborted && !timedOut && !durabilityError) {
				try {
					if (!invocation.hasPersistedMessages) await session.prompt(prompt.text);
					else if (invocation.structuredOutputSucceeded || invocation.complete) {
						// The prior process finished the logical node; rebuild its outcome without another model call.
					} else if (invocation.pendingToolCalls.length > 0) {
						const terminated = await recoverToolCalls(session, sessionManager, invocation.pendingToolCalls, context.signal);
						if (!terminated) await session.agent.continue();
					} else if (invocation.interruptedAssistant) {
						await session.prompt("Continue the interrupted graph node from the durable transcript without repeating completed work.");
					} else if (invocation.canContinue) {
						await session.agent.continue();
					} else {
						throw new AgentRuntimeExecutionError("SESSION_RECOVERY_INVALID", `Execution ${stableExecutionId} has no resumable transcript tail`);
					}
				} catch (error) {
					if (!budgetError && !timedOut && !aborted) captureRuntimeError(error);
				}
			}
			if (durabilityError) captureRuntimeError(durabilityError);
			structuredOutput = outputCapture.value;
			structuredOutputSucceeded = outputCapture.succeeded;
		} catch (error) {
			if (!budgetError && !timedOut && !aborted) captureRuntimeError(error);
		} finally {
			if (timeout) clearTimeout(timeout);
			removeAbortListener?.();
			if (abortPromise) await abortPromise;
			unsubscribe?.();
			if (session) {
				try {
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} catch (error) {
					captureRuntimeError(error);
				} finally {
					session.dispose();
				}
			}
			if (threadSessionFile && process.platform !== "win32") {
				try {
					await chmod(threadSessionFile, 0o600);
				} catch (error) {
					if (!hasErrorCode(error, "ENOENT")) captureRuntimeError(error);
				}
			}
		}

		return {
			outputText,
			usage,
			messages,
			stopReason,
			errorMessage: assistantError,
			runtimeError,
			runtimeErrorCode,
			runtimeErrorRetryable,
			timedOut,
			aborted,
			budgetError,
			structuredOutput,
			structuredOutputSucceeded,
		};
	}

	private async createSessionManager(
		node: AgentNodeDefinition,
		context: NodeExecutionContext,
		cwd: string,
		executionId: string,
	): Promise<SessionManager> {
		if (!this.options.threadSessionsDir) return SessionManager.inMemory(cwd);
		const { sessionDir, sessionFile } = (node.context?.mode ?? "isolated") === "thread"
			? await prepareThreadSessionFile(context, this.options.threadSessionsDir)
			: await prepareInvocationSessionFile(context, this.options.threadSessionsDir, executionId);
		return SessionManager.open(sessionFile, sessionDir, cwd);
	}
}

interface OutputCapture {
	value: JsonValue | undefined;
	succeeded: boolean;
}

class AgentRuntimeExecutionError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.name = "AgentRuntimeExecutionError";
		this.code = code;
		this.retryable = retryable;
	}
}

function createNodeOutputTool(schema: JsonSchema, capture: OutputCapture): ToolDefinition {
	const schemaJson = JSON.stringify(schema);
	const parameters = Type.Object(
		{
			data: Type.Optional(Type.Unknown({ description: `Final node handoff. Must match this JSON Schema: ${schemaJson}` })),
		},
		{ additionalProperties: true },
	);
	return defineTool({
		name: NODE_OUTPUT_TOOL_NAME,
		label: "Node Output",
		description:
			"Submit this graph node's final handoff value. The data field is validated against the node's configured JSON Schema. "
			+ `Required schema: ${schemaJson}`,
		promptSnippet: `Use ${NODE_OUTPUT_TOOL_NAME} to submit the final schema-validated node handoff.`,
		promptGuidelines: [
			`Call ${NODE_OUTPUT_TOOL_NAME} exactly once with the final value in data.`,
			"Do not return the handoff as plain text.",
		],
		parameters,
		async execute(_toolCallId, params) {
			const data = validateSubmittedOutput(schema, params);
			capture.value = data;
			capture.succeeded = true;
			return {
				content: [{ type: "text", text: "Schema-validated node output recorded." }],
				details: { kind: "pi-graph-node-output", data },
				terminate: true,
			};
		},
	});
}

function createGitDiffTool(cwd: string): ToolDefinition {
	return defineTool({
		name: GIT_DIFF_TOOL_NAME,
		label: "Git Diff",
		description: "Read the current Git status plus staged and unstaged patches. This tool never modifies the repository.",
		promptSnippet: `Use ${GIT_DIFF_TOOL_NAME} to inspect the actual workspace diff instead of trusting an implementation summary.`,
		promptGuidelines: [`Call ${GIT_DIFF_TOOL_NAME} before approving code changes.`],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const options = { cwd, encoding: "utf8" as const, maxBuffer: 1024 * 1024 };
			const [status, staged, unstaged] = await Promise.all([
				execFileAsync("git", ["status", "--short", "--untracked-files=all"], options),
				execFileAsync("git", ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--"], options),
				execFileAsync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--"], options),
			]);
			const fullText = `Status:\n${status.stdout || "(clean)"}\nStaged diff:\n${staged.stdout || "(none)"}\nUnstaged diff:\n${unstaged.stdout || "(none)"}`;
			const truncated = Buffer.byteLength(fullText, "utf8") > MAX_GIT_DIFF_BYTES;
			const text = truncateUtf8(fullText, MAX_GIT_DIFF_BYTES);
			return {
				content: [{ type: "text", text }],
				details: { kind: "pi-graph-git-diff", truncated },
			};
		},
	});
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "\n[diff truncated]";
	let prefix = Buffer.from(text, "utf8").subarray(0, maxBytes - Buffer.byteLength(marker, "utf8")).toString("utf8");
	if (prefix.endsWith("�")) prefix = prefix.slice(0, -1);
	return prefix + marker;
}

function validateSubmittedOutput(schema: JsonSchema, params: unknown): JsonValue {
	const wrapped = isJsonObject(params) && "data" in params;
	const primary = wrapped ? params.data : params;
	const candidates: unknown[] = [];
	if (typeof primary === "string") {
		try {
			candidates.push(JSON.parse(primary));
		} catch {
			// The string itself may be the schema value.
		}
	}
	candidates.push(primary);
	if (wrapped) candidates.push(params);

	let firstError: unknown;
	for (const candidate of candidates) {
		try {
			return validateSchemaOutput(schema, candidate, "node output");
		} catch (error) {
			firstError ??= error;
		}
	}
	throw firstError;
}

export function resolveAgentTools(node: AgentNodeDefinition, inheritedTools?: string[]): string[] {
	const graphTools = new Set<string>(GRAPH_TOOL_NAMES);
	const defaults = node.readOnly === true ? READ_ONLY_BUILTIN_TOOL_NAMES : DEFAULT_AGENT_TOOL_NAMES;
	const requested = node.tools ?? (node.readOnly === true ? defaults : inheritedTools ?? defaults);
	const tools = requested.filter(
		(tool) => !graphTools.has(tool) && (node.readOnly !== true || READ_ONLY_TOOL_SET.has(tool)),
	);
	if (node.response?.schema !== undefined) tools.push(NODE_OUTPUT_TOOL_NAME);
	return [...new Set(tools)];
}

function resolveNodeCwd(baseCwd: string, configured: string | undefined): string {
	return configured ? resolve(baseCwd, configured) : baseCwd;
}

async function prepareInvocationSessionFile(
	context: NodeExecutionContext,
	configuredRoot: string,
	executionId: string,
): Promise<{ sessionDir: string; sessionFile: string }> {
	const sessionDir = join(resolve(configuredRoot), context.runId, "attempts");
	await ensurePrivateDirectory(sessionDir);
	const safeNodeId = context.nodeId.replace(/[^A-Za-z0-9._-]/g, "_");
	const executionHash = hashJson(executionId).slice(0, 16);
	const sessionFile = join(sessionDir, `${context.step}-${safeNodeId}-${context.attempt ?? 1}-${executionHash}.jsonl`);
	await ensureSessionFile(sessionFile);
	return { sessionDir, sessionFile };
}

async function prepareThreadSessionFile(
	context: NodeExecutionContext,
	configuredRoot: string | undefined,
): Promise<{ sessionDir: string; sessionFile: string }> {
	if (!context.thread) {
		throw new AgentRuntimeExecutionError(
			"THREAD_CONTEXT_MISSING",
			`Thread node ${context.nodeId} is missing durable thread metadata`,
		);
	}
	if (!configuredRoot) {
		throw new AgentRuntimeExecutionError(
			"THREAD_SESSION_DIRECTORY",
			"threadSessionsDir is required for thread context nodes",
		);
	}

	const sessionDir = join(resolve(configuredRoot), context.runId);
	await ensurePrivateDirectory(sessionDir);
	const sessionFile = join(sessionDir, `${context.thread.sessionId}.jsonl`);
	await ensureSessionFile(sessionFile, context.thread.invocationCount > 0
		? `Durable Pi session for thread ${JSON.stringify(context.thread.key)} is missing: ${sessionFile}. Refusing to silently reset private agent memory.`
		: undefined);
	return { sessionDir, sessionFile };
}

async function ensureSessionFile(sessionFile: string, missingMessage?: string): Promise<void> {
	let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
	try {
		metadata = await lstat(sessionFile);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}

	if (metadata) {
		if (metadata.isSymbolicLink() || !metadata.isFile()) {
			throw new AgentRuntimeExecutionError(
				"THREAD_SESSION_INVALID",
				`Thread session path is not a regular file: ${sessionFile}`,
			);
		}
	} else {
		if (missingMessage) throw new AgentRuntimeExecutionError("THREAD_SESSION_MISSING", missingMessage);
		try {
			await writeFile(sessionFile, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			const racedMetadata = await lstat(sessionFile);
			if (racedMetadata.isSymbolicLink() || !racedMetadata.isFile()) {
				throw new AgentRuntimeExecutionError(
					"THREAD_SESSION_INVALID",
					`Thread session path is not a regular file: ${sessionFile}`,
				);
			}
		}
	}
	if (process.platform !== "win32") await chmod(sessionFile, 0o600);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const metadata = await lstat(path);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new AgentRuntimeExecutionError(
			"THREAD_SESSION_DIRECTORY",
			`Thread session directory is invalid: ${path}`,
		);
	}
	if (process.platform !== "win32") await chmod(path, 0o700);
}

function hasErrorCode(error: unknown, expected: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && String(error.code) === expected;
}

function extractMessageText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const item of content) {
		if (isJsonObject(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function collectStreamPart(content: unknown, type: "text" | "thinking"): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!isJsonObject(item) || item.type !== type) continue;
		const value = item[type];
		if (typeof value === "string" && value.trim()) parts.push(value);
	}
	return parts.join("\n");
}

/** Live one-line preview of what an in-node agent is currently writing or reasoning about. */
function streamActivityPreview(message: { content: unknown }): string | undefined {
	const text = tailLine(collectStreamPart(message.content, "text"));
	if (text) return text;
	const thinking = tailLine(collectStreamPart(message.content, "thinking"));
	return thinking ? `thinking: ${thinking}` : undefined;
}

function tailLine(text: string): string | undefined {
	const last = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	return last ? compactPreview(last) : undefined;
}

/** Compact single-line preview of a tool invocation for the live runtime board. */
function describeToolArgs(args: unknown): string {
	if (!isJsonObject(args)) return "";
	for (const key of TOOL_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return compactPreview(value);
	}
	const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null);
	if (entries.length === 0) return "";
	return compactPreview(entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" "));
}

function compactPreview(text: string): string {
	const single = text.replaceAll(/\s+/g, " ").trim();
	return single.length <= ACTIVITY_PREVIEW_CHARS ? single : `${single.slice(0, ACTIVITY_PREVIEW_CHARS - 1)}…`;
}

function extractUsage(value: unknown): Partial<UsageLedger> {
	if (!isJsonObject(value)) return { turns: 1 };
	const cost = isJsonObject(value.cost) && typeof value.cost.total === "number" ? value.cost.total : 0;
	return {
		inputTokens: numeric(value.input),
		outputTokens: numeric(value.output),
		cacheReadTokens: numeric(value.cacheRead),
		cacheWriteTokens: numeric(value.cacheWrite),
		turns: 1,
		costUsd: cost,
	};
}

function numeric(value: JsonValue | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
