import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demoGraph, prepareFixture, projectRoot } from "./gate-fixture.ts";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const workspace = await prepareFixture(join(projectRoot, "demo-output", stamp));
const graph = await demoGraph(projectRoot, workspace);
const graphsDir = join(projectRoot, ".pi", "graphs");
await mkdir(graphsDir, { recursive: true });
await writeFile(join(graphsDir, "coding-gate.json"), JSON.stringify(graph, null, 2) + "\n");
console.log(`Created a fresh workspace: ${workspace}\nCode output (after the Pi run): ${join(workspace, "src", "items.ts")}\nAcceptance tests: ${join(workspace, "tests", "items.test.ts")}\nPrevious workspaces were preserved.\n\nRun npm start, trust this project, select a configured model, then enter:\n/pig run coding-gate 给 listItems 增加分页参数，保持旧调用方式兼容`);
