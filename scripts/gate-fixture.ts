import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeOutcome, AgentRuntimePrompt, NodeAgentRuntime } from "../src/pi-agent-runtime.ts";
import type { AgentNodeDefinition, GraphDefinition, NodeExecutionContext } from "../src/types.ts";
import { emptyUsage } from "../src/utils.ts";

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const repairedSource = `export interface Item { id: number; name: string; }
export function listItems(items: readonly Item[], page?: number, pageSize?: number): Item[] {
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) throw new RangeError("Invalid page");
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) throw new RangeError("Invalid pageSize");
  const size = pageSize ?? items.length;
  const start = ((page ?? 1) - 1) * size;
  return items.slice(start, start + size);
}
`;
export const invalidSource = `${repairedSource}\nconst deliberateTypeError: number = "not a number";\n`;

export async function prepareFixture(directory: string): Promise<string> {
	const workspace = join(directory, "workspace");
	await mkdir(directory, { recursive: true });
	await cp(join(projectRoot, "demo", "fixture"), workspace, { recursive: true, errorOnExist: true, force: false });
	return workspace;
}

export async function demoGraph(root: string, workspace: string): Promise<GraphDefinition> {
	const graph = JSON.parse(await readFile(join(projectRoot, "examples", "coding-gate.json"), "utf8")) as GraphDefinition;
	const node = graph.nodes.implementer as AgentNodeDefinition;
	node.cwd = relative(root, workspace).split("\\").join("/");
	return graph;
}

/** Deterministic test double. It never calls a model and is not the production Agent. */
export class ScriptedRepairRuntime implements NodeAgentRuntime {
	readonly calls: { context: NodeExecutionContext; prompt: AgentRuntimePrompt }[] = [];
	private readonly workspace: string;
	private readonly scenario: "pass" | "repair" | "exhaust" | "tamper";

	constructor(workspace: string, scenario: "pass" | "repair" | "exhaust" | "tamper") {
		this.workspace = workspace;
		this.scenario = scenario;
	}

	async invoke(_node: AgentNodeDefinition, context: NodeExecutionContext, prompt: AgentRuntimePrompt): Promise<AgentRuntimeOutcome> {
		this.calls.push({ context, prompt });
		const pass = this.scenario === "pass" || (this.scenario === "repair" && this.calls.length > 1);
		await writeFile(join(this.workspace, "src", "items.ts"), pass ? repairedSource : invalidSource);
		if (this.scenario === "tamper") await writeFile(join(this.workspace, "tests", "items.test.ts"), "// removed tests\n");
		const usage = { ...emptyUsage(), turns: 1, inputTokens: 10, outputTokens: 5 };
		if (context.recordTurn) await context.recordTurn({ id: "scripted-turn", usage });
		else context.budget.report(usage);
		return { outputText: `Scripted candidate ${this.calls.length}`, usage, messages: [], stopReason: "stop", timedOut: false, aborted: false, structuredOutputSucceeded: false };
	}
}
