# Local restore drill (runbook 03, DEV-13)

Outcome: **failed** — Failed: POST /api/v1/integrations/poweroffice/pause → 503 {'title': 'MAINTENANCE_READ_ONLY', 'status': 503, 'code': 'MAINTENANCE_READ_ONLY', 'detail': 'The CRM is read-only for maintenance. Reading works; nothing can be changed until the maintenance ends.', 'since': '2026-10-04T15:51:02.0251140+00:00'}

- RPO (restore point → harmful operation): 53.8 s
- RTO (decision T0 → normal operation T9): None s
- Restore beside the live database: 0.6 s; switch with restart and migrations: 4.6 s
- Read-only maintenance: None s

| Mark | UTC | Note |
|---|---|---|
| setup | 2026-10-04T15:48:49.042Z | container crm-drill-dev13a, web https://localhost:5281, worker http://localhost:5291, mocks http://localhost:5399 |
| R | 2026-10-04T15:50:08.179Z | restore point: full backup (local stand-in for point-in-time restore) |
| R-backed-up | 2026-10-04T15:50:08.401Z |  |
| damage | 2026-10-04T15:51:01.981Z | harmful operation: 3 customers deleted |
| T0 | 2026-10-04T15:51:01.981Z | decision to restore |
| T1 | 2026-10-04T15:51:02.182Z | read-only maintenance switched on |
| T2 | 2026-10-04T15:51:12.357Z | nothing under way for 10 s |
| T3 | 2026-10-04T15:51:12.357Z | restore point chosen: 2026-10-04T15:50:08.179Z |
| T4 | 2026-10-04T15:51:12.358Z | restore into crm_drill_restore_202610041551 |
| T4done | 2026-10-04T15:51:12.923Z | restored beside the live database |
| T5 | 2026-10-04T15:51:12.923Z | checks of the copy |
| T6 | 2026-10-04T15:51:13.689Z | switch: crm_drill → crm_drill_before_202610041551, crm_drill_restore_202610041551 → crm_drill; restart; migrations |
| T6done | 2026-10-04T15:51:18.306Z | the copy is live, both apps restarted, migrations applied |
| T7 | 2026-10-04T15:51:18.429Z | reconciliation: dry run |
| T7done | 2026-10-04T15:51:19.377Z | reconciliation applied: report 20261004T155119Z-542a765dba2c4ca6b5fd6122fd8e9498 |
| T8 | 2026-10-04T15:51:19.567Z | checks before normal operation |

| Check | Result | Detail |
|---|---|---|
| order 1 sent before the restore point | ok | 5007 |
| order 2 sent after the restore point | ok | 5008 |
| PowerOffice has received two orders | ok | 2 |
| a change is refused | ok | 503 |
| reads go on | ok | 200 |
| a non-operator sign-in waits | ok | /?maintenance=signin |
| Finance waits too (no operations.maintenance) | ok | /?maintenance=signin |
| an operator signs in during maintenance | ok | / |
| the deleted customers are in the copy | ok |  |
| the copy has the second basis waiting | ok |  |
| the copy has its order queued | ok |  |
| the record entered after the point is not in the copy | ok |  |
| the copy's protection triggers are enabled | ok |  |
| still read-only after the restart | ok | 503 |
| the dry run names the second order | ok | ['PowerOffice created order 5008 for this basis at 2026-10-04 15:51 UTC; the restored copy still has it waiting to be sent', 'The journal shows operation cc9b3d6e-5c80-f235-0000-01a1079bb206 sent at 2 |
| the dry run names the queued operation | ok |  |
| the copy's pause of PowerOffice is reported | ok |  |
| the dry run changed nothing | ok |  |
| the second basis waits for Finance | ok |  |
| its operation is held | ok |  |
