#!/usr/bin/env python3
"""Validate the handoff's structure and declared state; never execute product work."""

import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--next', action='store_true', help='Show locally eligible tasks')
    parser.add_argument('--release', action='store_true', help='Require all tasks/gates accepted')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    def unique(items, label):
        for item, count in Counter(items).items():
            require(count == 1, f'{label}: duplicate {item}')

    try:
        backlog = json.loads((root / 'backlog.json').read_text())
        external = json.loads((root / 'external-gates.json').read_text())
        with (root / 'acceptance.csv').open(newline='') as stream:
            rows = list(csv.DictReader(stream))
    except (OSError, ValueError) as exc:
        print(f'ERROR: cannot read package: {exc}', file=sys.stderr)
        return 1

    tasks = backlog['tasks']
    by_id = {task['id']: task for task in tasks}
    gates = {gate['id']: gate for gate in external['gates']}
    cases = {row['case_id']: row for row in rows}
    order = backlog['execution_order']
    unique([task['id'] for task in tasks], 'tasks')
    unique([gate['id'] for gate in external['gates']], 'gates')
    unique([row['case_id'] for row in rows], 'acceptance')
    unique(order, 'execution_order')
    require(set(order) == set(by_id), 'execution_order must contain every task exactly once')
    require({f'DEV-{n:02}' for n in range(24)} <= set(by_id), 'Original DEV-00…23 missing')
    require({f'EXT-{n:02}' for n in range(1, 12)} <= set(gates), 'Original EXT-01…11 missing')
    positions = {item: index for index, item in enumerate(order)}
    expected_cases = set()
    audit_ids = set()
    checked_links = 0
    allowed_ac = {'not_run', 'pass', 'fail', 'blocked'}
    allowed_profiles = {f'Q{n}' for n in range(8)}

    for task in tasks:
        tid = task['id']
        require(task['status'] in backlog['status_values'], f'{tid}: invalid status')
        require(set(task['profiles']) <= allowed_profiles, f'{tid}: unknown validation profile')
        audit_ids.update(task['audit'])
        unique(task['acceptance_ids'], f'{tid} acceptance_ids')
        unique(task['dependencies'], f'{tid} dependencies')
        unique(task['external_gates'], f'{tid} external_gates')
        for dep in task['dependencies']:
            require(dep in by_id, f'{tid}: unknown dependency {dep}')
            require(positions.get(dep, len(order)) < positions.get(tid, -1),
                    f'{tid}: dependency {dep} not earlier in execution_order (cycle/order error)')
        for gate in task['external_gates']:
            require(gate in gates, f'{tid}: unknown gate {gate}')
        card = root / task['task_file']
        require(card.is_file(), f'{tid}: missing task file {card}')
        if not card.is_file():
            continue
        content = card.read_text()
        require(content.startswith(f'# {tid} {task["title"]}'), f'{tid}: title differs from backlog')
        card_cases = dict(re.findall(r'^- \*\*(DEV-\d+-AC\d+)\*\* — (.+)$', content, re.M))
        require(set(card_cases) == set(task['acceptance_ids']), f'{tid}: card AC list differs')
        dependency_line = 'Зависимости реализации: ' + (', '.join(task['dependencies']) or 'нет') + '.'
        require(dependency_line in content, f'{tid}: card dependencies differ from backlog')
        evidence = root / task['evidence_file']
        if task['status'] in {'code_verified', 'accepted'}:
            require(evidence.is_file(), f'{tid}: checked task requires evidence file')
            for dep in task['dependencies']:
                allowed = {'accepted'} if task['status'] == 'accepted' else {'code_verified', 'accepted'}
                require(dep in by_id and by_id[dep]['status'] in allowed,
                        f'{tid}: dependency {dep} not verified/accepted for declared status')
        for cid in task['acceptance_ids']:
            require(cid not in expected_cases, f'{cid}: assigned to multiple tasks')
            expected_cases.add(cid)
            row = cases.get(cid)
            require(row is not None, f'{cid}: missing acceptance row')
            if row is None:
                continue
            require(row['task_id'] == tid, f'{cid}: wrong task')
            require(row['expected_result'] == card_cases.get(cid), f'{cid}: CSV/card text differs')
            require(row['profiles'].split(',') == task['profiles'], f'{cid}: profiles differ')
            require(row['result'] in allowed_ac, f'{cid}: invalid result')
            if row['result'] != 'not_run':
                require(bool(row['evidence'].strip()), f'{cid}: result requires evidence reference')
            if row['result'] in {'pass', 'fail'}:
                require(bool(row['verified_at'].strip()), f'{cid}: result requires verification date')
            if task['status'] == 'accepted':
                require(row['result'] == 'pass', f'{cid}: accepted task has non-pass criterion')
            if task['status'] == 'code_verified':
                require(row['result'] in {'pass', 'blocked'}, f'{cid}: local verification incomplete')
                if row['result'] == 'blocked':
                    named_gates = set(re.findall(r'EXT-\d+', row['evidence']))
                    require(bool(named_gates & set(task['external_gates'])),
                            f'{cid}: blocked AC must reference a declared external gate')
        if task['status'] == 'accepted':
            for gate in task['external_gates']:
                require(gate in gates and gates[gate]['status'] == 'passed',
                        f'{tid}: external gate {gate} not passed')

    require(set(cases) == expected_cases, 'acceptance.csv has missing or orphan criteria')
    require({f'A{n:02}' for n in range(1, 17)} <= audit_ids, 'Audit A01…A16 coverage incomplete')
    for gate in external['gates']:
        gid = gate['id']
        require(gate['status'] in external['status_values'], f'{gid}: invalid status')
        expected_tasks = {task['id'] for task in tasks if gid in task['external_gates']}
        require(set(gate['tasks']) == expected_tasks, f'{gid}: task mapping differs')
        if gate['status'] == 'passed':
            require(bool(gate['owner'].strip()), f'{gid}: passed gate requires named owner')
            require(bool(gate['verified_at'].strip()), f'{gid}: passed gate requires date')
            require(bool(gate['evidence']), f'{gid}: passed gate requires evidence')

    # Only inspect the package's Markdown; source/audit documents are not rewritten here.
    for document in sorted(root.rglob('*.md')):
        for target in re.findall(r'\]\(([^\n)]+)\)', document.read_text()):
            target = target.strip().strip('<>')
            if urlsplit(target).scheme or target.startswith('#'):
                continue
            target = unquote(target.split('#', 1)[0])
            target = re.sub(r':\d+$', '', target)
            if target:
                checked_links += 1
                require((document.parent / target).exists(),
                        f'{document.relative_to(root)}: broken local link {target}')

    if args.release:
        require(all(task['status'] == 'accepted' for task in tasks), 'Release: tasks not all accepted')
        require(all(gate['status'] == 'passed' for gate in external['gates']), 'Release: gates not all passed')
    if errors:
        for error in errors:
            print(f'ERROR: {error}', file=sys.stderr)
        print(f'INVALID: {len(errors)} error(s)', file=sys.stderr)
        return 1

    print(f'VALID: {len(tasks)} tasks, {len(rows)} criteria, {len(gates)} external gates, '
          f'{checked_links} local links; audit A01…A16 covered; dependency order valid.')
    print('Task states: ' + ', '.join(f'{key}={value}' for key, value in Counter(t['status'] for t in tasks).items()))
    if args.next:
        eligible = [by_id[tid] for tid in order
                    if by_id[tid]['status'] in {'todo', 'in_progress'}
                    and all(by_id[dep]['status'] in {'code_verified', 'accepted'}
                            for dep in by_id[tid]['dependencies'])]
        if eligible:
            for index, task in enumerate(eligible):
                print(f'{"NEXT" if index == 0 else "ELIGIBLE"}: {task["id"]} — {task["title"]}')
        else:
            print('No locally eligible task. Review blocked tasks and external acceptance evidence.')
        pending = [g['id'] for g in external['gates'] if g['status'] != 'passed']
        print('Pending external gates: ' + (', '.join(pending) or 'none'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
