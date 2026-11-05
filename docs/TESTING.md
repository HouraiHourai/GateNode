# 测试与开发

## 环境

- Node.js 22.19+，使用仓库的 `package-lock.json` 安装依赖。
- Python 3.10+，Windows 的 `python` 或其他系统的 `python3` 需可用。
- Git；Windows 上执行 Bash 工具集成测试还需要 Git Bash。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run validate:examples
npm run demo
```

PowerShell 中可使用 `npm.cmd`。完整测试不需要模型 API 凭据。`npm run test:gate` 只运行门控相关测试。

## 验证范围

| 命令 | 验证内容 |
|---|---|
| `npm run check` | TypeScript 静态检查。 |
| `npm test` | 图引擎、checkpoint、Pi runtime、CLI 和 GateNode 的自动化测试。 |
| `npm run validate:examples` | 编译仓库中的图定义；编译错误导致失败，设计诊断可能作为 warning 输出。 |
| `npm run demo` | 脚本 Agent 配合真实 TypeScript 检查器，验证首次通过、修复后通过、尝试耗尽、工具错误四条路径。 |

GateNode 测试覆盖失败反馈、仅提交已验收的候选、尝试上限、共享预算、测试文件保护、检查超时与输出限制、人工确认不等于验收、已有执行标识的恢复拒绝。Python 测试还覆盖语法错误、断言失败、无有效测试、导入错误、提前退出和自定义文件准备流程。

Pi runtime 和 CLI 集成测试启动真实 Pi 会话并执行文件工具，模型响应来自 Pi 的 faux provider。它们验证扩展集成与反馈闭环，不代表真实模型的修复成功率。测试包含平台条件；某些上游用例在 Windows 上跳过，以测试输出为准。

离线演示输出到 `demo-output/demos/<timestamp>/`。生成文件、会话、报告和缓存由 `.gitignore` 排除，不应作为源码提交。

## 真实模型运行

交互运行见 [README](../README.md)。非交互 TypeScript 演示：

```sh
npm run demo:live -- --model provider/model-id
```

该命令使用本机已配置的 Pi 模型凭据，会调用模型 API。候选代码、`result.json`、检查报告和会话输出到 `demo-output/live-runs/<timestamp>/`。具体修复轮数受模型行为影响；以报告中的检查结果和业务状态判断是否验收。

## CI 与依赖

[GitHub Actions](../.github/workflows/ci.yml) 配置 Ubuntu / Windows 与 Node.js 22.19 / 24 的矩阵，Python 使用 3.14；执行静态检查、完整测试、图验证及离线演示。CI 不配置模型密钥，也不调用真实模型 API。

Pi 开发依赖固定为 0.83.0，升级应同时验证 provider 注册、会话恢复和 CLI 行为。依赖漏洞需通过 `npm audit` 单独检查；功能测试通过不代表依赖没有安全问题。不要在未验证兼容性的情况下使用 `npm audit fix --force` 跨主版本更新。
