"""Exercise the scheduled observer through the existing Actions/Docker fixtures."""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import unittest

import test_actions
from test_actions import ROOT, clean_env, write_script
from test_deploy_verify import FAKE_DOCKER, IMAGE_ID, health


class ReleaseStatusTest(unittest.TestCase):
    def setUp(self):
        self.actions = test_actions.GateTest('test_proceeds_when_both_workflows_passed_on_the_tip')
        self.actions.setUp()
        self.addCleanup(self.actions.doCleanups)
        self.actions.green()
        self.work = Path(self.actions.work.name)
        self.deploy = self.work / 'server' / 'deploy'
        self.deploy.mkdir(parents=True)
        self.store = self.deploy / '.env.workspace-proof.rollouts'
        self.store.mkdir()
        self.record = self.store / (self.actions.TIP + '.ABC123')
        self.record.write_text(f'{self.actions.TIP}\n{IMAGE_ID}\npoise-runtime:latest\nalice \ncomplete\n2026-11-10T18:00:00Z\n')
        (self.store / 'current').write_text(self.record.name)
        self.state = self.deploy / '.env.release-lag'
        self.docker = self.work / 'docker.json'
        self.old = 'a' * 40
        self.upstream = 'c' * 40
        self.actions.fixture('upstream-tip.json', {'sha': self.upstream})
        self.actions.fixture('compare.json', {'status': 'behind'})
        for name in ('sync-upstream', 'ci', 'caller', 'deploy'):
            self.actions.fixture(name + '-state.json', {'state': 'active'})
        gh = self.actions.FAKE_GH.replace('  *commits/main) file=tip.json;;', '''  repos/autonomio/poise/commits/main) file=upstream-tip.json;;
  *compare/*) file=compare.json;;
  *workflows/sync-upstream.yml) file=sync-upstream-state.json;;
  *workflows/ci.yml) file=ci-state.json;;
  *workflows/caller.yml) file=caller-state.json;;
  *workflows/deploy.yml) file=deploy-state.json;;
  *commits/main) file=tip.json;;''')
        write_script(os.path.join(self.actions.bin, 'gh'), gh)
        Path(self.actions.bin, 'gh').rename(Path(self.actions.bin, 'gh-read'))
        write_script(os.path.join(self.actions.bin, 'gh'), r'''#!/usr/bin/env python3
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs
args = sys.argv[1:]
fixtures = Path(os.environ['GH_FIXTURES'])
path = next((arg for arg in args if arg.startswith('repos/')), '')
if '/issues' in path:
    assert path.startswith('repos/triage/poise/issues')
    assert os.environ['GH_TOKEN'] == 'issue-fixture'
    control = json.loads((fixtures / 'issue-control.json').read_text())
    issues = json.loads((fixtures / 'issues.json').read_text())
    with Path(os.environ['GH_CALLS']).open('a') as file:
        file.write(('POST ' if 'POST' in args else 'GET ') + path + '\n')
    if 'POST' not in args:
        if control.get('lookup_fail'):
            print('lookup unavailable', file=sys.stderr)
            sys.exit(1)
        if control.get('resume'):
            docker = Path(os.environ['FAKE_DOCKER_STATE'])
            state = json.loads(docker.read_text())
            body = json.loads(state['health']['poise-ws-alice'][-1])
            body['draining'] = False
            state['health']['poise-ws-alice'] = [json.dumps(body)]
            docker.write_text(json.dumps(state))
        query = parse_qs(path.partition('?')[2])
        if 'since' in query:
            since = datetime.fromisoformat(query['since'][0].replace('Z', '+00:00'))
            issues = [issue for issue in issues if datetime.fromisoformat(issue['updated_at'].replace('Z', '+00:00')) >= since]
        page = int(query['page'][0])
        print(json.dumps(list(reversed(issues))[(page - 1) * 100:page * 100]))
    else:
        payload = json.load(sys.stdin)
        if control.get('reject'):
            print('HTTP/2.0 403 Forbidden\n\n{}')
            sys.exit(1)
        if control.get('unknown'):
            sys.exit(1)
        issue = dict(payload, number=len(issues) + 1, state='open',
                     updated_at=control.get('updated_at') or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                     html_url=f'https://github.com/triage/poise/issues/{len(issues) + 1}')
        issues.append(issue)
        (fixtures / 'issues.json').write_text(json.dumps(issues))
        if control.get('response_loss'):
            sys.exit(1)
        print('HTTP/2.0 201 Created\n\n' + json.dumps(issue))
elif '/actions/jobs/' in path and path.endswith('/logs'):
    assert os.environ['GH_TOKEN'] == 'observation-fixture'
    print((fixtures / 'verify-log.txt').read_text())
else:
    assert os.environ['GH_TOKEN'] == 'observation-fixture'
    os.execv(str(Path(__file__).with_name('gh-read')), ['gh-read', *args])
''')
        self.actions.fixture('issues.json', [])
        self.actions.fixture('issue-control.json', {})
        write_script(os.path.join(self.actions.bin, 'ssh'), '#!/bin/sh\n[ "$1" = poise-server ] || exit 98\nshift\nunset GH_TOKEN POISE_RELEASE_REPORT_TOKEN\nexec "$@"\n')
        write_script(os.path.join(self.actions.bin, 'docker'), FAKE_DOCKER)
        self.live(self.old)
        self.actions.deploy_run(head_sha=self.old, apply_sha=self.old, apply='success')

    def live(self, release, draining=False, **switch):
        body = json.loads(health(release, **switch))
        body['draining'] = draining
        self.docker.write_text(json.dumps(dict(image_id=IMAGE_ID,
                                              containers=[f'alice {IMAGE_ID} true /poise-ws-alice'],
                                              health={'poise-ws-alice': [json.dumps(body)]}, calls=[])))

    def observe(self, sync='true', fail='', report=False, code=0, **settings):
        env = clean_env(HOME=str(self.work), PATH=f'{self.actions.bin}{os.pathsep}{os.environ["PATH"]}',
                        REPO=self.actions.REPO, UPSTREAM_SYNC=sync, DEPLOY_PATH=str(self.deploy.parent),
                        GH_FIXTURES=self.actions.fixtures, GH_CALLS=self.actions.calls, GH_FAIL=fail,
                        FAKE_DOCKER_STATE=str(self.docker), GITHUB_STEP_SUMMARY=self.actions.summary,
                        GH_TOKEN='observation-fixture', GITHUB_RUN_ID='999',
                        POISE_RELEASE_REPORT_REPOSITORY='triage/poise' if report else '',
                        POISE_RELEASE_REPORT_TOKEN='issue-fixture' if report else '')
        env.update(settings)
        result = subprocess.run(['python3', os.path.join(ROOT, 'deploy', 'release-status.py')],
                                capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        return result.stdout

    def stalled(self, rollout='ABC123', end=None):
        self.record = self.store / (self.actions.TIP + '.' + rollout)
        self.record.write_text(f'{self.actions.TIP}\n{IMAGE_ID}\npoise-runtime:latest\nalice \npending\n2026-11-10T18:00:00Z\n'
                               '2026-11-10T18:10:00Z pending Verified: . alice: pending older release\n')
        (self.store / 'current').write_text(self.record.name)
        self.live(self.old, draining=True)
        end = end or datetime.now(timezone.utc) - timedelta(minutes=1)
        start = end - timedelta(seconds=602)
        self.actions.deploy_run(apply='success', conclusion='failure', head_sha=self.old)
        # GitHub truncates step timestamps, while its log lines retain fractions
        # (as in production job 132119670366's final verifier second).
        job = dict(id=901, steps=[
            dict(name=f'Deploy {self.actions.TIP}', conclusion='success', completed_at=start.strftime('%Y-%m-%dT%H:%M:%SZ')),
            dict(name=f'Verify rollout {self.actions.TIP}', conclusion='failure',
                 started_at=start.strftime('%Y-%m-%dT%H:%M:%SZ'), completed_at=end.strftime('%Y-%m-%dT%H:%M:%SZ')),
        ])
        self.actions.fixture('jobs-301.json', {'jobs': [job]})
        log = f'{(end - timedelta(seconds=1)).isoformat().replace("+00:00", "Z")} Rollout {self.record.name}: pending (release {self.actions.TIP}, image {IMAGE_ID}).\n' \
              f'{end.isoformat().replace("+00:00", "Z")} poise: the deploy of {self.actions.TIP} is still pending after 600s: these workspaces do not serve it yet:\n'
        Path(self.actions.fixtures, 'verify-log.txt').write_text(log)
        return job, log

    def issues(self):
        return json.loads(Path(self.actions.fixtures, 'issues.json').read_text())

    def overdue(self):
        state = json.loads(self.state.read_text())
        state['since'] = (datetime.now(timezone.utc) - timedelta(minutes=31)).isoformat()
        self.state.write_text(json.dumps(state))
        return state

    def test_disabled_or_unset_sync_old_green_deploy_and_newer_tips_keep_one_episode(self):
        record = self.record.read_text()
        for sync in ('false', ''):
            with self.subTest(sync=sync):
                self.state.unlink(missing_ok=True)
                initial = self.observe(sync)
                self.assertIn('in progress (30-minute grace)', initial)
                self.assertIn('intent unknown', initial)
                self.assertIn(f'alice: {self.old}', initial)
                original = self.overdue()
                overdue = self.observe(sync)
                self.assertIn('stale release', overdue)
                self.assertEqual(overdue.count('::warning::'), 1)
                self.actions.fixture('upstream-tip.json', {'sha': 'd' * 40})
                again = self.observe(sync)
                self.assertNotIn('::warning::', again)
                self.assertIn(original['id'], again)
                retained = json.loads(self.state.read_text())
                self.assertEqual(retained['id'], original['id'])
                self.assertEqual(retained['since'], original['since'])
        self.assertEqual(self.record.read_text(), record)
        self.assertFalse((self.deploy / '.env.workspace-proof').exists())
        calls = Path(self.actions.calls).read_text()
        self.assertNotIn('workflow run', calls)
        self.assertNotIn('merge-upstream', calls)

    def test_gated_candidate_retention_and_only_fresh_intended_serving_proof_recovers(self):
        self.actions.fixture('ci-runs.json', {'workflow_runs': [
            self.actions.workflow_run(101, status='in_progress', conclusion=None)]})
        first = self.observe()
        self.assertIn('ci.yml: in_progress', first)
        self.assertNotIn('sync missing:', first)
        self.assertNotIn('::warning::', first)
        self.actions.green()
        self.actions.deploy_run()
        self.assertIn('Deploy: no successful SHA-named apply attempt', self.observe())
        self.actions.deploy_run(status='queued', conclusion=None, head_sha=self.old)
        self.assertIn('Deploy: queued', self.observe())
        self.live(self.old, desired=self.actions.TIP)
        self.assertIn('workspace switch: intended release pending', self.observe())
        self.live(self.old)
        self.actions.deploy_run(head_sha=self.old, apply='success')
        self.assertIn('workspace switch', self.observe())
        self.actions.fixture('upstream-tip.json', {'sha': self.actions.TIP})
        self.actions.fixture('compare.json', {'status': 'identical'})
        self.overdue()
        # The terminal complete receipt and successful apply cannot clear old
        # health, or health that fails before the intended release is observed.
        self.assertIn('stale release', self.observe())
        state = json.loads(self.state.read_text())
        unavailable = self.observe(fail='tip.json')
        self.assertIn('unavailable, unresolved', unavailable)
        self.assertEqual(json.loads(self.state.read_text())['id'], state['id'])
        self.live(self.actions.TIP)
        recovered = self.observe()
        self.assertIn('Production release: recovered', recovered)
        self.assertIn(f'alice: {self.actions.TIP}', recovered)
        self.assertIsNone(json.loads(self.state.read_text()))
        self.assertIn('Production release: current', self.observe())

    def test_unavailable_health_missing_inventory_or_stopped_only_cannot_clear(self):
        self.observe()
        self.overdue()
        self.actions.fixture('upstream-tip.json', {'sha': self.actions.TIP})
        self.actions.fixture('compare.json', {'status': 'identical'})
        self.actions.deploy_run(apply='success')
        state = json.loads(self.state.read_text())
        for changes in ({'health': {}}, {'containers': []},
                        {'containers': [f'alice {IMAGE_ID} false /poise-ws-alice']}):
            with self.subTest(changes=changes):
                data = dict(image_id=IMAGE_ID, containers=[f'alice {IMAGE_ID} true /poise-ws-alice'],
                            health={'poise-ws-alice': [health(self.actions.TIP)]}, calls=[])
                data.update(changes)
                self.docker.write_text(json.dumps(data))
                summary = self.observe()
                self.assertIn('unavailable, unresolved', summary)
                self.assertNotIn('Production release: recovered', summary)
                self.assertEqual(json.loads(self.state.read_text())['since'], state['since'])

    def test_explicit_workflow_pause_is_distinct_and_preserves_open_age(self):
        self.actions.fixture('caller-runs.json', {'workflow_runs': []})
        self.actions.fixture('caller-state.json', {'state': 'disabled_manually'})
        self.assertIn('deliberate pause', self.observe())
        original = self.overdue()
        paused = self.observe()
        self.assertIn('caller.yml: deliberate pause', paused)
        self.assertNotIn('::warning::', paused)
        self.actions.fixture('caller-state.json', {'state': 'active'})
        resumed = self.observe()
        self.assertIn('stale release', resumed)
        self.assertIn(original['id'], resumed)
        self.assertIn('::warning::', resumed)

    def test_legacy_missing_rollout_still_reports_fresh_serving_and_never_recovers(self):
        (self.store / 'current').unlink()
        summary = self.observe(sync='false')
        self.assertIn(f'alice: {self.old}', summary)
        self.assertIn('retained rollout unavailable', summary)
        self.assertIn('intent unknown', summary)
        self.assertIsNotNone(json.loads(self.state.read_text()))

    def test_newest_exact_push_and_failed_deploy_are_the_first_blocking_stage(self):
        self.actions.fixture('ci-runs.json', {'workflow_runs': [
            self.actions.workflow_run(101),
            self.actions.workflow_run(103, conclusion='failure', created_at='2099-01-01T00:00:00Z'),
            self.actions.workflow_run(104, event='pull_request', created_at='2099-02-01T00:00:00Z'),
        ]})
        self.assertIn('ci.yml: completed failure', self.observe())
        self.actions.green()
        self.actions.deploy_run(conclusion='failure', apply='failure')
        self.assertIn('Deploy: failure', self.observe())
        self.actions.deploy_run(conclusion='failure', apply='success')
        self.assertIn('The host applied the release.', self.observe())
        self.record.write_text(self.record.read_text().replace('\ncomplete\n', '\nfailed\n'))
        summary = self.observe()
        self.assertIn('workspace switch: intended release failed to start', summary)
        self.assertIn(f'{self.record.name}` (failed)', summary)

    def test_vanished_inventory_only_workspace_keeps_episode_open(self):
        self.actions.fixture('upstream-tip.json', {'sha': self.actions.TIP})
        self.actions.fixture('compare.json', {'status': 'identical'})
        self.actions.deploy_run(apply='success')
        stale = f'bob {IMAGE_ID} true /poise-ws-bob'
        self.docker.write_text(json.dumps(dict(
            image_id=IMAGE_ID,
            containers=[f'alice {IMAGE_ID} true /poise-ws-alice', stale],
            health={'poise-ws-alice': [health(self.actions.TIP)],
                    'poise-ws-bob': [health(self.old)]}, calls=[])))
        self.assertIn('workspace switch', self.observe())
        original = self.overdue()
        overdue = self.observe()
        self.assertIn('::warning::', overdue)
        self.assertIn(original['id'], overdue)
        remembered = json.loads(self.state.read_text())
        self.assertEqual(set(remembered['handles']), {'alice', 'bob'})
        self.live(self.actions.TIP)
        missing = self.observe()
        self.assertNotIn('Production release: recovered', missing)
        self.assertIn('bob: missing workspace; replacement not verified', missing)
        self.assertIn('unavailable, unresolved', missing)
        self.assertNotIn('::warning::', missing)
        retained = json.loads(self.state.read_text())
        self.assertEqual(retained['id'], original['id'])
        self.assertEqual(retained['since'], original['since'])
        self.assertEqual(set(retained['handles']), {'alice', 'bob'})

    def test_container_vanishing_before_inspect_stays_expected(self):
        self.actions.fixture('upstream-tip.json', {'sha': self.actions.TIP})
        self.actions.fixture('compare.json', {'status': 'identical'})
        self.actions.deploy_run(apply='success')
        stale = f'bob {IMAGE_ID} true /poise-ws-bob'
        self.docker.write_text(json.dumps(dict(
            image_id=IMAGE_ID,
            containers=[f'alice {IMAGE_ID} true /poise-ws-alice', stale],
            health={'poise-ws-alice': [health(self.actions.TIP)],
                    'poise-ws-bob': [health(self.old)]}, calls=[])))
        self.assertIn('workspace switch', self.observe())
        original = self.overdue()
        self.assertIn('::warning::', self.observe())
        data = json.loads(self.docker.read_text())
        data['inspect_seen'] = 0
        data['inspect_fail_times'] = 1
        self.docker.write_text(json.dumps(data))
        vanished = self.observe()
        self.assertNotIn('Production release: recovered', vanished)
        self.assertIn('bob: missing workspace; replacement not verified', vanished)
        self.assertNotIn('::warning::', vanished)
        retained = json.loads(self.state.read_text())
        self.assertEqual(retained['id'], original['id'])
        self.assertEqual(retained['since'], original['since'])
        self.assertEqual(set(retained['handles']), {'alice', 'bob'})

    def test_verified_replacement_reports_despite_prior_warning_and_deduplicates_new_candidates(self):
        self.observe()
        self.overdue()
        self.observe()  # Existing installations have already delivered their warning.
        self.assertTrue(json.loads(self.state.read_text())['notified'])
        self.stalled()
        receipt = self.record.read_text()
        output = self.observe(report=True)
        issue, = self.issues()
        self.assertIn('Drain issue created:', output)
        self.assertEqual(issue['labels'], ['poise'])
        self.assertIn(f'<!-- poise-release-drain {self.actions.REPO} ', issue['body'])
        self.assertIn(f'Requested release: `{self.actions.TIP}`', issue['body'])
        self.assertIn(f'serving `{self.old}`', issue['body'])
        self.assertIn('admissions paused (`draining=True`)', issue['body'])
        self.assertIn(f'desired `{self.old}`; switching `None`; pending since `None`', issue['body'])
        self.assertIn('Known blocker: unavailable in health', issue['body'])
        self.assertIn('Last retained rollout observation:', issue['body'])
        self.assertIn('Later progress: unavailable', issue['body'])
        self.assertIn('Next recorded action:', issue['body'])
        self.assertIn('/actions/runs/301/job/901', issue['body'])
        self.assertIn('/actions/runs/999', issue['body'])
        original = json.loads(self.state.read_text())
        for _ in range(2):
            self.observe(report=True)  # Each invocation is a new process.
        self.actions.TIP = 'd' * 40
        self.actions.green()
        self.stalled(rollout='DEF456')
        self.observe(report=True)
        self.assertEqual(len(self.issues()), 1)
        self.assertEqual(json.loads(self.state.read_text())['id'], original['id'])
        self.assertEqual(json.loads(self.state.read_text())['since'], original['since'])
        self.assertEqual(self.store.joinpath('b' * 40 + '.ABC123').read_text(), receipt)
        calls = Path(self.actions.calls).read_text()
        self.assertEqual(calls.count('POST repos/triage/poise/issues'), 1)
        self.assertNotIn('workflow run', calls)
        self.assertNotIn('merge-upstream', calls)

    def test_lost_create_response_reconciles_closed_issue_after_restart(self):
        self.stalled()
        data = json.loads(self.docker.read_text())
        body = json.loads(data['health']['poise-ws-alice'][0])
        body.update(unsettledNativeCalls=3, nativeCleanupHold=dict(callId='original-call', reason='retained directory busy'))
        data['health']['poise-ws-alice'] = [json.dumps(body)]
        self.docker.write_text(json.dumps(data))
        # Reconciliation uses identity even if GitHub's clock trails the host.
        self.actions.fixture('issue-control.json', {'response_loss': True,
                             'updated_at': (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()})
        self.assertIn('outcome unknown', self.observe(report=True, code=1))
        self.assertEqual(len(self.issues()), 1)
        self.assertIn('native cleanup Call original-call: retained directory busy', self.issues()[0]['body'])
        self.assertIn('unsettled native Calls 3', self.issues()[0]['body'])
        state = json.loads(self.state.read_text())
        self.assertNotIn('url', state['report'])
        issues = self.issues()
        issues[0].update(state='closed', labels=[])
        issues.extend(dict(body='unrelated issue', html_url=f'https://github.com/triage/poise/issues/{number}',
                           updated_at=datetime.now(timezone.utc).isoformat()) for number in range(2, 102))
        self.actions.fixture('issues.json', issues)
        self.actions.fixture('issue-control.json', {})
        self.assertIn('Drain issue reconciled:', self.observe(report=True))
        self.observe(report=True)
        self.assertEqual(self.issues(), issues)
        self.assertEqual(Path(self.actions.calls).read_text().count('POST repos/triage/poise/issues'), 1)

    def test_resume_rearms_independent_drain_while_release_lag_remains(self):
        self.stalled()
        self.observe(report=True)
        original = json.loads(self.state.read_text())
        self.live(self.old)
        self.assertNotIn('Production release: recovered', self.observe(report=True))
        resumed = json.loads(self.state.read_text())
        self.assertNotEqual(resumed['id'], original['id'])
        self.assertEqual(resumed['since'], original['since'])
        self.assertNotIn('report', resumed)
        self.assertEqual(self.issues()[0]['state'], 'open')
        # The previous verifier cannot establish a later independent incident.
        self.live(self.old, draining=True)
        self.observe(report=True)
        self.assertEqual(len(self.issues()), 1)
        self.stalled(rollout='GHI789', end=datetime.now(timezone.utc))
        self.observe(report=True)
        issues = self.issues()
        self.assertEqual(len(issues), 2)
        self.assertIn(resumed['id'], issues[1]['body'])
        self.assertNotIn(original['id'], issues[1]['body'])
        self.actions.fixture('upstream-tip.json', {'sha': self.actions.TIP})
        self.actions.fixture('compare.json', {'status': 'identical'})
        self.live(self.actions.TIP)
        self.assertIn('Production release: recovered', self.observe(report=True))
        self.assertIsNone(json.loads(self.state.read_text()))
        self.assertTrue(all(issue['state'] == 'open' for issue in self.issues()))

    def test_lookup_failure_does_not_reserve_creation_and_rejection_can_retry(self):
        self.stalled()
        self.actions.fixture('issue-control.json', {'lookup_fail': True})
        self.assertIn('publication unavailable', self.observe(report=True, code=1))
        self.assertNotIn('report', json.loads(self.state.read_text()))
        self.actions.fixture('issue-control.json', {'reject': True})
        self.assertIn('HTTP 403', self.observe(report=True, code=1))
        self.assertNotIn('report', json.loads(self.state.read_text()))
        self.assertEqual(self.issues(), [])
        self.actions.fixture('issue-control.json', {})
        self.observe(report=True)
        self.assertEqual(len(self.issues()), 1)

    def test_ambiguous_post_without_a_visible_issue_cannot_post_again(self):
        self.stalled()
        self.actions.fixture('issue-control.json', {'unknown': True})
        self.observe(report=True, code=1)
        self.actions.fixture('issue-control.json', {})
        self.assertIn('no second POST', self.observe(report=True, code=1))
        self.assertEqual(self.issues(), [])
        self.assertEqual(Path(self.actions.calls).read_text().count('POST repos/triage/poise/issues'), 1)

    def test_unverified_pending_missing_or_recovered_evidence_cannot_file(self):
        for case in ('disabled', 'no-token', 'invalid-destination', 'no-observation-link', 'workflow-failed',
                     'different-rollout', 'different-image', 'short-verifier', 'other-job', 'not-draining',
                     'missing-health', 'missing-rollout', 'recovered', 'recovered-during-lookup', 'old-timeout'):
            with self.subTest(case=case):
                self.state.unlink(missing_ok=True)
                self.actions.fixture('issue-control.json', {})
                job, log = self.stalled()
                settings = {}
                enabled, code = True, 0
                if case == 'disabled':
                    enabled = False
                elif case == 'no-token':
                    settings['POISE_RELEASE_REPORT_TOKEN'] = ''
                    code = 1
                elif case == 'invalid-destination':
                    settings['POISE_RELEASE_REPORT_REPOSITORY'] = 'triage/poise/another'
                    code = 1
                elif case == 'no-observation-link':
                    settings['GITHUB_RUN_ID'] = ''
                    code = 1
                elif case == 'workflow-failed':
                    job['steps'] = job['steps'][:1]
                elif case == 'different-rollout':
                    log = log.replace('.ABC123:', '.XYZ789:')
                elif case == 'different-image':
                    log = log.replace(IMAGE_ID, 'sha256:' + 'f' * 64)
                elif case == 'short-verifier':
                    job['steps'][1]['started_at'] = job['steps'][1]['completed_at']
                elif case == 'other-job':
                    self.actions.fixture('jobs-301.json', {'jobs': [dict(id=900, steps=job['steps'][:1]),
                                                                               dict(id=901, steps=job['steps'][1:])]})
                elif case == 'not-draining':
                    self.live(self.old, desired=self.actions.TIP)
                elif case == 'missing-health':
                    data = json.loads(self.docker.read_text())
                    data['health'] = {}
                    self.docker.write_text(json.dumps(data))
                elif case == 'missing-rollout':
                    (self.store / 'current').unlink()
                elif case == 'recovered':
                    self.live(self.actions.TIP)
                    self.actions.fixture('compare.json', {'status': 'identical'})
                elif case == 'recovered-during-lookup':
                    self.actions.fixture('issue-control.json', {'resume': True})
                elif case == 'old-timeout':
                    log = log.replace('poise: the deploy', 'unrelated failure: the deploy')
                if case != 'other-job':
                    self.actions.fixture('jobs-301.json', {'jobs': [job]})
                Path(self.actions.fixtures, 'verify-log.txt').write_text(log)
                self.observe(report=enabled, code=code, **settings)
                self.assertEqual(self.issues(), [])
                self.actions.fixture('compare.json', {'status': 'behind'})

    def test_current_release_still_draining_is_not_recovery(self):
        self.stalled()
        self.live(self.actions.TIP, draining=True)
        self.actions.fixture('compare.json', {'status': 'identical'})
        self.observe(report=True)
        self.assertIsNotNone(json.loads(self.state.read_text()))
        self.assertEqual(len(self.issues()), 1)

    def test_observer_runs_after_skipped_or_failed_sync_without_release_writes(self):
        workflow = Path(ROOT, '.github/workflows/sync-upstream.yml').read_text()
        observer = workflow.split('  observe:\n')[1].split('\n  sync:\n')[0]
        self.assertIn('needs: sync', observer)
        self.assertIn("if: always() && vars.POISE_DEPLOY_HOST != ''", observer)
        self.assertIn('actions: read', observer)
        self.assertNotIn('issues: write', observer)
        self.assertIn('vars.POISE_RELEASE_REPORT_REPOSITORY', observer)
        self.assertIn('secrets.POISE_RELEASE_REPORT_TOKEN', observer)
        self.assertNotIn('POISE_UPSTREAM_SYNC ==', observer)
        self.assertIn('python3 deploy/release-status.py', observer)
        self.assertNotIn('sync-gate.sh', observer)
