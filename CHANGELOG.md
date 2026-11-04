# Changelog

## 0.2.0 — 2026-08-25

- **Chat-captured human asks:** interrupted human nodes (`input`/`confirm`/`select`) now hold the live board (paused, spinner stopped) and capture the user's next interactive chat message as the resume value — `input` passes text through, `confirm` maps yes/no words to booleans, `select` matches options. Slash commands always pass through; `/pig skip` releases capture while the run stays paused; a failed resume restores capture so the user can retry. Verified end-to-end in the TUI.
- **Topology live board:** the board now renders the graph shape instead of a node list — strongly connected components (cycles) inline joined by `⇄`, longest-path layering, `│`/`↘`/`↙` connectors, per-chip barycenter alignment under parents, chip states with elapsed time and `×N` run counts. Oversized SCCs (>5) unroll into per-node components. The activity log is separated by a rule and grouped by node (name shown once per group, only when several nodes are active); `node_retry` reasons join the trail. Panel width follows the TUI and no longer caps at 100 columns; ANSI escapes from truncation are stripped. 
- **Markdown inspect:** `/pig inspect <runId> <path>` renders state values as Markdown entries (strings as Markdown, objects/arrays as fenced JSON) instead of raw notify dumps; literal `\n` escapes and inline `(N)` enumerations in model-written strings are normalized to real line breaks before rendering.
- **Quieter policy defaults:** `confirmProjectGraph` and `confirmMutatingNodes` now default to `false` (opt-in). Graphs in untrusted repositories remain blocked at discovery; a graph can re-enable its gate with `policy.confirmProjectGraph = true`.
- **Optional graph timeout:** omitting `limits.timeoutMs` now disables the cap instead of silently applying a hard-coded 30-minute default. Node-level `timeoutMs` still applies when set.
- Added `examples/UPEV.json`: understand (grilling loop) → plan (read-only) → execute → verify (isolated reviewer) with repair routing; result projects the confirmed understanding.

## 0.1.0 — 2026-08-15

- **Breaking:** undeclared agent `context.mode` now defaults to `thread` instead of `isolated`. Existing graphs without an explicit mode gain persistent per-node session history (JSONL on disk per `threadKey`). Declare `"context": { "mode": "isolated" }` on reviewers, parallel branches, and one-shot experts to keep the old behavior; reviewers without an explicit isolated declaration now warn `REVIEWER_CONTEXT_NOT_ISOLATED`. Explicit `isolated`/`shared`/`thread` declarations are untouched.

## 0.0.12 — 2026-08-15

- Published release combining the live runtime board, node activity streaming, run-id prefix resolution, and the `/pig` argument completion fix.

## 0.0.11 — 2026-08-14

- Fixed `/pig run|validate|visualize|resume|inspect|delete` argument completion: the TUI replaces the whole argument segment with the completion value, so items now re-include the action prefix (e.g. `run research-review`) instead of swallowing the subcommand.
- `pi_graph_resume`, `pi_graph_inspect`, `/pig resume|inspect|delete`, and engine resume now accept any unique run-id prefix (e.g. `01b59243`) in addition to the full id. Ambiguous prefixes fail with the match count; deleted runs are skipped during resolution, and missing ids keep their existing errors.

## 0.0.10 — 2026-08-14

- The live TUI board now renders as a framed, theme-aware panel (`╭─ ◈ pi-graph · live board ──╮` … `╰──╯`) via the `setWidget` component factory: branded banner row separates the board from surrounding chat content, accent border while RUNNING and muted border when settled, glyph-based row coloring, CJK-safe padding, and a 100-column width cap.

## 0.0.9 — 2026-08-14

- Added live in-node agent activity to the runtime board: streaming text/thinking tails and compact tool-call previews (`bash(git status --short)`) now surface as `node_activity` events through `NodeExecutionContext.onEvent`, render on running node lines, and drive the status bar without touching checkpoints or control flow.
- The running graph board now animates a braille spinner in its header, refreshes every 300ms, and re-renders only when content changes.

## 0.0.8 — 2026-08-13

- Agent nodes now inherit the parent Pi session's model, thinking level, active tools, extensions, skills, prompt templates, system-prompt settings, scoped models, and extension flags by default; graph recursion tools remain excluded and resources can still be disabled explicitly.
- Added durable per-turn agent recovery with stable execution IDs and run-owned JSONL sessions. Completed turns and usage survive `SIGKILL`, resume deduplicates persisted turns, and isolated/shared context semantics remain isolated across completed invocations.
- Cancellation and graph timeout now preserve settled siblings, in-flight progress, node history, and reported usage so resume replays only unresolved work. Unfinished external tool calls remain at-least-once and may be replayed.
- Added read-only lease inspection for checkpoints. `/pig inspect` and run listings distinguish held, expired, and released leases and mark stale running checkpoints resumable without mutating or claiming them.
- Structural limits `maxSteps` and `maxNodeRuns` are now enforced only when explicitly configured; timeout, state, output, and cost guardrails remain available.
- Improved `/pig list` with aligned name/scope/node-count columns, singular/plural node labels, bounded descriptions, surfaced discovery diagnostics, and focused regression coverage.
- Added the optional `pi_graph_git_diff` agent tool and an open-ended DeepSeek/ZAI debate example.
- Aligned Pi peer and development dependencies with Pi 0.83.0 and expanded engine, checkpoint, runtime, extension, and crash-recovery tests.

## 0.0.7 — 2026-08-01

- **Breaking:** Replaced top-level `routes` with conditional objects in `edges`.
- **Breaking:** Renamed public compiled/runtime route fields to `conditionalEdgesByNode` and `conditional`; `onError.strategy: "route"` is unchanged.
- Added confirmed `/pig delete <runId>` cleanup for checkpoints, private thread history, and artifacts.
- Invalid `matches` regular expressions and incompatible conditional comparison values now fail at compile time.
- Removed redundant checkpoint commits and non-authoritative mirror synchronization; npm tests now run serially for deterministic lease timing.
- `GraphEngine` now applies per-node timeout signals to every `NodeExecutor`; the Pi runtime retains its own timer only for standalone calls without a caller signal.

## 0.0.6 — 2026-07-31

- **Breaking:** Removed graph- and node-level `maxTokens` from the public schema, types, compiler, and runtime budget enforcement. Existing `maxTokens` graph fields are now rejected as unknown; token accounting and display remain available for observability.
- Added the generic `open-ended-debate` example with neutral topic allocation, two persistent opposing agents, and conditional routing until one side concedes.

## 0.0.5 — 2026-07-28

- Renamed the user-facing slash command from `/pi-graph` to `/pig` — the command registry, usage/help strings, status and error labels, runtime board header, UI prompts, and docs now say `pig`. Backward-compatible identifiers are unchanged: the on-disk checkpoint format magic strings (`pi-graph-checkpoint*`, `pi-graph-run-lease`), the `~/.pi/agent/pi-graph/` storage directory, the runtime widget key, the `pi-graph-node-output` kind, the package name (`@shying/pi-graph`), and the agent-facing tool names (`pi_graph_run`, `pi_graph_resume`, `pi_graph_inspect`). Existing checkpoints, threads, and artifacts keep working.

## 0.0.4 — 2026-07-28

- Added per-assistant `usage_update` events so live dashboards refresh token counts before a node settles. User-facing tool, TUI, inspect, run-list, script, and session-summary views are now token-only; cost estimates remain internal for checkpoint compatibility and budget enforcement.
- Added `response.schema` contracts for agent node handoffs. Schema nodes use an internal structured-output tool, validate tool data before state commit, and fail without exposing malformed values to downstream nodes.
- Replaced per-node Pi subprocess/NDJSON execution with the `NodeAgentRuntime` seam and default `InProcessPiAgentRuntime`. Each invocation now uses `createAgentSession`; isolated/shared sessions are in memory, while thread invocations reopen their graph-owned private JSONL session.
- Structured output now accepts JSON-string `data` and valid unwrapped tool arguments, with regression coverage for both model behaviors.
- Read-only reviewers may explicitly use the known web research tools (`web_search`, `fetch_content`, and `get_search_content`) while mutating and unknown tools remain rejected.

## 0.0.3 — 2026-07-23

- Consolidated graph topology analysis so target validation, reachability, cycle detection, and fan-out checks share one representation; `onError.to` is now accepted only with `strategy: "route"`.
- Replaced hand-written raw graph parsing with an exact TypeBox structure schema. Unknown control fields now fail closed while `initialState` and user data values remain open JSON.
- **Breaking:** moved graph definitions to `schemaVersion: 2`. Version 1 is rejected; duplicate output/prompt/state limit fields and non-reviewer `purpose` values were removed. See `docs/SCHEMA.md` for the one-time manual migration.
- **Breaking:** checkpoint snapshots now require `version: 2` inside the existing `formatVersion: 2` envelope. Flat and v1 snapshots are rejected, and only the journal is read as authoritative recovery state.
- Reused Pi terminal width/size helpers, Node's abortable promise timer and `rm(..., { force: true })`; centralized tool policy constants and removed undocumented wrappers.
- Made the discovery result carry one required compiled graph instead of duplicating its definition, identity, hash and diagnostics.
- Replaced the runtime barrel's accidental exports with an explicit compile/engine/checkpoint/executor interface.
- Reduced the npm publish whitelist to runtime, examples, documentation, and skills; development tests, scripts, agent notes, and TypeScript configuration are no longer packed.
- Added a bounded live runtime board for graph runs and resumes, showing the current superstep, queued/running/retrying/completed nodes, topology, elapsed time, usage, and cost in both the Pi TUI widget and streaming tool result. The event stream additively exposes structured `step_start.scheduled` nodes and immediate, observational `node_settled` events without changing ordered `node_end`/checkpoint semantics.
- Hardened the shipped reviewer workflows: malformed structured reviews now retry and preserve best-effort output, while `research-review` can repair missing repository evidence and exits through an explicit approved or bounded best-effort result before hard graph limits.

- Added round-scoped state lifecycle primitives: the `collect` reducer, explicit `overwrite` and `unset` writes, hot-state limits, and per-path state budgets.
- Added prompt hygiene: compiler diagnostics for template/`reads` overlap, runtime projection deduplication, compact shared state-reference suppression, and byte/token preflight limits before an agent session starts.
- Changed shared capture to a bounded policy model (`none`, `compact`, `assistant-only`, `full`) and added `maxStoredMessages` durable retention with post-commit pruning.
- Added runtime-managed artifact output so full reports and transcripts stay out of checkpoint state; state keeps content-addressed metadata and a bounded preview.
- Added result projection and summary-first/path-oriented inspection; Pi tools no longer return the complete graph state or checkpoint by default.
- Reworked both science-research examples around `working`/`memory`/`result`, current-round branch collection, explicit round cleanup, compact debate state, prompt budgets, and artifact-backed final reports.
- Added compiler diagnostics for cyclic accumulating reducers, duplicate shared/output copies, orphaned artifact references, and duplicate/overlapping prompt projections.
- Added regression tests for cross-round collection, overwrite/unset cleanup, duplicate prompt suppression, shared retention, prompt preflight rejection, artifact persistence, state budgets, and projected results.
- Added exclusive run leases with heartbeat renewal over an immutable per-run operation journal; unexpired leases reject a second executor, expired/crashed owners can be replaced, and stale checkpoint commits are fenced by CAS. External node effects still require idempotency or downstream fencing after TTL-based takeover.
- Added atomic hard-link CAS with non-reusable append-only sequence claims, revisioned immutable checkpoint blobs, durable inode/directory synchronization, and a `formatVersion: 2` checkpoint envelope; new runs are durable at revision 1 and legacy flat `version: 1` checkpoints migrate from revision 0.
- Added strict checkpoint validation for all control fields, nested execution results, usage, history, thread UUIDs, interrupts, finite counters, status invariants, and immutable/monotonic properties across revisions.
- Changed Pi graph tools to throw failures through Pi's real tool-error channel instead of returning an ineffective `isError` field.
- Added concurrency, stale-revision, lease-takeover, crash-recovery, create/delete race, schema-corruption, extension-error, cancellation, and real offline Pi CLI contract tests.

## 0.0.2 — 2026-07-22

- Added `/pi-graph visualize <graph>`: render any discovered graph as a Mermaid flowchart in the Pi TUI (node shapes, static edges, conditional routes, and entry-node highlighting).
- Added the `pi-graph` skill (`skills/pi-graph/SKILL.md`): a workflow-oriented guide for deciding when to use a graph and for authoring, validating, running, resuming, and visualizing one; registered via `pi.skills`.
- Added the `science-research` example graph: a multi-stage research loop (planner → parallel branches → evidence review → integration → report).
- Added the `science-research-auto` example graph: a fully-autonomous variant of `science-research` that replaces the human scope gate with an isolated agent reviewer (`scope_review`) so the whole graph runs headless with no human in the loop; all other mechanics (parallel fan-out + barrier, shared adversarial debate, thread integrator, refinement loop) are preserved.
- Added an English README (`README.en.md`) with a language switcher linking both READMEs.
- Rendered all example graphs as embedded SVGs in the README (`docs/images/`) via `npm run render:graphs`; `@mermaid-js/mermaid-cli` is a devDependency only.
- Added GitHub `repository`, `bugs`, and `homepage` metadata to `package.json`.

## 0.0.1 — 2026-07-21

- Reversioned the package to `0.0.1` as the active baseline.

## 0.2.0 — 2026-07-21

- Added explicit agent context modes: `isolated`, `thread`, and `shared`.
- Preserved `isolated` as the default for backward-compatible `schemaVersion: 1` graphs.
- Added durable private Pi sessions keyed by `threadKey`, including checkpoint metadata, cwd compatibility checks, concurrent-use rejection, private permissions, and missing-session fail-closed behavior.
- Added explicit role-tagged shared-message channels in graph state, bounded transcript projection, atomic message commits, and implicit `concat` reducers.
- Added reviewer-context diagnostics and warnings for retrying persistent thread nodes.
- Updated coding, research, and shared-handoff examples to demonstrate deliberate memory boundaries.
- Expanded type, compile, subprocess, restart/resume, missing-session, and reducer regression coverage.

## 0.1.0 — 2026-07-21

- Initial Pi package and extension.
- Explicit JSON state graph with static and conditional edges.
- Bulk-synchronous fan-out/fan-in execution.
- Atomic state reducers and parallel-write conflict detection.
- Isolated Pi subprocess nodes with per-node model, thinking, tools, cwd, and resources.
- Node retry policies, idempotency diagnostics, and failure isolation.
- Durable checkpoints, inspection, resume, and human interrupts.
- Graph and node cost, token, turn, step, concurrency, timeout, output, and state-size limits.
- Project trust and mutating-tool confirmation gates.
