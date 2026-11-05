"""Trusted stdlib checker. -I ignores PYTHON* injection; -B avoids workspace pyc files.

This runs candidate code during unittest and is not a security sandbox.
"""
import json
import sys
import tokenize
import traceback
import unittest
from pathlib import Path

ROOT = Path.cwd().resolve()


def diagnostic(code, message, file=None, line=None, column=None):
    return dict(file=file, line=line, column=column, code=code, message=message[:1800])


def finish(status, diagnostics, **counts):
    report = dict(version=1, status=status, diagnostics=diagnostics[:20], **counts)
    print("\nGATENODE_PYTHON_RESULT=" + json.dumps(report, ensure_ascii=False), flush=True)
    return {"passed": 0, "rejected": 1, "error": 2}[status]


def syntax_check():
    sources = sorted((ROOT / "src").rglob("*.py"))
    if not sources:
        return finish("error", [diagnostic("CHECK_ERROR", "No src/**/*.py files found")])
    errors = []
    for path in sources:
        try:
            with tokenize.open(path) as source:
                compile(source.read(), str(path), "exec", dont_inherit=True)
        except SyntaxError as error:
            errors.append(diagnostic(type(error).__name__, str(error), path.relative_to(ROOT).as_posix(), error.lineno, error.offset if error.offset and error.offset > 0 else None))
        if len(errors) >= 20:
            break
    return finish("rejected" if errors else "passed", errors)


class GateResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.passed = 0
        self.diagnostics = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed += 1

    def remember(self, test, error):
        if len(self.diagnostics) >= 20:
            return
        file, line = None, None
        for frame in traceback.extract_tb(error[2]):
            try:
                file = Path(frame.filename).resolve().relative_to(ROOT).as_posix()
                line = frame.lineno
            except ValueError:
                pass
        detail = test.id() + "\n" + "".join(traceback.format_exception(*error))
        self.diagnostics.append(diagnostic(error[0].__name__, detail, file, line))

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.remember(test, error)

    def addError(self, test, error):
        super().addError(test, error)
        self.remember(test, error)

    def addSubTest(self, test, subtest, error):
        super().addSubTest(test, subtest, error)
        if error is not None:
            self.remember(subtest, error)


def test_check():
    # Support both `from src.main import ...` and `from main import ...`.
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROOT / "src"))
    loader = unittest.TestLoader()
    suite = loader.discover(str(ROOT / "tests"), pattern="test_*.py")
    if loader.errors:
        return finish("error", [diagnostic("PYTHON_TEST_IMPORT", "Test discovery/import failed; check the interpreter, dependencies and test files.\n" + text) for text in loader.errors[:20]])
    if suite.countTestCases() == 0:
        return finish("error", [diagnostic("CHECK_ERROR", "No unittest test cases found in tests/test_*.py; define unittest.TestCase methods, not pytest functions")])
    result = unittest.TextTestRunner(verbosity=2, resultclass=GateResult).run(suite)
    if not result.wasSuccessful():
        details = result.diagnostics or [diagnostic("PYTHON_TEST_FAILED", "unittest reported an unexpected success or another failed outcome")]
        return finish("rejected", details, testsRun=result.testsRun, passed=result.passed)
    if result.passed == 0:
        return finish("error", [diagnostic("CHECK_ERROR", "No tests actually passed; skipped and expected-failure cases do not satisfy acceptance")], testsRun=result.testsRun, passed=0)
    return finish("passed", [], testsRun=result.testsRun, passed=result.passed)


def main():
    if sys.version_info < (3, 10):
        return finish("error", [diagnostic("CHECK_ERROR", "Python 3.10 or newer is required")])
    try:
        if sys.argv[1:] == ["python-syntax"]:
            return syntax_check()
        if sys.argv[1:] == ["python-test"]:
            return test_check()
        raise ValueError("Unknown Python check preset")
    except Exception as error:
        return finish("error", [diagnostic(type(error).__name__, "".join(traceback.format_exception(type(error), error, error.__traceback__)))])


if __name__ == "__main__":
    sys.exit(main())
