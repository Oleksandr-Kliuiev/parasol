"""Control flow of tools/release/deploy.sh against a stand-in az and a stand-in crm-web (DEV-05-AC04).

`az` is replaced by a script that answers from a scenario and logs every call; the deployed app is a local HTTP server
that answers the smoke test like crm-web does (or fails it). Nothing reaches Azure.
"""
from __future__ import annotations

import http.server
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SHA = "0123456789abcdef0123456789abcdef01234567"
REGISTRY = "crcrmtest1234.azurecr.io"
WEB_DIGEST = "sha256:" + "a" * 64
WORKER_DIGEST = "sha256:" + "b" * 64
WEB = f"{REGISTRY}/crm-web@{WEB_DIGEST}"
WORKER = f"{REGISTRY}/crm-worker@{WORKER_DIGEST}"

FAKE_AZ = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
scenario = json.load(open(os.environ["AZ_SCENARIO"]))
with open(os.environ["AZ_LOG"], "a") as log:
    log.write(" ".join(args) + "\n")
line = " ".join(args)
def answer(value):
    print(value)
    sys.exit(0)
if args[:2] == ["acr", "list"]: answer(scenario["registry"])
if args[:3] == ["acr", "repository", "show"]:
    image = args[args.index("--image") + 1]
    answer(scenario["registryDigests"].get(image.split("@")[0], ""))
if args[:2] == ["identity", "show"]: answer("11111111-2222-3333-4444-555555555555")
if args[:3] == ["containerapp", "job", "update"]: answer("")
if args[:3] == ["containerapp", "job", "start"]: answer("migration-execution-1")
if args[:4] == ["containerapp", "job", "execution", "show"]: answer(scenario["migration"])
if args[:3] == ["containerapp", "job", "show"]: answer(scenario["migrationImage"])
if args[:3] == ["containerapp", "revision", "list"]: answer(scenario["stable"])
if args[:2] == ["deployment", "group"]: answer(json.dumps({"webUrl": {"value": scenario["publicUrl"]}, "webCandidateUrl": {"value": scenario["candidateUrl"]}}))
if args[:2] == ["containerapp", "show"]:
    app = args[args.index("-n") + 1]
    answer(scenario["latest"][app])
if args[:3] == ["containerapp", "revision", "show"]:
    app = args[args.index("-n") + 1]
    if "runningState" in line: answer("Running")
    if "healthState" in line: answer(scenario.get("workerHealth", "Healthy"))
    answer(scenario["running"][app])
if args[:4] == ["containerapp", "ingress", "traffic", "set"]: answer("")
print("unexpected az call: " + line, file=sys.stderr)
sys.exit(3)
'''


class CrmStandIn(http.server.BaseHTTPRequestHandler):
    """Answers the smoke test the way crm-web does; a server built with broken=True answers 500 to everything."""
    broken = False

    def log_message(self, *args):
        pass

    def reply(self, status, body=b"", headers=None):
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.broken:
            return self.reply(500)
        path = self.path.split("?")[0]
        if path in ("/health/live", "/health/ready"):
            return self.reply(200, b"Healthy")
        if path == "/":
            return self.reply(200, b'<div id="root"></div><script type="module" src="/assets/index-Ab12Cd.js"></script>',
                              {"Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'", "X-Content-Type-Options": "nosniff"})
        if path == "/assets/index-Ab12Cd.js":
            return self.reply(200, b"export {}", {"Content-Type": "text/javascript"})
        return self.reply(401)

    def do_POST(self):
        if self.broken:
            return self.reply(500)
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        return self.reply(401 if self.headers.get("X-CSRF") == "1" else 403)


def serve(broken: bool):
    handler = type("Handler", (CrmStandIn,), {"broken": broken})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class DeployScript(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.good = serve(broken=False)
        cls.bad = serve(broken=True)

    @classmethod
    def tearDownClass(cls):
        cls.good.shutdown()
        cls.bad.shutdown()

    def url(self, server):
        return f"http://127.0.0.1:{server.server_address[1]}"

    def run_deploy(self, rollback=False, **overrides):
        folder = pathlib.Path(tempfile.mkdtemp())
        bin_dir = folder / "bin"
        bin_dir.mkdir()
        az = bin_dir / "az"
        az.write_text(FAKE_AZ)
        az.chmod(az.stat().st_mode | stat.S_IEXEC)
        scenario = {
            "registry": REGISTRY,
            "registryDigests": {"crm-web": WEB_DIGEST, "crm-worker": WORKER_DIGEST},
            "migration": "Succeeded",
            "migrationImage": WEB,
            "stable": "ca-crm-web-test--old",
            "latest": {"ca-crm-web-test": "ca-crm-web-test--new", "ca-crm-worker-test": "ca-crm-worker-test--new"},
            "running": {"ca-crm-web-test": WEB, "ca-crm-worker-test": WORKER},
            "publicUrl": self.url(self.good),
            "candidateUrl": self.url(self.good),
        }
        scenario.update(overrides)
        (folder / "scenario.json").write_text(json.dumps(scenario))
        manifest = {
            "schema": "vardahei-crm/release-manifest/v1", "commit": SHA,
            "images": {"web": {"repository": f"{REGISTRY}/crm-web", "digest": WEB_DIGEST, "reference": WEB},
                       "worker": {"repository": f"{REGISTRY}/crm-worker", "digest": WORKER_DIGEST, "reference": WORKER},
                       "migrator": {"repository": f"{REGISTRY}/crm-web", "digest": WEB_DIGEST, "reference": WEB}},
        }
        (folder / "manifest.json").write_text(json.dumps(manifest))
        env = dict(os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", AZ_SCENARIO=str(folder / "scenario.json"),
                   AZ_LOG=str(folder / "az.log"), DEPLOY_POLL_SECONDS="0")
        env.pop("CRM_ENTRA_CLIENT_ID_TEST", None)
        command = ["bash", str(HERE / "deploy.sh"), "test", str(folder / "manifest.json"), str(folder / "out")]
        if rollback:
            command.append("--rollback")
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
        log = (folder / "az.log").read_text() if (folder / "az.log").exists() else ""
        return result, log, folder / "out"

    def test_a_failed_migration_changes_no_revision_and_no_traffic(self):
        result, log, _ = self.run_deploy(migration="Failed")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("the migration failed: no revision and no traffic was changed", result.stderr)
        self.assertIn("containerapp job start", log)
        self.assertNotIn("deployment group create", log)
        self.assertNotIn("ingress traffic set", log)

    def test_a_candidate_that_fails_its_smoke_test_gets_no_traffic(self):
        result, log, out = self.run_deploy(candidateUrl=self.url(self.bad))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("deployment group create", log)
        self.assertNotIn("ingress traffic set", log)
        self.assertEqual(json.loads((out / "smoke-candidate.json").read_text())["result"], "fail")

    def test_a_container_that_runs_another_digest_stops_the_deployment_before_traffic(self):
        other = f"{REGISTRY}/crm-web@sha256:" + "c" * 64
        result, log, _ = self.run_deploy(running={"ca-crm-web-test": other, "ca-crm-worker-test": WORKER})
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("the release is", result.stderr)
        self.assertNotIn("ingress traffic set", log)

    def test_a_digest_missing_from_the_registry_stops_before_anything_changes(self):
        result, log, _ = self.run_deploy(registryDigests={"crm-web": WEB_DIGEST, "crm-worker": ""})
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn("containerapp job", log)
        self.assertNotIn("deployment group create", log)

    def test_the_release_gets_traffic_after_its_smoke_tests_and_is_recorded(self):
        result, log, out = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = log.splitlines()
        order = [next(i for i, c in enumerate(calls) if c.startswith(prefix)) for prefix in
                 ("containerapp job update", "containerapp job start", "deployment group create", "containerapp ingress traffic set")]
        self.assertEqual(order, sorted(order))
        self.assertIn("--revision-weight ca-crm-web-test--new=100", log)
        self.assertIn(f"--image {WEB} --args --migrate-only", log)
        record = json.loads((out / "deployment-test.json").read_text())
        self.assertEqual(record["images"]["web"]["digest"], WEB_DIGEST)
        self.assertEqual(record["images"]["migrator"]["digest"], WEB_DIGEST)
        self.assertEqual(record["smoke"]["result"], "pass")
        self.assertFalse(record["rollback"])

    def test_a_failed_public_smoke_test_moves_the_traffic_back(self):
        result, log, _ = self.run_deploy(publicUrl=self.url(self.bad))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        switches = [c for c in log.splitlines() if c.startswith("containerapp ingress traffic set")]
        self.assertEqual(len(switches), 2)
        self.assertIn("ca-crm-web-test--new=100", switches[0])
        self.assertIn("ca-crm-web-test--old=100", switches[1])

    def test_a_worker_revision_that_never_gets_ready_stops_the_deployment_before_traffic(self):
        # DEV-06: the worker's readiness is the database; a revision that cannot reach it is not taken into service.
        result, log, _ = self.run_deploy(workerHealth="Unhealthy")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("health Unhealthy", result.stderr)
        self.assertNotIn("ingress traffic set", log)

    def test_a_rollback_runs_no_migrations_and_says_so_in_the_record(self):
        newer = f"{REGISTRY}/crm-web@sha256:" + "d" * 64
        result, log, out = self.run_deploy(rollback=True, migrationImage=newer)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("containerapp job update", log)
        self.assertNotIn("containerapp job start", log)
        record = json.loads((out / "deployment-test.json").read_text())
        self.assertTrue(record["rollback"])
        self.assertNotIn("migrator", record["images"])


if __name__ == "__main__":
    unittest.main()
