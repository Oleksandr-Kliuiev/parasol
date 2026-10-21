import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from common import private_path, run
from configure import initialize
from snapshot import backup, inventory, verify
from recovery import restore
from monitoring import status, retention


class FakeStack:
    def __init__(self, path, fail_stop=False):
        self.path = path
        self.project = 'parasol-synthetic'
        self.calls = []
        self.fail_stop = fail_stop

    def compose(self, *args):
        self.calls.append(args)
        if args[:3] == ('ps', '--status', 'running'):
            return b'crm-web\ncrm-worker\n' if len(self.calls) == 1 else b''
        if args[0] == 'stop' and self.fail_stop:
            raise RuntimeError('synthetic partial stop failure')
        return b''


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='parasol-ops-test-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_no_reinitialization_or_credential_overwrite(self):
        (self.root / 'sentinel').write_text('keep')
        with self.assertRaises(ValueError):
            initialize(self.root, rehearsal=True)
        self.assertEqual((self.root / 'sentinel').read_text(), 'keep')

    def test_new_installation_holds_only_crm_and_sql_server_secrets(self):
        # The temporary directory may sit below a symlinked /var (macOS); private state refuses symlinked parents.
        state = self.root.resolve() / 'state'
        initialize(state, rehearsal=True, release='synthetic')
        config = state / 'config'
        self.assertEqual(sorted(path.name for path in config.iterdir()), ['dp.pfx', 'migrate.json', 'oidc.pfx',
                         'sql-logins.json', 'sql-sa-password', 'web.json', 'worker.json'])
        self.assertEqual(config.stat().st_mode & 0o777, 0o700)
        for name in ('web', 'worker', 'migrate'):
            settings = json.loads((config / f'{name}.json').read_text())
            self.assertNotIn('Parasol', settings)
            self.assertIn('Server=sql,1433;Database=Crm;', settings['ConnectionStrings']['Crm'])
        worker = json.loads((config / 'worker.json').read_text())
        self.assertFalse({'DataProtection', 'AzureAd', 'Auth', 'Forwarded'} & set(worker))

    def test_failed_command_withholds_output_but_keeps_a_tail_for_the_drill(self):
        with self.assertRaises(RuntimeError) as caught:
            run([sys.executable, '-c', 'import sys; sys.stderr.write("synthetic-secret"); sys.exit(3)', '/private/path', 'word'])
        self.assertNotIn('synthetic-secret', str(caught.exception))
        self.assertIn('output withheld', str(caught.exception))
        self.assertEqual(caught.exception.stderr, b'synthetic-secret')
        self.assertEqual(caught.exception.command, 'word')

    def test_state_rejects_relative_symlink_and_repository_paths(self):
        with self.assertRaises(ValueError): private_path('relative')
        (self.root / 'alias').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): private_path(self.root / 'alias' / 'state')
        with self.assertRaises(ValueError): private_path(Path(__file__).resolve().parents[1] / 'state')

    def test_inventory_detects_content_corruption_and_extra_files(self):
        (self.root / 'document').write_bytes(b'immutable PDF bytes')
        manifest = {'format': 1, 'files': inventory(self.root)}
        (self.root / 'manifest.json').write_text(json.dumps(manifest))
        (self.root / 'document').write_bytes(b'changed PDF bytes')
        with self.assertRaisesRegex(ValueError, 'inventory'): verify(self.root)
        (self.root / 'document').write_bytes(b'immutable PDF bytes')
        (self.root / 'extra').write_bytes(b'not captured')
        with self.assertRaisesRegex(ValueError, 'inventory'): verify(self.root)

    def test_consistently_hashed_but_incomplete_backup_is_rejected(self):
        (self.root / 'manifest.json').write_text(json.dumps({'format': 1, 'files': {}}))
        with self.assertRaisesRegex(ValueError, 'incomplete'): verify(self.root)

    def complete_snapshot(self):
        names = ['crm.bak', 'config/web.json', 'config/worker.json', 'config/migrate.json', 'config/dp.pfx',
                 'config/oidc.pfx', 'config/sql-logins.json', 'config/sql-sa-password',
                 'data/documents/.parasol-volume', 'stack.json', 'data/keyring/key-synthetic.xml']
        for name in names:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic')
        (self.root / 'stack.json').write_text(json.dumps({'volumeId': 'synthetic'}))
        (self.root / 'config/web.json').write_text(json.dumps({'Documents': {'VolumeId': 'synthetic'}}))
        (self.root / 'manifest.json').write_text(json.dumps({'format': 1, 'files': inventory(self.root)}))

    def test_complete_snapshot_checks_volume_identity_as_well_as_hashes(self):
        self.complete_snapshot()
        self.assertEqual(verify(self.root)['format'], 1)
        (self.root / 'data/documents/.parasol-volume').write_text('wrong-volume')
        (self.root / 'manifest.json').write_text(json.dumps({'format': 1, 'files': inventory(self.root)}))
        with self.assertRaisesRegex(ValueError, 'volume identity'): verify(self.root)

    def test_missing_session_keyring_is_not_a_complete_backup(self):
        self.complete_snapshot()
        (self.root / 'data/keyring/key-synthetic.xml').unlink()
        (self.root / 'manifest.json').write_text(json.dumps({'format': 1, 'files': inventory(self.root)}))
        with self.assertRaisesRegex(ValueError, 'incomplete'): verify(self.root)

    def test_inventory_rejects_link_escape(self):
        (self.root / 'link').symlink_to('/etc/hosts')
        with self.assertRaisesRegex(ValueError, 'symlinks'): inventory(self.root)

    def test_capture_failure_resumes_only_original_writers_and_cleans_plaintext(self):
        stack = FakeStack(self.root)
        with patch('snapshot.capture', side_effect=RuntimeError('synthetic dump failure')):
            with self.assertRaises(RuntimeError): backup(stack)
        self.assertIn(('up', '-d', '--no-recreate', '--no-deps', '--wait', '--wait-timeout', '300', 'crm-web', 'crm-worker'), stack.calls)
        self.assertFalse(list(self.root.glob('.snapshot-*')))
        self.assertEqual(json.loads((self.root / 'backup-status.json').read_text())['status'], 'failed')

    def test_partial_stop_failure_also_attempts_to_resume(self):
        stack = FakeStack(self.root, fail_stop=True)
        with self.assertRaises(RuntimeError): backup(stack)
        self.assertTrue(any(call[:2] == ('up', '-d') for call in stack.calls))
        self.assertFalse(list(self.root.glob('.snapshot-*')))

    def test_backup_monitor_rejects_stale_or_failed_runs(self):
        stack = FakeStack(self.root)
        now = datetime.now(timezone.utc)
        for name in ('backup', 'check'):
            (self.root / f'{name}-status.json').write_text(json.dumps({'status': 'ok', 'finishedAt': now.isoformat()}))
        self.assertEqual(status(stack)['status'], 'ok')
        (self.root / 'backup-status.json').write_text(json.dumps({'status': 'ok', 'finishedAt': (now - timedelta(hours=37)).isoformat()}))
        with self.assertRaisesRegex(RuntimeError, 'stale'): status(stack)
        (self.root / 'backup-status.json').write_text(json.dumps({'status': 'failed'}))
        with self.assertRaisesRegex(RuntimeError, 'not successful'): status(stack)

    def test_retention_does_not_delete_without_recent_check_and_restore(self):
        stack = FakeStack(self.root)
        now = datetime.now(timezone.utc).isoformat()
        for name in ('backup', 'check'):
            (self.root / f'{name}-status.json').write_text(json.dumps({'status': 'ok', 'finishedAt': now}))
        with self.assertRaisesRegex(ValueError, 'restore drill'): retention(stack, apply=True)
        stack.restic = lambda *args: args
        args = retention(stack)
        self.assertIn('--dry-run', args)
        self.assertNotIn('--prune', args)
        self.assertEqual(args[args.index('--host') + 1], stack.project)

    def test_restore_refuses_existing_target_or_ambiguous_snapshot_before_any_docker_call(self):
        stack = FakeStack(self.root)
        with self.assertRaises(ValueError): restore(stack, 'latest', self.root / 'new')
        with self.assertRaises(ValueError): restore(stack, 'abcdef12', self.root)
        with self.assertRaises(ValueError): restore(stack, 'abcdef12', self.root / 'nested')
        self.assertEqual(stack.calls, [])


if __name__ == '__main__':
    unittest.main()
