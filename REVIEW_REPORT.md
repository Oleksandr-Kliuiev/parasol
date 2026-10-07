# Independent review — Checkpoint A

Дата: 2026-10-07. Проверено: `9770c83` (`1fdab12` — последний коммит кода) относительно `main @ 4d6f897`.
Ветка ревью: `codex/review-checkpoint-a`. До ревью рабочее дерево чистое; diff: 43 файла, +1561/−100, включая checkpoint report.
Область: задания 1.1–1.3. Следующие этапы не реализовывались; код приложения и миграции не изменялись.

## Вердикт

**REQUEST_CHANGES: одно обязательное исправление P2 перед принятием Checkpoint A.**

Штатные проверки подтверждены: 44/44 unit/PGlite, 17/17 PostgreSQL integration, typecheck, API build/smoke, schema validation и пустой migration drift. Межклиентский доступ в проверенных сценариях закрыт. Однако специально сформированная строка запроса ломает запись отказа в PostgreSQL: HTTP 500 без audit вместо контролируемого отказа с audit. Поэтому утверждение checkpoint «блокеров нет» требует пересмотра.

P0/P1-находок не обнаружено. Durable pipeline, snapshots и live-вызовы не объявляются реализованными на основании этих тестов.

## R1 — [P2] Недопустимые для PostgreSQL строки подавляют аудит отказов

**Основное место:** `packages/audit/prisma.ts:40–44` — `requestedClientId` только обрезается, metadata проходит allowlist без приведения строк к допустимому представлению. Та же проблема у клиентского sink, `packages/audit/prisma.ts:27–30`.

Путь входа: `apps/api/src/http-boundary.ts:34–39` принимает строки по типу и длине; `apps/api/src/db/auth.ts:43–55` передаёт client ID из URL в security audit. `packages/audit/memory.ts:8–14` ограничивает ключи и длину metadata, но сохраняет NUL и одиночные UTF-16 surrogates. Reference memory sink такие строки принимает; PostgreSQL text/jsonb — нет.

**Условие:** аутентифицированный запрос содержит NUL в запрошенном client ID или NUL/одиночный surrogate в неизвестном имени инструмента. Это воспроизводится через собранный HTTP API, а не только прямым вызовом repository.

| Запрос с действующим синтетическим токеном | HTTP | Новых SecurityAuditEvent | Новых AuditEvent |
|---|---:|---:|---:|
| `GET /clients/no-such-client/overview` (контроль) | 403 | 1 | 0 |
| `GET /clients/ghost%00client/overview` | **500** | **0** | 0 |
| `POST /tools/execute`, `clientId: "ghost\u0000client"`, обычный read-tool | **500** | **0** | 0 |
| `POST /tools/execute`, `clientId: "demo-gasta"`, `tool: "unknown\u0000tool"` | **500** | 0 | **0** |
| То же, `tool: "unknown\ud800tool"` | **500** | 0 | **0** |
| То же, `tool: "unknown.tool"` (контроль) | 403 | 0 | 1 |

**Последствие:** доступ остаётся запрещённым, но отказ отсутствует в журнале администратора/клиента. Вызывающий может детерминированно обходить запись отказа. Ошибка затрагивает уже реализованный DB-backed audit, поэтому не относится к отложенному заданию 1.9. Требование — docs/01, условие 7; docs/02, HTTP-маппинг и audit.

**Необходимое исправление:**

1. Сохранять ограниченное безопасное текстовое представление недопустимых символов во всех недоверенных строках audit, сохранив allowlist. Для requested client ID предпочтительно явное escaping, чтобы журнал отличал исходные значения; не подменять этим реальный scope.
2. Проверять формат client ID и имени инструмента на HTTP-границе. Определить контролируемый 400/403 для malformed input, сохранив требуемый аудит уже установленных scope/tool-denials. Простого перехвата ошибки БД и возврата 403 без записи недостаточно.
3. Добавить PostgreSQL API regression-тесты на приведённые случаи: отказ без 500, ровно одна ожидаемая audit-запись, ни одного чтения данных чужого клиента. Проверить и URL, и JSON body.

## Воспроизведённые проверки

Среда: Node 25.8.1, npm 11.11.0, PostgreSQL 17.11 в уже запущенном локальном compose. Использованы существующие установленные зависимости. PostgreSQL-проверки создавали отдельные временные БД и роли с последующим удалением; persistent dev-БД не изменялась.

Для PostgreSQL-команд `ATLAS_PG_ADMIN_URL` указывал на локальный compose (`127.0.0.1:5432/atlas`); URL с credentials не сохраняется в отчёте.

| Команда | Результат |
|---|---|
| `npm test` | **44/44 PASS**, без skips; unit/reference и PGlite |
| `npm run typecheck` | PASS |
| `npm run api:build` | PASS |
| `npm run api:smoke` | PASS; fixture API |
| `npm run schema:validate` | PASS; Prisma 6.19 schema |
| `npm run db:check:pg17` | PASS; четыре миграции, SQL/FK-инварианты, RLS, identities, guard, pool reuse |
| `npm run test:pg` | **17/17 PASS**, без skips; Prisma deploy, roles.sql, seed, auth, DB API |
| `npm run db:check:drift` | PASS; diff пустой |
| Дополнительный HTTP/PG probe ниже | R1 воспроизведён: четыре случая 500 без audit; два контроля 403 с audit |

Команда для повторения probe после `npm run api:build` и настройки `ATLAS_PG_ADMIN_URL`:

```sh
node --experimental-strip-types --input-type=module <<'NODE'
import { createTestDatabase, runSeed } from './tests/support/pg-harness.ts';
import { startApi } from './tests/support/api-process.ts';
import { generateToken } from './packages/auth/token.ts';
const db = await createTestDatabase();
const token = generateToken();
let api;
try {
  runSeed(db.ownerUrl, { ATLAS_DEMO_TOKEN: token });
  api = await startApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: db.runtimeUrl });
  const counts = async () => (await db.owner.query(
    'SELECT (SELECT count(*)::int FROM "SecurityAuditEvent") AS security, (SELECT count(*)::int FROM "AuditEvent") AS client'
  )).rows[0];
  for (const [label, path, body] of [
    ['control client', '/clients/no-such-client/overview', null],
    ['NUL path', '/clients/ghost%00client/overview', null],
    ['NUL client', '/tools/execute', {clientId:'ghost\u0000client', tool:'atera.alert.list'}],
    ['NUL tool', '/tools/execute', {clientId:'demo-gasta', tool:'unknown\u0000tool'}],
    ['surrogate tool', '/tools/execute', {clientId:'demo-gasta', tool:'unknown\ud800tool'}],
    ['control tool', '/tools/execute', {clientId:'demo-gasta', tool:'unknown.tool'}]
  ]) {
    const before = await counts();
    const response = await fetch(api.base + path, {
      method: body ? 'POST' : 'GET',
      headers: {Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {})
    });
    const after = await counts();
    console.log({label, status:response.status,
      securityAuditAdded:after.security-before.security,
      clientAuditAdded:after.client-before.client});
    await response.arrayBuffer();
  }
} finally { await api?.stop(); await db.drop(); }
NODE
```

## Что подтверждено и что остаётся открытым

- Scoped reads выполняются через `withScope`; actor и memberships получаются по токену из БД. Owner-подключение отклоняется до старта HTTP. Scope не сохраняется при переиспользовании соединения.
- Новые identity-связи включают workspace в FK; обычный client scope не открывает identities, runtime не может их изменять. Замороженные миграции не изменены.
- Контекст сохраняет confirmed mappings, явные `MISSING`/`items: null`, приоритет старого CRITICAL и счётчики всего OPEN-набора. Проверенные ответы не содержат secretRef, tenant ID и token digest.
- Атомарность observation/audit, retry/dedup и Decisions failure/shadow пока доказаны reference-тестами и SQL-инвариантами. DB worker отсутствует; эти результаты не подтверждают durable обработку несколькими workers.
- **Непройденных обязательных PostgreSQL-gates для 1.1–1.3 нет**, но R1 — дополнительный выявленный дефект сверх зелёного штатного набора. Исторические ручные действия на persistent dev-БД и мутационные проверки из CHECKPOINT_REPORT заново не воспроизводились.
- **Live Atera/Huntress/OpenAI не выполнялся.** Credentials и реальные mapping не использовались. DB graph и HTTP probes синтетические; fixture/transport tests не являются live verification.
- `npm ci`, `npm audit`, Node 24 и Windows в этом ревью не запускались. Указанные в checkpoint dependency advisories остаются отдельным вопросом; версии не изменялись.

## Необязательное усиление проверок

Добавить HTTP-тест одного аутентифицированного actor с `context:read` у клиента A и только `events:ingest` у B. Сейчас DB API тестирует эти права на разных actors, а сценарий нескольких memberships проверяется ниже HTTP-слоя. Ошибки реализации здесь не обнаружено; это не блокер.

## Следующий безопасный шаг

Сначала исправить R1 и подтвердить PostgreSQL regression-тестом вместе с существующими проверками. Затем можно переходить к **1.4 Mapping workflow**: scoped `ResolvedConnection`, candidate/manual-confirm, отклонение cross-client и ambiguous links, quarantine conflicting confirmed mappings. Разрабатывать 1.5–1.10 или расширять scope в рамках этого ревью не требуется. Production-ready статус не присваивается.
