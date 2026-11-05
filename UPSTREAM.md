# Upstream

GateNode is based on [huang-sh/pi-graph](https://github.com/huang-sh/pi-graph), licensed under MIT.

- Source revision: [`255d1f15d5f786a9af0e80e85f85021e37da2854`](https://github.com/huang-sh/pi-graph/tree/255d1f15d5f786a9af0e80e85f85021e37da2854).
- Upstream package: `@shying/pi-graph@0.2.0`.
- Pi dependencies: `0.83.0`, pinned in `package-lock.json`.
- Original copyright notice: [LICENSE](LICENSE).

The graph scheduler, state model, checkpoints, Pi agent sessions, context modes, human nodes, `/pig` commands, and terminal board come from pi-graph.

GateNode adds the `gate` policy, `GateNodeExecutor`, TypeScript/Python check presets, repair feedback, workspace change detection, acceptance reports, and task-preparation scripts. Graph definitions and the extension entry points integrate these additions without changing the scheduler or checkpoint data format.

Compatibility changes include transferring registered model providers through Pi 0.83's public registry and opening checkpoint files with a writable handle for Windows `fsync`. The Windows Bash test helper locates Git Bash without changing global Pi settings.

The original [README](https://github.com/huang-sh/pi-graph/blob/255d1f15d5f786a9af0e80e85f85021e37da2854/README.md) and [changelog](https://github.com/huang-sh/pi-graph/blob/255d1f15d5f786a9af0e80e85f85021e37da2854/CHANGELOG.md) are available upstream.
