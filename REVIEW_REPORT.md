# Independent review — Checkpoint B

Дата: 2026-10-07. Ветка: `stage1/foundation`, HEAD `60306eb`; код checkpoint — `db872de`.
База принятого Checkpoint A: `a04d805`. Diff B: 67 файлов, +3237/−238. Рабочее дерево до ревью чистое.
Область: задания 1.4–1.6, требования `prompts/REVIEW_STAGE_1.md`, AGENTS.md, docs/01, docs/03, docs/05. История принятого A и закрытой R1 сохранена в `a04d805:REVIEW_REPORT.md`.

## Вердикт

**REQUEST_CHANGES — четыре обязательные находки P2; Checkpoint B пока не принят.**

Штатные проверки подтверждены: **60/60 unit/PGlite, 56/56 PostgreSQL**, typecheck, API build/smoke, schema validation, SQL invariants и пустой migration drift. Дополнительные PostgreSQL-пробы выявили пробелы в lease/recovery и достоверности snapshot, которые штатный набор не покрывает. Ошибок межклиентского чтения в проверенных сценариях не найдено.

Открытых P0/P1-находок по проверенному изменению нет. Ограничение Atera alerts учтено как решение владельца; оно не является новой находкой. Исправление R1 из Checkpoint A сохраняется, его тесты проходят.

## B1 — [P2] Worker с истёкшим lease может отменить работу нового владельца

**Место:** `packages/events/worker.ts:138–151`, прежде всего UPDATE на строках 144–145. Аналогично фазы 1/2 на строках 92–99 и 109–111 не проверяют принадлежность текущего захвата.

`recordFailure` ограничивает UPDATE только scope, event ID и pending-статусом. Он не проверяет leaseOwner или версию захвата, а retry рассчитывает по устаревшему `claimed.attempts`. После повторного захвата старый worker по-прежнему может стереть чужой lease и записать RETRY/DEAD_LETTER. Блокировка строки защищает от двух observations, но не от перехода состояния по устаревшему захвату.

**Воспроизведение на двух Prisma-пулах:**

1. Сохранить CRITICAL-событие; A захватывает его с lease 100 ms.
2. После истечения lease B захватывает событие с lease 10 s и успешно сохраняет phase-1 decision через `prepareEvent`.
3. A продолжает `processClaimed` со своим старым объектом; через существующий `beforeFinalCommit` инъецируется `AtlasError('STALE_WORKER_WRITE_FAILED', 'PERMANENT')`.
4. Затем B пытается завершить своё сохранённое решение.

**Факт:** A возвращает `DEAD_LETTER`, B — `ALREADY_FINISHED`. Строка: `DEAD_LETTER`, `attempts=2`, `leaseOwner=null`, `lastErrorCode=STALE_WORKER_WRITE_FAILED`; **observations=0**. Искусственная ошибка здесь моделирует сбой старого worker; порядок захватов и все переходы выполняет настоящий код на PostgreSQL.

Это шире признанного в checkpoint риска лишнего provider call: корректная работа нового владельца отменяется старым, и CRITICAL не получает observation.

**Исправление:** выдать каждому захвату уникальный token/version; проверять его и текущий статус под блокировкой во всех изменениях phase 1, commit и failure. Устаревший worker должен завершаться как утративший захват, без смены статуса, очистки чужого lease и ложного failure-audit. Проверки только workerId недостаточно при его повторном использовании. Regression: новый владелец после устаревшей ошибки создаёт ровно одну observation/applied run, старый не меняет его состояние.

## B2 — [P2] `maxAttempts` не ограничивает повторные падения процесса

**Место:** `packages/events/worker.ts:49–54`, `packages/events/worker.ts:169–172`; единственная проверка лимита — в `recordFailure` на строке 140.

Захват увеличивает attempts, но выбирает событие независимо от достигнутого лимита. Если процесс погибает без выполнения catch/recordFailure, следующий worker захватывает его снова без ограничения. Это противоречит пункту 4 «Decisions and scope» checkpoint: падения сами по себе никогда не переводят событие в DEAD_LETTER.

**Воспроизведение:** четыре последовательных `claimEvents` одного события, каждый с lease 100 ms и временем следующего захвата через 200 ms; захваченные события намеренно не обрабатываются — моделируются четыре падения. Затем `processPending(..., {maxAttempts: 3, batchSize: 1})` после очередного истечения lease.

**Факт:** `PROCESSED`, **attempts=5**, provider вызван ещё один раз, observation создана. До восстановления строка оставалась RECEIVED с attempts=4, без dead-letter. При повторении падений attempts продолжает расти.

**Исправление:** при recovery просроченных захватов атомарно завершать исчерпавшие лимит события как DEAD_LETTER с safeErrorCode и audit, не вызывая провайдера. Не ограничиваться исключением их из SELECT: иначе останутся невидимые зависшие pending-строки. Явно определить поведение сохранённой phase-1 decision на границе лимита. Regression должен моделировать падения без catch, включая configured maxAttempts и явный audited requeue.

## B3 — [P2] Старый sync безусловно перезаписывает более свежий snapshot

**Место:** `packages/sync/snapshots.ts:72–77`; соответствующая запись ошибки на строках 58–59 также не учитывает порядок попыток.

Два sync одного connection/resource могут читать параллельно. Транзакция защищает целостность одного результата, но unconditional upsert не защищает от обратного порядка завершения. Snapshot, lastSuccessAt и lastSyncAt откатываются к времени старой попытки; ресурс при этом остаётся OK, если старый asOf ещё входит в freshness window.

**Воспроизведение:** старое чтение с временем T задержано перед возвратом корректного пустого `SnapshotRead`. Новое чтение того же Huntress incident-ресурса с T+100 ms получает два инцидента и успешно фиксируется. Затем освобождается старое чтение. Проба использует выданный ResolvedConnection, scoped repository и confined PostgreSQL-роль; задержка реализована в подставленном connector.

**Факт:** новое чтение сохранило 2 элемента; после завершения старого контекст возвращает **`status=OK`, `items=[]`**, asOf и lastSuccessAt равны **T**. Более свежая информация скрыта без ERROR/STALE. Уже записанный inbox этим не удаляется, но read-tool ресурса показывает неверное текущее состояние.

**Исправление:** сериализовать sync по connection/resource либо фиксировать версию попытки и условно заменять snapshot/state только актуальным результатом. Старый success/error не должен менять более новое состояние. Сохранение событий старого чтения рассмотреть отдельно от замены текущего snapshot, чтобы не терять evidence. Regression: старый success и старый failure завершаются после нового success; новый snapshot и временные метки остаются неизменными.

## B4 — [P2] Неполная пагинация Atera объявляется полным успешным чтением

**Место:** `connectors/atera/connector.ts:46–50`; `parsePage` в `connectors/atera/contract.ts:25` читает totalItemCount, но adapter его не использует.

Условие `page >= totalPages || items.length === 0` возвращает уже накопленную часть как полный результат. Пустая/nullable страница с ненулевым объявленным остатком не считается ошибкой. `SnapshotRead.itemCount` затем вычисляется как длина этой части, скрывая противоречие с vendor envelope.

**Воспроизведение через настоящий Atera adapter и scoped mock:** сначала обычные fixtures сохраняют 2 тикета. Во втором чтении страница 1 прежняя, а страница 2 — HTTP 200 с `{items: [], page: 2, totalPages: 2, totalItemCount: 2}`.

**Факт:** `syncResource` возвращает **OK, itemCount=1**; контекст — **OK, один тикет, truncated=false**. Последний полный snapshot из двух тикетов перезаписан неполным.

**Исправление:** проверять полноту и согласованность envelope/собранного набора, включая пустые страницы и повторяющиеся ID. При противоречии завершать чтение явной ошибкой; прежний snapshot сохранять и показывать STALE. Для изменившейся во время пагинации коллекции выбрать bounded retry или видимую ошибку, не выдавать часть за полный набор. Добавить проверки пустой промежуточной/последней страницы с объявленными оставшимися элементами и полного пустого набора как корректного контроля.

## Воспроизведённые команды и результаты

Среда: Node 25.8.1, PostgreSQL 17.11, уже работающий локальный compose. PostgreSQL-команды выполнялись с `ATLAS_PG_ADMIN_URL` локального сервера; credentials в отчёте не сохраняются. Использованы существующие зависимости. Persistent dev-БД не изменялась.

| Команда | Фактический результат |
|---|---|
| `npm test` | **60/60 PASS**, без skips; unit/reference + PGlite |
| `npm run typecheck` | PASS |
| `npm run api:build` | PASS |
| `npm run api:smoke` | PASS; fixture API |
| `npm run schema:validate` | PASS |
| `npm run db:check:pg17` | PASS; 7 миграций, structural/FK/RLS invariants, identities, mapping, snapshots, inbox, runtime role, pool reuse |
| `npm run test:pg` | **56/56 PASS**, без skips; Prisma deploy, roles.sql, seed, DB API, adapters/sync, inbox/worker |
| `npm run db:check:drift` | PASS; diff пустой |
| Два дополнительных `node --experimental-strip-types --input-type=module` PostgreSQL probe через stdin | **B1–B4 воспроизведены**, фактические результаты выше |
| `git diff --check` | PASS |

Каждая дополнительная проба создавала временную БД через `tests/support/pg-harness.ts:createTestDatabase`, выполняла `runSeed` и использовала `tests/support/events-fixtures.ts:liveHuntressWithConfirmedAgent`, `actors/gasta` из `tests/support/graph-fixtures.ts`. Worker-проба использовала два отдельных PrismaClient с runtimeUrl. Для B4 использован `vendor.overrides.ateraTicketsPage2` после bind/activate/resolve Atera `5001`. После проб соединения закрыты, временные БД и роли удалены. Исходники приложения и штатные тесты не менялись.

Новые regression-тесты нужны именно на описанные порядки выполнения. Существующие тесты двух workers используют непересекающиеся действующие lease; crash-тест моделирует одно падение, а bounded retry — только пойманные исключения. Тесты partial-page проверяют HTTP 503, но не HTTP 200 с противоречивой пагинацией. Это объясняет зелёный штатный набор при воспроизводимых дефектах.

## Подтверждённое и границы проверки

- Scoped mapping, составные typed FK, immutable tenant binding, candidate/confirm/quarantine и RLS проверены. Чужие записи vendor отклоняются, tenant-фильтр передаётся на каждой проверенной странице, секреты не попадают в проверенные context/audit.
- Обычные concurrent dedup, отдельное conflict evidence, две фазы decision/commit, rollback финальной транзакции, advisory failure и source urgency floor подтверждены существующими PostgreSQL-тестами. Проблемы B1/B2 ограничивают вывод о recovery.
- Resource-specific failures сохраняют предыдущий snapshot, не изменяют соседние ресурсы и отображают STALE/ERROR в последовательных сценариях. Проблемы B3/B4 ограничивают вывод о достоверности полного свежего набора.
- Новые изменения схемы находятся только в миграциях 1700/1800/1900; замороженные миграции не изменены.
- Официальная [Huntress Swagger specification](https://api.huntress.io/v1/swagger_doc.json), доступная из [API reference](https://api.huntress.io/docs), дополнительно прочитана без credentials: проверены organization_id, limit/page_token, status=sent, severity low/high/critical и используемые поля IncidentReport. Это проверка документации, **не live-read**.
- Atera contract остаётся **не сверенным с аккаунтом**. Чужой OpenAPI export не объявляется vendor/account verification. B4 воспроизводится уже на контракте, принятом самой реализацией, и не зависит от получения аккаунта.

## Открытые gates и следующий шаг

**Обязательные исправления перед принятием B: B1–B4.** После них повторить regression-пробы, `npm test`, typecheck, `test:pg`, schema validation/drift и API build/smoke; при изменении схемы добавить новую миграцию и повторить SQL/RLS checks. В CHECKPOINT_REPORT скорректировать утверждения о bounded crash recovery и полноте sync.

**Live Atera/Huntress/OpenAI не выполнялся.** Нет использованных реальных credentials или account mappings. Mock transport и синтетические fixtures не заменяют этот gate. Все перечисленные PostgreSQL-команды выполнены, но дополнительные recovery/sync-сценарии пока не проходят требования.

Отдельная durable shadow-job, timeout/budget/circuit-breaker и telemetry остаются заданием 1.7; отсутствие процесса по расписанию и RUNBOOK также явно отмечено автором. Эти известные ограничения не выданы здесь за уже реализованные возможности. `npm ci`, `npm audit`, Node 24, Windows, исторические мутационные проверки и persistent-dev deployment повторно не выполнялись.

Безопасно сначала исправить B1–B4 в текущих доменах и пройти повторное ревью. После принятия B — 1.7 Decision Layer. UI, remediation, write-tools, M365/PowerOffice и orchestration вне текущего scope не добавлять. Production-ready статус не присваивается.
