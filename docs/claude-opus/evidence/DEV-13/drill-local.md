# Local restore drill (runbook 03, DEV-13)

Outcome: **passed**

- RPO (restore point → harmful operation): 55.9 s
- RTO (decision T0 → normal operation T9): 17.4 s
- Restore beside the live database: 0.7 s; switch with restart and migrations: 3.9 s
- Read-only maintenance: 17.2 s

| Mark | UTC | Note |
|---|---|---|
| setup | 2026-10-04T15:55:19.867Z | container crm-drill-dev13b, web https://localhost:5281, worker http://localhost:5291, mocks http://localhost:5399 |
| R | 2026-10-04T15:56:08.539Z | restore point: full backup (local stand-in for point-in-time restore) |
| R-backed-up | 2026-10-04T15:56:08.770Z |  |
| damage | 2026-10-04T15:57:04.446Z | harmful operation: 3 customers deleted |
| T0 | 2026-10-04T15:57:04.446Z | decision to restore |
| T1 | 2026-10-04T15:57:04.648Z | read-only maintenance switched on |
| T2 | 2026-10-04T15:57:14.842Z | nothing under way for 10 s |
| T3 | 2026-10-04T15:57:14.843Z | restore point chosen: 2026-10-04T15:56:08.539Z |
| T4 | 2026-10-04T15:57:14.843Z | restore into crm_drill_restore_202610041557 |
| T4done | 2026-10-04T15:57:15.537Z | restored beside the live database |
| T5 | 2026-10-04T15:57:15.537Z | checks of the copy |
| T6 | 2026-10-04T15:57:16.296Z | switch: crm_drill → crm_drill_before_202610041557, crm_drill_restore_202610041557 → crm_drill; restart; migrations |
| T6done | 2026-10-04T15:57:20.240Z | the copy is live, both apps restarted, migrations applied |
| T7 | 2026-10-04T15:57:20.367Z | reconciliation: dry run |
| T7done | 2026-10-04T15:57:21.378Z | reconciliation applied: report 20261004T155721Z-23a55e91015146b392738684e69efc44 |
| T8 | 2026-10-04T15:57:21.570Z | checks before normal operation |
| T9 | 2026-10-04T15:57:21.859Z | normal operation |
| T9a | 2026-10-04T15:57:21.903Z | PowerOffice resumed in the restored copy |
| done | 2026-10-04T15:59:32.364Z |  |

| Check | Result | Detail |
|---|---|---|
| order 1 sent before the restore point | ok | 5338 |
| order 2 sent after the restore point | ok | 5339 |
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
| the dry run names the second order | ok | ['PowerOffice created order 5339 for this basis at 2026-10-04 15:57 UTC; the restored copy still has it waiting to be sent', 'The journal shows operation 6f501439-6c5a-30e9-0000-01a107a133ca sent at 2 |
| the dry run names the queued operation | ok |  |
| the copy's pause of PowerOffice is reported | ok |  |
| the dry run changed nothing | ok |  |
| the second basis waits for Finance | ok |  |
| its operation is held | ok |  |
| the restored CRM is ready | ok | 200 |
| changes are accepted again | ok |  |
| no second order for the restored basis | ok | 2 |
| Finance confirms the order the journal named | ok |  |
