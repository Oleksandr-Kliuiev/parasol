"""Create a new private installation. Existing state/credentials are never overwritten."""
import json
from pathlib import Path
import re
import secrets
import shutil
import uuid
from common import private_path, run, write_json


def certificate(config, password):
    (config / 'certificate-password').write_text(password)
    (config / 'certificate-password').chmod(0o600)
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650',
         '-subj', '/CN=Parasol Data Protection', '-keyout', config / 'temp.key', '-out', config / 'temp.crt'])
    run(['openssl', 'pkcs12', '-export', '-inkey', config / 'temp.key', '-in', config / 'temp.crt',
         '-out', config / 'dp.pfx', '-passout', f'file:{config / "certificate-password"}'])
    for name in ('temp.key', 'temp.crt', 'certificate-password'):
        (config / name).unlink()


def initialize(path, *, rehearsal=False, domain=None, tenant=None, client=None, oidc=None, password_file=None, release='local'):
    path = private_path(path)
    if path.exists():
        raise ValueError('Destination must not exist; existing state is never initialized again')
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', release):
        raise ValueError('Invalid release tag')
    if not rehearsal:
        if not domain or not re.fullmatch(r'[a-z0-9]+(?:[-.][a-z0-9]+)*\.[a-z]{2,63}', domain):
            raise ValueError('A public DNS hostname is required')
        uuid.UUID(tenant); uuid.UUID(client)
        if not oidc or not password_file:
            raise ValueError('OIDC certificate and password file are required')
    path.mkdir(parents=True, mode=0o700)
    path.chmod(0o700)
    for name in ('config', 'data/documents', 'data/keyring', 'data/caddy', 'data/caddy-config', 'backup', 'repository'):
        (path / name).mkdir(parents=True, mode=0o700)
    config = path / 'config'
    secret = lambda: secrets.token_hex(24)
    sa, web, worker, dp = [secret() for _ in range(4)]
    # SQL policy requires mixed character classes.
    sa = 'S1!' + sa; web = 'W1!' + web; worker = 'R1!' + worker
    certificate(config, dp)
    if rehearsal:
        domain = 'localhost'
        tenant, client = str(uuid.uuid4()), str(uuid.uuid4())
        shutil.copyfile(config / 'dp.pfx', config / 'oidc.pfx')
        oidc_password = dp
    else:
        shutil.copyfile(oidc, config / 'oidc.pfx')
        oidc_password = Path(password_file).read_text().strip()
    volume = str(uuid.uuid4())
    (path / 'data/documents/.parasol-volume').write_text(volume + '\n')
    application = {
        'AllowedHosts': f'{domain};127.0.0.1;localhost',
        'Auth': {'Mode': 'Entra'},
        'AzureAd': {'TenantId': tenant, 'ClientId': client, 'ClientCertificates': [
            {'SourceType': 'Path', 'CertificateDiskPath': '/run/secrets/oidc.pfx', 'CertificatePassword': oidc_password}]},
        'Documents': {'Provider': 'FileSystem', 'RootPath': '/var/lib/parasol/documents', 'VolumeId': volume},
        'DataProtection': {'KeyRingPath': '/var/lib/parasol/keyring', 'CertificatePath': '/run/secrets/dp.pfx', 'CertificatePassword': dp},
        'Hangfire': {'DashboardEnabled': False, 'PrepareSchema': False},
    }
    octet = secrets.randbelow(200) + 20
    application['Forwarded'] = {'KnownProxies': [f'172.30.{octet}.254']}
    for name, login, pwd in [('web', 'parasol_web', web), ('worker', 'parasol_worker', worker), ('migrate', 'sa', sa)]:
        cfg = json.loads(json.dumps(application))
        cfg['ConnectionStrings'] = {'Crm': f'Server=sql,1433;Database=Crm;User ID={login};Password={pwd};Encrypt=True;TrustServerCertificate=True'}
        if name == 'worker':
            for key in ('DataProtection', 'AzureAd', 'Auth', 'Forwarded'):
                cfg.pop(key, None)
        write_json(config / f'{name}.json', cfg, 0o444)
    # Fixed login names, only generated passwords enter SQL text through stdin.
    write_json(config / 'sql-logins.json', {'parasol_web': web, 'parasol_worker': worker})
    (config / 'sql-sa-password').write_text(sa); (config / 'sql-sa-password').chmod(0o444)
    for name in ('dp.pfx', 'oidc.pfx'):
        (config / name).chmod(0o444)
    (path / 'backup/password').write_text(secret())
    (path / 'backup/password').chmod(0o600)
    (path / 'backup/repository').write_text('/repository' if rehearsal else 'sftp:backup-host:/REPLACE/parasol')
    (path / 'backup/ssh_config').write_text(
        'Host backup-host\n  HostName REPLACE\n  User REPLACE\n  IdentityFile /run/backup/id_ed25519\n'
        '  UserKnownHostsFile /run/backup/known_hosts\n  StrictHostKeyChecking yes\n  BatchMode yes\n  ConnectTimeout 20\n  ServerAliveInterval 30\n  ServerAliveCountMax 3\n')
    write_json(path / 'stack.json', {
        'format': 1, 'kind': 'rehearsal' if rehearsal else 'production', 'project': f'parasol-{secrets.token_hex(5)}',
        'volumeId': volume, 'compose': {'RELEASE': release, 'SITE_ADDRESS': 'http://localhost' if rehearsal else domain,
            'TLS_EMAIL': 'operator@example.invalid', 'BIND_ADDRESS': '127.0.0.1' if rehearsal else '0.0.0.0',
            'HTTP_PORT': '18088' if rehearsal else '80', 'HTTPS_PORT': '18488' if rehearsal else '443',
            'PROXY_SUBNET': f'172.30.{octet}.0/24', 'PROXY_IP': f'172.30.{octet}.254',
            'READ_ONLY': 'true', 'ISOLATED': 'true' if rehearsal else 'false', 'MSSQL_PID': 'Express'}})
