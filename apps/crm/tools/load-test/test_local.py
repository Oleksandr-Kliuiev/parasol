"""Safety regression tests for the owned, local-only DEV-16 harness; no Docker or network calls."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('dev16_local', Path(__file__).with_name('local.py'))
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


def state():
    owner = 'a1' * 16
    return dict(owner=owner, container='crm-load-dev16-'+owner[:12], database='crm_load_dev16_'+owner[:12],
                password='private-admin-password', runtimePassword='private-runtime-password',
                sqlPort=14346, webPort=5182, workerPort=5192, mockPort=5300, documents='/tmp/dev16-test-documents')


class OwnedLocalHarnessTests(unittest.TestCase):
    def test_existing_state_is_never_adopted_or_seeded_again(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'state.private.json'
            path.write_text('{}')
            with patch.object(local, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'State already exists'):
                    local.initialize(None, path)
                run.assert_not_called()

    def test_names_and_owner_tokens_are_validated_before_docker_access(self):
        for changed in [dict(owner='wrong'), dict(container='existing-production'), dict(database='existing-production')]:
            with self.subTest(changed=changed), patch.object(local, 'run') as run:
                with self.assertRaises(ValueError):
                    local.validate_state(dict(state(), **changed))
                run.assert_not_called()

    def test_container_label_mismatch_prevents_database_access(self):
        with (patch.object(local, 'validate_local_docker'),
              patch.object(local, 'run', return_value=subprocess.CompletedProcess([], 0, 'another-owner'))):
            with patch.object(local, 'sql') as sql:
                with self.assertRaisesRegex(ValueError, 'Container ownership mismatch'):
                    local.ownership(state())
                sql.assert_not_called()

    def test_database_marker_mismatch_prevents_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'state.private.json').write_text(json.dumps(state()))
            with (patch.object(sys, 'argv', ['local.py', 'destroy', '--directory', directory]),
                  patch.object(local, 'validate_local_docker')):
                with patch.object(local, 'run', return_value=subprocess.CompletedProcess([], 0, state()['owner'])) as run:
                    with patch.object(local, 'sql', return_value='another-owner'):
                        with self.assertRaisesRegex(ValueError, 'Database ownership mismatch'):
                            local.main()
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(run.call_args.args[0][0:2], ['docker', 'inspect'])

    def test_remote_docker_host_or_context_is_refused_before_container_mutation(self):
        with patch.dict(os.environ, {'DOCKER_HOST': 'ssh://remote.example.invalid', 'DOCKER_CONTEXT': ''}):
            with patch.object(local, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'local Docker socket'):
                    local.validate_local_docker()
                run.assert_not_called()
        with patch.dict(os.environ, {'DOCKER_HOST': '', 'DOCKER_CONTEXT': 'remote'}):
            with patch.object(local, 'run', return_value=subprocess.CompletedProcess([], 0, 'tcp://remote.example.invalid:2376')) as run:
                with self.assertRaisesRegex(ValueError, 'local Docker socket'):
                    local.validate_local_docker()
                self.assertEqual(run.call_args.args[0][0:3], ['docker', 'context', 'inspect'])

    def test_inherited_production_settings_do_not_reach_local_hosts(self):
        poison = {'ConnectionStrings__crm': 'Server=production', 'ASPNETCORE_URLS': 'https://production',
                  'Integrations__Atera__Enabled': 'true', 'AZURE_CLIENT_SECRET': 'private-secret',
                  'OTEL_EXPORTER_OTLP_ENDPOINT': 'https://remote-collector', 'Notifications__EmailEnabled': 'true'}
        with patch.dict(os.environ, poison):
            web = local.environment(state())
            worker = local.environment(state(), worker=True)
        for env in [web, worker]:
            self.assertIn('Server=localhost,14346;', env['ConnectionStrings__crm'])
            self.assertNotIn('production', env['ConnectionStrings__crm'])
            self.assertEqual(env['ASPNETCORE_ENVIRONMENT'], 'Development')
            self.assertNotIn('ASPNETCORE_URLS', env)
            self.assertNotIn('AZURE_CLIENT_SECRET', env)
            self.assertEqual(env['Integrations__PowerOffice__BaseUrl'], 'http://localhost:5300/v2/')
            self.assertEqual(env['Integrations__PowerOffice__TokenUrl'], 'http://localhost:5300/OAuth/Token')
            self.assertEqual(env['Integrations__Atera__Enabled'], 'false')
            self.assertEqual(env['Integrations__MicrosoftGraph__Enabled'], 'false')
            self.assertEqual(env['Integrations__PartnerCenter__Enabled'], 'false')
            self.assertEqual(env['Notifications__EmailEnabled'], 'false')
            self.assertEqual(env['Sales__EmailEnabled'], 'false')
            self.assertEqual(env['APPLICATIONINSIGHTS_CONNECTION_STRING'], '')
            self.assertEqual(env['OTEL_EXPORTER_OTLP_ENDPOINT'], '')
            self.assertEqual(env['DataProtection__BlobUri'], '')
            self.assertEqual(env['DataProtection__KeyVaultKeyUri'], '')
        self.assertEqual(web['Integrations__PowerOffice__ClientKey'], '')
        self.assertEqual(worker['Integrations__PowerOffice__ClientKey'], 'simulated')

    def test_failed_sql_diagnostics_redact_both_credentials(self):
        sample = state()
        error = subprocess.CalledProcessError(1, ['sqlcmd'], output=sample['password']+' '+sample['runtimePassword'])
        with patch.object(local, 'run', side_effect=error):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                local.sql(sample, 'SELECT 1;')
        notes = ' '.join(raised.exception.__notes__)
        self.assertNotIn(sample['password'], notes)
        self.assertNotIn(sample['runtimePassword'], notes)

    def test_simulated_provider_profile_cannot_be_changed_by_inherited_environment(self):
        with patch.dict(os.environ, {'SIMULATED_FAILURE_EVERY': '1', 'NODE_OPTIONS': '--require=/private/other-script.js',
                                     'HTTPS_PROXY': 'https://remote-proxy', 'AZURE_CLIENT_SECRET': 'private-secret'}):
            env = local.provider_environment()
        self.assertEqual(env['SIMULATED_FAILURE_EVERY'], '0')
        self.assertIn('PATH', env)
        self.assertNotIn('NODE_OPTIONS', env)
        self.assertNotIn('HTTPS_PROXY', env)
        self.assertNotIn('AZURE_CLIENT_SECRET', env)


if __name__ == '__main__':
    unittest.main()
