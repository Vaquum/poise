"""Starts a test suite on a disposable test box instead of in this workspace, exactly as it was typed.

Poise puts this directory first on PYTHONPATH for what it starts, so every Python
asks here first, whichever virtualenv it belongs to and however it was reached.
docs/Operating.md, "Agents' test suites".
"""
import os
import sys

RUNNERS = {"pytest", "py.test", "unittest"}
# Asking a runner about itself costs nothing, and needs no test box.
PROBES = {"--version", "-V", "--help", "-h"}
# The interpreter's flags whose value is the next argument.
VALUE_FLAGS = {"-W", "-X"}


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


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    argv = getattr(sys, "orig_argv", None)
    if argv is None:
        try:
            with open("/proc/self/cmdline", "rb") as file:
                argv = [os.fsdecode(part) for part in file.read().split(b"\0")[:-1]]
        except OSError:
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
        sys.stderr.write("[poise] cannot start the test box: %s\n" % error)
        os._exit(125)


main()
