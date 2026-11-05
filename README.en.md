# GateNode

[中文](README.md) | **English**

Deterministic code acceptance and bounded repair for [pi-graph](https://github.com/huang-sh/pi-graph). Run coding tasks in the Pi terminal, check candidates with fixed tools and tests, and feed failures into another agent invocation. Exhausted attempts and checker errors route to a human node.

## Features

- TypeScript checks using `tsc --noEmit` and Node Test Runner.
- Python syntax checks and standard-library `unittest`.
- Structured diagnostics, separate repair invocations, and shared node budgets.
- Protected-file change detection, per-attempt reports, and human handoff.

## Requirements

Node.js 22.19+, npm, and Python 3.10+ for Python tasks and the full test suite. Actual agent runs require a configured Pi model provider. Pi is included as a project dependency.

From the repository root:

```sh
npm ci --ignore-scripts
```

Use `npm.cmd` instead of `npm` if required by PowerShell.

## Run in Pi

Prepare the TypeScript sample and open Pi:

```sh
npm run demo:prepare
npm start
```

Trust the project and select a configured model with `/model`. Enter these commands in the **Pi chat input**:

```text
/pig list
/pig validate coding-gate
/pig run coding-gate Add optional pagination to listItems while preserving existing calls
```

To select a model on startup, use `npm start -- --model provider/model-id`.

## Python tasks

Place sources under `python-input/src/` and fixed `unittest.TestCase` tests under `python-input/tests/test_*.py`. The sample contains a deliberately incorrect addition function. Source filenames are discovered by the preparation script.

```sh
npm run python:prepare
npm start
```

In Pi:

```text
/pig validate python-gate
/pig run python-gate Fix the code under src according to the acceptance tests
```

An interpreter can be selected with `npm run python:prepare -- --python /absolute/path/to/python`. Install application dependencies in that environment first; virtual environments should stay outside the input directory. Pytest-style test functions are not supported.

## Inputs and outputs

| Task | Input | Modified source |
|---|---|---|
| TypeScript | `demo/fixture/` | `demo-output/<timestamp>/workspace/src/` |
| Python | `python-input/` | `demo-output/python/<timestamp>/workspace/src/` |

Preparation copies inputs into a new workspace and prints the output paths. Agent runs edit that copy. Re-running a graph uses the prepared workspace; run preparation again after changing inputs. Python results also include `outputDirectory` and `outputFiles`.

Pi acceptance reports are stored under `<Pi agent directory>/gatenode/reports/`, normally `~/.pi/agent/gatenode/reports/`. Use `/pig inspect <runId>` to inspect workflow state.

At a `manual` pause, `acknowledge` records receipt of the failure. It leaves the business result as `needs_manual_repair`; it does not approve the candidate.

## Development

```sh
npm run demo
npm run check
npm test
npm run validate:examples
```

The offline demo uses scripted agent responses with real compiler and test processes. For a live, non-interactive model run, use `npm run demo:live -- --model provider/model-id`.

The [testing guide](docs/TESTING.md) describes coverage and prerequisites. CI runs on Windows and Linux with Node 22.19/24 and Python 3.14.

## Constraints

Gated nodes require isolated context and a serial graph. Only explicitly listed existing source files may change. Tests and configuration are protected by post-execution change detection.

Checks are not an OS sandbox. Use trusted workspaces; passing configured checks does not prove complete correctness. Disk changes are retained without automatic rollback. Mid-repair crash recovery requires a new run after inspection; human-node resume uses pi-graph checkpoints.

See [gate configuration](docs/GATE.md), the [graph schema](docs/SCHEMA.md), and [runtime architecture](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE). Fork provenance and compatibility changes are documented in [UPSTREAM.md](UPSTREAM.md).
