# RUNBOOK — Atlas Stage 1

Как установить, запустить и обслуживать Stage 1 и как пройти live-read gate. Stage 1 — read-only: нет UI, write-actions, планировщика и deployment. Это **не** production-ready система: что проверено и где, — `verification/RESULTS.md`, открытые gates — `CHECKPOINT_REPORT.md`.

## 1. Роли, акторы, секреты

| Кто | Подключение | Что делает |
|---|---|---|
| Владелец БД | `DATABASE_URL` | Только `db:deploy`, `prisma/roles.sql` и синтетический seed. Обходит RLS, поэтому приложению не передаётся |
| Runtime-роль `atlas_app` | `ATLAS_RUNTIME_DATABASE_URL` | API, ops CLI, worker. Старт через владельца или роль с BYPASSRLS отклоняется: `RUNTIME_ROLE_BYPASSES_RLS` |

Синтетические акторы seed (`fixtures/gasta.ts`), клиент `demo-gasta`:

| Актор | Токен | Права |
|---|---|---|
| `demo-technician` | `ATLAS_DEMO_TOKEN` | `context:read`, `events:ingest`; workspace `security_audit:read` |
| `demo-operator` | `ATLAS_OPERATOR_TOKEN` | `context:read`, `connections:manage`, `events:ingest`, `mapping:review`, `observations:triage` |

- В БД хранится только SHA-256 токена. Токены должны различаться.
- Новый токен: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
- Повторный `db:seed` с новым значением заменяет дайджест: старый токен перестаёт работать.
- Создание реальных акторов (provisioning) в Stage 1 не реализовано.

Секреты вендоров:
- В БД хранится только ссылка `env://NAME`. Само значение хранится в vault оператора и попадает в окружение одной команды. Пример с 1Password CLI: `op run --env-file=live.env -- npm run ops -- live-read …`.
- Не экспортируйте секрет в профиль shell и не кладите в `.env` репозитория.
- `vault://` в Stage 1 не подключён: такая ссылка даёт `SECRET_BACKEND_NOT_CONFIGURED`.

## 2. Установка (локально, PostgreSQL 17)

```sh
npm ci && npm run db:generate
docker compose up -d                                                        # PostgreSQL 17 на 127.0.0.1:5432
npm run db:deploy                                                           # владелец: миграции
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v atlas_app_password="$(cat /path/to/app-secret)" \
  -v atlas_cleanup_runner_password="$(cat /path/to/runner-secret)" -f prisma/roles.sql   # владелец, после КАЖДОГО db:deploy
```
Текущий `prisma/roles.sql` дополнительно требует `-v atlas_poweroffice_runner_password=…` и (R-EVAL RS-A, `\ir roles/reval.sql` в той же
транзакции) `-v atlas_reval_reader_password="$(cat /path/to/reval-reader-secret)"`. Как и для принятых ролей, значения `-v` видны в argv
процесса psql на время provisioning; выполняйте только в доверенной сессии владельца.

`prisma/roles.sql` идемпотентен (Stage 2): создаёт отсутствующие роли `atlas_app` (runtime), `atlas_m365_cleanup_definer`
(NOLOGIN, владелец процедуры очистки) и `atlas_m365_cleanup_runner` (LOGIN, только EXECUTE процедуры), проверяет
изоляцию существующих ролей, не меняя их пароли, и заново применяет все GRANT/REVOKE. С Stage 3 (S3-A) он также создаёт
`atlas_action_fence_definer` (NOLOGIN, владелец триггерной функции authority fence) и проверяет полноту fence — раздел 9. Пока он не выполнен после
обновления, `assertRuntimeRole()` отказывает в старте (`RUNTIME_ROLE_NOT_CONFINED`). Подключение runner к операторскому
`m365-cleanup` и порядок обновления Stage 2 — раздел 8.

```sh
ATLAS_DEMO_TOKEN=… ATLAS_OPERATOR_TOKEN=… npm run db:seed                  # владелец: синтетический граф и акторы
```

Seed не удаляет данные, его можно повторять. Проверки пакета перечислены в docs/06 «Reference pack checks». Перед live-gate прогоните их полностью.

## 3. Запуск

**API** слушает только `127.0.0.1:${ATLAS_API_PORT:-3100}`:

```sh
npm run api:build && ATLAS_MODE=db ATLAS_RUNTIME_DATABASE_URL=… npm run api:start
```

Маршруты с `Authorization: Bearer <token>`:
- `GET /clients`
- `GET /clients/:id/overview` — `ClientContextV1`
- `GET /clients/:id/observations?status=&severity=&limit=&cursor=`
- `GET /clients/:id/audit`
- `GET /audit/security`
- `GET /tools`
- `POST /tools/execute`

Тело `POST /tools/execute`: `{ "version": "1", "requestId": "…", "clientId": "…", "tool": "…", "parameters": {…} }`. Корреляция возвращается в `X-Atlas-Correlation-Id`, запись реестра — в `X-Atlas-Tool-Execution-Id`.

Если у клиента несколько подключений одного источника (FIXTURE из seed и живое, или два tenant), source-инструменты требуют `parameters.connectionId`. Без него ответ — 409 `AMBIGUOUS_CONNECTION`; первая попавшаяся строка никогда не возвращается.

**Worker.** Планировщика в Stage 1 нет. Проходы запускаются вручную или внешними таймерами (cron, systemd timer). Baseline и shadow — два отдельных прохода; запускайте их от **независимых** таймеров:

```sh
npm run ops -- worker-once     # baseline: обработка событий, в shadow-режиме провайдер не вызывается
npm run ops -- shadow-once     # только в shadow-режиме: shadow-задания (вызовы модели, non-applied runs)
```

Медленный shadow-эксперимент одного клиента не задерживает baseline другого. Не объединяйте два прохода в один процесс: systemd не запускает таймер, пока предыдущий запуск не завершился.

Параллельные проходы безопасны: claim, lease и claim token. Режим решений берётся из `config/decisions.json`:
- в `shadow` и `advisory` нужен `OPENAI_API_KEY`;
- `ATLAS_DECISIONS_MODE=rules` работает без провайдера. Такой override помечает версию суффиксом `-env`;
- guard провайдера (circuit breaker, бюджет в минуту) живёт в процессе, то есть действует в пределах одного прохода. При устойчивом сбое провайдера переключите режим на `rules` (раздел 6).

## 4. Операторские команды — `npm run ops -- <команда>`

Все команды, кроме `decisions-smoke`, требуют:
- `ATLAS_RUNTIME_DATABASE_URL` — только runtime-роль, владелец отклоняется;
- `ATLAS_OPERATOR_TOKEN` — токен актора, выполняющего команду.

Вывод — один JSON: статусы, счётчики, ID Atlas и безопасные коды, без токенов и credentials.

Exit codes:
- `0` — выполнено;
- `1` — команда отработала, но проверка не прошла (`live-read`, `decisions-smoke`);
- `2` — ошибка аргументов, аутентификации или отказ.

Запрос по чужому или некорректному клиенту и нехватка права отклоняются до вызова сервиса. Такой отказ записывается в workspace security audit (`ops.scope_denied`), а не в audit клиента.

| Команда | Право | Что делает |
|---|---|---|
| `bind --client C --connection N --system atera\|huntress --tenant T --secret-ref env://NAME` | `connections:manage` | Явная привязка tenant, статус `DISABLED`. Повторная привязка того же tenant отклоняется |
| `live-read --client C --connection N` | `connections:manage` + `events:ingest` | Активация (health check) при необходимости, health check и одна ограниченная синхронизация identities и ресурсов. Только GET |
| `mapping --client C` | `mapping:review` | Очередь ревью: сначала конфликты (QUARANTINED), затем кандидаты |
| `confirm-link --client C --link L` / `reject-link … [--reason CODE]` | `mapping:review` | Решение по кандидату или конфликту. Отклонение CONFIRMED — отзыв |
| `inbox --client C` | `context:read` | События RECEIVED, RETRY и DEAD_LETTER: eventKey, попытки, последний код |
| `requeue --client C --event KEY` | `events:ingest` | Явная повторная обработка одного dead letter, с audit |
| `triage --client C --observation O --action acknowledge\|resolve\|suppress\|reopen [--expected STATUS]` | `observations:triage` | Изменение жизненного цикла. С `--expected` чужое изменение даёт `OBSERVATION_STATUS_CHANGED`, а не перезапись. Если новая ревизия того же инцидента успела заменить observation (superseded), triage получает этот же отказ; закрытое человеком новая ревизия не трогает |
| `telemetry --client C [--minutes N]` | `context:read` | Runs, задержки, input tokens, согласие shadow с baseline, отказы guard, доля review (N ≤ 7 дней) |
| `worker-once` | `events:ingest` на клиенте | Один проход baseline (worker) по всем клиентам оператора |
| `shadow-once` | `events:ingest` на клиенте | Один проход shadow-заданий по всем клиентам оператора; вне shadow-режима — пустой |
| `decisions-smoke` | — (`OPENAI_API_KEY`, без БД) | Один вызов Decisions с компактным синтетическим входом |

## 5. Live-read onboarding gate (docs/06)

Цель — показать health и ограниченное чтение реальных tenant, ничего не меняя у вендора. Отдельно выполняется Decisions smoke на синтетическом входе.

Нужно заранее:
- read-only API-ключ Atera и пара key:secret Huntress — в vault;
- Atera customer ID и Huntress organization ID клиента;
- `OPENAI_API_KEY` для smoke;
- отдельная dev-БД по разделу 2.

1. **Контракт Atera.** Пройдите чек-лист аккаунта в `connectors/CONTRACTS.md`: поля, схема аутентификации, часовой пояс, статусы «open», фильтр alerts по клиенту. Расхождение — остановка: обновить контракт отдельной задачей.
2. **Привязка:**
   ```sh
   npm run ops -- bind --client demo-gasta --connection gasta-atera --system atera --tenant <AteraCustomerID> --secret-ref env://ATERA_GASTA
   npm run ops -- bind --client demo-gasta --connection gasta-huntress --system huntress --tenant <HuntressOrgID> --secret-ref env://HUNTRESS_GASTA
   ```
3. **Чтение.** Секрет попадает только в окружение одной команды:
   ```sh
   op run --env-file=live.env -- npm run ops -- live-read --client demo-gasta --connection gasta-atera
   ```
   Ожидается exit 0:
   - `activation ACTIVE`, `health OK`, `identities OK`;
   - Atera: `ticket OK`; `alert UNAVAILABLE` с `UPSTREAM_TENANT_FILTER_UNAVAILABLE` — решение владельца, не сбой;
   - Huntress: `incident OK`.

   Сверьте `itemCount` с консолью вендора по тому же клиенту.
4. **Остановка при exit 1 или 2.** Запишите `safeErrorCode`, повторы в цикле не запускайте.
   - `UPSTREAM_AUTH_FAILED` — ключ или его права;
   - `UPSTREAM_SCOPE_MISMATCH` — чужой tenant;
   - `UPSTREAM_PAGINATION_INCONSISTENT` — страницы не сошлись;
   - `UPSTREAM_CONTRACT_MISMATCH` — поле не по контракту;
   - `UPSTREAM_RATE_LIMITED` — ждите `retryAfterSeconds`.
5. **Mapping.** Выполните `npm run ops -- mapping --client demo-gasta`. Кандидат подтверждайте только после сверки устройства в консоли вендора: совпадение hostname не доказывает идентичность.
6. **Решения и контекст:**
   - `ATLAS_DECISIONS_MODE=rules npm run ops -- worker-once` (shadow-режим: ещё `shadow-once`, с ключом);
   - затем `GET /clients/demo-gasta/overview` с `ATLAS_DEMO_TOKEN`;
   - live-ресурсы `OK` и `asOf` свежий. FIXTURE-подключения seed остаются `MISSING` — это честный ответ, не ошибка.
7. **Decisions smoke:** `op run … -- npm run ops -- decisions-smoke`. Ожидается exit 0, `route`, `confidence` и `requestedModel = responseModel`.
   - Другой идентификатор модели — `MODEL_MISMATCH`. Allowlist меняется только вместе с новым `configVersion`.
   - Billing и доступ к аккаунту не предполагаются.
8. **Запись результата.** В `verification/RESULTS.md`, раздел live: дата, commit, команда, exit code, статусы, счётчики и коды из JSON. Без credentials, tenant ID и содержимого записей.

Gate не создаёт и не закрывает tickets, не сбрасывает MFA, не отзывает сессии, ничего не отключает и не пишет клиентам. Транспорт адаптеров допускает только GET (`connectors/http.ts`).

## 6. Эксплуатационные действия (docs/06 «Operational actions»)

- **Провайдер деградировал.** Запускайте worker с `ATLAS_DECISIONS_MODE=rules` или выпустите новый `configVersion` с `mode: rules`.
  - Ingestion, контекст и read tools продолжают работать.
  - В advisory открытый circuit breaker или исчерпанный бюджет уже переводят событие в rules: `PROVIDER_CIRCUIT_OPEN` / `PROVIDER_BUDGET_EXHAUSTED` в reasonCodes.
  - Состояние видно в `telemetry` и в `guard` вывода `worker-once` / `shadow-once`. Guard действует в пределах прохода, поэтому устойчивый сбой — повод переключиться на `rules`, а не ждать circuit breaker.
- **Vendor 429.** Ресурс получает `ERROR`/`STALE` с `UPSTREAM_RATE_LIMITED` и `retryAfterSeconds`. Следующее чтение — не раньше. Snapshot сохраняется с прежним `asOf`.
- **Устройство не сопоставлено.** Observation получает `HUMAN_REVIEW` с `UNRESOLVED_DEVICE` или `AMBIGUOUS_DEVICE_LINK`; ревью через `mapping`, `confirm-link` / `reject-link`.
- **Устаревший snapshot.** `STALE` с `asOf` и кодом: показывать последний snapshot, не утверждать актуальные числа. Окна свежести: alerts и incidents — 15 мин, tickets — 30 мин.
- **Сбой обработки события.** Сначала ограниченные `RETRY`, затем `DEAD_LETTER` с audit `event.dead_lettered`; событие видно в `inbox`. После исправления причины — `requeue`. Если решение фазы 1 уже было сохранено, оно переиспользуется, и провайдер повторно не вызывается.
- **Откат:**
  - остановите внешние таймеры `worker-once` и `shadow-once` и запуски `live-read`;
  - переведите решения в `rules`;
  - БД и оба audit-журнала сохраните.
  
  Никогда не выполняйте `prisma migrate reset`, `DROP` или `TRUNCATE`: у runtime-роли нет DELETE и TRUNCATE, audit неизменяем.

## 7. Чего в Stage 1 нет

- Планировщик и long-running worker (`apps/worker` — граница процесса).
- Vault backend (`vault://`) и provisioning акторов и токенов.
- Чтение alerts Atera.
- UI, write-actions, deployment.
- Live-проверка вендоров и Decisions — её выполняет раздел 5 при наличии credentials.

## 8. Stage 2 Microsoft 365: чтения, корреляция, обслуживание

Контракты: `docs/stage2/02_CONTRACTS.md` §1–6, `03_CONNECTOR_SYNC.md` §3, §5, §6. Live-доступ к tenant здесь не описан и не
проверен: всё ниже проверено только на синтетических данных и mock Graph.

**Порядок обновления (строго):** 1) `npm run db:deploy` (владелец) — сначала миграции; 2) `prisma/roles.sql` (владелец) —
затем роли и GRANT; 3) проверки изоляции — до старта runtime: API/CLI выполняют `assertRuntimeRole` при старте, `m365-cleanup`
перед каждым проходом проверяет runner со своей стороны (только EXECUTE процедуры, ни одной привилегии на таблицы, нет
членства в ролях, точный definer и ACL). Пока шаг 2 не прошёл, runtime не стартует.

| Переменная | Кому нужна | Значение |
|---|---|---|
| `ATLAS_CORRELATION_CURSOR_SECRET_REF=env://NAME` | API и CLI с M365-чтениями | `NAME` — один общий секрет ≥32 байт UTF-8 для всех процессов. Без него Stage 1 работает, а M365 paged reads отказывают (`CORRELATION_CURSOR_CONFIG_INVALID`, HTTP 500) уже на первой странице. Смена секрета делает выданные курсоры недействительными |
| `ATLAS_M365_CLEANUP_RUNNER_SECRET_REF=env://NAME` | только `m365-cleanup` | `NAME` — URL роли `atlas_m365_cleanup_runner` с её отдельным паролем. Цель (протокол, host, порт, база, все параметры) должна совпадать с `ATLAS_RUNTIME_DATABASE_URL`; иначе `M365_CLEANUP_CONFIG_INVALID` до любого подключения. Подключение строится из runtime URL с подстановкой только credentials runner |
| `ATLAS_M365_CLEANUP_TIMEOUT_MS` | только `m365-cleanup` | Целое 30000..600000, по умолчанию 300000. Lock timeout фиксирован: 5000 мс |
| `env://…` M365-подключения | `m365-probe`, `m365-sync` | `<application id>:<client secret>` из vault, только в окружение одной команды. Чтения секрет не используют |

| Команда (`--client C` всегда) | Право | Что делает |
|---|---|---|
| `m365-probe --connection N` | `connections:manage` | Версионированная одноразовая активация привязанного `DISABLED` подключения: tenant, users/devices, ограниченная проба sign-ins → `ACTIVE`. Sign-ins 403 → `ACTIVE` с `M365_SIGNINS_NOT_AVAILABLE`. `ACTIVE` → `CONNECTION_ALREADY_ACTIVE` без I/O; для реактивации — `m365-disable`, затем probe |
| `m365-sync --connection N --resource users\|devices` | `events:ingest` + `connections:manage` | Одна попытка полного чтения каталога (бюджет 8 попыток, `retryAt` из Retry-After) |
| `m365-sync … --resource signins --from T --to T` | то же | Новый запрос (≤24h, ≤7 дней, миллисекундные границы; суб-мс отклоняются) и один проход без ожидания и внутренних повторов |
| `m365-sync … --resource signins --request R` | то же | Продолжение того же запроса: интервал, счётчики и `retryAt` корней сохраняются; до `retryAt` — `NOT_DUE` без запросов к Graph |
| `m365-requeue --connection N --request R --window W` | то же | Аудируемый сброс бюджета одного `FAILED` корня, без I/O; затем отдельный `--request R` |
| `m365-directory-reset --connection N --resource users\|devices` | то же | Аудируемый сброс цепочки попыток каталога (после `retryAt`, без живого claim), без I/O; затем отдельный `m365-sync` |
| `m365-status --connection N [--request R]` | `connections:manage` | Статусы, бюджеты, счётчики и коды (`ACTIVE`/`DISABLED`), итог запроса по текущим root jobs. Без DTO, tenant и vendor ID |
| `m365-directory --connection N --resource users\|devices [--limit N] [--cursor X]` | `context:read` + `m365:read` | Одобренные DTO активного неистёкшего поколения (STALE тоже), порядок по ID, курсор привязан к поколению |
| `correlation --connection N --observation O --from T --to T [--limit N] [--cursor X]` | `context:read` + `m365:read` | `CorrelationContextV1` — тот же сервис, что API и tools |
| `m365-cleanup` | `events:ingest` + `connections:manage` | Один проход очистки истёкших данных клиента на отдельном runner (флагов фильтра нет) |

Флаги проверяются до прав и I/O (`INVALID_ARGUMENTS`, exit 2); только `--cursor` может быть до 512 ASCII-символов.

**Чтения.** `GET /clients/:clientId/observations/:observationId/correlation?connectionId&from&to[&limit][&cursor]` и tools
`atlas.observation.get_correlation`, `microsoft365.signin.list` (оба: `context:read` + `m365:read` на одном клиенте; в GET /tools
только тогда). Только сохранённые данные: чтение не запускает синхронизацию и не расширяет интервал; `from` не старше 7 дней,
`to` не в будущем, ≤24h, иначе 400. Права перепроверяются на каждой странице (отказ — одна запись workspace security audit).
`409 CORRELATION_CHANGED` (изменились публикация, сопоставления, назначение устройства, состояние подключения) или
`409 CORRELATION_CURSOR_EXPIRED` (наступил переход свежести/хранения, ≤15 мин) — начать с первой страницы; `400
CORRELATION_CURSOR_INVALID` — курсор повреждён или чужой. `coverage.status` (COMPLETE/PARTIAL/UNAVAILABLE) — только охват
обхода; `freshness` независима. `items: null` — данных нет; `[]` — найдено ноль, но это не «всё чисто».

**Состояния.** Каталог: старше 60 мин или есть новая незавершённая попытка — `STALE`/`DIRECTORY_STALE`, существующие
подтверждённые сопоставления работают, новые подтверждения требуют свежего поколения; на `expiresAt` (≤ completedAt+24h) —
`DIRECTORY_EXPIRED`, DTO скрыт. Sign-ins: хранение 7 дней от времени входа; окно свежести 15 мин; неудачное обновление
оставляет последнюю публикацию как `STALE` с прежним временем получения. Истечение применяется при чтении, даже если
очистка не запускалась или упала.

**Обновление данных — только оператором** (планировщика нет): рутинно последний полный час + предыдущий; старые интервалы
явно, кусками ≤24h в пределах 7 дней; каталог — не реже раза в час, если нужны новые подтверждения. 429 → `RETRY` с
`retryAt`: повторить `--request R` после него. `FAILED` корень → `m365-requeue`, затем `--request R`. Исчерпанный бюджет
каталога (`M365_ATTEMPTS_EXHAUSTED`) → `m365-directory-reset` после `retryAt`.

**Очистка.** Отдельный явный проход; разрешена и для `DISABLED` подключения. Атомарно снимает истёкшие указатели
(`MISSING`/`RETENTION_EXPIRED`), удаляет истёкшие данные и пишет `retention.completed` (только счётчики и локальные ID). Не
меняет Connection, не удаляет audit, сопоставления и RawEvent. `M365_CLEANUP_TIMEOUT` откатывает весь проход: повторите с
бо́льшим `ATLAS_M365_CLEANUP_TIMEOUT_MS` (в пределах диапазона) и меньшей нагрузкой обновлений. Если и при 600000 мс проход не
укладывается — это отказ, требующий рецензируемой поправки с пакетной очисткой; не заявлять физическое завершение хранения.
Остаточный риск (задокументирован): отзыв прав, закоммиченный после проверки текущих прав и до конца транзакции runner,
этот проход не останавливает; процедура всё равно ограничена клиентом и удаляет только истёкшее.

## 9. Stage 3: authority fence и MOCK-действия (S3-A/S3-B/S3-C)

Контракты: `docs/stage3/03_DATA_AND_CONCURRENCY.md`, `04_EXECUTION_AND_PORT.md`. Только MOCK: синтетический тикет-стор, live-записи нет.

**Порядок обновления (строго):** 1) `npm run db:deploy`; 2) `prisma/roles.sql`; 3) только затем API/CLI/worker и любые
записи владельца (seed, правки акторов/членств/токенов/подключений). Между шагами 1 и 2 runtime не стартует
(`RUNTIME_ROLE_NOT_CONFINED`), а запись владельца-не-суперпользователя в Actor/ClientMembership/ApiToken/Connection
отклоняется `ACTION_FENCE_NOT_READY`.

**Зависимость.** Каждая запись (вставка, изменение, удаление — даже no-op) в Actor, ClientMembership, ApiToken или
Connection увеличивает версию `ActionAuthorityFence` своего workspace. От исправности fence теперь зависят: `bind`,
активация Stage 1, `m365-probe` (активация M365), **`m365-disable` (аварийное отключение)** и `db:seed`. При отсутствующей
или повреждённой строке fence они отказывают с фиксированным `ACTION_FENCE_NOT_READY` и ничего не меняют — в том числе
аварийное отключение. TRUNCATE этих таблиц, удаление/переименование Workspace и любое изменение fence, кроме +1, отклоняются.
Токен, на который ссылается запрос действия, не удаляется — его отзывают (`revokedAt`) или заменяют новой строкой.

**S3-B (одобрение и резервирование, без команд CLI):** новой миграции нет, но `prisma/roles.sql` нужно выполнить заново:
runtime получает INSERT в ActionApproval/ActionAttempt и UPDATE только колонок жизненного цикла запроса и одобрения. До
этого runtime не стартует (`RUNTIME_ROLE_NOT_CONFINED`), а каждое действие отказывает `ACTION_FENCE_NOT_READY`.

**S3-C (MOCK-исполнение, проверка, восстановление; РЕАЛИЗОВАНО, ожидает независимой приёмки Astra):** новой миграции нет;
`prisma/roles.sql` выполнить заново (INSERT в ActionVerification/ActionMockTicket, UPDATE только изменяемых колонок итога и
claim). Команды: `npm run ops -- action-<preview|request|get|list|approve|reject|revoke|cancel|execute|verify|recover> --client C …`
с `ATLAS_OPERATOR_TOKEN` (своё право на каждом шаге) и `ATLAS_ACTIONS_MODE=MOCK`; без него — `ACTION_MODE_DISABLED`; LIVE,
ORIGIN/PORT/SCRIPT/CALLBACK — `ACTION_MODE_REFUSED`. Порт всегда встроенный синтетический (FIXTURE atera), без сети.
- Порядок: `action-preview --input F --preview-file NEW` → `action-request --input F --hash H` → одобряющий:
  `action-get --request R --preview-file NEW` → `action-approve --request R --hash H --preview-file NEW` → исполнитель:
  `action-execute --request R --hash H` (одно резервирование, ровно один create, затем отдельно авторизованное чтение №1).
- Итоги: `VERIFIED` (код 0); `CREATED_UNVERIFIED`/`VERIFICATION_MISMATCH` — повторить `action-verify --request R` (не более 3
  чтений всего, считая первое и неудачные); `OUTCOME_UNKNOWN` — никогда не повторять create; разрешается только совпадающим
  кандидатом из защищённого файла `action-verify --request R --reconciliation-file F` (0600, свой владелец, вне Git;
  `{"kind":"ACTION_RECONCILIATION_CANDIDATE","dto":"action-candidate/1","requestId":R,"candidateTicketId":…}`);
  `NOT_DISPATCHED` — вызова не было, попытка израсходована (нужен новый запрос).
- `action-recover --request R`: RESERVED после reservedAt+35 с → `OUTCOME_UNKNOWN`; зависший ACTIVE claim после его срока
  (startedAt+35 с) → ABANDONED без возврата ординала. Раньше — `ACTION_RECOVERY_NOT_DUE`. `ACTION_VERIFICATION_BUSY` с
  `recoveryRequired:true` означает: нужен явный recover. Recover никогда не создаёт тикет и не сбрасывает бюджет.
- `ACTION_PUBLICATION_CONFLICT`/`ACTION_AUDIT_FAILED` после create: факт не записан, состояние осталось прежним — дождаться
  срока и выполнить `action-recover`. Вывод никогда не содержит заголовок/текст, клиента, ID тикета, токены или пути файлов.

**Если fence повреждён:** вывести сервис из работы (API/CLI/worker остановлены) и выполнить отдельно рецензируемое офлайн-
восстановление владельцем с сохранением монотонной версии (никогда не сброс в 0), затем `prisma/roles.sql` (проверяет
полноту) и `assertRuntimeRole`. Автоматического сброса, обхода или CLI восстановления нет.

## 10. Stage 4 PowerOffice MOCK: чтения, CLI и обслуживание (S4-C)

Контракты: `docs/stage4/02_CONTRACTS.md`, `03_DATA_AND_CONCURRENCY.md`, `04_PORT_AND_SYNC.md`. Только синтетический MOCK:
встроенный экспорт, FIXTURE-подключения с синтетической привязкой (создаются только доверенными тестовыми фикстурами —
команды bind/seed/активации для PowerOffice нет). Никакого обращения к PowerOffice, токенов, OAuth или секретов. LIVE —
DEFERRED_BY_OWNER. Статус приёмки S4-C: реализовано, ожидает независимой приёмки Astra.

**Включение.** По умолчанию DISABLED. `ATLAS_POWEROFFICE_MODE=MOCK` в окружении API и CLI; любое другое значение или
переменная источника/URL/токена/часов (`ATLAS_POWEROFFICE_URL` и т. п.) — `POWEROFFICE_MODE_UNSUPPORTED`. Права только явные,
на одном членстве клиента: чтение `context:read`+`poweroffice:read`; sync/recover дополнительно `poweroffice:sync`;
cleanup — `context:read`+`poweroffice:read`+`poweroffice:maintain`. Права администратора workspace их не заменяют.

**API (ATLAS_MODE=db).** `GET /clients/:clientId/poweroffice/:connectionId/status` и `/summary` с `Authorization: Bearer`.
Собственный путь аутентификации (не Gateway и не ToolExecution). Коды: 200 — прочитано (MISSING/FRESH/STALE/ERROR/EXPIRED);
503 со строгим DTO `UNAVAILABLE` — привязка/жизненный цикл не совпадают; 401 — нет/неверный/истёкший токен; 403 — область/права
(одна запись SecurityAuditEvent); 404 — подключение неизвестно/невидимо/не PowerOffice; 400 — любой query-параметр; 409 —
конфликт; 503 — режим DISABLED/не готово (`POWEROFFICE_RUNTIME_NOT_READY`); 500 — сбой аудита/неожиданное. Все ответы
`Cache-Control: no-store` и `synthetic:true`. Каждое успешное чтение пишет одну клиентскую запись аудита (`poweroffice.*.read`).
Инструмента PowerOffice в `/tools` и `/tools/execute` нет.

**CLI.** `npm run ops -- poweroffice-<status|summary|sync|recover|cleanup> --client C --connection N`, токен только из
`ATLAS_OPERATOR_TOKEN` (никогда в argv), других флагов нет. Код выхода: 0 — успешное чтение/синхронизация/восстановление/очистка;
1 — операция не удалась (права, BUSY, NOT_FOUND, UNAVAILABLE-чтение, ошибки источника/очистки); 2 — использование/конфигурация
(аргументы, режим, токен, готовность runtime/runner). Вывод — один JSON без URL, паролей, токенов и ключей компании.
- Статус чтения (первое совпадение): UNAVAILABLE → EXPIRED (снимок истёк или удалён, даже после новой ошибки/ACTIVE) → ERROR
  (успеха не было, последняя попытка FAILED/ABANDONED) → MISSING → STALE с кодом ошибки (последняя попытка неуспешна, снимок
  ещё действителен) → STALE `POWEROFFICE_SNAPSHOT_STALE` (старше 15 мин) → FRESH. Пустой экспорт — `{totalCount:0, currencies:[]}`.
- `POWEROFFICE_SYNC_BUSY` — есть ACTIVE-попытка (даже просроченная): после `startedAt+80 с` выполнить `poweroffice-recover`
  (раньше — `POWEROFFICE_RECOVERY_NOT_DUE`; без ACTIVE — `POWEROFFICE_NO_ACTIVE_ATTEMPT`), затем новый `poweroffice-sync`.

**Очистка (`poweroffice-cleanup`).** Нужен отдельный runner: `ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF=env://ИМЯ`, где ИМЯ —
URL роли `atlas_poweroffice_cleanup_runner` (пароль из `prisma/roles.sql`) с ТЕМ ЖЕ протоколом, хостом, портом, базой и всеми
query-параметрами, что `ATLAS_RUNTIME_DATABASE_URL`; иначе `POWEROFFICE_RUNTIME_NOT_READY` (код 2), URL не печатается.
Порядок: свежая проверка прав maintain под fence → проверка конфайнмента runner и той же базы → одна транзакция runner с
общим бюджетом 10 с, отсчитываемым до получения соединения и никогда не сбрасываемым: ожидание/логин соединения, все
операторы и COMMIT. Runner работает на одном отдельном соединении (`pg`, без пула): ДО `BEGIN` в этой сессии ставятся и
проверяются по `pg_settings` (source = session) `transaction_timeout` (остаток бюджета минус 250 мс), `statement_timeout` и
`lock_timeout` 1 с — более строгие унаследованные значения роли/базы/параметров подключения сохраняются, более мягкие
никогда не продлевают срок; поэтому `BEGIN` взводит серверный таймер именно с этим значением, и сервер сам прерывает и
откатывает транзакцию, в том числе во время COMMIT. Кроме того, сторожевой таймер в момент исходного срока отправляет
серверу протокольный CancelRequest для выполняющейся инструкции runner (любой фазы: настройка, BEGIN, тело, COMMIT) — без
дополнительных прав; если инструкция не завершилась за 2 с, соединение закрывается. Ограничение: пока идёт вход (логин,
login-триггеры), PostgreSQL ещё не выдал ключ отмены — клиент закрывает соединение по сроку, а серверный код входа
доработает сам (выполнить инструкции runner он уже не может). Требуется PostgreSQL 17 и пакет `pg` в окружении CLI. Таймаут (включая слишком долгое подключение/логин runner) — `POWEROFFICE_CLEANUP_TIMEOUT`, код
выхода 1, всё откатывается; неверный пароль/роль runner — `POWEROFFICE_RUNTIME_NOT_READY` (код 2); deadlock — `POWEROFFICE_DB_CONFLICT`; ACTIVE — `POWEROFFICE_SYNC_BUSY` (сначала recover); прочее —
`POWEROFFICE_CLEANUP_FAILED`. Автоповтора нет: при `morePending:true` запустить команду ещё раз. За вызов не более 1000 строк:
сначала истёкшие снимки (указатель очищается, `lastSuccessAt` сохраняется), затем завершённые попытки старше 30 дней без ссылок.
Допускается подключение DISABLED/с новым lifecycle в той же синтетической привязке (без реактивации). Нет State — no-op.

**Эксплуатационные ограничения (приняты для MOCK).** Очистка держит fence workspace до 10 с: в это время ждут чтения/синхронизации
PowerOffice, допуск действий Stage 3 и изменения токенов/членств/подключений. Допуск (admission) и чтения ждут fence без
собственного lock_timeout (общие транзакции авторизации Stage 4). 1000 хранимых попыток блокируют новый sync
(`POWEROFFICE_SYNC_LIMIT`) до очистки старых (30 дней). Истечение 24 ч применяется при чтении даже без очистки.

## 11. Stage 5: локальная консоль оператора (S5-A, S5-B)

Контракты: `docs/stage5/02_CONTRACTS.md`, `03_SECURITY_AND_STATE.md`, `04_ARCHITECTURE_AND_UX.md`,
`S5B_IMPLEMENTATION_BRIEF_RC2.md`; код `apps/operator/AGENTS.md`. Только локальное чтение синтетических/тестовых данных.
S5-A (принято): вход по токену, выбор клиента, проверка `ClientContextV1`. S5-B (реализовано, ожидает независимой приёмки
Astra): контекст, очередь наблюдений, детали и явное чтение сохранённого evidence. Ask Atlas и LIVE — отдельные контракты.

**Включение.** `ATLAS_OPERATOR_UI=1` в окружении API; не задано или `0` — консоль выключена, API работает как раньше и
файлы консоли не нужны; любое другое значение (включая пустую строку) — отказ запуска. Сборка `npm run api:build`
(включает `npm run ui:build` → `dist/operator` с манифестом). Включено, но сборки нет или файлы не совпадают с
манифестом — отказ запуска `OPERATOR_UI_ASSETS_UNAVAILABLE`.

```sh
npm run api:build && ATLAS_OPERATOR_UI=1 ATLAS_MODE=fixture ATLAS_DEMO_TOKEN=… npm run api:start
# открыть ровно http://127.0.0.1:3100/operator/ (порт = ATLAS_API_PORT)
```

**Граница.** При включённой консоли каждый запрос (API и файлы) должен иметь ровно `Host: 127.0.0.1:<порт>`; `localhost`,
другие имена, прокси и `X-Forwarded-*` получают 421 до аутентификации и аудита. Все ответы получают CSP,
`Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. Отдаются только `/operator/`
и файлы манифеста; `/operator` без слэша и всё остальное под `/operator/` — 404, без редиректов. CORS, прокси и настройка
адреса API отсутствуют. Это защита от случайной публикации и DNS rebinding, а не производственная аутентификация.

**Токен.** Существующий токен (fixture: `ATLAS_DEMO_TOKEN`; db: выданный токен оператора) вводится в поле пароля и
хранится только в памяти страницы. Disconnect, перезагрузка, уход со страницы и возврат из back/forward cache очищают
токен и все данные; токен при этом не отзывается на сервере. Права и область решает сервер: 401 отключает консоль,
403 очищает выбранного клиента и один раз перечитывает список клиентов.

**Работа (S5-B).** После выбора клиента и проверки контекста консоль один раз читает очередь: в db — явные фильтры
статусов/серьёзности и размер страницы 25/50/100 (по умолчанию OPEN+ACKNOWLEDGED, все, 25), порядок сервера, «Next page»
заменяет страницу, «First page»/фильтр/обновление — с первой страницы; в fixture — фиксированная демо-страница без
параметров, фильтров и пагинации. Контекст показывает только имена людей, имена устройств, сохранённую ссылку на человека,
подтверждённые связи Atera/Huntress и сохранённые чтения ресурсов со статусом, временем и усечением (без e-mail, финансов,
M365, facts). Источник HIGH/CRITICAL всегда помечен «Urgent» независимо от уверенности, маршрута и метки приоритета.
Evidence читается только кнопкой для выбранного наблюдения: `POST /tools/execute` с закрытым набором (`atera.alert.list`
с точным отбором по ID, `atera.ticket.get`, `huntress.incident.get` в db); в fixture Huntress недоступен без запроса.
Каждое нажатие — новый requestId и, как у любого вызова Gateway, строки ToolExecution/AuditEvent (db) или записи
fixture-аудита; GET-чтения записей не добавляют. Пустой результат — «нет в сохранённом чтении» (при усечении — может быть
за его пределами); ERROR/MISSING — недоступно, а не пусто. Повторов нет: таймаут 10 с может иметь серверный исход.

**Проверки.** `npm run ui:typecheck`, `npm run ui:build`, `npm test`, `npm run test:pg` (`tests/pg/operator-http.pg.test.ts`),
`npm run test:ui` (Playwright @playwright/test 1.56.1, Chromium сборки 1194; разово `npx playwright install chromium`;
нужен `ATLAS_PG_ADMIN_URL` для `tests/ui/console-pg.spec.ts` и `console-journey-pg.spec.ts`). Скриншоты для визуальной
проверки — только при `ATLAS_UI_VISUAL_DIR=<каталог вне репозитория>`, после очистки поля пароля и проверки, что токена
нет на странице.

## 12. Stage 5 Ask Atlas: OFF/MOCK backend (ASK-A)

Контракт `docs/stage5/ask/` (RC3, утверждён), код `packages/ask/AGENTS.md`; отчёт `docs/stage5/ask/S5ASKA_IMPLEMENTATION_REPORT.md`
(приёмка Astra — PENDING). Это локальная синтетическая MOCK-проверка: внешней модели, ключей, сетевых вызовов и записи
вопроса нет; UI Ask в консоли — §13 (ASK-B).

**Включение.** `ATLAS_ASK_MODE` не задано или `off` — маршрутов Ask нет (обычный 404), API и консоль как прежде; `mock` —
`GET /ask/capabilities` и `POST /clients/:id/ask` в fixture и db; любое другое значение (включая пустую строку) — отказ запуска
`ATLAS_ASK_MODE must be unset, off or mock`. Флага LIVE/remote нет.

```sh
npm run api:build && ATLAS_ASK_MODE=mock ATLAS_MODE=fixture ATLAS_DEMO_TOKEN=… npm run api:start
curl -s -H "Authorization: Bearer $ATLAS_DEMO_TOKEN" -H 'Content-Type: application/json' http://127.0.0.1:3100/clients/demo-gasta/ask \
  -d '{"contractVersion":"AskRequestV1","requestId":"<uuidv4 строчными>","question":"What needs attention?","observationId":null}'
```

**Поведение.** Тело JSON ≤16 КиБ (иначе 413), вопрос 1..2000 кодовых точек; ошибки — только `AskErrorV1` с фиксированным
кодом и `X-Atlas-Correlation-Id`, без текста запроса. Право — `context:read` на клиенте пути; отказ пишет одно
`ask.scope_denied` в SecurityAuditEvent. Каждый допущенный вопрос — одна строка `ask.completed`/`ask.failed` в AuditEvent
(provider=fixture, ruleVersion=ask-mock-v1, itemCount, outcome, safeErrorCode); вопрос, план и ответ не сохраняются и не
логируются. Ответ — цитируемые факты сохранённого чтения (Atera/Huntress), не исчерпывающий и не «клиент здоров».
MOCK понимает только фразы из `02_CONTRACTS.md` (RU/EN), остальное — UNSUPPORTED.

**Ресурсы.** На процесс ≤4 одновременных Ask, ≤1 на актора, 10 вопросов на актора за скользящие 60 с, общий срок 8 с;
перегрузка — 429 `ASK_BUSY` без повторов. Брошенная (таймаут/разрыв) работа держит слот до фактического завершения
транзакции/планировщика; восстановление — перезапуск процесса. Каждая DB-фаза Ask ограничена одним абсолютным сроком
min(2 с, остаток 8 с): последовательные ожидания блокировок не продлевают её; после конца фазы новых запросов нет. Ask берёт `ActionAuthorityFence` FOR SHARE на ≤2 с за фазу:
изменения прав в том же workspace ждут этого окна.

**Проверки.** `npm test` (`tests/ask-*.test.ts`), `npm run test:pg` (`tests/pg/ask-{http,source,authority,budget,physical,helper-boundary}.pg.test.ts`).

## 13. Stage 5 Ask Atlas в консоли (ASK-B, OFF/MOCK)

Контракт `docs/stage5/ask/` (01 «UI», 03 «Browser state»), код `apps/operator/AGENTS.md`; отчёт
`docs/stage5/ask/S5ASKB_IMPLEMENTATION_REPORT.md` (приёмка Astra — PENDING). Нужны `ATLAS_OPERATOR_UI=1` и `ATLAS_ASK_MODE=mock`;
без `mock` консоль один раз на токен получает 404 и не показывает Ask вовсе.

```sh
npm run api:build && ATLAS_OPERATOR_UI=1 ATLAS_ASK_MODE=mock ATLAS_MODE=fixture ATLAS_DEMO_TOKEN=… npm run api:start
# http://127.0.0.1:3100/operator/ → клиент → панель «Ask Atlas — local synthetic MOCK; no external model»
```

**Работа.** После списка клиентов консоль один раз на токен запрашивает `GET /ask/capabilities`; поле вопроса появляется
только при валидном 200 и проверенном контексте выбранного клиента. Вопрос — свободный текст до 2000 кодовых точек (без
обрезки; управляющие символы и пустой текст отклоняются локально, ничего не отправляется); флажок «Use selected observation»
передаёт точный ID выбранного наблюдения. MOCK понимает только показанные RU/EN фразы, остальное — «Unsupported question».
Перед отправкой прежний ответ и поле очищаются; повторное нажатие во время ожидания ничего не шлёт; повтор — это новый
вопрос (новый requestId, новое чтение). Ответ показывает статус, утверждения по фиксированным шаблонам с цитатами E1..E32,
независимое уведомление о всех HIGH/CRITICAL в ответе, границы чтения и карточки evidence; кнопка цитаты лишь раскрывает
карточку этого ответа (без запросов и ссылок). Смена клиента/контекста/фильтра/страницы/наблюдения, ручное переключение флажка, Disconnect, уход со
страницы очищают ответ и поле сразу (выбор флажка сохраняется); поздние ответы старых запросов игнорируются. Ответ не меняет очередь, детали и evidence.

**Ошибки.** 401 отключает консоль; 403 очищает клиента и один раз перечитывает список; 404 — «недоступно»; 409 — права
изменились, нужен новый вопрос; 429/503/504 и неверный ответ — фиксированное сообщение с кодом и correlation ID, без
повторов. Срок браузера — одни 10 с на запрос, чтение (≤256 КиБ), разбор и проверку всего ответа.

**Проверки.** `npm test` (`tests/operator-ask-{validate,transport,controller}.test.ts`, паритет в `operator-contracts.test.ts`),
`npm run test:ui` (`tests/ui/ask-{fixture,races,visual}.spec.ts`; `ask-pg.spec.ts` требует `ATLAS_PG_ADMIN_URL`). Скриншоты —
только при `ATLAS_UI_VISUAL_DIR`, после очистки полей токена и вопроса и проверки страницы.

## 14. Stage 5 ASK-REMOTE R-A: неактивная политика, бюджет и роли (без провайдера)

Контракт `docs/stage5/ask/remote/04_AUTHORITY_AND_BILLING.md`; код `packages/ask/remote/AGENTS.md`; отчёт
`docs/stage5/ask/remote/S5ASKREMOTE_RA_IMPLEMENTATION_REPORT.md` (приёмка Astra — PENDING). R-A не добавляет ни адаптера,
ни сетевого вызова, ни режима: `ATLAS_ASK_MODE` остаётся `off|mock`, ключей и аккаунтов нет, активных политик не поставляется.

**Развёртывание.** Три новые миграции (`202610111000` словарь прав + `ask:remote`, `202610111010` четыре таблицы
RemoteAsk*, `202610111020` процедуры) и затем, как всегда, `prisma/roles.sql`: он создаёт восьмую роль
`atlas_ask_remote_definer` (NOLOGIN NOINHERIT, владелец восьми `atlas_ask_remote_*`), оставляет runtime только SELECT на
таблицах RemoteAsk* и EXECUTE на reserve/settle/pause, владельцу миграций — EXECUTE на create/revise/client_set. До
`roles.sql` runtime не стартует (default privileges дают ему INSERT/UPDATE); readiness проверяется в любом режиме Ask,
включая OFF/MOCK. Права `ask:remote` никому не назначаются автоматически; удалённый Ask требует `context:read` + `ask:remote`
на одном членстве (R-B).

**Доверенное обеспечение (только после приёмки R-A/B/C и отдельного решения владельца о данных и бюджете — сейчас НЕ
разрешено).** Только как владелец миграций, только через процедуры (прямой DML в RemoteAsk* отклоняется guard'ом, AR007),
в одной транзакции с `set_config('app.workspace_id', <workspace>, true)`. Каждая процедура сначала берёт fence рабочего
пространства FOR UPDATE, затем политику; каждое существенное изменение — fence +1 и policyVersion ровно +1:

```sql
BEGIN; SELECT set_config('app.workspace_id', '<ws>', true);
SELECT atlas_ask_remote_policy_create('<ws>', '<admission uuid>', '<project ref>', 'vault://…', '<owner approval ref>',
  '<retention attestation ref>', '<price revision>', '<prompt sha256>', '<schema sha256>', '<package sha256>', <day cap ≤ 2000000>,
  <month cap ≤ 10000000>, '<expiry ≤ now + 168 h>');            -- INACTIVE, policyVersion 1; одна строка на workspace
SELECT atlas_ask_remote_client_set('<ws>', '<admission>', '<client>', <expected version>, true);   -- точный allowlist
SELECT atlas_ask_remote_policy_revise('<ws>', '<admission>', <expected version>, 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'INACTIVE',
  …все существенные поля…);                                     -- идентичная ревизия ничего не меняет
COMMIT;
```

Политику нельзя удалить или создать заново; проект и admissionId неизменны; на max bigint политика становится терминальным
TOMBSTONE (AR008). Лимиты задаются при создании не выше 2 USD/сутки и 10 USD/месяц UTC; ревизия может их только понизить —
повышение любого из двух выше ТЕКУЩЕГО значения отклоняется (AR009) независимо от ссылки на одобрение, продления срока или
отзыва/повторной активации, ничего не меняя; пути увеличения бюджета нет (нужна отдельно рассмотренная поправка к 04).
Понижение ниже уже учтённой траты лишь закрывает новые резервирования; история и счётчики не переписываются; новая ревизия не
обнуляет бюджет проекта. Резервирование повторно проверяет срок политики по часам БД после ожидания блокировок счётчиков и
непосредственно перед возвратом (AR001, попытка и оба счётчика откатываются).

**Деньги.** Резерв 300000 микро-USD на попытку (MONTH → DAY, оба или ни одного; недостающие счётчики создаются
безопасно); расчёт ceil((prompt×275 + completion×825)/1000) только по проверенному usage; всё остальное (неизвестная
доставка, неверный usage/модель, отказ провайдера, падение процесса) удерживает весь резерв. NO_DISPATCH = 0: процедура
ДОВЕРЯЕТ исходу, который сообщает runtime; 10-секундное окно лишь запрещает запоздалый нулевой расчёт и НЕ доказывает ни
непрерывность процесса, ни отсутствие отправки (новое соединение внутри окна будет принято). Приватное, невосстановимое
доказательство «в этом процессе отправки не было» — обязательное условие приёмки R-B; его нельзя вывести из ID попытки,
переподключения, прошедшего времени или отсутствия записей о завершении. Расчёт ровно один раз, в исходных UTC-периодах; нет TTL, возвратов, повторов и
автоматической сверки. Отложенная проверка при COMMIT: каждый счётчик = сумма accounted его попыток (AR010). Ошибки:
AR001 NOT_ADMITTED, AR002 POLICY_CHANGED, AR003 BUDGET, AR004 SCOPE, AR005 AUTHORITY_CHANGED, AR006 SETTLEMENT_REFUSED.

**Конкуренция за общий fence.** Ревизии/allowlist/пауза берут тот же fence рабочего пространства FOR UPDATE, что и
допуски Stage 3, и ждут удерживающих FOR SHARE (Ask, ≤ 2 с на фазу); каждая такая операция и runtime-пауза увеличивают
fence, поэтому идущие в этот момент Ask/Stage 3 операции этого workspace получают свой обычный отказ финального допуска
(409/повтор вручную). Это намеренная консервативная инвалидация; ожидание ограничено короткими транзакциями. Расчёт не берёт
fence и политику и не ждёт ревизий.

**Готовность.** Проверка runtime при старте (в любом режиме Ask) включает полную эффективную поверхность прав remote
definer во всех схемах: опции GRANT на таблицы/столбцы, CREATE/владение схемами, права вне allowlist (с привязкой к
public."…"), PUBLIC и встроенные объекты (`packages/graph/ask-remote-surface.ts`), как и постусловие `roles.sql` §5.

**Остаточные риски.** Неизвестный исход COMMIT резервирования или расчёта сохраняет резерв до отдельной будущей сверки;
счётчик ограничивает только допущенные этим сервисом расходы по зафиксированной цене — не счёт провайдера, налоги, другое
использование проекта или скомпрометированный ключ; лимиты проекта на стороне провайдера — дополнительная защита.

**Проверки.** `npm test` (`tests/ask-remote-budget.test.ts`, `context-mapper.test.ts`), `npm run test:pg`
(`tests/pg/ask-remote-{policy,ledger,race,roles,upgrade,nonsuper}.pg.test.ts`).

## 15. Stage 5 ASK-REMOTE R-B: серверный V2 и закрытый адаптер провайдера (только офлайн-швы)

Контракт `docs/stage5/ask/remote/02–04`; код `packages/ask/remote/AGENTS.md` (раздел R-B); отчёт
`docs/stage5/ask/remote/S5ASKREMOTE_RB_IMPLEMENTATION_REPORT.md` (приёмка Astra — PENDING). Это НЕ допуск к данным, бюджету
или платным вызовам: ключи и аккаунты не выдаются, активных политик не поставляется, R-EVAL и реальное использование
закрыты отдельным решением владельца. Браузер остаётся V1/MOCK до R-C.

**Включение.** `ATLAS_ASK_MODE=remote` только вместе с `ATLAS_MODE=db` (fixture + remote не стартует:
`ATLAS_ASK_MODE=remote requires ATLAS_MODE=db`). Старт проверяет ту же readiness, что §14, ничего не создаёт и не
активирует, не читает секрет и не обращается к сети. Без активной политики/допуска клиента capability и POST дают
503 `ASK_REMOTE_NOT_ADMITTED` (не 404/OFF). Развёртывание: миграция `202610121000` (новая процедура
`atlas_ask_remote_reserve_floor`, обёртка над неизменной reserve) и затем `prisma/roles.sql` (EXECUTE только runtime).

**Ключ.** Только `secretRef` политики вида `env://ATLAS_ASK_REMOTE_<ИМЯ>` (выделенный ключ выделенного проекта); никогда
`OPENAI_API_KEY`, ключи Decisions или логины подписок. `vault://` и `fixture://` в production не разрешаются: допущенная
попытка не отправляется и рассчитывается как доказанное «не отправлено» (0). Значение живёт только в вызове транспорта.

**Поток.** GET `/ask/capabilities` → `AskCapabilityV2` (политика рабочего пространства). POST `/clients/:id/ask` принимает
только `AskRequestV2` с подтверждением `{admissionId, policyVersion}`; V1 — 400. Фаза 1: `context:read` И `ask:remote` в
одном членстве, сначала сравнение кортежа согласия (409 `ASK_REMOTE_POLICY_CHANGED`), затем активность/срок/профиль/
допуск клиента (503). Провайдеру уходит только `{question, hasFocus}` (≤16 КиБ), один POST на EU 443 без прокси, редиректов
и повторов; ответ ≤64 КиБ проверяется строго (дубликаты ключей, модель/tier, usage, интент). Ответ — `AskAnswerV2` из
локального селектора и неизменного компилятора. Статус не-200 определяется уже по заголовкам ответа (тело не читается и не
влияет: большое, оборванное или зависшее тело 401/403 всё равно закрывает circuit и ставит паузу). Коды: 503
`ASK_REMOTE_UNAVAILABLE` (любой не-200, включая 401/403/404/429/5xx, таймаут), `ASK_REMOTE_INVALID`, `ASK_REMOTE_MODEL_MISMATCH`, `ASK_REMOTE_USAGE_INVALID`, 429 `ASK_REMOTE_BUDGET`.

**Время.** Исходные 8 с; каждая DB-фаза ≤2 с. Перед вставкой попытки (внутри процедуры, после всех ожиданий блокировок
счётчиков), перед возвратом транзакции и после подтверждённого COMMIT должно оставаться ≥4500 мс исходного бюджета, иначе
504 и полный откат (или, после COMMIT, «не отправлено» с расчётом 0); последняя проверка порога выполняется после
получения ключа, непосредственно перед отправкой. Фаза провайдера — min(2 с, остаток), конец или разрыв
соединения её завершают; поздний ответ отбрасывается. Расчёт — отдельная транзакция со своими 2 с, публикация ждёт его не
дольше «остаток − 500 мс». Брошенная работа держит слот владельца до фактического завершения (перезапуск — восстановление).

**Деньги и неизвестность.** Резерв 300000 микро-USD; проверенный usage → ceil-стоимость, остальное возвращается в исходные
периоды; неверный ответ с проверенным usage — только стоимость, без ответа; неизвестная доставка, не-200, неверные модель/
tier/usage — весь резерв. Неизвестный исход COMMIT резервирования: вызов не отправляется и ничего не возвращается. Повторов,
фоновой сверки и TTL нет.

**Предохранитель.** Неверные модель/tier/usage или upstream 401/403 сразу закрывают локальный circuit рабочего пространства
и затем (после финальной фазы) ставят политику на паузу (fence первым; policyVersion и fence +1). Восстановление: владелец
выясняет причину вне Atlas и делает ревизию ACTIVE (новая версия) — circuit этого процесса открывается; если пауза не
записалась, процесс отказывает этому рабочему пространству до перезапуска (после проверки владельцем).

**Отзыв.** Подтверждённый COMMIT допуска — точка линеаризации: отзыв токена/членства/политики (записи владельца, которые
двигают тот же fence) ждёт его и после него лишь подавляет ответ (401/403/409); отправленный вопрос и стоимость остаются.

**Остаточные риски.** Как в 03/04/05: ID модели не фиксирует веса; интент может быть семантически неверным; вопрос не
очищается; принятую отправку не отозвать; abort не доказывает отсутствие списания; учёт — не счёт провайдера. Локальный
circuit действует в одном процессе. Поведение реального TLS-сокета и формы ответа не проверены офлайн (R-EVAL).

**Проверки.** `npm test` (`tests/ask-remote-{wire,dispatch,local,flow}.test.ts`), `npm run test:pg`
(`tests/pg/ask-remote-{journey,upstream,egress,floor,settle,process}.pg.test.ts`).

## 16. Stage 5 ASK-REMOTE R-C: REMOTE в консоли — раскрытие, согласие на каждый вопрос (только офлайн)

Контракт `docs/stage5/ask/remote/02` («Consent and generation isolation»), бриф `S5ASKREMOTE_RC_IMPLEMENTATION_BRIEF.md`, код
`apps/operator/AGENTS.md` (раздел ASK-REMOTE); отчёт `docs/stage5/ask/remote/S5ASKREMOTE_RC_IMPLEMENTATION_REPORT.md`
(приёмка Astra — PENDING). Это НЕ допуск: R-C не выдаёт ключей, аккаунтов, политик или права `ask:remote`, не включает R-EVAL
и не разрешает реальные/клиентские вопросы. Без активной политики консоль показывает «недоступно», а не OFF.

```sh
npm run api:build && ATLAS_OPERATOR_UI=1 ATLAS_MODE=db ATLAS_ASK_MODE=remote ATLAS_RUNTIME_DATABASE_URL=… npm run api:start
# http://127.0.0.1:3100/operator/ → клиент → «Ask Atlas — REMOTE: OpenAI GPT-6 Luna interprets; facts compiled locally»
```

**Что видит оператор.** Только после точного `AskCapabilityV2` (все ключи раскрытия; admissionId и policyVersion показаны
как значения, policyVersion — строка, не число): «OpenAI GPT-6 Luna interprets the question; Atlas compiles facts locally.»,
что уходит (исходный вопрос как набран и флаг «есть фокус»; хранимые данные не уходят), что платное API оплачивается отдельно
от подписок, хранение — по политике аккаунта, проверенной владельцем, и что допустимы только синтетические вопросы; видимое
«Up to US$0.30 reserved per attempt; unknown outcomes retain this reservation.»; четыре поддерживаемые задачи. Ни ссылок,
ни выбора модели/цены, ни ввода ключа, ни редактора политики. Ярлык и примеры MOCK в REMOTE не показываются.

**Согласие.** Отдельный изначально пустой флажок «I consent to sending this question to OpenAI and confirm it is synthetic.»
нужно отметить вручную для КАЖДОГО вопроса. Без него ничего не отправляется (сообщение «Nothing was sent»). Порядок: выбрать
фокус → набрать вопрос → отметить флажок → Ask. Флажок снимается при правке вопроса, отправке, смене фокуса, клиента,
контекста, очереди, страницы, фильтра, наблюдения, токена, при обновлении раскрытия, Disconnect, уходе со страницы и
восстановлении из bfcache. При отправке консоль сначала фиксирует вопрос, фокус и кортеж раскрытия, затем очищает поле и
флажок; запрос — ровно `AskRequestV2` с новым UUIDv4. Правка вопроса во время ожидания (только REMOTE) отменяет ожидающий
вопрос; в MOCK набор текста по-прежнему ничего не отменяет.

**Ошибки.** 409 `ASK_REMOTE_POLICY_CHANGED` (текущий): вопрос и флажок очищены, Ask помечен недоступным, доступна только
кнопка «Refresh the remote Ask disclosure»; никакой автоматической повторной отправки — после обновления нужно снова набрать
вопрос и дать согласие. 503 `ASK_REMOTE_NOT_ADMITTED` — недоступно (не OFF). 503 `ASK_REMOTE_UNAVAILABLE` (любая ошибка
провайдера, включая upstream 401/403/404/429/5xx), `ASK_REMOTE_INVALID`, `_MODEL_MISMATCH`, `_USAGE_INVALID`, 429
`_BUDGET` — фиксированный текст, сеанс, клиент и доступ не меняются, повторов нет. Только реальные 401/403 самого браузера
ведут себя как раньше (отключение / сброс клиента). Неверный, частичный, V1- или чужой ответ отбрасывается целиком.

**Остаточные риски.** Вопрос не очищается и после принятой отправки необратим; согласие — заявление оператора, не полномочие;
резерв неизвестного исхода сохраняется. Реальный провайдер, TLS, качество и задержка не проверены (R-EVAL NOT_ADMITTED).

**Проверки.** `npm test` (`tests/operator-ask-remote-{validate,transport,controller}.test.ts`), `npm run test:ui`
(`tests/ui/ask-remote-{ui,races}.spec.ts` — перехват маршрутов; `ask-remote-pg.spec.ts` — реальный PG17, скомпилированный
сервер и офлайн-шов провайдера R-B, требует `ATLAS_PG_ADMIN_URL`). Скриншоты — только при `ATLAS_UI_VISUAL_DIR`, после
очистки полей и проверки страницы на отсутствие токена и вопроса.

## R-EVAL server (RS-A … RS-D): канал владельца, песочница фикстур, мостовой сервер, инструмент, перепись и DRAIN

Без активации и без ключа провайдера. Подробный регламент: `docs/stage5/ask/remote/reval-server/rs-d/REVAL_RUNBOOK.md`; порядок работы
инструмента: `docs/stage5/ask/remote/reval-server/rs-c/INSTRUMENT_RUNBOOK.md`.
