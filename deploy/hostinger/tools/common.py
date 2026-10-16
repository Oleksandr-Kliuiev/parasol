"""Private state, Docker orchestration and exclusive operations. Never echo command output."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import secrets

BUNDLE = Path(__file__).resolve().parents[1]
RESTIC = 'restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'
WRITERS = ('caddy', 'atlas', 'crm-worker', 'crm-web')


def run(args, *, data=None, cwd=None, env=None, input_file=None, output_file=None):
    result = subprocess.run([str(a) for a in args], input=data, stdin=input_file, stdout=output_file or subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=cwd, env=env)
    if result.returncode:
        # Drivers/Compose errors may include secrets. Do not print args, stdout or stderr.
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode}); output withheld')
    return result.stdout or b''


def write_json(path, value, mode=0o600):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(mode)


def private_path(value):
    path = Path(value)
    if not path.is_absolute() or any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('State path must not contain symlinks')
    path = path.resolve()
    if BUNDLE.parents[1] == path or BUNDLE.parents[1] in path.parents:
        raise ValueError('Private state must live outside the Git checkout')
    if any(c in str(path) for c in '\n\r,:$'):
        raise ValueError('Unsupported character in state path')
    return path


class Stack:
    def __init__(self, path):
        self.path = private_path(path)
        self.meta = json.loads((self.path / 'stack.json').read_text())
        self.project = self.meta['project']
        if not re.fullmatch(r'parasol-[a-z0-9-]{4,40}', self.project):
            raise ValueError('Invalid isolated project name')
        self.env = os.environ.copy()
        # No ambient Compose variables can silently redirect this stack.
        self.env.update({k: str(v) for k, v in self.meta['compose'].items()})
        self.env['STATE_DIR'] = str(self.path)
        self.env['COMPOSE_PROFILES'] = ''

    def compose(self, *args, data=None, input_file=None, output_file=None):
        return run(['docker', 'compose', '--env-file', '/dev/null', '-p', self.project,
                    '-f', BUNDLE / 'compose.yaml', *args], data=data, env=self.env, input_file=input_file, output_file=output_file)

    def cid(self, service):
        value = self.compose('ps', '-a', '-q', service).decode().strip()
        if not re.fullmatch(r'[a-f0-9]{12,64}', value):
            raise RuntimeError(f'{service} container unavailable')
        return value

    def sql(self, query, database='master'):
        return self.compose('exec', '-T', 'sql', 'sh', '-c',
            'export SQLCMDPASSWORD="$(cat /run/secrets/sql-sa-password)"; '
            'exec /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -b -r 1 -h -1 -W -d "$1"',
            'sql', database, data=query.encode())

    def pg(self, query):
        return self.compose('exec', '-T', 'postgres', 'psql', '-X', '-U', 'postgres', '-d', 'atlas',
                            '-v', 'ON_ERROR_STOP=1', '-tA', data=query.encode())

    @contextlib.contextmanager
    def lock(self):
        with (self.path / '.operation.lock').open('a') as handle:
            os.chmod(handle.name, 0o600)
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def restic(self, *args, staging=None, target=None):
        backup = self.path / 'backup'
        repo = (backup / 'repository').read_text().strip()
        mounts = ['-v', f'{backup}:/run/backup:ro']
        if self.meta['kind'] == 'rehearsal':
            if repo != '/repository':
                raise ValueError('Rehearsal uses only its local restic repository')
            mounts += ['-v', f'{self.path / "repository"}:/repository']
        elif not repo.startswith('sftp:') or 'REPLACE' in repo:
            raise ValueError('Production backup requires a configured off-VPS SFTP repository')
        elif 'REPLACE' in (backup / 'ssh_config').read_text():
            raise ValueError('Configure the backup SSH endpoint before using restic')
        ssh = [] if self.meta['kind'] == 'rehearsal' else ['-o', 'sftp.args=-F /run/backup/ssh_config']
        with self.restic_volume(staging, target) as volume:
            if volume:
                mounts += ['-v', f'{volume}:/snapshot:ro' if staging else f'{volume}:/restore']
            return run(['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}',
                        '--cap-drop=ALL', '--security-opt=no-new-privileges',
                        '--read-only', '--tmpfs', '/tmp', *mounts,
                        '-e', 'RESTIC_REPOSITORY_FILE=/run/backup/repository',
                        '-e', 'RESTIC_PASSWORD_FILE=/run/backup/password', RESTIC, '--no-cache', *ssh, *args])

    @contextlib.contextmanager
    def restic_volume(self, staging, target):
        """Use a native Linux scratch volume for portable file metadata and restic I/O.

        No Docker socket reaches this container. The host owns orchestration and cleanup.
        Docker Desktop shared folders do not implement all Linux read flags used by restic.
        """
        if not staging and not target:
            yield None
            return
        if staging and target:
            raise ValueError('A restic operation cannot capture and restore simultaneously')
        volume = f'{self.project}-restic-{secrets.token_hex(6)}'
        run(['docker', 'volume', 'create', '--label', f'com.parasol.scratch={self.project}', volume])
        helper = None
        try:
            helper = run(['docker', 'create', '--network', 'none', '--read-only',
                          '--label', f'com.parasol.scratch={self.project}',
                          '--mount', f'type=volume,source={volume},target=/transfer',
                          '--entrypoint', '/bin/true', RESTIC]).decode().strip()
            if staging:
                run(['docker', 'cp', str(staging) + '/.', f'{helper}:/transfer'])
            # docker cp can preserve host numeric owners. Normalize only this disposable volume.
            run(['docker', 'run', '--rm', '--network', 'none', '--cap-drop=ALL', '--cap-add=CHOWN',
                 '--cap-add=DAC_OVERRIDE', '--read-only', '-v', f'{volume}:/transfer',
                 '--entrypoint', '/bin/sh', RESTIC, '-c', f'chown -R {os.getuid()}:{os.getgid()} /transfer'])
            yield volume
            if target:
                run(['docker', 'cp', f'{helper}:/transfer/.', str(target)])
        finally:
            try:
                if helper: run(['docker', 'rm', helper])
            finally:
                run(['docker', 'volume', 'rm', volume])
