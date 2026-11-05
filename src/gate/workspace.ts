import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export type WorkspaceSnapshot = Map<string, string>;

/** Detection boundary for a small trusted workspace, not an OS sandbox. */
export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
	const entries: WorkspaceSnapshot = new Map();
	let totalBytes = 0;
	async function walk(directory: string, prefix: string) {
		for (const item of await readdir(directory, { withFileTypes: true })) {
			if (item.name === ".git" || item.name === "node_modules") continue;
			const name = prefix ? `${prefix}/${item.name}` : item.name;
			const file = join(directory, item.name);
			if (item.isSymbolicLink()) throw new Error(`Symlinks are not supported in gated workspaces: ${name}`);
			if (item.isDirectory()) { await walk(file, name); continue; }
			if (!item.isFile()) throw new Error(`Unsupported workspace entry: ${name}`);
			const stat = await lstat(file);
			totalBytes += stat.size;
			if (entries.size >= 2000 || totalBytes > 32 * 1024 * 1024) throw new Error("Gate workspace exceeds 2000 files / 32 MiB; use a small dedicated workspace");
			entries.set(name, createHash("sha256").update(await readFile(file)).digest("hex"));
		}
	}
	await walk(root, "");
	return entries;
}

export function protectedChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot, writableFiles: string[]): string[] {
	const writable = new Set(writableFiles);
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter((file) => !writable.has(file) && before.get(file) !== after.get(file)).sort();
}

export async function resolveWorkspace(projectRoot: string, nodeCwd?: string): Promise<string> {
	const root = await realpath(projectRoot);
	const cwd = await realpath(resolve(root, nodeCwd ?? "."));
	const rel = relative(root, cwd);
	if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
		throw new Error("Gate workspace must be inside the current project");
	}
	return cwd;
}
