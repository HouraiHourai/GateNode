export const READ_ONLY_BUILTIN_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export const READ_ONLY_WEB_TOOL_NAMES = ["web_search", "fetch_content", "get_search_content"] as const;
export const READ_ONLY_GRAPH_TOOL_NAMES = ["pi_graph_git_diff"] as const;
export const READ_ONLY_TOOL_NAMES = [
	...READ_ONLY_BUILTIN_TOOL_NAMES,
	...READ_ONLY_WEB_TOOL_NAMES,
	...READ_ONLY_GRAPH_TOOL_NAMES,
] as const;
export const DEFAULT_AGENT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export const READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(READ_ONLY_TOOL_NAMES);
export const READ_ONLY_WEB_TOOL_SET: ReadonlySet<string> = new Set(READ_ONLY_WEB_TOOL_NAMES);
