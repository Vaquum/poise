"""Read-only release diagnosis for the Sync workflow's existing operator summary.

Only the private diagnostic episode is written on the deployment host. Release
controls, rollout receipts and workspace proof files are never changed.
"""

from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

GRACE_SECONDS = 30 * 60
UPSTREAM = 'autonomio/poise'
SHA = re.compile(r'[0-9a-f]{40}')


def command(args, timeout=30, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=timeout, **kwargs).stdout


def collect(repo):
    errors = []
    deadline = time.monotonic() + 120

    def read(path):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('GitHub observation exceeded two minutes')
            return json.loads(command(['gh', 'api', path], timeout=min(30, remaining)))
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            detail = error.stderr.strip()[:1024] if isinstance(error, subprocess.CalledProcessError) else str(error)
            errors.append(f'{path}: unavailable ({detail})')
            return None

    def tip(repository):
        answer = read(f'repos/{repository}/commits/main')
        sha = answer.get('sha', '') if isinstance(answer, dict) else ''
        if isinstance(sha, str) and SHA.fullmatch(sha):
            return sha
        errors.append(f'{repository} main: SHA unavailable')
        return None

    upstream, candidate = tip(UPSTREAM), tip(repo)
    comparison = read(f'repos/{repo}/compare/autonomio:{upstream}...{repo.split("/")[0]}:{candidate}?per_page=1') \
        if upstream and candidate else None
    ancestry = comparison.get('status') if isinstance(comparison, dict) else None
    includes_upstream = ancestry in ('ahead', 'identical') if ancestry in ('ahead', 'identical', 'behind', 'diverged') else None
    if not isinstance(comparison, dict) or comparison.get('status') not in ('ahead', 'identical', 'behind', 'diverged'):
        errors.append('upstream ancestry: unavailable')
    workflows = {}
    for name in ('sync-upstream.yml', 'ci.yml', 'caller.yml', 'deploy.yml'):
        path = f'repos/{repo}/actions/workflows/{name}'
        metadata = read(path)
        state = metadata.get('state') if isinstance(metadata, dict) else None
        if state not in ('active', 'disabled_manually', 'disabled_inactivity', 'deleted'):
            errors.append(f'{name}: workflow state unavailable')
        runs = []
        if name != 'sync-upstream.yml':
            query = 'branch=main' if name == 'deploy.yml' else f'head_sha={candidate}'
            answer = read(f'{path}/runs?{query}&per_page=30')
            if isinstance(answer, dict) and isinstance(answer.get('workflow_runs'), list):
                # The same evidence selection as the deployment/sync gates:
                # exact-main push CI, and Deploy's SHA-named apply step.
                runs = [run for run in answer['workflow_runs']
                        if run.get('head_branch') == 'main'
                        and run.get('head_repository', {}).get('full_name') == repo
                        and (run.get('event') in ('workflow_run', 'workflow_dispatch') if name == 'deploy.yml'
                             else run.get('event') == 'push' and run.get('head_sha') == candidate)]
                runs.sort(key=lambda run: (run['created_at'], run['id']), reverse=True)
            else:
                errors.append(f'{name}: runs unavailable')
        workflows[name] = {'state': state, 'runs': runs}
    for run in workflows['deploy.yml']['runs']:
        if run['status'] == 'completed':
            answer = read(f'repos/{repo}/actions/runs/{run["id"]}/jobs?per_page=100')
            if isinstance(answer, dict) and isinstance(answer.get('jobs'), list):
                run['steps'] = [step for job in answer['jobs'] for step in job.get('steps', [])]
            else:
                errors.append(f'Deploy {run["id"]}: steps unavailable')
            if any(step.get('name') == f'Deploy {candidate}' and step.get('conclusion') not in (None, 'skipped')
                   for step in run.get('steps', [])):
                break
    if tip(repo) != candidate:
        errors.append('fork main changed during observation; recheck next tick')
    return dict(repo=repo, upstream=upstream, candidate=candidate, includes_upstream=includes_upstream,
                sync=os.environ.get('UPSTREAM_SYNC', ''), workflows=workflows, errors=errors,
                deploy_path=os.environ['DEPLOY_PATH'])


def workspace_proof(deploy, candidate, remembered=frozenset()):
    """Use the existing rollout inventory and fresh health/image evidence, even
    when the receipt is terminal. A receipt's historical success is not a probe.
    Handles remembered from the open episode stay expected until verified, so a
    workspace that vanishes mid-episode cannot clear it by absence.
    """
    notes, errors, expected, serving = [], [], set(remembered), []
    store = deploy / '.env.workspace-proof.rollouts'
    pointer = target = image = None
    try:
        pointer = (store / 'current').read_text().strip()
        if not re.fullmatch(r'[0-9a-f]{40}\.[a-zA-Z0-9]{6}', pointer):
            raise ValueError('invalid current rollout ID')
        receipt = (store / pointer).read_text()
        target, image, _, handles, _, _ = receipt.splitlines()[:6]
        if not SHA.fullmatch(target) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
            raise ValueError('invalid rollout target/image')
        expected.update(handles.split())
    except (OSError, ValueError) as error:
        errors.append(f'retained rollout unavailable ({error}); expected inventory unverified')
        pointer = None
    pending = deploy / '.env.workspace-proof'
    if pending.exists():
        expected.update(pending.read_text().split())
    inventory = command(['docker', 'ps', '--all', '--filter', 'label=poise.managed=true',
                         '--format', '{{.ID}} {{.Label "poise.workspace"}}'])
    ids = []
    for line in inventory.splitlines():
        container, handle = line.split()
        expected.add(handle)
        ids.append(container)
    try:
        lines = command(['docker', 'inspect', '--format',
                         '{{index .Config.Labels "poise.workspace"}} {{.Image}} {{.State.Running}} {{.Name}}',
                         *ids]) if ids else ''
    except subprocess.SubprocessError:
        # A container may vanish between ps and inspect; every handle ps
        # discovered is already expected, so leaving them all unobserved keeps
        # the episode open without dropping the vanished workspace.
        lines = ''
    observed, proven, running, switching, lag = set(), set(), 0, False, False
    for line in lines.splitlines():
        handle, actual_image, active, name = line.split()
        if handle in observed:
            raise ValueError(f'duplicate workspace {handle}')
        observed.add(handle)
        if active != 'true':
            notes.append(f'{handle}: stopped; image {actual_image} (no serving proof)')
            if actual_image == image:
                proven.add(handle)
            continue
        running += 1
        try:
            health = json.loads(command(['docker', 'exec', name.lstrip('/'), 'curl', '-fsS', '--max-time', '10',
                                         'http://127.0.0.1:5555/api/service/health']))
            release = health.get('release')
            if health.get('ok') is not True or health.get('mode') != 'service' or not isinstance(release, str) \
                    or not SHA.fullmatch(release) or health.get('version') != release:
                raise ValueError('health does not verify the active release/build')
            serving.append(f'{handle}: {release}')
            notes.append(f'{handle}: active {release}; desired {health.get("desiredRelease")}; '
                         f'switching {health.get("switching")}; pending since {health.get("pendingSince")}; '
                         f'waiting on {health.get("switchWaitingOn")}; drain {health.get("draining")}; '
                         f'running Caller {health.get("runningCallerCalls")}; '
                         f'unsettled native Calls {health.get("unsettledNativeCalls")}')
            if release == candidate and not health.get('switching'):
                proven.add(handle)
            if release != candidate:
                lag = True
            if release != candidate and candidate in (health.get('desiredRelease'), health.get('switching')):
                switching = True
        except (OSError, subprocess.SubprocessError, ValueError, AttributeError) as error:
            errors.append(f'{handle}: current health unavailable ({error})')
    for handle in expected - observed:
        errors.append(f'{handle}: missing workspace; replacement not verified')
    if pointer and ((store / 'current').read_text().strip() != pointer or (store / pointer).read_text() != receipt):
        errors.append('rollout changed during observation')
    if not expected or not running:
        errors.append('no running workspace establishes a serving release')
    return dict(current=bool(expected) and expected <= proven and target == candidate and not errors,
                serving=serving, notes=notes, errors=errors, rollout=pointer, switching=switching and target == candidate, lag=lag,
                expected=sorted(expected))


def stage(evidence, proof):
    repo, workflows = evidence['repo'], evidence['workflows']

    def workflow(name, reason, action):
        paused = workflows[name]['state'] == 'disabled_manually'
        return (f'{name}: deliberate pause (workflow disabled manually)' if paused else reason,
                f'{action} [Open workflow](https://github.com/{repo}/actions/workflows/{name}).', paused)

    if not evidence['upstream'] or not evidence['candidate']:
        return 'release evidence unavailable', 'Restore the GitHub evidence read; recheck on the next tick.', False
    if evidence['includes_upstream'] is None:
        return 'sync ancestry evidence unavailable', 'Restore the GitHub comparison read; retain any open condition.', False
    if not evidence['includes_upstream'] and evidence['sync'] != 'true':
        return workflow('sync-upstream.yml', 'sync disabled; intent unknown' if evidence['sync'] else 'sync missing; intent unknown',
                        'Confirm operator intent; if updates are intended, set POISE_UPSTREAM_SYNC=true and check POISE_SYNC_TOKEN '
                        f'in [repository settings](https://github.com/{repo}/settings/variables/actions).')
    if proof['current'] and not evidence['includes_upstream']:
        return workflow('sync-upstream.yml', 'sync missing: the serving candidate has not incorporated upstream',
                        'Inspect the sync run and repair its merge/token failure.')
    verified_at = '1970-01-01T00:00:00Z'
    for name in ('ci.yml', 'caller.yml'):
        runs = workflows[name]['runs']
        if not runs:
            return workflow(name, f'{name}: no exact-main push run', 'Check POISE_SYNC_TOKEN and start the required push verification.')
        run = runs[0]
        verified_at = max(verified_at, run['updated_at'])
        if run['status'] != 'completed' or run['conclusion'] != 'success':
            reason = f'{name}: {run["status"]} {run.get("conclusion") or ""} ({run["html_url"]})'
            return workflow(name, reason, 'Wait for running verification, or inspect and repair the failed run; retain the normal gate.')
    if proof.get('switching'):
        return 'workspace switch: intended release pending', \
            'Inspect the current health blockers and retained rollout on the deployment host; allow the normal switch/drain to finish.', False
    in_flight = None
    for run in workflows['deploy.yml']['runs']:
        if run['status'] != 'completed':
            if in_flight is None:
                in_flight = run
            continue
        steps = run.get('steps', [])
        attempted = [step for step in steps if step.get('name') == f'Deploy {evidence["candidate"]}'
                     and step.get('conclusion') not in (None, 'skipped')]
        if any(step['conclusion'] == 'success' for step in attempted):
            return 'workspace switch: intended release not verified serving', \
                'The host applied the release. Sync rechecks the retained proof while the gateway handles activation. ' \
                f'[Deploy evidence]({run["html_url"]}).', False
        admitted = any(step.get('name') == 'Refuse any tip whose required CI did not pass on it'
                       and (step.get('started_at') or '') >= verified_at for step in steps)
        if run['conclusion'] != 'success' and (attempted or admitted or run['created_at'] >= verified_at):
            return f'Deploy: {run["conclusion"]} ({run["html_url"]})', \
                'Inspect and repair the failed Deploy, then rerun the normal gated workflow.', False
    if in_flight:
        return workflow('deploy.yml', f'Deploy: {in_flight["status"]} ({in_flight["html_url"]})', 'Wait for the serialized gated Deploy.')
    return workflow('deploy.yml', 'Deploy: no successful SHA-named apply attempt', 'Inspect the Deploy handoff; dispatch only the normal gated Deploy.')


def observe(evidence):
    deploy = Path(evidence['deploy_path']) / 'deploy'
    with (deploy / '.env.release-lag.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = deploy / '.env.release-lag'
        state = json.loads(state_path.read_text()) if state_path.exists() else None
        if state is not None and (not isinstance(state, dict) or not re.fullmatch(r'[0-9a-f]{32}', state.get('id', ''))
                                  or not isinstance(state.get('since'), str) or not isinstance(state.get('notified'), bool)
                                  or not isinstance(state.get('handles', []), list)
                                  or any(not isinstance(handle, str) or not handle or ' ' in handle
                                         for handle in state.get('handles', []))):
            raise ValueError('invalid retained release-lag condition; refusing to reset it')
        remembered = set(state.get('handles', [])) if state else set()
        try:
            proof = workspace_proof(deploy, evidence['candidate'], remembered)
        except (OSError, subprocess.SubprocessError, ValueError, AttributeError) as error:
            proof = dict(current=False, serving=[], notes=[], errors=[f'workspace proof unavailable ({error})'], rollout=None,
                         expected=sorted(remembered))
        evidence['errors'].extend(proof['errors'])
        now = datetime.now(timezone.utc)
        recovered = evidence['includes_upstream'] and proof['current'] and not evidence['errors']
        reason, action, paused = stage(evidence, proof)
        if recovered:
            status = 'recovered' if state else 'current'
            reason, action = 'intended fork candidate verified serving', 'No action required.'
        elif evidence['upstream'] or evidence['candidate'] or state:
            if state is None:
                state = dict(id=uuid4().hex, since=now.isoformat(), notified=False, handles=[])
            age = (now - datetime.fromisoformat(state['since'])).total_seconds()
            state['handles'] = sorted(set(state.get('handles', [])) | set(proof.get('expected', [])))
            status = 'deliberate pause' if paused else 'stale release' if age >= GRACE_SECONDS else 'in progress (30-minute grace)'
            if evidence['errors']:
                if not paused and age >= GRACE_SECONDS and evidence['includes_upstream'] is not False and not proof.get('lag'):
                    status = 'release verification overdue'
                status += '; evidence unavailable, unresolved'
        else:
            status = 'observation unavailable; release expectation unknown'
        warning = bool(state) and not recovered and not paused and age >= GRACE_SECONDS and not state['notified']
        if warning:
            state['notified'] = True
        summary = render(evidence, proof, state, status, reason, action)
        # Store only diagnostic identity/age/inventory, never release authority
        # or a new rollout format. A newer tip cannot replace an unresolved episode.
        with tempfile.NamedTemporaryFile(mode='w', dir=deploy, prefix='.env.release-lag.', delete=False) as file:
            json.dump(None if recovered else state, file)
            temporary = Path(file.name)
        temporary.replace(state_path)
        return dict(summary=summary, warning=warning)


def render(evidence, proof, state, status, reason, action):
    repo = evidence['repo']
    lines = [f'### Production release: {status}', '', f'First waiting or failed stage: **{reason}**.', '', f'Next action: {action}', '']
    if state:
        lines += [f'Condition `{state["id"]}`; first observed {state["since"]}. Fixed grace: 30 minutes.', '']
    for label, repository, sha in (('Upstream tip', UPSTREAM, evidence['upstream']), ('Fork candidate', repo, evidence['candidate'])):
        lines.append(f'- {label}: [{sha}](https://github.com/{repository}/commit/{sha})' if sha else f'- {label}: unavailable')
    lines.append('- Serving now (fresh health): ' + ('; '.join(proof['serving']) or 'unavailable'))
    if proof['rollout']:
        lines.append(f'- Retained rollout: `deploy/.env.workspace-proof.rollouts/{proof["rollout"]}` (historical outcome is not serving proof).')
    lines += [f'- {note}' for note in proof['notes']]
    for name, workflow in evidence['workflows'].items():
        for run in workflow['runs'][:1]:
            lines.append(f'- [{name}]({run["html_url"]}): {run["status"]} {run.get("conclusion") or ""}; recorded head `{run["head_sha"]}`.')
    lines += [f'- Unavailable evidence: {error}' for error in evidence['errors']]
    lines += ['', f'[Sync observations](https://github.com/{repo}/actions/workflows/sync-upstream.yml) · '
              '[Release operation and verification](https://github.com/autonomio/poise/blob/main/docs/Operating.md#run-your-own-poise-from-a-fork)', '']
    return '\n'.join(lines)


def main():
    evidence = collect(os.environ['REPO'])
    # Ship this observer, not the possibly stale production checkout's code.
    # Inputs and code use stdin; no credential or operator value becomes shell syntax.
    program = 'import json\nEVIDENCE = json.loads(' + repr(json.dumps(evidence)) + ')\n' + Path(__file__).read_text()
    try:
        answer = json.loads(subprocess.run(['ssh', 'poise-server', 'python3', '-', '--remote'], input=program,
                                          check=True, capture_output=True, text=True, timeout=300).stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        detail = error.stderr.strip()[:2048] if isinstance(error, subprocess.CalledProcessError) else str(error)
        evidence['errors'].append(f'deployment host observation unavailable ({detail}); retained condition cannot be cleared or reset')
        proof = dict(current=False, serving=[], notes=[], rollout=None)
        reason, action, _ = stage(evidence, proof)
        answer = dict(summary=render(evidence, proof, None, 'observation unavailable; condition and age retained on host', reason, action), warning=False)
    if answer['warning']:
        print('::warning::Production release overdue; inspect this run\'s release summary.')
    print(answer['summary'])
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as file:
            file.write(answer['summary'])


if __name__ == '__main__':
    if sys.argv[1:] == ['--remote']:
        print(json.dumps(observe(EVIDENCE)))
    else:
        main()
