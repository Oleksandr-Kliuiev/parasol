"""Fail-closed recovery oracles; native database behavior is tested by rehearse.py."""
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import rehearsal_workload as workload


class SyntheticStack:
    def __init__(self, kind='rehearsal'):
        self.meta = {'kind': kind, 'compose': {'ISOLATED': 'true', 'READ_ONLY': 'true',
                                             'BIND_ADDRESS': '127.0.0.1'}}
        self.calls = []
        self.sql_output = ('\n'.join(['A' * 64] * len(workload.SQL_TABLES))).encode()

    def sql(self, query, database):
        self.calls.append(('sql', query, database))
        return self.sql_output


class WorkloadTests(unittest.TestCase):
    def setUp(self):
        self.stack = SyntheticStack()
        self.fixture = workload.Workload()

    def test_production_or_nonquarantined_state_is_rejected_before_database_calls(self):
        for kind in ('production', 'restore', None):
            with self.subTest(kind=kind):
                stack = SyntheticStack(kind)
                with self.assertRaises(ValueError): workload.seed(stack)
                self.assertEqual(stack.calls, [])
        for key, bad in [('ISOLATED', 'false'), ('READ_ONLY', 'false'), ('BIND_ADDRESS', '0.0.0.0')]:
            with self.subTest(key=key):
                stack = SyntheticStack()
                stack.meta['compose'][key] = bad
                with self.assertRaises(ValueError): workload.seed(stack)
                self.assertEqual(stack.calls, [])

    def test_restored_state_can_be_read_but_never_post_backup_mutated(self):
        stack = SyntheticStack('restore')
        workload.capture(stack, self.fixture)
        stack.calls.clear()
        with self.assertRaises(ValueError): workload.mutate_after_backup(stack, self.fixture, {})
        self.assertEqual(stack.calls, [])

    def test_seed_writes_one_alert_and_its_atera_task_receipt_in_one_owner_transaction(self):
        fixture = workload.seed(self.stack)
        [(kind, query, database)] = self.stack.calls
        self.assertEqual((kind, database), ('sql', 'Crm'))
        self.assertIn('BEGIN TRANSACTION;', query)
        self.assertTrue(query.endswith('COMMIT;'))
        for table in workload.SQL_TABLES:
            with self.subTest(table=table):
                self.assertIn(f'IF EXISTS (SELECT 1 FROM {workload.sql_table(table)})', query)
                self.assertIn(f'INSERT {workload.sql_table(table)}', query)
        # The alert carries its Atera customer, as the receipt does; columns added later must be nullable or defaulted.
        self.assertIn('INSERT [service].[Alerts] (Id,System,ExternalId,OrganizationId,ExternalCustomerId,Severity,Title,DeviceName,'
                      'CreatedAtSource)\n VALUES (' + f"'{fixture.alert}','atera','920029','{fixture.organization}','900029'", query)
        self.assertIn(f"VALUES ('{fixture.source_key}','{fixture.task}','atera','alert','900029','920029','Task'", query)
        # The task's subject is the alert's title, as the CRM offers it.
        self.assertIn(f"VALUES ('{fixture.task}','Task','{fixture.organization}','Synthetic recovery alert','High','Open'", query)

    def test_receipt_key_is_the_crm_source_task_key_of_the_atera_alert(self):
        # SourceTaskIdentityRules.Key hashes the System.Text.Json form of the identity array; the CRM's unit test
        # SourceTaskTests pins the same digest for the same alert.
        expected = hashlib.sha256(b'["SourceTaskV1","atera","alert","900029","920029","Task"]').hexdigest()
        self.assertEqual(self.fixture.source_key, expected)
        self.assertEqual(expected, '8f7340d260a6b240d65f9673b311315552400b89b6fa17821b1fc5c60aae6aa6')

    def test_fingerprint_requires_every_sql_row_instead_of_accepting_truncated_output(self):
        count = len(workload.SQL_TABLES)
        for bad in (b'', b'A' * 63, b'NULL', ('\n'.join(['A' * 64] * (count - 1))).encode(),
                    ('\n'.join(['A' * 64] * (count + 1))).encode()):
            self.stack.sql_output = bad
            with self.subTest(output_length=len(bad)):
                with self.assertRaisesRegex(RuntimeError, 'Incomplete SQL'):
                    workload.capture(self.stack, self.fixture)

    def test_fingerprint_hashes_every_workflow_row_including_the_alert_in_sql_server(self):
        self.assertEqual(set(workload.capture(self.stack, self.fixture)), set(workload.SQL_TABLES))
        [(_, query, database)] = self.stack.calls
        self.assertEqual(database, 'Crm')
        self.assertIn(f"SELECT * FROM [service].[Alerts] WHERE Id='{self.fixture.alert}' FOR JSON PATH, INCLUDE_NULL_VALUES", query)
        self.assertEqual(query.count('HASHBYTES'), len(workload.SQL_TABLES))

    def test_changed_rowversion_missing_receipt_or_extra_table_cannot_pass_restore(self):
        expected = workload.capture(self.stack, self.fixture)
        for table in ('activities.Activities', 'activities.SourceTaskLinks', 'service.Alerts',
                      'time.TimeEntries', 'time.TimeEntryCreateReceipts'):
            changed = {**expected, table: 'B' * 64}
            with self.subTest(table=table), patch.object(workload, 'capture', return_value=changed), \
                    patch.object(workload, 'verify_integrity') as integrity:
                with self.assertRaisesRegex(RuntimeError, 'fingerprint changed'):
                    workload.verify_restored(self.stack, self.fixture, expected)
                integrity.assert_not_called()
        for invalid in ({k: v for k, v in expected.items() if k != 'time.TimeEntryCreateReceipts'},
                        {**expected, 'unexpected': 'A' * 64}):
            with patch.object(workload, 'capture', return_value=invalid):
                with self.assertRaises(RuntimeError): workload.verify_restored(self.stack, self.fixture, invalid)

    def test_matching_rows_still_require_runtime_receipt_denies_and_relational_integrity(self):
        expected = workload.capture(self.stack, self.fixture)
        with patch.object(workload, 'verify_integrity', side_effect=RuntimeError('runtime permission failure')):
            with self.assertRaisesRegex(RuntimeError, 'runtime permission failure'):
                workload.verify_restored(self.stack, self.fixture, expected)

    def test_noop_or_unrelated_post_backup_change_does_not_prove_point_in_time_restore(self):
        before = workload.capture(self.stack, self.fixture)
        changed = lambda *tables: {**before, **{table: 'B' * 64 for table in tables}}
        for after in (before, changed('time.TimeEntryCreateReceipts'), changed('activities.Activities'),
                      changed('activities.Activities', 'time.TimeEntries'),
                      changed('activities.Activities', 'time.TimeEntries', 'service.Alerts', 'service.Tickets')):
            with patch.object(workload, 'capture', return_value=after):
                with self.assertRaisesRegex(RuntimeError, 'isolated and effective'):
                    workload.mutate_after_backup(self.stack, self.fixture, before)
        with patch.object(workload, 'capture', return_value=changed('activities.Activities', 'time.TimeEntries', 'service.Alerts')):
            workload.mutate_after_backup(self.stack, self.fixture, before)
        self.assertIn(f"UPDATE [service].[Alerts] SET Severity='Warning' WHERE Id='{self.fixture.alert}'", self.stack.calls[-1][1])

    def test_workload_proof_exposes_only_bounded_facts_and_does_not_claim_http_replay(self):
        expected = workload.capture(self.stack, self.fixture)
        with patch.object(workload, 'verify_integrity'):
            proof = workload.verify_restored(self.stack, self.fixture, expected)
        self.assertEqual(proof['sqlRows'], 9)
        self.assertTrue(proof['ownerSeededPersistenceOnly'])
        self.assertFalse(proof['httpReplayTested'])
        self.assertNotIn(self.fixture.technician, json.dumps(proof))
        self.assertNotIn(self.fixture.source_key, json.dumps(proof))


if __name__ == '__main__':
    unittest.main()
