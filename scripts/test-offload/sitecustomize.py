"""Starts a test suite on a disposable test instance instead of in this workspace.

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


def test_command(args):
    """Whether these interpreter arguments run a test suite."""
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "-c" or arg == "-":
            return False
        if arg == "-m":
            runner, rest = (args[index + 1] if index + 1 < len(args) else ""), args[index + 2 :]
            break
        if not arg.startswith("-"):
            runner, rest = os.path.basename(arg), args[index + 1 :]
            break
        index += 2 if arg in VALUE_FLAGS else 1
    else:
        return False
    return runner in RUNNERS and not PROBES.intersection(rest)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    if not os.path.exists(os.path.join(here, "relay")):
        return
    try:
        with open("/proc/self/cmdline", "rb") as file:
            argv = [os.fsdecode(part) for part in file.read().split(b"\0")[:-1]]
    except OSError:
        return
    if not test_command(argv[1:]):
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
