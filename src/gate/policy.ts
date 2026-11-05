import { isAbsolute } from "node:path";
import type { AgentNodeDefinition, GraphDefinition } from "../types.ts";

export function gatePolicyProblems(node: AgentNodeDefinition, graph: GraphDefinition): string[] {
	if (!node.gate) return [];
	const problems: string[] = [];
	if (node.context?.mode !== "isolated") problems.push("gate requires explicit isolated context");
	if ((node.retry?.maxAttempts ?? 1) !== 1) problems.push("gate owns repair attempts; retry.maxAttempts must be 1");
	if (graph.limits?.maxConcurrency !== 1) problems.push("gate requires graph limits.maxConcurrency = 1");
	if (graph.edges?.some((edge) => "to" in edge && Array.isArray(edge.from) && edge.from.length > 1)) {
		problems.push("gate does not support barrier edges");
	}
	if (node.onError?.strategy === "continue") problems.push("gate failures must fail or route to a human node");
	if (node.onError?.strategy === "route") {
		const target = node.onError.to;
		if (typeof target !== "string" || graph.nodes[target]?.type !== "human") problems.push("gate error route must target one human node");
	}
	if (node.response?.storage === "artifact") problems.push("gate requires inline state output");
	const python = node.gate.checks.some((check) => check.startsWith("python-"));
	if (python && node.gate.checks.some((check) => check === "typecheck" || check === "test")) problems.push("gate cannot mix Python and TypeScript check presets");
	if (node.gate.pythonExecutable && (!python || (!isAbsolute(node.gate.pythonExecutable) && !["python", "python3"].includes(node.gate.pythonExecutable)))) {
		problems.push("pythonExecutable requires Python checks and must be python, python3, or an absolute interpreter path without arguments");
	}
	const sourcePattern = python ? /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.py$/ : /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/;
	for (const file of node.gate.writableFiles) {
		if (!sourcePattern.test(file) || /(?:^|\/)(?:tests?|__tests__)\//.test(file)) {
			problems.push(`writable file must be an exact source ${python ? ".py" : ".ts"} path under src/: ${file}`);
		}
	}
	return problems;
}
