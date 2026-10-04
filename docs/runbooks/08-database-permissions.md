# Runbook 08. Права БД, неизменяемый аудит, retention и секреты

Решение и обоснование — [ADR-014](../adr/ADR-014-database-permissions-and-immutable-audit.md). Роли: **администратор БД** (Entra-администратор Azure SQL через PIM), **ответственный за данные** (утверждает политику хранения, DEC-03), **оператор приватности** (запускает retention), Admin CRM.

## 1. Кто что может

| Субъект | Как входит | SQL | Key Vault | Graph (Application) |
|---|---|---|---|---|
| crm-web | MI `id-crm-app-<env>` | роль `crm_web`: данные модулей (`SELECT/INSERT/UPDATE/DELETE` по схемам), `audit` — только `SELECT/INSERT`; не меняет outbox и контрольные точки аудита | метаданные хранилища (Key Vault Reader); Secrets User **только** на секрет сертификата входа `crm-web-auth`; Crypto User на ключ Data Protection | `Mail.Send` на группу `crm-quote-senders@` (отправка предложений), `Sites.Selected` (вкладка «Документы») |
| crm-worker | MI `id-crm-worker-<env>` | роль `crm_worker`: то же, что web, плюс обработка outbox и контрольные точки аудита | Secrets User на каждый секрет поставщика отдельно (`poweroffice-*`, `atera-api-key`; Teams-вебхуки и Partner Center — так же при подключении) | `User.Read.All` (синхронизация пользователей), `Mail.Send` на ящик `crm@` (сводка), `Sites.Selected` (папки клиентов) |
| crm-migrate | MI `id-crm-migrator-<env>` | Entra-администратор: миграции, роли, права, сопоставление идентичностей | — | — |
| оператор приватности | своя учётная запись, член `crm_privacy` (через PIM) | только `EXECUTE audit.ApplyRetention` | — | — |
| администратор БД | Entra-администратор через PIM | всё, включая отключение триггеров (действие видно в SQL-аудите Azure) | — | — |

Общие запреты для `crm_runtime` (web и worker): `UPDATE/DELETE` журнала аудита; запись в `__EFMigrationsHistory` любого модуля; `INSERT/UPDATE/DELETE` в `audit.RetentionPolicies`; `UPDATE/DELETE` контрольных точек; `DELETE` из `billing.BillingRuns`, `BillingBases`, `BillingLines`, `BillingApprovals`, `BillingExportAttempts`, `Charges`, `Invoices`, `InvoicePayments`, `PendingCharges` (финансовые записи удаляются только мягко); `UPDATE` журнала отправок `BillingExportAttempts`. DDL нет ни у одной роли приложения.

Триггеры действуют для **любого** пишущего (ADR-014 §4): утверждённый прогон, основание, его строки, акты согласования и начисления меняются только так, как их меняет приложение (ход выгрузки, номер заказа, сверка); журнал аудита и журнал отправок только дополняются.

Мигратор применяет роли и права после каждой миграции (`DatabaseMigrator` → `DatabasePermissions`), проверяет права роли на каждую схему и только потом делает идентичности членами ровно своей роли, снимая `db_datareader`, `db_datawriter`, `db_owner`, `db_ddladmin` и др. DDL-триггер `trg_ApplicationRolesStayNarrow` не даёт вернуть идентичности приложения широкую роль (ошибка 51031) — в том числе мигратору предыдущей версии при откате.

## 2. Переход с общей идентичности (одно окно, до развёртывания)
Выполняет владелец тенанта и подписки; поручением не выполнялось.
1. Конвейер (`deploy.yml`) сам создаёт `id-crm-worker-<env>`, если её нет, и передаёт задаче миграций обе идентичности — пользователи БД появляются раньше, чем контейнеры переключатся.
2. **До** развёртывания выдать `id-crm-worker-<env>` Graph-разрешения: `User.Read.All` (`./infra/entra/register-app.sh <env> <url> <principalId worker>`), `Mail.Send` на ящик `crm@` ([runbook 02 §4.1](02-integrations.md#41-общий-ящик-и-разрешение), с appId worker), доступ `Sites.Selected` к сайту «Kunder» ([02 §4b.2](02-integrations.md#4b2-документы-в-sharepoint)). Без них синхронизация пользователей, сводка и папки SharePoint из worker не работают (видно по `/health/integrations` и логам).
3. После проверки — снять у `id-crm-app-<env>` то, что ему больше не нужно: `User.Read.All` и область `Mail.Send` на `crm@`.
4. Проверить: `SELECT r.name, m.name FROM sys.database_role_members x JOIN sys.database_principals r ON r.principal_id = x.role_principal_id JOIN sys.database_principals m ON m.principal_id = x.member_principal_id WHERE m.name LIKE 'id-crm-%';` — `id-crm-app-<env>` только в `crm_web`, `id-crm-worker-<env>` только в `crm_worker`.

## 3. Новый модуль, таблица или секрет
- **Схема модуля** получает права роли автоматически (мигратор перечисляет схемы всех контекстов).
- **Таблица, строки которой нельзя удалять или менять** (финансовые, юридические, доказательства) — запрет в `IDatabasePermissionRules` модуля (пример — `BillingDatabasePermissions`), при необходимости триггер с `HasTrigger` в маппинге EF. Обязательно для inbox-таблиц DEV-07 (обработанное входящее сообщение не удаляется приложением) и таблиц приватности DEV-11 (запросы субъектов, подавления, legal holds — только добавление и смена статуса).
- **Секрет поставщика** — в Key Vault, имя добавить в `workerSecretNames` (`infra/main.bicep`) и в `integrationSecrets`/`integrationKeys` (`infra/modules/apps.bicep`). crm-web его не получает; если операция нужна в интерфейсе, она ставится в очередь worker (как проверка подключения).

## 4. Retention аудита (DEC-03, EXT-07)
Пока ответственный за данные не утвердил политику по категориям, возможен только пробный прогон.
1. Пробный прогон (оператор приватности):
   ```sql
   EXEC audit.ApplyRetention @Module = N'customers', @Before = '2025-10-01T00:00:00+00:00';  -- @DryRun = 1 по умолчанию
   ```
   Возвращает, сколько записей содержат персональную часть. Ничего не меняется.
2. После утверждения DEC-03 администратор БД записывает политику (приложение этого не может):
   ```sql
   INSERT INTO audit.RetentionPolicies (Module, RetainDays, ApprovedBy, ApprovedAt, Reference)
   VALUES (N'customers', <дней ≥ 30>, N'<ответственный>', SYSDATETIMEOFFSET(), N'DEC-03 <номер решения>');
   ```
3. Разрушающий прогон (оператор приватности): `@DryRun = 0`, `@Before` не позже «сейчас − RetainDays». Обнуляются `UserId`, `UserName`, `IpAddress`, `Changes` старых записей модуля; факт действия остаётся; запуск записывается в аудит (`Action = 'Retention'`, `UserName` = логин оператора).
4. Модули `billing`, `contracts`, `time`, `sales`, `projects`, `catalog`, `licensing` и `audit` — доказательства финансовых записей (бухгалтерский закон): процедура отказывает (51020), политика для них не принимается.

## 5. Целостность аудита
- Ночная задача `audit-integrity` (04:40, worker) продолжает цепочку и перепроверяет последнюю и одну старую контрольную точку. Записи моложе `Audit:Integrity:SettleTime` (5 минут) ждут следующего запуска: так незавершённая транзакция не попадает «в дыру» внутри уже посчитанного диапазона. Каждая новая точка уходит в лог: `AUDIT_CHECKPOINT {Id} {FromId} {ToId} {Entries} {PreviousHash} {ChainHash}`.
- Полная проверка — задача `audit-integrity-full` (Admin → Задания → «Запустить»), после инцидента и перед проверкой аудитором.
- Сверка якорей (Log Analytics, хранение логов не короче срока аудита):
  ```kusto
  AppTraces | where Message startswith "AUDIT_CHECKPOINT"
  | extend p = split(Message, " ") | project TimeGenerated, Id = tolong(p[1]), ToId = tolong(p[3]), ChainHash = tostring(p[6])
  ```
  `ChainHash` каждой точки должен совпадать с `audit.IntegrityCheckpoints`. Несовпадение или исчезнувшая точка — инцидент ([runbook 06](06-security-incident.md)).
- Алерт: `AppTraces | where Message startswith "AUDIT_INTEGRITY_MISMATCH"` ≥ 1 → Sev1, получатели — по DEC-09 (адреса не назначены).

## 6. Действия администратора БД
Ремонт данных утверждённых записей или подготовка восстановления — только администратор БД, по заявке, в одной транзакции (схемная блокировка не даёт другим сессиям работать с таблицей без триггера, ошибка оставляет триггер включённым):
```sql
BEGIN TRANSACTION;
DISABLE TRIGGER [billing].[trg_BillingBases_Protect] ON [billing].[BillingBases];
-- исправление, с номером заявки в комментарии
ENABLE TRIGGER [billing].[trg_BillingBases_Protect] ON [billing].[BillingBases];
COMMIT;
```
Потом запустить `audit-integrity-full`. Отключение триггера, изменение ролей и `DROP TRIGGER trg_ApplicationRolesStayNarrow ON DATABASE` видны в SQL-аудите Azure; абсолютной защиты от администратора БД нет и она не заявляется (ADR-014).
