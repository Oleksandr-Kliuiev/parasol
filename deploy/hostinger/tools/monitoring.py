"""Local checks suitable for an Atera script monitor; no notification service credentials."""
from datetime import datetime, timezone
import json
from common import write_json


def full_check(stack):
    # Write failure first so a killed/failed check cannot leave an old green status.
    write_json(stack.path / 'check-status.json', {'status': 'running'})
    try:
        stack.restic('check', '--read-data')
    except Exception:
        write_json(stack.path / 'check-status.json', {'status': 'failed'})
        raise
    write_json(stack.path / 'check-status.json', {'status': 'ok', 'finishedAt': datetime.now(timezone.utc).isoformat()})


def status(stack):
    for name, hours in [('backup', 36), ('check', 8 * 24)]:
        path = stack.path / f'{name}-status.json'
        if not path.exists():
            raise RuntimeError(f'{name}: never completed')
        record = json.loads(path.read_text())
        if record.get('status') != 'ok':
            raise RuntimeError(f'{name}: latest run was not successful')
        age = datetime.now(timezone.utc) - datetime.fromisoformat(record['finishedAt'])
        if age.total_seconds() > hours * 3600 or age.total_seconds() < 0:
            raise RuntimeError(f'{name}: stale timestamp')
    return {'status': 'ok', 'backupMaxAgeHours': 36, 'fullCheckMaxAgeHours': 8 * 24}


def retention(stack, apply=False):
    if apply:
        status(stack)
        proof = stack.path / 'restore-proof.json'
        if not proof.exists():
            raise ValueError('Retention requires a successful restore drill first')
        age = datetime.now(timezone.utc) - datetime.fromisoformat(json.loads(proof.read_text())['verifiedAt'])
        if age.total_seconds() > 31 * 86400 or age.total_seconds() < 0:
            raise ValueError('Restore proof must be less than 31 days old')
    return stack.restic('forget', '--host', stack.project, '--tag', 'parasol-v1',
                        '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '6',
                        '--group-by', 'host,paths,tags', *(['--prune'] if apply else ['--dry-run']), '--json')
