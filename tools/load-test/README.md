# DEV-16: воспроизводимая нагрузка

Набор инструментов проверяет CRM на синтетических данных. Он не подтверждает EXT-05 без согласованной инфраструктуры, профиля действий и владельца протокола (DEC-07). Ни Entra, ни реальные бухгалтерские/сервисные API здесь не нагружаются.

## Данные и изоляция

| Профиль | Организации | Контакты | Тикеты | Часы (entries) | Аудит |
|---|---:|---:|---:|---:|---:|
| smoke | 500 | 5 000 | 10 000 | 10 000 | 100 000 |
| full | 5 000 | 50 000 | 1 000 000 | 1 000 000 | 10 000 000 |

`seed.sql` задаёт фиксированные IDs, даты, распределение по пятилетнему периоду и дополнительные связи/allocations, товар, 500 договоров и PowerOffice mappings. Биллинг: сентябрь 2026, 500 клиентов × 10 единиц × 150 NOK без НДС; история часов уже Invoiced. Это воспроизводимая исходная модель; реальный состав портфеля, перекосы/горячие клиенты и частоты операций требуют согласования DEC-07.

`local.py` создаёт новый SQL-контейнер на loopback, уникальную БД `crm_load_dev16_*` и ownership marker; существующая база не принимается. Миграции выполняются администратором, Web и Worker работают под отдельными `crm_web` / `crm_worker`. Пароли находятся только в `state.private.json` с правами 0600 вне репозитория. Не включать этот файл в evidence. Очистка проверяет одновременно имя, Docker label и маркер БД; удаляет только созданный контейнер. Незавершённый seed не продолжается поверх частичных данных: создать новую среду, старую удалить после проверки ownership.

Вставки ограничены пакетами 10 000. Контрольная сумма построена из SHA-256 канонического JSON всех полей каждой исходной строки (кроме rowversion), затем SHA-256 упорядоченных пакетных хешей и таблиц. Чтение для checksum идёт по ключу, без растущего OFFSET. Проверка исключает новые audit entries приложения, но включает весь seed-аудит. `generatorChecksum` отдельно фиксирует SQL-рецепт. Совпадение counts само по себе не считается совпадением данных.

## Подготовка

Нужны .NET SDK из `global.json`, Docker с SQL Server 2022, Python 3, Node, зависимости `web`, k6 (проверен 1.3.0). На ARM SQL Server запускается через эмуляцию; это обязательно отмечается в протоколе. [Установка/запуск k6](https://grafana.com/docs/k6/latest/get-started/running-k6/).

```sh
export PATH="$HOME/.dotnet:$PATH" DOTNET_ROOT="$HOME/.dotnet"
dotnet build Vardahei.Crm.slnx --no-restore -c Release --disable-build-servers -m:1
npm --prefix web run build
python3 tools/load-test/local.py init --directory /tmp/dev16-smoke --profile smoke
python3 tools/load-test/local.py verify --directory /tmp/dev16-smoke
python3 tools/load-test/local.py serve --directory /tmp/dev16-smoke
```

`serve` остаётся запущен в отдельном терминале: Web `https://localhost:5182`, Worker `5192`, симулятор `5300`; все порты можно задать при `init`. Для полного набора выбрать **новую** директорию, `--profile full` и свободный `--sql-port`, если smoke ещё работает. Параметры хостов берутся из private state, workload — из manifest.

После готовности Web, в другом терминале:

```sh
node tools/load-test/provision.mjs /tmp/dev16-smoke/dataset.json
node --experimental-vm-modules --test tools/load-test/*.test.mjs
python3 -m unittest discover -s tools/load-test -p 'test_*.py'
```

Provision использует существующий `/bff/dev-login` и сверяет `/bff/user`. Production bypass не добавлен. У каждого VU отдельная cookie-сессия, но Development harness предоставляет одну identity на роль: 50 VU **не равны 50 разным сотрудникам**. Реальные Entra и 50 identities — отдельная согласованная проверка. Сценарии отвергают неизвестный/production manifest, remote URL без явного `ALLOW_REMOTE_TEST=1`, чужой BASE_URL и несовпадение пользователя.

## Рабочий день и браузер

```sh
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=/tmp/dev16-smoke/workday.html \
  k6 run -e DATASET_MANIFEST=/tmp/dev16-smoke/dataset.json \
  -e ALLOW_LOCAL_TLS=1 -e VUS=50 -e WARMUP=30s -e DURATION=2m \
  -e SUMMARY_PATH=/tmp/dev16-smoke/workday.json \
  --out json=/tmp/dev16-smoke/workday-samples.jsonl tools/load-test/workday.js
ALLOW_LOCAL_TLS=1 node tools/load-test/browser-card.mjs --manifest /tmp/dev16-smoke/dataset.json \
  --output /tmp/dev16-smoke/browser.json --samples 10 --warmup 1
```

В `workday.js`: фиксированное распределение ролей/карточек, чтение карточки и связанных разделов, поиск, dashboard по правам, создание/изменение Note и два одновременных PUT с одним If-Match. Конфликт проверяется как ровно 200+412; 403 не является успешным бизнес-ответом. Warmup и измерения разделены с временем завершения запросов между ними. Full по умолчанию: 50 VU, warmup 2 минуты, измерения 30 минут; короткий переопределённый full-прогон остаётся локальной проверкой инструмента.

Роли с `time.read` читают общую историческую страницу с непустыми entries и allocations; `time.own` без `time.read` проверяет явно пустой личный список, поскольку импортированные техники seed не связаны с Development identities. Период чтения берётся из `history.readPeriod` manifest, при отсутствии — из `billing`; год, месяц и источник периода записываются в `workload.timeEntryProfile` summary. Для сравнения до/после сохранить `history.readPeriod: {"year":2026,"month":9}`, даже если повтор биллинга использует другой месяц.

Пороги: p95 read ≤500 ms, write/search ≤1000 ms, все обязательные операции присутствуют, failed checks/errors = 0. Все HTTP-ответы, включая ошибки и ожидаемые конфликты, попадают в соответствующие latency histograms; таймаут получает как минимум полный timeout, не нулевую длительность. Raw samples и summary сохранять и при ненулевом exit code. Графики формирует [k6 web dashboard](https://grafana.com/docs/k6/latest/results-output/web-dashboard/).

Браузер отдельно измеряет LCP и первый полезный контент (название выбранной организации + видимые данные карточки). Профиль: Chromium, 1365×900, CPU slowdown 4×, 40 ms сети, 10 Mbps download / 1 Mbps upload, cold browser cache; warmup приложения отдельно. Ошибки/ненаблюдённые метрики учитываются как failed samples с timeout, не отбрасываются. Chromium emulation не заменяет согласованный клиентский профиль EXT-05. k6 HTTP latency не называется LCP.

## Биллинг и внешний сервис

```sh
k6 run --log-format=json --console-output=/tmp/dev16-smoke/billing-protocol.jsonl \
  -e DATASET_MANIFEST=/tmp/dev16-smoke/dataset.json -e ALLOW_LOCAL_TLS=1 \
  -e SUMMARY_PATH=/tmp/dev16-smoke/billing.json tools/load-test/billing.js
```

Сценарий создаёт один run, собирает 500 оснований и проверяет точное множество клиентов. Collect в текущем API синхронный (HTTP 200); протокол записывает фактически наблюдаемый режим. Затем Finance утверждает текущую ревизию с If-Match; worker асинхронно экспортирует основания. Успех — 500 статусов `Exported` с квитанциями/номерами заказов, без failed/reconciliation. Очередь сама по себе не означает завершённый экспорт. Бюджеты: 300 секунд collect и 1800 секунд export. Утверждённые финансовые записи не удаляются и не переписываются ради теста. Повтор возможен на новом dataset либо только в собственной демонстрационной seed-базе за следующий ещё не использованный период действия тех же 500 договоров (например, октябрь после сентября). Перед повтором проверить срок договоров и отсутствие уже собранного/утверждённого run за выбранный месяц; повторный экспорт тех же оснований недопустим. Сохранить исходный manifest и результаты отдельно, в manifest повтора изменить `billing.year/month`, сохранив `history.readPeriod` для сопоставимого чтения, и явно зафиксировать различие периодов в протоколе.

`provider.mjs` — отдельный loopback PowerOffice simulator: задержка 150–250 ms, условная квота 10 requests/s с 429/Retry-After. Это **simulated**, не реальные ограничения PowerOffice. `/stats` сообщает actual requests, throttles, failures, orders, duplicateReferences. Дубли возвращают 409, чтобы mock не скрывал повторный экспорт. `SIMULATED_FAILURE_EVERY=N` при отдельном запуске provider моделирует 503 до внешнего эффекта; режим и actual stats фиксировать вместе с manifest. Сбой после неизвестного внешнего результата покрыт отдельными DEV-03/07 integration tests; эта симуляция его не заменяет.

## Ресурсы и SQL

Параллельно workload:

```sh
python3 tools/load-test/capture.py --directory /tmp/dev16-smoke \
  --output /tmp/dev16-smoke/resources --seconds 180
# PID — конкретный Web/Worker этого запуска, инструмент ставится во временный tool-path.
dotnet-counters collect --process-id PID --counters System.Runtime \
  --format json --refresh-interval 1 --duration 00:03:00 --output /tmp/dev16-smoke/runtime.json
```

Capture сохраняет CPU/RSS двух собственных процессов, память/CPU контейнера, характеристики среды, снимки executed query counters и cached estimated SQL plans. Последние не выдаются за actual operator row counts. Кэш/статистики чужих баз не сбрасываются. Allocations/GC измеряются [dotnet-counters](https://learn.microsoft.com/dotnet/core/diagnostics/dotnet-counters). SQL query-count/reader-count assertions дополнительно находятся в `BillingCollectionPerformanceTests` и `ReportQueryPerformanceTests`.

В протокол включить source manifest, dataset checksum, версии, warmup/duration, action mix/identity limitation, p50/p95/p99/max, failures/timeouts/failed checks, ресурсы, SQL plans, billing receipts, browser profile и графики. Положительный smoke не закрывает SLO на целевых данных; локальный full не является согласованной EXT-05 приёмкой.

После остановки `serve` (Ctrl-C):

```sh
python3 tools/load-test/local.py destroy --directory /tmp/dev16-smoke
```

Reports и документы остаются в своей временной директории для просмотра; приватный state удаляется. После измеренного full-прогона DEV-16 добавлены три индекса в миграциях Service/TimeTracking `ReadPathIndexes`: открытые тикеты, активные записи времени по WorkDate DESC/Id ASC, активные allocations по TimeEntryId. Старые индексы сохранены; Down удаляет только новые индексы. В исходных cached plans каждый из четырёх основных запросов сканировал миллион строк. Upgrade на representative synthetic data, длительность и контроль целостности записаны в evidence; production rollout требует оценки окна блокировки построения индексов в своей среде. Отдельный report read model пока не вводится: сначала сравниваются планы и нагрузка с этими индексами.
