import assert from "node:assert/strict";
import test from "node:test";
import { GraphValidationError, compileGraph, graphUsesMutatingTools } from "../src/compile.ts";
import { resolveTools } from "../src/pi-executor.ts";
import type { GraphDefinition } from "../src/types.ts";

test("compiler flags a reviewer that is not read-only", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "review",
		entry: "reviewer",
		nodes: {
			reviewer: { type: "agent", purpose: "reviewer", prompt: "review" },
		},
		limits: { maxSteps: 2, maxNodeRuns: 2, maxConcurrency: 1, maxCostUsd: 1, timeoutMs: 1000, maxStateBytes: 1000 },
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "REVIEWER_NOT_READ_ONLY"));
});

test("read-only reviewers can use the known web research tools", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "web-review",
		entry: "reviewer",
		nodes: {
			reviewer: {
				type: "agent",
				purpose: "reviewer",
				prompt: "verify claims",
				readOnly: true,
				loadExtensions: true,
				tools: ["web_search", "fetch_content", "get_search_content"],
			},
		},
	});
	const reviewer = graph.definition.nodes.reviewer;
	assert.equal(reviewer?.type, "agent");
	assert.deepEqual(resolveTools(reviewer), ["web_search", "fetch_content", "get_search_content"]);
	assert.ok(!graph.diagnostics.some((item) => item.code === "REVIEWER_NOT_READ_ONLY"));
	assert.equal(graphUsesMutatingTools(graph.definition), true);
});

test("read-only nodes do not receive web tools unless explicitly requested", () => {
	assert.deepEqual(resolveTools({ type: "agent", prompt: "inspect", readOnly: true }), ["read", "grep", "find", "ls"]);
});

test("read-only reviewers can explicitly request the graph git diff tool", () => {
	const reviewer = {
		type: "agent" as const,
		purpose: "reviewer" as const,
		prompt: "review the actual diff",
		readOnly: true,
		tools: ["read", "pi_graph_git_diff"],
	};
	const graph = compileGraph({
		schemaVersion: 2,
		name: "diff-review",
		entry: "reviewer",
		nodes: { reviewer },
	});

	assert.deepEqual(resolveTools(reviewer), ["read", "pi_graph_git_diff"]);
	assert.ok(!graph.diagnostics.some((item) => item.code === "READ_ONLY_TOOLS"));
});

test("web tools require extension loading", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "missing-web-extension",
				entry: "reviewer",
				nodes: {
					reviewer: {
						type: "agent",
						prompt: "review",
						readOnly: true,
						loadExtensions: false,
						tools: ["web_search"],
					},
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError &&
			error.diagnostics.some((item) => item.code === "WEB_TOOLS_REQUIRE_EXTENSIONS"),
	);
});

test("default extension loading is treated as mutating authorization", () => {
	assert.equal(
		graphUsesMutatingTools({
			schemaVersion: 2,
			name: "default-resources",
			entry: "reviewer",
			nodes: { reviewer: { type: "agent", prompt: "review", readOnly: true } },
		}),
		true,
	);
	assert.equal(
		graphUsesMutatingTools({
			schemaVersion: 2,
			name: "disabled-extensions",
			entry: "reviewer",
			nodes: { reviewer: { type: "agent", prompt: "review", readOnly: true, loadExtensions: false } },
		}),
		false,
	);
});

test("non-read-only nodes inherit outer active tools only without an explicit tools field", () => {
	assert.deepEqual(
		resolveTools({ type: "agent", prompt: "work" }, ["read", "grep", "write", "pi_graph_run"]),
		["read", "grep", "write"],
	);
	assert.deepEqual(
		resolveTools({ type: "agent", prompt: "work", tools: ["ls"] }, ["read", "grep"]),
		["ls"],
	);
	assert.deepEqual(
		resolveTools({ type: "agent", prompt: "review", readOnly: true }, ["read", "bash", "write"]),
		["read", "grep", "find", "ls"],
	);
});

test("read-only nodes still reject mutating or unknown tools", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "unsafe-review",
				entry: "reviewer",
				nodes: {
					reviewer: { type: "agent", prompt: "review", readOnly: true, tools: ["web_search", "bash"] },
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "READ_ONLY_TOOLS"),
	);
});

test("compiler rejects schemaVersion 1 even when called directly", () => {
	const definition = {
		schemaVersion: Number("1"),
		name: "old-schema",
		entry: "worker",
		nodes: { worker: { type: "agent", prompt: "work", readOnly: true } },
	};
	assert.throws(
		() => compileGraph(definition as unknown as GraphDefinition),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "SCHEMA_VERSION"),
	);
});

test("compiler rejects removed v1 fields and purpose outside agent nodes", () => {
	const base = {
		schemaVersion: 2,
		name: "v2-removed-fields",
		entry: "worker",
		nodes: { worker: { type: "agent", prompt: "work", readOnly: true } },
	};
	const cases = [
		{
			path: "limits.maxTokens",
			definition: { ...base, limits: { maxTokens: 100 } },
		},
		{
			path: "nodes.worker.limits.maxTokens",
			definition: {
				...base,
				nodes: { worker: { ...base.nodes.worker, limits: { maxTokens: 100 } } },
			},
		},
		{
			path: "limits.maxEstimatedInputTokens",
			definition: { ...base, limits: { maxEstimatedInputTokens: 100 } },
		},
		{
			path: "nodes.worker.limits.maxOutputBytes",
			definition: {
				...base,
				nodes: { worker: { ...base.nodes.worker, limits: { maxOutputBytes: 1024 } } },
			},
		},
		{
			path: "nodes.worker.limits.maxEstimatedInputTokens",
			definition: {
				...base,
				nodes: { worker: { ...base.nodes.worker, limits: { maxEstimatedInputTokens: 100 } } },
			},
		},
		{
			path: "statePolicy.maxHotStateBytes",
			definition: { ...base, statePolicy: { maxHotStateBytes: 1024 } },
		},
		{
			path: "nodes.worker.purpose",
			definition: {
				...base,
				nodes: { worker: { type: "set", purpose: "reviewer", assign: [{ path: "done", value: true }] } },
			},
		},
	] as const;

	for (const { definition, path } of cases) {
		assert.throws(
			() => compileGraph(definition as unknown as GraphDefinition),
			(error: unknown) =>
				error instanceof GraphValidationError &&
				error.diagnostics.some((item) => item.code === "UNKNOWN_FIELD" && item.path === path),
			path,
		);
	}
});

test("compiler rejects unsupported agent purpose values", () => {
	const definition = {
		schemaVersion: 2,
		name: "unsupported-purpose",
		entry: "worker",
		nodes: { worker: { type: "agent", purpose: "worker", prompt: "work", readOnly: true } },
	};
	assert.throws(
		() => compileGraph(definition as unknown as GraphDefinition),
		(error: unknown) =>
			error instanceof GraphValidationError &&
			error.diagnostics.some((item) => item.code === "GRAPH_STRUCTURE" && item.path === "nodes.worker.purpose"),
	);
});

test("compiler rejects unknown destinations", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "bad-edge",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }] } },
				edges: [{ from: "a", to: "missing" }],
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "UNKNOWN_TARGET"),
	);
});

test("compiler accepts conditional edges", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "conditional-edge",
		entry: "review",
		nodes: {
			review: { type: "set", assign: [{ path: "approved", value: true }] },
			revise: { type: "set", assign: [{ path: "revised", value: true }] },
		},
		edges: [
			{
				from: "review",
				cases: [{ when: { path: "approved", op: "eq", value: true }, to: "__end__" }],
				default: "revise",
			},
		],
	});
	assert.equal(graph.definition.edges?.length, 1);
});

test("compiler validates conditional edge values and regular expressions", () => {
	const cases = [
		{ when: { path: "value", op: "matches", value: "[" }, code: "CONDITION_REGEX" },
		{ when: { path: "value", op: "matches", value: 1 }, code: "CONDITION_VALUE" },
		{ when: { path: "value", op: "gt", value: true }, code: "CONDITION_VALUE" },
		{ when: { path: "value", op: "exists", value: true }, code: "CONDITION_VALUE" },
	] as const;
	for (const { when, code } of cases) {
		assert.throws(
			() =>
				compileGraph({
					schemaVersion: 2,
					name: "invalid-condition",
					entry: "check",
					nodes: { check: { type: "set", assign: [{ path: "done", value: true }] } },
					edges: [{ from: "check", cases: [{ when, to: "__end__" }] }],
				}),
			(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === code),
			`${when.op}: ${JSON.stringify(when.value)}`,
		);
	}
});

test("compiler rejects unknown graph control fields with their exact paths", () => {
	const cases = [
		{
			path: "descripton",
			graph: {
				schemaVersion: 2,
				name: "unknown-top-level",
				descripton: "typo",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }] } },
			},
		},
		{
			path: "nodes.a.limtis",
			graph: {
				schemaVersion: 2,
				name: "unknown-node-field",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }], limtis: { timeoutMs: 1 } } },
			},
		},
		{
			path: "nodes.a.assign.0.paht",
			graph: {
				schemaVersion: 2,
				name: "unknown-assignment-field",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1, paht: "y" }] } },
			},
		},
		{
			path: "limits.maxStepz",
			graph: {
				schemaVersion: 2,
				name: "unknown-limit-field",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }] } },
				limits: { maxSteps: 2, maxStepz: 3 },
			},
		},
	] as const;

	for (const { graph, path } of cases) {
		assert.throws(
			() => compileGraph(graph),
			(error: unknown) =>
				error instanceof GraphValidationError &&
				error.diagnostics.some((item) => item.code === "UNKNOWN_FIELD" && item.path === path),
			path,
		);
	}
});

test("compiler keeps graph data objects open", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "open-data",
		entry: "a",
		initialState: { arbitrary: { nested: true, fields: [1, 2, 3] } },
		nodes: {
			a: {
				type: "set",
				assign: [{ path: "payload", value: { arbitrary: { nested: true }, limtis: { anything: "data" } } }],
			},
		},
	});

	assert.deepEqual(graph.definition.initialState, { arbitrary: { nested: true, fields: [1, 2, 3] } });
});

test("compiler rejects onError.to for non-route strategies", () => {
	for (const strategy of ["fail", "continue"] as const) {
		assert.throws(
			() =>
				compileGraph({
					schemaVersion: 2,
					name: `invalid-${strategy}-target`,
					entry: "a",
					nodes: {
						a: { type: "set", assign: [{ path: "x", value: 1 }], onError: { strategy, to: "b" } },
						b: { type: "set", assign: [{ path: "y", value: 1 }] },
					},
				}),
			(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "ERROR_ROUTE"),
		);
	}
});

test("compiler validates error-route targets", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "bad-error-route",
				entry: "a",
				nodes: {
					a: { type: "set", assign: [{ path: "x", value: 1 }], onError: { strategy: "route", to: "missing" } },
				},
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "UNKNOWN_TARGET"),
	);
});

test("error-route targets drive reachability, cycle, and fan-out analysis", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "error-route-topology",
		entry: "source",
		nodes: {
			source: {
				type: "set",
				assign: [{ path: "started", value: true }],
				onError: { strategy: "route", to: ["left", "right"] },
			},
			left: {
				type: "set",
				assign: [
					{ path: "history", value: "left" },
					{ path: "shared", value: "left" },
				],
			},
			right: { type: "set", assign: [{ path: "shared", value: "right" }] },
		},
		edges: [{ from: "left", to: "source" }],
		reducers: { history: "append" },
	});

	assert.ok(!graph.diagnostics.some((item) => item.code === "UNREACHABLE_NODE"));
	assert.ok(graph.diagnostics.some((item) => item.code === "ACCUMULATING_REDUCER_IN_CYCLE"));
	assert.ok(graph.diagnostics.some((item) => item.code === "POSSIBLE_PARALLEL_STATE_CONFLICT"));
});

test("compiler rejects prototype-pollution state paths", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "unsafe",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "__proto__.polluted", value: true }] } },
			}),
		/allowed|not allowed/,
	);
});

test("compiler rejects node ids that collide with object prototype keys", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "unsafe-node-id",
				entry: "constructor",
				nodes: { constructor: { type: "set" as const, assign: [{ path: "safe", value: true }] } },
			}),
		/graph\.nodes\.constructor is not allowed/,
	);
});

test("shared context installs an implicit concat reducer", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "shared-context",
		entry: "writer",
		nodes: {
			writer: {
				type: "agent",
				prompt: "write",
				readOnly: true,
				context: { mode: "shared", messagesPath: "conversation.messages" },
			},
		},
		limits: { maxSteps: 2, maxNodeRuns: 2, maxConcurrency: 1, maxCostUsd: 1, timeoutMs: 1000, maxStateBytes: 10000 },
	});
	assert.equal(graph.reducers["conversation.messages"], "concat");
});

test("compiler accepts collect reducers for current-superstep fan-in", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "collect",
		entry: ["a", "b"],
		nodes: {
			a: { type: "set", assign: [{ path: "results", value: "a" }] },
			b: { type: "set", assign: [{ path: "results", value: "b" }] },
		},
		reducers: { results: "collect" },
	});
	assert.equal(graph.reducers.results, "collect");
});

test("compiler warns when prompt templates and reads inject the same state", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "duplicate-input",
		entry: "worker",
		nodes: {
			worker: {
				type: "agent",
				prompt: "Review {{evidence}}",
				reads: ["evidence"],
				readOnly: true,
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "DUPLICATE_STATE_INJECTION"));
});

test("compiler warns but does not claim to deduplicate parent-child input overlaps", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "overlapping-input",
		entry: "worker",
		nodes: {
			worker: {
				type: "agent",
				prompt: "Review {{evidence.summary}}",
				reads: ["evidence"],
				readOnly: true,
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "OVERLAPPING_STATE_INJECTION"));
});

test("compiler rejects reading a shared message path twice", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "duplicate-shared",
				entry: "worker",
				nodes: {
					worker: {
						type: "agent",
						prompt: "Continue",
						reads: ["conversation.messages"],
						readOnly: true,
						context: { mode: "shared", messagesPath: "conversation.messages" },
					},
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "SHARED_MESSAGES_DUPLICATE_READ"),
	);
});

test("compiler rejects interpolating a shared message path twice", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "duplicate-shared-template",
				entry: "worker",
				nodes: {
					worker: {
						type: "agent",
						prompt: "Continue from {{conversation.messages}}",
						readOnly: true,
						context: { mode: "shared", messagesPath: "conversation.messages" },
					},
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "SHARED_MESSAGES_DUPLICATE_TEMPLATE"),
	);
});

test("compiler warns when artifact output is copied inline into shared state", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "artifact-inline-shared",
		entry: "writer",
		nodes: {
			writer: {
				type: "agent",
				prompt: "write",
				readOnly: true,
				response: { storage: "artifact" },
				context: { mode: "shared", capture: "assistant-only" },
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "ARTIFACT_SHARED_INLINE_CAPTURE"));
});

test("compiler accepts explicit unset assignments and result projection", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "cleanup",
		entry: "cleanup",
		nodes: {
			cleanup: { type: "set", assign: [{ path: "working", mode: "unset" }] },
		},
		result: { paths: ["result.summary"], includeState: false, maxBytes: 4096 },
	});
	assert.equal(graph.definition.nodes.cleanup.type, "set");
});

test("shared context rejects an incompatible explicit reducer", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "bad-shared-reducer",
				entry: "writer",
				nodes: {
					writer: {
						type: "agent",
						prompt: "write",
						readOnly: true,
						context: { mode: "shared", messagesPath: "messages" },
					},
				},
				reducers: { messages: "replace" },
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "SHARED_MESSAGES_REDUCER"),
	);
});

test("compiler rejects parallel nodes sharing one persistent thread", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "parallel-thread",
				entry: ["a", "b"],
				nodes: {
					a: { type: "agent", prompt: "a", readOnly: true, context: { mode: "thread", threadKey: "coder" } },
					b: { type: "agent", prompt: "b", readOnly: true, context: { mode: "thread", threadKey: "coder" } },
				},
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "PARALLEL_THREAD_CONTEXT"),
	);
});

test("compiler warns when a persistent thread node retries", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "thread-retry",
		entry: "coder",
		nodes: {
			coder: {
				type: "agent",
				prompt: "code",
				readOnly: true,
				context: { mode: "thread" },
				retry: { maxAttempts: 2 },
				idempotent: true,
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "THREAD_RETRY_APPENDS_HISTORY"));
});

test("compiler warns when an independent reviewer shares agent history", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "reviewer-history",
		entry: "reviewer",
		nodes: {
			reviewer: {
				type: "agent",
				purpose: "reviewer",
				prompt: "review",
				readOnly: true,
				context: { mode: "shared" },
			},
		},
		limits: { maxSteps: 2, maxNodeRuns: 2, maxConcurrency: 1, maxCostUsd: 1, timeoutMs: 1000, maxStateBytes: 10000 },
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "REVIEWER_CONTEXT_NOT_ISOLATED"));
});

test("compiler rejects nodes that bind one thread to different working directories", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "thread-cwd",
				entry: "a",
				nodes: {
					a: { type: "agent", prompt: "a", readOnly: true, cwd: "packages/a", context: { mode: "thread", threadKey: "coder" } },
					b: { type: "agent", prompt: "b", readOnly: true, cwd: "packages/b", context: { mode: "thread", threadKey: "coder" } },
				},
				edges: [{ from: "a", to: "b" }],
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "THREAD_CWD_MISMATCH"),
	);
});

test("compiler rejects artifact storage when its reference is not retained", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "orphan-artifact",
				entry: "writer",
				nodes: {
					writer: {
						type: "agent",
						prompt: "write",
						readOnly: true,
						response: { storage: "artifact", storeOutput: false },
					},
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "ARTIFACT_REFERENCE_NOT_STORED"),
	);
});

test("compiler accepts a JSON Schema response contract and treats it as JSON output", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "schema-handoff",
		entry: "reviewer",
		nodes: {
			reviewer: {
				type: "agent",
				prompt: "review",
				readOnly: true,
				response: {
					schema: {
						type: "object",
						properties: { approved: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
						required: ["approved", "issues"],
						additionalProperties: false,
					},
				},
			},
		},
	});
	assert.equal(graph.definition.nodes.reviewer.type, "agent");
	assert.deepEqual(graph.definition.nodes.reviewer.response?.schema, {
		type: "object",
		properties: { approved: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
		required: ["approved", "issues"],
		additionalProperties: false,
	});
});

test("compiler rejects malformed or ineffective response schemas", () => {
	for (const schema of [{}, { answer: 42 }, { type: "not-a-json-type" }, { type: "array", items: { value: "missing-keyword" } }]) {
		assert.throws(
			() =>
				compileGraph({
					schemaVersion: 2,
					name: "bad-schema-handoff",
					entry: "worker",
					nodes: { worker: { type: "agent", prompt: "work", readOnly: true, response: { schema } } },
				}),
			(error: unknown) =>
				error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "RESPONSE_SCHEMA"),
			JSON.stringify(schema),
		);
	}
});

test("compiler rejects response schema combined with text format", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "schema-text-conflict",
				entry: "worker",
				nodes: {
					worker: {
						type: "agent",
						prompt: "work",
						readOnly: true,
						response: { format: "text", schema: { type: "string" } },
					},
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "RESPONSE_SCHEMA_FORMAT"),
	);
});

test("compiler warns when shared inline capture duplicates the node output", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "duplicated-shared-output",
		entry: "writer",
		nodes: {
			writer: {
				type: "agent",
				prompt: "write",
				readOnly: true,
				output: "draft",
				context: { mode: "shared", capture: "assistant-only" },
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "SHARED_OUTPUT_DUPLICATED"));
});

test("compiler warns when an accumulating reducer is written inside a cycle", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "cyclic-append",
		entry: "worker",
		nodes: {
			worker: { type: "set", assign: [{ path: "history", value: "round" }] },
			review: { type: "set", assign: [{ path: "approved", value: false }] },
		},
		edges: [
			{ from: "worker", to: "review" },
			{ from: "review", to: "worker" },
		],
		reducers: { history: "append" },
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "ACCUMULATING_REDUCER_IN_CYCLE"));
});

test("bounded shared channels do not warn about cyclic accumulation", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "bounded-shared-cycle",
		entry: "writer",
		nodes: {
			writer: {
				type: "agent",
				prompt: "write",
				readOnly: true,
				context: { mode: "shared", maxStoredMessages: 4 },
			},
		},
		edges: [{ from: "writer", to: "writer" }],
	});
	assert.ok(!graph.diagnostics.some((item) => item.code === "ACCUMULATING_REDUCER_IN_CYCLE"));
});

test("undeclared agent context.mode defaults to thread; explicit declarations are preserved", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "default-thread",
		entry: "plain",
		nodes: {
			plain: { type: "agent", prompt: "p" },
			noContext: { type: "agent", prompt: "p", context: { threadKey: "k" } },
			iso: { type: "agent", prompt: "p", context: { mode: "isolated" } },
			shared: { type: "agent", prompt: "p", context: { mode: "shared" } },
			thread: { type: "agent", prompt: "p", context: { mode: "thread" } },
			setter: { type: "set", assign: [{ path: "done", value: true }] },
		},
	});
	const nodes = graph.definition.nodes as Record<string, { context?: { mode?: string } }>;
	assert.equal(nodes.plain?.context?.mode, "thread");
	assert.equal(nodes.noContext?.context?.mode, "thread");
	assert.equal(nodes.iso?.context?.mode, "isolated");
	assert.equal(nodes.shared?.context?.mode, "shared");
	assert.equal(nodes.thread?.context?.mode, "thread");
	assert.equal(nodes.setter?.context, undefined);
});

test("undeclared reviewer mode defaults to thread and warns REVIEWER_CONTEXT_NOT_ISOLATED", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "reviewer-default-thread",
		entry: "reviewer",
		nodes: {
			reviewer: { type: "agent", purpose: "reviewer", readOnly: true, prompt: "review" },
		},
	});
	const nodes = graph.definition.nodes as Record<string, { context?: { mode?: string } }>;
	assert.equal(nodes.reviewer?.context?.mode, "thread");
	assert.ok(graph.diagnostics.some((item) => item.code === "REVIEWER_CONTEXT_NOT_ISOLATED"));
});
