# Проверки и доказательства

Команды ниже соответствуют исходному репозиторию на 03.10.2026. После изменения tooling обновлять этот файл вместе с конфигурацией. Не путать готовую команду со сделанным измерением. Различать pass, fail и not run; сохранять exit code и содержательное подтверждение результата, а не только последнее слово лога.

## Q0 — исходное состояние

Прочитать инструкции и Git status, версии SDK/Node, Docker, manifest аудита. Не печатать секреты. Зафиксировать текущий commit, а если его нет — список/хеши исходников и ограничение. Проверить отличие от [source-snapshot.sha256](../audits/2026-10-03/source-snapshot.sha256), не восстанавливать автоматически старые файлы. Обновления пакета закономерно отличаются от снимка аудита.

Проверка самого пакета из корня репозитория:

```sh
python3 docs/claude-opus/validate-package.py --next
```

## Q1 — домен, архитектура, сборка

SDK задаёт [global.json](../../global.json). В данной рабочей среде он находится в `~/.dotnet`; в другом окружении использовать установленный совместимый SDK. Из корня:

```sh
export PATH="$HOME/.dotnet:$PATH"
export DOTNET_ROOT="$HOME/.dotnet"
dotnet restore Vardahei.Crm.slnx
dotnet build Vardahei.Crm.slnx --no-restore -c Release
dotnet test --project tests/Crm.UnitTests/Crm.UnitTests.csproj --no-build -c Release
dotnet test --project tests/Crm.ArchitectureTests/Crm.ArchitectureTests.csproj --no-build -c Release
```

Используется Microsoft Testing Platform, не предполагать совместимость VSTest-флагов. Покрытие (с DEV-15) собирает `Microsoft.Testing.Extensions.CodeCoverage` 18.11.x (совместим с MTP 2.4), отчёты Cobertura объединяет и проверяет `tools/coverage/coverage-gate.py`. Проверено на SDK 10.0.401:

```sh
dotnet test --project tests/Crm.UnitTests/Crm.UnitTests.csproj --no-build -c Release \
  --coverage --coverage-output-format cobertura --coverage-output "$PWD/coverage/unit.cobertura.xml"
dotnet test --project tests/Crm.IntegrationTests/Crm.IntegrationTests.csproj --no-build -c Release \
  --coverage --coverage-output-format cobertura --coverage-output "$PWD/coverage/integration.cobertura.xml"
python3 tools/coverage/coverage-gate.py --allow-unmeasured Crm.Worker \
  coverage/unit.cobertura.xml coverage/integration.cobertura.xml
```

Gate: line coverage ≥90% для `src/Modules/{Billing,Contracts,TimeTracking}/*/Domain/` и ≥70% для остального `src/` (NFR-10); печатает covered/coverable строки, исключения (EF migrations и snapshots, *.Designer.cs, сгенерированное в obj/, Aspire AppHost) и проекты, которые не загружает ни один тест (вне denominator; каждое такое исключение явно разрешается флагом с причиной в CI). Branch coverage выводится справочно и не гейтится: построчные условия Cobertura нельзя точно объединить между отчётами. Архитектурные тесты запускать **без** `--coverage`: инструментирование добавляет типы в каждую сборку, и правила зависимостей видят их как нарушения. Не сравнивать разные метрики как одну; критические ветви авторизации проверяются поведенческими тестами (матрица прав `AccessAndConcurrencyTests`), а не процентом.

## Q2 — SQL, API, конкуренция и миграции

Нужен работающий Docker: integration fixture создаёт изолированный SQL Testcontainer, внешние API заменены WireMock.

```sh
dotnet test --project tests/Crm.IntegrationTests/Crm.IntegrationTests.csproj --no-build -c Release
```

Для каждой меняющей схему задачи дополнительно: пустая БД; upgrade с предыдущей схемы и representative synthetic data; dry-run backfill; итоги по клиенту/периоду/валюте; повтор миграции; прерывание и возобновление; concurrency; права runtime web/worker и отдельной migration identity. Тест с sa/db_owner не подтверждает least privilege. Отдельно проверить совместимость старого приложения с расширенной схемой и стратегию после irreversible внешнего эффекта.

Использовать настоящую SQL Server semantics для rowversion, транзакций, filtered indexes и triggers. In-memory provider не доказывает эти гарантии. Старые приложения не должны автоматически применять privileged migrations в рабочей среде.

## Q3 — интерфейс и браузер

Из `web/`:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Production build пишет в `src/Hosts/Crm.Web/wwwroot`; учитывать это при review и коммитах. Проверить sync ключей nb/en/ru, единицы/валюты, серверное скрытие полей, состояния ошибки/пустого списка/загрузки/412/429. Нельзя скрыть утечку данных только UI-проверкой роли.

E2E требует **выделенную временную БД** и свободные порты 5181, 5191, 5299. [playwright.config.ts](../../web/playwright.config.ts) запускает web/worker/mock; по умолчанию использует общую crm_e2e локального контейнера. До запуска задать `E2E_SQL` для собственной БД через безопасное окружение, не копировать production connection string; конфигурация отказывается работать с нелокальным сервером и с базой, имя которой не начинается с `crm_e2e`. `DOTNET` при необходимости указывает путь executable. Уже запущенные hosts переиспользуются только при `E2E_REUSE_SERVERS=1` — тогда самому убедиться, что они смотрят в ту же БД. crm-web в E2E работает по HTTPS на development-сертификате (доверие не нужно, `ignoreHTTPSErrors`): Secure-cookie сессии WebKit на http не хранит. Тестовые журналы не публиковать с паролями.

После подготовки окружения, из web:

```sh
npx playwright install chromium firefox webkit
npm run e2e
```

В CI Linux: `npx playwright install --with-deps chromium firefox webkit` и `dotnet dev-certs https`. Месяцы биллинга тесты занимают созданием прогона (уникальный индекс открытого периода, BR-BIL-01), поэтому workers и прогоны на одной БД не конфликтуют; тест с диалогом создаёт прогон сам и при занятом месяце переходит к следующему. Тест, прошедший только на retry, роняет прогон (`failOnFlakyTests`). Один успешный retry не закрывает race; дополнительные повторения оправданы проверкой гонки, не поиском зелёного прогона. Сценарии `@critical` идут также в Firefox и WebKit; WebKit Playwright — не Safari на macOS/iOS и не заменяет проверку на реальных устройствах (DEV-18, EXT-10).

## Q4 — инфраструктура и эксплуатация

Текущие compile-only команды из корня:

```sh
az bicep build --file infra/main.bicep --stdout
az bicep build-params --file infra/env/test.bicepparam --stdout
az bicep build-params --file infra/env/prod.bicepparam --stdout
```

Если az пытается скачать compiler в ограниченном окружении, использовать уже установленный `bicep build` / `bicep build-params` с теми же параметрами; в исходной среде есть `~/.azure/bin/bicep`. Записать версию. Compile не является deployment/restore test.

Проверить разделение identities, ingress/probes, maintenance, startup config validation, alert rules/action groups, secrets references, artifact SHA/digest и корректный failure exit status scanners. What-if/deploy/DR выполнять только на явно разрешённой среде. Записать фактические resource IDs из outputs, не предполагать имена по старому runbook. Для alert test доказать доставку разрешённому получателю, не только наличие Bicep.

Проверки зависимостей отдельно от компиляции:

```sh
dotnet list Vardahei.Crm.slnx package --vulnerable --include-transitive
```

Из web — `npm audit --json` с dev dependencies. Пользователь разрешил проверку npm в исходной сессии аудита; при передаче в другую среду соблюдать действующую сетевую политику. Ошибка реестра не равна нулю уязвимостей. Не передавать исходники, реальные выгрузки или секреты сторонним сканерам без разрешения. Повторить vulnerability scan на release artifact; историческое «0» не гарантия будущего релиза.

## Q5 — доступность и ежедневный UX

Automated axe и dark/mobile tests дополнить ручными сценариями WCAG 2.2 AA: клавиатура и порядок фокуса, dialog/combobox/table/drag alternative, отсутствие keyboard trap, видимый и не перекрытый фокус, screen reader labels/errors/live updates, contrast, zoom/reflow, target size и accessible authentication по применимости. Проверить понятность денежных итогов и действия без доступа к скрытым полям.

Минимум: browser matrix сотрудников, светлая/тёмная тема, узкий экран 360 px, nb/en/ru, исходная базовая accessibility матрица. Chromium-only не доказывает поведение Safari/Firefox. Bundle budget остаётся 300 KB gzip; прочие UX/performance цели уточнить карточкой, не измерять LCP скоростью API.

## Q6 — нагрузка и отказ

[Набор DEV-16](../../tools/load-test/README.md) содержит воспроизводимый генератор smoke/full, read/write/concurrency workload, billing-to-receipt, browser LCP/FUC и сбор ресурсов. Локальный полный набор и короткий прогон не заменяют согласованную EXT-05 нагрузку. Использовать отдельную synthetic БД; Development sign-in никогда не включать в production.

Записать dataset seed/count, app digest/schema, инфраструктуру, warmup, длительность, read/write mix, p50/p95/p99, error rate, ресурсы и SQL count/plans. Предлагаемый полный прогон — 30 минут после прогрева плюс согласованный пик; итоговый workload должен быть утверждён EXT-05. Проверить 50 пользователей, p95 read ≤500 мс/write ≤1 с/search ≤1 с; 500 клиентов billing ≤5 мин, экспорт ≤30 мин либо подтверждённая отдельно принятая граница provider. HTTP 403 для роли, которая должна читать, — ошибка сценария.

Включить рестарт worker, два worker, lease timeout, DB outage, provider 429/timeout/5xx и restore после внешнего эффекта. Отделить измеренные реальные результаты от simulated provider latency. Не повышать SLO для прохождения теста.

## Q7 — реальные среды и приёмка

Проверки [EXT-01…11](DECISIONS.md) требуют соответствующей среды/владельца. Подготовить сценарий, входные данные и ожидаемый результат заранее; при отсутствии доступа записать blocked. Доказательства: ссылки на разрешённые протоколы/артефакты, дата, версия и подписавший владелец. В repo хранить обезличенный итог, не токены, клиентские документы или персональные выгрузки.

Нельзя сократить полный месячный parallel billing до запуска таймера с подменённой датой: ускоренные synthetic tests полезны, но не заменяют реальный цикл Finance. Не писать «независимый pentest», если проверку выполнил тот же агент.

## Источники baseline

Версии взяты из аудита на 03.10.2026. Перед реализацией детальной ASVS-матрицы и перед выпуском сверить официальные публикации и зафиксировать дату; номера требований не придумывать.

- [OWASP ASVS](https://owasp.org/projects/asvs) — baseline 5.0.0, Level 2, применимость и доказательства для каждого контроля.
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) — baseline AA; автоматические проверки покрывают часть требований.
- [NIST SSDF, SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) — организация безопасной разработки и происхождения релиза.
- [Microsoft: Web connector troubleshooting](https://learn.microsoft.com/en-us/power-query/connectors/web/web-troubleshoot) — ограничения и диагностика поддерживаемого обновления BI.
- [Datatilsynet: retting og sletting](https://www.datatilsynet.no/rettigheter-og-plikter/virksomhetenes-plikter/retting-og-sletting/) — исходный контекст обработки данных; конкретные сроки и основания подтверждает ответственный компании.
