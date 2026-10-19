"""Explicit migrations, restricted SQL logins and application readiness."""
import json
import re
from common import WRITERS, run


def prepare_files(stack):
    # Only these two bind mounts become writable by the common unprivileged CRM UID.
    stack.compose('run', '--rm', '--no-deps', '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE', '--entrypoint', '/bin/sh', 'crm-web', '-c',
                  'chown -R 1654:1654 /var/lib/parasol/documents /var/lib/parasol/keyring && '
                  'chmod 700 /var/lib/parasol/documents /var/lib/parasol/keyring')


def sql_logins(stack, *, users=False):
    values = json.loads((stack.path / 'config/sql-logins.json').read_text())
    for login, role in [('parasol_web', 'crm_web'), ('parasol_worker', 'crm_worker')]:
        password = values[login]
        if not re.fullmatch(r'[A-Za-z0-9!]{32,128}', password):
            raise ValueError('Unexpected generated SQL password format')
        stack.sql(f"IF SUSER_ID(N'{login}') IS NULL CREATE LOGIN [{login}] WITH PASSWORD=N'{password}';")
        if users:
            stack.sql(f"""IF USER_ID(N'{login}') IS NULL CREATE USER [{login}] FOR LOGIN [{login}];
ALTER USER [{login}] WITH LOGIN = [{login}];
IF IS_ROLEMEMBER(N'{role}', N'{login}') <> 1 ALTER ROLE [{role}] ADD MEMBER [{login}];
""", 'Crm')


def validate_permissions(stack):
    for login, role in [('parasol_web', 'crm_web'), ('parasol_worker', 'crm_worker')]:
        stack.sql(f"""EXECUTE AS LOGIN = '{login}';
IF IS_SRVROLEMEMBER('sysadmin') <> 0 OR IS_ROLEMEMBER('db_owner') <> 0
 OR IS_ROLEMEMBER('{role}') <> 1 OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') <> 0
 THROW 51031, 'Runtime permissions failed', 1;
REVERT;""", 'Crm')
    stack.pg("""DO $$ BEGIN
IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='atlas_app' AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='atlas_app' AND rolcanlogin)
THEN RAISE EXCEPTION 'Atlas runtime permissions failed'; END IF; END $$;""")


def migrate(stack):
    if set(stack.compose('ps', '--status', 'running', '--services').decode().split()) & set(WRITERS):
        raise ValueError('Stop application services before running migrations')
    print('Starting private databases', flush=True)
    stack.compose('up', '-d', '--wait', '--wait-timeout', '300', 'sql', 'postgres')
    prepare_files(stack)
    print('Applying CRM migrations', flush=True)
    stack.compose('run', '--rm', '--no-deps', 'crm-migrate')
    print('Applying Atlas migrations and roles', flush=True)
    stack.compose('run', '--rm', '--no-deps', 'atlas-migrate')
    sql_logins(stack, users=True)
    validate_permissions(stack)


def start(stack):
    if stack.meta['kind'] == 'restore':
        raise ValueError('Restored state stays quarantined; recovery review and journal replay precede promotion')
    stack.compose('up', '-d', '--wait', '--wait-timeout', '300', 'crm-web', 'crm-worker', 'atlas', 'caddy')


def image_ids(stack):
    release = stack.meta['compose']['RELEASE']
    return {service: run(['docker', 'image', 'inspect', f'parasol-{service}:{release}', '--format', '{{.Id}}']).decode().strip()
            for service in ('crm-web', 'crm-worker', 'atlas')}
