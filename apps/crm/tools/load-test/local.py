#!/usr/bin/env python3
"""Disposable local DEV-16 environment. No existing database/container is ever adopted."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import time
import urllib.request
import ssl

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PROFILES = {
    'smoke': dict(organizations=500, contacts=5000, tickets=10000, timeEntries=10000, auditEntries=100000),
    'full': dict(organizations=5000, contacts=50000, tickets=1000000, timeEntries=1000000, auditEntries=10000000),
}
TABLES = dict(organizations='customers.Organizations', contacts='customers.Contacts',
              tickets='service.Tickets', timeEntries='time.TimeEntries', auditEntries='audit.AuditEntries')


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def validate_local_docker():
    # A shell's selected Docker context can point at a remote machine. This harness is local-only even then.
    context = os.environ.get('DOCKER_CONTEXT')
    endpoint = os.environ.get('DOCKER_HOST') if not context else None
    if not endpoint:
        command = ['docker', 'context', 'inspect'] + ([context] if context else [])
        endpoint = run(command + ['--format', '{{.Endpoints.docker.Host}}'], capture_output=True).stdout.strip()
    if not (endpoint.startswith('unix:///') or endpoint.startswith('npipe:////./pipe/') or endpoint.startswith('npipe://./pipe/')):
        raise ValueError('DEV-16 harness requires a local Docker socket; remote/HTTP/SSH contexts are refused')


def sql(state, query, database=None):
    # Password goes through process environment, not shell interpolation or command output.
    env = dict(os.environ, SQLCMDPASSWORD=state['password'])
    try:
        result = run(['docker', 'exec', '-i', '-e', 'SQLCMDPASSWORD', state['container'],
                      '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-C', '-b', '-I',
                      '-d', database or state['database'], '-h', '-1', '-w', '65535', '-y', '8000'],
                     env=env, input='SET NOCOUNT ON;\n'+query, capture_output=True)
    except subprocess.CalledProcessError as error:
        diagnostic = (error.stdout or '') + (error.stderr or '')
        for key in ['password', 'runtimePassword']:
            diagnostic = diagnostic.replace(state.get(key, '\0'), '<redacted>')
        error.add_note(diagnostic.strip())
        raise
    return result.stdout.strip()


def validate_state(state):
    if not re.fullmatch(r'[a-f0-9]{32}', state['owner']):
        raise ValueError('Invalid ownership token')
    if state['container'] != 'crm-load-dev16-'+state['owner'][:12] or state['database'] != 'crm_load_dev16_'+state['owner'][:12]:
        raise ValueError('Resource names do not belong to this state')
    validate_local_docker()
    label = run(['docker', 'inspect', '--format', '{{ index .Config.Labels "crm.dev16.owner" }}', state['container']], capture_output=True).stdout.strip()
    if label != state['owner']:
        raise ValueError('Container ownership mismatch')


def ownership(state):
    validate_state(state)
    found = sql(state, "SELECT CONVERT(nvarchar(128),value) FROM sys.extended_properties WHERE class=0 AND name='DEV16.Owner';")
    if found != state['owner']:
        raise ValueError('Database ownership mismatch; refusing mutation/cleanup')


def process_environment():
    # Never inherit host-specific connection strings, provider switches or telemetry exporters from the caller's shell.
    return {key: value for key, value in os.environ.items() if key in {
        'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
        'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SYSTEMROOT', 'WINDIR', 'TERM',
    }}


def provider_environment():
    # Keep the process's fault injection profile identical to the generated dataset manifest.
    return dict(process_environment(), SIMULATED_FAILURE_EVERY='0')


def environment(state, worker=False, admin=False):
    user = 'sa' if admin else ('crm_load_worker' if worker else 'crm_load_web')
    password = state['password'] if admin else state['runtimePassword']
    connection = f"Server=localhost,{state['sqlPort']};Database={state['database']};User Id={user};Password={password};TrustServerCertificate=True;Encrypt=True"
    dotnet = Path.home()/'.dotnet'
    return dict(process_environment(), PATH=str(dotnet)+os.pathsep+os.environ['PATH'], DOTNET_ROOT=str(dotnet),
                ASPNETCORE_ENVIRONMENT='Development', DOTNET_ENVIRONMENT='Development',
                ConnectionStrings__crm=connection, Auth__Mode='Development',
                Database__MigrateOnStartup='false', Documents__Provider='FileSystem',
                Documents__RootPath=state['documents'], RateLimits__ApiPerMinute='100000',
                DataProtection__BlobUri='', DataProtection__KeyVaultKeyUri='',
                Integrations__Brreg__BaseUrl=f"http://localhost:{state['mockPort']}/brreg/",
                Integrations__PowerOffice__Enabled='true', Integrations__PowerOffice__WriteEnabled='true',
                Integrations__PowerOffice__Environment='Demo', Deployment__Environment='test',
                Integrations__PowerOffice__BaseUrl=f"http://localhost:{state['mockPort']}/v2/",
                Integrations__PowerOffice__TokenUrl=f"http://localhost:{state['mockPort']}/OAuth/Token",
                Integrations__PowerOffice__ApplicationKey='simulated' if worker else '',
                Integrations__PowerOffice__ClientKey='simulated' if worker else '',
                Integrations__PowerOffice__SubscriptionKey='simulated' if worker else '',
                Integrations__Atera__Enabled='false', Integrations__MicrosoftGraph__Enabled='false',
                Integrations__MicrosoftGraph__MailEnabled='false', Integrations__MicrosoftGraph__CalendarEnabled='false',
                Integrations__MicrosoftGraph__Teams__Enabled='false', Integrations__MicrosoftGraph__SharePoint__Enabled='false',
                Notifications__EmailEnabled='false', Sales__EmailEnabled='false',
                APPLICATIONINSIGHTS_CONNECTION_STRING='', OTEL_EXPORTER_OTLP_ENDPOINT='',
                Integrations__PartnerCenter__Enabled='false', Logging__LogLevel__Default='Warning')


def digest_data(state):
    """Hash every seeded row (all persisted columns except volatile rowversion), in bounded batches.
    SQL canonical JSON -> SHA256 per 10k rows -> SHA256 of table names and batch hashes.
    No synthetic table can be silently omitted from verification.
    """
    hashes = {}
    for table in [*TABLES.values(), 'customers.OrganizationContacts', 'time.TimeAllocations',
                  'catalog.Products', 'contracts.Contracts', 'contracts.ContractLines', 'integration.ExternalLinks']:
        schema, name = table.split('.')
        columns = sql(state, f"SELECT STRING_AGG(CONVERT(nvarchar(max),QUOTENAME(name)),',') WITHIN GROUP (ORDER BY column_id) FROM sys.columns WHERE object_id=OBJECT_ID('{table}') AND system_type_id<>189;")
        # Authentication/workload audit entries are not seeded history. Never hash them as part of the reproducible input.
        predicate = "CorrelationId=N'DEV16-seed'" if table == 'audit.AuditEntries' else '1=1'
        id_type = 'bigint' if table == 'audit.AuditEntries' else 'uniqueidentifier'
        query = f"""
DECLARE @last {id_type}=NULL;
CREATE TABLE #DigestIds (Id {id_type} NOT NULL PRIMARY KEY);
WHILE 1=1 BEGIN
 INSERT #DigestIds SELECT TOP (10000) Id FROM [{schema}].[{name}]
 WHERE {predicate} AND (@last IS NULL OR Id>@last) ORDER BY Id OPTION (RECOMPILE);
 IF @@ROWCOUNT=0 BREAK;
 SELECT CONVERT(varchar(64),HASHBYTES('SHA2_256', (SELECT {columns} FROM [{schema}].[{name}] WHERE Id IN (SELECT Id FROM #DigestIds) ORDER BY Id FOR JSON PATH,INCLUDE_NULL_VALUES)),2);
 SELECT TOP(1) @last=Id FROM #DigestIds ORDER BY Id DESC;
 TRUNCATE TABLE #DigestIds;
END;
"""
        hashes[table] = hashlib.sha256(sql(state, query).encode()).hexdigest()
        print('Verified content:', table, flush=True)
    return hashes


def initialize(args, state_path):
    if state_path.exists():
        raise ValueError('State already exists. Use a new directory; partial seeds are never resumed silently.')
    validate_local_docker()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    owner = secrets.token_hex(16)
    state = dict(owner=owner, container='crm-load-dev16-'+owner[:12], database='crm_load_dev16_'+owner[:12],
                 password='DEV16-'+secrets.token_hex(18)+'aA1!', runtimePassword='DEV16-'+secrets.token_hex(18)+'aA1!',
                 profile=args.profile, sqlPort=args.sql_port, webPort=args.web_port, workerPort=args.worker_port,
                 mockPort=args.mock_port, documents=str(state_path.parent/'documents'))
    fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(state, f, indent=2)
    env = dict(os.environ, MSSQL_SA_PASSWORD=state['password'])
    run(['docker', 'run', '-d', '--name', state['container'], '--label', 'crm.dev16.owner='+owner,
         '-e', 'ACCEPT_EULA=Y', '-e', 'MSSQL_SA_PASSWORD', '-e', 'MSSQL_MEMORY_LIMIT_MB=2048',
         '-p', f"127.0.0.1:{args.sql_port}:1433", 'mcr.microsoft.com/mssql/server:2022-latest'], env=env, capture_output=True)
    for attempt in range(60):
        try:
            sql(state, 'SELECT 1;', 'master')
            break
        except subprocess.CalledProcessError:
            if attempt == 59:
                raise
            time.sleep(2)
    sql(state, f"CREATE DATABASE [{state['database']}];", 'master')
    sql(state, f"EXEC sp_addextendedproperty @name=N'DEV16.Owner', @value=N'{owner}'; ALTER DATABASE [{state['database']}] SET RECOVERY SIMPLE;")
    print('Created owned database; applying current migrations.', flush=True)
    with open(state_path.parent/'migration.log', 'w') as log:
        run(['dotnet', str(ROOT/'src/Hosts/Crm.Web/bin/Release/net10.0/Crm.Web.dll'), '--migrate-only'],
            cwd=ROOT/'src/Hosts/Crm.Web', env=environment(state, admin=True), stdout=log, stderr=subprocess.STDOUT)
    ownership(state)
    counts = PROFILES[args.profile]
    source = (HERE/'seed.sql').read_text()
    query = source
    for key, value in dict(Organizations=counts['organizations'], Contacts=counts['contacts'], Tickets=counts['tickets'],
                           TimeEntries=counts['timeEntries'], Audit=counts['auditEntries'], Owner=owner).items():
        query = query.replace('$('+key+')', str(value))
    started = time.monotonic()
    print('Seeding '+args.profile+' profile.', flush=True)
    sql(state, query)
    actual = {key: int(sql(state, 'SELECT COUNT_BIG(*) FROM '+table+';')) for key, table in TABLES.items()}
    if actual != counts:
        raise ValueError(f'Seed count mismatch: {actual}')
    hashes = digest_data(state)
    checksum = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    # Dedicated runtime users have the same role grants as production; no sa app host.
    for login, role in [('crm_load_web', 'crm_web'), ('crm_load_worker', 'crm_worker')]:
        sql(state, f"CREATE LOGIN [{login}] WITH PASSWORD=N'{state['runtimePassword']}',CHECK_POLICY=OFF; CREATE USER [{login}] FOR LOGIN [{login}]; ALTER ROLE [{role}] ADD MEMBER [{login}];")
    organizations = [dict(id=f'16160001-0000-0000-0000-{i:012}', name=f'Synthetic DEV16 Organization {i:05}', searchTerm=f'Organization {i:05}') for i in range(1, counts['organizations'] + 1)]
    dataset_id = 'dev16-'+owner
    manifest = dict(schemaVersion=1, profile=args.profile, seed=1616, datasetId=dataset_id,
                    datasetChecksum='sha256:'+checksum, tableContentHashes=hashes,
                    generatorChecksum='sha256:'+hashlib.sha256(source.encode()).hexdigest(),
                    baseUrl=f'https://localhost:{args.web_port}', database=dict(name=state['database'], syntheticMarker='DEV16:'+dataset_id),
                    counts=counts, seedSeconds=round(time.monotonic()-started,3), history=dict(fromDate='2021-10-05',toDate='2026-10-04',readPeriod=dict(year=2026,month=9)),
                    auth=dict(mode='Development',environment='Development',users=[dict(role='Crm.'+role,weight=1,loginPath='/bff/dev-login?role=Crm.'+role+'&returnUrl=/') for role in ['Sales','Technician','ServiceLead','Finance','Management']]),
                    organizations=organizations, billing=dict(year=2026,month=9,customerIds=[x['id'] for x in organizations[:500]]),
                    provider=dict(mode='simulated',baseUrl=f'http://localhost:{args.mock_port}',latencyMs=150, jitterMs=100, failureEvery=0,requestsPerSecond=10))
    (state_path.parent/'dataset.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print('Seed verified. Manifest: '+str(state_path.parent/'dataset.json'), flush=True)


def serve(state, directory):
    ownership(state)
    children = []
    logs = []
    def stop(*_):
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
        for log in logs:
            log.close()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        commands = [('provider', ['node', str(HERE/'provider.mjs'), str(state['mockPort'])], provider_environment(), ROOT),
                    ('web', ['dotnet', str(ROOT/'src/Hosts/Crm.Web/bin/Release/net10.0/Crm.Web.dll'), '--urls', f"https://localhost:{state['webPort']}"], environment(state), ROOT/'src/Hosts/Crm.Web'),
                    ('worker', ['dotnet', str(ROOT/'src/Hosts/Crm.Worker/bin/Release/net10.0/Crm.Worker.dll'), '--urls', f"http://localhost:{state['workerPort']}"], environment(state, worker=True), ROOT/'src/Hosts/Crm.Worker')]
        for name, command, env, cwd in commands:
            log = open(directory/(name+'.log'), 'w'); logs.append(log)
            children.append(subprocess.Popen(command, env=env, cwd=cwd, stdout=log, stderr=subprocess.STDOUT))
        print('Local hosts started. Stop with Ctrl-C; database retained until destroy.', flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(1)
        raise RuntimeError('A local host exited. Inspect its log.')
    except KeyboardInterrupt:
        pass
    finally:
        stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['init','serve','verify','destroy'])
    parser.add_argument('--directory', type=Path, required=True, help='Private untracked output directory, e.g. /tmp/dev16-smoke')
    parser.add_argument('--profile', choices=PROFILES, default='smoke')
    parser.add_argument('--sql-port', type=int, default=14346)
    parser.add_argument('--web-port', type=int, default=5182)
    parser.add_argument('--worker-port', type=int, default=5192)
    parser.add_argument('--mock-port', type=int, default=5300)
    args = parser.parse_args()
    path = args.directory.resolve()/'state.private.json'
    if args.command == 'init':
        initialize(args, path)
        return
    state = json.loads(path.read_text())
    ownership(state)
    if args.command == 'serve':
        serve(state, path.parent)
    elif args.command == 'verify':
        expected = json.loads((path.parent/'dataset.json').read_text())
        actual = digest_data(state)
        if actual != expected['tableContentHashes']:
            raise ValueError('Dataset changed (expected after workload writes). Reseed a new environment for identical inputs.')
        print('All dataset content hashes match.')
    elif args.command == 'destroy':
        run(['docker','rm','-f',state['container']], capture_output=True)
        path.unlink()
        print('Owned synthetic SQL container removed; reports and documents retained.')


if __name__ == '__main__':
    main()
