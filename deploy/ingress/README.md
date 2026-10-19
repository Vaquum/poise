# External Caddy diagnostics

This optional reader runs on the operator-owned Docker host serving the external
Poise proxy. It sends only Poise-host native Warning/Error/Critical records to
the existing gateway operator command. It adds no network listener or workspace access.
The normal one-record `ingress` command remains available for manual diagnosis.

The reader requires Python 3.10+, Docker CLI and OpenSSH. It polls every 15 seconds,
replays the oldest retained native record within 30 days, and resumes its centrally
committed window after restart. Backfill continues at one-second intervals until
current; a source with no retained records starts with a five-minute window.
Initial coverage makes no claim about earlier history. A replaced
container or a cursor older than the oldest retained Docker record leaves an
explicit historical uncertainty interval. Docker rotation cannot recover deleted
records. Restore/replay never removes historical gaps.

Reads have a 1 MiB/1,000-native-record bound, at most 100 projected diagnostics
per transaction, and a 12-second total replay budget. Projection input includes
identity and JSON framing in its separate 1 MiB bound. Large
windows are halved; their starting boundary and unfinished reductions survive
the next poll's replay budget in memory until the container or committed
checkpoint changes. Native reads recheck retention after completion so rotation
cannot silently advance past deleted history. The projected records are checked
again against the gateway's 64 KiB limit after redaction, including expansion.
An irreducible one-second window is recorded as incomplete
and advanced. Unavailable sources never advance the checkpoint. Native routine
and unstructured output are excluded by policy. The reader sends no request URI,
headers, body or unrelated host records. The gateway checks the domain again and
applies canonical redaction before committing. Events, coverage and the source
checkpoint share one transaction; acknowledgements follow that commit. Current
health expires after 90 seconds without a report, independently of process health.

## Install

First deploy a reviewed gateway containing `ingress-stream`. On the edge host,
create `/etc/poise-ingress` mode 0700 and generate a dedicated key there:

```sh
ssh-keygen -t ed25519 -N '' -f /etc/poise-ingress/id_ed25519
```

Keep the private key on the edge host. Install only its public key into the
gateway host operator's `authorized_keys`, prefixed by:

```text
restrict,command="/usr/bin/docker exec -i poise-gateway node dist/diagnostics/cli.js ingress-stream"
```

The command path/container must match the actual installation. Restrict the key
to the edge source address with `from="ADDRESS",` where that address is stable.
Do not reuse a login/deployment key. The account already owns Docker; this key
must not grant a shell, forwarding, PTY or arbitrary Docker commands.

Obtain the gateway host key over an already verified administrative connection;
put it into `/etc/poise-ingress/known_hosts`. The reader refuses unknown/changed
keys, SSH-agent identities and user SSH configuration. Write mode-0600
`/etc/poise-ingress/config.json` using the actual installation values:

```json
{
  "domain": "poise.example.org",
  "container": "external-caddy",
  "target": "poise@gateway-host",
  "identity": "/etc/poise-ingress/id_ed25519",
  "known_hosts": "/etc/poise-ingress/known_hosts"
}
```

Install this directory's `reporter.py` into `/opt/poise-ingress/reporter.py` and
`poise-ingress.service` into `/etc/systemd/system/`. Run a bounded initial proof:

```sh
python3 /opt/poise-ingress/reporter.py --config /etc/poise-ingress/config.json --once
systemctl daemon-reload
systemctl enable --now poise-ingress.service
```

Inspect `external-ingress` in the gateway operator `health` output or Logging's
Data control: `currentStatus` must be connected and `observationExpiresAt` must
advance. `status: partial` may retain earlier gaps; inspect those separately.
Verify an actual retained Poise proxy diagnostic using operator `query`/`event`.
Use journal output for collector failures; never dump raw shared proxy logs.
Stopping/removing the unit and its one public-key line revokes this integration.

The gateway process owns `logging.ingress.sock` (0600) and the only writable
connection. Both operator ingress commands relay to it; the gateway must be
running. A stream receives a new challenge and gateway-issued observation time
before scanning. Acknowledgement follows the atomic event/coverage/checkpoint
commit. The 90-second lease starts at the challenge issue time, rather than
receipt of an old packet. An expired source opens a gap at its last confirmed
observation. Gateway restart is initializing until another source scan.

Build the edge projection with Node 22 after installing the gateway lockfile:

```sh
npm ci --prefix gateway
node deploy/ingress/build.mjs /tmp/poise-ingress/projection.cjs
```

The bundle targets the installed edge Node 12 syntax/runtime and contains the
same canonical host classifier and redactor used by the gateway. Copy that
bundle beside `reporter.py` as `/opt/poise-ingress/projection.cjs`; the edge needs
Python 3.10+, Node, Docker and OpenSSH. Redaction and strict host projection run
locally before SSH transmission. Raw request headers, bodies, addresses and URIs
never form an outgoing record. Full native timestamps remain in occurrence
identity even though display times use milliseconds. Reads never use `--tail`.

Attributable TLS records require a structured Poise name. Unattributable
hostless shared-proxy records are excluded; access loggers are also excluded.
The installed proxy has no server access logging enabled. Its native causal
warning/error records remain authoritative; no access event is promoted to an
error. All retained diagnostics continue to share the existing finite FIFO
budget; this integration adds no quota policy or guarantee against a flood.

Window ends are one second before the earlier of the edge and gateway handshake
clocks, so a slow edge cannot commit beyond events it has not emitted yet. The edge clock must agree within
five seconds; greater skew reports an explicit unavailable observation, keeps
the committed checkpoint and uses the normal 15-second cadence until repaired.
Unstructured shared-proxy text is excluded without discarding attributable JSON
records in the same second. Invalid Docker timestamp framing remains a source
continuity failure. Diagnostics storage or relay startup failure is independently
reported and retried every five seconds; login and workspace routing continue.
