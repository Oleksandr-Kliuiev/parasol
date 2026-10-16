#!/usr/bin/env python3
"""The Azure half of a database restore of Vardahei CRM (DEV-13, docs/runbooks/03-database-restore.md, ADR-021).

Nothing is chosen for the operator. The environment has to be named (--env test|prod, there is no default), one run performs
exactly one operation, and an operation that changes something only prints its commands unless --execute is given. The live
database is never deleted, and it is renamed only by `switch` (or `cutback`), with --execute and a confirmation that spells
out the environment, the server and the database. Resource names come from the outputs of the environment's latest
successful deployment — never from this file, so a renamed server or a new suffix cannot send a command to the wrong place.

Operations:
  discover                  the environment's resources, as its latest deployment reports them (reads only)
  points                    the restore window of the live database (reads only)
  restore --time T          restores the live database as it was at T into a NEW database crm-restore-<stamp>
  check --database NAME     facts about a database of the server, e.g. a restored copy (reads only)
  switch --database NAME    crm becomes crm-before-<stamp>, then NAME becomes crm
  cutback --database NAME   undoes a switch: crm becomes crm-failed-<stamp>, then NAME (the former live one) becomes crm
  restart                   restarts the active revisions of crm-web and crm-worker (new connections after a switch)
  worker-off / worker-on    deactivates / activates crm-worker's revisions; read-only maintenance normally keeps the worker
                            running (privacy replay, heartbeat), so this is for a worker that must not run at all

Each command that changes something is printed with its start time and duration, so the drill log has its timestamps.
Needs az (logged in with the rights of runbook 03). Prints no secret: it handles none.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from typing import Any

LIVE = "crm"
REQUIRED_OUTPUTS = ("sqlServerName", "sqlDatabaseName", "webAppName", "workerAppName", "migrationJobName", "storageAccountName")
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")


class Refused(Exception):
    """A precondition does not hold: nothing was changed."""


def utc_now() -> dt.datetime:
    fixed = os.environ.get("RESTORE_NOW")  # tests only: a fixed clock
    return dt.datetime.fromisoformat(fixed.replace("Z", "+00:00")) if fixed else dt.datetime.now(dt.timezone.utc)


def stamp(at: dt.datetime) -> str:
    return at.strftime("%Y%m%d%H%M")


def iso(at: dt.datetime) -> str:
    return at.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(value: str) -> dt.datetime:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z", value):
        raise Refused(f"{value!r} is not a UTC time like 2026-10-04T06:30:00Z")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


class Azure:
    """Runs az. Reads always run; changes run only with --execute, otherwise they are printed as the dry run."""

    def __init__(self, execute: bool) -> None:
        self.az = os.environ.get("AZ", "az")
        self.execute = execute

    def read(self, *args: str) -> Any:
        result = subprocess.run([self.az, *args, "-o", "json"], capture_output=True, text=True)
        if result.returncode != 0:
            raise Refused(f"az {' '.join(args[:3])} failed: {result.stderr.strip()[:300]}")
        return json.loads(result.stdout) if result.stdout.strip() else None

    def exists(self, *args: str) -> bool:
        return subprocess.run([self.az, *args, "-o", "none"], capture_output=True, text=True).returncode == 0

    def change(self, *args: str) -> bool:
        line = "az " + " ".join(args)
        if not self.execute:
            print(f"DRY RUN  {line}")
            return False
        started = utc_now()
        print(f"[{iso(started)}] {line}", flush=True)
        clock = time.monotonic()
        result = subprocess.run([self.az, *args, "-o", "none"], capture_output=True, text=True)
        took = time.monotonic() - clock
        if result.returncode != 0:
            print(f"[{iso(utc_now())}] FAILED after {took:.1f} s: {result.stderr.strip()[:300]}", flush=True)
            raise subprocess.CalledProcessError(result.returncode, line)
        print(f"[{iso(utc_now())}] done in {took:.1f} s", flush=True)
        return True


def discover(azure: Azure, environment: str, deployment: str | None) -> dict[str, str]:
    group = f"rg-crm-{environment}"
    if deployment is None:
        deployments = azure.read(
            "deployment", "group", "list", "-g", group,
            "--query", f"[?starts_with(name, 'crm-{environment}-') && properties.provisioningState=='Succeeded']"
                       ".{name:name, at:properties.timestamp}") or []
        if not deployments:
            raise Refused(f"{group} has no successful deployment named crm-{environment}-…: deploy first (runbook 01)")
        deployment = max(deployments, key=lambda d: d["at"])["name"]
    outputs = azure.read("deployment", "group", "show", "-g", group, "-n", deployment, "--query", "properties.outputs") or {}
    missing = [name for name in REQUIRED_OUTPUTS if name not in outputs]
    if missing:
        raise Refused(f"deployment {deployment} has no output {', '.join(missing)}: deploy a release with DEV-13 first (runbook 03 §0)")
    names = {name: str(value["value"]) for name, value in outputs.items() if isinstance(value, dict) and "value" in value}
    names["resourceGroup"] = group
    names["deployment"] = deployment
    if names["sqlDatabaseName"] != LIVE:
        raise Refused(f"the live database is {names['sqlDatabaseName']!r}, not {LIVE!r}: this tool and runbook 03 do not fit this deployment")
    return names


def database(azure: Azure, names: dict[str, str], name: str) -> dict[str, Any] | None:
    if not azure.exists("sql", "db", "show", "-g", names["resourceGroup"], "-s", names["sqlServerName"], "-n", name):
        return None
    return azure.read(
        "sql", "db", "show", "-g", names["resourceGroup"], "-s", names["sqlServerName"], "-n", name,
        "--query", "{name:name, status:status, objective:currentServiceObjectiveName, earliest:earliestRestoreDate, created:creationDate}")


def check_name(value: str) -> str:
    if not NAME.match(value):
        raise Refused(f"{value!r} is not a database name")
    return value


def confirmation(environment: str, names: dict[str, str], name: str) -> str:
    return f"{environment}/{names['sqlServerName']}/{name}"


def rename_pair(azure: Azure, names: dict[str, str], moved_to: str, incoming: str) -> None:
    """crm → moved_to, then incoming → crm; if the second step fails, the first is undone so the CRM has its database back."""
    group, server = names["resourceGroup"], names["sqlServerName"]
    azure.change("sql", "db", "rename", "-g", group, "-s", server, "-n", LIVE, "--new-name", moved_to)
    try:
        azure.change("sql", "db", "rename", "-g", group, "-s", server, "-n", incoming, "--new-name", LIVE)
    except subprocess.CalledProcessError:
        print(f"Putting {moved_to} back as {LIVE}: the second rename failed.", flush=True)
        azure.change("sql", "db", "rename", "-g", group, "-s", server, "-n", moved_to, "--new-name", LIVE)
        raise


def active_revisions(azure: Azure, names: dict[str, str], app: str) -> list[str]:
    return azure.read("containerapp", "revision", "list", "-g", names["resourceGroup"], "-n", app,
                      "--query", "[?properties.active].name") or []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env", required=True, choices=["test", "prod"], help="the environment; there is no default")
    parser.add_argument("operation", choices=["discover", "points", "restore", "check", "switch", "cutback", "restart", "worker-off", "worker-on"])
    parser.add_argument("--deployment", help="read the names from this deployment instead of the latest successful one")
    parser.add_argument("--time", help="restore: the restore point in UTC, e.g. 2026-10-04T06:30:00Z")
    parser.add_argument("--database", help="check, switch, cutback: the database to act on")
    parser.add_argument("--execute", action="store_true", help="carry out the changes; without it they are only printed")
    parser.add_argument("--confirm", help="switch, cutback: <env>/<server>/<database>, exactly")
    args = parser.parse_args(argv)
    azure = Azure(args.execute)

    try:
        names = discover(azure, args.env, args.deployment)
        group, server = names["resourceGroup"], names["sqlServerName"]
        now = utc_now()

        if args.operation == "discover":
            print(json.dumps(names, indent=2, sort_keys=True))
            return 0

        if args.operation == "points":
            live = database(azure, names, LIVE) or {}
            print(json.dumps({"database": f"{server}/{LIVE}", "earliestRestorePoint": live.get("earliest"),
                              "status": live.get("status"), "now": iso(now)}, indent=2))
            return 0

        if args.operation == "check":
            name = check_name(args.database or "")
            found = database(azure, names, name)
            if found is None:
                raise Refused(f"{server} has no database {name}")
            print(json.dumps(found, indent=2, sort_keys=True))
            return 0

        if args.operation == "restore":
            if not args.time:
                raise Refused("restore needs --time, the restore point in UTC")
            point = parse_utc(args.time)
            live = database(azure, names, LIVE)
            if live is None:
                raise Refused(f"{server} has no database {LIVE} to restore from")
            earliest = dt.datetime.fromisoformat(str(live["earliest"]).replace("Z", "+00:00"))
            if point > now or point < earliest:
                raise Refused(f"the restore point must lie between {iso(earliest)} and now ({iso(now)})")
            target = f"crm-restore-{stamp(now)}"
            if database(azure, names, target) is not None:
                raise Refused(f"{target} already exists on {server}: wait a minute and run again")
            # Always beside the live database, never over it: the live one stays untouched until a switch.
            azure.change("sql", "db", "restore", "-g", group, "-s", server, "-n", LIVE, "--dest-name", target, "--time", iso(point))
            print(f"restore point {iso(point)} → {server}/{target}")
            return 0

        if args.operation in ("switch", "cutback"):
            incoming = check_name(args.database or "")
            if incoming == LIVE:
                raise Refused(f"--database names the database that becomes {LIVE}; it cannot be {LIVE} itself")
            moved_to = f"crm-before-{stamp(now)}" if args.operation == "switch" else f"crm-failed-{stamp(now)}"
            found = database(azure, names, incoming)
            if found is None or found.get("status") != "Online":
                raise Refused(f"{incoming} is not an online database of {server}")
            if database(azure, names, LIVE) is None:
                raise Refused(f"{server} has no database {LIVE}")
            if database(azure, names, moved_to) is not None:
                raise Refused(f"{moved_to} already exists on {server}")
            expected = confirmation(args.env, names, incoming)
            if args.execute and args.confirm != expected:
                raise Refused(f"--confirm must be exactly {expected!r}: nothing was renamed")
            rename_pair(azure, names, moved_to, incoming)
            print(f"{LIVE} → {moved_to}; {incoming} → {LIVE}" + ("" if args.execute else f" (dry run; to carry it out add --execute --confirm {expected})"))
            return 0

        if args.operation == "restart":
            for app in (names["webAppName"], names["workerAppName"]):
                for revision in active_revisions(azure, names, app):
                    azure.change("containerapp", "revision", "restart", "-g", group, "-n", app, "--revision", revision)
            return 0

        if args.operation == "worker-off":
            for revision in active_revisions(azure, names, names["workerAppName"]):
                azure.change("containerapp", "revision", "deactivate", "-g", group, "-n", names["workerAppName"], "--revision", revision)
            return 0

        if args.operation == "worker-on":
            latest = azure.read("containerapp", "show", "-g", group, "-n", names["workerAppName"], "--query", "properties.latestRevisionName")
            azure.change("containerapp", "revision", "activate", "-g", group, "-n", names["workerAppName"], "--revision", str(latest))
            return 0
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        return 3
    except subprocess.CalledProcessError as failed:
        print(f"failed: {failed.cmd}", file=sys.stderr)
        return 4
    return 2


if __name__ == "__main__":
    sys.exit(main())
