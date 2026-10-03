#!/usr/bin/env python3
"""Process-group leader between Caller and the native agent (poise-contract.md §1.6).

    lease_gate.py --lease-worker IDENT --control-fd FD [--status-fd FD] -- COMMAND...

Waits on the control pipe for `GO`; the holder writes it only after this pid,
group and IDENT are registered in the checkout lease. EOF before GO (the
holder died) exits 3 without starting anything. After GO the agent runs in
this group with the gate's stdio and without either pipe, and `STARTED` is
written to the status pipe so the holder knows an agent existed whatever its
exit status. EOF after GO, or SIGTERM/SIGINT/SIGHUP, stops the whole group:
SIGTERM, SIGKILL after five seconds. When the agent exits, lingering
descendants are settled the same way before the gate exits with the agent's
status; a group that cannot be listed is never reported settled, and one that
will not die is reported with exit 70 so the holder keeps the lease.
"""
import os
import select
import signal
import subprocess
import sys
from time import monotonic, sleep

GRACE_SECONDS = 5.0
SETTLE_DEADLINE_SECONDS = 20.0
PS_TIMEOUT_SECONDS = 5.0
NO_GO = 3
UNSETTLED = 70


def members(pgid: int) -> list[int] | None:
    """Pids in our group other than ourselves; None when they cannot be listed.
    ps runs in its own session so it is not itself a member."""
    try:
        done = subprocess.run(["ps", "-eo", "pid=,pgid="], text=True, capture_output=True,
                              timeout=PS_TIMEOUT_SECONDS, start_new_session=True)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if done.returncode != 0:
        return None
    found = []
    for line in done.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit() and int(parts[1]) == pgid and int(parts[0]) != os.getpid():
            found.append(int(parts[0]))
    return found


def settle(pgid: int) -> bool:
    """Stop everything else in our group and wait until it is gone. Each
    signal round uses a fresh listing, so a pid is only ever signalled while
    it is seen in the group. False when the group could not be proven empty."""
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)
    started = monotonic()
    termed = False
    while True:
        listed = members(pgid)
        if listed == []:
            return True
        elapsed = monotonic() - started
        if listed is None:
            print("lease_gate: cannot list the process group; waiting", file=sys.stderr)
        elif not termed or elapsed >= GRACE_SECONDS:
            for pid in listed:
                try:
                    os.kill(pid, signal.SIGKILL if termed and elapsed >= GRACE_SECONDS else signal.SIGTERM)
                except ProcessLookupError:
                    pass
            termed = True
        if elapsed >= SETTLE_DEADLINE_SECONDS:
            print(f"lease_gate: {len(listed) if listed is not None else '?'} process(es) in the worker group did not exit", file=sys.stderr)
            return False
        sleep(0.05)


def main(argv: list[str]) -> int:
    ident = control = status = None
    rest = argv[1:]
    while rest and rest[0] != "--":
        flag, value, *rest = rest
        if flag == "--lease-worker":
            ident = value
        elif flag == "--control-fd":
            control = int(value)
        elif flag == "--status-fd":
            status = int(value)
        else:
            raise SystemExit(f"lease_gate: unknown option {flag}")
    command = rest[1:]
    if not ident or control is None or not command:
        raise SystemExit("usage: lease_gate.py --lease-worker IDENT --control-fd FD [--status-fd FD] -- COMMAND...")
    if os.getpgid(0) != os.getpid():
        os.setpgid(0, 0)
    pgid = os.getpid()

    buffer = b""
    while b"\n" not in buffer:
        chunk = os.read(control, 64)
        if not chunk:
            return NO_GO
        buffer += chunk
    if buffer.split(b"\n", 1)[0] != b"GO":
        return NO_GO

    stopping = []
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: stopping.append("signal"))
    agent = subprocess.Popen(command, close_fds=True)
    if status is not None:
        os.write(status, b"STARTED\n")
    while agent.poll() is None:
        readable, _, _ = select.select([control], [], [], 0.2)
        if readable and not os.read(control, 4096):
            stopping.append("holder gone")
        if stopping:
            try:
                agent.terminate()
            except ProcessLookupError:
                pass
            try:
                agent.wait(timeout=GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                agent.kill()
                agent.wait()
    if not settle(pgid):
        return UNSETTLED
    if stopping:
        return 128 + signal.SIGTERM
    return agent.returncode if agent.returncode >= 0 else 128 - agent.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
