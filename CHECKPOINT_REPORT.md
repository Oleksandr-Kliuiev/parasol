# Atlas Stage 1 checkpoint

- **Date:** 2026-10-07
- **Checkpoint:** **C** (после задания 1.10)
- **Branch/commit:** `stage1/foundation` @ `1a95845` — проверенное состояние. Этот отчёт закоммичен поверх и кода не меняет.
- **Предыдущий checkpoint:** B принят ревью (`2a753d2`); его отчёт — `git show 2a753d2:CHECKPOINT_REPORT.md`.
- **Tasks completed:**
  - 1.7 Decision Layer (`10f2578`);
  - 1.8 Observations and context (`7c9e8d6`);
  - 1.9 Tool Gateway (`9295f67`);
  - 1.10 Acceptance (`1a95845`).
- **Статус: не production-ready.**
  - Весь mock/recorded-объём выполнен и проверен на PostgreSQL 17.
  - Live-read gate заблокирован ровно одним: нет credentials (раздел «Remaining gates / blockers»).

## Result

Сквозной сценарий — `tests/pg/e2e.pg.test.ts` на PostgreSQL 17.11, документированным путём:
- владелец: `prisma migrate deploy`, `roles.sql`, synthetic seed;
- дальше всё через runtime-роль: операторские команды (тот же код, что `npm run ops`) и собранный API в `ATLAS_MODE=db` под токеном техника.

Вендоры — mock transport, Decisions — scripted endpoint. **Это не live-проверка.** Evidence этого прогона — `verification/e2e/*.json`.

### Полный context (`verification/e2e/4-context.json`)

Граф: Gasta → Kari → GASTA-LT-07, четыре подтверждённые связи:
- две из seed (FIXTURE-подключения);
- две оператор подтвердил после ревью: Huntress agent 207001 и Atera agent 107001. Совпадение hostname дало только CANDIDATE.

Observations (активные, по приоритету):

| Событие | Severity | Priority | Route | Entity | reasonCodes |
|---|---|---|---|---|---|
| Huntress 9001 | CRITICAL | URGENT | HUMAN_REVIEW | `demo-device-07` | RULES_BASELINE, SOURCE_URGENCY_FLOOR |
| Huntress 9002 | LOW | NORMAL | HUMAN_REVIEW | — | RULES_BASELINE, UNRESOLVED_DEVICE |

Ресурсы (в порядке ID подключения):

| Подключение | Ресурс | Статус | Код / данные |
|---|---|---|---|
| `demo-atera-connection` (FIXTURE seed) | alert, ticket | MISSING | `SYNC_NOT_CONFIGURED` |
| `demo-huntress-connection` (FIXTURE seed) | incident | MISSING | `SYNC_NOT_CONFIGURED` |
| `gasta-atera` | alert | MISSING | `UPSTREAM_TENANT_FILTER_UNAVAILABLE` (решение владельца) |
| `gasta-atera` | ticket | OK | 2 тикета |
| `gasta-huntress` | incident | OK | 2 инцидента |

- `completeness: PARTIAL`.
- В контексте нет `env://`, `secretRef`, токенов, тестовых credentials и текста аналитика.

### Shadow Decisions: applied и non-applied runs (`3-worker-pass.json`, `6-telemetry.json`)

Конфигурация `decisions-2026-10-07.1`, режим shadow, OpenAI-адаптер поверх scripted endpoint. Модель ответила MONITOR 0.95 на оба события.

| Событие | applied | provider | route | модель | input tokens | на run ссылается observation |
|---|---|---|---|---|---|---|
| 9001 | true | rules | HUMAN_REVIEW | — | — | да |
| 9001 | false | openai | MONITOR | gpt-6-luna | 42 | нет |
| 9002 | true | rules | INVESTIGATE | — | — | да |
| 9002 | false | openai | MONITOR | gpt-6-luna | 42 | нет |

- **MONITOR модели ничего не изменил.** Observation ссылается только на applied rules run. CRITICAL остался URGENT/HUMAN_REVIEW по urgency floor. У 9002 маршрут observation — HUMAN_REVIEW, потому что устройство не сопоставлено; собственный маршрут applied run (INVESTIGATE) хранится в run.
- **Вход Decisions — только** `{"source":"huntress","kind":"SECURITY_INCIDENT","sourceSeverity":…}`: без имён, hostname, summary и ID.
- **Telemetry:**
  - runs: openai OK 2, rules OK 2;
  - input tokens: 84, по 42 на вызов;
  - согласие с baseline: HUMAN_REVIEW→MONITOR 1, INVESTIGATE→MONITOR 1 — это согласие с baseline, не точность;
  - shadow jobs: DONE 2; отказов guard нет.

### Read tools с audit (`5-read-tools.json`)

`POST /tools/execute` от `demo-technician` (`context:read`):

| requestId | Инструмент | HTTP | ToolExecution | Audit |
|---|---|---|---|---|
| req-e2e-0001 | `huntress.incident.get` {9001, `connectionId: gasta-huntress`} | 201 | SUCCEEDED | started, succeeded |
| req-e2e-0002 | `huntress.incident.list` без `connectionId` (у клиента два Huntress-подключения) | 409 | FAILED `AMBIGUOUS_CONNECTION` | started, failed |
| req-e2e-0003 | `atera.ticket.list` {`connectionId: gasta-atera`} | 201 | SUCCEEDED, 2 тикета | started, succeeded |
| req-e2e-0004 | `atlas.observation.list` {severity CRITICAL, HIGH} | 201 | SUCCEEDED, 9001 | started, succeeded |
| req-e2e-0005 | `atera.ticket.create` | 403 | — | `tool.denied` UNKNOWN_TOOL |
| req-e2e-0006 | `atera.ticket.list` для `demo-other` | 403 | — | workspace security audit `tool.scope_denied`, `requestedClientId demo-other`; audit `demo-other` пуст |

`X-Atlas-Correlation-Id` = requestId; `X-Atlas-Tool-Execution-Id` = ID строки ToolExecution.

### Операторский путь (задание 1.10)

- **`bind` → `live-read` через mock vendor:**
  - activation ACTIVE, health OK;
  - identities: Huntress 2 / 1 candidate, Atera 1 / 1 candidate;
  - ресурсы: Huntress incident OK (2 события в inbox), Atera ticket OK, alert UNAVAILABLE;
  - все запросы — GET с фильтром tenant; алерты Atera не запрашивались.
- **Отказ health check активного подключения (401):** `UPSTREAM_AUTH_FAILED`, проверка заканчивается после одного запроса.
- **Ревью и разбор:**
  - очередь ревью и подтверждение;
  - проход worker;
  - triage: acknowledge, затем resolve с ожидаемым статусом; устаревшее ожидание → `OBSERVATION_STATUS_CHANGED`;
  - telemetry.
- **Отказы:**
  - чужой клиент, неверный ID клиента, нет права → `ops.scope_denied` в workspace security audit;
  - URL владельца, чужой токен → exit 2.
- **CLI как процесс** (`tests/pg/ops-cli.pg.test.ts`): dead letter виден в `inbox`, после исправления `requeue` и проход его завершают; `worker-once` в режиме `rules` работает без ключа.

### Fixture-тесты, PGlite, PostgreSQL 17 и live: что доказывает каждый слой

| Слой | Доказывает | Не доказывает |
|---|---|---|
| Fixture/unit (67 тестов, Node) | Контракты, правила и reference pipeline, политику и схемы параметров gateway, конфигурацию и guard Decisions, разбор DTO по синтетическим ответам вендоров, аргументы CLI | Ни БД, ни транзакций, ни конкуренции |
| PGlite (13 тестов) | SQL всех 12 миграций: ограничения, триггеры, RLS-политики, путь обновления, guard runtime-роли — in-process через `SET ROLE` | Одно соединение, не сервер: нет login-роли, пулов, конкуренции, пути Prisma Client |
| PostgreSQL 17 (108 тестов, `db:check:pg17`, drift) | Настоящий сервер и документированная установка; Prisma Client через ограниченную login-роль; два пула, `SKIP LOCKED`, advisory locks, generic plans; собранные API и CLI как процессы | Вендоры — mock transport с синтетическими ответами по документированным контрактам, Decisions — scripted fetch; ничего из реального аккаунта |
| Live-read validation | Реальные фильтры tenant, права ключей, пагинация, rate limits, контракт Atera на аккаунте, реальный идентификатор модели и `usage` | **Не выполнялась** |

## Changes

**1.7 Decision Layer** (`10f2578`):
- Миграция `202610072200_stage1_decision_layer`: `DecisionRun.configVersion`; таблица `ShadowJob` (RLS, lease с claim token, по одной на событие).
- Версионируемый `config/decisions.json` со строгой проверкой. Override из окружения помечает версию суффиксом `-env`.
- Shadow — отдельная durable job; worker в shadow-режиме провайдер не вызывает.
- `DecisionGuard`: circuit breaker и бюджет в минуту. В advisory при открытом circuit или исчерпанном бюджете событие явно переходит в rules.
- Telemetry; `usage.input_tokens`, если он есть.

**1.8 Observations and context** (`7c9e8d6`):
- Миграция `202610072300_stage1_observation_lifecycle`:
  - право `observations:triage`;
  - автор и время acknowledge;
  - `supersededById`;
  - триггер допустимых переходов и неизменяемости evidence.
- Triage с условием по ожидаемому статусу.
- Жизненный цикл ревизий под advisory lock:
  - urgent evidence не закрывается не-urgent ревизией;
  - поздняя ревизия сразу superseded;
  - конфликты остаются в ревью.
- Страницы observations: фильтры status/severity и keyset cursor, привязанный к фильтрам. Контекст показывает OPEN и ACKNOWLEDGED.

**1.9 Tool Gateway** (`9295f67`):
- Миграция `202610080000_stage1_tool_gateway`: `ToolExecution` как реестр выполнений — проверки, триггер, только read.
- Детерминированная политика: scope → имя → реестр → read-only → право.
- Строгие схемы параметров, 7 read tools.
- Выполнение пишется вместе со строками audit.
- DTO v1 с `requestId`; заголовки корреляции; CONFLICT → 409.

**1.10 Acceptance** (`1a95845`):
- **Операторский CLI** `npm run ops -- <команда>` (`scripts/ops.ts`, `packages/ops/`):
  - `bind`, `live-read`;
  - `mapping`, `confirm-link`, `reject-link`;
  - `inbox`, `requeue`;
  - `triage`, `telemetry`;
  - `worker-once`, `decisions-smoke`.

  Работает только через runtime-роль, актор определяется токеном. Отказы по scope и правам пишутся в workspace security audit. Вывод — JSON; exit-коды 0, 1, 2.
- **Seed** создаёт синтетического оператора с `ATLAS_OPERATOR_TOKEN`.
- **Тесты:** E2E, тест CLI-процесса, unit-тесты CLI.
- **Документация:**
  - `docs/RUNBOOK.md`;
  - матрица приёмки «gate → тест → окружение» в docs/06;
  - датированный `verification/RESULTS.md` с evidence.
- **Миграций в 1.10 нет.**
- **Исправлено по находкам E2E:**
  - **Read tools брали первую попавшуюся строку.** Если у клиента несколько подключений одного источника (FIXTURE seed рядом с живым), инструмент возвращал первую строку, а контекст перечислял подключения в физическом порядке. Теперь:
    - `connectionId` выбирает подключение, без него — `AMBIGUOUS_CONNECTION` (409);
    - сущности, связи и подключения идут в порядке ID;
    - версии инструментов остаются `1`, релиза не было.
  - **Triage принимал унаследованные имена действий.** `toString` проходил проверку и падал TypeError; теперь — `INVALID_TRIAGE_ACTION`.

## Verification

Среда: macOS 26.6.2 arm64, Node 25.8.1, npm 11.11.0, PostgreSQL 17.11 (`postgres:17`, docker compose). Полный прогон начат с `rm -rf node_modules dist && npm ci` на дереве `1a95845`. Подробности — `verification/RESULTS.md`.

| Command/scenario | Environment | Actual result |
|---|---|---|
| `npm ci`, `db:generate`, `schema:validate` | локально | OK. Lockfile не менялся; `npm audit` — те же 10 находок (2 moderate, 8 high) |
| `npm test` | unit + fixture + PGlite | **80/80** (67 unit/fixture, 13 PGlite) |
| `npm run typecheck`, `npm run api:build` | локально | pass |
| `npm run api:smoke`, `npm run demo` | fixture | PASS |
| `npm run db:check:pg17` | PostgreSQL 17.11 | PASS: 12 миграций по порядку; инварианты mapping, snapshots, inbox, decision layer, lifecycle, ledger; RLS через login-роль; guard; переиспользование соединений пула |
| `npm run test:pg` | PostgreSQL 17.11, throwaway-БД на файл | **108/108** в 20 файлах. С Checkpoint B добавлены: shadow-jobs, decision-advisory, observation-lifecycle, tool-gateway (1.7–1.9), e2e — 9, ops-cli — 4. Прежние тесты проходят |
| E2E с evidence | PostgreSQL 17.11 | 9/9, `verification/e2e/*.json` |
| `npm run db:check:drift` | PostgreSQL 17.11 | PASS, diff пустой |
| Dev-БД | PostgreSQL 17.11, persistent volume | См. список после таблицы |
| Остатки прогонов | PostgreSQL 17.11 | Throwaway-БД, ролей и процессов не осталось |
| Мутационные проверки | PGlite / PostgreSQL 17 | Все пойманы (код временно ломался, затем восстанавливался). См. список после таблицы |
| `git diff --check` | локально | чисто |

Dev-БД:
- `db:deploy`: новых миграций нет;
- seed с обоими токенами;
- `ops`: `mapping`, `inbox`, `telemetry`, `worker-once` (rules) — exit 0;
- shadow без ключа — `OPENAI_KEY_REQUIRED`; URL владельца — `RUNTIME_ROLE_BYPASSES_RLS`; токен техника на `mapping` — `PERMISSION_DENIED`;
- API: overview 200 (PARTIAL, три MISSING-ресурса fixture), оператор на `/audit/security` — 403, старт через владельца отклонён.

Мутационные проверки по заданиям:
- **1.7:**
  - нет shadow job в финальной транзакции;
  - advisory игнорирует guard;
  - повторы shadow сверх бюджета;
  - shadow run без проверки захвата;
  - нет input tokens; нет `configVersion`;
  - отказ модели считается outage;
  - override не помечен.
- **1.8:**
  - контекст показывает закрытые;
  - urgent закрыт не-urgent ревизией;
  - поздняя ревизия не superseded;
  - нет блокировки объекта источника;
  - конфликты superseded;
  - keyset теряет равные;
  - cursor не привязан к фильтрам;
  - triage без ожидаемого статуса;
  - evidence не защищено.
- **1.9:**
  - write tool проходит политику;
  - право до scope;
  - параметры не проверяются;
  - выполнение не в реестре;
  - hash без параметров;
  - get возвращает весь список;
  - реестр принимает write;
  - любая версия DTO;
  - заголовок корреляции после проверки доступа.
- **1.10 — 16 из 16:**
  - неоднозначность не отклоняется; `connectionId` игнорируется;
  - нет security audit отказа CLI; права CLI не проверяются;
  - повтор флагов; унаследованные имена команд;
  - вердикт live-read без ресурсов; smoke всегда OK;
  - унаследованные действия triage;
  - нет проверки runtime-роли; провал проверки → exit 0;
  - shadow-проход со временем начала;
  - нет health-gate и activation-gate;
  - подключения в физическом порядке;
  - seed игнорирует токен оператора.

  Ловля мутации «физический порядок» зависит от порядка строк в прогоне, PostgreSQL его не гарантирует.

## Remaining gates / blockers

**Блокер live-read gate (docs/06) — нет credentials.** Нужны:
- read-only API-ключ Atera и customer ID;
- пара key:secret Huntress и organization ID;
- `OPENAI_API_KEY` для Decisions smoke.

Всё, что можно сделать без них, сделано: тот же код проверен с mock transport, процедура и команды готовы (`docs/RUNBOOK.md` §5). До первого live-чтения Atera нужна сверка контракта с аккаунтом по чек-листу `connectors/CONTRACTS.md`; она входит в этот же gate. Live account setup и deployment без отдельного указания не начинаю.

**Не production-ready** — открыто и названо:
- **Нет планировщика и долгоживущего worker.** `worker-once` запускается вручную или внешним таймером.
- **Lease во время обработки не продлевается.** Медленный провайдер может привести к лишнему вызову: устаревший worker получит `CLAIM_LOST`. Истёкший lease тратит попытку.
- **Нет vault backend (`vault://`) и provisioning акторов и токенов.** Есть только синтетические акторы seed.
- **Нет HTTP-маршрутов** для привязки, ревью сопоставлений, inbox/requeue и triage — только CLI и сервисы.
- **Ошибки аутентификации (401) не пишутся в security audit.**
- **Нет retention `RawEvent`:** у runtime-роли нет DELETE.
- **Объём чтения ограничен:** Huntress 20×100, Atera 40×50, snapshot ≤ 100 элементов.
- **Алерты Atera недоступны** по решению владельца.
- **`npm audit`: 10 находок** в закреплённых NestJS 11.1.6 и Prisma 6.19.0. Нужен отдельный решённый bump до production.
- **Не запускались:** Node 24, Linux, Windows; CI нет. Точность классификатора, порог, задержка и цена live-провайдера не измерены.
- **`MANIFEST.json` описывает импортированный пакет.** Ветку идентифицирует commit.

## Decisions and scope

1. **Операторский CLI** вместо HTTP-маршрутов администрирования. Без него RUNBOOK и live-gate нельзя выполнить. CLI — тонкая обёртка над уже проверенными сервисами, со своей границей: runtime-роль, токен, security audit отказов. UI и новых HTTP-маршрутов нет.
2. **`connectionId` у source-инструментов и отказ при неоднозначности** — исправление дефекта 1.9, найденного E2E. Версии инструментов остаются `1`, релиза не было.
3. **Синтетический оператор в seed.** Seed — одна из двух разрешённых операций владельца, и создание актора там не нарушает правило «владелец — только миграции и seed».
4. **E2E пишет evidence только при `ATLAS_E2E_EVIDENCE_DIR`.** Обычный прогон тестов файлов не создаёт.
5. **Scope:**
   - нет write-actions (транспорт адаптеров допускает только GET), UI, Agents/Responses-оркестрации, векторной и графовой БД;
   - нет deployment и изменений аккаунтов;
   - в Decisions уходят только `source`, `kind`, `sourceSeverity` (и `diskPercent`);
   - в БД только `secretRef`; `.env` в git не попадает;
   - зависимости закреплены, Prisma 6.19.

## Next task

**Ревью Checkpoint C.** Дальше, при наличии credentials и отдельного указания, — live-read gate по `docs/RUNBOOK.md` §5:
1. Чек-лист Atera в `connectors/CONTRACTS.md`.
2. `npm run ops -- bind` для обоих tenant.
3. `live-read` с секретом только в окружении команды.
4. Ревью сопоставлений.
5. `worker-once`.
6. `decisions-smoke`.
7. Результаты — в раздел live `verification/RESULTS.md`: статусы, счётчики, коды; без credentials и tenant ID.

Файлы: `docs/RUNBOOK.md`, `scripts/ops.ts`, `packages/ops/commands.ts`, `connectors/CONTRACTS.md`.
