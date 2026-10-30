import json
import subprocess
import tempfile
from contextlib import ExitStack
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
            (source / 'data.json').write_text('x' * 4_000_000)
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

    async def test_retains_source_diff_above_the_old_packet_limit(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            git(root, 'init', '--quiet')
            git(root, 'config', 'user.name', 'Test')
            git(root, 'config', 'user.email', 'test@example.com')
            git(root, 'commit', '--quiet', '--allow-empty', '-m', 'base')
            base = git(root, 'rev-parse', 'HEAD')
            content = 'value = 1\n' * 120_000
            for name in ('a.py', 'b.py'):
                (source / name).write_text(content)
            git(root, 'add', '.')
            git(root, 'commit', '--quiet', '-m', 'head')
            head = git(root, 'rev-parse', 'HEAD')
            original = rd._git

            def local_git(cwd, env, *args, limit):
                if args[:2] == ('remote', 'add'):
                    args = (*args[:-1], source.as_uri())
                return original(cwd, env, *args, limit=limit)

            async def sizes(client, owner, repo, files):
                return {file['new_oid']: len(content.encode()) for file in files}

            client = AsyncMock()
            client.token = 'not-a-token'
            client.get.return_value = {'merge_base_commit': {'sha': base}}
            with patch.object(rd, '_git', side_effect=local_git), patch.object(rd, '_blob_sizes', side_effect=sizes):
                packet = await rd.review_diff(client, 'o', 'r', {'head': {'sha': head}, 'base': {'sha': base}})

            self.assertEqual([entry['filename'] for entry in packet['files']], ['a.py', 'b.py'])
            self.assertNotIn('omitted_files', packet)
            self.assertEqual(packet['diff'].count('+value = 1\n'), 240_000)
            self.assertGreater(len(packet['diff'].encode()), 1_500_000)
            self.assertLess(len(json.dumps(packet, indent=2).encode()), 2_950_000)

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

    async def test_large_artifact_excluded_even_when_total_input_fits(self):
        # A packet that fits locally can still carry an artifact diff entry
        # GitHub rejects inline comments on (422 "diff is too large"). Bulk
        # data is excluded upfront so the model never targets it.
        base, head = 'a' * 40, 'b' * 40
        code, data = 'c' * 40, 'd' * 40
        raw = (f':000000 100644 {"0" * 40} {code} A\0code.py\0'
               f':000000 100644 {"0" * 40} {data} A\0input-artefacts/RUN-abc.json\0').encode()
        diff_calls = []

        def git_result(cwd, env, *args, limit):
            if '--raw' in args:
                return raw
            if '--find-renames' in args:
                diff_calls.append(args)
                self.assertNotIn(':(literal)input-artefacts/RUN-abc.json', args)
                return b'diff --git a/code.py b/code.py\n+pass\n'
            return b''

        client = AsyncMock()
        client.token = 'test-token'
        client.get.return_value = {'merge_base_commit': {'sha': base}}
        # Total input (~100KB) fits well under the 1.35MB diff budget.
        with patch.object(rd, '_git', side_effect=git_result), \
                patch.object(rd, '_blob_sizes', AsyncMock(return_value={code: 100, data: 100_000})):
            packet = await rd.review_diff(client, 'o', 'r', {'base': {'sha': base}, 'head': {'sha': head}})
        self.assertEqual([f['path'] for f in packet['excluded_files']], ['input-artefacts/RUN-abc.json'])
        self.assertEqual([f['filename'] for f in packet['files']], ['code.py'])
        self.assertIn('code.py', packet['diff'])
        self.assertNotIn('omitted_files', packet)


class TestBoundedCoverage(IsolatedAsyncioTestCase):
    async def _packet(self, names, per_file, diff_limit, packet_limit=None, context=None):
        base, head = 'a' * 40, 'b' * 40
        oids = {name: f'{index + 1:040d}' for index, name in enumerate(names)}
        raw = b''.join(
            f':000000 100644 {"0" * 40} {oids[name]} A\0{name}\0'.encode()
            for name in names
        )

        def git_result(cwd, env, *args, limit):
            if '--raw' in args:
                return raw
            if '--find-renames' in args:
                out = b'x' * sum(1 for arg in args if arg.startswith(':(literal)')) * per_file
                if len(out) > limit:
                    raise rd.ReviewPacketTooLarge(f'{rd.PACKET_LIMIT_CODE}: retained review diff exceeds {limit} bytes')
                return out
            return b''

        client = AsyncMock()
        client.token = 'test-token'
        client.get.return_value = {'merge_base_commit': {'sha': base}}
        with ExitStack() as stack:
            stack.enter_context(patch.object(rd, '_git', side_effect=git_result))
            stack.enter_context(patch.object(
                rd, '_blob_sizes', AsyncMock(return_value={oid: 100 for oid in oids.values()})))
            stack.enter_context(patch.object(rd, 'MAX_DIFF_BYTES', diff_limit))
            if packet_limit is not None:
                stack.enter_context(patch.object(rd, 'MAX_PACKET_BYTES', packet_limit))
            return await rd.review_diff(client, 'o', 'r', {'base': {'sha': base}, 'head': {'sha': head}}, context)

    async def test_oversized_diff_yields_bounded_packet_with_explicit_omitted_files(self):
        packet = await self._packet(['a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'data.csv'], 1000, 2500)
        self.assertEqual(len(packet['diff']), 2000)
        self.assertEqual([entry['filename'] for entry in packet['files']],
                         ['a.py', 'b.py'])
        self.assertEqual(packet['files'][0],
                         {'filename': 'a.py', 'status': 'added', 'old_mode': '000000', 'new_mode': '100644'})
        self.assertEqual([entry['path'] for entry in packet['omitted_files']],
                         ['c.py', 'd.py', 'e.py'])
        for entry in packet['omitted_files']:
            self.assertIn('not reviewed', entry['reason'])
        self.assertEqual([entry['path'] for entry in packet['excluded_files']], ['data.csv'])
        self.assertEqual(packet['merge_base_sha'], 'a' * 40)
        self.assertIn('partial', packet['review_scope'])
        self.assertIn('3 of 5', packet['review_scope'])
        self.assertIn('omitted_files', packet['review_scope'])
        self.assertLessEqual(len(json.dumps(packet).encode('utf-8')), rd.MAX_PACKET_BYTES)

    async def test_bounded_coverage_is_deterministic(self):
        first = await self._packet(['a.py', 'b.py', 'c.py', 'd.py', 'e.py'], 1000, 2500)
        second = await self._packet(['a.py', 'b.py', 'c.py', 'd.py', 'e.py'], 1000, 2500)
        self.assertEqual(first, second)

    async def test_packet_budget_shrinks_coverage_before_the_prompt_limit(self):
        packet = await self._packet(['a.py', 'b.py', 'c.py'], 2000, 100_000,
                                    packet_limit=7500, context={'body': 'x' * 4000})
        self.assertEqual(len(packet['diff']), 2000)
        self.assertEqual([entry['filename'] for entry in packet['files']], ['a.py'])
        self.assertEqual([entry['path'] for entry in packet['omitted_files']], ['b.py', 'c.py'])

    async def test_single_file_over_budget_stays_an_explicit_typed_failure(self):
        with self.assertRaisesRegex(rd.ReviewPacketTooLarge, 'review_packet_too_large'):
            await self._packet(['big.py'], 5000, 2500)

    async def test_small_diff_carries_no_omitted_coverage_key(self):
        packet = await self._packet(['a.py', 'b.py'], 1000, rd.MAX_DIFF_BYTES)
        self.assertEqual(len(packet['diff']), 2000)
        self.assertNotIn('omitted_files', packet)


class TestSinceHeadDiff(IsolatedAsyncioTestCase):
    async def _packet(self, since=None, fetch_error=None, bases=None, compare_error=None):
        base, head, old = 'a' * 40, 'b' * 40, 'c' * 40
        raw = f':100644 100644 {old} {head} M\0code.py\0'.encode()
        calls = []

        def git_result(cwd, env, *args, limit):
            calls.append(args)
            if args[:1] == ('fetch',) and fetch_error is not None:
                raise fetch_error
            if '--raw' in args:
                return raw
            if '--find-renames' in args:
                return b'diff --git a/code.py b/code.py\n'
            return b''

        client = AsyncMock()
        client.token = 'test-token'
        if compare_error is not None:
            client.get.side_effect = compare_error
        elif bases is not None:
            client.get.side_effect = [{'merge_base_commit': {'sha': sha}} for sha in bases]
        else:
            client.get.return_value = {'merge_base_commit': {'sha': base}}
        with patch.object(rd, '_git', side_effect=git_result), \
                patch.object(rd, '_blob_sizes', AsyncMock(return_value={old: 100, head: 100})):
            packet = await rd.review_diff(client, 'o', 'r', {'base': {'sha': base}, 'head': {'sha': head}},
                                          since=since)
        return packet, calls, client

    async def test_stable_base_diffs_since_to_head(self):
        since = 'c' * 40
        packet, calls, client = await self._packet(since=since, bases=['a' * 40, 'a' * 40])
        self.assertEqual(client.get.await_count, 2)
        fetch = next(args for args in calls if args[:1] == ('fetch',))
        self.assertEqual(fetch[-2:], (since, 'b' * 40))
        raw = next(args for args in calls if '--raw' in args)
        self.assertEqual(raw[5:7], (since, 'b' * 40))
        self.assertEqual(packet['merge_base_sha'], since)
        self.assertEqual(packet['since_head_sha'], since)
        self.assertEqual([entry['filename'] for entry in packet['files']], ['code.py'])
        self.assertIn('Follow-up review', packet['review_scope'])
        self.assertIn('RIGHT-side', packet['review_scope'])

    async def test_moved_base_widens_to_the_full_pr_diff(self):
        old_base, new_base = 'd' * 40, 'e' * 40
        packet, calls, client = await self._packet(since='c' * 40, bases=[old_base, new_base])
        self.assertEqual(client.get.await_count, 2)
        fetch = next(args for args in calls if args[:1] == ('fetch',))
        self.assertEqual(fetch[-2:], (new_base, 'b' * 40))
        raw = next(args for args in calls if '--raw' in args)
        self.assertEqual(raw[5:7], (new_base, 'b' * 40))
        self.assertEqual(packet['merge_base_sha'], new_base)
        self.assertIsNone(packet['since_head_sha'])
        self.assertIn('not limited to changes since the last review', packet['review_scope'])
        self.assertNotIn('Follow-up review', packet['review_scope'])

    async def test_gc_since_head_compare_is_an_unknown_since_head(self):
        with self.assertRaisesRegex(RuntimeError, 'review_since_head_unknown'):
            await self._packet(since='c' * 40, compare_error=RuntimeError('GitHub 404: Not Found'))

    async def test_full_packet_marks_no_since_head(self):
        packet, _, _ = await self._packet()
        self.assertIsNone(packet['since_head_sha'])

    async def test_unfetchable_since_head_is_a_distinct_error(self):
        from github_interface.atoms.process_diagnostic import GitProcessError
        fetch_error = GitProcessError({"operation": "fetch", "outcome": "exit", "stderr": "missing object",
                                       "exit_code": 128, "signal": None, "errno": None})
        with self.assertRaisesRegex(RuntimeError, 'review_since_head_unknown'):
            await self._packet(since='c' * 40, fetch_error=fetch_error)

    async def test_pr_review_behavior_passes_since_head_to_the_diff(self):
        from unittest.mock import ANY
        head, base, since = 'a' * 40, 'b' * 40, 'c' * 40
        pull = {'head': {'sha': head}, 'base': {'sha': base}}
        client = AsyncMock()
        with patch.object(pr_review, 'get_pull', AsyncMock(side_effect=[pull, pull])), \
                patch.object(pr_review, 'review_diff', AsyncMock(return_value={})) as diff, \
                patch.object(pr_review, 'list_inline_comments', AsyncMock(return_value=[])), \
                patch.object(pr_review, 'issue_comments', AsyncMock(return_value=[])), \
                patch.object(pr_review, 'list_review_threads', AsyncMock(return_value=[])), \
                patch.object(pr_review, 'linked_issues', AsyncMock(return_value=[])):
            await pr_review.run(client, {'repository': 'o/r', 'pr': 1, 'expected_head': head,
                                         'since_head': since})
        diff.assert_awaited_once_with(client, 'o', 'r', pull, ANY, since=since)

    async def test_pr_review_behavior_rejects_a_malformed_since_head(self):
        with self.assertRaisesRegex(ValueError, 'since-head'):
            await pr_review.run(AsyncMock(), {'repository': 'o/r', 'pr': 1, 'expected_head': 'a' * 40,
                                              'since_head': 'zzz'})
