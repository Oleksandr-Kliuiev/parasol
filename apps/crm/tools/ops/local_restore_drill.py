#!/usr/bin/env python3
"""Local rehearsal of runbook 03 (DEV-13): the restore procedure end to end, against a throwaway SQL Server container.

It never touches Azure or a shared database. It starts its own SQL Server container (crm-drill-<label>), the external API
mocks, crm-web and crm-worker from the current build, and walks the runbook with a clock:

  setup     a customer billed and its order sent to the PowerOffice mock; a second run approved while PowerOffice is paused
  R         the restore point: a full backup (the local stand-in for point-in-time restore)
  after R   the order of the second run leaves after R; a record is entered; then the harmful operation deletes customers
  T0..T9    decision, read-only maintenance, restore beside the live database, checks, switch (rename), restart and
            migrations, reconciliation (dry run, apply), back to normal, Finance confirms the held order

The protocol (UTC timestamps of every step, RPO, RTO, what was checked) is written as JSON and Markdown to --out. Local times
are not the cloud's: point-in-time restore and renames in Azure take longer, so this proves the order of the steps, the
application's behaviour and the tooling, not the RTO of production (EXT-04).

Usage: local_restore_drill.py --label NAME --out DIR [--keep]
Needs docker, node, and a built solution (dotnet build Vardahei.Crm.slnx). Ports: SQL 14337, web 5281, worker 5291, mocks 5399.
"""
from __future__ import annotations

import argparse
import datetime as dt
import http.cookiejar
import json
import os
import pathlib
import secrets
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[2]
WEB = "https://localhost:5281"
WORKER = "http://localhost:5291"
MOCK = "http://localhost:5399"
SQL_PORT = 14337
LIVE = "crm_drill"
CONTEXT = ssl._create_unverified_context()  # the ASP.NET Core development certificate


def utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(at: dt.datetime) -> str:
    return at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Failed(Exception):
    pass


class Protocol:
    def __init__(self, out: pathlib.Path) -> None:
        self.out = out
        self.steps: list[dict[str, Any]] = []
        self.marks: dict[str, dt.datetime] = {}
        self.checks: list[dict[str, Any]] = []

    def mark(self, name: str, note: str = "") -> dt.datetime:
        at = utc()
        self.marks[name] = at
        print(f"[{iso(at)}] {name} {note}", flush=True)
        self.steps.append({"mark": name, "at": iso(at), "note": note})
        return at

    def check(self, what: str, ok: bool, detail: Any = "") -> None:
        print(f"    {'OK ' if ok else 'BAD'} {what} {detail}", flush=True)
        self.checks.append({"check": what, "ok": ok, "detail": detail, "at": iso(utc())})
        if not ok:
            raise Failed(f"{what}: {detail}")

    def write(self, outcome: str, error: str | None = None) -> None:
        self.out.mkdir(parents=True, exist_ok=True)
        m = self.marks
        span = lambda a, b: round((m[b] - m[a]).total_seconds(), 1) if a in m and b in m else None
        summary = {
            "outcome": outcome,
            "error": error,
            "rpoSeconds": span("R", "damage"),
            "rtoSeconds": span("T0", "T9"),
            "restoreSeconds": span("T4", "T4done"),
            "switchSeconds": span("T6", "T6done"),
            "readOnlySeconds": span("T1", "T9"),
            "steps": self.steps,
            "checks": self.checks,
        }
        (self.out / "drill-protocol.json").write_text(json.dumps(summary, indent=2))
        lines = [
            "# Local restore drill (runbook 03, DEV-13)", "",
            f"Outcome: **{outcome}**" + (f" — {error}" if error else ""), "",
            f"- RPO (restore point → harmful operation): {summary['rpoSeconds']} s",
            f"- RTO (decision T0 → normal operation T9): {summary['rtoSeconds']} s",
            f"- Restore beside the live database: {summary['restoreSeconds']} s; switch with restart and migrations: {summary['switchSeconds']} s",
            f"- Read-only maintenance: {summary['readOnlySeconds']} s", "",
            "| Mark | UTC | Note |", "|---|---|---|",
        ] + [f"| {s['mark']} | {s['at']} | {s['note']} |" for s in self.steps] + [
            "", "| Check | Result | Detail |", "|---|---|---|",
        ] + [f"| {c['check']} | {'ok' if c['ok'] else 'FAILED'} | {str(c['detail']).replace('|', '/')[:200]} |" for c in self.checks]
        (self.out / "drill-protocol.md").write_text("\n".join(lines) + "\n")


class Browser:
    """A signed-in browser: cookies, the CSRF header on changes, JSON in and out."""

    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), urllib.request.HTTPSHandler(context=CONTEXT))
        no_redirect = type("NoRedirect", (urllib.request.HTTPRedirectHandler,), {"redirect_request": lambda *a, **k: None})
        self.raw = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), urllib.request.HTTPSHandler(context=CONTEXT), no_redirect)

    def call(self, method: str, path: str, body: Any = None, etag: str | None = None, follow: bool = True) -> tuple[int, dict[str, str], Any]:
        headers = {"Accept": "application/json"}
        if method != "GET":
            headers["X-CSRF"] = "1"
        if etag:
            headers["If-Match"] = etag
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(WEB + path, data=data, method=method, headers=headers)
        try:
            with (self.opener if follow else self.raw).open(request, timeout=120) as response:
                text = response.read().decode()
                return response.status, dict(response.headers), json.loads(text) if text and text.lstrip()[:1] in "[{" else text
        except urllib.error.HTTPError as error:
            text = error.read().decode()
            try:
                payload: Any = json.loads(text)
            except ValueError:
                payload = text
            return error.code, dict(error.headers), payload

    def ok(self, method: str, path: str, body: Any = None, etag: str | None = None, expect: tuple[int, ...] = (200, 201, 204)) -> Any:
        status, _, payload = self.call(method, path, body, etag)
        if status not in expect:
            raise Failed(f"{method} {path} → {status} {str(payload)[:300]}")
        return payload

    def sign_in(self, role: str) -> tuple[int, str]:
        status, headers, _ = self.call("GET", f"/bff/dev-login?role={role}&returnUrl=%2F", follow=False)
        return status, headers.get("Location", "")


class Drill:
    def __init__(self, label: str, out: pathlib.Path, keep: bool) -> None:
        self.label = label
        self.container = f"crm-drill-{label}"
        self.password = f"Drill-{secrets.token_hex(12)}aA1!"
        self.work = out / "work"
        self.documents = self.work / "documents"
        self.protocol = Protocol(out)
        self.keep = keep
        self.processes: dict[str, subprocess.Popen[bytes]] = {}
        self.logs = out / "logs"

    # ---------------------------------------------------------------- infrastructure
    def sql(self, query: str, database: str = "master") -> list[str]:
        result = subprocess.run(
            ["docker", "exec", self.container, "/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "localhost", "-U", "sa", "-P", self.password,
             "-d", database, "-b", "-h", "-1", "-W", "-Q", "SET NOCOUNT ON; " + query],
            capture_output=True, text=True)
        if result.returncode != 0:
            raise Failed(f"sql failed: {result.stdout.strip()[:300]} {result.stderr.strip()[:300]}")
        return [line for line in result.stdout.splitlines() if line.strip()]

    def scalar(self, query: str, database: str = LIVE) -> str:
        rows = self.sql(query, database)
        return rows[0].strip() if rows else ""

    def start_sql(self) -> None:
        subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
        subprocess.run(["docker", "run", "-d", "--name", self.container, "-e", "ACCEPT_EULA=Y", "-e", f"MSSQL_SA_PASSWORD={self.password}",
                        "-p", f"{SQL_PORT}:1433", "mcr.microsoft.com/mssql/server:2022-latest"], check=True, capture_output=True)
        for _ in range(90):
            try:
                self.sql("SELECT 1")
                return
            except Failed:
                time.sleep(2)
        raise Failed("SQL Server did not start")

    def host_args(self) -> list[str]:
        connection = f"Server=localhost,{SQL_PORT};Database={LIVE};User Id=sa;Password={self.password};TrustServerCertificate=True;Encrypt=True"
        return [
            f"--ConnectionStrings:crm={connection}",
            f"--Integrations:Brreg:BaseUrl={MOCK}/enhetsregisteret/api/",
            "--Integrations:PowerOffice:Enabled=true",
            f"--Integrations:PowerOffice:BaseUrl={MOCK}/v2/",
            f"--Integrations:PowerOffice:TokenUrl={MOCK}/OAuth/Token",
            "--Integrations:PowerOffice:WriteEnabled=true",
            "--RateLimits:ApiPerMinute=100000",
            "--Auth:ActiveUserCacheSeconds=0",
            f"--Documents:RootPath={self.documents}",
        ]

    def spawn(self, name: str, args: list[str], cwd: pathlib.Path, env: dict[str, str] | None = None) -> None:
        self.logs.mkdir(parents=True, exist_ok=True)
        log = open(self.logs / f"{name}.log", "ab")
        self.processes[name] = subprocess.Popen(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, **(env or {})})

    def stop(self, name: str) -> None:
        process = self.processes.pop(name, None)
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()

    def wait_for(self, url: str, seconds: int = 240) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url, context=CONTEXT, timeout=5) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            time.sleep(1)
        raise Failed(f"{url} did not answer")

    def start_apps(self, migrate: bool) -> None:
        dotnet = shutil.which("dotnet") or str(pathlib.Path.home() / ".dotnet" / "dotnet")
        env = {"ASPNETCORE_ENVIRONMENT": "Development", "DOTNET_ROOT": str(pathlib.Path.home() / ".dotnet")}
        web = ROOT / "src" / "Hosts" / "Crm.Web"
        worker = ROOT / "src" / "Hosts" / "Crm.Worker"
        self.spawn("web", [dotnet, str(web / "bin" / "Debug" / "net10.0" / "Crm.Web.dll"), "--urls", WEB,
                           f"--Database:MigrateOnStartup={'true' if migrate else 'false'}", *self.host_args()], web, env)
        self.wait_for(WEB + "/health/ready")
        self.spawn("worker", [dotnet, str(worker / "bin" / "Debug" / "net10.0" / "Crm.Worker.dll"), "--urls", WORKER,
                              "--Hangfire:PrepareSchema=true", *self.host_args(),
                              "--Integrations:PowerOffice:ApplicationKey=mock", "--Integrations:PowerOffice:ClientKey=mock",
                              "--Integrations:PowerOffice:SubscriptionKey=mock"], worker, env)
        self.wait_for(WORKER + "/health/live")

    def orders_posted(self) -> int:
        log = (self.logs / "mocks.log").read_text() if (self.logs / "mocks.log").exists() else ""
        return sum(1 for line in log.splitlines() if " POST /v2/SalesOrders" in line)

    def eventually(self, what: str, condition, seconds: int = 180) -> Any:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = condition()
            if value:
                return value
            time.sleep(2)
        raise Failed(f"timed out waiting for {what}")

    # ---------------------------------------------------------------- CRM helpers
    def run_command(self, browser: Browser, run_id: str, command: str) -> Any:
        status, headers, _ = browser.call("GET", f"/api/v1/billing/runs/{run_id}")
        if status != 200:
            raise Failed(f"run {run_id} → {status}")
        return browser.ok("POST", f"/api/v1/billing/runs/{run_id}/{command}", {}, headers.get("ETag"))

    def billed_customer(self, admin: Browser, finance: Browser, marker: str, year: int, month: int) -> tuple[str, str]:
        """A linked customer with one monthly line in that month, its run collected; returns (run id, basis id)."""
        start = f"{year}-{month:02d}-01"
        end = (dt.date(year + (month // 12), month % 12 + 1, 1) - dt.timedelta(days=1)).isoformat()
        number = self.org_number()
        organization = admin.ok("POST", "/api/v1/customers/organizations", {
            "name": f"{marker} Drift AS", "orgNumber": number, "legalForm": "AS", "status": "Customer", "email": "post@example.no",
            "ehfEnabled": False, "visitAddress": {"street": "Storgata 1", "postalCode": "0155", "city": "Oslo", "countryCode": "NO"},
            "domains": [],
        })
        admin.ok("POST", "/api/v1/integrations/links", {"system": "poweroffice", "externalType": "Customer",
                                                        "externalId": str(secrets.randbelow(80_000) + 10_000), "entityId": organization["id"], "entityType": "Organization"})
        product = admin.ok("POST", "/api/v1/catalog/products", {
            "sku": f"{marker}-MSP", "name": f"{marker} Managed services", "type": "ManagedService", "businessLine": "Atera", "unit": "Device",
            "billingPeriod": "Monthly", "vatRate": 25, "listPrice": 1500, "unitCost": 500})
        admin.ok("POST", "/api/v1/integrations/links", {"system": "poweroffice", "externalType": "Product",
                                                        "externalId": str(secrets.randbelow(80_000) + 10_000), "entityId": product["id"], "entityType": "Product"})
        contract = admin.ok("POST", "/api/v1/contracts", {
            "organizationId": organization["id"], "title": f"{marker} Avtale", "type": "Msp", "startDate": start, "endDate": end, "autoRenew": False,
            "renewalTermMonths": 0, "noticePeriodDays": 30, "invoiceFrequency": "Monthly", "invoiceTiming": "InAdvance", "indexation": False})
        admin.ok("POST", f"/api/v1/contracts/{contract['id']}/lines", {"productId": product["id"], "quantityModel": "Fixed", "quantity": 1, "unitPrice": 1500, "validFrom": start})
        admin.ok("POST", f"/api/v1/contracts/{contract['id']}/activate")
        run = finance.ok("POST", "/api/v1/billing/runs", {"year": year, "month": month, "notes": marker})
        self.run_command(finance, run["id"], "collect")
        bases = finance.ok("GET", f"/api/v1/billing/runs/{run['id']}/bases?search={marker}")
        basis = next(b for b in bases if b["organization"]["id"] == organization["id"])
        return run["id"], basis["id"]

    @staticmethod
    def org_number() -> str:
        weights = [3, 2, 7, 6, 5, 4, 3, 2]
        while True:
            digits = [8] + [secrets.randbelow(10) for _ in range(7)]
            check = 11 - sum(d * w for d, w in zip(digits, weights)) % 11
            check = 0 if check == 11 else check
            if check != 10:
                return "".join(map(str, digits)) + str(check)

    def basis(self, browser: Browser, basis_id: str) -> tuple[dict[str, Any], str]:
        status, headers, payload = browser.call("GET", f"/api/v1/billing/bases/{basis_id}")
        if status != 200:
            raise Failed(f"basis {basis_id} → {status}")
        return payload, headers.get("ETag", "")

    # ---------------------------------------------------------------- the drill
    def run(self) -> None:
        p = self.protocol
        p.mark("setup", f"container {self.container}, web {WEB}, worker {WORKER}, mocks {MOCK}")
        self.work.mkdir(parents=True, exist_ok=True)
        self.start_sql()
        self.sql(f"CREATE DATABASE [{LIVE}];")
        self.spawn("mocks", ["node", str(ROOT / "tools" / "dev-mocks" / "external-apis.mjs"), "5399"], ROOT, {"MOCK_LOG": "1"})
        self.wait_for(MOCK + "/health")
        self.start_apps(migrate=True)

        # Privileged actions need a confirmation of the roles younger than five minutes (ADR-019); the development sign-in is the
        # only one, so each phase signs in afresh — during maintenance too, which only operators may.
        def fresh(role: str) -> Browser:
            browser = Browser()
            status, location = browser.sign_in(role)
            if status not in (302, 303) or "maintenance" in location:
                raise Failed(f"sign-in as {role} → {status} {location}")
            return browser

        admin, finance = fresh("Crm.Admin"), fresh("Crm.Finance")

        # A customer billed and its order in PowerOffice before the restore point.
        marker = f"D{secrets.token_hex(3).upper()}"
        run1, basis1 = self.billed_customer(admin, finance, f"{marker}1", 2041, 3)
        self.run_command(finance, run1, "approve")
        first = self.eventually("the first order", lambda: (b := self.basis(finance, basis1)[0])["status"] == "Exported" and b)
        p.check("order 1 sent before the restore point", first["orderNo"] is not None, first["orderNo"])

        # Customers the harmful operation will delete; they exist at the restore point.
        victims = [admin.ok("POST", "/api/v1/customers/organizations", {
            "name": f"{marker} Offer {i} AS", "orgNumber": self.org_number(), "legalForm": "AS", "status": "Prospect", "email": "post@example.no",
            "ehfEnabled": False, "visitAddress": {"street": "Storgata 1", "postalCode": "0155", "city": "Oslo", "countryCode": "NO"}, "domains": []})["id"]
            for i in range(3)]

        # A second run approved while PowerOffice is paused: at the restore point its order waits in the queue.
        admin.ok("POST", "/api/v1/integrations/poweroffice/pause", {"paused": True, "reason": "Drill: hold the queue across the restore point"})
        run2, basis2 = self.billed_customer(admin, finance, f"{marker}2", 2041, 4)
        self.run_command(finance, run2, "approve")
        self.eventually("the queued order", lambda: self.scalar(
            f"SELECT COUNT(*) FROM integration.OutboundOperations WHERE EntityId = '{basis2}' AND Status = N'Pending'") == "1")

        r = p.mark("R", "restore point: full backup (local stand-in for point-in-time restore)")
        self.sql(f"BACKUP DATABASE [{LIVE}] TO DISK = N'/var/opt/mssql/data/drill-R.bak' WITH COPY_ONLY, INIT;")
        p.mark("R-backed-up")

        # After the restore point: the queued order leaves, someone enters a record, then the harmful operation.
        admin = fresh("Crm.Admin")
        admin.ok("POST", "/api/v1/integrations/poweroffice/pause", {"paused": False, "reason": None})
        second = self.eventually("the second order", lambda: (b := self.basis(finance, basis2)[0])["status"] == "Exported" and b, seconds=240)
        p.check("order 2 sent after the restore point", second["orderNo"] is not None, second["orderNo"])
        orders_before_restore = self.orders_posted()
        p.check("PowerOffice has received two orders", orders_before_restore == 2, orders_before_restore)
        late = admin.ok("POST", "/api/v1/customers/organizations", {
            "name": f"{marker} Etter punktet AS", "orgNumber": self.org_number(), "legalForm": "AS", "status": "Prospect", "email": "post@example.no",
            "ehfEnabled": False, "visitAddress": {"street": "Storgata 1", "postalCode": "0155", "city": "Oslo", "countryCode": "NO"}, "domains": []})
        admin = fresh("Crm.Admin")
        for victim in victims:
            status, headers, _ = admin.call("GET", f"/api/v1/customers/organizations/{victim}")
            admin.ok("DELETE", f"/api/v1/customers/organizations/{victim}", etag=headers.get("ETag"))
        p.mark("damage", f"harmful operation: {len(victims)} customers deleted")

        # ---- runbook 03 from here on
        p.mark("T0", "decision to restore")
        admin = fresh("Crm.Admin")
        on = admin.ok("PUT", "/api/v1/operations/maintenance", {"mode": "ReadOnly", "reason": "Drill: restoring the database (runbook 03)", "reference": "DRILL", "expectedKey": None})
        p.mark("T1", "read-only maintenance switched on")
        status, _, refused = finance.call("POST", "/api/v1/customers/organizations", {"name": "x"})
        p.check("a change is refused", status == 503 and refused.get("code") == "MAINTENANCE_READ_ONLY", status)
        status, _, listed = finance.call("GET", f"/api/v1/customers/organizations?search={marker}")
        p.check("reads go on", status == 200, status)
        status, location = Browser().sign_in("Crm.Sales")
        p.check("a non-operator sign-in waits", status in (302, 303) and "maintenance=signin" in location, location)
        status, location = Browser().sign_in("Crm.Finance")
        p.check("Finance waits too (no operations.maintenance)", status in (302, 303) and "maintenance=signin" in location, location)
        status, location = Browser().sign_in("Crm.Admin")
        p.check("an operator signs in during maintenance", status in (302, 303) and "maintenance" not in location, location)
        def quiet() -> bool:
            counts = admin.ok("GET", "/api/v1/operations/maintenance")["inFlight"]
            return all(c["count"] == 0 for c in counts)
        self.eventually("nothing under way", quiet, seconds=120)
        time.sleep(10)
        p.mark("T2", "nothing under way for 10 s")

        p.mark("T3", f"restore point chosen: {iso(r)}")
        target = f"{LIVE}_restore_{utc():%Y%m%d%H%M}"
        p.mark("T4", f"restore into {target}")
        files = self.sql("RESTORE FILELISTONLY FROM DISK = N'/var/opt/mssql/data/drill-R.bak';")
        logical = [line.split()[0] for line in files]
        self.sql(f"RESTORE DATABASE [{target}] FROM DISK = N'/var/opt/mssql/data/drill-R.bak' WITH "
                 f"MOVE N'{logical[0]}' TO N'/var/opt/mssql/data/{target}.mdf', MOVE N'{logical[1]}' TO N'/var/opt/mssql/data/{target}_log.ldf';")
        p.mark("T4done", "restored beside the live database")

        p.mark("T5", "checks of the copy")
        ids = ",".join(f"'{v}'" for v in victims)
        p.check("the deleted customers are in the copy", self.scalar(
            f"SELECT COUNT(*) FROM customers.Organizations WHERE Id IN ({ids}) AND IsDeleted = 0", target) == "3")
        p.check("the copy has the second basis waiting", self.scalar(f"SELECT Status FROM billing.BillingBases WHERE Id = '{basis2}'", target) == "Approved")
        p.check("the copy has its order queued", self.scalar(
            f"SELECT Status FROM integration.OutboundOperations WHERE EntityId = '{basis2}'", target) == "Pending")
        p.check("the record entered after the point is not in the copy", self.scalar(
            f"SELECT COUNT(*) FROM customers.Organizations WHERE Id = '{late['id']}'", target) == "0")
        p.check("the copy's protection triggers are enabled", self.scalar("SELECT COUNT(*) FROM sys.triggers WHERE is_disabled = 1", target) == "0")

        before = f"{LIVE}_before_{utc():%Y%m%d%H%M}"
        p.mark("T6", f"switch: {LIVE} → {before}, {target} → {LIVE}; restart; migrations")
        self.stop("worker")
        self.stop("web")
        self.sql(f"ALTER DATABASE [{LIVE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ALTER DATABASE [{LIVE}] MODIFY NAME = [{before}];"
                 f"ALTER DATABASE [{before}] SET MULTI_USER; ALTER DATABASE [{target}] MODIFY NAME = [{LIVE}];")
        self.start_apps(migrate=True)
        p.mark("T6done", "the copy is live, both apps restarted, migrations applied")
        status, _, _ = finance.call("POST", "/api/v1/customers/organizations", {"name": "x"})
        p.check("still read-only after the restart", status == 503, status)

        p.mark("T7", "reconciliation: dry run")
        admin = fresh("Crm.Admin")
        preview = admin.ok("POST", "/api/v1/operations/restore/reconcile", {"restorePoint": iso(r), "apply": False})
        lines = preview["reconciliation"]
        p.check("the dry run names the second order", any(l["area"] == "billing" and second["orderNo"] in l["finding"] for l in lines),
                [l["finding"][:120] for l in lines])
        p.check("the dry run names the queued operation", any(l["area"] == "integrations" and basis2 in l["subject"] for l in lines))
        p.check("the copy's pause of PowerOffice is reported", any("paused" in c["finding"] for c in preview["checks"]))
        p.check("the dry run changed nothing", self.basis(finance, basis2)[0]["status"] == "Approved")
        applied = admin.ok("POST", "/api/v1/operations/restore/reconcile", {"restorePoint": iso(r), "apply": True})
        p.mark("T7done", f"reconciliation applied: report {applied['id']}")
        p.check("the second basis waits for Finance", self.basis(finance, basis2)[0]["status"] == "ReconciliationRequired")
        p.check("its operation is held", self.scalar(f"SELECT Status FROM integration.OutboundOperations WHERE EntityId = '{basis2}'") == "Failed")

        p.mark("T8", "checks before normal operation")
        status, _, _ = Browser().call("GET", "/health/ready")
        p.check("the restored CRM is ready", status == 200, status)
        admin = fresh("Crm.Admin")
        key = admin.ok("GET", "/api/v1/operations/maintenance")["key"]
        admin.ok("PUT", "/api/v1/operations/maintenance", {"mode": "Normal", "reason": "Drill: restored and reconciled", "reference": "DRILL", "expectedKey": key})
        p.mark("T9", "normal operation")
        # Resuming the pause the copy brought back is a change too: only after normal operation (runbook 03 § 8, found by the drill).
        admin.ok("POST", "/api/v1/integrations/poweroffice/pause", {"paused": False, "reason": None})
        p.mark("T9a", "PowerOffice resumed in the restored copy")
        p.check("changes are accepted again", admin.call("POST", "/api/v1/customers/organizations", {
            "name": f"{marker} Ny etter AS", "orgNumber": self.org_number(), "legalForm": "AS", "status": "Prospect", "email": "post@example.no",
            "ehfEnabled": False, "visitAddress": {"street": "Storgata 1", "postalCode": "0155", "city": "Oslo", "countryCode": "NO"}, "domains": []})[0] == 201)

        # The worker runs the outbound queue every minute: two rounds later PowerOffice still has two orders.
        time.sleep(130)
        p.check("no second order for the restored basis", self.orders_posted() == 2, self.orders_posted())
        finance = fresh("Crm.Finance")
        held, etag = self.basis(finance, basis2)
        finance.ok("POST", f"/api/v1/billing/bases/{basis2}/reconcile",
                   {"created": True, "orderNo": second["orderNo"], "reason": "Drill: found in PowerOffice"}, etag)
        p.check("Finance confirms the order the journal named", self.basis(finance, basis2)[0]["status"] == "Exported")
        p.mark("done")

    def cleanup(self) -> None:
        for name in list(self.processes):
            self.stop(name)
        if not self.keep:
            subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
            shutil.rmtree(self.work, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--keep", action="store_true", help="keep the container and the work folder for inspection")
    args = parser.parse_args()
    drill = Drill(args.label, args.out, args.keep)
    try:
        drill.run()
        drill.protocol.write("passed")
        return 0
    except Exception as error:  # the protocol says where it stopped
        drill.protocol.write("failed", f"{type(error).__name__}: {error}")
        print(f"drill failed: {error}", file=sys.stderr)
        return 1
    finally:
        drill.cleanup()


if __name__ == "__main__":
    sys.exit(main())
