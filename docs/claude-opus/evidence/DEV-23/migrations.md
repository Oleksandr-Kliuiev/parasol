# Миграции EF Core и совместимость отката (DEV-23)

Источник перечня: `find src -path '*/Persistence/Migrations/*.cs'` без `*.Designer.cs` и `*ModelSnapshot.cs` — **62 миграции** в 16 контекстах (`Audit`, `Customers`, `Identity`, `Catalog`, `Contracts`, `Service`, `TimeTracking`, `Sales`, `Projects`, `Activities`, `Licensing`, `Billing`, `Notifications`, `Privacy`, `CustomFields`, `Crm.Integrations.Core`). Модуль `Reports` схемы не имеет (ADR-022). Коммит добавления — `git log --diff-filter=A` по файлу миграции (самый ранний); дата — дата коммита, не метка времени миграции. `HEAD` = `b6da6a8`.

Что проверено мной при составлении (повторяемо):
- В `Up()` ни одной из 62 миграций нет `DropTable`, `DropColumn`, `RenameColumn`, `RenameTable`, `DropSchema`, `DropSequence`, `DeleteData`, `RenameIndex` (скрипт по тексту файлов; `Down()` их содержат, это ожидаемо). Это критерий архитектурного теста `tests/Crm.ArchitectureTests/MigrationCompatibilityTests.cs` (`Migrations_only_expand_the_schema_unless_a_contract_step_is_approved`; словарь одобренных contract-шагов `ApprovedContractSteps` пуст). Сам тест я не запускал; его прогоны записаны в evidence DEV-05…DEV-22. Проверку «обязательная колонка без default» и «сужение/смена типа» я не повторял.
- Создают триггеры (поиск `trigger` без учёта регистра в файлах миграций): ровно четыре — `Audit/20261004011342_AppendOnlyAudit`, `Billing/20261004011343_ProtectApprovedBilling`, `Sales/20261004052355_QuoteDocuments`, `Sales/20261004095840_QuoteDocumentErasure`. Все четыре записаны в `tools/release/schema-breaks.json`: одна как `breaks`, три как `reviewedCompatible`. Архитектурный тест `Every_migration_that_creates_a_trigger_is_registered_as_a_break_or_reviewed_compatible` требует этого.
- Аддитивность не означает отсутствия переноса данных: часть миграций содержит SQL (`migrationBuilder.Sql`) — например `ChargeIdentity` (DEV-01), `RevisionBoundApprovals` (DEV-02, legacy-акты выводятся из полей подписей), `ChargeRegister` (DEV-03, backfill реестра и отчёт `Legacy`), `OperationalMonitoring` (DEV-17, перенос последних полных успехов в `integration.SyncSuccesses`), `PrivacyCases` (DEV-11), все 15 `OutboxDelivery` (DEV-07). Контекст Contracts `OutboxDelivery` останавливается ошибкой 51041, если в базе есть несколько договоров по одному принятому КП (runbook 09 §5). Содержимое остальных SQL-вставок я не разбирал построчно — смотреть сами файлы.

## 1. Реестр schema-breaks (`tools/release/schema-breaks.json`)

| Миграция | Класс | Причина (из файла) | Чем проверено (из файла и evidence) |
|---|---|---|---|
| `Crm.Billing/20261004011343_ProtectApprovedBilling` (DEV-04, `1721a15`) | **break** | SQL-триггеры на таблицах биллинга. Модель EF Core без `HasTrigger`, то есть каждый релиз до DEV-04, пишет с `OUTPUT` без `INTO`, чего SQL Server не допускает на таблице с триггером (ошибка 334): сбор и согласования биллинга падают. | `tools/release/rollback-compat.sh 646a565` (DEV-03 на этой схеме): 9 сценариев биллинга падают с HTTP 500 при сборе; `evidence/DEV-05/rollback-compat-646a565.txt`: 44 passed, 9 failed |
| `Crm.Audit/20261004011342_AppendOnlyAudit` (DEV-04) | reviewed compatible | Триггер срабатывает только на UPDATE и DELETE `audit.AuditEntries`; все релизы только вставляют записи аудита; новые таблицы старые релизы не отображают. | `rollback-compat.sh 646a565`: прежний релиз пишет аудит на этой схеме в каждом пройденном сценарии |
| `Crm.Sales/20261004052355_QuoteDocuments` (DEV-08) | reviewed compatible | Триггер охраняет только новую таблицу `sales.QuoteDocuments`, которую ранние релизы не отображают. | `rollback-compat.sh 51c5ea6` (DEV-07 на этой схеме), `evidence/DEV-08.md` |
| `Crm.Sales/20261004095840_QuoteDocumentErasure` (DEV-11) | reviewed compatible | Заменяет триггер DEV-08 на такой, что принимает все записи прежних релизов; две новые колонки nullable и ранними релизами не отображаются; стёртый документ сохраняет статус (скачивание в старом релизе ответит, что документ нельзя прочитать). | `rollback-compat.sh 7b4c90c` (DEV-10 на этой схеме), `evidence/DEV-11.md` |

### Заявление об откате за разрыв схемы

- **Старые релизы не могут писать в биллинг на схеме с `ProtectApprovedBilling`.** Любой релиз **ниже коммита `1721a15`** (DEV-04) несовместим с БД, к которой применена эта миграция: сбор и согласования биллинга падают (ошибка 334). Ниже лежат baseline `2bed19e` и DEV-00…DEV-03.
- **Автоматически такой откат отклоняется.** Job `deploy` в `promote.yml` (и `release.yml` для test) вызывает `release.py schema-guard` до `deploy.sh`: релиз ниже применённого в окружении разрыва отклоняется (runbook 01 §9 п. 2); сам `deploy.sh` разрыв не проверяет.
- **Развёртывание разрыва поверх более старого релиза** — только в согласованное окно: пауза интеграций и биллинга, режим обслуживания, `accept_schema_break` (runbook 01 §6a). Работающий релиз продолжает обслуживать запросы между миграциями и переключением трафика.
- **Ручной путь ниже разрыва:** администратор БД откатывает конкретную миграцию (например, `ProtectApprovedBilling` снимает триггеры, данные не трогает) и разворачивает релиз вручную по решению владельца; **разрушающий откат схемы с потерей данных запрещён** (runbook 01 §9 п. 3). По evidence DEV-04 (проверка отката `ChargeRegister` и audit `Initial`): триггеры и процедура сняты, контрольные точки и политики сохранены в `*_rollback_<время>`, а роли, запреты и DDL-триггер **остаются** — `ALTER ROLE db_datawriter ADD MEMBER` по-прежнему отклоняется (51031), поэтому повторный запуск мигратора прежней версии остановится на DDL-триггере. Откат образов через предыдущую ревизию Container Apps узкие права сохраняет.
- `Down()` — инструмент администратора БД, а не штатный откат релиза: `deploy.sh --rollback` миграций не запускает.

## 2. Все миграции

«Класс»: `expand` — в `Up()` нет разрушающих операций (проверка выше); четыре миграции с триггерами помечены отдельно. Задача определена по сообщению коммита. Коммит `3a1ec89` объединяет DEV-16 и DEV-17: `OperationalMonitoring` — DEV-17 (evidence/DEV-17.md), обе `ReadPathIndexes` — DEV-16 (три индекса, evidence/DEV-16.md).

| Контекст | Миграция | Коммит (дата коммита) | Задача | Класс |
|---|---|---|---|---|
| Crm.Integrations.Core | `20260915095455_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Crm.Integrations.Core | `20260915123122_ExternalLinksAndOutbound` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Crm.Integrations.Core | `20260922112327_IntegrationSwitches` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Crm.Integrations.Core | `20261004030441_WorkerHeartbeats` | `51fbe5e` 2026-10-04 | DEV-06 | expand |
| Crm.Integrations.Core | `20261004040653_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Crm.Integrations.Core | `20261004201458_OperationalMonitoring` | `3a1ec89` 2026-10-05 | DEV-17 | expand |
| Activities | `20260916071959_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Activities | `20260921212126_OutlookActivities` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Activities | `20261004040649_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Audit | `20260915081313_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Audit | `20261004011342_AppendOnlyAudit` | `1721a15` 2026-10-04 | DEV-04 | expand; триггер, reviewed compatible |
| Audit | `20261004040638_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Audit | `20261004095841_PrivacyErasure` | `9dfe2b4` 2026-10-04 | DEV-11 | expand |
| Billing | `20260916082954_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Billing | `20260916183504_PendingCharges` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Billing | `20261003230254_ChargeIdentity` | `8b8e6f8` 2026-10-04 | DEV-01 | expand |
| Billing | `20261003233005_RevisionBoundApprovals` | `bf0eda5` 2026-10-04 | DEV-02 | expand |
| Billing | `20261004002311_ChargeRegister` | `646a565` 2026-10-04 | DEV-03 | expand |
| Billing | `20261004011343_ProtectApprovedBilling` | `1721a15` 2026-10-04 | DEV-04 | **разрыв схемы (break)** |
| Billing | `20261004040651_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Billing | `20261004112326_InvoiceListOrder` | `65b74c6` 2026-10-04 | DEV-12 | expand |
| Billing | `20261005095917_InvoiceBalanceMovements` | `7f3b4ec` 2026-10-05 | DEV-19 | expand |
| Catalog | `20260915191718_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Catalog | `20261004040643_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Contracts | `20260915192708_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Contracts | `20260916183501_ContractSourceQuote` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Contracts | `20261004040644_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| CustomFields | `20260922105418_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| CustomFields | `20261004040641_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Customers | `20260915081326_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Customers | `20260915094817_OrganizationMerges` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Customers | `20260922073130_OrganizationGroup` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Customers | `20261004040640_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Customers | `20261005104625_ImportRuns` | `c16e86c` 2026-10-05 | DEV-20 | expand |
| Identity | `20260915081324_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Identity | `20260915081342_TokenCache` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Identity | `20260915205432_TechnicianMappings` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Identity | `20261004040639_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Identity | `20261004083007_SessionsAndConfirmedRoles` | `7b4c90c` 2026-10-04 | DEV-10 | expand |
| Identity | `20261005120721_SessionExternalId` | `bd70452` 2026-10-05 | DEV-21 | expand |
| Identity | `20261005131126_SessionAuthTime` | `bd70452` 2026-10-05 | DEV-21 | expand |
| Licensing | `20260916072001_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Licensing | `20260922054410_LicenseUsageAndBilling` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Licensing | `20261004040650_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Notifications | `20260916150925_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Notifications | `20261004040652_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Privacy | `20261004095906_PrivacyCases` | `9dfe2b4` 2026-10-04 | DEV-11 | expand |
| Projects | `20260922073201_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Projects | `20261004040648_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Projects | `20261004071249_ProjectMembers` | `4a108ac` 2026-10-04 | DEV-09 | expand |
| Sales | `20260916071957_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Sales | `20260916184621_Quotes` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Sales | `20261004040647_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Sales | `20261004052355_QuoteDocuments` | `d53b3eb` 2026-10-04 | DEV-08 | expand; триггер, reviewed compatible |
| Sales | `20261004095840_QuoteDocumentErasure` | `9dfe2b4` 2026-10-04 | DEV-11 | expand; триггер, reviewed compatible |
| Service | `20260915231817_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| Service | `20261004040645_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| Service | `20261004220000_ReadPathIndexes` | `3a1ec89` 2026-10-05 | DEV-16 | expand |
| TimeTracking | `20260915231819_Initial` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| TimeTracking | `20260922073132_TimeEntryProject` | `2bed19e` 2026-10-03 | до DEV (baseline) | expand |
| TimeTracking | `20261004040646_OutboxDelivery` | `51c5ea6` 2026-10-04 | DEV-07 | expand |
| TimeTracking | `20261004220001_ReadPathIndexes` | `3a1ec89` 2026-10-05 | DEV-16 | expand |

Сводка по коммитам: baseline `2bed19e` — 27; DEV-07 — 15; DEV-11 — 3; DEV-16/17 — 3; DEV-04 — 2; DEV-21 — 2; по одной — DEV-01, DEV-02, DEV-03, DEV-06, DEV-08, DEV-09, DEV-10, DEV-12, DEV-19, DEV-20. Миграций не добавляли DEV-00, DEV-05, DEV-13, DEV-14, DEV-15, DEV-18, DEV-22 (для DEV-18 и DEV-22 это записано в их evidence; для DEV-14 — в `PROGRESS.md`: «изменений модели EF нет ни в одном из 16 контекстов»; остальные — по таблице).

## 3. Проверки совместимости отката по задачам

`tools/release/rollback-compat.sh <SHA предыдущего релиза>` поднимает временную SQL Server БД (контейнер) и git worktree, применяет миграции **текущих** исходников и гоняет E2E **предыдущего** релиза. Проверяется пара «предыдущий релиз на схеме следующего», не все пары.

| Задача (схема) | Предыдущий релиз | Результат | Протокол |
|---|---|---|---|
| DEV-05 | `646a565` (DEV-03) | 44 passed, 9 failed — **найден разрыв схемы** | `evidence/DEV-05/rollback-compat-646a565.txt` |
| DEV-05 | `1721a15` (DEV-04) на текущей схеме | 54/54 | `evidence/DEV-05/rollback-compat-1721a15.txt` |
| DEV-05 | `bf0eda5` (DEV-02) на схеме `646a565` (`ROLLBACK_SCHEMA_FROM`) | 52/52 | `evidence/DEV-05/rollback-compat-bf0eda5-on-646a565.txt` |
| DEV-06 | `500546d` (DEV-05) | 54/54 (первый прогон 53/54: сценарий не уложился в общий таймаут при параллельной нагрузке; запас увеличен) | `evidence/DEV-06/rollback-compat-500546d.txt`, `…-run1.txt` |
| DEV-07 (15 миграций `OutboxDelivery`) | `51fbe5e` (DEV-06) | 54/54 | `evidence/DEV-07/rollback-compat-51fbe5e.txt` |
| DEV-08 | `51c5ea6` (DEV-07) | 54/54 | `evidence/DEV-08/rollback-compat-51c5ea6.txt` |
| DEV-09 | `d53b3eb` (DEV-08) | 54/54 | `evidence/DEV-09/rollback-compat-d53b3eb.txt` |
| DEV-10 | `4a108ac` (DEV-09) | 55/55 | `evidence/DEV-10/rollback-compat-4a108ac.txt` |
| DEV-11 | `7b4c90c` (DEV-10) | 55/55 | `evidence/DEV-11/rollback-compat-7b4c90c.txt` |
| DEV-12 | `9dfe2b4` (DEV-11) | 58/58 | `evidence/DEV-12/rollback-compat-9dfe2b4.txt` |
| DEV-13 | `65b74c6` (DEV-12) | 58/58 | `evidence/DEV-13/rollback-compat-65b74c6.txt` |
| DEV-14 | `c1b5e12` (DEV-13) | 58/58 | `evidence/DEV-14/rollback-compat-c1b5e12.txt` |
| DEV-16 | `9745703` (DEV-14), `--grep '@critical'` | 7/7 | `evidence/DEV-16/checks/dev16-rollback.log` |
| DEV-17 | `9745703` (DEV-14) | 7/7 | `evidence/DEV-17/rollback.txt` |
| DEV-18 | — | миграций нет; протокола в evidence нет | `evidence/DEV-18.md` («Схема, API и миграции не менялись») |
| DEV-19 | `8005bd1` (DEV-18) | 10/10 | `evidence/DEV-19/rollback.txt` |
| DEV-20 | `7f3b4ec` (DEV-19) — по `PROGRESS.md` | 10/10 по `PROGRESS.md`; **файла протокола в `evidence/DEV-20/` нет** | `PROGRESS.md` (раздел DEV-20) |
| DEV-21 | `c16e86c` (DEV-20) — по `PROGRESS.md` | 10 passed | `evidence/DEV-21/rollback.txt` (в файле SHA не указан) |
| DEV-22 | `bd70452` (DEV-21) — по `PROGRESS.md`; миграций нет | 10 passed | `evidence/DEV-22/rollback.txt` (в файле SHA не указан) |

Для DEV-00…DEV-04 `rollback-compat.sh` ещё не существовал (появился в DEV-05); для DEV-01…DEV-03 есть проверки обновления с прежних данных: `evidence/DEV-01/migration-upgrade.txt`, `evidence/DEV-02/migration-upgrade.txt`, `evidence/DEV-03/migration-upgrade.txt`. Протоколы DEV-19/21/22 и `dev16-rollback.log` проверяют критические браузерные сценарии (`@critical`), не весь набор E2E.

## 4. Окно совместимого отката и его границы

- **Совместимое окно по проверенным парам:** релиз с коммита `1721a15` (DEV-04) и новее совместим со схемой следующего шага по протоколам §3. Ниже `1721a15` — несовместим (§1).
- **Не проверено:** пары через несколько шагов (например, `9745703` на схеме `HEAD` — после DEV-17 схема менялась в DEV-19, DEV-20 и DEV-21, а проверялись только пары-соседи); откат при данных, созданных новым кодом. Старые релизы не знают новых таблиц и колонок (`ExternalSessionHash`, `AuthenticatedAt`, `ImportRuns`, `InvoiceBalanceMovements` и др.) и их не используют; что они не повреждают эти данные — следует из expand-only, но по парам не доказано.
- **Перед откатом:** (1) цель выше разрыва схемы; (2) есть протокол `rollback-compat` для пары, а для непроверенной — `tools/release/rollback-compat.sh <SHA>` на отдельной временной БД (не на производственной); (3) manifest и запись развёртывания цели доступны; (4) режим обслуживания не включён на откатываемом релизе без DEV-13 (runbook 03 §9, последний абзац); (5) откат не меняет данные и внешние документы (`rollback-cutback.md` §3).
