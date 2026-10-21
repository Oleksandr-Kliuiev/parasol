"""Restore only into new, network-isolated state; never overwrite or promote a live stack."""
import json
import re
import secrets
import shutil
import time
from datetime import datetime, timezone
from common import Stack, private_path, run, write_json
from lifecycle import image_ids, prepare_files, sql_logins, validate_permissions
from snapshot import verify


def restore(source, snapshot_id, destination):
    if not re.fullmatch(r'[a-f0-9]{8,64}', snapshot_id):
        raise ValueError('Select an explicit restic snapshot ID')
    destination = private_path(destination)
    if destination.exists() or source.path == destination or source.path in destination.parents:
        raise ValueError('Restore requires a new directory outside the source installation')
    destination.mkdir(parents=True, mode=0o700)
    destination.chmod(0o700)
    started = time.monotonic()
    incoming = destination / 'incoming'
    incoming.mkdir(mode=0o700)
    source.restic('restore', snapshot_id, '--target', '/restore', '--verify', target=incoming)
    root = incoming / 'snapshot'
    manifest = verify(root)
    if manifest['project'] != source.project:
        raise ValueError('Snapshot belongs to a different installation')
    meta = json.loads((root / 'stack.json').read_text())
    meta['kind'] = 'restore'
    meta['project'] = f'parasol-restore-{secrets.token_hex(4)}'
    # Existing published ports are never inherited. No Caddy or worker is started by restore.
    octet = (int(source.meta['compose']['PROXY_IP'].split('.')[2]) + 1) % 200 + 20
    meta['compose'].update(ISOLATED='true', READ_ONLY='true', BIND_ADDRESS='127.0.0.1',
                           PROXY_SUBNET=f'172.30.{octet}.0/24', PROXY_IP=f'172.30.{octet}.254')
    write_json(destination / 'stack.json', meta)
    for name in ('config', 'data'):
        shutil.copytree(root / name, destination / name)
    target = Stack(destination)
    if manifest['images'] != image_ids(target):
        raise ValueError('Restore requires the exact application images recorded by this snapshot')
    target.compose('up', '-d', '--wait', '--wait-timeout', '300', 'sql')
    target.compose('exec', '-T', 'sql', 'mkdir', '-p', '/var/opt/mssql/backup')
    run(['docker', 'cp', root / 'crm.bak', f'{target.cid("sql")}:/var/opt/mssql/backup/parasol.bak'])
    target.compose('exec', '-T', '--user', '0', 'sql', 'chown', '10001:0', '/var/opt/mssql/backup/parasol.bak')
    target.sql("RESTORE VERIFYONLY FROM DISK=N'/var/opt/mssql/backup/parasol.bak' WITH CHECKSUM;")
    # No REPLACE: a pre-existing CRM database makes the restore fail rather than overwriting it.
    target.sql("""IF DB_ID('Crm') IS NOT NULL THROW 51032, 'Restore database already exists', 1;
RESTORE DATABASE [Crm] FROM DISK=N'/var/opt/mssql/backup/parasol.bak' WITH CHECKSUM,
 MOVE N'Crm' TO N'/var/opt/mssql/data/Crm.mdf', MOVE N'Crm_log' TO N'/var/opt/mssql/data/Crm_log.ldf';
DBCC CHECKDB ([Crm]) WITH NO_INFOMSGS;""")
    sql_logins(target, users=True)
    validate_permissions(target)
    prepare_files(target)
    target.compose('up', '-d', '--wait', '--wait-timeout', '300', 'crm-web')
    target.compose('exec', '-T', 'sql', 'rm', '-f', '/var/opt/mssql/backup/parasol.bak')
    shutil.rmtree(incoming)
    result = {'status': 'quarantined', 'snapshot': snapshot_id,
              'elapsedSeconds': round(time.monotonic() - started, 2), 'documentFiles': len([
                  name for name in manifest['files'] if name.startswith('data/documents/')]),
              'checks': ['restic restore --verify', 'file inventory SHA-256', 'SQL VERIFYONLY/CHECKDB',
                         'restricted runtime roles', 'web readiness'],
              'promotionBlocked': True}
    write_json(destination / 'restore-status.json', result)
    write_json(source.path / 'restore-proof.json', {**result, 'verifiedAt': datetime.now(timezone.utc).isoformat()})
    return result
