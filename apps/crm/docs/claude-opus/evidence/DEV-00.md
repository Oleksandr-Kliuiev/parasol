# DEV-00 — доказательства выполнения

## Версия и среда

- Дата/исполнитель: 03.10.2026 (Europe/Oslo), Claude Opus 5.5 в Claude Code по поручению владельца; git-пользователь репозитория — Oleksandr Kliuiev.
- Baseline: коммит `2bed19e5520ac4061cbf1ad2e680a8a2b6e79320` на `main` (tree `ce72b52c30ab3815751137cc171d575c94011996`), первый коммит репозитория. Регрессии и это evidence — следующий коммит на рабочей ветке `codex/readiness` (родитель `2bed19e`); его SHA записан в [PROGRESS](../PROGRESS.md), так как файл не может содержать хеш собственного коммита.
- Среда: macOS (arm64), .NET SDK 10.0.401 из `~/.dotnet` (pin в global.json), Microsoft Testing Platform + xUnit v3 4.0.1, Node 24.19.0 / npm 11.17.0, Docker 29.5.3 (Docker Desktop, 7.75 GB), SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`, amd64 под эмуляцией) через Testcontainers 4.15.0, Playwright 1.63.0 / Chromium, Python 3.14.7.
- Данные: только синтетические. Реальные данные не используются: для crm-web/crm-worker нет user-secrets (`~/.microsoft/usersecrets/vardahei-crm` отсутствует), у AppHost только служебные параметры Aspire (выведены лишь имена ключей), appsettings не содержат ключей интеграций, локальные базы наполнены dev-mocks и E2E. Значения секретов не выводились.
- Область: baseline, регрессионные тесты, базовые проверки и инвентаризация. Продуктовый код, схема и данные не менялись.

## Подтверждённая проблема и реализация

**Baseline (AC01).** До DEV-00 в репозитории не было коммитов, все исходники были untracked. Сверка с [source-snapshot.sha256](../../audits/2026-10-03/source-snapshot.sha256): 597 из 597 файлов совпадают по SHA-256 (`shasum -a 256 -c`). Вне снимка аудита лежат корневые файлы (.editorconfig, .gitignore, README, CLAUDE.md, dotnet-tools.json), docs, tools и пакет — они ожидаемо в снимок не входили.

Коммит собран из явного списка 670 файлов (`git add --pathspec-from-file`), без `git add .`. Три журнала аудита (`docs/audits/2026-10-03/*.log`) добавлены принудительно: правило `*.log` их игнорировало, а отчёт аудита на них ссылается. Намеренно не включены и оставлены на диске без изменений:

- `.claude/launch.json` — машинная настройка с абсолютным путём к `~/.dotnet`;
- `docs/claude-opus-development-pack-2026-10-03.zip` и распакованная рядом копия (47 файлов) — архив поставки и его дубликат, содержимое которого уже лежит в `docs/claude-opus` и в истории аудита.

Полный manifest рабочей копии на момент baseline, включая исключённые файлы (719 записей), — [working-copy-2026-10-03.sha256](DEV-00/working-copy-2026-10-03.sha256), SHA-256 самого файла `cbbd30fa561d2e32796d71d9a1db67c16820a8adfd9344dde23df792d0675da6`. Ничего не удалялось, reset/clean не выполнялись, push не выполнялся (remote отсутствует).

Проверка секретов перед коммитом: поиск по паролям, ключам, токенам, PEM, ключам AWS/GitHub/Slack во всех кандидатах и журналах аудита. Найден только задокументированный одноразовый пароль SA локального контейнера (`README.md`, `appsettings.Development.json` обоих hosts, `web/playwright.config.ts`, service container в `ci.yml`). Это не рабочий секрет; риск — повторное использование такого пароля где-либо ещё. Строки подключения E2E предлагается перевести на переменные окружения в DEV-15. Реальных ключей поставщиков в дереве нет: тесты используют `test-*`/`mock`.

Самодостаточность baseline проверена на чистой копии коммита (`git worktree add --detach … 2bed19e` во временной папке, затем удалена): `dotnet build -c Release` собрал 43 проекта без предупреждений; unit 252/252, architecture 54/54; `npm ci`, lint, typecheck, vitest 29/29 и production build 282.7 KB прошли. То есть в коммите нет зависимости от исключённых файлов.

**Регрессии (AC02–AC04).** Тесты утверждают требуемый инвариант, а не поведение аудированного кода, поэтому сейчас красные. Они помечены `[Trait("Regression", "A0x")]`, не пропускаются и не маскируются.

| Дефект | Тест | Уровень | Фактический результат на baseline |
|---|---|---|---|
| A01 | `Crm.UnitTests.BillingRegressionTests.A01_a_corrected_line_stays_one_position_at_the_corrected_amount_when_its_source_is_collected_again` (1 и 10 пересборок) | домен | `basis.TotalExVat should be 900m but was 1900m` в обоих случаях |
| A01 | `Crm.IntegrationTests.BillingRegressionApiTests.A01_a_corrected_line_stays_one_position_at_the_corrected_amount_after_the_run_is_collected_again` | API, SQL | `totalExVat should be 900m but was 1900,00m` |
| A02, тот же человек | `BillingRegressionTests.A02_one_person_cannot_give_both_approvals_by_signing_the_second_one_first` | домен | `run.Status should not be Approved but was Approved` |
| A02, тот же человек | `BillingRegressionApiTests.A02_a_user_with_both_approval_rights_cannot_release_a_run_alone_by_signing_the_second_approval_first` (Admin: second-approve, затем approve) | API | статус прогона `Approved` |
| A02, устаревшее согласование | `BillingRegressionTests.A02_an_approval_given_before_a_recollect_does_not_count_for_the_recollected_content` | домен | `Approved` |
| A02, устаревшее согласование | `BillingRegressionApiTests.A02_a_first_approval_does_not_carry_over_to_a_recollected_run_with_other_content` (Finance одобряет 300 000, договор получает строку 50 000, пересборка даёт 350 000, Management ставит вторую подпись) | API | `Approved` без одобрения Finance для 350 000 |
| A02, порог после ручной правки | `BillingRegressionTests.A02_a_manual_line_that_lifts_a_basis_over_the_threshold_needs_a_second_approval` | домен | `Approved` при основании 310 000 |
| A02, порог после ручной правки | `BillingRegressionApiTests.A02_a_manual_line_that_lifts_a_basis_over_the_threshold_cannot_pass_with_one_approval` (сбор 10 000, `requiresSecondApproval=false`, ручная строка 300 000, одно approve) | API | `Approved` одним согласующим |
| A03 | `BillingRegressionApiTests.A03_a_second_run_for_an_exported_and_closed_month_does_not_bill_the_contract_month_or_the_hour_purchase_again` | API, SQL, WireMock PowerOffice | первый прогон: основание 15 000 (5 000 договор + 10 ч × 1 000 пакет), экспорт заказом 9401, закрытие; второй прогон того же месяца создан и собрал **15 000 снова**: `billedAgain should be 0m but was 15000,00m` |

Тест A03 проверяет экономический дубль через новый runId (а значит и новый ключ экспорта), а не повтор одного outbound-запроса. Если после DEV-03 обычный прогон закрытого месяца будет отклоняться с 409, тест считает инвариант соблюдённым; путь дополнительного прогона отдельно покрывает DEV-03-AC01.

Изменённые файлы:

- `tests/Crm.UnitTests/BillingRegressionTests.cs` — новый (SHA-256 `3c374379…7409c`);
- `tests/Crm.IntegrationTests/BillingRegressionApiTests.cs` — новый (SHA-256 `089a877f…d557d`);
- `tests/Crm.IntegrationTests/BillingApiTests.cs` — `LinkAsync` и `StubToken` стали `internal` для повторного использования, поведение не изменилось;
- пакет: backlog.json, acceptance.csv, PROGRESS.md, это evidence и файлы в `evidence/DEV-00/`.

Миграции, permissions, record scope, совместимость API и i18n не затрагивались: продуктовый код не менялся.

## Проверка критериев

| AC | Входные данные / действие | Ожидаемый результат | Фактический результат | Статус | Тест/протокол/артефакт |
|---|---|---|---|---|---|
| DEV-00-AC01 | Git без коммитов; сверка с manifest аудита; проверка секретов; коммит явного списка | Проверяемый commit либо точный manifest и объяснение; пользовательские изменения сохранены | Коммит `2bed19e` (670 файлов), 597/597 совпадений со снимком аудита, полный manifest 719 файлов, исключённые файлы на диске без изменений, чистая копия коммита собирается и проходит тесты | pass | Этот файл, раздел «Baseline»; [manifest](DEV-00/working-copy-2026-10-03.sha256) |
| DEV-00-AC02 | 1000 → ручные 900 → 1 и 10 пересборок (домен) и пересборка через API | Сейчас обнаруживается 1900; после DEV-01 требуется 900 | Домен и API: 1900 вместо 900, тесты красные | pass | [unit](DEV-00/unit-regressions.log.txt), [integration](DEV-00/integration-regressions.log.txt) |
| DEV-00-AC03 | Три сценария A02 в домене и через API | Различить одинакового согласующего, устаревшее согласование и превышение порога после правки | Шесть тестов (3 домен + 3 API) красные, каждый на своём сценарии | pass | [unit](DEV-00/unit-regressions.log.txt), [integration](DEV-00/integration-regressions.log.txt) |
| DEV-00-AC04 | Закрытый и выгруженный месяц, второй runId | Проверка экономического дубля через второй прогон | Второй прогон снова начислил договор и пакет часов: 15 000 вместо 0 | pass | [integration](DEV-00/integration-regressions.log.txt) |
| DEV-00-AC05 | Новые прогоны базовых проверок на baseline | Новый фактический результат; старые 252/54/80/29 не выдаются за новую версию | Прогоны 03.10.2026 21:30–21:45 UTC на `2bed19e`, см. «Запуски»; совпадение чисел с аудитом объясняется идентичным кодом, измерения новые | pass | Таблица «Запуски» |

Expected failure DEV-00: красные регрессии подтверждают **воспроизведение** дефектов, а не исправление продукта. Release gate остаётся красным до DEV-01/02/03.

## Запуски

Рабочий каталог — корень репозитория, если не указано иное; `PATH`/`DOTNET_ROOT` указывают на `~/.dotnet`. Полные журналы остались во временной папке сессии; в репозиторий сохранены очищенные выдержки (без строк подключения и паролей).

| Время (UTC) | Версия | Команда | Exit | Результат |
|---|---|---|---|---|
| 21:30:09–21:30:23 | `2bed19e` | `dotnet restore` + `dotnet build Vardahei.Crm.slnx --no-restore -c Release` | 0 | 0 warnings, 0 errors |
| 21:30 | `2bed19e` | `dotnet test --project tests/Crm.UnitTests/... --no-build -c Release` | 0 | 252 passed, 0 failed, 0 skipped |
| 21:30 | `2bed19e` | `dotnet test --project tests/Crm.ArchitectureTests/...` | 0 | 54 passed |
| 21:30:45–21:31:05 | `2bed19e` | `dotnet test --project tests/Crm.IntegrationTests/...` (Testcontainers SQL + WireMock) | 0 | 80 passed |
| 21:31 | `2bed19e` | `web: npm ci; npm run lint; npm run typecheck; npm test` | 0/0/0/0 | lint и typecheck без ошибок; vitest 29 passed, 9 files |
| 21:31 | `2bed19e` | `web: npm run build` | 0 | initial total 282.7 KB gzip при бюджете 300 KB |
| 21:32:05–21:34:14 | `2bed19e` | `web: npm run e2e`, 3 workers, выделенная временная БД в контейнере `crm-e2e-dev00-20261003` (порт 14335, создан и удалён), порты 5181/5191/5299 перед запуском свободны | 1 | **37 passed, 1 failed**: `billing.spec.ts:12 a monthly run is collected, approved and sent to PowerOffice` — «A run for 2040-01 is already open» (BIL_PERIOD_BUSY). Гонка `freeBillingPeriod` (A14) воспроизведена на чистой БД; относится к DEV-15 |
| 21:44:41–21:45:26 | чистая копия `2bed19e` | build, unit, architecture, `npm ci`, lint, typecheck, vitest, build | все 0 | 43 проекта, 252/252, 54/54, 29/29, 282.7 KB |
| 21:40 | `2bed19e` + регрессии | unit tests | 2 | 257: 252 passed, **5 failed** — только новые регрессии A01 ×2, A02 ×3 |
| 21:43:03–21:43:19 | `2bed19e` + регрессии | integration tests | 2 | 85: 80 passed, **5 failed** — только новые регрессии A01, A02 ×3, A03 |

Зарегистрированные известные красные проверки для следующих карточек (не маскировать, не исправлять чужой карточкой):

- unit: `BillingRegressionTests` — A01 (2 случая) → DEV-01; три A02 → DEV-02;
- integration: `BillingRegressionApiTests` — A01 → DEV-01; три A02 → DEV-02; A03 → DEV-03;
- E2E: гонка периода в `billing.spec.ts` (существовала до DEV-00) → DEV-15.

Дополнительное наблюдение для DEV-15: в первом из четырёх прогонов integration-набора с регрессиями (21:41) fixture `CrmWebFactory.DisposeAsync` упал с `NullReferenceException` внутри `WebApplicationFactory.DisposeAsync`, и xUnit приписал «Test Assembly Cleanup Failure» каждому из 84 тестов (итог 168/88). Три следующих прогона — 0 таких ошибок. Это нестабильность teardown, не связанная с логикой регрессий; разобрать в DEV-15 как случайный красный сигнал.

## Данные и обратимость

Схема и данные не менялись. Инвентаризация существующих данных — только агрегатные `SELECT` без содержимого строк на локальном контейнере `vardahei-crm-sql` ([запрос](DEV-00/inventory.sql), [результат](DEV-00/inventory-2026-10-03.txt)):

- `crm` (локальная dev-база): прогонов, оснований, PendingCharges и счетов нет; 11 событий outbox ожидают worker (catalog 6, contracts 3, customers 2), «застрявших» после 10 попыток нет; 1 версия предложения в PendingApproval; 4 активных пользователя; 70 записей аудита.
- `crm_e2e` (общая E2E-база, синтетика mock PowerOffice): 59 прогонов (30 Collected, 29 ExportedWithErrors), периоды 2026-07…2046-01, по одному прогону на период; 1 824 основания (911 Draft, 446 Exported с номером заказа, 444 Failed, 23 Cancelled), ни одного выше 200 000 и ни одного прогона с одинаковыми согласующими; строки — 1 801 Subscription и 50 OneOff, из них 27 ручных без SourceRefs; повторов одного contractLineId в разных основаниях одного периода нет; 5 PendingCharges `project-phase` ожидают; 337 счетов, все связаны с основанием; outbox полностью обработан; OutboundOperations: create-sales-order 446 Succeeded / 444 Failed, sync-contact-person 254 Succeeded; предложения: 10 Accepted, 13 Draft, 20 Ready, 12 Superseded — PDF рендерится при скачивании, сохранённых файлов нет; 6 пользователей; 13 874 записи аудита.
- Роли: семь Entra App Roles из `Crm.Authorization/Permissions.cs`; Admin имеет и `billing.approve`, и `billing.approve.second`, Finance — первое, Management — второе. Назначения ролей в БД не хранятся.

Вывод для миграций DEV-01…03: в существующих данных встречаются самостоятельные ручные строки без источника и ни одной исправленной собранной строки; при backfill их нельзя принимать за overrides. Рабочей (production) базы нет.

Временные ресурсы: контейнер `crm-e2e-dev00-20261003` и файл пароля к нему удалены; временный worktree удалён (`git worktree list` показывает только основную копию). Обратимость: удалить два новых тестовых файла и вернуть `private` у двух helpers либо отменить коммит DEV-00; baseline-коммит не меняет файлы рабочей копии.

## Самопроверка и остаточные риски

Проверены весь diff, отсутствие skip/условных обходов, что каждый тест падает именно на своём инварианте и что 80 существующих integration и 252 unit тестов не изменили результат. Проверку выполнял тот же агент — это не независимый review.

- Инварианты записаны через нынешние публичные методы. DEV-01/02 могут изменить сигнатуры (например, согласование с ревизией или текущими суммами); тогда меняется вызов, но не утверждение.
- Доменный тест порога сейчас не может пройти без передачи суммы основания в согласование — это и есть дефект, который DEV-02 закрывает в транзакции утверждения.
- API-тесты используют общую БД тестов: прогоны в их периодах подбирают и открытые договоры других классов (суммы малы и не влияют на порог). Периоды 2029-01…2029-05 не используются другими тестами.
- Нестабильный teardown integration fixture передан в DEV-15.

Итоговый статус: **code_verified**. Внешних gates у карточки нет, все AC — pass; повышение до accepted оставлено владельцу или независимому review ([REVIEW_PROMPT](../REVIEW_PROMPT.md)).
