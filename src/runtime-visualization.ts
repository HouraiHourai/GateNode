import type {
	CheckpointSnapshot,
	GraphDefinition,
	GraphRunEvent,
	GraphStatus,
	NodeRunHistory,
	TokenUsageLedger,
} from "./types.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { usageTokens } from "./utils.ts";

export type RuntimeNodeStatus =
	| "waiting"
	| "queued"
	| "running"
	| "retrying"
	| "completed"
	| "failed"
	| "interrupted"
	| "cancelled";

export interface RuntimeGraphLink {
	target: string;
	kind: "edge" | "conditional" | "error";
}

export interface RuntimeNodeView {
	id: string;
	type: "agent" | "set" | "human";
	status: RuntimeNodeStatus;
	step?: number;
	attempt?: number;
	runs: number;
	elapsedMs?: number;
	updatedAtMs: number;
	message?: string;
	/** Most recent in-node activity messages (latest last), memory-only trail. */
	activities: string[];
	processed: boolean;
	links: RuntimeGraphLink[];
}

export interface RuntimeGraphView {
	graphName: string;
	runId?: string;
	status: GraphStatus;
	step: number;
	nodeRuns: number;
	elapsedMs: number;
	usage: TokenUsageLedger;
	message?: string;
	nodes: RuntimeNodeView[];
}

interface MutableRuntimeNode {
	id: string;
	type: RuntimeNodeView["type"];
	status: RuntimeNodeStatus;
	step?: number;
	attempt?: number;
	runs: number;
	startedAtMs?: number;
	endedAtMs?: number;
	updatedAtMs: number;
	message?: string;
	activities: string[];
	processed: boolean;
	links: RuntimeGraphLink[];
}

interface RuntimeGraphMonitorOptions {
	checkpoint?: CheckpointSnapshot;
	now?: () => number;
}

interface RenderRuntimeGraphOptions {
	maxLines?: number;
	maxLineLength?: number;
}

const ACTIVE_NODE_STATUSES = new Set<RuntimeNodeStatus>(["running", "retrying"]);
const TERMINAL_NODE_STATUSES = new Set<RuntimeNodeStatus>(["completed", "failed", "interrupted", "cancelled"]);
/** Statuses whose node line carries an inline message and therefore a trail. */
const SHOWS_MESSAGE_STATUSES = new Set<RuntimeNodeStatus>(["running", "retrying", "failed", "interrupted"]);
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 300;
const DEFAULT_MAX_LINES = 18;
const DEFAULT_MAX_LINE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 160;
/** Per-node rolling activity trail kept in monitor memory (never persisted). */
const ACTIVITY_TRAIL_LENGTH = 3;
/** Max trailing activity lines below the shape diagram. */
const MAX_TRAIL_LINES = 5;
const CYCLE_JOIN = " ⇄ ";
const LAYER_JOIN = "   ";

export class RuntimeGraphMonitor {
	private readonly definition: GraphDefinition;
	private readonly now: () => number;
	private readonly nodes = new Map<string, MutableRuntimeNode>();
	private readonly invocationStartedAtMs: number;
	private baseElapsedMs = 0;
	private endedAtMs: number | undefined;
	private runId: string | undefined;
	private status: GraphStatus = "running";
	private step = 0;
	private nodeRuns = 0;
	private usage: TokenUsageLedger = emptyTokenUsage();
	private message: string | undefined;

	constructor(definition: GraphDefinition, options: RuntimeGraphMonitorOptions = {}) {
		this.definition = definition;
		this.now = options.now ?? Date.now;
		this.invocationStartedAtMs = this.now();
		const links = collectLinks(definition);
		for (const [id, node] of Object.entries(definition.nodes)) {
			this.nodes.set(id, {
				id,
				type: node.type,
				status: "waiting",
				runs: 0,
				updatedAtMs: this.invocationStartedAtMs,
				processed: false,
				links: links.get(id) ?? [],
				activities: [],
			});
		}
		if (options.checkpoint) this.hydrate(options.checkpoint);
	}

	apply(event: GraphRunEvent): void {
		const changedAtMs = this.now();
		this.runId = event.runId || this.runId;
		if (event.step !== undefined) this.step = event.step;
		if (event.usage) this.usage = copyTokenUsage(event.usage);

		switch (event.type) {
			case "graph_start":
				this.status = "running";
				this.endedAtMs = undefined;
				break;
			case "step_start":
				for (const nodeId of event.scheduled ?? []) this.updateNode(nodeId, "queued", event, changedAtMs);
				break;
			case "node_start": {
				const node = this.updateNode(event.nodeId, "running", event, changedAtMs);
				if (node) {
					this.nodeRuns += 1;
					if ((event.attempt ?? 1) === 1) node.runs += 1;
					node.startedAtMs = changedAtMs;
					node.endedAtMs = undefined;
					node.message = undefined;
					node.activities = [];
					node.processed = false;
				}
				break;
			}
			case "node_retry": {
				const node = this.updateNode(event.nodeId, "retrying", event, changedAtMs);
				if (node && event.message !== undefined) {
					const message = truncateMessage(event.message);
					node.message = message;
					if (message !== undefined && node.activities.at(-1) !== message) {
						node.activities.push(message);
						if (node.activities.length > ACTIVITY_TRAIL_LENGTH) node.activities.shift();
					}
				}
				break;
			}
			case "node_activity": {
				const node = event.nodeId ? this.nodes.get(event.nodeId) : undefined;
				if (node && event.message !== undefined) {
					const message = truncateMessage(event.message);
					node.message = message;
					node.updatedAtMs = changedAtMs;
					if (message !== undefined && node.activities.at(-1) !== message) {
						node.activities.push(message);
						if (node.activities.length > ACTIVITY_TRAIL_LENGTH) node.activities.shift();
					}
				}
				break;
			}
			case "node_settled": {
				const status = nodeStatusFromEvent(event.status);
				const node = status ? this.updateNode(event.nodeId, status, event, changedAtMs) : undefined;
				if (node) node.endedAtMs = changedAtMs;
				break;
			}
			case "node_end": {
				const status = nodeStatusFromEvent(event.status);
				const node = status ? this.updateNode(event.nodeId, status, event, changedAtMs) : undefined;
				if (node) {
					node.endedAtMs ??= changedAtMs;
					node.processed = true;
				}
				break;
			}
			case "interrupt": {
				const node = this.updateNode(event.nodeId, "interrupted", event, changedAtMs);
				if (node) node.endedAtMs ??= changedAtMs;
				this.status = "interrupted";
				break;
			}
			case "graph_end":
				this.status = graphStatusFromEvent(event.status) ?? this.status;
				this.message = truncateMessage(event.message);
				this.endedAtMs = changedAtMs;
				this.finishActiveNodes(changedAtMs);
				break;
			case "checkpoint":
			case "usage_update":
			case "step_end":
				break;
		}
	}

	view(): RuntimeGraphView {
		const now = this.now();
		const invocationEnd = this.endedAtMs ?? now;
		return {
			graphName: this.definition.name,
			runId: this.runId,
			status: this.status,
			step: this.step,
			nodeRuns: this.nodeRuns,
			elapsedMs: this.baseElapsedMs + Math.max(0, invocationEnd - this.invocationStartedAtMs),
			usage: copyTokenUsage(this.usage),
			message: this.message,
			nodes: [...this.nodes.values()].map((node) => ({
				id: node.id,
				type: node.type,
				status: node.status,
				step: node.step,
				attempt: node.attempt,
				runs: node.runs,
				elapsedMs:
					node.startedAtMs === undefined
						? undefined
						: Math.max(0, (node.endedAtMs ?? now) - node.startedAtMs),
				updatedAtMs: node.updatedAtMs,
				message: node.message,
				activities: [...node.activities],
				processed: node.processed,
				links: node.links.map((link) => ({ ...link })),
			})),
		};
	}

	private hydrate(checkpoint: CheckpointSnapshot): void {
		this.runId = checkpoint.runId;
		this.status = checkpoint.status;
		this.step = checkpoint.step;
		this.nodeRuns = checkpoint.nodeRuns;
		this.usage = copyTokenUsage(checkpoint.usage);
		this.baseElapsedMs = checkpoint.activeTimeMs;
		for (const history of checkpoint.history) this.hydrateHistory(history);
		if (checkpoint.inFlight) {
			for (const nodeId of Object.keys(checkpoint.inFlight.completed)) {
				const node = this.nodes.get(nodeId);
				if (node?.status === "waiting") node.status = "completed";
			}
			for (const nodeId of checkpoint.inFlight.unresolved) {
				const node = this.nodes.get(nodeId);
				if (node) {
					node.status = "queued";
					node.step = checkpoint.inFlight.step;
				}
			}
		} else {
			for (const nodeId of checkpoint.pending) {
				const node = this.nodes.get(nodeId);
				if (node) node.status = "queued";
			}
		}
		if (checkpoint.interrupt) {
			const node = this.nodes.get(checkpoint.interrupt.nodeId);
			if (node) {
				node.status = "interrupted";
				node.message = truncateMessage(checkpoint.interrupt.prompt);
			}
		}
	}

	private hydrateHistory(history: NodeRunHistory): void {
		const node = this.nodes.get(history.nodeId);
		if (!node) return;
		node.status = history.status;
		node.step = history.step;
		node.attempt = history.attempts;
		node.runs += 1;
		node.startedAtMs = parseTimestamp(history.startedAt);
		node.endedAtMs = parseTimestamp(history.endedAt);
		node.updatedAtMs = node.endedAtMs ?? this.invocationStartedAtMs;
		node.message = truncateMessage(history.error);
		node.processed = true;
	}

	private updateNode(
		nodeId: string | undefined,
		status: RuntimeNodeStatus,
		event: GraphRunEvent,
		changedAtMs: number,
	): MutableRuntimeNode | undefined {
		if (!nodeId) return undefined;
		const node = this.nodes.get(nodeId);
		if (!node) return undefined;
		node.status = status;
		node.step = event.step ?? node.step;
		node.attempt = event.attempt ?? node.attempt;
		node.updatedAtMs = changedAtMs;
		if (event.message !== undefined) node.message = truncateMessage(event.message);
		return node;
	}

	private finishActiveNodes(changedAtMs: number): void {
		for (const node of this.nodes.values()) {
			if (node.status !== "queued" && !ACTIVE_NODE_STATUSES.has(node.status)) continue;
			node.status =
				node.status === "queued" || this.status === "cancelled"
					? "cancelled"
					: this.status === "interrupted"
						? "interrupted"
						: "failed";
			node.endedAtMs ??= changedAtMs;
			node.updatedAtMs = changedAtMs;
		}
	}
}

export function renderRuntimeGraph(view: RuntimeGraphView, options: RenderRuntimeGraphOptions = {}): string[] {
	const maxLines = Math.max(4, options.maxLines ?? DEFAULT_MAX_LINES);
	const maxLineLength = Math.max(40, options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH);
	const runId = view.runId ? ` · ${view.runId.slice(0, 8)}` : "";
	const spinner =
		view.status === "running"
			? `${SPINNER_FRAMES[Math.floor(view.elapsedMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]} `
			: "";
	const lines = [
		truncateToWidth(
			`${spinner}pig · ${view.graphName} · ${view.status.toUpperCase()} · step ${view.step}${runId} · ${formatDuration(view.elapsedMs)}`,
			maxLineLength,
			"…",
		),
	];
	const active = view.nodes.filter((node) => ACTIVE_NODE_STATUSES.has(node.status)).length;
	const done = view.nodes.filter((node) => TERMINAL_NODE_STATUSES.has(node.status)).length;
	lines.push(
		truncateToWidth(
			`active ${active} · done ${done}/${view.nodes.length} · runs ${view.nodeRuns} · ${formatTokens(usageTokens(view.usage))} tok`,
			maxLineLength,
			"…",
		),
	);

	// Topology shape: layered rows (cycles joined inline) + connector arrows.
	lines.push(...renderGraphShape(view.nodes, maxLineLength));

	// Activity log below the shape: thin rule separator, grouped by node —
	// the node name appears once per group, its activities listed beneath.
	const trailNodes = view.nodes
		.filter((node) => SHOWS_MESSAGE_STATUSES.has(node.status) && node.activities.length > 0)
		.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
	const plain = (text: string): string =>
		truncateToWidth(text, maxLineLength, "…").replace(/\u001b\[[0-9;]*m/g, "");
	if (trailNodes.length > 0) lines.push("─".repeat(Math.min(24, maxLineLength)));
	const showNames = trailNodes.length > 1;
	let emitted = 0;
	for (const node of trailNodes) {
		if (emitted >= MAX_TRAIL_LINES) break;
		const activities = node.activities.slice(-Math.min(ACTIVITY_TRAIL_LENGTH, MAX_TRAIL_LINES - emitted));
		if (showNames) {
			lines.push(plain(`${nodeGlyph(node.status)} ${node.id}`));
			emitted += 1;
		}
		for (const activity of activities) {
			lines.push(plain(`  ${activity}`));
			emitted += 1;
		}
	}
	return lines.slice(0, maxLines);
}

/**
 * Layered topology rendering: nodes are grouped into strongly connected
 * components (cycle members render inline joined by ⇄), components are
 * layered by longest-path depth, and connector rows draw │/↘/↙ arrows.
 */
function renderGraphShape(nodes: RuntimeNodeView[], maxLineLength: number): string[] {
	if (nodes.length === 0) return [];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const orderIndex = new Map(nodes.map((node, index) => [node.id, index]));

	// Intra-graph edges only (__end__ targets excluded).
	const seen = new Set<string>();
	const edges: Array<[string, string]> = [];
	for (const node of nodes) {
		for (const link of node.links) {
			if (!byId.has(link.target) || link.target === node.id) continue;
			const key = `${node.id}->${link.target}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push([node.id, link.target]);
		}
	}

	const sccs = stronglyConnectedComponents(
		nodes.map((node) => node.id),
		edges,
	);
	// Effective components for layout: small cycles stay inline (cycle-joined);
	// oversized tangles unroll into per-node components with forward-only edges.
	const MAX_INLINE_CYCLE = 5;
	const effCompOf = new Map<string, number>();
	const effMembers = new Map<number, string[]>();
	let singletonId = 0;
	sccs.forEach((component, index) => {
		if (component.length <= MAX_INLINE_CYCLE) {
			effMembers.set(index, component);
			for (const id of component) effCompOf.set(id, index);
		} else {
			for (const id of component) {
				const singleton = 10_000 + singletonId++;
				effMembers.set(singleton, [id]);
				effCompOf.set(id, singleton);
			}
		}
	});
	const sccIndexOf = new Map<string, number>();
	sccs.forEach((component, index) => {
		for (const id of component) sccIndexOf.set(id, index);
	});
	const layoutEdges = edges.filter(([from, to]) => {
		const fromScc = sccIndexOf.get(from);
		if (fromScc === undefined || fromScc !== sccIndexOf.get(to)) return true;
		return (sccs[fromScc]?.length ?? 0) > MAX_INLINE_CYCLE
			? (orderIndex.get(to) ?? 0) > (orderIndex.get(from) ?? 0)
			: false;
	});

	// Condensed DAG between effective components.
	const condensed = new Map<number, Set<number>>();
	for (const [from, to] of layoutEdges) {
		const fromComp = effCompOf.get(from);
		const toComp = effCompOf.get(to);
		if (fromComp === undefined || toComp === undefined || fromComp === toComp) continue;
		const targets = condensed.get(fromComp) ?? new Set<number>();
		targets.add(toComp);
		condensed.set(fromComp, targets);
	}

	// Longest-path layering on the condensed DAG (acyclic by construction).
	const layerOf = new Map<number, number>();
	const layerOfComponent = (component: number): number => {
		const memo = layerOf.get(component);
		if (memo !== undefined) return memo;
		let depth = 0;
		for (const [source, targets] of condensed) {
			if (targets.has(component)) depth = Math.max(depth, layerOfComponent(source) + 1);
		}
		layerOf.set(component, depth);
		return depth;
	};
	for (const component of effMembers.keys()) layerOfComponent(component);

	// Components grouped into rows by layer, ordered by first definition index.
	const rowsByLayer = new Map<number, number[]>();
	for (const component of effMembers.keys()) {
		const depth = layerOf.get(component) ?? 0;
		const row = rowsByLayer.get(depth) ?? [];
		row.push(component);
		rowsByLayer.set(depth, row);
	}
	const firstIndex = (component: number) =>
		Math.min(...(effMembers.get(component) ?? []).map((id) => orderIndex.get(id) ?? 0));
	const sortedLayers = [...rowsByLayer.keys()].sort((left, right) => left - right);
	for (const depth of sortedLayers) {
		rowsByLayer.get(depth)?.sort((left, right) => firstIndex(left) - firstIndex(right));
	}

	// Chip rows with absolute center columns. Cycle members carry the join
	// glyph (e.g. "⇄") that slotRow paints in the reserved gap.
	const chipRows: Array<Array<{ id: string; label: string; center: number; joinBefore: string }>> = [];
	for (const depth of sortedLayers) {
		const chips: Array<{ id: string; label: string; center: number; joinBefore: string }> = [];
		let column = 0;
		const components = rowsByLayer.get(depth) ?? [];
		for (const [componentIndex, component] of components.entries()) {
			if (componentIndex > 0) column += LAYER_JOIN.length;
			const members = [...(effMembers.get(component) ?? [])].sort(
				(left, right) => (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0),
			);
			for (const [memberIndex, memberId] of members.entries()) {
				const joinBefore = memberIndex > 0 ? CYCLE_JOIN : "";
				if (memberIndex > 0) column += CYCLE_JOIN.length;
				const label = chipLabel(byId.get(memberId));
				chips.push({ id: memberId, label, center: column + Math.floor(label.length / 2), joinBefore });
				column += label.length;
			}
		}
		chipRows.push(chips);
	}
	const rowOfComponent = new Map<number, number>();
	sortedLayers.forEach((depth, rowIndex) => {
		for (const component of rowsByLayer.get(depth) ?? []) rowOfComponent.set(component, rowIndex);
	});

	// Align each row under its incoming edge sources, chip by chip: a chip
	// slides to the barycenter of the parents that target IT (not its row's
	// left edge), then the row is re-spaced so chips never overlap and the
	// leftmost chip stays at column >= 0. This keeps plan→execution vertical.
	const chipCenterOf = (id: string): number | undefined => {
		for (const chips of chipRows) {
			const chip = chips.find((entry) => entry.id === id);
			if (chip) return chip.center;
		}
		return undefined;
	};
	for (let rowIndex = 1; rowIndex < chipRows.length; rowIndex += 1) {
		const chips = chipRows[rowIndex];
		if (chips.length === 0) continue;
		const parentsOf = new Map<string, number[]>();
		for (const chip of chips) {
			const component = effCompOf.get(chip.id);
			if (component === undefined) continue;
			for (const [source, target] of layoutEdges) {
				if (effCompOf.get(target) !== component) continue;
				const sourceX = chipCenterOf(source);
				if (sourceX !== undefined) {
					const list = parentsOf.get(chip.id) ?? [];
					list.push(sourceX);
					parentsOf.set(chip.id, list);
				}
			}
		}
		if (parentsOf.size === 0) continue;
		// Desired center per chip: parent barycenter, else keep current.
		const desired = chips.map((chip) => {
			const parents = parentsOf.get(chip.id);
			if (!parents || parents.length === 0) return chip.center;
			return parents.reduce((sum, value) => sum + value, 0) / parents.length;
		});
		// Greedy left-to-right placement: honor desired centers, enforce gaps.
		const minGap = 2;
		let placed: Array<{ chip: (typeof chips)[number]; center: number }> = [];
		for (let index = 0; index < chips.length; index += 1) {
			const chip = chips[index];
			let label = chip.label;
			const available = Math.max(12, maxLineLength - 8);
			if (label.length > available) {
				label = `${label.slice(0, available - 1)}…`;
				chip.label = label;
			}
			const half = Math.floor(label.length / 2);
			let center = Math.round(desired[index]);
			const previous = placed[placed.length - 1];
			const joinWidth = chip.joinBefore ? CYCLE_JOIN.length : minGap;
			if (previous) {
				// previous label end (ceil half) + join glyph + our half.
				const previousHalfEnd = Math.ceil(previous.chip.label.length / 2);
				const minCenter = previous.center + previousHalfEnd + joinWidth + half;
				if (center < minCenter) center = minCenter;
			}
			center = Math.max(half, center);
			placed.push({ chip, center });
			chip.center = center;
		}
	}

	// Connector rows between adjacent chip rows.
	const connectors: string[][] = chipRows.slice(0, -1).map(() => [] as string[]);
	const chipCenter = (id: string): number | undefined => {
		for (const chips of chipRows) {
			const chip = chips.find((entry) => entry.id === id);
			if (chip) return chip.center;
		}
		return undefined;
	};
	const place = (rowIndex: number, column: number, glyph: string): void => {
		const cells = connectors[rowIndex];
		if (!cells) return;
		while (cells.length < column) cells.push(" ");
		if (cells[column] === undefined || cells[column] === " ") cells[column] = glyph;
	};
	for (const [from, to] of layoutEdges) {
		const fromComp = effCompOf.get(from);
		const toComp = effCompOf.get(to);
		if (fromComp === undefined || toComp === undefined || fromComp === toComp) continue;
		const fromRow = rowOfComponent.get(fromComp) ?? 0;
		const toRow = rowOfComponent.get(toComp) ?? 0;
		if (toRow <= fromRow) continue;
		const sourceX = chipCenter(from);
		const targetX = chipCenter(to);
		if (sourceX === undefined || targetX === undefined) continue;
		for (let row = fromRow; row < toRow; row += 1) {
			const last = row === toRow - 1;
			const glyph = !last ? "│" : targetX > sourceX ? "↘" : targetX < sourceX ? "↙" : "│";
			place(row, sourceX, glyph);
		}
	}

	// Emit chip rows rebuilt from column slots (preserves inter-chip spacing),
	// interleaved with connector rows.
	const slotRow = (chips: Array<{ label: string; center: number; joinBefore: string }>): string => {
		const cells: string[] = [];
		const paint = (text: string, at: number): void => {
			for (let index = 0; index < text.length; index += 1) {
				const target = at + index;
				while (cells.length < target) cells.push(" ");
				cells[target] = text[index];
			}
		};
		for (const chip of chips) {
			const start = chip.center - Math.floor(chip.label.length / 2);
			if (chip.joinBefore) paint(chip.joinBefore, start - chip.joinBefore.length);
			paint(chip.label, start);
		}
		return cells.join("");
	};
	const plain = (text: string): string =>
		truncateToWidth(text, maxLineLength, "…").replace(/\u001b\[[0-9;]*m/g, "");
	const shapeLines: string[] = [];
	chipRows.forEach((chips, rowIndex) => {
		shapeLines.push(plain(slotRow(chips)));
		const connector = connectors[rowIndex];
		if (connector) shapeLines.push(plain(connector.join("").trimEnd()));
	});
	return shapeLines;
}

/** Chip label for the shape view: glyph + id (+ time/runs when notable). */
function chipLabel(node: RuntimeNodeView | undefined): string {
	if (!node) return "?";
	let label = `${nodeGlyph(node.status)} ${node.id}`;
	if (ACTIVE_NODE_STATUSES.has(node.status) && node.elapsedMs !== undefined) {
		label += `·${formatDuration(node.elapsedMs)}`;
	} else if (node.runs > 1) {
		label += `·×${node.runs}`;
	}
	return label;
}

/** Tarjan strongly connected components over a small node set. */
function stronglyConnectedComponents(ids: string[], edges: Array<[string, string]>): string[][] {
	const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
	for (const [from, to] of edges) adjacency.get(from)?.push(to);
	let index = 0;
	const indices = new Map<string, number>();
	const lowlinks = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const components: string[][] = [];
	const strongConnect = (nodeId: string): void => {
		indices.set(nodeId, index);
		lowlinks.set(nodeId, index);
		index += 1;
		stack.push(nodeId);
		onStack.add(nodeId);
		for (const next of adjacency.get(nodeId) ?? []) {
			if (!indices.has(next)) {
				strongConnect(next);
				lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId)!, lowlinks.get(next)!));
			} else if (onStack.has(next)) {
				lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId)!, indices.get(next)!));
			}
		}
		if (lowlinks.get(nodeId) === indices.get(nodeId)) {
			const component: string[] = [];
			let member: string;
			do {
				member = stack.pop()!;
				onStack.delete(member);
				component.push(member);
			} while (member !== nodeId);
			components.push(component);
		}
	};
	for (const id of ids) if (!indices.has(id)) strongConnect(id);
	return components;
}

function collectLinks(definition: GraphDefinition): Map<string, RuntimeGraphLink[]> {
	const result = new Map<string, RuntimeGraphLink[]>();
	for (const nodeId of Object.keys(definition.nodes)) result.set(nodeId, []);
	const add = (source: string, target: string, kind: RuntimeGraphLink["kind"]) => {
		const links = result.get(source);
		if (!links || links.some((link) => link.target === target && link.kind === kind)) return;
		links.push({ target, kind });
	};
	for (const edge of definition.edges ?? []) {
		if ("cases" in edge) {
			for (const edgeCase of edge.cases) {
				const targets = Array.isArray(edgeCase.to) ? edgeCase.to : [edgeCase.to];
				for (const target of targets) add(edge.from, displayTarget(target), "conditional");
			}
			if (edge.default !== undefined) {
				const targets = Array.isArray(edge.default) ? edge.default : [edge.default];
				for (const target of targets) add(edge.from, displayTarget(target), "conditional");
			}
		} else {
			const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
			const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
			for (const source of sources) for (const target of targets) add(source, displayTarget(target), "edge");
		}
	}
	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		if (node.onError?.strategy !== "route" || node.onError.to === undefined) continue;
		const targets = Array.isArray(node.onError.to) ? node.onError.to : [node.onError.to];
		for (const target of targets) add(nodeId, displayTarget(target), "error");
	}
	return result;
}




function nodeGlyph(status: RuntimeNodeStatus): string {
	if (status === "queued") return "◌";
	if (status === "running") return "●";
	if (status === "retrying") return "↻";
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "interrupted") return "!";
	if (status === "cancelled") return "×";
	return "○";
}

function nodeStatusFromEvent(status: GraphRunEvent["status"]): RuntimeNodeStatus | undefined {
	if (status === "completed" || status === "failed" || status === "interrupted") return status;
	if (status === "cancelled") return "cancelled";
	return undefined;
}

function graphStatusFromEvent(status: GraphRunEvent["status"]): GraphStatus | undefined {
	if (status === "running" || status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled") {
		return status;
	}
	return undefined;
}

function copyTokenUsage(usage: TokenUsageLedger): TokenUsageLedger {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		turns: usage.turns,
	};
}

function emptyTokenUsage(): TokenUsageLedger {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
}

function parseTimestamp(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function truncateMessage(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const normalized = message.replaceAll(/\s+/g, " ").trim();
	return normalized.length <= MAX_MESSAGE_LENGTH ? normalized : `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function displayTarget(target: string): string {
	return target === "__end__" ? "end" : target;
}
