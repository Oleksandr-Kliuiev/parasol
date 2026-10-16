# Ограниченный rollout, наблюдение и модель поддержки (DEV-23)

## 0. Статус и границы

- Это **план и шаблон**. Production-операции, включение интеграций и отправка реальных документов этим пакетом не разрешены. Какое окружение и какие пользователи участвуют, решает владелец явно и письменно.
- Все поля владельцев, имён, адресов, дат и численных порогов rollout — **(пусто)**. В репозитории они не определены: `GO_LIVE.md` требует определить «численные пороги ошибок/задержек, владельца остановки и длительность наблюдения» до выпуска; `external-gates.json`: `owner` пуст у всех 11 gate.
- Состав этапов, частоты проверок и пороги ниже, помеченные «предложение», не утверждены; числа без пометки взяты из кода, Bicep или runbooks (источник указан).
- Связанные документы: `rollback-cutback.md` (откат, возврат к ручному процессу, критерии остановки, контрольные данные), `config-manifest.md`, `migrations.md`, `known-limitations.md`, `gate-summary.md` и `go-no-go-record.md` (другой исполнитель).

## 1. Условия входа (до любого этапа с реальными пользователями)

Из `GO_LIVE.md`: допуск к эксплуатации получен по каждому пункту таблицы, нет открытого P1 в запускаемом объёме, необъяснённого финансового расхождения, непроверенного восстановления, неподтверждённого record scope, незакрытого применимого gate, критической/высокой находки безопасности. На 05.10.2026 в `GO_LIVE.md` результат всех строк — `not_run`; `external-gates.json`: blocked — EXT-01, 02, 03, 05, 06, 09, 10; not_run — EXT-04, 07, 08, 11. Поэтому условия входа **не выполнены**; план описывает порядок после их выполнения.

Дополнительно (из runbooks):
- роли и контакты §5 назначены людьми;
- развёртывание вынесено в `test` конвейером (EXT-11); первое развёртывание DEV-04+ поверх старого релиза — в согласованное окно (runbook 01 §6a);
- `infra/entra/register-app.sh` выполнен владельцем tenant до выкладки DEV-21 (иначе привилегированные действия закрыты); права Graph у worker выданы (`config-manifest.md` §4);
- режим записевого охвата `Restricted`, отчёт «Доступ к записям» сверен (runbook 11 §1);
- доставка алертов проверена по протоколу EXT-01 (runbook 15);
- контрольные данные записаны (`rollback-cutback.md` §7).

## 2. Этапы (предложение, не утверждено)

Состав групп, их размеры и длительность этапов — (пусто): решает Product Owner с Finance. Структура соответствует `GO_LIVE.md`: «согласованная группа пользователей/клиентов, затем расширение по наблюдаемым критериям».

| Этап | Кто | Что включено | Условия перехода дальше | Условия остановки |
|---|---|---|---|---|
| 0. Тестовая среда | Operations, Finance (тестовые учётные записи) | `test`; PowerOffice только Demo (зафиксировано в `test.bicepparam`); исходящая почта и запись во внешние системы выключены | Проверены вход ролей, привилегированные действия, алерты Fired/Resolved (runbook 15), `restore.py` на тестовой среде (EXT-04), smoke конвейера (EXT-11) | Любое условие §3 `rollback-cutback.md` S1–S15 |
| 1. Параллельный месяц (пилот) | Finance (владелец сверки), Product Owner, Admin, Management; бухгалтер, выставляющий по-старому | Runbook 18 вариант A (отдельная среда с копией данных, Demo); CRM клиентам ничего не отправляет; источник истины — старый способ | Полный месяц пройден (runbook 18 §4); сверка подписана Finance без необъяснённых расхождений (DEV-22-AC03); критерии §10 runbook 18 закрыты внешними доказательствами | Runbook 18 §9 |
| 2. Ограниченная группа | Согласованные пользователи по ролям Sales / Technician / ServiceLead / Finance (состав (пусто)), согласованные клиенты (пусто) | Только решения, принятые владельцем; записевой охват `Restricted`; внешние эффекты включаются по одному флагу и сначала для ограниченного круга (`WriteEnabled`, почта) | Срок наблюдения (пусто) без срабатывания условий остановки; жалобы по доступу и деньгам разобраны | `rollback-cutback.md` §5 |
| 3. Расширение | Остальные пользователи, клиенты (пусто) | Расширение по критериям этапа 2 | Те же критерии, срок (пусто) | Те же |
| 4. Передача в эксплуатацию | Поддержка §5 | Старый способ отключается только после приёмки EXT-09 / EXT-10 (DEV-23 «Данные и обратимость»; runbook 16 §9) | Решение go/no-go (см. `go-no-go-record.md`), стабилизация завершена | — |

## 3. Что наблюдается, где и как часто

Частоты — **предложение** (не утверждены); сроки реакции — (пусто) (DEC-09). Пороги — начальные значения, не утверждённые SLO (runbook 15; p95 > 2000 мс — диагностический порог, не замена SLO DEV-16).

| Что смотреть | Где | Нормально / порог (источник) | Предложение по частоте | Реакция |
|---|---|---|---|---|
| Готовность и живость | `/health/ready` (БД и схема), `/health/live`, `/health/integrations` (только мониторинг, не readiness), `/health/details` (администраторы: heartbeat компонентов) | SQL readiness Healthy; heartbeat не старше 180 с; цикл outbox — раунд не реже 10 мин (`Worker:Health`) | Алерты — непрерывно; ручной просмотр — раз в рабочий день этапов 1–2 | Runbook 01/03/09 |
| Алерты Azure Monitor | Правила `infra/modules/monitoring-operations.bicep` (18 правил: http-errors, http-latency, sql-readiness, host-telemetry-missing, collector-failed, heartbeat-old/missing, outbox-depth/old/deadletter, outbound-errors, sync-failed/overdue, unmapped-records, financial-exceptions, operational-exceptions, audit-integrity-mismatch, audit-checkpoint-missing) | Пороги и severity: таблица «Сигналы и реакция» runbook 15 | Непрерывно (**доставка не проверена, получатели не назначены — EXT-01**) | Runbook 15 |
| Экран мониторинга | «Администрирование → Интеграции → Мониторинг» (`integrations.manage`; финансовые сигналы — `finance.read`, себестоимость — `finance.cost.read`) | Исключения с ответственным и статусом; Recovered → Решено | Раз в рабочий день | Назначить ответственного, статус «В работе», причина (runbook 15) |
| Outbox / доставка событий | «Администрирование → Интеграции → Доставка событий», `GET /api/v1/integrations/outbox` | Dead letter и карантин = 0; очередь ≤ 100, самое старое ≤ 300 с | Раз в рабочий день | Runbook 09; повтор только после устранения причины, ≤ 100 сообщений |
| Свежесть синхронизаций | Мониторинг: `integration.SyncSuccesses` | Atera открытые тикеты и недавние — 15 мин; PowerOffice счета — 90 мин (значения в `main.bicep`, DEC-09 не утверждено); частичный успех, пропуск и проверка соединения не освежают | Раз в рабочий день; при паузе интеграции показывается отдельной категорией | Runbook 15, 05 |
| Аномалии биллинга | Страница прогона, фильтр «Needs a look only»: изменение суммы клиента > 20 % (`Billing:TotalChangeAnomalyPct`), позиция без цены, клиент/продукт без связи PowerOffice, подписка CSP без позиции договора, устаревшее количество (`BIL_STALE_QUANTITY`, > 3 дней) | Каждая аномалия объяснена или исправлена (runbook 18 §4.3) | При каждом прогоне | Finance |
| Финансовые исключения | Мониторинг: `Unbilled`, `ReconciliationRequired`, `LegacyUnresolved`, `BillingConflict`, `EstimatedQuantity`, `LicenseDiscrepancy` | > 0 — Sev 2, Finance (runbook 15 «Финансовые исключения») | Раз в рабочий день, ежедневно в первые рабочие дни месяца (предложение) | Сверка, не слепой повтор |
| Выгрузка биллинга | Страница прогона (счётчики, «отправлено X, с ошибкой Y, из Z»), `GET /api/v1/billing/runs/{id}/bases?status=ExportFailed` | Все основания выгружены или отменены перед закрытием (runbook 04 §5) | Во время каждой выгрузки | Runbook 04 |
| Счета и остатки | «Счета»: остаток, просрочка, дата среза | Синхронизация PowerOffice каждый час (`Billing:InvoiceSyncCron` `20 * * * *`) | Раз в неделю (предложение) | Finance |
| Документы предложений | Сигнал `DocumentPreparing` (порог `Monitoring:DocumentPreparingMinutes`, по умолчанию 15) | 0 | Раз в рабочий день | Runbook 10 |
| Подтверждение ролей Entra | Сигнал `DirectoryConfirmationStale` (> 10 мин, `Monitoring:DirectoryConfirmationMinutes`) | Подтверждение свежее | Непрерывно | Runbook 12 |
| Журнал безопасности | Метрика `crm.security.events` (счётчик измерения Meter `Crm.Security`, тег `kind`: `forbidden`, `unauthenticated`, `csrf_refused`, `rate_limited`, `bi_token_rejected`, `bi_denied`, `sign_in_failed`, `remote_sign_out_ignored`; категория лога `Crm.Security`: код, шаблон маршрута и id, без запроса и токенов) | **Алерта на неё в Bicep нет** (в `monitoring-operations.bicep` слово `security` не встречается), порог не определён — (пусто). Метр подключён в `ServiceDefaultsExtensions.cs` (`AddMeter`) | Раз в рабочий день на этапах 1–2 (предложение): всплеск `forbidden`, `csrf_refused`, `sign_in_failed` | Runbook 06 при подозрении; решение порога — Security owner |
| Целостность аудита | `AUDIT_INTEGRITY_MISMATCH` (Sev 1), нет `AUDIT_CHECKPOINT` 2 суток (Sev 3), ночная задача `audit-integrity` 04:40 Europe/Oslo | Нет несовпадений | Непрерывно | Runbook 08 §5, 06 |
| Запросы субъектов, стирание | Экран «Персональные данные»; `503 PRIVACY_REPLAY_PENDING` | Нет ожидающих повторов после восстановления | Раз в рабочий день при открытых делах | Runbook 13 |
| Охват записей | «Доступ к записям» | Нет предложений без владельца / с неактивным владельцем | Раз после первого включения и при изменениях команд | Runbook 11 |
| Обратная связь пользователей | Канал вопросов (роль L1, (пусто)) | — | Ежедневно | Эскалация §5 |

## 4. Критерии выхода из наблюдения

Состав и сроки утверждает Product Owner с Finance; значения — (пусто). Минимальный набор (предложение):
- за весь срок наблюдения нет условий остановки S1–S15 (`rollback-cutback.md` §5);
- нет открытых необъяснённых расхождений сумм, ни одного основания в «Требует сверки» без решения, ни одного документа в `Preparing` сверх порога;
- все исключения мониторинга имеют ответственного и статус; алерты доставлялись назначенным людям;
- ни одного случая доступа вне охвата;
- завершён хотя бы один полный биллинговый цикл месяца с подписанной сверкой Finance (runbook 18);
- завершена стабилизация (§5), поддержка принята назначенными людьми.

## 5. Модель поддержки (шаблон, поля пусты)

Роли названы только ролями; имена, контакты, часы, замещение и сроки реакции не заполнены и не придуманы. Заполняется Product Owner и Operations (EXT-01 / DEC-09, EXT-11). Публичные адреса приёма уязвимостей не публиковать, пока канал не подтверждён (runbook 17 §0).

| Роль | Ответственность | Имя | Контакт | Замещающий | Часы | Срок реакции |
|---|---|---|---|---|---|---|
| Product Owner | Решения go/no-go и остановки rollout, DEC-01…10, срок реакции на уязвимости (runbook 17 §2 — предложение), принятие остаточных рисков (`DEC-EXC-<номер>`) | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Finance acceptance | Приёмка пилотной сверки и подпись (право `billing.reconcile`), решения по `LegacyUnresolved`, правила корректировок (DEC-02), остановка выставления через CRM | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Дежурный Operations (on-call) | Алерты Azure Monitor, пауза интеграций, режим обслуживания, откат образов, восстановление (runbook 03) | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| L1 | Приём вопросов пользователей, первичная проверка (доступ, роль, «не вижу предложение», `AUTH_REVERIFY_REQUIRED`), сбор информации | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| L2 | Разбор исключений мониторинга, dead letter, сверки биллинга, вопросы к провайдерам | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Разработка (L3) | Исправления кода; не подписывает за Finance и Product Owner (`GO_LIVE.md`) | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Security owner | Приём уязвимостей (`SECURITY.md`, runbook 17), инциденты безопасности (runbook 06), целостность аудита | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Приём уязвимостей (канал) | Канал в `SECURITY.md` — заглушка (EXT-11); приватные уведомления GitHub и защищённый ящик не подтверждены | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Владелец данных | Запросы субъектов, сроки хранения, юридические удержания, роль `crm_privacy` (EXT-07) | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Владелец tenant Entra | Роли, группы, PIM, Conditional Access, Graph-разрешения, срочный отзыв (runbook 12; EXT-02) | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Владелец репозитория | Настройки GitHub, окружения `test`/`prod`, reviewers, защита `main` (EXT-11) | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Владелец интеграций | PowerOffice, Atera, Partner Center: ключи, контакт у провайдера (EXT-03) | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Владелец BI | Power BI Service, регистрация приложения, ротация сертификата (EXT-08) | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |
| Получатели алертов | `monitoringOperationsOwner`, `monitoringFinanceOwner`, `monitoringOperationsEmails`, `monitoringFinanceEmails`, `monitoringRunbookUrl` (Bicep) — пусты; `monitoringNotificationsEnabled` = `false`; в bicepparam не закреплены; доставка Fired/Resolved не проверена (runbook 15 «Протокол EXT-01») | (пусто) | (пусто) | (пусто) | (пусто) | (пусто) |

Эскалация (шаблон, порядок и сроки — (пусто)): пользователь → L1 → L2 → дежурный Operations → Product Owner; деньги — Finance acceptance; доступ и данные — Security owner / владелец данных; инцидент безопасности — runbook 06 (GDPR: 72 часа от обнаружения, уведомление Datatilsynet решает Компания).

Период стабилизации: длительность и критерии окончания — (пусто); до окончания разработка остаётся на связи как L3 (решение владельца). Поддержка не заменяет gate: приложение не считается переданным, пока роли выше назначены (DEV-23-AC05).

Резервный ручной процесс и владельцы исключений: runbook 07 (Finance, Admin), runbook 18 §5 (исключения пилота, владельцы — (пусто)).

## 6. Проверка актуальности runbooks

Что сделано (чтением и скриптами, без правки runbooks и без выполнения команд в Azure):
1. Все локальные markdown-ссылки и якоря `#…` в `docs/runbooks/*.md` разрешаются в существующие файлы и заголовки.
2. Пути в обратных кавычках (`tools/…`, `src/…`, `infra/…`, `docs/…`, `.github/…`, `web/…`, `tests/…`) проверены на существование.
3. Маршруты API (`/api/v1/…`, `/health/…`) сверены с `Map*`-определениями в `src/**` с учётом `MapGroup`-префиксов.
4. Идентификаторы заданий Hangfire (`audit-integrity-full`, `quote-document-orphans`, `privacy-replay`, `brreg-registry-check`, `outbox-retention`, `entra-role-sync`, `entra-user-sync`, `reports-snapshot`, `outbound-operations`, `audit-integrity`, `privacy-retention`) — есть в коде.
5. Ключи конфигурации в обратных кавычках — свойства options в коде существуют (проверено по имени свойства для `Audit:Integrity:SettleTime`, `Auth:RequiredAcr`, `Auth:RoleGrace`, `Billing:StaleQuantityDays`, `Customers:MigrationChunkSize`, `Customers:MigrationRunStaleAfter`, `Integrations:Atera:WriteAllowedCustomerIds`, `Integrations:PartnerCenter:BillingReconciliationEnabled`, `Privacy:Retention:*` и др.).
6. Процедуры SQL `audit.ClearErasedPayloads`, `sales.ClearErasedDocuments`, `audit.ApplyRetention` — есть в миграциях; переменные `CRM_*` из runbooks есть в bicepparam, workflows или скриптах.
7. Подкоманды `tools/ops/restore.py` (`discover`, `points`, `restore`, `check`, `switch`, `cutback`, `restart`, `worker-off`, `worker-on`) совпадают с `--help`.
8. `az bicep build --file infra/main.bicep --stdout > /dev/null` — выход 0 (05.10.2026).

Не проверялось: фактическое выполнение команд `az`, `gh`, `curl`, SQL и KQL из runbooks; названия кнопок интерфейса.

### 6.1 Найденные устаревшие ссылки (ничего не исправлено)

| № | Runbook | Что написано | Что на самом деле | Серьёзность |
|---|---|---|---|---|
| R1 | `04-billing-export.md` §3 п. 2 | «`POST /api/v1/billing/bases/{id}/export`» | Такого маршрута нет. Есть `POST /api/v1/billing/bases/{id}/retry` и `POST /api/v1/billing/runs/{id}/export` (`BillingModule.cs`). Кнопка «Выгрузить снова» в тексте верна по смыслу, но API-вариант в тексте — мёртвая ссылка. | Мёртвый маршрут |
| R2 | `02-integrations.md` §5 п. 3 | «Запустить workflow Deploy» | Workflow `deploy.yml` нет; его заменили `release.yml` (в test) и `promote.yml` (в prod) в DEV-05. | Мёртвая ссылка на workflow |
| R3 | `08-database-permissions.md` §2 п. 1 | «Конвейер (`deploy.yml`) сам создаёт `id-crm-worker-<env>`» | `.github/workflows/deploy.yml` нет. Идентичность worker создаёт `tools/release/deploy.sh` (команда `az identity create`, только в режиме не-rollback). | Мёртвая ссылка на файл |
| R4 | `02-integrations.md` §5 п. 3 | `WriteEnabled` «включается переменной окружения контейнера `Integrations__PowerOffice__WriteEnabled` / `Integrations__Atera__WriteEnabled`» | В `infra/modules/apps.bicep` таких переменных нет; значение, добавленное вручную в контейнер, может быть перезаписано следующим развёртыванием шаблона (не проверено). Закрепляющего параметра Bicep нет. | Расхождение с инфраструктурой |
| R5 | `18-pilot-billing.md` §3 | «Atera и Partner Center: `WriteEnabled` = false» | У `PartnerCenterOptions` нет свойства `WriteEnabled` (интеграция только читает); флаг есть у PowerOffice и Atera. | Неточность |
| R6 | `04-billing-export.md` §2 и `02-integrations.md` §1.5, `03-database-restore.md` §10 | Ключ заказа `{период}-{клиент}-{прогон}` описан как защита от дубля | Это транспортный ключ одного основания; от повторного начисления в другом прогоне защищает реестр начислений (`CLAUDE.md`, `FINANCIAL_DESIGN.md`), фактический ключ — `{period}-{organizationId}-{runId}`. | Формулировка неполна |
| R7 | `15-monitoring.md` («Владельцы и включение») | Параметры `monitoring*` закрепляются в `infra/env/<env>.bicepparam` | В `prod.bicepparam` и `test.bicepparam` ни одного `monitoring*` параметра нет (не ссылка, а невыполненное действие). | Невыполненное предусловие |
| R8 | `16-migration.md` §6 | `/billing/charges/legacy` | Это API-маршрут `GET /api/v1/billing/charges/legacy` без префикса; SPA-маршрута с таким путём нет. | Неточный путь |
| R9 | `17-vulnerability-intake.md` §3 | `docs/claude-opus/evidence/DEV-21/register.md` | Файла нет; в тексте сказано «создаётся при первой записи» — не ошибка, но реестра находок и исключений ещё нет. | Информационно |

Вне runbooks: `evidence/DEV-11.md` и `PROGRESS.md` ссылаются на «runbook 03 п. 3a» — такого пункта в runbook 03 нет (есть `04 § 3a`); смысл — «хранилище документов не откатывать отдельно от базы» — содержится в runbook 03 §5 п. 5, §6.4, §8.3 и в `10-quote-documents.md` §3.

### 6.2 Сводка по runbooks

| № | Заголовок | Последний раздел | Проверено | Находки |
|---|---|---|---|---|
| 01 | Первое развёртывание окружения (test / prod) | §9 Откат | ссылки, `register-app.sh`, `release-settings.sh`, `rollback-compat.sh`, `restore.py worker-off`, `CRM_*`; `promote.yml` (`rollback`, `accept_schema_break`) | — |
| 02 | Подключение PowerOffice Go и Atera | §5 Azure | ключи конфигурации, `CRM_ENABLE_*` | R2, R4, R6 |
| 03 | Восстановление базы на момент времени | §12 После | `restore.py` (все подкоманды), `/admin/maintenance`, `/admin/jobs`, `/admin/audit`, задания Hangfire, `reconcile` | R6 (§10) |
| 04 | Биллинг-выгрузка прошла не полностью | §5 Закрытие | маршруты runs/bases/reconcile/cancel, `BIL_RECONCILE_FIRST`, `BIL_PERIOD_ALREADY_BILLED` | R1, R6 |
| 05 | Приостановить интеграцию во время инцидента | §5 После инцидента | `POST /api/v1/integrations/{system}/pause`, `/health/integrations` | — |
| 06 | Инцидент безопасности или утечка ПДн | §6 После | `/admin/audit`, `/admin/mappings`, `/api/v1/integrations/runs`, `USER_INACTIVE` | — |
| 07 | Ручной биллинг, когда CRM недоступна | §5 После | ссылки на 03, 04, 05; `manual-{ГГГГ-ММ}-{клиент}` (соглашение) | — |
| 08 | Права БД, неизменяемый аудит, retention и секреты | §6 Действия администратора БД | процедуры SQL, `Audit:Integrity:SettleTime`, правила в `monitoring-operations.bicep` | R3 |
| 09 | Недоставленные события | §7 Хранение | `/api/v1/integrations/outbox`, `/outbox/replay`, `outbox-retention`, ошибка 51041 (в миграции Contracts) | — |
| 10 | Документы предложений | §5 Что нельзя | `SAL_DOCUMENT_UNAVAILABLE`, `quote-document-orphans` | — |
| 11 | Записевой охват | §4 Что нельзя | `GET /api/v1/admin/record-scope`, `/admin/record-access`, `recordScope` | — |
| 12 | Роли и сессии | §6 Что нельзя | `entra-role-sync`, `entra-user-sync`, `AUTH_REVERIFY_REQUIRED`, `Auth:*` | — |
| 13 | Персональные данные | §7 Чего не делать | процедуры оператора, `Privacy:Retention:*`, `privacy-replay`, `PRV_*` | — |
| 14 | Power BI | §7 Если обновление не проходит | `/api/v1/bi/v1/…`, `CRM_BI_*`, `reports-snapshot`, роли `Crm.Bi.*` | — |
| 15 | Мониторинг и разбор исключений | Протокол EXT-01 для мониторинга | правила Bicep, `/api/v1/integrations/monitoring`, параметры `monitoring*`, `Monitoring:*` | R7 |
| 16 | Пробная миграция и переключение | §9 План отказа | маршруты `organizations/import[/runs…/reconcile]`, `Customers:Migration*` | R8 |
| 17 | Приём уязвимостей | §6 Обзор зависимостей и сканеры | `SECURITY.md`, `release-settings.sh`, workflows, `tools/release/release.py scan-secrets` | R9 |
| 18 | Параллельный месячный пилот биллинга | §10 Критерии завершения | маршруты `trace`, `pilot/*`, `pilot-readiness`, `pilot/kpi`, SPA `/billing/runs/{id}/pilot`, файлы evidence DEV-22 | R5 |
