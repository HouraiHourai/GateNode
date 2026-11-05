# Python input

Sources belong in `src/`; fixed acceptance tests belong in `tests/`.

```text
python-input/
├── src/main.py
└── tests/test_main.py
```

The sample `add()` implementation intentionally subtracts so the tests provide a repair target. Replace the sample pair or use other source filenames. Source paths must be existing `.py` files under `src/`; tests must be named `test_*.py` and define `unittest.TestCase` methods.

For example, `tests/test_main.py` imports the function with `from src.main import add`. Pytest-style functions are not discovered by this runner.

From the repository root:

```sh
npm run python:prepare
npm start
```

In Pi, select a configured model with `/model`, then run:

```text
/pig run python-gate 根据 tests 中的验收要求修复 src 下的代码
```

Preparation copies inputs to `demo-output/python/<timestamp>/workspace/` and prints each output path. Agent runs modify sources in that workspace; the input files and acceptance tests stay unchanged. Re-run preparation after updating inputs. Restart Pi after upgrading extension code.

## Python environment

Python 3.10+ is required. Unittest is included in the standard library. To use a virtual environment, pass its absolute interpreter path:

```sh
npm run python:prepare -- --python /absolute/path/to/python
```

On Windows, use the absolute path to the environment's `Scripts/python.exe`.

Install application dependencies before preparation and keep the environment outside this input directory. Import failures stop acceptance. Tests must leave the workspace unchanged; checker invocations disable bytecode writes.
