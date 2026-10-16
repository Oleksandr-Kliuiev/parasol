# DEV-06 — доказательства выполнения

## Версия и среда

- Дата/исполнитель: 04.10.2026, Claude Opus 5.5 в Claude Code.
- Версия: ветка `codex/readiness`, от коммита DEV-05 `500546d`; изменения DEV-06 — следующий коммит (SHA в [PROGRESS](../PROGRESS.md)).
- Среда: как в [DEV-15](DEV-15.md); SQL Server 2022 в Testcontainers и временных контейнерах (`crm-health-dev06`, `crm-rollback-*`, удалены).
- Данные: только синтетические. Azure не использовался: пробы Container Apps проверены сборкой Bicep и архитектурным тестом, поведение хостов — локально.
- Область: readiness (БД и схема с ограниченным временем), liveness без БД, heartbeat и контроль цикла обработки crm-worker, диагностика для администраторов, пробы web/worker в Bicep, ожидание готовности worker в развёртывании, документация.

## Подтверждённая проблема и реализация

**До.** `AddServiceDefaults` регистрировал одну проверку `self` с тегом `live`, а `/health/ready` выбирал теги `ready` или `live` — то есть readiness был тем же «процесс жив». Воспроизведено на предыдущей сборке (`500546d`): crm-web с базой, которой нет (`127.0.0.1,9`), отвечает `/health/ready → 200 Healthy` ([протокол](DEV-06/previous-build-without-database.txt)); docs/07 при этом обещал «SQL, Key Vault, Blob». У crm-worker не было ни проб в Bicep, ни признака того, что обработка идёт: зависший цикл outbox при живом процессе не был виден.

**После:**

- `DatabaseReadinessCheck` (Crm.Infrastructure, тег `ready`, оба хоста): отдельное соединение вне пула с connect timeout 3 с и `SELECT 1`, ответ не позже 3,5 с даже если SqlClient ждёт дольше (первый вариант с пулом при «замороженном» SQL отвечал за 8 с — найдено проверкой на реальном worker и исправлено); раз в 5 минут — отсутствие неприменённых миграций этой сборки. Ответ проб — только слово статуса; описание проверки без сервера, логина и ошибки, исключение — только в журнал.
- Liveness не зависит от БД: в crm-web — процесс; в crm-worker добавлена проверка `outbox-loop` по раундам цикла в памяти (`ProcessingLoopMonitor`, 10 мин без раунда — Unhealthy, платформа перезапускает). Цикл завершает раунд досрочно, если база недоступна (`DatabaseUnavailable`: исчерпаны повторы EF, таймаут, сетевые коды SQL), чтобы долгие таймауты при недоступной БД не превращались в перезапуски; ошибка данных одного контекста раунд не прерывает.
- Heartbeat: цикл outbox после раундов (не чаще раза в 30 с, не дольше 10 с и без наложения) и задача Hangfire `worker-heartbeat` раз в минуту пишут `integration.WorkerHeartbeats` (строка на компонент и экземпляр, строки ушедших экземпляров удаляются через неделю). `/health/details` (право `integrations.manage`) показывает проверки с длительностью и возраст heartbeat; старше 3 минут — `stale`, общий статус `Degraded`.
- `AddOutboxProcessing()` регистрирует цикл вместе с его liveness; worker больше не регистрирует `OutboxProcessor` напрямую. `--migrate-only` завершается до запуска хоста — фоновая обработка в задаче миграций не стартует (архитектурный тест).
- Bicep: у crm-web таймауты проб (readiness 5 с), у crm-worker появились liveness/readiness/startup — новая ревизия worker без доступа к SQL не заменяет работающую; `deploy.sh` ждёт `healthState = Healthy` новой ревизии worker. Smoke (`/health/ready = Healthy`) теперь проверяет базу.

Изменённые и новые файлы: `src/BuildingBlocks/Crm.Infrastructure/{Health/DatabaseReadinessCheck.cs, Health/ProcessingHealth.cs, Health/HealthRegistration.cs (новые), Outbox/OutboxProcessor.cs, DependencyInjection/ModuleRegistration.cs}`, `src/Integrations/Crm.Integrations.Core/{WorkerHeartbeats.cs (новый), IntegrationsCoreModule.cs, Persistence/IntegrationDbContext.cs, Persistence/Migrations/*WorkerHeartbeats*, снимок}`, `src/Hosts/Crm.Web/{Program.cs, Http/HealthEndpoints.cs (новый)}`, `src/Hosts/Crm.Worker/Program.cs`, `infra/modules/apps.bicep`, `tools/release/{deploy.sh, test_deploy.py, release.py, test_release.py}` (шаблон пароля в проверке секретов больше не считает секретом ссылку `$pw`/`{pw}` и маску `***`), `web/e2e/billing.spec.ts` (запас времени сценария дополнительного прогона), тесты (`ServiceHealthTests`, `TcpToggleProxy`, `ProcessingHealthTests` — новые; `CrmWebFactory`, `ReleasePipelineTests`), docs/07 §4.3, CLAUDE.md.

## Проверка критериев

| AC | Входные данные / действие | Ожидаемый результат | Фактический результат | Статус | Тест/протокол/артефакт |
|---|---|---|---|---|---|
| DEV-06-AC01 | (а) Второй экземпляр crm-web ходит в SQL через TCP-прокси; прокси «падает» (рвёт соединения, не принимает новые). (б) Реальный crm-worker на временной БД; SQL-контейнер приостановлен (`docker pause`, соединения висят). (в) Предыдущая сборка без БД | Live успешен, ready — неуспех за ограниченное время | (а) `/health/live` 200 `Healthy`, `/health/ready` 503 `Unhealthy` быстрее 6 с. (б) live 200 за 20–25 мс в течение паузы; ready 503 за 3044 и 3032 мс. (в) до исправления: ready 200 `Healthy` без БД | pass | `ServiceHealthTests.AC01_AC02_…`, [worker](DEV-06/worker-host-sql-paused.txt), [предыдущая сборка](DEV-06/previous-build-without-database.txt) |
| DEV-06-AC02 | Прокси/SQL возвращаются | Ready восстанавливается без ручного пересоздания данных | (а) ready снова 200 (опрос до 20 с), API читает данные той же БД; (б) после `docker unpause` ready 200 за 22 мс | pass | `ServiceHealthTests.AC01_AC02_…`, [worker](DEV-06/worker-host-sql-paused.txt) |
| DEV-06-AC03 | Экземпляр с адресами PowerOffice, Atera и Partner Center на закрытом порту: создание организации-клиента и контакта, обработка outbox и исходящей очереди (обработчики и отправки падают), чтение и новое создание | Отказ Atera/PowerOffice не выключает независимый CRUD | Создание и чтение проходят; после отказов интеграций `/health/ready` 200, организация находится поиском, следующая создаётся. Внешние системы в readiness не входят | pass | `ServiceHealthTests.AC03_…` |
| DEV-06-AC04 | Экземпляр с циклом outbox и короткими порогами (heartbeat 2 с, цикл 3 с); событие, обработчик которого не возвращается | Worker с остановленной обработкой при живом HTTP имеет просроченный heartbeat | До сбоя: live 200, heartbeat `outbox` свежий. После: процесс отвечает, `/health/live` 503 `Unhealthy`, heartbeat `stale`, возраст ≥ 2 с, `/health/details` — `Degraded`/`Unhealthy`. После освобождения обработчика live и heartbeat восстанавливаются сами. Юнит: 10 мин без раунда — Unhealthy; раунд прерывается только при недоступной БД | pass | `ServiceHealthTests.AC04_…`, `ProcessingHealthTests.*` |
| DEV-06-AC05 | (а) Пустая база без миграций, затем запуск с миграциями. (б) Тексты ответов проб при отказе и `/health/details` для анонима, Sales и Admin. (в) Миграции и старт на пустой БД в проверке на реальном worker и в E2E | Миграции и startup на пустой БД проходят; health не раскрывает секреты/SQL | (а) без миграций ready 503 (схема отстаёт), после запуска с миграциями ready 200 `Healthy`. (б) пробы — только слово статуса; `/health/details`: аноним — вход, Sales — 403, Admin — проверки с длительностью и heartbeat, без пароля, логина, адреса сервера, «Exception»/«SqlClient». (в) мигратор: `Applied and verified … 15 schemas`, worker стартует, heartbeat записан | pass | `ServiceHealthTests.AC05_…` (2), [worker](DEV-06/worker-host-sql-paused.txt), [e2e](DEV-06/e2e.txt) |

## Запуски

| Время (UTC, 04.10.2026) | Команда | Exit | Результат |
|---|---|---|---|
| 03:05–03:10 | Новые тесты здоровья; полный интеграционный набор | 0 | 5/5; 132/132 ([сводка](DEV-06/integration.txt)) |
| 03:11–03:13 | Реальный crm-worker на временной БД (`crm-health-dev06`, удалена): старт, пауза и возврат SQL ([скрипт](DEV-06/worker-host-run.sh)) | 0 | Первая версия: ready при «замороженном» SQL — 8049 мс → исправлено (соединение вне пула, бюджет 3,5 с); повтор: 3044/3032 мс, live 20–25 мс, восстановление 22 мс ([протокол](DEV-06/worker-host-sql-paused.txt)) |
| 03:15–03:19 | `rollback-compat.sh 500546d` (DEV-05 на схеме DEV-06), параллельно с линтерами и тестами инструментов | 1 | 53/54: сценарий дополнительного прогона упёрся в общий таймаут 180 с, ожидая экспорт ([лог](DEV-06/rollback-compat-500546d-run1.txt)) |
| 03:20–03:23 | Тот же прогон без параллельной нагрузки | 0 | 54/54 ([лог](DEV-06/rollback-compat-500546d.txt)); запас времени сценария увеличен (300 с, ожидание экспорта до 240 с) |
| 03:24 | Предыдущая и текущая сборка crm-web без БД | — | до: ready 200; после: ready 503 ([протокол](DEV-06/previous-build-without-database.txt)) |
| 03:24–03:26 | Шаги job'ов `backend` и `infrastructure` из ci.yml | **PASSED** | Unit 357/357, Architecture 83/83, Integration 132/132, Coverage: домен 96.41 % (1262/1309), backend 85.50 % (15 405/18 017); тесты инструментов выпуска 27/27, Bicep ([backend](DEV-06/ci-local-backend.txt), [infrastructure](DEV-06/ci-local-infrastructure.txt), [покрытие](DEV-06/coverage-summary.md)) |
| 03:26–03:29 | Полный E2E (новая БД, сборка SPA) | 0 | 54/54 ([список](DEV-06/e2e.txt)) |

**Известных красных проверок нет.**

## Данные и обратимость

Миграция `WorkerHeartbeats` (integration) только добавляет таблицу — expand; архитектурное правило expand/contract её пропускает, разрывов схемы нет. Проверено, что предыдущий релиз работает на новой схеме: E2E релиза DEV-05 (`500546d`) на схеме DEV-06 — 54/54 (повтор без параллельной нагрузки; первый прогон под нагрузкой — 53/54 из-за таймаута теста, см. «Запуски»). Проверки схемы на пробе обратно совместимы: старая ревизия видит в базе «лишние» новые миграции и остаётся готовой; не готова только сборка, чьих миграций в базе нет. Пробы не выполняют тяжёлых запросов: `SELECT 1` на каждую пробу, история миграций — раз в 5 минут. Откат — удалить таблицу (`Down`), данных бизнеса в ней нет.

## Самопроверка и остаточные риски

Самопроверка (не независимое review): diff, сценарии «база недоступна» (отказ соединения и «зависший» сервер), восстановление, зависший обработчик, отказ поставщиков, пустая база, утечки в ответах проб и диагностики, права на `/health/details`. Найдено и исправлено при самопроверке: проба через пул при зависшем сервере отвечала 8 с (теперь ≤ 3,5 с); цикл outbox при «чёрной дыре» сети мог бы часами ждать таймаутов всех контекстов и тем самым связать liveness с БД — раунд прерывается при недоступной базе.

Остаточные риски: значения порогов (3 мин heartbeat, 10 мин цикл) — исходные, уточняются с алертами в DEV-17; поведение проб в Azure (метка ревизии, healthState worker) проверяется первым развёртыванием (EXT-11, DEV-05); Key Vault/Blob в readiness не входят — ключи Data Protection читаются при старте, их отказ виден при запуске ревизии.

Статус **code_verified**: внешнего gate у карточки нет, все AC проверены локально.
