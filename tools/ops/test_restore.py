"""tools/ops/restore.py against a stand-in az (DEV-13-AC03).

`az` is replaced by a script that answers from a scenario and logs every call; nothing reaches Azure. The tests pin what the
operator relies on: no environment is chosen for them, names come from the deployment, a dry run changes nothing, the live
database is renamed only by an explicitly confirmed switch, and nothing is ever deleted.
"""
from __future__ import annotations

import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE / "restore.py"
NOW = "2026-10-04T08:30:00Z"

FAKE_AZ = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
scenario = json.load(open(os.environ["AZ_SCENARIO"]))
with open(os.environ["AZ_LOG"], "a") as log:
    log.write(" ".join(args) + "\n")
def value(name):
    return args[args.index(name) + 1] if name in args else None
def answer(result, code=0):
    if result is not None:
        print(json.dumps(result))
    sys.exit(code)
if args[:3] == ["deployment", "group", "list"]: answer(scenario["deployments"])
if args[:3] == ["deployment", "group", "show"]: answer(scenario["outputs"][value("-n")])
if args[:3] == ["sql", "db", "show"]:
    db = scenario["databases"].get(value("-n"))
    if db is None:
        print("ResourceNotFound", file=sys.stderr)
        sys.exit(3)
    answer(db)
if args[:3] == ["sql", "db", "restore"]: answer(None)
if args[:3] == ["sql", "db", "rename"]:
    if value("-n") in scenario.get("failRename", []):
        print("rename failed", file=sys.stderr)
        sys.exit(1)
    answer(None)
if args[:3] == ["containerapp", "revision", "list"]: answer(scenario["revisions"][value("-n")])
if args[:2] == ["containerapp", "show"]: answer(scenario["latest"][value("-n")])
if args[:3] == ["containerapp", "revision"] and args[2] in ("restart", "deactivate", "activate"): answer(None)
print("unexpected az call: " + " ".join(args), file=sys.stderr)
sys.exit(9)
'''

OUTPUTS = {
    # Deliberately unlike the old runbook's hand-typed names: the script must use what the deployment says.
    "sqlServerName": {"type": "String", "value": "sql-crm-prod-zq81"},
    "sqlDatabaseName": {"type": "String", "value": "crm"},
    "webAppName": {"type": "String", "value": "ca-crm-web-prod"},
    "workerAppName": {"type": "String", "value": "ca-crm-worker-prod"},
    "migrationJobName": {"type": "String", "value": "caj-crm-migrate-prod"},
    "storageAccountName": {"type": "String", "value": "stcrmprodzq81"},
    "webUrl": {"type": "String", "value": "https://crm.example"},
}


def scenario(**overrides):
    base = {
        "deployments": [
            {"name": "crm-prod-20261001120000", "at": "2026-10-01T12:00:00Z"},
            {"name": "crm-prod-20261003090000", "at": "2026-10-03T09:00:00Z"},
        ],
        "outputs": {"crm-prod-20261003090000": OUTPUTS, "crm-prod-20261001120000": {}},
        "databases": {
            "crm": {"name": "crm", "status": "Online", "objective": "GP_S_Gen5_4", "earliest": "2026-09-01T00:00:00Z"},
            "crm-restore-202610040815": {"name": "crm-restore-202610040815", "status": "Online", "objective": "GP_S_Gen5_4", "earliest": "2026-10-04T08:15:00Z"},
        },
        "revisions": {"ca-crm-web-prod": ["ca-crm-web-prod--r7", "ca-crm-web-prod--r8"], "ca-crm-worker-prod": ["ca-crm-worker-prod--w3"]},
        "latest": {"ca-crm-worker-prod": "ca-crm-worker-prod--w3"},
    }
    base.update(overrides)
    return base


class RestoreScript(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.dir.name)
        self.az = root / "az"
        self.az.write_text(FAKE_AZ)
        self.az.chmod(self.az.stat().st_mode | stat.S_IEXEC)
        self.log = root / "az.log"
        self.scenario_file = root / "scenario.json"

    def tearDown(self):
        self.dir.cleanup()

    def run_script(self, *args, scene=None):
        self.scenario_file.write_text(json.dumps(scene or scenario()))
        self.log.write_text("")
        env = {**os.environ, "AZ": str(self.az), "AZ_SCENARIO": str(self.scenario_file), "AZ_LOG": str(self.log), "RESTORE_NOW": NOW}
        result = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env)
        return result, [line for line in self.log.read_text().splitlines() if line]

    def changes(self, calls):
        return [c for c in calls if not (" show " in f" {c} " or " list " in f" {c} ")]

    def test_no_environment_is_chosen_for_the_operator(self):
        result, calls = self.run_script("discover")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--env", result.stderr)
        self.assertEqual(calls, [])
        result, calls = self.run_script("--env", "prod")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, [])

    def test_names_come_from_the_latest_successful_deployment(self):
        result, calls = self.run_script("--env", "prod", "discover")
        self.assertEqual(result.returncode, 0, result.stderr)
        names = json.loads(result.stdout)
        self.assertEqual(names["sqlServerName"], "sql-crm-prod-zq81")
        self.assertEqual(names["deployment"], "crm-prod-20261003090000")
        self.assertEqual(names["resourceGroup"], "rg-crm-prod")
        self.assertEqual(self.changes(calls), [])

    def test_a_deployment_without_the_outputs_is_refused(self):
        scene = scenario(deployments=[{"name": "crm-prod-20261001120000", "at": "2026-10-01T12:00:00Z"}])
        result, calls = self.run_script("--env", "prod", "points", scene=scene)
        self.assertEqual(result.returncode, 3)
        self.assertIn("has no output", result.stderr)
        self.assertEqual(self.changes(calls), [])

    def test_restore_without_execute_only_prints_and_never_touches_the_live_database(self):
        result, calls = self.run_script("--env", "prod", "restore", "--time", "2026-10-04T06:30:00Z")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DRY RUN  az sql db restore -g rg-crm-prod -s sql-crm-prod-zq81 -n crm --dest-name crm-restore-202610040830 --time 2026-10-04T06:30:00Z", result.stdout)
        self.assertEqual(self.changes(calls), [])

    def test_restore_creates_a_new_database_beside_the_live_one(self):
        result, calls = self.run_script("--env", "prod", "restore", "--time", "2026-10-04T06:30:00Z", "--execute")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.changes(calls), [
            "sql db restore -g rg-crm-prod -s sql-crm-prod-zq81 -n crm --dest-name crm-restore-202610040830 --time 2026-10-04T06:30:00Z -o none"])
        self.assertRegex(result.stdout, r"\[2026-10-04T08:30:00Z\] az sql db restore")

    def test_a_restore_point_outside_the_window_is_refused(self):
        for point in ("2026-10-04T09:00:00Z", "2026-08-01T00:00:00Z", "yesterday"):
            result, calls = self.run_script("--env", "prod", "restore", "--time", point, "--execute")
            self.assertEqual(result.returncode, 3, point)
            self.assertEqual(self.changes(calls), [], point)

    def test_a_switch_needs_execute_and_the_exact_confirmation(self):
        restored = "crm-restore-202610040815"
        result, calls = self.run_script("--env", "prod", "switch", "--database", restored)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DRY RUN  az sql db rename -g rg-crm-prod -s sql-crm-prod-zq81 -n crm --new-name crm-before-202610040830", result.stdout)
        self.assertIn(f"--confirm prod/sql-crm-prod-zq81/{restored}", result.stdout)
        self.assertEqual(self.changes(calls), [])

        for confirm in ([], ["--confirm", "prod"], ["--confirm", f"test/sql-crm-prod-zq81/{restored}"]):
            result, calls = self.run_script("--env", "prod", "switch", "--database", restored, "--execute", *confirm)
            self.assertEqual(result.returncode, 3, confirm)
            self.assertIn("nothing was renamed", result.stderr)
            self.assertEqual(self.changes(calls), [], confirm)

        result, calls = self.run_script("--env", "prod", "switch", "--database", restored, "--execute", "--confirm", f"prod/sql-crm-prod-zq81/{restored}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.changes(calls), [
            "sql db rename -g rg-crm-prod -s sql-crm-prod-zq81 -n crm --new-name crm-before-202610040830 -o none",
            f"sql db rename -g rg-crm-prod -s sql-crm-prod-zq81 -n {restored} --new-name crm -o none",
        ])

    def test_a_switch_whose_second_step_fails_puts_the_live_database_back(self):
        restored = "crm-restore-202610040815"
        result, calls = self.run_script(
            "--env", "prod", "switch", "--database", restored, "--execute", "--confirm", f"prod/sql-crm-prod-zq81/{restored}",
            scene=scenario(failRename=[restored]))
        self.assertEqual(result.returncode, 4)
        self.assertEqual(self.changes(calls)[-1], "sql db rename -g rg-crm-prod -s sql-crm-prod-zq81 -n crm-before-202610040830 --new-name crm -o none")

    def test_a_switch_refuses_the_live_database_an_unknown_one_and_an_offline_one(self):
        offline = scenario()
        offline["databases"]["crm-restore-202610040815"]["status"] = "Restoring"
        for database, scene in (("crm", None), ("crm-restore-209901010000", None), ("crm-restore-202610040815", offline)):
            result, calls = self.run_script(
                "--env", "prod", "switch", "--database", database, "--execute", "--confirm", f"prod/sql-crm-prod-zq81/{database}", scene=scene)
            self.assertEqual(result.returncode, 3, database)
            self.assertEqual(self.changes(calls), [], database)

    def test_restart_and_worker_switches_act_on_the_deployed_apps_only_with_execute(self):
        result, calls = self.run_script("--env", "prod", "restart")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("DRY RUN"), 3)
        self.assertEqual(self.changes(calls), [])

        result, calls = self.run_script("--env", "prod", "worker-off", "--execute")
        self.assertEqual(self.changes(calls), ["containerapp revision deactivate -g rg-crm-prod -n ca-crm-worker-prod --revision ca-crm-worker-prod--w3 -o none"])
        result, calls = self.run_script("--env", "prod", "worker-on", "--execute")
        self.assertEqual(self.changes(calls), ["containerapp revision activate -g rg-crm-prod -n ca-crm-worker-prod --revision ca-crm-worker-prod--w3 -o none"])

    def test_the_script_has_no_way_to_delete_a_database_or_to_stop_an_app_by_a_scale_of_zero(self):
        source = SCRIPT.read_text()
        self.assertNotIn('"delete"', source)
        self.assertNotIn("max-replicas", source)


if __name__ == "__main__":
    unittest.main()
