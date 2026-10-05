# DEV-16 — производительность и воспроизводимые измерения

## Версия и среда

Исполнитель — Codex, 04–05.10.2026 (UTC и Europe/Oslo). Нагрузочные измерения выполнены 04.10 UTC; заключительный review и проверка SQL aggregates — 05.10 UTC. Рабочая ветка `codex/readiness`, исходный HEAD `9745703`; DEV-17 и DEV-16 находятся в рабочей копии, commit/push не выполнялись. Состав проверенной копии фиксируется [SHA-256 manifest](DEV-16/source-manifest.sha256) и [описанием происхождения](DEV-16/source-provenance.json). Manifest включает все изменённые и новые файлы DEV-17+DEV-16 поверх указанного HEAD; пользовательские архивы и `.claude/` исключены и сохранены без изменений. Сам manifest исключён из своего списка. Проверки этого документа не являются независимой внешней приёмкой.

Среда — локальный Apple M4, 10 logical CPU, 16 GiB RAM, macOS 26.6.2; SQL Server 2022 amd64 через Docker на ARM, предел памяти SQL 2048 MiB. .NET SDK 10.0.401/runtime 10.0.12, Node 24.19.0, k6 1.3.0 (официальный release, SHA-256 проверен), dotnet-counters 10.0.745401, Playwright 1.63.0/Chromium 153.0.8010.12. Чужие контейнеры/нагрузки не останавливались. Это не согласованная инфраструктура EXT-05.

Только синтетические данные и отдельные owned SQL-контейнеры. Web/Worker имеют отдельные штатные роли `crm_web`/`crm_worker`, миграции и seed выполнялись администратором. Production auth не менялся; 50 VU используют отдельные сессии пяти role identities существующего Development harness. Entra, Azure и реальные провайдеры не вызывались.

## Подтверждённая проблема и реализация

В `BillingCollector` полный subscription portfolio читался снова внутри каждой basis; contracted products/unmapped offers/device counts также имели per-customer calls. Теперь scope — организации данного run и invoice parents, каждый источник читается пакетно перед циклом; contract/time/purchase/charge источники сгруппированы один раз. Latest assigned snapshots выбираются SQL на нужных организациях. Финансовые позиции не обрезаются лимитом; charge ledger, ключи начислений, approval revision/digest, округления и outbox экспорт сохранены.

Billing reports, service load, time utilization/customer/project hours и Microsoft cost totals теперь возвращают SQL-агрегаты. Allocation totals считаются отдельным сгруппированным join, чтобы строки распределений не умножали часы/суммы. Margin использует словарь; dashboard разрешает имена только 20 отображаемых renewals. Search проверен на существующих TOP/projection запросах. Первый full/50-VU прогон выявил четыре SQL-сканирования миллионных таблиц (98,96% logical reads среди top20). По этим измеренным планам добавлены три filtered covering индекса в additive миграциях Service/TimeTracking `ReadPathIndexes`; подробности upgrade и сравнения ниже.

При полном coverage-прогоне обнаружены и исправлены две гонки: глобальный счётчик `OperationalSignalTests` изолирован от параллельных fixtures; два `ContractLifecycleJob` больше не могут одновременно пройти проверку dedup и вставить одинаковое напоминание. Последний сериализован SQL applock в execution strategy/транзакции, а account-manager lookup выполняется одним scoped запросом только для новых due reminders. Внешних вызовов внутри транзакции нет.

`tools/load-test` теперь содержит owned local environment, детерминированный seed, k6 read/write/If-Match/search/dashboard/historical time, полный billing-to-receipt и отдельный Chromium LCP/FUC runner. Ошибки и таймауты остаются в histograms и failed checks, 403 не считается успехом. CI выполняет regression tests инструментов; реальные нагрузочные прогоны остаются отдельной процедурой. `actionlint .github/workflows/ci.yml` прошёл без замечаний; [лог](DEV-16/checks/dev16-workflow-lint.log).

## Данные

Полный seed: 5 000 организаций, 50 000 контактов, 1 000 000 тикетов, 1 000 000 time entries, 10 000 000 audit entries, дополнительно 50 000 affiliations, 1 000 000 allocations, 500 договоров/строк и 501 external mapping. Фиксированная история 05.10.2021–04.10.2026. Seed + SHA-256 содержимого 11 таблиц: **338,636 с**. Data allocated 4808 MiB / used 4745,25 MiB; log allocated 776 MiB / used 184,391 MiB. [Manifest](DEV-16/dataset-full.json), [объёмы и 48 существующих индексов](DEV-16/full-db-profile.json).

Dataset checksum: `sha256:7d32b44cd737ec67f3fcca42d9e6cc72b235a7ba2643b079d347c58f932caf85`. Хешируются все persisted поля, кроме rowversion, в пакетах по 10 000 с keyset чтением. Generator checksum хранится отдельно. Два независимо созданных smoke-набора дали одинаковые 11 table hashes; оба тестовых контейнера затем удалены с проверкой ownership: [протокол детерминизма](DEV-16/determinism.json).

Synthetic mix ограничен: 500 fixed MSP contracts × 1500 NOK, без реального распределения лицензий, проектов, закрытых BI snapshots, reconciled Microsoft billing lines и сложных parent/hour-bank portfolios. Time history принадлежит условному unassigned technician: роли `time.read` читают непустой исторический период, `time.own` отдельно проверяет пустой personal list. Полный объём записей не означает согласованный production action/data mix.

## Проверка критериев

| AC | Проверка и фактический результат | Статус |
|---|---|---|
| DEV-16-AC01 | Полный локальный набор, 50 сессий: финальный p95 read 74 / write 46 / search 653,5 ms, 43 562/43 562 checks, HTTP errors=0, interrupted=0; k6 exit0. Исходный прогон превышал read/search SLO и сохранён. Согласованные identities, длительность и инфраструктура — DEC-07 / EXT-05. | blocked |
| DEV-16-AC02 | Full: 500 оснований собраны за 3,363 с (синхронный HTTP200), затем 500 Exported с order receipts за 355,362 с, failed=0, provider duplicateReferences=0. Реальные provider quotas — EXT-05. Исходный full: collect26,806 с / export370,092 с. | blocked |
| DEV-16-AC03 | Full: 10 cold-cache Chromium card loads, FUC p95/max 1827,4 ms, LCP p95/max 1828 ms, 0 failed samples. CPU4×, сеть40ms/10Mbps; SQL coverage параллельно на общей VM. Согласованный клиентский профиль — EXT-05. [JSON](DEV-16/browser-full.json), [screenshot](DEV-16/browser-full.png). | blocked |
| DEV-16-AC04 | SQL reader/query-count tests подтверждают scoped/aggregate queries, включая Microsoft costs: 12→2008 исходных строк, 1 SQL и3 итоговые строки. Полный seed и нагрузочные прогоны завершены без OOM. CPU/RSS/allocations/GC и планы сохранены; границы workload перечислены ниже. | pass |
| DEV-16-AC05 | Настоящий сценарий исполняется в VM regression tests: 403 и timeout не исчезают из latency/checks, два успешных racing PUT вместо 200+412 дают failure; browser missing metrics учитываются как failed/timeout samples. После review добавлен запрет новых запросов за границей фазы и started/finished counters: принудительное прерывание даёт exit99. | pass |
| DEV-16-AC06 | Владелец QA / operations / PO, инфраструктура, реальные identities/quotas и профиль DEC-07 не согласованы. EXT-05 blocked; ноутбучные результаты не названы acceptance. | blocked |

## Запуски и самопроверка

[Команды выполненных проверок](DEV-16/checks/commands.txt). Команды воспроизведения, измерения и безопасной очистки: [tools/load-test/README.md](../../../tools/load-test/README.md). Полный локальный прогон: `VUS=50 WARMUP=30s DURATION=2m`, затем отдельный 32-секундный запас на завершение запросов. Это короткое диагностическое измерение, не согласованный 30-минутный прогон длительной нагрузки с пиками.

| Метрика, ms | До индексов: p50 / p95 / p99 / max | После индексов: p50 / p95 / p99 / max |
|---|---:|---:|
| read | 58 / 2032,7 / 5610,3 / 16356 | 7 / 78,3 / 170,0 / 816,6 |
| write | 117 / 299,6 / 447,6 / 653 | 15,4 / 48,0 / 69,0 / 305 |
| search | 1138 / 2214,3 / 2544,6 / 4460 | 202 / 723,8 / 1493,1 / 1776,2 |

Оба запуска — на одной synthetic БД, без очистки кэша. Данные созданных Note и утверждённого биллинга сохранялись. Первый billing за сентябрь, повтор за октябрь в пределах договоров; historical time workload в обоих читает сентябрь. Смесь фиксирована кодом: пять равновесных ролей, карточка/связанные списки/поиск/pipeline, dashboard и time по правам, Note create/edit и два racing PUT (ровно200+412), 2–4 секунды между взаимодействиями. До индексов failSLO не скрыт: 17 024 checks успешны, но k6 exit99. После — 43 141 checks, exit0; native interruptediterations=0 в обоих.

- [Сравнение измерений](DEV-16/comparison.json), [исходный summary](DEV-16/baseline/workday.json), [графики исходного прогона](DEV-16/baseline/workday.html), [после индексов](DEV-16/after-index/workday.json), [графики после индексов](DEV-16/after-index/workday.html). Raw samples сохранены в gzip рядом с отчётами.
- [Исходные планы и 98,96% logical reads](DEV-16/baseline/baseline-plan-review.json), [исходные CPU/GC/allocations](DEV-16/baseline/resources/numeric.json). Cached estimated plans не называются actual execution row counts.
- Release build: **0 warnings/errors**; **423 unit +91 architecture +269 SQL/API**, failed0/skipped0. [Логи](DEV-16/checks/dev16-build.log), [unit](DEV-16/checks/dev16-unit-coverage.log), [architecture](DEV-16/checks/dev16-architecture.log), [SQL](DEV-16/checks/dev16-integration-coverage.log), [coverage gate](DEV-16/checks/dev16-coverage-gate.log). Coverage critical1274/1315=96,88%, остальные20986/23597=88,94%; generated EF отдельно исключён, Worker оставлен в предусмотренном unmeasured allowlist. Cobertura XML сохранены в gzip.
- Первый полный coverage имел два сбоя из-за lifecycle/counter races; [исходный failure log](DEV-16/checks/dev16-integration-coverage.initial-failure.log) сохранён, причины исправлены и полный269-suite прошёл. Первый smoke также выявил ошибочное ожидание `totalCount` у keyset organization API; проверка заменена на фактические business records.

Новых API endpoints нет; схема расширяется только тремя индексами; применимость permissions/CSRF/If-Match сохранена существующими API. Runtime роли проверены реальным workload. Исходный DEV-17 schema manifest — исторический снимок; последующие изменения общего теста/документации входят в DEV-16 source manifest.

Финальный повтор с deadline guard также прошёл: p95 **74 /46 /653,5 ms**, **43 562/43 562 checks**, HTTP errors0, interruptedIterations0, exit0. [Summary](DEV-16/workday.json), [графики](DEV-16/workday.html), [полный лог](DEV-16/workday.log). Во время запуска изменено только имя пользовательского gauge-tag `vu` → `client_id`, чтобы убрать предупреждение о зарезервированном имени k6; финальное имя отдельно проверено native k6 proofs ниже. Backend, deadlines и бизнес-сценарий не менялись. Полный420s resource capture включает первый послеиндексный прогон и начало финального; сравнение active-window использует первый, чтобы периоды были сопоставимы.

[Протокол биллинга](DEV-16/billing-protocol.jsonl), [summary](DEV-16/billing.json), [provider stats](DEV-16/provider-stats.json): actual1002 requests,500 orders,0throttles,0injected failures,0duplicate references. Профиль simulator150–250ms/10req/s; сбои в этом полном прогоне выключены, retry/unknown-outcome покрыты SQL integration suite и отдельными provider tests.

Инструменты: [Node13/13](DEV-16/checks/dev16-tooling-node-tests.log), [Python ownership8/8](DEV-16/checks/dev16-tooling-python-tests.log). [Native k6 forced interruption](DEV-16/checks/dev16-tooling-forced-interruption.log) намеренно exit99, started2/recorded1/interrupted1/gauge1; [balanced drain](DEV-16/checks/dev16-tooling-balanced-drain.log) exit0,2/2/interrupted0/gauge0. [Proof source](DEV-16/checks/dev16-tooling-boundary-proof.js) локальный и без сети. Эти negative proofs подтверждают, что потерянные при принудительном завершении samples не превращают прогон в зелёный.

## Ресурсы и запросы

[Сравнение CPU/RSS/allocations/GC](DEV-16/resources/resource-comparison.json), [численные измерения](DEV-16/resources/numeric.json), [SQL counters и access paths](DEV-16/resources/sql-comparison.json). В активном первом послеиндексном окне: Web RSS max1037 MiB (после GC~339 MiB к концу окна), Worker max907 MiB; SQL max1927 MiB при целевом лимите2048. Web GC pauses суммарно0,965 с (~0,52% окна), Worker0,265 с. Число HTTP requests выросло в2,63 раза; суммарные Web allocations7,57→19,8 GiB, приблизительно570→567 KiB/request. Это process-wide ratio с фоновыми задачами/биллингом, не endpoint allocation profiler. Короткий прогон и sampled RSS не доказывают отсутствие долгосрочных утечек.

SQL CPU mean602%→318% (100%=одно ядро); container block read delta~331→0,93 GiB. Logical reads/exec по четырём hotspot queries: открытые тикеты38 210→244; страница времени46 874→251; суммы периода46 667→283; utilization38 865→7389. Все четыре новых плана используют Index Seek, сортировка перед TOP для страницы исчезла. Cache lifetime/counters после миграции отличаются; сравнение отмечает reset и не вычитает несовместимые handles. [Решение о report read model](DEV-16/resources/read-model-decision.json) — пока оставить текущую композицию с SQL aggregates/индексами; возвращаться к отдельной модели только при измеренном ограничении в согласованной среде.

## Данные и обратимость

Три индекса добавлены по измеренным запросам: открытые тикеты с TechnicianUserId, активные TimeEntries по WorkDate DESC/Id ASC с нужными полями, активные allocations по TimeEntryId с суммами. Старые индексы сохранены; Down удаляет только три новых. Empty DB/migration metadata и соответствие EF model проверены [ReadPathIndexTests](../../../tests/Crm.IntegrationTests/ReadPathIndexTests.cs) и [логом](DEV-16/checks/dev16-index-metadata.log).

На полной БД upgrade занял **3,142 с**, повтор без изменений **1,526 с**. [15 counts и5 sums до](DEV-16/upgrade/before.json) точно равны [после](DEV-16/upgrade/after.json), включая финансовые записи предыдущего утверждённого run. [Протокол](DEV-16/upgrade/result.json), [locks](DEV-16/upgrade/lock-samples.json): Sch-M наблюдался в2/4 samples, максимум3 одновременно; Web/Worker были остановлены. Это не подтверждение неблокирующего production upgrade: окно построения должно быть измерено для реального SQL service.

Проверка совместимости отката: `tools/release/rollback-compat.sh 9745703 --project=desktop --grep '@critical' --workers=1` — **7/7 passed** на новой схеме Service/TimeTracking, включая полный monthly billing→PowerOffice. [Лог предыдущего релиза](DEV-16/checks/dev16-rollback.log). Откат приложения сохраняет расширенную схему; внешние заказы и подтверждённые финансовые записи не отменяются откатом.

Полный owned SQL-контейнер, Web/Worker/provider и временные smoke/rollback-ресурсы удалены после измерений. Private state с паролями удалён, отчёты сохранены; финальная проверка обнаружила только основной Git checkout. Чужие ресурсы не затрагивались. [Протокол очистки](DEV-16/cleanup.json). Во время предыдущего завершения лимит использования прервал автоматическую проверку разрешений для контрольного чтения Docker; после возобновления проверка разрешена и успешно выполнена.

## Самопроверка и границы

Проверены scoped source reads, финансовые фильтры/округление/ledger, revision-bound approvals, runtime permissions, concurrent reminders, migrations и error accounting. Review выполнен агентами Codex; независимой внешней проверкой не является. Дополнительный отчётный read model сейчас не введён: измеренные scans устранены индексами и SQL aggregates, короткий целевой local workload проходит SLO.

Заключительный review выявил оставшуюся materialization в `GetMsCostsAsync`; исправлено SQL GROUP BY/SUM/COUNT с прежним representative-currency контрактом и .NET decimal.Round после суммирования. Два новых SQL-теста проверяют рост12→2008 строк, только3 возвращённых customer totals, границы overlap, исключение unmapped/outside-period строк, credits, валюты и округление; ReportQueryPerformanceTests9/9 прошли. Полный load seed MsBilledLines не содержит: его сохранённые timings получены до этой последней локальной правки и не выданы за benchmark реального Microsoft portfolio. Новая сборка отдельно проходит полный серверный набор. Реальные license/parent/hour-bank mix, перекосы клиентов, 50 отдельных Entra identities, длительная нагрузка и production provider limits требуют EXT-05. Владелец QA / operations / PO должен утвердить DEC-07 и приложить внешний протокол. Локальное code_verified не означает accepted.

Итог: **code_verified**, AC04/AC05 проверены локально; AC01/AC02/AC03/AC06 ждут EXT-05. Commit/push и внешнее развёртывание не выполнялись. Следующая задача реализации по execution_order — DEV-18.
