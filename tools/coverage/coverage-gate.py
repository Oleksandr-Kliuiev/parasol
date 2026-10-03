#!/usr/bin/env python3
"""Coverage gate for NFR-10 over Cobertura reports from Microsoft.Testing.Extensions.CodeCoverage.

Merges any number of reports (a line counts as covered when any report hit it), sorts every coverable line of src/ into
one scope and fails when a scope is below its threshold:

  critical  domain logic of billing, tariffs and contracts — src/Modules/{Billing,Contracts,TimeTracking}/*/Domain/  >= 90 %
  backend   every other line under src/                                                                            >= 70 %
  excluded  EF migrations and model snapshots, *.Designer.cs, generated sources under obj/, the local Aspire AppHost

The denominator (coverable lines) and the exclusions are printed with the result, so a percentage never stands alone.
A collector only reports assemblies a test loaded, so every production project under src/ missing from all reports is
named, and fails the gate unless it is allowed with --allow-unmeasured and a reason in the CI configuration.
Branch coverage is reported for information only: Cobertura gives per-line condition counts, which cannot be merged
exactly across reports, so the merged value is the best per-line value and is not gated.

Usage: coverage-gate.py [--root DIR] [--critical 90] [--backend 70] [--allow-unmeasured PROJECT ...] [--summary FILE]
                        REPORT [REPORT ...]
Exit code: 0 when every scope meets its threshold and nothing is unmeasured, 1 otherwise, 2 when reports cannot be read.
"""

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

CRITICAL = re.compile(r'^src/Modules/(Billing|Contracts|TimeTracking)/Crm\.(Billing|Contracts|TimeTracking)/Domain/')
EXCLUDED = [
    (re.compile(r'/Persistence/Migrations/'), 'EF Core migrations and model snapshots (generated)'),
    (re.compile(r'\.Designer\.cs$'), 'designer files (generated)'),
    (re.compile(r'(^|/)obj/'), 'sources generated at build time'),
    (re.compile(r'^src/Hosts/Crm\.AppHost/'), 'local Aspire orchestrator, not deployed'),
]
CONDITION = re.compile(r'\((\d+)/(\d+)\)')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('reports', nargs='+', type=Path)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--critical', type=float, default=90.0, help='minimum line coverage of the critical domain, %%')
    parser.add_argument('--backend', type=float, default=70.0, help='minimum line coverage of the rest of the backend, %%')
    parser.add_argument('--allow-unmeasured', action='append', default=[], metavar='PROJECT',
                        help='production project that no test loads and that may stay out of the denominator')
    parser.add_argument('--summary', type=Path, help='also write the Markdown summary to this file')
    args = parser.parse_args()
    root = args.root.resolve()
    production = sorted(
        path.stem for path in (root / 'src').rglob('*.csproj')
        if not {'bin', 'obj'} & set(path.parts) and not any(pattern.search(path.relative_to(root).as_posix()) for pattern, _ in EXCLUDED))

    hits = {}            # (file, line) -> max hits over all reports
    branches = {}        # (file, line) -> (covered, total), best per line
    assembly_of = {}     # file -> assembly (Cobertura package)
    for report in args.reports:
        try:
            tree = ET.parse(report)
        except (OSError, ET.ParseError) as error:
            print(f'Cannot read {report}: {error}', file=sys.stderr)
            return 2
        for package in tree.getroot().iter('package'):
            for cls in package.iter('class'):
                path = relative(cls.get('filename', ''), root)
                assembly_of.setdefault(path, package.get('name', '?'))
                for line in cls.iter('line'):
                    key = (path, int(line.get('number')))
                    hits[key] = max(hits.get(key, 0), int(line.get('hits', '0')))
                    match = CONDITION.search(line.get('condition-coverage') or '')
                    if line.get('branch') == 'True' and match:
                        covered, total = int(match.group(1)), int(match.group(2))
                        best = branches.get(key, (0, total))
                        branches[key] = max(best, (covered, total), key=lambda value: value[0] / value[1] if value[1] else 0)

    if not hits:
        print('The reports contain no coverable lines.', file=sys.stderr)
        return 2

    scopes = {'critical': [0, 0], 'backend': [0, 0]}
    excluded = defaultdict(int)
    by_assembly = defaultdict(lambda: [0, 0])
    critical_files = defaultdict(lambda: [0, 0])
    scope_branches = {'critical': [0, 0], 'backend': [0, 0]}
    for (path, number), count in hits.items():
        reason = next((why for pattern, why in EXCLUDED if pattern.search(path)), None)
        if reason or not path.startswith('src/'):
            excluded[reason or 'outside src/'] += 1
            continue
        scope = 'critical' if CRITICAL.search(path) else 'backend'
        covered = 1 if count > 0 else 0
        scopes[scope][0] += covered
        scopes[scope][1] += 1
        by_assembly[assembly_of[path]][0] += covered
        by_assembly[assembly_of[path]][1] += 1
        if scope == 'critical':
            critical_files[path][0] += covered
            critical_files[path][1] += 1
        if (path, number) in branches:
            scope_branches[scope][0] += branches[(path, number)][0]
            scope_branches[scope][1] += branches[(path, number)][1]

    thresholds = {'critical': args.critical, 'backend': args.backend}
    failed = [scope for scope, (covered, total) in scopes.items() if total == 0 or percent(covered, total) < thresholds[scope]]
    measured = set(assembly_of.values())
    unmeasured = [project for project in production if project not in measured]
    unexplained = [project for project in unmeasured if project not in args.allow_unmeasured]
    problems = [f'{scope} below {thresholds[scope]:.0f} %' for scope in failed]
    if unexplained:
        problems.append('not measured: ' + ', '.join(unexplained))

    lines = [
        '## Coverage (NFR-10)',
        '',
        f'Reports: {", ".join(report.name for report in args.reports)}',
        '',
        '| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |',
        '|---|---:|---:|---:|---:|---|---:|',
    ]
    labels = {'critical': 'Domain of Billing, Contracts, TimeTracking', 'backend': 'Rest of the backend (src/)'}
    for scope, (covered, total) in scopes.items():
        branch_covered, branch_total = scope_branches[scope]
        lines.append(
            f'| {labels[scope]} | {covered} | {total} | {percent(covered, total):.2f} % | {thresholds[scope]:.0f} % | '
            f'{"fail" if scope in failed else "pass"} | {percent(branch_covered, branch_total):.2f} % of {branch_total} |')
    lines += ['', 'Excluded from the denominator:', '']
    lines += [f'- {reason}: {count} lines' for reason, count in sorted(excluded.items())]
    for project in unmeasured:
        allowed = 'allowed by --allow-unmeasured' if project in args.allow_unmeasured else 'NOT allowed'
        lines.append(f'- {project}: no test loads it, so its lines are not measured ({allowed})')
    lines += ['', '### Critical domain by file', '', '| File | Covered | Coverable | Line coverage |', '|---|---:|---:|---:|']
    for path, (covered, total) in sorted(critical_files.items()):
        lines.append(f'| {path} | {covered} | {total} | {percent(covered, total):.2f} % |')
    lines += ['', '### Backend by assembly', '', '| Assembly | Covered | Coverable | Line coverage |', '|---|---:|---:|---:|']
    for assembly, (covered, total) in sorted(by_assembly.items()):
        lines.append(f'| {assembly} | {covered} | {total} | {percent(covered, total):.2f} % |')
    lines += ['', f'Gate: **{"FAILED — " + "; ".join(problems) if problems else "passed"}**', '']

    text = '\n'.join(lines)
    print(text)
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        with args.summary.open('a', encoding='utf-8') as stream:
            stream.write(text + '\n')
    return 1 if problems else 0


def relative(filename, root):
    path = Path(filename)
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        # Reports from another machine (CI runner) still carry the repository layout below src/.
        posix = path.as_posix()
        index = posix.find('/src/')
        return posix[index + 1:] if index >= 0 else posix


def percent(covered, total):
    return 100.0 * covered / total if total else 0.0


if __name__ == '__main__':
    sys.exit(main())
