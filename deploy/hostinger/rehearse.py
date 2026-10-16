#!/usr/bin/env python3
"""Destructive only to newly created synthetic stacks; local restore drill for CI/operators."""
import argparse
import json
from pathlib import Path
import secrets
import socket
import sys
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parent / 'tools'))
from common import Stack, private_path, write_json
from configure import initialize
from lifecycle import migrate, start
from recovery import restore
from snapshot import backup, inventory


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def drill(root, release, build, keep):
    root = private_path(root)
    if root.exists():
        raise ValueError('Rehearsal directory must be new')
    root.mkdir(parents=True, mode=0o700)
    source_path, target_path = root / 'source', root / 'restored'
    initialize(source_path, rehearsal=True, release=release)
    meta = json.loads((source_path / 'stack.json').read_text())
    meta['compose']['HTTP_PORT'] = str(free_port())
    meta['compose']['HTTPS_PORT'] = str(free_port())
    write_json(source_path / 'stack.json', meta)
    source = Stack(source_path)
    try:
        if build:
            print('Building Linux application images', flush=True)
            source.compose('build', 'crm-web', 'crm-worker', 'atlas', 'atlas-migrate')
        print('Migrating empty SQL Server/PostgreSQL databases', flush=True)
        migrate(source)
        start(source)
        # The edge only exposes the web host, never internal health or Atlas.
        for route in ['/health/ready', '/bff/user']:
            try:
                urllib.request.urlopen(f'http://localhost:{meta["compose"]["HTTP_PORT"]}{route}', timeout=10)
            except urllib.error.HTTPError as error:
                if error.code not in (401, 404, 503): raise
            else:
                raise RuntimeError('Private route unexpectedly exposed by the edge')
        marker = secrets.token_hex(16)
        source.sql(f"CREATE TABLE dbo.ParasolRecoveryProbe (Id int PRIMARY KEY, Value varchar(64) NOT NULL); INSERT dbo.ParasolRecoveryProbe VALUES (1, '{marker}');", 'Crm')
        source.pg(f"CREATE TABLE public.parasol_recovery_probe (id int PRIMARY KEY, value text NOT NULL); INSERT INTO public.parasol_recovery_probe VALUES (1, '{marker}');")
        documents = source_path / 'data/documents'
        (documents / 'rehearsal').mkdir(mode=0o700)
        pdf = documents / 'rehearsal/immutable.pdf'
        pdf.write_bytes(b'%PDF-1.4\n% Parasol synthetic recovery document\n' + marker.encode())
        pdf.chmod(0o600)
        before_documents = inventory(documents)
        before_keys = inventory(source_path / 'data/keyring')
        if not before_keys:
            raise RuntimeError('No actual DataProtection key was generated')
        print('Backing up a running stack with restic', flush=True)
        source.restic('init')
        with source.lock(): result = backup(source)
        source.restic('check', '--read-data')
        # Simulate later data/loss in the synthetic source; the restored copy must recover the earlier point.
        source.sql("UPDATE dbo.ParasolRecoveryProbe SET Value='after-backup';", 'Crm')
        source.pg("UPDATE public.parasol_recovery_probe SET value='after-backup';")
        pdf.unlink()
        source.compose('stop')  # Simulate unavailable source; recovery cannot borrow either live database.
        print('Restoring both databases, documents and keyring into a new isolated stack', flush=True)
        with source.lock(): recovered = restore(source, result['snapshot'], target_path)
        target = Stack(target_path)
        if marker not in target.sql('SET NOCOUNT ON; SELECT Value FROM dbo.ParasolRecoveryProbe;', 'Crm').decode():
            raise RuntimeError('SQL point-in-time marker mismatch')
        if target.pg('SELECT value FROM public.parasol_recovery_probe;').decode().strip() != marker:
            raise RuntimeError('PostgreSQL point-in-time marker mismatch')
        if before_documents != inventory(target_path / 'data/documents'):
            raise RuntimeError('Restored document inventory changed')
        if before_keys != inventory(target_path / 'data/keyring'):
            raise RuntimeError('Restored keyring changed')
        # A damaged encrypted pack must fail verification. Restore the synthetic bytes afterwards.
        packs = list((source_path / 'repository/data').glob('*/*'))
        if not packs: raise RuntimeError('Restic wrote no encrypted data packs')
        pack = packs[0]
        original = pack.read_bytes()
        try:
            damaged = bytearray(original); damaged[len(damaged) // 2] ^= 1; pack.write_bytes(damaged)
            try: source.restic('check', '--read-data')
            except RuntimeError: pass
            else: raise RuntimeError('Damaged restic data pack was accepted')
        finally:
            pack.write_bytes(original)
        source.restic('check', '--read-data')
        report = {'status': 'passed', 'syntheticOnly': True, 'snapshot': result['snapshot'],
                  'backupSeconds': result['elapsedSeconds'], 'restoreSeconds': recovered['elapsedSeconds'],
                  'checks': recovered['checks'] + ['SQL and PostgreSQL before/after markers',
                      'exact document and keyring inventory', 'corrupt encrypted pack rejected', 'edge isolation'],
                  'promoted': False}
        write_json(root / 'report.json', report)
        print(json.dumps(report, indent=2))
    finally:
        if not keep:
            # Only project names created by this drill, never user-owned containers or global prune.
            for path in (target_path, source_path):
                if (path / 'stack.json').exists():
                    Stack(path).compose('down', '--volumes', '--remove-orphans')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--release', default='rehearsal')
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--keep', action='store_true', help='keep only this drill\'s containers for private diagnosis')
    args = parser.parse_args()
    try: drill(args.directory, args.release, not args.skip_build, args.keep)
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        raise SystemExit(1)
