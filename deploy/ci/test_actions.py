"""Tests deploy/actions/, the scripts .github/workflows/deploy.yml runs to deploy a fork.

    python3 -m unittest discover --start-directory deploy/ci --pattern 'test_*.py'
"""

import base64
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
ACTIONS = os.path.join(ROOT, 'deploy', 'actions')
WORKFLOWS = [os.path.join(ROOT, '.github', 'workflows', name) for name in ('deploy.yml', 'sync-upstream.yml')]
DEPLOY_INPUTS = ('VARS', 'REPO', 'SHA', 'DEPLOY_PATH', 'TOKEN')


def clean_env(**extra):
    """This process's environment without deployment settings or the developer's git configuration."""
    env = {name: value for name, value in os.environ.items()
           if not name.startswith(('POISE_', 'GIT_', 'COMPOSE_')) and name not in DEPLOY_INPUTS}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
    env.update(extra)
    return env


def write_script(path, text):
    with open(path, 'w') as file:
        file.write(text)
    os.chmod(path, 0o755)


class EnvFileTest(unittest.TestCase):
    def env_file(self, variables, secret: 'str | None' = 's3cret', google_secret=None):
        env = clean_env(VARS=json.dumps(variables))
        if secret is not None:
            env['POISE_GITHUB_CLIENT_SECRET'] = secret
        if google_secret is not None:
            env['POISE_GOOGLE_CLIENT_SECRET'] = google_secret
        return subprocess.run([os.path.join(ACTIONS, 'env.sh')], capture_output=True, text=True, env=env)

    def test_writes_the_poise_variables_then_the_client_secret(self):
        result = self.env_file({
            'POISE_DOMAIN': 'poise.example.com',
            'POISE_ADMINS': 'root, alice',
            'POISE_PROXY_LISTEN': '192.168.150.10:8080',
            'POISE_DEPLOY_HOST': '192.0.2.10',
            'POISE_UPSTREAM_SYNC': 'true',
            'OTHER_SETTING': 'kept out',
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'POISE_ADMINS=root, alice\nPOISE_DOMAIN=poise.example.com\n'
                                        'POISE_PROXY_LISTEN=192.168.150.10:8080\nPOISE_GITHUB_CLIENT_SECRET=s3cret\n')

    def test_refuses_to_run_without_the_client_secret(self):
        result = self.env_file({'POISE_DOMAIN': 'poise.example.com'}, secret=None)
        self.assertEqual(result.returncode, 1)
        self.assertIn('no POISE_GITHUB_CLIENT_SECRET secret', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_refuses_values_that_would_break_the_file_or_expose_the_secret(self):
        for variables, secret, says in [
            ({'POISE_ADMINS': 'root\nPOISE_ALLOWED_USERS=mallory'}, 's3cret', 'POISE_ADMINS spans more than one line'),
            ({'POISE_GITHUB_CLIENT_SECRET': 'shown in the settings'}, 's3cret', 'make it a secret instead'),
            ({}, 'one\ntwo', 'POISE_GITHUB_CLIENT_SECRET secret spans more than one line'),
        ]:
            result = self.env_file(variables, secret)
            self.assertEqual(result.returncode, 1, variables)
            self.assertIn(says, result.stderr)


    def test_google_client_pair_is_optional_and_secret_is_not_a_variable(self):
        for variables, google_secret, error in [
            ({'POISE_GOOGLE_CLIENT_ID': 'google-client'}, None, 'must be set together'),
            ({}, 'google-test-secret', 'must be set together'),
            ({'POISE_GOOGLE_CLIENT_SECRET': 'variable-test-secret'}, None, 'make it a secret instead'),
            ({'POISE_GOOGLE_CLIENT_ID': 'google-client', 'POISE_GOOGLE_CLIENT_SECRET': 'variable-test-secret'},
             'google-test-secret', 'make it a secret instead'),
            ({'POISE_GOOGLE_CLIENT_ID': 'google-client'}, 'first\nsecond', 'secret spans more than one line'),
            ({'POISE_GOOGLE_CLIENT_ID': 'google-client'}, 'first\rsecond', 'secret spans more than one line'),
        ]:
            with self.subTest(variables=list(variables), error=error):
                result = self.env_file(variables, google_secret=google_secret)
                self.assertEqual(result.returncode, 1)
                self.assertIn(error, result.stderr)
                self.assertEqual(result.stdout, '')
                for value in ('variable-test-secret', 'google-test-secret', 'first', 'second', 's3cret'):
                    self.assertNotIn(value, result.stderr)

    def test_empty_google_client_pair_stays_disabled(self):
        result = self.env_file({'POISE_GOOGLE_CLIENT_ID': ''}, google_secret='')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('POISE_GOOGLE_CLIENT_SECRET=', result.stdout)

    def test_workflow_supplies_the_google_actions_secret(self):
        with open(WORKFLOWS[0]) as file:
            self.assertIn('POISE_GOOGLE_CLIENT_SECRET: ${{ secrets.POISE_GOOGLE_CLIENT_SECRET }}', file.read())


class SshSetupTest(unittest.TestCase):
    SETTINGS = {
        'POISE_DEPLOY_HOST': '192.168.150.10',
        'POISE_DEPLOY_USER': 'poise',
        'POISE_DEPLOY_KNOWN_HOSTS': '192.168.150.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKey',
        'POISE_DEPLOY_SSH_KEY': '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----',
    }

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.ssh = os.path.join(self.home.name, '.ssh')

    def setup_ssh(self, **changes):
        settings = {name: value for name, value in {**self.SETTINGS, **changes}.items() if value is not None}
        return subprocess.run([os.path.join(ACTIONS, 'ssh-setup.sh')], capture_output=True, text=True,
                              env=clean_env(HOME=self.home.name, **settings))

    def resolved(self):
        """What ssh makes of poise-server with the written configuration."""
        result = subprocess.run(['ssh', '-F', os.path.join(self.ssh, 'config'), '-G', 'poise-server'],
                                capture_output=True, text=True, env=clean_env(HOME=self.home.name))
        self.assertEqual(result.returncode, 0, result.stderr)
        options = {}
        for line in result.stdout.splitlines():
            name, _, value = line.partition(' ')
            options.setdefault(name, []).append(value)
        return options

    def test_reaches_the_server_with_the_deploy_key_and_known_host_keys_only(self):
        result = self.setup_ssh()
        self.assertEqual(result.returncode, 0, result.stderr)
        options = self.resolved()
        self.assertEqual(options['hostname'], ['192.168.150.10'])
        self.assertEqual(options['user'], ['poise'])
        self.assertEqual(options['port'], ['22'])
        self.assertIn(options.get('proxyjump', ['none'])[0], ('none', ''))
        self.assertEqual(options['identityfile'], [os.path.join(self.ssh, 'poise_deploy')])
        self.assertEqual(options['identitiesonly'], ['yes'])
        self.assertEqual(options['stricthostkeychecking'], ['true'])
        self.assertEqual(options['userknownhostsfile'], [os.path.join(self.ssh, 'poise_known_hosts')])
        self.assertEqual(options['batchmode'], ['yes'])
        for name in ('poise_deploy', 'poise_known_hosts', 'config'):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.ssh, name)).st_mode), 0o600, name)
        with open(os.path.join(self.ssh, 'poise_deploy')) as file:
            self.assertEqual(file.read(), self.SETTINGS['POISE_DEPLOY_SSH_KEY'] + '\n')

    def test_goes_through_the_jump_host_on_another_port(self):
        result = self.setup_ssh(POISE_DEPLOY_JUMP='poise-deploy@203.0.113.7', POISE_DEPLOY_PORT='2222')
        self.assertEqual(result.returncode, 0, result.stderr)
        options = self.resolved()
        # Newer ssh prints the address in brackets.
        self.assertEqual([jump.replace('[', '').replace(']', '') for jump in options['proxyjump']], ['poise-deploy@203.0.113.7'])
        self.assertEqual(options['port'], ['2222'])

    def test_names_each_missing_setting(self):
        for name, says in [
            ('POISE_DEPLOY_HOST', 'no POISE_DEPLOY_HOST variable'),
            ('POISE_DEPLOY_USER', 'no POISE_DEPLOY_USER variable'),
            ('POISE_DEPLOY_SSH_KEY', 'no POISE_DEPLOY_SSH_KEY secret'),
            ('POISE_DEPLOY_KNOWN_HOSTS', 'no POISE_DEPLOY_KNOWN_HOSTS variable'),
        ]:
            result = self.setup_ssh(**{name: None})
            self.assertEqual(result.returncode, 1, name)
            self.assertIn(says, result.stderr)

    def test_refuses_a_setting_that_would_add_to_the_configuration(self):
        result = self.setup_ssh(POISE_DEPLOY_HOST='192.168.150.10\n  ProxyCommand sh -c id')
        self.assertEqual(result.returncode, 1)
        self.assertIn('may hold only a host name, an address, a user and a port', result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.ssh, 'config')))


class DeployTest(unittest.TestCase):
    """deploy.sh and remote.sh together, with a local repository, ssh running the server's side here, and stand-in scripts."""

    TOKEN = 'ghs_runtoken'

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        work = self.work.name
        self.calls = os.path.join(work, 'calls.log')
        self.ssh_calls = os.path.join(work, 'ssh.log')
        self.origin = os.path.join(work, 'origin.git')
        self.path = os.path.join(work, 'srv', 'poise')
        self.bin = os.path.join(work, 'bin')
        os.mkdir(self.bin)
        # The gateway's container exists once install.sh has run. ssh runs the command here, as the server would.
        write_script(os.path.join(self.bin, 'docker'), f'#!/bin/sh\n[ -e "{work}/installed" ]\n')
        write_script(os.path.join(self.bin, 'ssh'),
                     f'#!/bin/sh\nprintf "%s\\n" "$*" >>"{self.ssh_calls}"\n[ "$1" = poise-server ] || exit 99\nshift\nexec "$@"\n')
        self.git('init', '--quiet', '--bare', '--initial-branch=main', self.origin)
        self.git('-C', self.origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
        self.seed = os.path.join(work, 'seed')
        self.git('clone', '--quiet', self.origin, self.seed)
        self.commits = [self.commit('first'), self.commit('second', {'docs/new.md': 'added by the second commit'})]

    def git(self, *args):
        return subprocess.run(['git', *args], capture_output=True, text=True, check=True, env=clean_env()).stdout.strip()

    def commit(self, label, files=None):
        """A commit on origin's main, with FILES, whose install.sh and upgrade.sh say they ran, and at which commit."""
        for name, text in (files or {}).items():
            os.makedirs(os.path.dirname(os.path.join(self.seed, name)), exist_ok=True)
            with open(os.path.join(self.seed, name), 'w') as file:
                file.write(text)
        deploy = os.path.join(self.seed, 'deploy')
        os.makedirs(deploy, exist_ok=True)
        log = f'printf "%s %s\\n" "$(basename "$0") $*" "$(git rev-parse HEAD)" >>"{self.calls}"\n'
        write_script(os.path.join(deploy, 'install.sh'), f'#!/bin/sh\n{log}touch "{self.work.name}/installed"\n')
        write_script(os.path.join(deploy, 'upgrade.sh'), f'#!/bin/sh\n{log}')
        with open(os.path.join(self.seed, 'version'), 'w') as file:
            file.write(label)
        self.git('-C', self.seed, 'add', '--all')
        self.git('-C', self.seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', label)
        self.git('-C', self.seed, 'push', '--quiet', 'origin', 'HEAD:main')
        return self.git('-C', self.seed, 'rev-parse', 'HEAD')

    def deploy(self, sha, variables=None, google_secret=None):
        env = clean_env(
            HOME=self.work.name,
            PATH=f'{self.bin}{os.pathsep}{os.environ["PATH"]}',
            REPO=self.origin,
            SHA=sha,
            DEPLOY_PATH=self.path,
            TOKEN=self.TOKEN,
            VARS=json.dumps(variables or {'POISE_DOMAIN': 'poise.example.com', 'POISE_ADMINS': 'root'}),
            POISE_GITHUB_CLIENT_SECRET='s3cret',
        )
        if google_secret is not None:
            env['POISE_GOOGLE_CLIENT_SECRET'] = google_secret
        return subprocess.run([os.path.join(ACTIONS, 'deploy.sh')], capture_output=True, text=True, env=env)

    def calls_made(self):
        if not os.path.exists(self.calls):
            return []
        with open(self.calls) as file:
            return file.read().splitlines()

    def checkout(self, *args):
        return self.git('-C', self.path, *args)

    def test_clones_and_installs_then_upgrades_in_place(self):
        first, second = self.commits
        result = self.deploy(first)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'Cloning {self.origin} into {self.path}.', result.stdout)
        self.assertIn('deploy/.env sets POISE_ADMINS POISE_DOMAIN POISE_GITHUB_CLIENT_SECRET.', result.stdout)
        self.assertEqual(self.checkout('rev-parse', 'HEAD'), first)
        self.assertEqual(self.checkout('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
        self.assertEqual(self.checkout('rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main')
        self.assertEqual(self.calls_made(), [f'install.sh  {first}'])
        env_file = os.path.join(self.path, 'deploy', '.env')
        self.assertEqual(stat.S_IMODE(os.stat(env_file).st_mode), 0o600)
        with open(env_file) as file:
            self.assertEqual(file.read(), 'POISE_ADMINS=root\nPOISE_DOMAIN=poise.example.com\nPOISE_GITHUB_CLIENT_SECRET=s3cret\n')

        result = self.deploy(second, {'POISE_DOMAIN': 'poise.example.com', 'POISE_ADMINS': 'root,alice'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('Cloning', result.stdout)
        self.assertEqual(self.checkout('rev-parse', 'HEAD'), second)
        self.assertEqual(self.calls_made(), [f'install.sh  {first}', f'upgrade.sh --no-pull {second}'])
        with open(env_file) as file:
            self.assertIn('POISE_ADMINS=root,alice\n', file.read())

    def test_google_pair_survives_rewrite_and_invalid_pair_never_reaches_server(self):
        first, second = self.commits
        variables = {'POISE_DOMAIN': 'poise.example.com', 'POISE_GOOGLE_CLIENT_ID': 'google-client'}
        result = self.deploy(first, variables, google_secret='google-test-secret')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('google-test-secret', result.stdout + result.stderr)
        env_file = os.path.join(self.path, 'deploy', '.env')
        with open(env_file) as file:
            original = file.read()
        self.assertIn('POISE_GOOGLE_CLIENT_ID=google-client\n', original)
        self.assertIn('POISE_GOOGLE_CLIENT_SECRET=google-test-secret\n', original)
        self.assertEqual(stat.S_IMODE(os.stat(env_file).st_mode), 0o600)
        with open(self.ssh_calls) as file:
            original_calls = file.read()
        for invalid, secret in [
            (variables, None),
            ({'POISE_DOMAIN': 'poise.example.com'}, 'google-test-secret'),
            ({**variables, 'POISE_GOOGLE_CLIENT_SECRET': 'variable-test-secret'}, 'google-test-secret'),
        ]:
            result = self.deploy(second, invalid, google_secret=secret)
            self.assertEqual(result.returncode, 1)
            for value in ('google-test-secret', 'variable-test-secret', 's3cret'):
                self.assertNotIn(value, result.stdout + result.stderr)
            with open(env_file) as file:
                self.assertEqual(file.read(), original)
            with open(self.ssh_calls) as file:
                self.assertEqual(file.read(), original_calls)
            self.assertEqual(self.checkout('rev-parse', 'HEAD'), first)
        result = self.deploy(second)
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(env_file) as file:
            self.assertNotIn('POISE_GOOGLE_', file.read())

    def test_keeps_the_token_and_settings_off_command_lines_and_out_of_the_checkout(self):
        result = self.deploy(self.commits[0])
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.ssh_calls) as file:
            self.assertEqual(file.read().splitlines(), ['poise-server bash -s'])
        with open(os.path.join(self.path, '.git', 'config')) as file:
            config = file.read()
        encoded = base64.b64encode(f'x-access-token:{self.TOKEN}'.encode()).decode()
        for secret in (self.TOKEN, encoded, 's3cret', 'extraheader'):
            self.assertNotIn(secret, config)
        self.assertNotIn(self.TOKEN, result.stdout + result.stderr)
        self.assertNotIn('s3cret', result.stdout + result.stderr)

    def test_finishes_a_first_deployment_that_stopped_after_the_clone(self):
        # The fetch fails after the clone, as a network failure or a cancelled run would leave it.
        missing = '0' * 40
        result = self.deploy(missing)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(os.path.isdir(os.path.join(self.path, '.git')))
        result = self.deploy(self.commits[0])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('Cloning', result.stdout)
        self.assertEqual(self.checkout('rev-parse', 'HEAD'), self.commits[0])
        self.assertEqual(self.calls_made(), [f'install.sh  {self.commits[0]}'])

    def test_refuses_a_checkout_with_changes_that_are_not_committed(self):
        first, second = self.commits
        self.assertEqual(self.deploy(first).returncode, 0)
        with open(os.path.join(self.path, 'version'), 'w') as file:
            file.write('edited on the server')
        result = self.deploy(second)
        self.assertEqual(result.returncode, 1)
        self.assertIn('has changes that are not committed', result.stderr)
        self.assertEqual(self.checkout('rev-parse', 'HEAD'), first)
        self.assertEqual(self.calls_made(), [f'install.sh  {first}'])

    def test_refuses_to_overwrite_an_untracked_file_the_commit_adds(self):
        first, second = self.commits
        self.assertEqual(self.deploy(first).returncode, 0)
        notes = os.path.join(self.path, 'docs', 'new.md')
        os.makedirs(os.path.dirname(notes), exist_ok=True)
        with open(notes, 'w') as file:
            file.write('the operator\'s notes')
        result = self.deploy(second)
        self.assertEqual(result.returncode, 1)
        self.assertIn('has files git does not track where', result.stderr)
        with open(notes) as file:
            self.assertEqual(file.read(), 'the operator\'s notes')
        self.assertEqual(self.checkout('rev-parse', 'HEAD'), first)
        self.assertEqual(self.calls_made(), [f'install.sh  {first}'])

    def test_refuses_a_directory_that_holds_something_else(self):
        os.makedirs(self.path)
        with open(os.path.join(self.path, 'notes'), 'w') as file:
            file.write('not a checkout')
        result = self.deploy(self.commits[0])
        self.assertEqual(result.returncode, 1)
        self.assertIn('holds files but no checkout', result.stderr)
        self.assertEqual(self.calls_made(), [])

    def test_refuses_a_checkout_of_another_repository(self):
        self.git('clone', '--quiet', self.origin, self.path)
        self.checkout('remote', 'set-url', 'origin', 'https://github.com/someone/else.git')
        result = self.deploy(self.commits[0])
        self.assertEqual(result.returncode, 1)
        self.assertIn('is a checkout of https://github.com/someone/else.git', result.stderr)
        self.assertEqual(self.calls_made(), [])


class GateTest(unittest.TestCase):
    """deploy/actions/gate.sh with a fake gh serving canned API answers."""

    REPO = 'fork/poise'
    TIP = 'b' * 40

    FAKE_GH = """#!/bin/sh
# Serves canned API answers from $GH_FIXTURES; $GH_FAIL names files that fail.
path="$2"
case "$path" in
  *commits/main) file=tip.json;;
  *workflows/ci.yml/runs*) file=ci-runs.json;;
  *workflows/caller.yml/runs*) file=caller-runs.json;;
  *actions/runs/*/jobs*) file=jobs.json;;
  *) echo "unexpected gh api path: $path" >&2; exit 99;;
esac
printf '%s\\n' "$path" >>"$GH_CALLS"
case " $GH_FAIL " in *" $file "*) echo "boom" >&2; exit 1;; esac
cat "$GH_FIXTURES/$file"
"""

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.bin = os.path.join(self.work.name, 'bin')
        self.fixtures = os.path.join(self.work.name, 'fixtures')
        os.mkdir(self.bin)
        os.mkdir(self.fixtures)
        self.calls = os.path.join(self.work.name, 'gh-calls.log')
        self.output = os.path.join(self.work.name, 'github-output')
        self.summary = os.path.join(self.work.name, 'github-summary')
        write_script(os.path.join(self.bin, 'gh'), self.FAKE_GH)

    def workflow_run(self, run_id, **changes):
        payload = {
            'id': run_id,
            'run_number': run_id,
            'run_attempt': 1,
            'event': 'push',
            'head_branch': 'main',
            'head_repository': {'full_name': self.REPO},
            'head_sha': self.TIP,
            'status': 'completed',
            'conclusion': 'success',
            'html_url': f'https://github.com/{self.REPO}/actions/runs/{run_id}',
            'created_at': '2026-10-25T06:00:00Z',
        }
        payload.update(changes)
        return payload

    def fixture(self, name, payload):
        with open(os.path.join(self.fixtures, name), 'w') as file:
            json.dump(payload, file)

    def green(self):
        self.fixture('tip.json', {'sha': self.TIP})
        self.fixture('ci-runs.json', {'total_count': 1, 'workflow_runs': [self.workflow_run(101)]})
        self.fixture('caller-runs.json', {'total_count': 1, 'workflow_runs': [self.workflow_run(102)]})
        self.jobs()

    def jobs(self, *failed):
        steps = [{'name': name, 'conclusion': 'failure' if name in failed else 'success'}
                 for name in ('Set up job', 'Audit dependencies', 'Complete job')]
        self.fixture('jobs.json', {'total_count': 1, 'jobs': [{'steps': steps}]})

    def gate(self, trigger='workflow_run', fail=''):
        env = clean_env(
            PATH=f'{self.bin}{os.pathsep}{os.environ["PATH"]}',
            GH_FIXTURES=self.fixtures, GH_CALLS=self.calls, GH_FAIL=fail,
            GITHUB_OUTPUT=self.output, GITHUB_STEP_SUMMARY=self.summary,
            REPO=self.REPO, TRIGGER=trigger,
        )
        result = subprocess.run([os.path.join(ACTIONS, 'gate.sh')], capture_output=True, text=True, env=env)
        outputs = {}
        if os.path.exists(self.output):
            with open(self.output) as file:
                for line in file.read().splitlines():
                    name, _, value = line.partition('=')
                    outputs[name] = value
        return result, outputs

    def summary_text(self):
        if not os.path.exists(self.summary):
            return ''
        with open(self.summary) as file:
            return file.read()

    def test_proceeds_when_both_workflows_passed_on_the_tip(self):
        self.green()
        result, outputs = self.gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {'proceed': 'true', 'sha': self.TIP})
        self.assertEqual(result.stdout.splitlines()[-1], 'proceed=true')
        self.assertIn('runs/101', result.stdout)
        self.assertIn('runs/102', result.stdout)
        self.assertIn(self.TIP, self.summary_text())

    def test_judges_the_current_tip_whatever_woke_it(self):
        self.green()
        result, _ = self.gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.calls) as file:
            calls = file.read().splitlines()
        self.assertIn(f'repos/{self.REPO}/commits/main', calls)
        for workflow in ('ci.yml', 'caller.yml'):
            self.assertIn(f'repos/{self.REPO}/actions/workflows/{workflow}/runs?head_sha={self.TIP}&per_page=30', calls)

    def test_refuses_a_failed_workflow_naming_the_run_and_step(self):
        for trigger, hint in [('workflow_run', 'their success wakes the gate again'),
                              ('workflow_dispatch', 'then dispatch again')]:
            with self.subTest(trigger=trigger):
                self.green()
                self.fixture('ci-runs.json', {'total_count': 1,
                                              'workflow_runs': [self.workflow_run(101, conclusion='failure')]})
                self.jobs('Audit dependencies')
                result, outputs = self.gate(trigger=trigger)
                self.assertEqual(result.returncode, 1)
                self.assertIn('runs/101', result.stderr)
                self.assertIn('attempt 1', result.stderr)
                self.assertIn('Audit dependencies', result.stderr)
                self.assertIn(hint, result.stderr)
                self.assertEqual(outputs, {})

    def test_refuses_when_a_workflow_never_ran(self):
        self.green()
        self.fixture('caller-runs.json', {'total_count': 0, 'workflow_runs': []})
        result, _ = self.gate()
        self.assertEqual(result.returncode, 1)
        self.assertIn('no caller.yml run', result.stderr)

    def test_skips_a_running_workflow_and_refuses_it_on_dispatch(self):
        self.green()
        self.fixture('caller-runs.json', {'total_count': 1, 'workflow_runs': [
            self.workflow_run(102, status='in_progress', conclusion=None)]})
        result, outputs = self.gate(trigger='workflow_run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs['proceed'], 'false')
        self.assertIn('still in_progress', result.stderr)
        result, _ = self.gate(trigger='workflow_dispatch')
        self.assertEqual(result.returncode, 1)
        self.assertIn('still in_progress', result.stderr)
        self.assertIn('dispatch again', result.stderr)

    def test_ignores_runs_from_other_events_repositories_and_branches(self):
        self.green()
        decoys = [
            self.workflow_run(201, event='pull_request', head_repository={'full_name': 'mallory/poise'}),
            self.workflow_run(202, event='workflow_dispatch'),
            self.workflow_run(203, head_branch='feature'),
            self.workflow_run(204, head_repository={'full_name': 'mallory/poise'}),
        ]
        self.fixture('ci-runs.json', {'total_count': len(decoys), 'workflow_runs': decoys})
        result, _ = self.gate()
        self.assertEqual(result.returncode, 1)
        self.assertIn('no ci.yml run', result.stderr)

    def test_accepts_a_green_rerun(self):
        self.green()
        self.fixture('ci-runs.json', {'total_count': 1, 'workflow_runs': [self.workflow_run(101, run_attempt=2)]})
        result, outputs = self.gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs['proceed'], 'true')
        self.assertIn('attempt 2', result.stdout)

    def test_judges_the_newest_run_not_an_older_green_one(self):
        self.green()
        self.fixture('ci-runs.json', {'total_count': 2, 'workflow_runs': [
            self.workflow_run(101, conclusion='success', created_at='2026-10-25T06:00:00Z'),
            self.workflow_run(103, conclusion='failure', created_at='2026-10-25T07:00:00Z'),
        ]})
        result, _ = self.gate()
        self.assertEqual(result.returncode, 1)
        self.assertIn('runs/103', result.stderr)

    def test_refuses_a_cancelled_conclusion(self):
        self.green()
        self.fixture('caller-runs.json', {'total_count': 1,
                                           'workflow_runs': [self.workflow_run(102, conclusion='cancelled')]})
        result, _ = self.gate()
        self.assertEqual(result.returncode, 1)
        self.assertIn('cancelled', result.stderr)

    def test_refuses_loudly_when_the_api_fails(self):
        self.green()
        for failing in ('tip.json', 'ci-runs.json', 'caller-runs.json'):
            with self.subTest(failing=failing):
                result, _ = self.gate(fail=failing)
                self.assertEqual(result.returncode, 1)
                self.assertIn('cannot read', result.stderr)
        self.fixture('ci-runs.json', {'total_count': 1,
                                      'workflow_runs': [self.workflow_run(101, conclusion='failure')]})
        result, _ = self.gate(fail='jobs.json')
        self.assertEqual(result.returncode, 1)
        self.assertIn('runs/101', result.stderr)

    def test_refuses_an_unknown_trigger(self):
        self.green()
        result, _ = self.gate(trigger='push')
        self.assertEqual(result.returncode, 1)
        self.assertIn('no deploy trigger', result.stderr)


class DeployWiringTest(unittest.TestCase):
    """deploy.yml keeps invoking the gate the way GateTest proves it."""

    def workflow(self, name):
        with open(os.path.join(ROOT, '.github', 'workflows', name)) as file:
            return file.read()

    def test_deploy_runs_on_ci_and_caller_completion_only(self):
        triggers = self.workflow('deploy.yml').split('permissions:')[0].split('\non:\n')[1]
        self.assertIn('workflow_run:', triggers)
        self.assertNotRegex(triggers, r'(?m)^  push:')
        for name in ('ci.yml', 'caller.yml'):
            match = re.search(r'^name: (.+)$', self.workflow(name), re.MULTILINE)
            self.assertTrue(match, name)
            self.assertIn(match.group(1), triggers)

    def test_gate_judges_before_any_ssh_and_pins_what_it_approved(self):
        deploy = self.workflow('deploy.yml')
        self.assertLess(deploy.index('deploy/actions/gate.sh'), deploy.index('deploy/actions/ssh-setup.sh'))
        self.assertIn('ref: ${{ github.sha }}', deploy)
        self.assertIn('ref: ${{ steps.gate.outputs.sha }}', deploy)
        self.assertIn('SHA: ${{ steps.gate.outputs.sha }}', deploy)
        self.assertEqual(deploy.count("if: steps.gate.outputs.proceed == 'true'"), 3)

    def test_every_completion_reaches_the_gate(self):
        deploy = self.workflow('deploy.yml')
        self.assertIn("if: vars.POISE_DEPLOY_HOST != ''", deploy)
        for skipped in ('workflow_run.conclusion', 'workflow_run.event',
                        'workflow_run.head_branch', 'workflow_run.head_repository',
                        'workflow_run.head_sha'):
            self.assertNotIn(skipped, deploy)

    def test_gate_may_read_workflow_runs(self):
        permissions = self.workflow('deploy.yml').split('concurrency:')[0]
        self.assertIn('actions: read', permissions)

    def test_audit_step_classifies_transport_failures(self):
        self.assertIn('run: node scripts/npm-audit.mjs', self.workflow('ci.yml'))


class LintTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('actionlint'), 'actionlint is not installed')
    def test_workflows_pass_actionlint(self):
        result = subprocess.run(['actionlint', *WORKFLOWS], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which('shellcheck'), 'shellcheck is not installed')
    def test_scripts_pass_shellcheck(self):
        scripts = [os.path.join(ACTIONS, name) for name in sorted(os.listdir(ACTIONS))]
        result = subprocess.run(['shellcheck', '-x', *scripts], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
