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
psql "$DATABASE_URL" -v atlas_app_password="$(cat /path/to/secret)" -f prisma/roles.sql   # владелец, один раз на БД
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

**Worker.** Планировщика в Stage 1 нет. Проход запускается вручную или внешним таймером (cron, systemd timer):

```sh
npm run ops -- worker-once
```

Параллельные проходы безопасны: claim, lease и claim token. Режим решений берётся из `config/decisions.json`:
- в `shadow` и `advisory` нужен `OPENAI_API_KEY`;
- `ATLAS_DECISIONS_MODE=rules` работает без провайдера. Такой override помечает версию суффиксом `-env`.

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
| `triage --client C --observation O --action acknowledge\|resolve\|suppress\|reopen [--expected STATUS]` | `observations:triage` | Изменение жизненного цикла. С `--expected` чужое изменение даёт `OBSERVATION_STATUS_CHANGED`, а не перезапись |
| `telemetry --client C [--minutes N]` | `context:read` | Runs, задержки, input tokens, согласие shadow с baseline, отказы guard, доля review (N ≤ 7 дней) |
| `worker-once` | `events:ingest` на клиенте | Один проход worker и, в shadow, shadow-заданий по всем клиентам оператора |
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
   - `ATLAS_DECISIONS_MODE=rules npm run ops -- worker-once`;
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
  - Состояние видно в `telemetry` и в `guard` вывода `worker-once`.
- **Vendor 429.** Ресурс получает `ERROR`/`STALE` с `UPSTREAM_RATE_LIMITED` и `retryAfterSeconds`. Следующее чтение — не раньше. Snapshot сохраняется с прежним `asOf`.
- **Устройство не сопоставлено.** Observation получает `HUMAN_REVIEW` с `UNRESOLVED_DEVICE` или `AMBIGUOUS_DEVICE_LINK`; ревью через `mapping`, `confirm-link` / `reject-link`.
- **Устаревший snapshot.** `STALE` с `asOf` и кодом: показывать последний snapshot, не утверждать актуальные числа. Окна свежести: alerts и incidents — 15 мин, tickets — 30 мин.
- **Сбой обработки события.** Сначала ограниченные `RETRY`, затем `DEAD_LETTER` с audit `event.dead_lettered`; событие видно в `inbox`. После исправления причины — `requeue`. Если решение фазы 1 уже было сохранено, оно переиспользуется, и провайдер повторно не вызывается.
- **Откат:**
  - остановите внешние таймеры `worker-once` и запуски `live-read`;
  - переведите решения в `rules`;
  - БД и оба audit-журнала сохраните.
  
  Никогда не выполняйте `prisma migrate reset`, `DROP` или `TRUNCATE`: у runtime-роли нет DELETE и TRUNCATE, audit неизменяем.

## 7. Чего в Stage 1 нет

- Планировщик и long-running worker (`apps/worker` — граница процесса).
- Vault backend (`vault://`) и provisioning акторов и токенов.
- Чтение alerts Atera.
- UI, write-actions, deployment.
- Live-проверка вендоров и Decisions — её выполняет раздел 5 при наличии credentials.
