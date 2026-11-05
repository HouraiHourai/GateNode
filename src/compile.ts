import type {
	AgentNodeDefinition,
	ConditionalEdgeDefinition,
	CompiledEdge,
	CompiledGraph,
	Condition,
	Diagnostic,
	EdgeDefinition,
	GraphDefinition,
	HumanNodeDefinition,
	JsonObject,
	NodeDefinition,
	ReducerName,
	StaticEdgeDefinition,
} from "./types.ts";
import { posix as pathPosix } from "node:path";
import { validateGraphStructure } from "./graph-schema.ts";
import { jsonSchemaProblems } from "./output-schema.ts";
import { gatePolicyProblems } from "./gate/policy.ts";
import {
	DEFAULT_AGENT_TOOL_NAMES,
	READ_ONLY_TOOL_NAMES,
	READ_ONLY_TOOL_SET,
	READ_ONLY_WEB_TOOL_SET,
} from "./tool-policy.ts";
import { END } from "./types.ts";
import {
	asStringArray,
	extractTemplatePaths,
	hashJson,
	isJsonObject,
	statePathsOverlap,
	toJsonValue,
	uniqueStrings,
} from "./utils.ts";

interface GraphTargetGroup {
	sources: string[];
	targets: string[];
	path: string;
}

interface GraphTopology {
	targetGroups: GraphTargetGroup[];
	adjacency: Map<string, Set<string>>;
	fanOutGroups: string[][];
}

export class GraphValidationError extends Error {
	readonly diagnostics: Diagnostic[];

	constructor(diagnostics: Diagnostic[]) {
		super(diagnostics.filter((item) => item.level === "error").map((item) => item.message).join("; "));
		this.name = "GraphValidationError";
		this.diagnostics = diagnostics;
	}
}

export function compileGraph(raw: unknown, source = "graph"): CompiledGraph {
	const normalized = toJsonValue(raw, source);
	if (!isJsonObject(normalized)) throw new Error(`${source} must be a JSON object`);
	const structuralDiagnostics = validateGraphStructure(normalized);
	if (structuralDiagnostics.some((item) => item.level === "error")) throw new GraphValidationError(structuralDiagnostics);
	applyDefaultContextMode(normalized);
	const definition = normalized as unknown as GraphDefinition;
	const diagnostics = validateGraph(definition);
	if (diagnostics.some((item) => item.level === "error")) throw new GraphValidationError(diagnostics);
	const staticEdges: CompiledEdge[] = (definition.edges ?? []).flatMap((edge, index) =>
		isStaticEdge(edge)
			? [{
				id: `edge:${index}`,
				from: uniqueStrings(asStringArray(edge.from)),
				to: uniqueStrings(asStringArray(edge.to)),
				barrier: uniqueStrings(asStringArray(edge.from)).length > 1,
			}]
			: [],
	);
	const conditionalEdgesByNode = new Map<string, ConditionalEdgeDefinition>();
	for (const edge of (definition.edges ?? []).filter(isConditionalEdge)) conditionalEdgesByNode.set(edge.from, edge);
	return {
		definition,
		hash: hashJson(toJsonValue(definition)),
		diagnostics,
		staticEdges,
		conditionalEdgesByNode,
		reducers: resolveEffectiveReducers(definition),
	};
}

function isConditionalEdge(edge: EdgeDefinition): edge is ConditionalEdgeDefinition {
	return "cases" in edge;
}

function isStaticEdge(edge: EdgeDefinition): edge is StaticEdgeDefinition {
	return "to" in edge;
}

function validateGraph(definition: GraphDefinition): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const nodeIds = Object.keys(definition.nodes);
	const nodeSet = new Set(nodeIds);
	const topology = buildGraphTopology(definition);

	if (nodeIds.length === 0) pushError(diagnostics, "EMPTY_GRAPH", "Graph must define at least one node", "nodes");
	if (nodeIds.length === 1) {
		pushWarning(
			diagnostics,
			"SINGLE_NODE_GRAPH",
			"This graph has one node. Prefer a single agent loop unless persistence or human interruption is the actual requirement.",
			"nodes",
		);
	}

	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		validateNode(nodeId, node, diagnostics);
		if (node.type === "agent") {
			for (const problem of gatePolicyProblems(node, definition)) pushError(diagnostics, "GATE_POLICY", problem, `nodes.${nodeId}.gate`);
		}
	}
	for (const group of topology.targetGroups) {
		for (const target of group.targets) validateTarget(target, nodeSet, diagnostics, group.path);
	}

	const conditionalSources = new Set<string>();
	for (const [index, edge] of (definition.edges ?? []).entries()) {
		if (isConditionalEdge(edge)) {
			if (conditionalSources.has(edge.from)) {
				pushError(diagnostics, "DUPLICATE_CONDITIONAL_EDGE", `Node ${edge.from} has more than one conditional edge`, `edges.${index}.from`);
			}
			conditionalSources.add(edge.from);
			if (!nodeSet.has(edge.from)) {
				pushError(diagnostics, "CONDITIONAL_EDGE_SOURCE", `Unknown conditional edge source ${edge.from}`, `edges.${index}.from`);
			}
			for (const [caseIndex, item] of edge.cases.entries()) {
				validateCondition(item.when, diagnostics, `edges.${index}.cases.${caseIndex}.when`);
			}
		} else {
			for (const source of uniqueStrings(asStringArray(edge.from))) {
				if (!nodeSet.has(source)) pushError(diagnostics, "EDGE_SOURCE", `Unknown edge source ${source}`, `edges.${index}.from`);
			}
		}
	}
	if (!definition.limits) {
		pushWarning(
			diagnostics,
			"DEFAULT_LIMITS",
			"No limits configured. Structural steps and node runs are unbounded; set explicit limits for production graphs.",
			"limits",
		);
	}
	validateReachability(definition, topology.adjacency, diagnostics);
	validateAgentContexts(definition, diagnostics);
	validateThreadContextCompatibility(definition, diagnostics);
	validateParallelWrites(definition, topology.fanOutGroups, diagnostics);
	validateAccumulatingReducersInCycles(definition, topology.adjacency, diagnostics);
	validateParallelThreadContexts(definition, topology.fanOutGroups, diagnostics);
	return diagnostics;
}

function validateNode(nodeId: string, node: NodeDefinition, diagnostics: Diagnostic[]): void {
	const path = `nodes.${nodeId}`;
	if ((node.retry?.maxAttempts ?? 1) > 1 && node.idempotent !== true) {
		pushWarning(
			diagnostics,
			"RETRY_REQUIRES_IDEMPOTENCY",
			`${path} retries but does not declare idempotent: true. A crash or resume can re-run side effects.`,
			path,
		);
	}

	if (node.type === "agent") validateAgentNode(nodeId, node, diagnostics, path);
	else if (node.type === "human") validateHumanNode(node, diagnostics, path);
}

function validateAgentNode(nodeId: string, node: AgentNodeDefinition, diagnostics: Diagnostic[], path: string): void {
	if (node.purpose === "reviewer" && node.readOnly !== true) {
		pushWarning(
			diagnostics,
			"REVIEWER_NOT_READ_ONLY",
			`Reviewer node ${nodeId} should set readOnly: true so verification cannot mutate the work it reviews.`,
			path,
		);
	}
	if (node.purpose === "reviewer" && (node.context?.mode ?? "isolated") !== "isolated") {
		pushWarning(
			diagnostics,
			"REVIEWER_CONTEXT_NOT_ISOLATED",
			`Reviewer node ${nodeId} uses ${node.context?.mode} context. Use isolated context when the reviewer must remain independent from upstream agent history.`,
			`${path}.context.mode`,
		);
	}
	if (node.readOnly === true && node.tools?.some((tool) => !READ_ONLY_TOOL_SET.has(tool))) {
		pushError(
			diagnostics,
			"READ_ONLY_TOOLS",
			`Node ${nodeId} is read-only but requests a mutating or unknown tool. Allowed tools: ${READ_ONLY_TOOL_NAMES.join(", ")}.`,
			`${path}.tools`,
		);
	}
	if (node.loadExtensions === false && node.tools?.some((tool) => READ_ONLY_WEB_TOOL_SET.has(tool))) {
		pushError(
			diagnostics,
			"WEB_TOOLS_REQUIRE_EXTENSIONS",
			`Node ${nodeId} requests a web extension tool but loadExtensions is false.`,
			`${path}.loadExtensions`,
		);
	}
	if (node.response?.schema !== undefined) {
		if (node.response.format === "text") {
			pushError(
				diagnostics,
				"RESPONSE_SCHEMA_FORMAT",
				"response.schema implies JSON output and cannot be combined with format: text",
				`${path}.response.format`,
			);
		}
		for (const problem of jsonSchemaProblems(node.response.schema, `${path}.response.schema`)) {
			pushError(diagnostics, "RESPONSE_SCHEMA", problem, `${path}.response.schema`);
		}
	}
	if (node.response?.mediaType !== undefined && !node.response.mediaType.trim()) {
		pushError(diagnostics, "RESPONSE_MEDIA_TYPE", "response.mediaType must be non-empty", `${path}.response.mediaType`);
	}
	if (node.response?.storeOutput === false && node.output !== undefined) {
		pushWarning(
			diagnostics,
			"OUTPUT_PATH_IGNORED",
			`Node ${nodeId} sets response.storeOutput: false, so output path ${node.output} is not written.`,
			`${path}.output`,
		);
	}
	if ((node.response?.storage ?? "state") === "artifact" && node.response?.storeOutput === false) {
		pushError(
			diagnostics,
			"ARTIFACT_REFERENCE_NOT_STORED",
			`Node ${nodeId} requests artifact storage but disables its output write, so the artifact reference would be orphaned.`,
			`${path}.response.storeOutput`,
		);
	}
	validatePromptInputs(nodeId, node, diagnostics, path);
	validateAgentContextPolicy(nodeId, node, diagnostics, path);
}

function validatePromptInputs(nodeId: string, node: AgentNodeDefinition, diagnostics: Diagnostic[], path: string): void {
	const templatePaths = uniqueStrings([
		...safeTemplatePaths(node.prompt, diagnostics, `${path}.prompt`),
		...safeTemplatePaths(node.systemPrompt ?? "", diagnostics, `${path}.systemPrompt`),
	]);
	for (const [index, readPath] of (node.reads ?? []).entries()) {
		if (templatePaths.includes(readPath)) {
			pushWarning(
				diagnostics,
				"DUPLICATE_STATE_INJECTION",
				`Node ${nodeId} reads ${readPath} and also interpolates the same path; runtime omits the duplicate reads payload.`,
				`${path}.reads.${index}`,
			);
			continue;
		}
		const overlap = templatePaths.find((templatePath) => pathsOverlapForValidation(templatePath, readPath));
		if (overlap) {
			pushWarning(
				diagnostics,
				"OVERLAPPING_STATE_INJECTION",
				`Node ${nodeId} reads ${readPath} and interpolates overlapping path ${overlap}. Runtime does not auto-remove parent/child overlaps because that could discard sibling fields; select one input path explicitly.`,
				`${path}.reads.${index}`,
			);
		}
	}
}

function safeTemplatePaths(template: string, diagnostics: Diagnostic[], path: string): string[] {
	try {
		return extractTemplatePaths(template);
	} catch (error) {
		pushError(diagnostics, "TEMPLATE_PATH", String(error), path);
		return [];
	}
}

function validateAgentContextPolicy(
	nodeId: string,
	node: AgentNodeDefinition,
	diagnostics: Diagnostic[],
	path: string,
): void {
	const context = node.context;
	const mode = context?.mode ?? "isolated";
	if (context?.threadKey !== undefined) {
		if (mode !== "thread") {
			pushError(diagnostics, "THREAD_KEY_MODE", "context.threadKey is only valid for thread mode", `${path}.context.threadKey`);
		}
		validateThreadKey(context.threadKey, diagnostics, `${path}.context.threadKey`);
	}
	if (mode === "thread") {
		validateThreadKey(context?.threadKey ?? nodeId, diagnostics, `${path}.context.threadKey`);
		if ((node.retry?.maxAttempts ?? 1) > 1) {
			pushWarning(
				diagnostics,
				"THREAD_RETRY_APPENDS_HISTORY",
				`Thread node ${nodeId} retries in the same Pi session; a failed attempt can leave duplicate prompts or partial history.`,
				path,
			);
		}
	}
	if (mode !== "shared") {
		for (const field of ["messagesPath", "maxMessages", "maxPromptBytes", "maxMessageBytes", "maxStoredMessages", "capture"] as const) {
			if (context?.[field] !== undefined) {
				pushError(diagnostics, "SHARED_CONTEXT_FIELD", `context.${field} is only valid for shared mode`, `${path}.context.${field}`);
			}
		}
	}
	if (mode === "shared") {
		const messagesPath = context?.messagesPath ?? "messages";
		const capture = context?.capture ?? "compact";
		if (capture === "compact" && node.response?.storeOutput === false) {
			pushError(
				diagnostics,
				"SHARED_COMPACT_OUTPUT_REQUIRED",
				`Node ${nodeId} uses compact shared capture, which stores a reference to the node output. response.storeOutput must not be false.`,
				`${path}.response.storeOutput`,
			);
		}
		if (capture === "full") {
			pushWarning(
				diagnostics,
				"SHARED_FULL_CAPTURE",
				`Node ${nodeId} stores rendered prompts and process messages in graph state. Use compact capture unless full transcripts are explicitly required.`,
				`${path}.context.capture`,
			);
		}
		if ((capture === "assistant-only" || capture === "full") && node.response?.storeOutput !== false) {
			pushWarning(
				diagnostics,
				"SHARED_OUTPUT_DUPLICATED",
				`Node ${nodeId} stores its final output both at ${node.output ?? `outputs.${nodeId}`} and inline in ${messagesPath}. Use compact capture or set response.storeOutput: false to keep one canonical copy.`,
				`${path}.context.capture`,
			);
		}
		if ((node.response?.storage ?? "state") === "artifact" && (capture === "assistant-only" || capture === "full")) {
			pushWarning(
				diagnostics,
				"ARTIFACT_SHARED_INLINE_CAPTURE",
				`Node ${nodeId} stores its output as an artifact but shared capture ${capture} also keeps output text inline in graph state. Use compact capture to retain only the artifact reference.`,
				`${path}.context.capture`,
			);
		}
		if (node.reads?.some((readPath) => pathsOverlapForValidation(readPath, messagesPath))) {
			pushError(
				diagnostics,
				"SHARED_MESSAGES_DUPLICATE_READ",
				`Node ${nodeId} receives ${messagesPath} automatically through shared context and must not also include it in reads.`,
				`${path}.reads`,
			);
		}
		const templatePaths = uniqueStrings([
			...safeTemplatePaths(node.prompt, diagnostics, `${path}.prompt`),
			...safeTemplatePaths(node.systemPrompt ?? "", diagnostics, `${path}.systemPrompt`),
		]);
		if (templatePaths.some((templatePath) => pathsOverlapForValidation(templatePath, messagesPath))) {
			pushError(
				diagnostics,
				"SHARED_MESSAGES_DUPLICATE_TEMPLATE",
				`Node ${nodeId} receives ${messagesPath} automatically through shared context and must not also interpolate it in prompt or systemPrompt.`,
				path,
			);
		}
		const outputPath = node.output ?? `outputs.${nodeId}`;
		if (node.response?.storeOutput !== false && pathsOverlapForValidation(messagesPath, outputPath)) {
			pushError(
				diagnostics,
				"SHARED_OUTPUT_OVERLAP",
				`Shared messages path ${messagesPath} overlaps node output path ${outputPath}.`,
				path,
			);
		}
	}
}

function validateThreadKey(key: string, diagnostics: Diagnostic[], path: string): void {
	if (!key.trim()) {
		pushError(diagnostics, "THREAD_KEY", "threadKey must be non-empty", path);
		return;
	}
	if (key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
		pushError(diagnostics, "THREAD_KEY", "threadKey must be at most 128 characters and contain no control characters", path);
	}
	if (["__proto__", "prototype", "constructor"].includes(key)) {
		pushError(diagnostics, "THREAD_KEY", `${JSON.stringify(key)} is not an allowed threadKey`, path);
	}
}

function validateHumanNode(node: HumanNodeDefinition, diagnostics: Diagnostic[], path: string): void {
	const kind = node.kind ?? "input";
	if (kind === "select" && (!node.options || node.options.length === 0)) {
		pushError(diagnostics, "HUMAN_OPTIONS", "Select human node requires options", `${path}.options`);
	}
}

function validateCondition(condition: Condition, diagnostics: Diagnostic[], path: string): void {
	if ("all" in condition) {
		condition.all.forEach((item, index) => validateCondition(item, diagnostics, `${path}.all.${index}`));
		return;
	}
	if ("any" in condition) {
		condition.any.forEach((item, index) => validateCondition(item, diagnostics, `${path}.any.${index}`));
		return;
	}
	if ("not" in condition) {
		validateCondition(condition.not, diagnostics, `${path}.not`);
		return;
	}
	if (["exists", "truthy"].includes(condition.op) && condition.value !== undefined) {
		pushError(diagnostics, "CONDITION_VALUE", `Operator ${condition.op} does not accept value`, `${path}.value`);
	} else if (!["exists", "truthy"].includes(condition.op) && condition.value === undefined) {
		pushError(diagnostics, "CONDITION_VALUE", `Operator ${condition.op} requires value`, `${path}.value`);
	} else if (["gt", "gte", "lt", "lte"].includes(condition.op) && !["number", "string"].includes(typeof condition.value)) {
		pushError(diagnostics, "CONDITION_VALUE", `Operator ${condition.op} requires a number or string value`, `${path}.value`);
	} else if (condition.op === "matches") {
		if (typeof condition.value !== "string") {
			pushError(diagnostics, "CONDITION_VALUE", "Operator matches requires a string value", `${path}.value`);
		} else {
			try {
				new RegExp(condition.value);
			} catch {
				pushError(diagnostics, "CONDITION_REGEX", "Invalid regular expression", `${path}.value`);
			}
		}
	}
}

function buildGraphTopology(definition: GraphDefinition): GraphTopology {
	const targetGroups: GraphTargetGroup[] = [{ sources: [], targets: asStringArray(definition.entry), path: "entry" }];
	for (const [index, edge] of (definition.edges ?? []).entries()) {
		if (isConditionalEdge(edge)) {
			for (const [caseIndex, edgeCase] of edge.cases.entries()) {
				targetGroups.push({
					sources: [edge.from],
					targets: asStringArray(edgeCase.to),
					path: `edges.${index}.cases.${caseIndex}.to`,
				});
			}
			if (edge.default !== undefined) {
				targetGroups.push({ sources: [edge.from], targets: asStringArray(edge.default), path: `edges.${index}.default` });
			}
		} else {
			targetGroups.push({ sources: asStringArray(edge.from), targets: asStringArray(edge.to), path: `edges.${index}.to` });
		}
	}
	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		if (node.onError?.strategy !== "route" || node.onError.to === undefined) continue;
		targetGroups.push({ sources: [nodeId], targets: asStringArray(node.onError.to), path: `nodes.${nodeId}.onError.to` });
	}

	const adjacency = new Map<string, Set<string>>();
	for (const nodeId of Object.keys(definition.nodes)) adjacency.set(nodeId, new Set());
	for (const group of targetGroups) {
		for (const source of group.sources) {
			for (const target of group.targets) if (target !== END) adjacency.get(source)?.add(target);
		}
	}
	const fanOutGroups = targetGroups
		.map((group) => group.targets.filter((target) => target !== END))
		.filter((targets) => targets.length > 1);
	return { targetGroups, adjacency, fanOutGroups };
}

function validateReachability(definition: GraphDefinition, adjacency: Map<string, Set<string>>, diagnostics: Diagnostic[]): void {
	const reached = new Set<string>();
	const queue = asStringArray(definition.entry).filter((item) => item !== END);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || reached.has(current)) continue;
		reached.add(current);
		for (const next of adjacency.get(current) ?? []) if (!reached.has(next)) queue.push(next);
	}
	for (const nodeId of Object.keys(definition.nodes)) {
		if (!reached.has(nodeId)) pushWarning(diagnostics, "UNREACHABLE_NODE", `Node ${nodeId} is unreachable from entry`, `nodes.${nodeId}`);
	}
}

function validateAgentContexts(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	const retentionByPath = new Map<string, { value: number; nodeId: string }>();
	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		if (node.type !== "agent" || (node.context?.mode ?? "isolated") !== "shared") continue;
		if ((node.context?.capture ?? "compact") === "none") continue;
		const messagesPath = node.context?.messagesPath ?? "messages";
		const maxStoredMessages = node.context?.maxStoredMessages;
		if (maxStoredMessages !== undefined) {
			const existing = retentionByPath.get(messagesPath);
			if (existing && existing.value !== maxStoredMessages) {
				pushWarning(
					diagnostics,
					"SHARED_RETENTION_MISMATCH",
					`Shared message channel ${messagesPath} uses different maxStoredMessages values (${existing.value} on ${existing.nodeId}, ${maxStoredMessages} on ${nodeId}); runtime applies the smaller bound.`,
					`nodes.${nodeId}.context.maxStoredMessages`,
				);
			} else if (!existing) {
				retentionByPath.set(messagesPath, { value: maxStoredMessages, nodeId });
			}
		}
		const reducer = definition.reducers?.[messagesPath];
		if (reducer !== undefined && reducer !== "concat") {
			pushError(
				diagnostics,
				"SHARED_MESSAGES_REDUCER",
				`Shared message channel ${messagesPath} requires the concat reducer, not ${reducer}.`,
				`reducers.${messagesPath}`,
			);
		}
	}
}

function validateThreadContextCompatibility(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	const threads = new Map<string, { cwd: string; nodes: string[] }>();
	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		if (node.type !== "agent" || (node.context?.mode ?? "isolated") !== "thread") continue;
		const key = node.context?.threadKey ?? nodeId;
		const cwd = normalizeThreadCwd(node.cwd);
		const existing = threads.get(key);
		if (!existing) {
			threads.set(key, { cwd, nodes: [nodeId] });
			continue;
		}
		existing.nodes.push(nodeId);
		if (existing.cwd !== cwd) {
			pushError(
				diagnostics,
				"THREAD_CWD_MISMATCH",
				`Thread context ${JSON.stringify(key)} is shared by nodes with different cwd values (${existing.cwd} and ${cwd}). A Pi session has one durable working directory.`,
				`nodes.${nodeId}.cwd`,
			);
		}
	}
}

function normalizeThreadCwd(cwd: string | undefined): string {
	return pathPosix.normalize((cwd?.trim() || ".").replaceAll("\\", "/"));
}

/**
 * Un-declared agent context.mode now defaults to "thread" (persistent per-node
 * role memory). Explicit isolated/shared declarations are untouched. Applied
 * before validation and hashing so downstream `?? "isolated"` fallbacks and
 * the graph hash see the resolved mode.
 */
function applyDefaultContextMode(graph: JsonObject): void {
	const nodes = graph.nodes;
	if (!isJsonObject(nodes)) return;
	for (const node of Object.values(nodes)) {
		if (!isJsonObject(node) || node.type !== "agent") continue;
		const context = node.context;
		if (!isJsonObject(context)) {
			node.context = { mode: "thread" };
			continue;
		}
		if (context.mode === undefined) context.mode = "thread";
	}
}

function resolveEffectiveReducers(definition: GraphDefinition): Record<string, ReducerName> {
	const reducers = { ...(definition.reducers ?? {}) };
	for (const node of Object.values(definition.nodes)) {
		if (node.type !== "agent" || (node.context?.mode ?? "isolated") !== "shared") continue;
		if ((node.context?.capture ?? "compact") === "none") continue;
		const messagesPath = node.context?.messagesPath ?? "messages";
		reducers[messagesPath] ??= "concat";
	}
	return reducers;
}

function validateParallelThreadContexts(definition: GraphDefinition, fanOutGroups: string[][], diagnostics: Diagnostic[]): void {
	for (const group of fanOutGroups) {
		const byKey = new Map<string, string[]>();
		for (const nodeId of group) {
			const node = definition.nodes[nodeId];
			if (!node || node.type !== "agent" || (node.context?.mode ?? "isolated") !== "thread") continue;
			const key = node.context?.threadKey ?? nodeId;
			const nodes = byKey.get(key) ?? [];
			nodes.push(nodeId);
			byKey.set(key, nodes);
		}
		for (const [key, nodes] of byKey) {
			if (nodes.length > 1) {
				pushError(
					diagnostics,
					"PARALLEL_THREAD_CONTEXT",
					`Parallel nodes ${nodes.join(", ")} share threadKey ${JSON.stringify(key)}. A persistent Pi session cannot be used concurrently.`,
					"nodes",
				);
			}
		}
	}
}

function validateAccumulatingReducersInCycles(
	definition: GraphDefinition,
	adjacency: Map<string, Set<string>>,
	diagnostics: Diagnostic[],
): void {
	const cyclicNodes = findCyclicNodes(definition, adjacency);
	if (cyclicNodes.size === 0) return;
	const reducers = resolveEffectiveReducers(definition);
	for (const [path, reducer] of Object.entries(reducers)) {
		if (reducer !== "append" && reducer !== "concat") continue;
		const writers = Object.entries(definition.nodes)
			.filter(([nodeId, node]) => cyclicNodes.has(nodeId) && directWritePaths(nodeId, node).includes(path))
			.map(([nodeId]) => nodeId);
		if (writers.length === 0) continue;
		if (reducer === "concat" && isBoundedSharedChannel(definition, path, writers)) continue;
		pushWarning(
			diagnostics,
			"ACCUMULATING_REDUCER_IN_CYCLE",
			`State path ${path} uses ${reducer} and is written by cyclic node(s) ${writers.join(", ")}; values survive each loop iteration. Use collect for current-round fan-in, overwrite/unset cleanup, or a bounded shared-message channel.`,
			`reducers.${path}`,
		);
	}
}

function isBoundedSharedChannel(definition: GraphDefinition, path: string, writers: string[]): boolean {
	return writers.every((nodeId) => {
		const node = definition.nodes[nodeId];
		return (
			node?.type === "agent" &&
			(node.context?.mode ?? "isolated") === "shared" &&
			(node.context?.capture ?? "compact") !== "none" &&
			(node.context?.messagesPath ?? "messages") === path &&
			node.context?.maxStoredMessages !== undefined
		);
	});
}

function findCyclicNodes(definition: GraphDefinition, adjacency: Map<string, Set<string>>): Set<string> {
	const cyclic = new Set<string>();
	for (const nodeId of Object.keys(definition.nodes)) {
		const queue = [...(adjacency.get(nodeId) ?? [])];
		const visited = new Set<string>();
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current || visited.has(current)) continue;
			if (current === nodeId) {
				cyclic.add(nodeId);
				break;
			}
			visited.add(current);
			queue.push(...(adjacency.get(current) ?? []));
		}
	}
	return cyclic;
}

function validateParallelWrites(definition: GraphDefinition, fanOutGroups: string[][], diagnostics: Diagnostic[]): void {
	const reducers = resolveEffectiveReducers(definition);
	for (const group of fanOutGroups) {
		const paths = new Map<string, string[]>();
		for (const nodeId of group) {
			const node = definition.nodes[nodeId];
			if (!node) continue;
			for (const path of directWritePaths(nodeId, node)) {
				const writers = paths.get(path) ?? [];
				writers.push(nodeId);
				paths.set(path, writers);
			}
		}
		for (const [path, writers] of paths) {
			if (writers.length > 1 && reducers[path] === undefined) {
				pushWarning(
					diagnostics,
					"POSSIBLE_PARALLEL_STATE_CONFLICT",
					`Parallel nodes ${writers.join(", ")} may write ${path}. Add a reducer or use distinct output paths.`,
					`reducers.${path}`,
				);
			}
		}
	}
}

function directWritePaths(nodeId: string, node: NodeDefinition): string[] {
	if (node.type === "set") return node.assign.map((assignment) => assignment.path);
	const paths = node.type === "agent" && node.response?.storeOutput === false ? [] : [node.output ?? `outputs.${nodeId}`];
	if (
		node.type === "agent" &&
		(node.context?.mode ?? "isolated") === "shared" &&
		(node.context?.capture ?? "compact") !== "none"
	) {
		paths.push(node.context?.messagesPath ?? "messages");
	}
	return paths;
}

function pathsOverlapForValidation(leftPath: string, rightPath: string): boolean {
	try {
		return statePathsOverlap(leftPath, rightPath);
	} catch {
		// Structural validation already rejects malformed paths.
		return false;
	}
}

function validateTarget(target: string, nodeSet: Set<string>, diagnostics: Diagnostic[], path: string): void {
	if (target !== END && !nodeSet.has(target)) pushError(diagnostics, "UNKNOWN_TARGET", `Unknown target ${target}`, path);
}

function pushError(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
	diagnostics.push({ level: "error", code, message, path });
}

function pushWarning(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
	diagnostics.push({ level: "warning", code, message, path });
}

export function graphUsesMutatingTools(definition: GraphDefinition): boolean {
	for (const node of Object.values(definition.nodes)) {
		if (node.type !== "agent") continue;
		if (node.loadExtensions !== false) return true;
		if (node.readOnly === true) continue;
		const tools = node.tools ?? DEFAULT_AGENT_TOOL_NAMES;
		if (tools.some((tool) => !READ_ONLY_TOOL_SET.has(tool))) return true;
	}
	return false;
}
