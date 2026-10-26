"""Consistent native database dumps plus documents/keyring, encrypted in restic."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time
from datetime import datetime, timezone
from common import WRITERS, run, write_json
from lifecycle import image_ids


# Starts the stopped writers again and waits until they are healthy. `compose start --wait` exists only in newer Compose
# releases (Ubuntu's runner refuses the flag); `up --no-recreate --no-deps` starts the same containers without rebuilding
# them or touching the databases.
RESUME = ('up', '-d', '--no-recreate', '--no-deps', '--wait', '--wait-timeout', '300')


def inventory(root):
    files = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Snapshot cannot contain symlinks')
        if path.is_file():
            if path.name == 'manifest.json' and path.parent == root:
                continue
            with path.open('rb') as handle:
                digest = hashlib.file_digest(handle, 'sha256').hexdigest()
            files[path.relative_to(root).as_posix()] = {'sha256': digest, 'bytes': path.stat().st_size}
        elif not path.is_dir():
            raise ValueError('Snapshot cannot contain special files')
    return files


def verify(root):
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest.get('format') != 1 or manifest.get('files') != inventory(root):
        raise ValueError('Snapshot inventory does not match; restore refused')
    required = {'crm.bak', 'atlas.dump', 'roles.sql', 'config/web.json', 'config/worker.json',
                'config/migrate.json', 'config/dp.pfx', 'config/oidc.pfx', 'config/sql-logins.json',
                'config/sql-sa-password', 'config/pg-password', 'config/atlas-admin.json',
                'config/atlas-runtime.json', 'data/documents/.parasol-volume', 'stack.json'}
    if not required.issubset(manifest['files']) or not any(
            name.startswith('data/keyring/key-') and name.endswith('.xml') for name in manifest['files']):
        raise ValueError('Snapshot is incomplete')
    meta = json.loads((root / 'stack.json').read_text())
    web = json.loads((root / 'config/web.json').read_text())
    volume = (root / 'data/documents/.parasol-volume').read_text().strip()
    if volume != meta['volumeId'] or volume != web['Documents']['VolumeId']:
        raise ValueError('Document volume identity mismatch')
    return manifest


def capture(stack, staging):
    stack.compose('exec', '-T', 'sql', 'mkdir', '-p', '/var/opt/mssql/backup')
    stack.sql("BACKUP DATABASE [Crm] TO DISK=N'/var/opt/mssql/backup/parasol.bak' WITH COPY_ONLY, INIT, CHECKSUM;")
    stack.sql("RESTORE VERIFYONLY FROM DISK=N'/var/opt/mssql/backup/parasol.bak' WITH CHECKSUM;")
    run(['docker', 'cp', f'{stack.cid("sql")}:/var/opt/mssql/backup/parasol.bak', staging / 'crm.bak'])
    # COPY_ONLY avoids disturbing other backup chains. No compression: Express supports this path.
    with (staging / 'atlas.dump').open('wb') as dump:
        stack.compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', 'atlas', '--format=custom', output_file=dump)
    roles = stack.compose('exec', '-T', 'postgres', 'pg_dumpall', '-U', 'postgres', '--globals-only')
    (staging / 'roles.sql').write_bytes(roles)
    for name in ('config', 'data'):
        # Check links before copying: shutil would otherwise dereference them.
        inventory(stack.path / name)
        shutil.copytree(stack.path / name, staging / name)
    shutil.copy2(stack.path / 'stack.json', staging / 'stack.json')
    write_json(staging / 'manifest.json', {'format': 1, 'project': stack.project,
        'capturedAt': datetime.now(timezone.utc).isoformat(), 'images': image_ids(stack), 'files': inventory(staging)})
    verify(staging)


def backup(stack):
    started = time.monotonic()
    write_json(stack.path / 'backup-status.json', {'status': 'running', 'startedAt': datetime.now(timezone.utc).isoformat()})
    running = set(stack.compose('ps', '--status', 'running', '--services').decode().split())
    active = [name for name in WRITERS if name in running]
    quiesced = False
    staging = Path(tempfile.mkdtemp(prefix='.snapshot-', dir=stack.path))
    staging.chmod(0o700)
    try:
        quiesced = True
        if active:
            stack.compose('stop', *active)
        # Verify nobody restarted during quiescence (all deployment tools share the operation lock).
        if set(stack.compose('ps', '--status', 'running', '--services').decode().split()) & set(WRITERS):
            raise RuntimeError('A writer is still running')
        capture(stack, staging)
        # Resume service before uploading the already-consistent private staging directory.
        if active:
            stack.compose(*RESUME, *reversed(active))
        quiesced = False
        output = stack.restic('backup', '/snapshot', '--host', stack.project, '--tag', 'parasol-v1', '--json', staging=staging)
        summaries = [json.loads(line) for line in output.decode().splitlines() if line.startswith('{')]
        summary = next((x for x in summaries if x.get('message_type') == 'summary'), {})
        snapshot_id = summary.get('snapshot_id')
        if not snapshot_id:
            raise RuntimeError('restic did not confirm a snapshot')
        stack.restic('check')
        result = {'status': 'ok', 'snapshot': snapshot_id, 'finishedAt': datetime.now(timezone.utc).isoformat(),
                  'elapsedSeconds': round(time.monotonic() - started, 2)}
        write_json(stack.path / 'backup-status.json', result)
        return result
    except Exception:
        write_json(stack.path / 'backup-status.json', {'status': 'failed', 'finishedAt': datetime.now(timezone.utc).isoformat()})
        raise
    finally:
        # Remove native SQL staging even on failure; the persistent SQL volume is not a backup destination.
        try:
            stack.compose('exec', '-T', 'sql', 'rm', '-f', '/var/opt/mssql/backup/parasol.bak')
        finally:
            shutil.rmtree(staging)
            if quiesced and active:
                stack.compose(*RESUME, *reversed(active))
