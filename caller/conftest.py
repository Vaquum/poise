"""Keeps Caller's tests away from the developer's agent CLI logins.

Caller reads provider configuration from the environment and falls back to
the home folder: Muse's sign-in under XDG_CONFIG_HOME or ~/.config, gh's under
GH_CONFIG_DIR. Every test session starts with these pointed at empty temporary
folders, so no test reads or writes a real login, as POISE_REPO_SPECIFICS
requires of every test in this repository. Tests that need a configuration
create their own.
"""

import os
import shutil
import tempfile

ISOLATED = (
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "GH_CONFIG_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GROK_HOME",
)

_isolated_home = None


# pytest passes hook implementations only the arguments they name.
def pytest_configure():
    global _isolated_home
    _isolated_home = tempfile.mkdtemp(prefix="caller-tests-")
    for name in ISOLATED:
        folder = os.path.join(_isolated_home, name.lower())
        os.mkdir(folder)
        os.environ[name] = folder


def pytest_unconfigure():
    if _isolated_home is not None:
        shutil.rmtree(_isolated_home)
