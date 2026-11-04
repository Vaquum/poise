"""In a workspace, starts a test suite on a disposable test instance instead. On a test instance, fits a
whole-suite command to it.

Poise puts this directory first on PYTHONPATH for what it starts, so every Python
asks here first, whichever virtualenv it belongs to and however it was reached.
docs/Operating.md, "Agents' test suites".
"""
import os
import sys

RUNNERS = {"pytest", "py.test", "unittest"}
# Asking a runner about itself costs nothing, and needs no test instance.
PROBES = {"--version", "-V", "--help", "-h"}
# The interpreter's flags whose value is the next argument.
VALUE_FLAGS = {"-W", "-X"}
# pytest's, for telling a path it was given from a flag's value.
PYTEST_VALUE_FLAGS = {"-m", "-n", "-o", "-p", "-c", "-r", "-W", "--numprocesses", "--maxfail", "--rootdir", "--junitxml", "--durations", "--tb", "--cov", "--cov-report"}
# A change to one of these can touch any test.
SHARED_FILES = {"conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"}
# A change to only these touches none.
PROSE = (".md", ".rst")


def split_command(args):
    """The runner these interpreter arguments start, and the arguments it gets."""
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "-c" or arg == "-":
            return None, []
        if arg == "-m":
            return (args[index + 1] if index + 1 < len(args) else None), args[index + 2 :]
        if not arg.startswith("-"):
            return os.path.basename(arg), args[index + 1 :]
        index += 2 if arg in VALUE_FLAGS else 1
    return None, []


def test_command(args):
    """Whether these interpreter arguments run a test suite."""
    runner, rest = split_command(args)
    return runner in RUNNERS and not PROBES.intersection(rest)


def names_tests(args):
    """Whether these pytest arguments choose what to run."""
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in PYTEST_VALUE_FLAGS:
            index += 1
        elif not arg.startswith("-") or arg.startswith("-k"):
            return True
        index += 1
    return False


def one_worker(args):
    """The same pytest arguments, without xdist's workers: a test instance has half a CPU."""
    result = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("-n", "--numprocesses"):
            result += [arg, "0"]
            index += 2
            continue
        if arg.startswith("--numprocesses="):
            result.append("--numprocesses=0")
        elif arg.startswith("-n") and arg[2:].replace("auto", "1").isdigit():
            result.append("-n0")
        else:
            result.append(arg)
        index += 1
    return result


def touched_tests(since):
    """The test files a change touches, by name and by who mentions the changed modules; None when that cannot be told."""
    import re
    import subprocess

    def git(*args, nothing_found=0):
        result = subprocess.run(["git", *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if result.returncode not in (0, nothing_found):
            raise OSError("git %s failed" % " ".join(args[:3]))
        return [path for path in os.fsdecode(result.stdout).split("\0") if path]

    try:
        # A change anywhere in the checkout counts, whichever folder the suite runs from; the tests are this folder's.
        top = os.fsdecode(subprocess.run(["git", "rev-parse", "--show-toplevel"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True).stdout).strip()
        changed = git("-C", top, "diff", "--name-only", "-z", since) + git("-C", top, "ls-files", "-z", "--others", "--exclude-standard")
        if any(os.path.basename(path) in SHARED_FILES for path in changed):
            return None
        tests = set()
        modules = set()
        for path in changed:
            name = os.path.basename(path)
            if name.startswith("test_") and name.endswith(".py") or name.endswith("_test.py"):
                here = os.path.relpath(os.path.join(top, path))
                if os.path.exists(here) and not here.startswith(".."):
                    tests.add(here)
            elif name == "__init__.py":
                package = os.path.basename(os.path.dirname(path))
                if not package:
                    return None
                modules.add(re.escape(package))
            elif name.endswith(".py"):
                modules.add(re.escape(name[:-3]))
        if modules:
            pattern = "|".join(sorted(modules))
            tests.update(git("grep", "-z", "-l", "-w", "-E", pattern, "--", "*test_*.py", "*_test.py", nothing_found=1))
    except (OSError, subprocess.CalledProcessError):
        return None
    # Saying no test is touched is only safe when prose, and nothing but prose, changed.
    if not tests and not (changed and all(path.endswith(PROSE) for path in changed)):
        return None
    return sorted(tests)


def fit_to_instance(argv):
    """Fits a pytest command to a test instance, in the arguments the runner is about to read."""
    runner, rest = split_command(argv[1:])
    if runner not in ("pytest", "py.test") or PROBES.intersection(rest):
        return
    # What this runs in its turn is the suite's own business.
    del os.environ["POISE_TEST_INSTANCE"]
    sys.argv[1:] = one_worker(sys.argv[1:])
    since = os.environ.get("POISE_TEST_CHANGED_SINCE")
    if not since or names_tests(rest):
        return
    tests = touched_tests(since)
    if tests is None:
        return
    if not tests:
        sys.stderr.write("[poise] no test touches this change. CI runs the whole suite before merge.\n")
        sys.stderr.flush()
        os._exit(0)
    sys.stderr.write("[poise] running only the %d test files this change touches. CI runs the whole suite before merge.\n" % len(tests))
    sys.argv.extend(tests)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    argv = getattr(sys, "orig_argv", None)
    if argv is None:
        try:
            with open("/proc/self/cmdline", "rb") as file:
                argv = [os.fsdecode(part) for part in file.read().split(b"\0")[:-1]]
        except OSError:
            return
    if os.environ.get("POISE_TEST_INSTANCE") == "1":
        fit_to_instance(argv)
        return
    if not os.path.exists(os.path.join(here, "relay")) or not test_command(argv[1:]):
        return
    try:
        os.execvp(
            "node",
            ["node", os.path.join(here, "run.mjs"), "--also", sys.prefix, "--also", sys.base_prefix, "--"] + argv,
        )
    except OSError as error:
        # site swallows what this module raises and would run the suite here.
        sys.stderr.write("[poise] cannot start the test instance: %s\n" % error)
        os._exit(125)


main()
