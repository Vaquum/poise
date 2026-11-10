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
        write_script(os.path.join(self.actions.bin, 'ssh'), '#!/bin/sh\n[ "$1" = poise-server ] || exit 98\nshift\nexec "$@"\n')
        write_script(os.path.join(self.actions.bin, 'docker'), FAKE_DOCKER)
        self.live(self.old)
        self.actions.deploy_run(head_sha=self.old, apply_sha=self.old, apply='success')

    def live(self, release, **switch):
        self.docker.write_text(json.dumps(dict(image_id=IMAGE_ID,
                                              containers=[f'alice {IMAGE_ID} true /poise-ws-alice'],
                                              health={'poise-ws-alice': [health(release, **switch)]}, calls=[])))

    def observe(self, sync='true', fail=''):
        env = clean_env(HOME=str(self.work), PATH=f'{self.actions.bin}{os.pathsep}{os.environ["PATH"]}',
                        REPO=self.actions.REPO, UPSTREAM_SYNC=sync, DEPLOY_PATH=str(self.deploy.parent),
                        GH_FIXTURES=self.actions.fixtures, GH_CALLS=self.actions.calls, GH_FAIL=fail,
                        FAKE_DOCKER_STATE=str(self.docker), GITHUB_STEP_SUMMARY=self.actions.summary)
        result = subprocess.run(['python3', os.path.join(ROOT, 'deploy', 'release-status.py')],
                                capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

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

    def test_observer_runs_after_skipped_or_failed_sync_without_release_writes(self):
        workflow = Path(ROOT, '.github/workflows/sync-upstream.yml').read_text()
        observer = workflow.split('  observe:\n')[1].split('\n  sync:\n')[0]
        self.assertIn('needs: sync', observer)
        self.assertIn("if: always() && vars.POISE_DEPLOY_HOST != ''", observer)
        self.assertIn('actions: read', observer)
        self.assertNotIn('POISE_UPSTREAM_SYNC ==', observer)
        self.assertIn('python3 deploy/release-status.py', observer)
        self.assertNotIn('sync-gate.sh', observer)
