"""Fail-closed recovery oracles; native database behavior is tested by rehearse.py."""
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
        self.pg_rows = [{'table': table, 'rows': [{'id': 'synthetic', 'nullable': None}]}
                        for table in workload.PG_TABLES]

    def sql(self, query, database):
        self.calls.append(('sql', query, database))
        return self.sql_output

    def pg(self, query):
        self.calls.append(('pg', query))
        return '\n'.join(json.dumps(row) for row in self.pg_rows).encode()


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

    def test_fingerprint_requires_every_sql_row_instead_of_accepting_truncated_output(self):
        for bad in (b'', b'A' * 63, b'NULL', ('\n'.join(['A' * 64] * 7)).encode(),
                    ('\n'.join(['A' * 64] * 9)).encode()):
            self.stack.sql_output = bad
            with self.subTest(output_length=len(bad)):
                with self.assertRaisesRegex(RuntimeError, 'Incomplete SQL'):
                    workload.capture(self.stack, self.fixture)

    def test_fingerprint_rejects_missing_duplicate_or_wrong_pg_row(self):
        for rows in (None, [], [{'id': 'one'}, {'id': 'two'}]):
            self.stack.pg_rows[-1]['rows'] = rows
            with self.subTest(rows=rows):
                with self.assertRaisesRegex(RuntimeError, 'missing or ambiguous'):
                    workload.capture(self.stack, self.fixture)
        self.stack.pg_rows.pop()
        with self.assertRaisesRegex(RuntimeError, 'Incomplete PostgreSQL'):
            workload.capture(self.stack, self.fixture)
        self.stack = SyntheticStack()
        self.stack.pg_rows[-1]['table'] = 'RawEvent'
        with self.assertRaisesRegex(RuntimeError, 'missing or ambiguous'):
            workload.capture(self.stack, self.fixture)

    def test_fingerprint_canonicalizes_pg_object_order_and_includes_nulls(self):
        before = workload.capture(self.stack, self.fixture)
        self.stack.pg_rows[-1]['rows'] = [{'nullable': None, 'id': 'synthetic'}]
        self.assertEqual(workload.capture(self.stack, self.fixture), before)
        self.stack.pg_rows[-1]['rows'] = [{'id': 'synthetic'}]
        self.assertNotEqual(workload.capture(self.stack, self.fixture), before)

    def test_changed_rowversion_missing_receipt_or_extra_table_cannot_pass_restore(self):
        expected = workload.capture(self.stack, self.fixture)
        for table in ('activities.Activities', 'time.TimeEntries', 'time.TimeEntryCreateReceipts', 'atlas.Observation'):
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
        unrelated = {**before, 'time.TimeEntryCreateReceipts': 'B' * 64}
        partial = {**before, 'activities.Activities': 'B' * 64}
        for after in (before, unrelated, partial):
            with patch.object(workload, 'capture', return_value=after):
                with self.assertRaisesRegex(RuntimeError, 'isolated and effective'):
                    workload.mutate_after_backup(self.stack, self.fixture, before)

    def test_workload_proof_exposes_only_bounded_facts_and_does_not_claim_http_replay(self):
        expected = workload.capture(self.stack, self.fixture)
        with patch.object(workload, 'verify_integrity'):
            proof = workload.verify_restored(self.stack, self.fixture, expected)
        self.assertEqual(proof['sqlRows'], 8)
        self.assertEqual(proof['atlasRows'], 5)
        self.assertTrue(proof['ownerSeededPersistenceOnly'])
        self.assertFalse(proof['httpReplayTested'])
        self.assertNotIn(self.fixture.technician, json.dumps(proof))
        self.assertNotIn(self.fixture.source_key, json.dumps(proof))


if __name__ == '__main__':
    unittest.main()
