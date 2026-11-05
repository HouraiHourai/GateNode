# 门控配置与执行流程

GateNode 在 pi-graph 的 `NodeExecutor` 接口上包装 `PiNodeExecutor`。带 `gate` 的 Agent 节点先执行模型任务，再检查工作区；只有验收通过，候选的成功结果才会返回 `GraphEngine`。不带 `gate` 的节点直接交给原执行器。

## 配置

以下为 Agent 节点的门控配置片段。完整图见 [TypeScript 示例](../examples/coding-gate.json) 和 [Python 示例](../examples/python-gate.json)。

```json
{
  "type": "agent",
  "prompt": "{{input.task}}",
  "cwd": "demo/fixture",
  "context": { "mode": "isolated" },
  "retry": { "maxAttempts": 1 },
  "gate": {
    "checks": ["typecheck", "test"],
    "writableFiles": ["src/items.ts"],
    "maxAttempts": 3,
    "timeoutMs": 30000,
    "maxOutputBytes": 32768
  },
  "onError": { "strategy": "route", "to": "manual" }
}
```

`manual` 必须是图中存在的 `human` 节点；图级 `limits.maxConcurrency` 必须显式为 `1`。

| 字段 | 含义与限制 |
|---|---|
| `checks` | 必填，1–2 个不重复的预设，按顺序执行；首个失败后停止后续检查。 |
| `writableFiles` | 必填，1–32 个相对节点 `cwd` 的现有源码文件；不支持 glob。 |
| `maxAttempts` | 总尝试次数，包含首次执行；默认 `3`，范围 `1–5`。 |
| `timeoutMs` | 单个检查器的超时，默认 `30000`，最大 `60000` 毫秒。 |
| `maxOutputBytes` | 单个检查器的合并输出上限，默认 `32768`，范围 `1024–131072` 字节。超限终止检查并按工具错误处理。 |
| `pythonExecutable` | 仅 Python 预设可用；值为 `python`、`python3` 或解释器绝对路径，不接受命令行参数。Windows 默认 `python`，其他系统默认 `python3`。 |

`writableFiles` 使用 `/` 分隔路径，文件位于 `src/` 下，目录和文件名仅使用英文字母、数字、下划线及连字符。TypeScript 文件扩展名为 `.ts`，Python 为 `.py`；不允许 `test/`、`tests/` 或 `__tests__/` 子目录。

## 检查预设

| 预设 | 行为 |
|---|---|
| `typecheck` | 使用项目安装的 TypeScript 执行 `tsc --noEmit --pretty false --incremental false --project <cwd>/tsconfig.json`。 |
| `test` | 使用 Node Test Runner 执行工作区顶层 `tests/*.test.ts`，要求至少一个实际测试通过。测试中的 TypeScript 必须能由 Node 直接擦除类型后执行。 |
| `python-syntax` | 通过 Python 内置 `compile()` 检查 `src/` 下的 Python 源码，不生成字节码。 |
| `python-test` | 发现 `tests/test_*.py` 中的 `unittest.TestCase` 测试；至少一个测试正常通过，且无失败或错误。 |

同一节点不能混用 TypeScript 和 Python 预设。Python 检查器使用 `-I -B -X utf8` 启动；应用依赖需提前安装到所选解释器环境，测试可使用 `from src.main import add` 导入源码。仅包含 pytest 风格函数、跳过项或预期失败项的测试不能作为验收通过的依据。

检查命令由预设构造，并以 `shell: false` 启动。源码诊断和断言失败可进入修复轮次；解释器缺失、导入失败、配置错误、超时、输出超限或无有效测试会停止自动修复。

## 一次执行的流程

1. 检查图约束与工作区路径，记录源码、测试和配置的初始哈希。
2. 创建报告；每轮使用独立的执行标识和 `isolated` Agent 会话。
3. Agent 提交候选后，检查是否修改了允许清单以外的文件。
4. 执行检查预设；检查器运行期间如发生文件变化，拒绝验收。
5. 全部通过时返回候选成功结果，由上游引擎提交图状态。
6. 可修复失败转换为诊断摘要，注入下一轮 prompt；尝试耗尽或工具异常则返回不可重试的节点失败。

诊断包含文件、行列、错误码和消息；没有定位信息时保留检查器的错误摘要。下一轮只接收上一轮的诊断摘要，完整检查历史保存在报告中。反馈不作为 prompt 模板再次求值。

所有轮次共享节点取消信号、轮数与费用预算，失败轮次的用量也会记账。`gate.maxAttempts` 与引擎的 `retry.maxAttempts` 含义不同：前者控制验收修复，后者须为 `1`，防止重复套用重试。

## 图与工作区边界

- Gate 节点必须显式使用 `isolated`；图必须串行，不能包含 barrier edges。
- 失败可停止图，或通过 `onError.route` 转入一个 `human` 节点；不允许 `onError.continue`。
- Gate 节点不支持 `response.storage: "artifact"`。
- 节点工作区须在当前项目内部；报告目录必须在候选工作区之外。
- 快照最多覆盖 2000 个文件、32 MiB，跳过 `.git/` 和 `node_modules/`，拒绝扫描范围内的符号链接。
- 文件检查是变更检测，不是操作系统沙箱。Agent、源码和测试仍以当前用户权限运行，适用于可信的小型工作区。
- 拒绝验收不会回滚磁盘上的修改；它阻止的是候选成功写入图状态。下游是否接受结果应以验收状态为准。

## 报告与失败处理

Pi 扩展将逐轮报告写入 `<Pi agent directory>/gatenode/reports/`，通常为 `~/.pi/agent/gatenode/reports/`。报告包含 `runId`、`nodeId`、状态、各轮检查结果、诊断、输出是否截断以及相对初始快照的修改文件。错误信息会给出报告路径。

| 错误码 | 含义 |
|---|---|
| `GATE_CONFIG` | 不支持的门控配置或缺失的输入文件。 |
| `GATE_PROTECTED_FILES` | Agent 修改了允许清单以外的文件，尚未执行检查。 |
| `GATE_WORKSPACE_CHANGED` | 检查期间工作区内容变化。 |
| `GATE_CHECK_ERROR` | 检查器或环境异常，需要人工处理。 |
| `GATE_EXHAUSTED` | 已用完总尝试次数，仍未通过。 |
| `GATE_RECOVERY_REQUIRED` | 同一执行标识已有报告，拒绝自动重放修复。 |

Agent 执行失败保留原错误码，例如 `AGENT_FAILED`；取消返回 `ABORTED`。其他未分类异常返回 `GATE_ERROR`。

示例图将失败转到 `manual`。`acknowledge` 只确认收到失败信息，随后结果为 `needs_manual_repair`；即使工作流完成，也不表示代码验收通过。只有成功分支写入 `accepted`。

人工暂停处可以使用 pi-graph 的 resume。修复循环中途崩溃则不能精确续跑：检查工作区与已有报告后启动新运行，避免重置轮次或重放文件副作用。`/pig delete` 清理上游运行记录，不会删除 GateNode 的独立报告。

## 代码入口

- [executor.ts](../src/gate/executor.ts)：候选验收、修复轮次、报告与反馈。
- [policy.ts](../src/gate/policy.ts)：图配置约束。
- [checker.ts](../src/gate/checker.ts)：固定检查命令、进程限制与 TypeScript 诊断。
- [python-runner.py](../src/gate/python-runner.py)：Python 语法检查和 unittest 验收。
- [workspace.ts](../src/gate/workspace.ts)：路径校验和工作区变更检测。
