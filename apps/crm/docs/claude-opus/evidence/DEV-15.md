# DEV-15 — доказательства выполнения

## Версия и среда

- Дата/исполнитель: 03–04.10.2026, Claude Opus 5.5 в Claude Code.
- Версия: ветка `codex/readiness`, от коммита DEV-00 `4bcf3a1`; изменения DEV-15 — следующий коммит (SHA в [PROGRESS](../PROGRESS.md)).
- Среда: macOS arm64, .NET SDK 10.0.401, Microsoft Testing Platform 2.4.0 + xUnit v3 4.0.1, `Microsoft.Testing.Extensions.CodeCoverage` 18.11.2, Node 24.19.0, Playwright 1.63.0 (Chromium 1243, Firefox 155.0 build 1543, WebKit 26.6 build 2359), Docker 29.5.3, SQL Server 2022 в Testcontainers и во временных контейнерах `crm-e2e-dev15-*` (создавались и удалялись скриптом прогона), Ruby 2.6 для локального прогона шагов CI.
- Данные: только синтетические (Testcontainers, временные E2E-базы, WireMock и dev-mocks).
- Область: тестовая инфраструктура и CI. Продуктовый код не менялся.

## Подтверждённая проблема и реализация

**E2E без гонки периода (A14).** Было: `freeBillingPeriod` читал список прогонов и возвращал первый свободный месяц, прогон создавался позже; параллельные workers брали один месяц (DEV-00: 37/38, BIL_PERIOD_BUSY 2040-01). Стало:

- `reserveBillingRun` занимает месяц созданием прогона: уникальный индекс открытого периода (BR-BIL-01) делает захват атомарным, занятый месяц отвечает 409 и берётся следующий. Чтение списка — только подсказка. Прогоны через API — с 2040 по 2079.
- Тест с диалогом создаёт прогон сам в 2080+ и при «already open/already exists» переходит к следующему месяцу; договор создаётся после захвата и покрывает ровно этот месяц.
- Тестовые договоры биллинга получили дату окончания в своём месяце. Найдено нагрузочным прогоном: бессрочный договор одного теста попадал в прогоны других тестов более поздних месяцев, и клиент получал второй счёт.
- `collectedBillingRun` больше не переиспользует чужие прогоны.
- a11y: проверка ориентира `main` по элементу, а не по роли. Модальный диалог скрывает остальную страницу от assistive technology в момент, зависящий от нагрузки; при 6 workers это давало ложное падение.
- Конфигурация Playwright: `failOnFlakyTests: true` (тест, прошедший только на retry, роняет прогон); существующие hosts переиспользуются только при `E2E_REUSE_SERVERS=1`; защита `E2E_SQL` — только локальный сервер и имя базы `crm_e2e…`; crm-web по HTTPS на development-сертификате (`ignoreHTTPSErrors`). Причина HTTPS: WebKit не хранит Secure-cookie сессии на http://localhost, Chromium и Firefox хранят.

**Архитектурная полнота.** `tests/Crm.ArchitectureTests/Production.cs` находит модули по папкам `src/Modules/<Имя>` (`Crm.<Имя>` и `Crm.<Имя>.Contracts`; Contracts → `Crm.Contracts.Contracts`) и интеграции по `src/Integrations`. Все правила берут списки оттуда, Projects и CustomFields участвуют во всех применимых правилах (54 → 67 тестов). `CompletenessTests`:

- каждый проект `src/` (кроме недеплоимого AppHost) загружается из crm-web/crm-worker;
- каждый `.csproj` из `src/` и `tests/` есть в `Vardahei.Crm.slnx`;
- в папке модуля нет проектов неизвестной формы;
- у каждого модуля есть пространство `Domain`, кроме явно перечисленных Audit и Reports;
- у каждого модуля свой `ModuleDbContext` с `public const string SchemaName`, совпадающим со `Schema`; схемы уникальны; кроме Reports, у которого схемы нет до ADR (DEV-14).

**Покрытие NFR-10.** Пакет `Microsoft.Testing.Extensions.CodeCoverage` 18.11.2 (зависит ровно от MTP 2.4.0) во всех тест-проектах; `tools/coverage/coverage-gate.py` объединяет отчёты Cobertura и проверяет два порога. Критический домен — `src/Modules/{Billing,Contracts,TimeTracking}/*/Domain/` ≥ 90 %, остальной `src/` ≥ 70 %. Печатаются covered/coverable строки и исключения: миграции и snapshots, *.Designer.cs, сгенерированное в obj/, AppHost. Проект, который не загружает ни один тест, вне denominator назван явно и роняет gate без `--allow-unmeasured`; в CI разрешён только `Crm.Worker`, composition root без логики. Branch coverage выводится справочно. Архитектурные тесты идут без coverage: инструментирование добавляет в каждую сборку типы, которые правила зависимостей видят как нарушения (проверено: 21 ложное падение под `--coverage`).

На baseline критический домен был **85.60 % (755/882) — gate красный**. Добавлены поведенческие доменные тесты для непокрытых правил договоров, пакетов часов и записей времени (`ContractRulesTests`, `HourBankRulesTests`, `TimeEntryRulesTests`, 25 тестов): изменение закрытого договора, перенос только черновика, событие SLA для действующего договора, notice/end/line rules, слияние и отмена, журнал пакета часов, редактирование и отзыв записи времени. После них — **95.58 % (843/882)**; остальной backend — 84.98 % (14 398/16 942). Billing-домен по файлам ещё ниже 90 % (BillingRun 82.4 %, PendingCharge 77.3 %). Его перестраивают DEV-01…03, они же добавляют покрытие.

**Негативные права и конкурентность** (`AccessAndConcurrencyTests`):

- матрица прав по всем `/api` endpoints запущенного приложения: для каждой роли без нужного разрешения (политики `perm:a|b`, все политики endpoint) запрос должен получить 403 — **609 запросов на 210 endpoints, все 403**; новые endpoints попадают в матрицу автоматически;
- 10 параллельных `POST /runs` одного периода: ровно один 201, остальные 409, ни одного 5xx, в БД один открытый прогон;
- изменение основания: без If-Match — 428, устаревший ETag — 412 без изменения суммы.

**Нестабильность integration-набора, найдена и исправлена.**

- `WebApplicationFactory` хранит созданные HttpClient в небезопасном для потоков `List`. Параллельные тест-классы портили список, и `DisposeAsync` падал с `NullReferenceException` для всей сборки (DEV-00: 1 из 4 прогонов). `CrmWebFactory` создаёт клиентов под lock. После исправления — 0 таких ошибок в 39 прогонах.
- `Outbox_processor_dispatches_events_to_handlers` делал один проход outbox, хотя сообщение мог захватить параллельный процессор. Теперь тест ждёт отметку обработки.
- Основной billing-тест закрывал прогон, не дождавшись экспорта чужих оснований в нём. Добавлен `WaitForRunExportAsync`.

**Найденные дефекты продукта** (не маскируются, переданы в карточки):

1. Гонка двух `CreateRun` одного периода отвечает `409 DUPLICATE` (нарушение уникального индекса) вместо `BIL_PERIOD_BUSY`; пользователь видит общее сообщение. Инвариант одного открытого прогона БД держит. → DEV-03, шаг 1.
2. Параллельный экспорт двух оснований одного прогона: `BillingApi.UpdateRunStatusAsync` падает с `DbUpdateConcurrencyException` внутри `MarkExportedAsync`/`MarkExportFailedAsync`. Исходящая операция записывается как ошибка **после** создания заказа и ставится на повтор, прогон может остаться в `Exporting` (it-final-15). → DEV-07, DEV-03.
3. Один раз из 8 прогонов (it-stable-8) один и тот же заказ (одинаковый `ExternalImportReference`) отправлен в PowerOffice дважды. Механизм ещё не установлен. Заглушка PowerOffice всегда отвечает «не найден» на поиск по reference, поэтому единственная защита CRM в тестах отсутствует; обработчик не проверяет локальный статус экспорта. Основной billing-тест теперь печатает время каждой отправки. → DEV-07, DEV-19 (EXT-03).

Основной billing integration-тест поэтому может изредка краснеть (1 из 25 финальных прогонов, дефект 2). Это истинный сигнал дефекта продукта, а не шум теста; он зарегистрирован, проверка не ослаблялась.

Изменённые файлы: `.github/workflows/ci.yml`, `Directory.Packages.props`, `tests/Directory.Build.props`, `tests/Crm.ArchitectureTests/{Production,CompletenessTests,ModuleBoundaryTests}.cs`, `tests/Crm.IntegrationTests/{AccessAndConcurrencyTests,BillingApiTests,BillingRegressionApiTests,CrmWebFactory,CustomersApiTests,IntegrationTestHelpers}.cs`, `tests/Crm.UnitTests/{ContractsDomainTests,TimeTrackingDomainTests}.cs`, `tools/coverage/coverage-gate.py`, `web/playwright.config.ts`, `web/e2e/support.ts`, `web/e2e/{billing,a11y,organizations,quotes,sales-licensing,search-and-export,service-time}.spec.ts`, документация: README, CLAUDE.md, docs/07-nfr-devops.md, VALIDATION.md. Миграций, permissions, API и i18n изменения не касаются.

## Проверка критериев

| AC | Входные данные / действие | Ожидаемый результат | Фактический результат | Статус | Тест/протокол/артефакт |
|---|---|---|---|---|---|
| DEV-15-AC01 | Полный E2E (50 тестов: Chromium + @critical в Firefox/WebKit), 3 workers, новая БД на каждый прогон; нагрузочный прогон billing+a11y ×3 при 6 workers; пробный flaky-тест | Два полных прогона без конфликтов периодов; retry не скрывает первое падение | final1 50/50 и final2 50/50 (22:41–22:46 UTC); stress3 24/24 при 6 workers; без retry локально; тест, прошедший на retry, даёт exit 1 (`failOnFlakyTests`) | pass | [e2e-runs](DEV-15/e2e-runs.log.txt) |
| DEV-15-AC02 | Временный модуль `Crm.Probe` во временном worktree: (A) не подключён, (B) подключён и использует тип реализации Billing | Тест полноты падает при модуле вне правил | A: 28 падений, в том числе «not referenced by crm-web or crm-worker» и «missing from Vardahei.Crm.slnx»; B: модуль автоматически вошёл во все правила (70 тестов), нарушение названо (`Crm.Probe.ProbeModule`), падают проверки Domain и схемы | pass | [arch-probe](DEV-15/arch-probe.log.txt) |
| DEV-15-AC03 | Шаги job `backend` из ci.yml выполнены локально по порядку (`RUNNER_TEMP`, `GITHUB_STEP_SUMMARY`); gate на отчётах до и после доменных тестов | CI публикует coverage с явным denominator и падает ниже порога | До тестов: 85.60 % < 90 % → `FAILED`, exit 1. После: 95.58 % / 84.98 % → passed, summary с denominator записан в step summary. Без allowlist `Crm.Worker` и при пороге 96 % gate падает. Job в целом красный из-за известных регрессий DEV-00. Сам GitHub Actions не запускался (remote нет), upload-artifact локально заменён перечнем файлов | pass | [ci-local](DEV-15/ci-local-backend.txt), [до](DEV-15/coverage-before-domain-tests.md), [после](DEV-15/coverage-after-domain-tests.md), [решения gate](DEV-15/coverage-gate-decisions.txt) |
| DEV-15-AC04 | Регрессии DEV-00 (домен и API) | Проверяют инварианты и подтверждают нарушения; прохождение после исправления — в DEV-01/02/03 | 5 unit и 5 integration регрессий красные именно на инвариантах (1900 вместо 900, Approved одним человеком, 15 000 повторно) | pass | [evidence DEV-00](DEV-00.md), [integration-repeats](DEV-15/integration-repeats.log.txt) |
| DEV-15-AC05 | 6 сценариев `@critical` в Chromium/Firefox/WebKit; WebKit без установленного runtime | Проходят во всех трёх; отсутствие runtime — gap, а не pass | final1/final2: все 6 в каждом браузере проходят; без runtime — `Executable doesn't exist`, тест failed, exit 1. WebKit Playwright ≠ Safari macOS/iOS: проверка на реальных устройствах — DEV-18/EXT-10 | pass | [e2e-runs](DEV-15/e2e-runs.log.txt) |
| DEV-15-AC06 | Поиск ключей и операций очистки БД в tests/e2e/dev-mocks; попытки E2E с удалённым сервером и чужой базой | Нет реальных ключей поставщиков; чужая/рабочая БД не очищается | Только `test-*`/`mock`; кода DROP/TRUNCATE/DELETE/EnsureDeleted нет; integration — собственный Testcontainer; E2E отказывается: «points to crm-prod…» и «uses the database "crm"» | pass | Этот файл, раздел «Запуски» |

## Запуски

| Время (UTC) | Команда | Exit | Результат |
|---|---|---|---|
| 22:02–22:05 | E2E полный, http (run1) | 1 | 44 passed, 6 failed — все WebKit: редирект на `/bff/login` (Secure-cookie на http) |
| 22:05–22:07 | E2E `--project webkit` по HTTPS (run2) | 0 | 6/6 |
| 22:07–22:12 | E2E полный ×2 (full1, full2) | 0/0 | 50/50, 50/50 (до ограничения договоров и исправления a11y) |
| 22:12–22:20 | E2E billing+a11y `--repeat-each 3 --workers 6` (stress, stress2, stress3) | 1/1/0 | 7 failed → 1 failed → 24/24 (`DUPLICATE` вместо BUSY, чужой договор в счёте, a11y-ориентир) |
| 22:41–22:46 | E2E полный ×2 (final1, final2), финальный код | 0/0 | 50/50, 50/50 |
| 22:46 | WebKit без runtime | 1 | failed: `Executable doesn't exist` |
| 22:23–22:24 | build Release; unit/arch/integration с coverage; gate | 0/2/0/2/1 | 0/0; 257 (5 известных red); 67/67; 88 (5 известных red); критический домен 85.60 % → FAILED |
| 22:24–22:40 | integration ×39 (it-repeat 6, it-stable 8, it-final 25) | 2 (известные) | Teardown-ошибок 0. Сверх известных 5: it-repeat-6 (закрытие до экспорта, исправлено в тесте), it-stable-4 (однопроходный outbox-тест, исправлено), it-stable-8 (двойной заказ — дефект 3), it-final-15 (`Exporting` — дефект 2) |
| после доменных тестов | unit с coverage, integration с coverage, gate | 2/2/0 | unit 282 (5 известных red); integration 88 (5 известных red, иных нет); 95.58 % / 84.98 % passed |
| после доменных тестов | шаги job `backend` из ci.yml локально | job FAILED | Restore, Build, Vulnerable packages, Architecture, Coverage gate — success; Unit и Integration — failure только из-за известных регрессий DEV-00 |
| перед коммитом | frontend lint, typecheck, vitest | 0/0/0 | 29/29 |

Зарегистрированные красные проверки: 5 unit + 5 integration регрессий DEV-00 (→ DEV-01/02/03); интермиттентный основной billing-тест из-за дефектов 2–3 (→ DEV-07). Новых неожиданных ошибок нет: каждое иное падение разобрано, исправлено в тесте или отнесено к воспроизведённому дефекту продукта с карточкой.

## Данные и обратимость

Только тестовая инфраструктура и CI; схема, миграции и бизнес-данные не менялись. Временные контейнеры `crm-e2e-dev15-*`, worktree с пробным модулем и пробный flaky-spec удалены. Существующая общая `crm_e2e` локального контейнера не использовалась (E2E шли на временных базах). Откат — отмена коммита DEV-15. Заметное следствие для разработчиков: E2E теперь требует development-сертификат ASP.NET Core (`dotnet dev-certs https`) и браузеры Firefox/WebKit.

## Самопроверка и остаточные риски

Проверены diff, отсутствие ослабленных утверждений, увеличенных таймаутов и retries как исправления, отсутствие skip. Проверку выполнял тот же агент — это не независимый review.

- GitHub Actions на реальном runner не выполнялся (remote отсутствует); шаги проверены локальным исполнением.
- Пороги NFR-10 соблюдаются по агрегату; файлы Billing-домена ниже 90 % до DEV-01…03.
- Дефекты 1–3 продукта открыты и переданы в DEV-03/07/19; основной billing-тест может изредка краснеть до DEV-07.
- WebKit Playwright не заменяет Safari на реальных устройствах; браузерная матрица сотрудников подтверждается в DEV-18/EXT-10.

Итоговый статус: **code_verified**. Внешних gates у карточки нет; accepted оставлено владельцу/независимому review.
