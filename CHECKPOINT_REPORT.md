# Atlas Stage 1 checkpoint

Date: 2026-10-07
Checkpoint: **B** (после задания 1.6)
Branch/commit: `stage1/foundation` @ `db872de` — проверенное состояние кода; этот отчёт закоммичен поверх. Checkpoint A принят ревью (`a04d805`); его отчёт: `git show 61122b9:CHECKPOINT_REPORT.md`.
Tasks completed: 1.4 Mapping workflow (`0506eae`); 1.5 Read adapters (`36ed428`, решение владельца по алертам Atera — `153e56a`); 1.6 Persistent sync/events (`20cd453`, тесты `806db3d`, `db872de`).

## Result

**Что проверено и где.**
- **Live:** ничего. Credentials нет; ни одного запроса к Atera, Huntress или OpenAI не было.
- **Вендоры в тестах:** HTTP идёт в локальный mock-транспорт с синтетическими ответами (`fixtures/vendor`). Это проверка адаптеров по контракту, **не live API verification**. Контракт Huntress сверен с официальной спецификацией. Контракт Atera взят из экспорта документации Atera OpenAPI v3 в стороннем публичном репозитории и с аккаунтом не сверен.
- **БД:** всё перечисленное ниже работает на PostgreSQL 17.11 через confined runtime-роль; на каждый тестовый файл — отдельная throwaway-БД. SQL-инварианты дополнительно гоняются в PGlite.

1. **Scoped evidence Atera/Huntress.**
   - **Привязка.** Клиент привязывается к Atera customer или Huntress organization явно: с автором и временем, в начальном состоянии DISABLED. Один tenant — один клиент: повторная привязка уже привязанного tenant отклоняется как CONFLICT, отказ записывается, первая привязка остаётся. В клиентский аудит не попадают ни tenant ID, ни secretRef.
   - **Активация.** Health check идёт к привязанному tenant с разрешённым секретом. Если проверка не прошла, connection остаётся DISABLED.
   - **Кто может читать.** Только выданный `ResolvedConnection`: скопированный или собранный вручную отклоняется до любой работы с БД. FIXTURE-подключения к вендору не обращаются.
   - **Фильтр по tenant.** Каждый upstream-запрос фильтруется на стороне вендора:
     - Huntress: `organization_id` на каждой странице;
     - Atera: `customerId` у тикетов, путь `/agents/customer/{id}` у агентов.

     Если в ответе есть запись чужого tenant, падает всё чтение (`UPSTREAM_SCOPE_MISMATCH`, PERMANENT), и ничего не сохраняется.
   - **Алерты Atera** не запрашиваются (решение владельца). В контексте они `MISSING` с причиной `UPSTREAM_TENANT_FILTER_UNAVAILABLE`.
   - **DTO и ошибки.** DTO проверяются при чтении. Расхождение с контрактом даёт PERMANENT-ошибку с именем поля, без значения. Контакты заявителя, комментарии и тексты аналитиков не копируются. Ошибки HTTP классифицируются без URL, заголовков, секрета и тела ответа.
   - **Сопоставление.** Matcher предлагает только CANDIDATE, и только по точному hostname внутри клиента. При неоднозначности не создаётся ничего.

2. **Durable event processing.**
   - **Источник событий.** Чтение открытых инцидентов Huntress пишет события в inbox в той же транзакции, что и snapshot.
     - Повторное чтение даёт дубликаты; новый `updated_at` — новая ревизия.
     - Неудачное чтение не сохраняет ничего, в том числе при сбое на второй странице.
   - **Хранение до обработки.** Дубликат определяется по eventKey v2 и payload hash и ничего не меняет: из 6 одновременных доставок через два пула — 1 STORED и 5 DUPLICATE.
   - **Конфликт содержания** (тот же ID и ревизия, другое содержание):
     - сохраняется отдельной строкой с `conflictOfEventKey`;
     - каноническая строка не перезаписывается, audit пишется один раз;
     - маршрут — `HUMAN_REVIEW` с собственной severity: CRITICAL остаётся URGENT, первое observation сохраняется;
     - если два разных содержания приходят одновременно, получаются одна каноническая строка, один конфликт и один audit.
   - **Две фазы.**
     - Захват: `FOR UPDATE SKIP LOCKED` с lease.
     - Фаза 1: DecisionRun записываются с `applied = false`, решение сохраняется.
     - Фаза 2, одна транзакция: applied, Observation, audit `observation.created` и PROCESSED.
     - Два worker на двух пулах обработали 12 событий, каждое ровно один раз: 12 observations, 12 applied runs, 12 вызовов провайдера.
   - **Advisory и shadow.**
     - Advisory: при сбое провайдера пишутся FAILED run с запрошенной моделью и применённый rules run, маршрут — `HUMAN_REVIEW`.
     - Shadow: rules применяется сразу; AI-run сохраняется с `applied = false` и на observation не влияет.

3. **Восстановление после рестарта.** Worker падает после фазы 1. Пока lease действует, другой worker событие не берёт. После истечения lease он фиксирует сохранённое решение: провайдер вызван один раз, applied run и observation — по одному, `attempts = 2`.

4. **Retry и dead-letter.**
   - **TRANSIENT-сбой финальной транзакции** откатывает её целиком, событие уходит в RETRY с backoff и аудитом `event.retry_scheduled`. Повтор использует сохранённое решение: один вызов провайдера, один applied run.
   - **После `maxAttempts`** событие уходит в DEAD_LETTER с аудитом `event.dead_lettered`; это видно в inbox view (`context:read`) вместе с кодом ошибки.
   - **Повреждённый сохранённый payload** сразу даёт DEAD_LETTER (`INVALID_EVENT`, PERMANENT).
   - **Повторной обработки само по себе нет.** Requeue — явное действие с правом `events:ingest` и аудитом `event.requeued`; reader получает отказ.

5. **Quarantine конфликтов привязки.**
   - Первое подтверждение выигрывает. Конфликтующая связь получает статус QUARANTINED с указателем на победившую; она хранится, но не используется.
   - Одновременные подтверждения из двух пулов дают ровно одну CONFIRMED.
   - Событие агента с карантинной связью — CONFLICT: `HUMAN_REVIEW`, без entity, `AMBIGUOUS_DEVICE_LINK`; CRITICAL остаётся URGENT.

6. **Health и freshness по конкретному ресурсу.** Состояние синхронизации хранится на пару connection + ресурс.
   - **Полное чтение** даёт OK.
   - **Сбой обновления:**
     - последний snapshot остаётся и показывается как STALE с кодом сбоя;
     - `lastSuccessAt` не сдвигается, Retry-After передаётся дальше.
   - **Изоляция сбоя.** Сбой тикетов Atera не трогает ни соседний ресурс (алерты сохраняют свою причину), ни другую connection (инциденты Huntress остаются OK); connection остаётся ACTIVE.
   - **Ни одного полного чтения** — ERROR, а не пустой список.
   - **Устаревание по возрасту:** alert и incident — 15 минут, ticket — 30 минут.
   - **`COMPLETE`** — только когда все ожидаемые ресурсы OK.

7. **Webhook metadata не принимается за identity.** Webhook и HTTP-маршрута приёма событий в Stage 1 нет; API с Checkpoint A не менялся. Событие принимается только через выданный `ResolvedConnection` и с правом `events:ingest`. Workspace, client, connection и source в теле события должны с ним совпасть, иначе `EVENT_SCOPE_MISMATCH`.

## Changes

**Схема.** Только новые миграции, замороженные не тронуты.
- `202610071700_stage1_mapping_workflow`:
  - словарь статусов Connection;
  - автор и время привязки, неизменяемые триггером;
  - `resourceType`/`entityKind` в `EntityLink` с составными FK и CHECK совместимости;
  - статус `QUARANTINED` с указателем внутри scope;
  - права `mapping:review`, `connections:manage`;
  - preflight.
- `202610071800_stage1_resource_snapshots`:
  - `ResourceSnapshot`: не больше 100 элементов плюс общее число у источника, FK на `SyncState`, RLS;
  - словарь `SyncState`.
- `202610071900_stage1_event_inbox`:
  - колонки inbox в `RawEvent`: `nextAttemptAt`, lease, `preparedDecision`;
  - CHECK на lease, на завершённые события и на коды ошибок;
  - индекс ожидающих событий;
  - словари `DecisionRun` (status, provider) с preflight.

**Сервисы.**
- `packages/connections/connections.ts` — привязка и выдача `ResolvedConnection`.
- `packages/graph/mapping.ts` — регистрация, кандидаты, confirm/quarantine/reject, очередь review.
- `packages/sync/snapshots.ts`, `activation.ts` — snapshot и события в одной транзакции, активация.
- `packages/graph/context-mapper.ts` (`mapResources`) — статусы `ResourceView`.
- `packages/events/inbox.ts`, `worker.ts`, `decision.ts`, `identity.ts` — durable inbox и worker. Логика маршрута общая с in-memory reference (`pipeline.ts`).

**Коннекторы.** `connectors/http.ts`, `dto.ts`, `huntress/*`, `atera/*`; источники контрактов и маппинги — в `connectors/CONTRACTS.md`.

**API и seed.** API не менялся. В seed синтетические связи получили `resourceType` (1.4).

**Тестовая поддержка.** `tests/support/mock-http.ts`, `vendor-routes.ts` (mock вендора с проверкой tenant-фильтра), `events-fixtures.ts`.

## Verification

Среда: macOS 26.6.2 arm64, Node 25.8.1, npm 11.11.0, PostgreSQL 17.11 (`postgres:17`, docker compose). Команды `npm` повторены на дереве `20cd453` после `npm ci`. Тесты коммитов `806db3d` и `db872de` прогнаны повторно: `npm test`, `typecheck`, `test:pg`.

| Command/scenario | Environment | Actual result |
|---|---|---|
| `npm ci` | локально | OK. Lockfile с Checkpoint A не менялся. `npm audit`: 10 находок (2 moderate, 8 high), те же, что в Checkpoint A |
| `npm run db:generate`, `npm run schema:validate` | локально | Prisma Client 6.19.0 сгенерирован, схема валидна |
| `npm test` | unit + PGlite | **60/60 pass**, включая SQL-инварианты inbox и бюджет контекста |
| `npm run typecheck`, `npm run api:build` | локально | pass |
| `npm run api:smoke`, `npm run demo` | fixture | PASS, поведение прежнее |
| `npm run db:check:pg17` | PostgreSQL 17.11 | PASS: 7 миграций по порядку; структурные инварианты, в том числе mapping, snapshot и inbox; RLS через login-роль; lookup-политики identities; RLS snapshot; guard runtime-роли; переиспользование соединений пула |
| `npm run test:pg` | PostgreSQL 17.11, throwaway-БД на файл | **56/56 pass**. Новые с Checkpoint A: connections 5, mapping 6, adapters 4, sync 4, inbox 4, worker 5, worker-routing 6. Прежние 22 тоже проходят |
| `npm run db:check:drift` | PostgreSQL 17.11, shadow-БД | PASS, diff пустой |
| Dev-БД: `db:deploy` | PostgreSQL 17.11, persistent volume | Миграции 1700, 1800 и 1900 применены по ходу заданий. `assertRuntimeRole` принимает `atlas_app` и отклоняет owner (`RUNTIME_ROLE_BYPASSES_RLS`). Inbox view через runtime-роль работает; в dev-БД событий 0, seed их не создаёт |
| Остатки тестовых прогонов | PostgreSQL 17.11 | Throwaway-БД и ролей не осталось: только `atlas` и `postgres`, роли `atlas` и `atlas_app` |
| Мутационные проверки (код временно ломался, затем восстанавливался) | PGlite / PostgreSQL 17 | Все пойманы. 1.4: ослабленная проверка неоднозначности; снятая проверка конфликта при подтверждении; без блокировки строки и без unique — гонка. 1.5: снятый tenant-фильтр; пропуск чужой записи; перезапись snapshot при сбое; игнор возраста snapshot. 1.6: решение не переиспользуется; без SKIP LOCKED и lease; без retry; карантин игнорируется; конфликт принят за дубликат; точка сбоя после commit; сбой на странице 2 молча проглочен; ERROR записан на все ресурсы connection |
| `git diff --check` | локально | чисто |

Покрытие проверок задания 1.6 из docs/05:
- два worker;
- повтор ревизии;
- рестарт;
- сбой на второй странице;
- видимый dead letter;
- карантинная связь с сохранённым CRITICAL;
- retry финального commit без второго вызова провайдера и без второго applied run;
- CRITICAL-повтор с другим содержанием в urgent review.

Все сценарии — тесты в `tests/pg/inbox|worker|worker-routing|sync.pg.test.ts`.

## Remaining gates / blockers

Блокеров для ревью нет. Не выполнено:
- **Live read-only smoke Atera/Huntress и live Decisions (OpenAI).** Нет credentials и сопоставления аккаунтов; по заданию это вне checkpoint и требует отдельного указания.
- **Контракт Atera с аккаунтом не сверен.** Документация вендора закрыта логином. Сверить по чек-листу `connectors/CONTRACTS.md` до активации live-подключения Atera.
- **Алерты Atera недоступны** по решению владельца. При доступе к аккаунту проверить, можно ли читать их по клиенту: фильтр, вебхук или endpoint по агенту.
- **События только из инцидентов Huntress.** Тикеты Atera — только snapshot. Закрытие инцидента событием не является. Жизненный цикл observation по ревизиям одного инцидента — задание 1.8.
- **Нет процесса-исполнителя.** `syncConnection` и `processPending` — функции. Запуска по расписанию (интервал, обход клиентов, graceful shutdown) пока нет; это нужно для RUNBOOK (1.10) или развёртывания.
- **Shadow-вызов выполняется в том же проходе worker.** Он идёт после фиксации baseline и не блокирует его, но задерживает следующее событие пакета. Lease во время обработки не продлевается: медленный провайдер может пережить lease остатка пакета, и тогда событие возьмёт другой worker. Второго observation не будет — финальная транзакция проверяет статус под блокировкой строки. Но возможен лишний вызов провайдера и лишняя попытка в `attempts`. Отдельная shadow-job, timeout, бюджет и circuit-breaker — задание 1.7.
- **Объём чтения Huntress ограничен:** 20 страниц по 100. Больше — `UPSTREAM_TOO_MANY_PAGES` (ERROR). Snapshot хранит не больше 100 элементов: сначала самые серьёзные, плюс общее число у источника.
- **Нет retention для `RawEvent`.** У runtime-роли нет DELETE, inbox растёт.
- **HTTP-маршрутов** для очереди сопоставления, привязки и inbox/requeue нет — только сервисы и аудит.
- **Node 24 ровно и Windows** не запускались.
- **`npm audit`, 10 находок** в закреплённых NestJS 11.1.6 и Prisma 6.19.0; нужен отдельный решённый patch-bump.
- **Перенесено из Checkpoint A:**
  - cursor и фильтры `GET /clients/:id/observations` (1.8);
  - администрирование identities;
  - ошибки аутентификации не попадают в security audit;
  - `ToolExecution` (1.9);
  - `MANIFEST.json` и `verification/RESULTS.md` описывают импортированный пакет, а не ветку.

## Decisions and scope

1. **Алерты Atera не читаются** (решение владельца, вариант 1, `153e56a`). Чтение всех алертов MSP-аккаунта с раскладкой по клиентам не делалось.
2. **«Incremental sync» в Stage 1 устроен так:** полное, ограниченное по объёму чтение открытого набора инцидентов плюс durable dedup. Курсора по времени нет. События пишутся атомарно со snapshot, поэтому чтение, упавшее на середине, не оставляет ни snapshot, ни событий.
3. **Outbox не используется:** в Stage 1 нет исходящих действий.
4. **Попытка считается при захвате.** Событие, на котором worker падает, тоже дойдёт до DEAD_LETTER после `maxAttempts`.
5. **Неизвестные ошибки** уходят в DEAD_LETTER сразу, как требует AGENTS.md: PERMANENT/unknown → dead-letter.
6. **Shadow AI-run пишется после финальной транзакции**, best effort; до задания 1.7 отдельной job нет.
7. **Значения по умолчанию** (настраиваются): lease 60 с, `maxAttempts` 3, пакет 10, backoff 30 с·2^(n−1), но не больше 15 минут.
8. **Решение и маршрут вычисляет общий `packages/events/decision.ts`.** Его используют и in-memory reference, и worker, так что расхождения правил нет.
9. **HTTP-маршруты сопоставления и inbox не добавлены:** в спецификации Stage 1 их нет.

**Scope.**
- **Ничего лишнего не добавлено:** нет write-tools и записей к вендорам (только GET), нет UI, Agents/Responses-оркестрации, векторной и графовой БД, развёртывания и изменений аккаунтов.
- **Что уходит в Decisions.** Провайдер OpenAI из пакета отправляет только `source`, `kind`, `sourceSeverity` и `diskPercent`. Summary, идентификаторы, имена и контакты не уходят.
- **Секреты.** В БД только `secretRef`; тестовые секреты mock-вендора живут в памяти теста; `.env` в git не попал.

## Next task

**После ревью — задание 1.7, Decision Layer.** Нужно:
- rules baseline, fixture и OpenAI shadow как **отдельная job**: baseline фиксируется до результата AI, а worker не ждёт shadow-вызова;
- `DecisionConfig` из versioned config; модель и allowlist ответов — из конфигурации;
- `MODEL_MISMATCH` с requested/response model в DecisionRun и метриках;
- advisory-сбой → `HUMAN_REVIEW`;
- переключение в `rules` при outage (circuit-breaker);
- telemetry, budget и retry.

Проверки (docs/05): timeout, refusal, дрейф схемы ответа, неизвестная модель, urgency floor; один applied run на событие; CRITICAL baseline доступен, пока shadow-вызов не завершён.

Файлы: `packages/events/decision.ts`, `packages/events/worker.ts` (`runShadow`, `processClaimed`), `packages/decisions/provider.ts`, `packages/decisions/openai.ts`, `docs/04_DECISION_LAYER.md`, `tests/pg/worker-routing.pg.test.ts`.

Старт:
1. Прочитать docs/04 и этот отчёт.
2. Вынести shadow из `processClaimed` в отдельный проход по событиям с завершённым baseline и без shadow-run: claim с lease, как у inbox.
3. Добавить тест: медленный shadow-провайдер не задерживает обработку следующего CRITICAL-события.
