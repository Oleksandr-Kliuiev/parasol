"""Tests of the release gates: python3 -m unittest discover -s tools/release (DEV-05)."""
from __future__ import annotations

import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import release  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef01234567"
WEB = "crcrmtest1234.azurecr.io/crm-web@sha256:" + "a" * 64
WORKER = "crcrmtest1234.azurecr.io/crm-worker@sha256:" + "b" * 64
PROD_WEB = "crcrmprod5678.azurecr.io/crm-web@sha256:" + "a" * 64
PROD_WORKER = "crcrmprod5678.azurecr.io/crm-worker@sha256:" + "b" * 64
CHECKS = {job: "success" for job in release.REQUIRED_CI_JOBS}
ROOT = pathlib.Path(__file__).resolve().parents[2]


def dotnet_report(**overrides):
    report = {"version": 1, "parameters": "--vulnerable --include-transitive", "sources": ["https://api.nuget.org/v3/index.json"],
              "projects": [{"path": "/src/Crm.Web/Crm.Web.csproj"}, {"path": "/src/Crm.Worker/Crm.Worker.csproj"}]}
    report.update(overrides)
    return report


def vulnerable(severity):
    return [{"path": "/src/Crm.Web/Crm.Web.csproj", "frameworks": [{"framework": "net10.0", "transitivePackages": [
        {"id": "Some.Package", "resolvedVersion": "1.0.0", "vulnerabilities": [{"severity": severity, "advisoryurl": "https://github.com/advisories/GHSA-x"}]}]}]}]


def npm_report(**counts):
    vulnerabilities = {"info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0}
    vulnerabilities.update(counts)
    vulnerabilities["total"] = sum(vulnerabilities.values())
    return {"auditReportVersion": 2, "vulnerabilities": {}, "metadata": {"vulnerabilities": vulnerabilities,
            "dependencies": {"prod": 107, "dev": 258, "total": 364}}}


class ScannerGates(unittest.TestCase):
    def test_a_clean_dotnet_scan_passes(self):
        self.assertEqual(release.check_vulnerable_dotnet(dotnet_report(), min_projects=2), [])

    def test_high_and_critical_dotnet_findings_block(self):
        for severity in ("High", "Critical", "unknown-severity"):
            with self.subTest(severity), self.assertRaises(release.GateError):
                release.check_vulnerable_dotnet(dotnet_report(projects=vulnerable(severity)))

    def test_moderate_dotnet_findings_are_reported_not_blocking(self):
        warnings = release.check_vulnerable_dotnet(dotnet_report(projects=vulnerable("Moderate")))
        self.assertEqual(len(warnings), 1)
        self.assertIn("Some.Package", warnings[0])

    def test_a_dotnet_scan_that_could_not_run_is_not_a_clean_result(self):
        cases = {
            "source failed": dotnet_report(problems=[{"level": "error", "text": "Unable to load the service index for source"}]),
            "no source": dotnet_report(sources=[]),
            "no projects": dotnet_report(projects=[]),
            "fewer projects": dotnet_report(),
            "project problem": dotnet_report(projects=[{"path": "/a.csproj", "problems": [{"level": "warning", "text": "assets file missing"}]}, {"path": "/b.csproj"}, {"path": "/c.csproj"}]),
            "unknown version": dotnet_report(version=2),
        }
        for name, report in cases.items():
            with self.subTest(name), self.assertRaises(release.GateError):
                release.check_vulnerable_dotnet(report, min_projects=3)

    def test_npm_audit_gate(self):
        self.assertEqual(release.check_npm_audit(npm_report()), [])
        self.assertEqual(release.check_npm_audit(npm_report(moderate=2)), ["moderate: 2"])
        for counts in ({"high": 1}, {"critical": 1}):
            with self.subTest(counts), self.assertRaises(release.GateError):
                release.check_npm_audit(npm_report(**counts))

    def test_an_npm_audit_that_failed_or_skipped_build_time_dependencies_blocks(self):
        without_dev = npm_report()
        without_dev["metadata"]["dependencies"] = {"prod": 107, "dev": 0, "total": 107}
        cases = {
            "registry error": {"error": {"code": "ENOAUDIT", "summary": "Your configured registry does not support audit requests."}},
            "nothing audited": {"auditReportVersion": 2, "vulnerabilities": {}, "metadata": {"vulnerabilities": {}, "dependencies": {"total": 0}}},
            "omit=dev": without_dev,
            "unknown version": {"auditReportVersion": 1},
        }
        for name, report in cases.items():
            with self.subTest(name), self.assertRaises(release.GateError):
                release.check_npm_audit(report)


class SecretScan(unittest.TestCase):
    def test_artifacts_with_credentials_are_refused_and_clean_ones_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            clean = pathlib.Path(folder, "release-manifest.json")
            clean.write_text(json.dumps({"images": {"web": {"reference": WEB}}, "commit": SHA}))
            self.assertEqual(release.scan_secrets([folder]), [])
            samples = {
                "conn.txt": "Server=tcp:sql;Database=crm;User Id=sa;Password=Hunter2Hunter2;",
                "blob.txt": "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=" + "A" * 40,
                "sas.txt": "https://x.blob.core.windows.net/c?sv=2024&sig=" + "a" * 30,
                "key.pem": "-----BEGIN RSA PRIVATE KEY-----",
                "log.txt": "Authorization: Bearer " + "x" * 40,
                "jwt.txt": "eyJhbGciOiJSUzI1NiJ9a.eyJzdWIiOiIxMjM0NTY3ODkwIn0b.c2lnbmF0dXJlLXZhbHVlLWhlcmU",
                "gh.txt": "ghp_" + "a" * 36,
                "app.json": '{"client_secret": "abcdefghijklmnop1234"}',
            }
            for name, content in samples.items():
                pathlib.Path(folder, name).write_text(content)
            findings = release.scan_secrets([folder])
            for name in samples:
                with self.subTest(name):
                    self.assertTrue(any(name in finding for finding in findings), findings)
            self.assertFalse(any("release-manifest.json" in finding for finding in findings))

    def test_a_missing_artifact_cannot_be_cleared(self):
        with self.assertRaises(release.GateError):
            release.scan_secrets(["/nonexistent/artifact"])


class Manifest(unittest.TestCase):
    def create(self, **overrides):
        with tempfile.TemporaryDirectory() as folder:
            sbom = pathlib.Path(folder, "crm-web.spdx.json")
            sbom.write_text('{"spdxVersion": "SPDX-2.3"}')
            args = dict(sha=SHA, repository="vardahei/crm", run_id="42", run_url="https://github.com/vardahei/crm/actions/runs/42",
                        web=WEB, worker=WORKER, checks=dict(CHECKS), sboms=[str(sbom)], root=str(ROOT))
            args.update(overrides)
            return release.create_manifest(**args)

    def test_the_manifest_pins_digests_schema_sbom_checks_and_provenance(self):
        manifest = self.create()
        release.verify_manifest(manifest, SHA)
        self.assertEqual(manifest["images"]["migrator"]["digest"], manifest["images"]["web"]["digest"])
        self.assertEqual(manifest["images"]["worker"]["digest"], "sha256:" + "b" * 64)
        self.assertIn("Crm.Billing", manifest["schemaVersions"])
        self.assertEqual(manifest["schemaBreaks"], ["Crm.Billing/20261004011343_ProtectApprovedBilling"])
        self.assertRegex(manifest["schemaVersions"]["Crm.Billing"], r"^\d{14}_")
        self.assertEqual(len(manifest["sbom"][0]["sha256"]), 64)
        self.assertTrue(manifest["provenance"]["builtOnce"])

    def test_a_release_cannot_be_made_from_a_failed_ci_job_or_without_digests(self):
        for job in release.REQUIRED_CI_JOBS:
            with self.subTest(job), self.assertRaises(release.GateError):
                self.create(checks={**CHECKS, job: "failure"})
        for reference in ("crcrmtest1234.azurecr.io/crm-web:latest", "crm-web@sha256:abc", "crcrmtest1234.azurecr.io/crm-web@sha256:" + "A" * 64):
            with self.subTest(reference), self.assertRaises(release.GateError):
                self.create(web=reference)
        with self.assertRaises(release.GateError):
            self.create(sha="main")

    def test_a_manifest_of_another_commit_or_tampered_entries_is_refused(self):
        manifest = self.create()
        with self.assertRaises(release.GateError):
            release.verify_manifest(manifest, "f" * 40)
        tampered = json.loads(json.dumps(manifest))
        tampered["images"]["web"]["digest"] = "sha256:" + "c" * 64
        with self.assertRaises(release.GateError):
            release.verify_manifest(tampered, SHA)
        other_migrator = json.loads(json.dumps(manifest))
        other_migrator["images"]["migrator"] = release.parse_image(WORKER)
        with self.assertRaises(release.GateError):
            release.verify_manifest(other_migrator, SHA)


class Promotion(unittest.TestCase):
    def setUp(self):
        with tempfile.TemporaryDirectory() as folder:
            sbom = pathlib.Path(folder, "sbom.json")
            sbom.write_text("{}")
            self.manifest = release.create_manifest(sha=SHA, repository="vardahei/crm", run_id="42", run_url="u", web=WEB, worker=WORKER,
                                                    checks=dict(CHECKS), sboms=[str(sbom)], root=str(ROOT))
        self.smoke = {"result": "pass", "checks": 9, "failed": []}
        self.test_deployment = release.deployment_record(self.manifest, environment="test", web_image=WEB, worker_image=WORKER,
                                                         migration_image=WEB, smoke=self.smoke, web_revision="ca-crm-web-test--r1", worker_revision=None)
        self.jobs = {"jobs": [{"name": n, "conclusion": "success"} for n in
                              ("backend", "frontend", "e2e", "infrastructure", "codeql (csharp)", "codeql (javascript-typescript)",
                               "release / publish", "release / deploy-test")]}
        self.required = list(release.REQUIRED_CI_JOBS) + ["release / publish", "release / deploy-test"]

    def check(self, **overrides):
        args = dict(sha=SHA, manifest=self.manifest, deployment=self.test_deployment, jobs=self.jobs, required=self.required, rollback=False)
        args.update(overrides)
        release.promotion_check(**args)

    def test_the_tested_artifact_is_promoted_and_production_runs_the_same_digests(self):
        self.check()
        prod = release.deployment_record(self.manifest, environment="prod", web_image=PROD_WEB, worker_image=PROD_WORKER,
                                         migration_image=PROD_WEB, smoke=self.smoke, web_revision="ca-crm-web-prod--r9", worker_revision=None)
        for role in ("web", "worker", "migrator"):
            self.assertEqual(prod["images"][role]["digest"], self.test_deployment["images"][role]["digest"])
        self.assertNotEqual(prod["images"]["web"]["repository"], self.test_deployment["images"]["web"]["repository"])

    def test_an_unverified_sha_or_digest_is_refused(self):
        cases = {
            "other sha": dict(sha="f" * 40),
            "short sha": dict(sha=SHA[:7]),
            "failed job": dict(jobs={"jobs": [*self.jobs["jobs"][:-1], {"name": "release / deploy-test", "conclusion": "failure"}]}),
            "missing job": dict(jobs={"jobs": self.jobs["jobs"][1:]}),
            "one matrix leg failed": dict(jobs={"jobs": [*self.jobs["jobs"], {"name": "codeql (csharp)", "conclusion": "failure"}]}),
            "untested digest": dict(deployment={**self.test_deployment, "images": {**self.test_deployment["images"], "web": release.parse_image(
                "crcrmtest1234.azurecr.io/crm-web@sha256:" + "d" * 64)}}),
            "failed smoke": dict(deployment={**self.test_deployment, "smoke": {"result": "fail"}}),
            "not from test": dict(deployment={**self.test_deployment, "environment": "prod"}),
        }
        for name, overrides in cases.items():
            with self.subTest(name), self.assertRaises(release.GateError):
                self.check(**overrides)

    def test_a_deployment_record_refuses_an_environment_that_runs_something_else(self):
        with self.assertRaises(release.GateError):
            release.deployment_record(self.manifest, environment="test", web_image="crcrmtest1234.azurecr.io/crm-web@sha256:" + "e" * 64,
                                      worker_image=WORKER, migration_image=WEB, smoke=self.smoke, web_revision=None, worker_revision=None)
        with self.assertRaises(release.GateError):
            release.deployment_record(self.manifest, environment="test", web_image=WEB, worker_image=WORKER, migration_image=WEB,
                                      smoke={"result": "fail", "failed": ["ready"]}, web_revision=None, worker_revision=None)

    def test_a_rollback_goes_back_to_a_release_that_ran_in_that_environment(self):
        prod = release.deployment_record(self.manifest, environment="prod", web_image=PROD_WEB, worker_image=PROD_WORKER,
                                         migration_image=PROD_WEB, smoke=self.smoke, web_revision=None, worker_revision=None)
        self.check(deployment=prod, rollback=True, jobs=None)
        # The rollback itself runs no migrations: the job keeps the newer image and the record says so.
        back = release.deployment_record(self.manifest, environment="prod", web_image=PROD_WEB, worker_image=PROD_WORKER,
                                         migration_image=None, smoke=self.smoke, web_revision=None, worker_revision=None, rollback=True)
        self.assertTrue(back["rollback"])
        self.assertNotIn("migrator", back["images"])
        self.check(deployment=back, rollback=True, jobs=None)
        with self.assertRaises(release.GateError):
            release.deployment_record(self.manifest, environment="prod", web_image=PROD_WEB, worker_image=PROD_WORKER,
                                      migration_image=None, smoke=self.smoke, web_revision=None, worker_revision=None)


class SchemaBreaks(unittest.TestCase):
    BREAK = "Crm.Billing/20261004011343_ProtectApprovedBilling"

    def release_with(self, commit, breaks):
        return {"commit": commit, "schemaBreaks": breaks}

    def test_the_registry_marks_the_trigger_migration_and_a_manifest_carries_its_breaks(self):
        breaks = release.load_breaks(ROOT)
        self.assertIn(self.BREAK, [f"{b['context']}/{b['migration']}" for b in breaks])
        self.assertEqual(release.breaks_in({"Crm.Billing": "20261004011343_ProtectApprovedBilling"}, breaks), [self.BREAK])
        self.assertEqual(release.breaks_in({"Crm.Billing": "20261004002311_ChargeRegister"}, breaks), [])
        self.assertEqual(release.breaks_in({"Crm.Billing": "20991231000000_Later"}, breaks), [self.BREAK])

    def test_a_rollback_below_a_break_the_environment_has_is_refused_whatever_is_accepted(self):
        current = self.release_with("c" * 40, [self.BREAK])
        older = self.release_with("a" * 40, [])
        for accept in (False, True):
            with self.subTest(accept=accept), self.assertRaises(release.GateError) as refused:
                release.schema_guard(older, current, accept)
            self.assertIn("predates", str(refused.exception))
        self.assertEqual(release.schema_guard(self.release_with("b" * 40, [self.BREAK]), current, False), [])

    def test_deploying_a_break_over_a_release_without_it_needs_an_accepted_window(self):
        running = self.release_with("a" * 40, [])
        new = self.release_with("c" * 40, [self.BREAK])
        with self.assertRaises(release.GateError):
            release.schema_guard(new, running, False)
        self.assertEqual(len(release.schema_guard(new, running, True)), 1)
        with self.assertRaises(release.GateError):
            release.schema_guard(new, None, False)
        self.assertTrue(release.schema_guard(new, None, True))
        self.assertTrue(release.schema_guard(running, None, False))


class CommandLine(unittest.TestCase):
    def test_exit_codes(self):
        with tempfile.TemporaryDirectory() as folder:
            good = pathlib.Path(folder, "good.json")
            good.write_text(json.dumps(npm_report()))
            bad = pathlib.Path(folder, "bad.json")
            bad.write_text("not json")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(release.main(["npm-audit", str(good)]), 0)
                self.assertEqual(release.main(["npm-audit", str(bad)]), 1)
                self.assertEqual(release.main(["npm-audit", str(pathlib.Path(folder, "missing.json"))]), 1)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(release.main(["schema-versions", "--root", str(ROOT)]), 0)


if __name__ == "__main__":
    unittest.main()
