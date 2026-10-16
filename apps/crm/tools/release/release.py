#!/usr/bin/env python3
"""Release gates of Vardahei CRM (DEV-05, docs/adr/ADR-015-release-pipeline.md). Standard library only.

Every check fails closed: a scanner that did not run, a result it could not read, a digest that is not a digest or a
manifest that does not match the commit stops the release instead of passing as "nothing found".

  release.py vulnerable-dotnet REPORT.json [--min-projects N]   dotnet list package --vulnerable --format json
  release.py npm-audit REPORT.json                              npm audit --json (with dev dependencies)
  release.py scan-secrets PATH...                               refuses files that look like they carry a secret
  release.py schema-versions [--root DIR]                       newest migration of every module context, as JSON
  release.py manifest-create --sha SHA --repository OWNER/REPO --run-id ID --run-url URL --web IMAGE@DIGEST
                             --worker IMAGE@DIGEST --check NAME=RESULT... [--sbom FILE...] [--root DIR] --out FILE
  release.py manifest-verify MANIFEST --sha SHA                 the manifest is well-formed and belongs to the commit
  release.py deployment-record MANIFEST --environment ENV --web-image IMAGE --worker-image IMAGE [--migration-image IMAGE]
                               --smoke SMOKE.json [--web-revision NAME] [--worker-revision NAME] [--rollback] --out FILE
  release.py promotion-check --sha SHA --manifest MANIFEST --deployment DEPLOYMENT [--jobs JOBS.json]
                             [--required NAME,...] [--rollback]
  release.py schema-guard --target MANIFEST [--current MANIFEST] [--accept-break]
                          may the target release replace the one running in the environment (schema-breaks.json)?
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import sys

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^(?P<repository>[a-z0-9][a-z0-9.\-]*(?::[0-9]+)?/[a-z0-9][a-z0-9._\-/]*)@(?P<digest>sha256:[0-9a-f]{64})$")
MANIFEST_SCHEMA = "vardahei-crm/release-manifest/v1"
DEPLOYMENT_SCHEMA = "vardahei-crm/deployment/v1"
REQUIRED_CI_JOBS = ("backend", "frontend", "e2e", "infrastructure", "codeql")
BLOCKING_SEVERITIES = {"high", "critical"}

# Files in an artifact must never look like credentials. The patterns are deliberately broad; a false alarm is cheaper
# than a published secret.
SECRET_PATTERNS = [
    # A reference ($pw, {password}, %PW%) or a masked value (***) is not a secret.
    ("connection string password", re.compile(r"(?i)\b(password|pwd)\s*=\s*(?![$%{*])[^;\s\"']{3,}")),
    ("storage account key", re.compile(r"(?i)AccountKey\s*=\s*[A-Za-z0-9+/=]{20,}")),
    ("shared access signature", re.compile(r"(?i)[?&]sig=[A-Za-z0-9%+/=]{20,}")),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("bearer token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{20,}=*")),
    ("JSON web token", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("client secret", re.compile(r"(?i)client[_-]?secret\"?\s*[:=]\s*\"?[A-Za-z0-9~._\-]{16,}")),
]


class GateError(Exception):
    """A release gate refused: the message says why."""


def load_json(path: str | pathlib.Path) -> dict:
    try:
        text = pathlib.Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise GateError(f"{path}: cannot read ({error.strerror})") from error
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise GateError(f"{path}: not JSON ({error.msg} at line {error.lineno})") from error
    if not isinstance(value, dict):
        raise GateError(f"{path}: expected a JSON object")
    return value


# ---------------------------------------------------------------- scanners

def check_vulnerable_dotnet(report: dict, min_projects: int = 1) -> list[str]:
    """Returns the warnings; raises when the scan failed, was incomplete or found a High/Critical vulnerability."""
    if report.get("version") != 1:
        raise GateError(f"unknown report version {report.get('version')!r}")
    if not report.get("sources"):
        raise GateError("the scan names no vulnerability source: nothing was checked")
    problems = list(report.get("problems") or [])
    projects = report.get("projects")
    if not isinstance(projects, list) or len(projects) < min_projects:
        raise GateError(f"the scan covered {0 if not isinstance(projects, list) else len(projects)} projects, expected at least {min_projects}")
    blocking, warnings = [], []
    for project in projects:
        problems.extend(project.get("problems") or [])
        for framework in project.get("frameworks") or []:
            for kind in ("topLevelPackages", "transitivePackages"):
                for package in framework.get(kind) or []:
                    for vulnerability in package.get("vulnerabilities") or []:
                        severity = str(vulnerability.get("severity", "unknown")).lower()
                        line = f"{package.get('id')} {package.get('resolvedVersion')} ({severity}) in {pathlib.Path(project.get('path', '?')).name}: {vulnerability.get('advisoryurl', '')}"
                        # Only a severity known to be low passes with a warning; anything unreadable blocks.
                        (warnings if severity in {"low", "moderate"} else blocking).append(line)
    if problems:
        texts = "; ".join(str(p.get("text", p)) for p in problems)
        raise GateError(f"the scan reported problems, so its result is incomplete: {texts}")
    if blocking:
        raise GateError("High/Critical vulnerabilities: " + "; ".join(blocking))
    return warnings


def check_npm_audit(report: dict) -> list[str]:
    if "error" in report:
        error = report["error"]
        raise GateError(f"npm audit failed: {error.get('code', '')} {error.get('summary', error)}")
    if report.get("auditReportVersion") != 2:
        raise GateError(f"unknown npm audit report version {report.get('auditReportVersion')!r}")
    metadata = report.get("metadata") or {}
    counts = metadata.get("vulnerabilities")
    dependencies = (metadata.get("dependencies") or {}).get("total", 0)
    if not isinstance(counts, dict) or dependencies <= 0:
        raise GateError("npm audit checked no dependencies: nothing was audited")
    if (metadata.get("dependencies") or {}).get("dev", 0) <= 0:
        raise GateError("npm audit left out the build-time (dev) dependencies; run it without --omit=dev")
    blocking = {severity: counts.get(severity, 0) for severity in BLOCKING_SEVERITIES if counts.get(severity, 0)}
    if blocking:
        names = sorted(name for name, item in (report.get("vulnerabilities") or {}).items() if str(item.get("severity")).lower() in BLOCKING_SEVERITIES)
        raise GateError(f"npm audit found {blocking}: {', '.join(names)}")
    return [f"{severity}: {counts[severity]}" for severity in ("moderate", "low") if counts.get(severity)]


def scan_secrets(paths: list[str]) -> list[str]:
    findings = []
    files = []
    for path in paths:
        p = pathlib.Path(path)
        if p.is_dir():
            files.extend(sorted(f for f in p.rglob("*") if f.is_file()))
        elif p.is_file():
            files.append(p)
        else:
            raise GateError(f"{path}: does not exist, so it cannot be cleared for publication")
    for file in files:
        try:
            text = file.read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            raise GateError(f"{file}: cannot read ({error.strerror})") from error
        for number, line in enumerate(text.splitlines(), start=1):
            for name, pattern in SECRET_PATTERNS:
                if pattern.search(line):
                    findings.append(f"{file}:{number}: looks like a {name}")
    return findings


# ---------------------------------------------------------------- schema and manifest

def load_breaks(root: str | pathlib.Path = ".") -> list[dict]:
    registry = load_json(pathlib.Path(root, "tools", "release", "schema-breaks.json"))
    breaks = registry.get("breaks")
    if not isinstance(breaks, list):
        raise GateError("schema-breaks.json has no list of breaks")
    for entry in breaks:
        if not entry.get("context") or not re.match(r"^\d{14}_\w+$", str(entry.get("migration", ""))) or not entry.get("reason"):
            raise GateError(f"schema-breaks.json: incomplete entry {entry}")
    return breaks


def breaks_in(schema: dict[str, str], breaks: list[dict]) -> list[str]:
    """The breaks a schema contains: its newest migration of the context is the break's migration or later."""
    return sorted(f"{b['context']}/{b['migration']}" for b in breaks if schema.get(b["context"], "") >= b["migration"])


def schema_guard(target: dict, current: dict | None, accept_break: bool) -> list[str]:
    """
    Whether the target release may replace the one running in the environment. The schema only moves forward; a release
    without a break the environment already has cannot run there at all (a rollback below it is refused). A break the
    running release does not have fails that release between the migrations and the traffic switch, so deploying it
    needs an accepted maintenance window. Returns notes; raises when refused.
    """
    target_breaks = set(target.get("schemaBreaks") or [])
    if current is None:
        if target_breaks and not accept_break:
            raise GateError("the release running in the environment is unknown and this release contains schema breaks "
                            f"({', '.join(sorted(target_breaks))}): deploy it in an accepted maintenance window")
        return ["the release running in the environment is unknown"] + (["maintenance window accepted"] if target_breaks else [])
    current_breaks = set(current.get("schemaBreaks") or [])
    missing = sorted(current_breaks - target_breaks)
    if missing:
        raise GateError(f"{target.get('commit')} cannot run on the schema of {current.get('commit')}: it predates {', '.join(missing)} "
                        "(tools/release/schema-breaks.json). Going below a break needs the database administrator to revert that "
                        "migration first and a manual deployment (docs/runbooks/01-first-deployment.md).")
    new = sorted(target_breaks - current_breaks)
    if new and not accept_break:
        raise GateError(f"{current.get('commit')} does not survive {', '.join(new)} between the migrations and the traffic switch: "
                        "deploy in an accepted maintenance window (pause the worker and billing, accept_schema_break)")
    return [f"maintenance window accepted for {', '.join(new)}"] if new else []

def schema_versions(root: str | pathlib.Path = ".") -> dict[str, str]:
    """The newest migration of every module context (folder Persistence/Migrations of a module or integration)."""
    versions: dict[str, str] = {}
    folders = [f for f in pathlib.Path(root, "src").rglob("Migrations")
               if f.parent.name == "Persistence" and not {"bin", "obj"} & set(f.parts)]
    for folder in sorted(folders):
        project = folder.parent.parent.name
        names = sorted(f.stem for f in folder.glob("*.cs") if re.match(r"^\d{14}_", f.name) and not f.name.endswith(".Designer.cs"))
        if names:
            versions[project] = names[-1]
    if not versions:
        raise GateError(f"no migrations found under {root}/src: wrong root?")
    return versions


def parse_image(reference: str) -> dict:
    match = IMAGE_RE.match(reference)
    if not match:
        raise GateError(f"{reference!r} is not an image pinned by digest (registry/repository@sha256:<64 hex>)")
    return {"repository": match["repository"], "digest": match["digest"], "reference": reference}


def file_sha256(path: str | pathlib.Path) -> str:
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def create_manifest(*, sha: str, repository: str, run_id: str, run_url: str, web: str, worker: str,
                    checks: dict[str, str], sboms: list[str], root: str, now: dt.datetime | None = None) -> dict:
    if not SHA_RE.match(sha):
        raise GateError(f"{sha!r} is not a full commit SHA")
    missing = [job for job in REQUIRED_CI_JOBS if checks.get(job) != "success"]
    if missing:
        raise GateError(f"required CI jobs not successful: {', '.join(missing)}")
    web_image, worker_image = parse_image(web), parse_image(worker)
    return {
        "schema": MANIFEST_SCHEMA,
        "commit": sha,
        "repository": repository,
        "createdAt": (now or dt.datetime.now(dt.timezone.utc)).isoformat(timespec="seconds"),
        "provenance": {"workflowRun": run_id, "runUrl": run_url, "builtOnce": True},
        "images": {
            "web": web_image,
            "worker": worker_image,
            # The migrations run from the crm-web image (--migrate-only): the migrator is the same artifact.
            "migrator": dict(web_image),
        },
        "schemaVersions": (versions := schema_versions(root)),
        "schemaBreaks": breaks_in(versions, load_breaks(root)),
        "sbom": [{"file": pathlib.Path(f).name, "sha256": file_sha256(f)} for f in sboms],
        "checks": dict(sorted(checks.items())),
    }


def verify_manifest(manifest: dict, sha: str) -> None:
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise GateError(f"unknown manifest schema {manifest.get('schema')!r}")
    if not SHA_RE.match(sha or ""):
        raise GateError(f"{sha!r} is not a full commit SHA")
    if manifest.get("commit") != sha:
        raise GateError(f"the manifest is for commit {manifest.get('commit')}, not {sha}")
    images = manifest.get("images") or {}
    for role in ("web", "worker", "migrator"):
        image = images.get(role) or {}
        parsed = parse_image(image.get("reference", ""))
        if parsed["digest"] != image.get("digest") or parsed["repository"] != image.get("repository"):
            raise GateError(f"the {role} image entry contradicts its own reference")
    if images["migrator"]["digest"] != images["web"]["digest"]:
        raise GateError("the migrator must be the crm-web image of the release")
    missing = [job for job in REQUIRED_CI_JOBS if (manifest.get("checks") or {}).get(job) != "success"]
    if missing:
        raise GateError(f"the manifest records unsuccessful required jobs: {', '.join(missing)}")
    if not manifest.get("schemaVersions"):
        raise GateError("the manifest names no schema versions")
    if not isinstance(manifest.get("schemaBreaks"), list):
        raise GateError("the manifest does not say which schema breaks it contains")
    if not manifest.get("sbom"):
        raise GateError("the manifest carries no SBOM")


def deployment_record(manifest: dict, *, environment: str, web_image: str, worker_image: str, migration_image: str | None,
                      smoke: dict, web_revision: str | None, worker_revision: str | None, rollback: bool = False,
                      now: dt.datetime | None = None) -> dict:
    """What an environment runs after a deployment. A rollback runs no migrations: the schema stays as the newer release
    left it (expand/contract), so the migration job keeps that release's image and is not compared."""
    expected = manifest["images"]
    running = {"web": web_image, "worker": worker_image}
    if not rollback:
        if not migration_image:
            raise GateError("a deployment that ran migrations must say which image ran them")
        running["migrator"] = migration_image
    for role, reference in running.items():
        if parse_image(reference)["digest"] != expected[role]["digest"]:
            raise GateError(f"{environment} runs {role} {reference}, the release is {expected[role]['digest']}")
    if smoke.get("result") != "pass":
        raise GateError(f"the smoke test of {environment} did not pass: {smoke.get('failed') or smoke.get('result')}")
    return {
        "schema": DEPLOYMENT_SCHEMA,
        "environment": environment,
        "commit": manifest["commit"],
        "deployedAt": (now or dt.datetime.now(dt.timezone.utc)).isoformat(timespec="seconds"),
        "images": {role: parse_image(reference) for role, reference in running.items()},
        "revisions": {"web": web_revision, "worker": worker_revision},
        "rollback": rollback,
        "smoke": smoke,
    }


def promotion_check(*, sha: str, manifest: dict, deployment: dict, jobs: dict | None, required: list[str], rollback: bool) -> None:
    """A version goes to production only as the artifact that passed CI and test (AC01–AC03)."""
    verify_manifest(manifest, sha)
    if deployment.get("schema") != DEPLOYMENT_SCHEMA:
        raise GateError(f"unknown deployment record schema {deployment.get('schema')!r}")
    if deployment.get("commit") != sha:
        raise GateError(f"the deployment record is for {deployment.get('commit')}, not {sha}")
    if not rollback and deployment.get("environment") != "test":
        raise GateError("a release is promoted after its test deployment; the record is from " + str(deployment.get("environment")))
    if (deployment.get("smoke") or {}).get("result") != "pass":
        raise GateError("the recorded deployment did not pass its smoke test")
    for role in ("web", "worker") if rollback else ("web", "worker", "migrator"):
        deployed = ((deployment.get("images") or {}).get(role) or {}).get("digest")
        if deployed != manifest["images"][role]["digest"]:
            raise GateError(f"{role}: deployed {deployed}, manifest {manifest['images'][role]['digest']}")
    if jobs is not None:
        conclusions: dict[str, set[str]] = {}
        for job in jobs.get("jobs", []):
            name = str(job.get("name", ""))
            # A matrix or reusable workflow job is named "codeql (csharp)" or "release / publish".
            base = name.split(" (")[0]
            conclusions.setdefault(base, set()).add(str(job.get("conclusion")))
            conclusions.setdefault(name, set()).add(str(job.get("conclusion")))
        bad = [name for name in required if conclusions.get(name) != {"success"}]
        if bad:
            raise GateError(f"the CI run of {sha} has unsuccessful or missing required jobs: {', '.join(bad)}")


# ---------------------------------------------------------------- command line

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("vulnerable-dotnet")
    p.add_argument("report")
    p.add_argument("--min-projects", type=int, default=1)
    p = commands.add_parser("npm-audit")
    p.add_argument("report")
    p = commands.add_parser("scan-secrets")
    p.add_argument("paths", nargs="+")
    p = commands.add_parser("schema-versions")
    p.add_argument("--root", default=".")
    p = commands.add_parser("manifest-create")
    for name in ("--sha", "--repository", "--run-id", "--run-url", "--web", "--worker", "--out"):
        p.add_argument(name, required=True)
    p.add_argument("--check", action="append", default=[])
    p.add_argument("--sbom", action="append", default=[])
    p.add_argument("--root", default=".")
    p = commands.add_parser("manifest-verify")
    p.add_argument("manifest")
    p.add_argument("--sha", required=True)
    p = commands.add_parser("deployment-record")
    p.add_argument("manifest")
    for name in ("--environment", "--web-image", "--worker-image", "--smoke", "--out"):
        p.add_argument(name, required=True)
    p.add_argument("--migration-image")
    p.add_argument("--web-revision")
    p.add_argument("--worker-revision")
    p.add_argument("--rollback", action="store_true")
    p = commands.add_parser("promotion-check")
    for name in ("--sha", "--manifest", "--deployment"):
        p.add_argument(name, required=True)
    p.add_argument("--jobs")
    p.add_argument("--required", default=",".join(REQUIRED_CI_JOBS))
    p.add_argument("--rollback", action="store_true")
    p = commands.add_parser("schema-guard")
    p.add_argument("--target", required=True)
    p.add_argument("--current")
    p.add_argument("--accept-break", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.command == "vulnerable-dotnet":
            warnings = check_vulnerable_dotnet(load_json(args.report), args.min_projects)
            print(f"dotnet packages: no High/Critical vulnerability; {len(warnings)} lower: " + "; ".join(warnings))
        elif args.command == "npm-audit":
            warnings = check_npm_audit(load_json(args.report))
            print("npm (with build-time dependencies): no High/Critical vulnerability" + (f"; {', '.join(warnings)}" if warnings else ""))
        elif args.command == "scan-secrets":
            findings = scan_secrets(args.paths)
            if findings:
                raise GateError("possible secrets, not published:\n  " + "\n  ".join(findings))
            print(f"no secret patterns in {', '.join(args.paths)}")
        elif args.command == "schema-versions":
            print(json.dumps(schema_versions(args.root), indent=2, sort_keys=True))
        elif args.command == "manifest-create":
            checks = dict(item.split("=", 1) for item in args.check)
            manifest = create_manifest(sha=args.sha, repository=args.repository, run_id=args.run_id, run_url=args.run_url,
                                       web=args.web, worker=args.worker, checks=checks, sboms=args.sbom, root=args.root)
            pathlib.Path(args.out).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
            print(f"release manifest for {args.sha}: web {manifest['images']['web']['digest']}, worker {manifest['images']['worker']['digest']}")
        elif args.command == "manifest-verify":
            verify_manifest(load_json(args.manifest), args.sha)
            print(f"manifest verified for {args.sha}")
        elif args.command == "deployment-record":
            record = deployment_record(load_json(args.manifest), environment=args.environment, web_image=args.web_image,
                                       worker_image=args.worker_image, migration_image=args.migration_image,
                                       smoke=load_json(args.smoke), web_revision=args.web_revision, worker_revision=args.worker_revision,
                                       rollback=args.rollback)
            pathlib.Path(args.out).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
            print(f"{args.environment} runs the release {record['commit']}")
        elif args.command == "promotion-check":
            promotion_check(sha=args.sha, manifest=load_json(args.manifest), deployment=load_json(args.deployment),
                            jobs=load_json(args.jobs) if args.jobs else None,
                            required=[name for name in args.required.split(",") if name], rollback=args.rollback)
            print(f"{args.sha} may be {'rolled back to' if args.rollback else 'promoted'}: CI, manifest and the recorded deployment agree")
        elif args.command == "schema-guard":
            notes = schema_guard(load_json(args.target), load_json(args.current) if args.current else None, args.accept_break)
            print("schema compatible" + (f" ({'; '.join(notes)})" if notes else ""))
    except GateError as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
