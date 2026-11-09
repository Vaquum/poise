"""Backup refuses live SQLite access across a workspace kernel boundary."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class BackupKernelBoundaryTest(unittest.TestCase):
    def test_refuses_foreign_kernels_before_opening_any_volume(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            deploy = root / 'deploy'
            deploy.mkdir()
            for name in ['lib.sh', 'backup.sh']:
                shutil.copy(ROOT / 'deploy' / name, deploy / name)
            (deploy / '.env').write_text('POISE_DOMAIN=poise.test\nPOISE_GITHUB_CLIENT_ID=id\nPOISE_GITHUB_CLIENT_SECRET=secret\nPOISE_ADMINS=alice\nPOISE_PROXY_LISTEN=127.0.0.1:8080\n')
            (deploy / '.env').chmod(0o600)
            binary = root / 'bin'
            binary.mkdir()
            docker = binary / 'docker'
            docker.write_text('#!' + sys.executable + '\n' + '''import os, sys
from pathlib import Path
a = sys.argv[1:]
if a[:1] == ['version']: print('24.0.0')
elif a[:2] == ['compose', 'version']: pass
elif a[:2] in [['image', 'inspect'], ['volume', 'inspect']]: pass
elif a[:2] == ['volume', 'ls']: print('poise-home-alice')
elif a[:1] == ['ps']:
 if os.environ['BACKUP_TEST_RUNTIME'] == 'inventory-error': sys.exit(1)
 print('workspace')
elif a[:1] == ['inspect']: print('/poise-ws-alice ' + os.environ['BACKUP_TEST_RUNTIME'])
elif a[:1] == ['run']:
 Path(os.environ['BACKUP_TEST_OPENED']).touch()
 sys.exit(23)
else: sys.exit(2)
''')
            docker.chmod(0o755)
            opened = root / 'opened-volume'
            for runtime in ['runsc', 'unknown', 'inventory-error', 'runc']:
                with self.subTest(runtime=runtime):
                    opened.unlink(missing_ok=True)
                    result = subprocess.run(['bash', str(deploy / 'backup.sh'), str(root / 'backups')],
                        capture_output=True, text=True, env={**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH'],
                            'BACKUP_TEST_RUNTIME': runtime, 'BACKUP_TEST_OPENED': str(opened)})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(opened.exists(), runtime == 'runc')
                    if runtime != 'runc':
                        self.assertIn('refusing', result.stderr.lower())
                        self.assertFalse((root / 'backups').exists())
