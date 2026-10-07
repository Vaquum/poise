import subprocess
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface.atoms import review_diff as rd
from github_interface.behaviors import pr_review


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd).decode().strip()


class TestReviewDiff(IsolatedAsyncioTestCase):
    async def test_complete_pinned_diff_excludes_data_before_diff_and_keeps_contracts(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            git(root, "init", "--quiet")
            git(root, "config", "user.name", "Test")
            git(root, "config", "user.email", "test@example.com")
            (source / 'old.py').write_text('print("before")\n')
            git(root, "add", ".")
            git(root, "commit", "--quiet", "-m", "base")
            base = git(root, "rev-parse", "HEAD")
            (source / 'old.py').rename(source / 'renamed.py')
            (source / 'new.py').write_text('print("é")\n')
            (source / 'new.py').chmod(0o755)
            (source / 'data.json').write_text('x' * 2_000_000)
            (source / 'package.json').write_text('x' * 40_000)
            (source / 'fixtures').mkdir()
            (source / 'fixtures' / 'small.json').write_text('{"ok": true}\n')
            (source / '[literal].py').write_text('pass\n')
            git(root, "add", ".")
            git(root, "commit", "--quiet", "-m", "head")
            head = git(root, "rev-parse", "HEAD")
            # A later base-branch change must not enter this PR's diff.
            git(root, "checkout", "--quiet", "--detach", base)
            (source / 'base-only.py').write_text('pass\n')
            git(root, "add", ".")
            git(root, "commit", "--quiet", "-m", "new base")
            new_base = git(root, "rev-parse", "HEAD")
            calls = []
            original = rd._git

            def local_git(cwd, env, *args, limit):
                calls.append(args)
                if args[:2] == ('remote', 'add'):
                    args = (*args[:-1], source.as_uri())
                return original(cwd, env, *args, limit=limit)

            async def sizes(client, owner, repo, files):
                return {f[key]: int(git(root, 'cat-file', '-s', f[key]))
                        for f in files for key in ('old_oid', 'new_oid') if f[key] != '0' * 40}

            client = AsyncMock()
            client.token = 'not-a-token'
            client.get.return_value = {'merge_base_commit': {'sha': base}}
            with patch.object(rd, '_git', side_effect=local_git), patch.object(rd, '_blob_sizes', side_effect=sizes):
                packet = await rd.review_diff(client, 'o', 'r', {'head': {'sha': head}, 'base': {'sha': new_base}})

            self.assertEqual(packet['merge_base_sha'], base)
            self.assertEqual([f['path'] for f in packet['excluded_files']], ['data.json'])
            self.assertIn('rename from old.py', packet['diff'])
            self.assertIn('rename to renamed.py', packet['diff'])
            self.assertIn('new file mode 100755', packet['diff'])
            self.assertIn('+print("é")', packet['diff'])
            for retained in ('package.json', 'fixtures/small.json', '[literal].py'):
                self.assertIn(retained, packet['diff'])
            self.assertNotIn('base-only.py', packet['diff'])
            diff_call = next(args for args in calls if '--find-renames' in args)
            self.assertNotIn(':(literal)data.json', diff_call)
            self.assertIn(':(literal)[literal].py', diff_call)
            client.get.assert_awaited_once_with(f'/repos/o/r/compare/{new_base}...{head}', params={'page': 2, 'per_page': 1})

    async def test_packet_rejects_head_or_base_change_after_read(self):
        head = 'a' * 40
        base = 'b' * 40
        for changed in ('head', 'base'):
            initial = {'head': {'sha': head}, 'base': {'sha': base}}
            latest = {**initial, changed: {'sha': 'c' * 40}}
            with self.subTest(changed=changed), patch.object(pr_review, 'get_pull', AsyncMock(side_effect=[initial, latest])), \
                    patch.object(pr_review, 'review_diff', AsyncMock(return_value={})), \
                    patch.object(pr_review, 'list_inline_comments', AsyncMock(return_value=[])), \
                    patch.object(pr_review, 'list_review_threads', AsyncMock(return_value=[])), \
                    patch.object(pr_review, 'linked_issues', AsyncMock(return_value=[])):
                with self.assertRaisesRegex(RuntimeError, 'head or base changed'):
                    await pr_review.run(AsyncMock(), {'repository': 'o/r', 'pr': 1, 'expected_head': head})


class TestPacketPolicy(TestCase):
    def test_git_deadline_reports_a_timeout_instead_of_a_kill_exit(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(TimeoutError, "timed out"):
                rd._git(root, rd._env("test-token"), "-c", "alias.stall=!sleep 1", "stall", timeout=0.02)

    def test_compaction_preserves_source_configuration_and_small_fixtures(self):
        def reason(path, size, compact=True):
            return rd._excluded({'filename': path, 'old_mode': '000000', 'new_mode': '100644',
                                 'old_oid': '0' * 40, 'new_oid': 'a' * 40}, {'a' * 40: size}, compact)
        for path in ('a.py', 'docs/design.md', 'package.json', 'tsconfig.build.json', 'api.schema.json', 'manifest.json', 'config/routes.json', 'index.html'):
            self.assertIsNone(reason(path, 100_000), path)
        self.assertIsNone(reason('tests/fixtures/example.json', 500))
        self.assertIsNone(reason('data.json', 500, compact=False))
        self.assertIsNone(reason('data.json', 80_000, compact=None))
        self.assertIsNotNone(reason('data.json', 500))
        self.assertIsNotNone(reason('data.csv', 100_000))
        self.assertIsNotNone(reason('captures/run/raw/markets.md', 100_000))
        self.assertIsNone(reason('captures/run/raw/check.py', 100_000))
        self.assertIsNotNone(reason('captures/run/raw/page.html', 100_000))

    def test_output_limit_rejects_complete_result_without_truncation(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(rd.ReviewPacketTooLarge):
                rd._git(root, rd._env('test-token'), '--version', limit=1)

class TestPacketBudget(IsolatedAsyncioTestCase):
    async def test_review_context_triggers_compaction_before_final_prompt_limit(self):
        base, head = 'a' * 40, 'b' * 40
        code, data = 'c' * 40, 'd' * 40
        raw = (f':000000 100644 {"0" * 40} {code} A\0code.py\0'
               f':000000 100644 {"0" * 40} {data} A\0data.csv\0').encode()
        diff_calls = []

        def git_result(cwd, env, *args, limit):
            if '--raw' in args:
                return raw
            if '--find-renames' in args:
                diff_calls.append(args)
                return b'x' * (8_000 if ':(literal)data.csv' in args else 1_000)
            return b''

        client = AsyncMock()
        client.token = 'test-token'
        client.get.return_value = {'merge_base_commit': {'sha': base}}
        with patch.object(rd, '_git', side_effect=git_result), \
                patch.object(rd, '_blob_sizes', AsyncMock(return_value={code: 1000, data: 7000})), \
                patch.object(rd, 'MAX_PACKET_BYTES', 6000):
            packet = await rd.review_diff(client, 'o', 'r', {'base': {'sha': base}, 'head': {'sha': head}}, {'body': 'x' * 3000})
        self.assertEqual(packet['excluded_files'][0]['path'], 'data.csv')
        self.assertNotIn(':(literal)data.csv', diff_calls[-1])
        self.assertEqual(len(packet['diff']), 1000)
