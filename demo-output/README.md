# Task output

Generated workspaces are stored here and excluded from Git. Preparation prints the source paths for each run.

| Command | Workspace |
|---|---|
| `npm run demo:prepare` | `<timestamp>/workspace/` |
| `npm run python:prepare` | `python/<timestamp>/workspace/` |
| `npm run demo` | `demos/<timestamp>/<scenario>/workspace/` |
| `npm run demo:live -- --model provider/model-id` | `live-runs/<timestamp>/workspace/` |

Modified code is under each workspace's `src/` directory. Re-running a prepared graph updates that workspace; preparation creates a new copy from the input files.

A candidate file may exist even when acceptance fails. Check the run status and acceptance report before using it. Pi reports are stored under `<Pi agent directory>/gatenode/reports/`; scripted runs place reports beside their workspace in `reports/`.
