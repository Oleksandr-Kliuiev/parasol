#!/usr/bin/env python3
"""Host operator entry point. Python stdlib + Docker Compose v2 + OpenSSL; no pip packages."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent / 'tools'))
from common import Stack
from configure import initialize
from lifecycle import migrate, start
from recovery import restore
from snapshot import backup
from monitoring import full_check, status, retention


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, help='absolute private directory outside the Git checkout')
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init')
    init.add_argument('--rehearsal', action='store_true')
    for key in ('domain', 'tenant', 'client', 'oidc', 'password-file', 'edge-network', 'edge-subnet'):
        init.add_argument('--' + key)
    init.add_argument('--release', required=True)
    for name in ('build', 'migrate', 'up', 'backup-init', 'backup', 'check', 'status', 'snapshots', 'stop'):
        commands.add_parser(name)
    keep = commands.add_parser('retention')
    keep.add_argument('--apply', action='store_true', help='delete old snapshots only after a recent verified restore')
    rec = commands.add_parser('restore')
    rec.add_argument('--snapshot', required=True)
    rec.add_argument('--destination', required=True)
    args = parser.parse_args()
    if args.command == 'init':
        initialize(args.state, rehearsal=args.rehearsal, domain=args.domain, tenant=args.tenant,
                   client=args.client, oidc=args.oidc, password_file=args.password_file, release=args.release,
                   edge_network=args.edge_network, edge_subnet=args.edge_subnet)
        print('Private configuration created; maintenance remains on.')
        return
    stack = Stack(args.state)
    with stack.lock():
        if args.command == 'build': stack.compose('build', 'crm-web', 'crm-worker')
        elif args.command == 'migrate':
            if stack.meta['kind'] == 'restore': raise ValueError('Do not migrate a quarantined recovery')
            migrate(stack)
        elif args.command == 'up': start(stack)
        elif args.command == 'backup-init': stack.restic('init')
        elif args.command == 'backup': print(json.dumps(backup(stack)))
        elif args.command == 'check': full_check(stack)
        elif args.command == 'status': print(json.dumps(status(stack)))
        elif args.command == 'retention':
            output = retention(stack, args.apply)
            if args.apply:
                print('Retention applied')
            else:
                groups = json.loads(output)
                print(json.dumps([{key: [snapshot['id'] for snapshot in group.get(key, [])]
                                   for key in ('keep', 'remove')} for group in groups]))
        elif args.command == 'snapshots':
            data = json.loads(stack.restic('snapshots', '--host', stack.project, '--json'))
            print(json.dumps([{'id': x['id'], 'time': x['time']} for x in data]))
        elif args.command == 'restore': print(json.dumps(restore(stack, args.snapshot, args.destination)))
        elif args.command == 'stop': stack.compose('stop')
    print(f'{args.command}: completed')


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # Exceptions from a tool must not reveal its captured private output.
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        raise SystemExit(1)
