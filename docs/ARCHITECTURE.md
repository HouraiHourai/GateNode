# GateNode architecture

GateNode 在 pi-graph 的图运行时上增加代码验收执行器。以下首先说明扩展层，再描述继承的图调度、状态与恢复语义。

## GateNode 验收层

```text
Pi extension → GraphEngine → GateNodeExecutor
                                ├─ 普通节点 → PiNodeExecutor
                                └─ gate 节点 → Agent → 工作区检查 → 固定验收
                                                ↑                 │
                                                └─ 失败反馈与限次修复
```

`GateNodeExecutor` 持有候选结果，只有检查全部通过才把成功 writes 返回引擎。它复用 `NodeExecutor`、节点预算、事件和错误路由；调度器与 checkpoint 数据格式保持上游语义。修复报告独立存储，不提供修复中途的精确恢复。配置、工作区保护和恢复边界见 [门控机制](GATE.md)。

下文描述通用 pi-graph 能力；GateNode 门控目前仅支持 `isolated` 上下文和串行图。

## 图运行时目标

`pi-graph` 是 Pi extension，不是 LangGraph API 克隆。它把以下低层语义映射到 Pi agent runtime：

- shared state
- nodes and edges
- three explicit agent context modes
- bulk-synchronous parallelism
- reducers and conditional routing
- durable checkpoint
- human interrupt
- failure isolation
- bounded execution

Graph runtime 负责控制流、state ownership、恢复和治理；Pi 负责每个智能节点中的模型推理、tool loop、provider 和项目上下文。

## 为什么支持三种上下文

单一上下文策略无法同时满足连续性、独立性和可审计性：

- 所有节点共享完整历史会污染 reviewer，并让并行和恢复变得含糊。
- 所有节点完全隔离会让实现—审查—修复循环丢失有价值的工作记忆。
- 只使用持久 session 会把关键业务状态藏进不可组合的消息历史。

因此上下文由图作者显式选择：

```text
isolated = private memory per invocation
thread   = private durable memory per role
shared   = explicit durable messages in graph state
```

Graph state 在所有模式中都是控制流和跨角色契约的权威来源。

## 运行层次

```text
Pi session
  └─ pi-graph extension tool/command
       └─ GraphEngine
            ├─ shared JSON state
            ├─ scheduler / edges / barriers
            ├─ effective reducers
            ├─ checkpoint store
            └─ PiNodeExecutor
                 ├─ NodeAgentRuntime seam
                 │    └─ InProcessPiAgentRuntime
                 │         └─ createAgentSession per invocation
                 │         ├─ isolated in-memory session
                 │         ├─ reopened thread JSONL session
                 │         └─ shared-transcript in-memory session
                 └─ deterministic / human nodes
```

GraphEngine 不直接调用 provider SDK，也不依赖 agent 的进程边界。Agent node 委托给 `PiNodeExecutor`，再经 `NodeAgentRuntime` seam 的默认实现 `InProcessPiAgentRuntime` 调用 Pi 的 `createAgentSession`，复用 Pi 的 provider、模型、tool harness、resource loader 和 session format。每次 invocation 都创建并最终 dispose 一个进程内 `AgentSession`；上下文模式只决定它使用 in-memory 还是私有 JSONL `SessionManager`。

## 四个记忆平面

### 1. Graph state（hot working set）

```text
state.input
working.*
memory.*
result.*
conversation.messages
```

它是 JSON serializable、checkpointed、受 reducer、state policy 和 state-size limit 约束的显式记忆。Conditional edge 只读取 graph state。Graph state 不是全文仓库：`working` 应按轮次清理，`memory` 只保留压缩摘要，`result` 保存小型输出和 artifact 引用。

### 2. Thread private session

```text
threadKey → stable sessionId → Pi JSONL
```

它保存某个持续角色的 Pi user/assistant/tool history，不直接参与 reducer，也不自动暴露给其他角色。

### 3. Workspace / context files

代码、数据、报告、`AGENTS.md` 等由工作目录和 Pi resource loader 提供。它们是外部真实世界状态，不由 graph checkpoint 回滚。

### 4. Runtime artifacts

Agent output 可声明 `response.storage: "artifact"`。PiNodeExecutor 将完整正文写入私有、content-addressed 文件，Graph state 仅保存 URI、media type、bytes、SHA-256 和有限 preview。完整 report、branch analysis 和 debate transcript 应进入该冷存储，而不是热 state。

## Context execution

### Isolated

```text
state snapshot
  → render prompt
  → createAgentSession(SessionManager.inMemory)
  → prompt + dispose
  → output/state writes
```

每次调用是新的进程内 Pi session。适合并行 worker 和 independent reviewer。

### Thread

```text
checkpoint.threads[threadKey].sessionId
  + current state-derived prompt
  → SessionManager.create/open(<stable-file>)
  → createAgentSession
  → Pi appends private history + dispose
  → output/state writes
```

默认文件：

```text
~/.pi/agent/pi-graph/threads/<runId>/<sessionId>.jsonl
```

目录为 `0700`，文件为 `0600`（非 Windows）。首次 invocation 由 Pi 的 `SessionManager` 初始化合法 session header；后续 invocation 打开同一路径。这里复用的是持久 history，而不是长期存活的 `AgentSession` 对象。

GraphEngine 在调度 thread node 前建立 durable thread metadata，并在运行时拒绝同一 key 并发。共享 key 的节点必须使用相同 cwd，因为一个 Pi session header 只有一个工作目录语义。

Pi session 和 graph checkpoint 不构成跨文件原子事务。每个逻辑 node attempt 先把 stable execution ID 写入 checkpoint；所有 agent context 都使用 run-owned JSONL。恢复时先扫描该 invocation 已持久化的 assistant turns，再用 checkpoint 中的 turn ID 游标补记或去重 usage，因此 `SIGKILL` 不会重复已完成 turn，也不会重复 final assistant prompt。JSONL 是 turn transcript 的事实源，checkpoint 仍是 graph control/state 的事实源。

### Shared

```text
state[messagesPath] snapshot
  → select only recent maxMessages
  → resolve compact state references unless already projected
  → byte-bounded role-tagged transcript
  → createAgentSession(SessionManager.inMemory)
  → prompt + dispose
  → capture according to policy
  → commit + optional maxStoredMessages pruning
```

Shared mode 不复用 Pi session。默认 `capture: compact` 不保存展开后的完整 user prompt；它保存一条小型 assistant message，并用 `statePath` 引用 node output 作为 canonical content。若当前 node 已经通过 template 或 `reads` 投影该路径，runtime 不再次展开引用。

`assistant-only` 保存最终 assistant 文本，通常与 `storeOutput: false` 配合；`none` 不写 channel；`full` 才保存完整 user/tool/assistant transcript，并产生 warning。

`messagesPath` 使用隐式 `concat` reducer。并行节点都读取同一个 transcript snapshot，commit 时按 scheduled order 合并。`maxMessages` / `maxPromptBytes` 限制一次模型输入；`maxStoredMessages` 在 commit 后真正裁剪 durable state。旧 compact reference 已被 state cleanup 删除时仅显示 unavailable marker，不阻塞后续运行。

## Prompt projection 与 preflight

Graph state 不会整体自动发送给模型。PiNodeExecutor 只组合：node template、shared transcript、`reads` projection、response contract 和 node system prompt。Compiler 对 template 与 `reads` 的重叠给出诊断；runtime 对精确重复路径以及 compact shared state reference 再次去重。

`pi-graph` 构造的 prompt 部分在创建 agent session 前计算 UTF-8 bytes，并与 node/graph `maxPromptBytes` 的较小值比较。超限时返回 `PROMPT_BUDGET_EXCEEDED`，不会发起该次模型调用。该 preflight 不包含 Pi 基础 system prompt、工具 schema、自动加载的 context/skill/extension、provider framing，或 thread session 已有私有历史；这些由实际 usage、Pi context management 和更保守的运行预算兜底。Runtime 只维护这一套 prompt byte 判断。

## Superstep 模型

每个 step：

1. 从 `pending` 得到唯一 scheduled nodes。
2. 为 scheduled thread nodes建立/恢复 thread metadata。
3. 保存 `inFlight` checkpoint。
4. 所有节点读取同一个 state snapshot。
5. 在 `maxConcurrency` 内并发运行 unresolved nodes。
6. 每个节点真实结束时立即发出只用于观测的 `node_settled`；它不代表 state 已提交。
7. 并行 batch 返回后，按 scheduled order 发出 `node_end`，并将成功结果逐个保存到 `inFlight.completed`，但不修改 shared state。
8. 所有节点解决后按 scheduled order 聚合 writes。
9. 应用 effective reducers 并原子提交新 state。
10. 增加 completion counts。
11. 计算 conditional/static edges 与 barriers，写入下一 step 的 `pending`。

这种 bulk-synchronous 模型避免较快并行节点提前改变 sibling 正在读取的 state。

## 运行时可观测性

Extension 为每次 run/resume 建立一个仅含控制面信息的 `RuntimeGraphMonitor`。它从 graph definition 提取 static/conditional edges 和错误 fallback，从 `step_start.scheduled`、node start/retry/settled/end、interrupt 与 graph end events 归约出当前节点状态。Resume 时先用 checkpoint history、pending 和 `inFlight` hydrate，再继续消费新事件。

同一份有界快照同时驱动编辑器下方的 TUI widget 和 streaming tool result。默认最多 10 行，并优先保留活动、重试、失败和排队节点，避免大型图撑满终端。Widget 是临时 UI，所有退出路径都会清理；checkpoint 和 `node_end` 仍是 durable/control-flow 事实，`node_settled` 只解决并发 batch 中“较快节点已经结束，但尚未进入 ordered reconciliation”的显示延迟。

### 节点内实时活动（node_activity）

Agent 节点执行期间，内部 in-process Pi session 的事件流（`message_start`、`message_update`、`tool_execution_start`）会被压缩成一行实时预览，经 `NodeExecutionContext.onEvent` 以 `node_activity` 事件向上冒泡：

- 流式文本/思考尾部：`thinking: …` 或当前正在写的最后一行（截断 100 字符）；
- 工具调用：`bash(git status --short)`、`read(src/engine.ts)` 等紧凑参数预览；
- 流式更新按 ≥150ms 节流，工具开始不节流，保证工具调用可见。

这些事件只用于观测：monitor 将它们写到对应节点的 message 字段并随 running 节点行渲染（`● researcher · running · 10s · read(src/engine.ts)`），同时驱动状态栏文本；它们不写入 checkpoint，也不影响控制流。Board 头部在 running 状态下带 braille spinner（300ms 帧），widget 重绘去重且仅在有变化时更新。Widget 通过 `setWidget` 的组件工厂形式（而非纯字符串数组）渲染为一个带品牌横幅的圆角面板：`╭─ ◈ pi-graph · live board ──╮` … `╰──╯`，运行中用 accent 边框、结束后转为 muted，行内按节点 glyph 着色，CJK 宽度安全填充，宽度上限 100 列。横幅与边框使 board 与编辑器上方的历史对话内容明确区分。

## State commit 与生命周期

节点返回：

```ts
interface StateWrite {
  path: string;
  value?: JsonValue;
  nodeId: string;
  mode?: "reduce" | "overwrite" | "unset";
}
```

- `reduce`：使用 channel reducer；单 writer 无 reducer时等价 replace。
- `overwrite`：绕过 reducer，适合在新轮次建立干净 working set。
- `unset`：真正删除旧路径，不留下 `null` 占位。
- `append`：跨 superstep 累积历史。
- `collect`：只收集当前 superstep 的并行 writes，替换上一轮 batch。
- shared messages：隐式 concat，随后按 `maxStoredMessages` 裁剪。

Compiler 对 cyclic node 写入 `append`/`concat` channel 发出 `ACCUMULATING_REDUCER_IN_CYCLE`，除非它是配置了 `maxStoredMessages` 的有界 shared channel。父子路径并行写入、同一路径中的显式 overwrite/unset 与其他 writes 混用都会失败。Commit 后立即执行 shared retention、hot-state/per-path budget，再计算 conditional edge。

## User-facing result 与 inspect

`GraphRunResult.state` 仍是内部 durable state，但 extension 默认只渲染顶层 `result.paths` 投影；`includeState` 默认为 false。这样 100KB 内部 state 不会在 tool result 中再次进入主 Pi context。

Inspect 默认输出 checkpoint summary、pending/in-flight、usage、state 总大小和最大 paths；inventory/path/full 是显式视图。只有 full 会序列化完整 checkpoint，且仍有 byte cap。

## Routing 与 barrier

Conditional edge 在整个 step writes 提交后求值，因此 reviewer 可以读取刚提交的 review state。第一个 case 命中；default 可选。

`onError.route` 是 node-result override：失败节点走专用 destination，不再执行正常 conditional/static edge。

合法的业务拒绝仍是成功 node result；显式 `maxSteps` 等 graph-level hard limit 也不会进入 node `onError`。需要降级输出的循环可在 graph state 中显式计数，并在显式硬限制前路由到 terminal fallback，不能依赖撞限后再执行节点。

Multi-source edge 使用 completion count barrier：当每个 source count 都大于该 barrier 已消费 count 时触发一次。这支持循环中的重复 fan-in。

## Checkpoint

Checkpoint 是 GraphEngine 的显式状态协议，不是 agent 进程快照。Engine 在每个 superstep 的调度前、并行结果 reconciliation、state/reducer/edge/barrier commit，以及 interrupt/failure/end 边界序列化 state 和 control fields。恢复只依据该 snapshot 重建 pending、in-flight、reducers、conditional edge decisions 和 barriers；node 使用子进程还是进程内 `AgentSession` 不参与这套语义。

File checkpoint adapter 不使用需要回收的锁文件。每个 run 在 `.journal/<runId>/` 下维护 append-only 的不可变操作序列；lease acquire/renew、CAS commit、release 和 delete 都尝试用 atomic hard-link 发布唯一的下一序号文件。多个进程从同一序号出发时只有一个 link 能成功，其余进程重新读取 winner 后重试或返回 lease/revision 冲突，因此 stale owner 无法删除或覆盖新 owner 的协调状态。

Checkpoint snapshot 先写入并 `fsync` 为唯一命名的 immutable blob，journal entry 的 inode 也在 hard-link 发布前完成 `fsync`。需要对调用者确认成功的 durable 状态转换还会同步最终 journal 文件及其目录；首次创建目录时也会同步父目录。这样，即使一次非 durable lease 目录更新被稍后的目录同步一并刷盘，它也不会成为内容撕裂的最高序号。只有 journal 是 lease、revision 和 checkpoint pointer 的权威来源；根目录 `<runId>.json` 是供人工检查与备份的 best-effort 最新镜像，镜像失败不会反转已经成功的 CAS。耐久同步失败会作为 checkpoint control error 返回，不能被误报成一次成功 commit。

Journal sequence claim 永不删除或复用。保留 append-only CAS namespace 可以避免暂停进程在恢复后复用旧序号产生 ABA；代价是长运行 run 的 lease entry 与旧 checkpoint blob 会持续增长。删除 run 会清除 blob，但为了防止复活仍保留 sequence claim 和最小 tombstone，因此部署方仍需监控 inode，并在确认不存在 stale 进程且不再复用这些 `runId` 时按运维策略轮换或归档整个 checkpoint root。目录使用 `0700`，文件使用 `0600`。完整耐久语义要求同一主机、支持原子 hard-link 和目录 `fsync` 的本地文件系统，不是跨主机分布式协调协议；不支持目录同步的平台只能提供 best-effort metadata durability。

删除 run 时先发布不可变 tombstone，再移除 snapshot blobs 和根目录镜像；最小 tombstone 会保留，以阻止 stale owner 或残留旧镜像复活已经删除的 `runId`。

磁盘格式是带 revision 的 envelope：

```ts
interface CheckpointRecord {
  format: "pi-graph-checkpoint";
  formatVersion: 2;
  revision: number;
  snapshot: CheckpointSnapshot;
}
```

新 run 在 `open({ mode: "create" })` 返回前已持久化为 revision 1。Checkpoint 只接受 `formatVersion: 2` envelope；其他磁盘格式直接拒绝，不执行隐式迁移。

`CheckpointStore.open()` 在加载 resume state 或运行新节点前取得 run lease。`CheckpointRun` 在内部 heartbeat；lease 不确定或丢失时 abort 自己的 signal。`commit()` 同时验证 owner、expiry 和 expected revision，成功后 revision 精确加一。CAS/lease/schema 错误不会被 engine 转写成一个新的 failed checkpoint。

`SIGKILL` 无法执行 `finally` 或写入终态，因此最后的 durable snapshot 会继续保持 `running`。`inspect()` 与 `list()` 从权威 journal 只读派生 lease 状态：`held`、`expired` 或 `released`；`running + expired/released` 在用户界面标为 resumable，但不会被伪装成 `failed`。只有显式 resume 会通过 `open({ mode: "resume" })` 的 CAS 原子接管过期 lease，inspect/list 不抢 lease、不启动节点。

```ts
interface CheckpointRun {
  readonly runId: string;
  readonly revision: number;
  readonly snapshot: CheckpointSnapshot;
  readonly signal: AbortSignal;
  commit(snapshot: CheckpointSnapshot): Promise<void>;
  close(): Promise<void>;
}
```

加载、创建和每次 commit 共用同一个 strict validator。除开放的 JSON state/value 外，所有 control objects 都拒绝未知字段；validator 覆盖 usage、history、threads、in-flight success results、writes、interrupt、UUID session IDs、有限非负整数、规范时间戳、plain JSON object 以及 status-specific invariants。Snapshot 必须显式包含 `threads`。`running` 不得携带 interrupt/error/end，`interrupted` 必须指向 unresolved in-flight node，terminal 状态必须满足各自的 end/error 约束。

```ts
interface CheckpointSnapshot {
  version: 2;
  runId: string;
  graphName: string;
  graphHash: string;
  status: "running" | "interrupted" | "completed" | "failed" | "cancelled";
  state: JsonObject;
  pending: string[];
  completionCounts: Record<string, number>;
  barrierConsumed: Record<string, Record<string, number>>;
  usage: UsageLedger;
  history: NodeRunHistory[];
  threads: Record<string, AgentThreadState>;
  inFlight?: {
    step: number;
    scheduled: string[];
    unresolved: string[];
    completed: Record<string, NodeExecutionSuccess>;
  };
  interrupt?: GraphInterrupt;
}
```

Thread metadata：

```ts
interface AgentThreadState {
  key: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  nodes: string[];
  invocationCount: number;
  lastNodeId?: string;
}
```

### Crash recovery

并行 step 运行 A、B、C。整个 batch 返回后：

- A 成功并 checkpoint
- B 成功并 checkpoint
- C 返回失败并保留在 unresolved

恢复后只执行 C；随后 A/B/C writes 一起 commit。

如果进程在整个 batch 返回前退出，已提交到 `inFlight.completed` 的 sibling 不会重跑；未完成 attempt 复用相同 execution ID。未过期 lease 会阻止第二个执行者进入同一 run；但旧进程暂停超过 TTL 后，新 owner 可以接管，旧进程恢复时仍可能在下一次 heartbeat 或 commit 发现失租前短暂继续执行。未完成的工具调用在恢复时直接重放，因此外部副作用可能重复。

Shared messages 属于 pending writes，所以 A/B 的 messages 已保存在 `inFlight.completed` 但尚未进入 state。Thread private session 由 Pi 直接追加，可能领先于 graph checkpoint。

### Graph hash

Hash 是 definition 的 stable sorted JSON SHA-256。恢复时 hash 不同会拒绝。强制恢复不会迁移 state 或 thread history。

## Human interrupt

Human node 无值时保存：

```json
{
  "nodeId": "approval",
  "kind": "confirm",
  "prompt": "Approve?",
  "createdAt": "..."
}
```

Status 变为 `interrupted`，in-flight 保持。Resume value 只注入当前 interrupt node。

## 进程内 Pi session protocol

`PiNodeExecutor` 把 node 请求交给 `NodeAgentRuntime`。默认的 `InProcessPiAgentRuntime` 为每次 invocation 调用 `createAgentSession`，订阅 `AgentSession` events，并在结束路径 dispose session。它直接处理 `message_end` 中的 assistant / tool-result message，并提取：

- assistant text
- usage input/output/cacheRead/cacheWrite
- `usage.cost.total`
- model、stopReason、errorMessage

每条 assistant turn 先进入 run-owned Pi JSONL，再在 awaited `turn_end` 中把 usage 与 turn ID 一次 commit 到 graph checkpoint，之后才允许下一 provider turn。恢复扫描可补上 JSONL append 与 checkpoint CAS 之间的进程崩溃窗口。对外的 runtime/tool/inspect/session-summary view 只包含 token 与 turn；`costUsd` 仍保留在内部 ledger 和 checkpoint 中用于预算执行。达到 budget、node timeout、graph timeout 或外部取消时调用 cooperative `session.abort()`；若 provider 或 tool 不及时响应取消，实际返回可能晚于限制时刻。

System prompt 直接交给 Pi resource loader。`response.schema` 的结构化输出工具以 per-invocation `customTools` 注入，并在成功后请求终止当前 agent loop；不再创建临时 system-prompt 文件或临时 extension 文件。

`isolated` 和 `shared` 为当前 logical attempt 使用确定性、run-owned JSONL，仅用于 crash recovery，不跨已完成 invocation 共享记忆。`thread` 根据 checkpoint 中的 stable session ID 创建或重新打开角色私有 JSONL。两类 JSONL 都由 invocation boundary 隔离当前 node 的 output/usage。

## Budget

Graph budget 是并发共享 ledger。每个 attempt 还有 scoped node budget。Executor 流式 `report()`；engine 用最终 result usage reconciliation 补齐差额。

所有 retries 计费和计 token。Human/set usage 为零。Graph timeout 记录 active execution time，不计算人工暂停时间。

## Failure model

### Retryable failure

按 node retry policy 重试，每个 attempt 计入 `maxNodeRuns`。

- isolated/shared retry：新的 in-memory `AgentSession`；未成功的 graph writes 不提交。
- thread retry：新的 `AgentSession` 重新打开同一 Pi JSONL history；先前 attempt 可能已经留下 messages，因此编译器 warning。

### Fatal node failure

成功 sibling results 留在 `inFlight.completed`；失败 node 留在 `unresolved`。Resume 只重跑失败 node。

### Isolated error policy

`onError.continue` 或 `route` 把结构化错误转为成功 graph result，使 step 可 commit。History 仍记录 failed。

### State conflict / graph limit

Status 变为 failed，in-flight 保留。调整 definition 后 graph hash 会变化，force resume 必须经过人工审阅。

### Missing thread session

若 checkpoint 显示 thread 已被调用，但其 JSONL 不存在，executor 返回 `THREAD_SESSION_MISSING`，拒绝静默丢失 private memory。

### Abort

AbortSignal 导致 status `cancelled`，未完成 in-flight 保留；已 settled sibling 不会在 resume 时重跑，已报告的 usage 与 cancelled attempt history 会一并持久化。取消中的 side-effect node 仍必须幂等，因为它可能需要重跑。

## Security boundaries

1. Discovery 只读取固定 user/project graph directories。
2. Project graph discovery 依赖 Pi trust。
3. 项目和 mutating graph 有独立 confirmation cache。
4. 非交互执行由 graph policy 显式授权。
5. Agent session 默认继承直接 Pi session 的 extensions、skills 与 prompt templates；将对应 `load*` 字段设为 `false` 才禁用。
6. Graph tools 在每个 agent session 中排除，避免递归。
7. Read-only reviewer 使用 fail-closed allowlist；除 built-in 读取工具外，只接受显式声明的已知 web 读取工具。
8. 任一 agent node 的 `loadExtensions` 未显式设为 `false` 时进入 mutating authorization，因为 allowlist 不能约束扩展初始化代码。
9. State path、thread key、run id、JSON 类型和输出大小均验证。
10. Thread directories 和 files 使用私有权限，并拒绝 symlink/非普通文件。

`readOnly` 不等于 sandbox。进程内 AgentSession 与 graph runtime 共享 OS user 权限。高风险执行应增加容器、namespace、seccomp、只读挂载或专用工作区。

## 扩展点

核心 runtime 通过 `NodeExecutor` 解耦：

```ts
interface NodeExecutor {
  execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult>;
}
```

后续可增加：

- provider-native message-array executor
- alternative `NodeAgentRuntime` adapters
- containerized / remote worker executor
- database checkpoint and thread-session store
- graph-level state channel schemas and message compaction nodes（agent handoff 已支持 `response.schema`）
- OpenTelemetry event sink
- graph migrations and subgraph nodes

扩展必须保持控制流、state ownership、memory mode、failure semantics 和 budget 显式。
