# Independent review — Checkpoint A, revision 2

Дата: 2026-10-07. Проверено: `stage1/foundation @ 61122b9`; последний коммит кода — `c4c536c`.
Первое ревью: `9770c83` относительно `main @ 4d6f897`; исходный отчёт сохранён в Git-коммите `4a38d5c`.
Повторное ревью: diff `4a38d5c..61122b9` (16 файлов, +302/−50), исправление R1 и связанные регрессии.
До повторного ревью рабочее дерево чистое. Изменён только этот отчёт; ветка осталась `stage1/foundation`.

## Вердикт

**APPROVE — Checkpoint A принят. R1 закрыта. Блокирующих находок не осталось; новых обязательных исправлений нет.**

Независимо воспроизведены 49/49 unit/PGlite и 22/22 PostgreSQL integration тестов, typecheck, API build/smoke, schema validation и пустой migration drift. Исходная шестисценарная HTTP-проба из первого отчёта повторена без изменения её кода: все запросы вернули 403 и добавили ровно одну запись в соответствующий журнал.

Вердикт относится к заданиям 1.1–1.3. Он не означает завершение Stage 1 или готовность к production.

## Находки по серьёзности

Открытых P0/P1/P2/P3-находок по проверенным изменениям нет.

**R1 [P2], потеря аудита на NUL/одиночном UTF-16 surrogate — исправлена в `c4c536c`.** Ранее четыре из шести запросов исходной пробы возвращали 500 без audit. Теперь результат стабилен: контролируемый отказ и сохранённый след запроса.

| Проверенный участок | Вывод |
|---|---|
| `packages/audit/sanitize.ts:16` | NUL, C0 controls, DEL и одиночные surrogates экранируются; обратный слэш удваивается. В пределах сохранённого префикса NUL отличается от буквального текста `\u0000`. Лимит 200 не разрезает escape или surrogate pair. |
| `packages/audit/prisma.ts:27`, `packages/audit/memory.ts:11` | Оба sink применяют общие правила при записи, сохраняя явный список полей и allowlist metadata. Scope и actor authority не подменяются экранированными значениями. |
| `packages/audit/sanitize.ts:40`, `packages/audit/prisma.ts:57` | Чтение применяет allowlist без повторного экранирования; PG-тест подтвердил round trip. |
| `apps/api/src/db/auth.ts:44`, `apps/api/src/db/tools.ts:27` | Malformed client ID отклоняется до чтения клиентских данных и установки клиентского RLS-scope; `SecurityAuditEvent` получает `INVALID_SCOPE_ID`. Аутентификация и сама запись аудита по-прежнему обращаются к БД. |
| `packages/tools/gateway.ts:37` | Scope проверяется раньше имени инструмента. Malformed tool в доступном клиенте даёт `tool.denied / INVALID_TOOL_NAME`; чужой клиент остаётся scope-отказом в workspace audit. |

Схема, миграции, runtime grants, auth lookup и механизмы tenant isolation в исправлении не менялись. Повторные проверки RLS, составных FK, runtime-role guard и переиспользования соединений прошли.

## Исходная проба R1 после исправления

Проба извлечена из shell-блока `REVIEW_REPORT.md` первой редакции и исполнена через Node на исправленной сборке. Использованы новая временная PostgreSQL-БД, confined runtime role и случайный синтетический токен; после завершения БД и роль удалены.

| Сценарий | HTTP | Новых SecurityAuditEvent | Новых AuditEvent |
|---|---:|---:|---:|
| Неизвестный клиент, обычный ID — контроль | 403 | 1 | 0 |
| `GET /clients/ghost%00client/overview` | 403 | 1 | 0 |
| Tool request с `clientId: "ghost\u0000client"` | 403 | 1 | 0 |
| Доступный клиент, `tool: "unknown\u0000tool"` | 403 | 0 | 1 |
| Доступный клиент, `tool: "unknown\ud800tool"` | 403 | 0 | 1 |
| Доступный клиент, `tool: "unknown.tool"` — контроль | 403 | 0 | 1 |

Точные сохранённые значения и reason codes дополнительно проверены в `tests/pg/api-input.pg.test.ts` и `tests/pg/database.pg.test.ts`. Unit-тест gateway считает вызовы read callback и подтверждает ноль чтений при отказах. HTTP-тест проверяет отсутствие `tool.started/tool.succeeded`; порядок до вызова client repository также проверен по коду.

Необязательное замечание первого ревью тоже закрыто: `tests/pg/api.pg.test.ts:141` проверяет одного actor с `context:read` у Gasta и только `events:ingest` у другого клиента. REST и tool-вызов второго клиента отклоняются; права первого не переносятся на второй.

## Воспроизведённые команды

Среда: Node 25.8.1, PostgreSQL 17.11, локальный compose. Использованы существующие установленные зависимости. PostgreSQL-команды запускались с `ATLAS_PG_ADMIN_URL`, указывающим на локальный сервер; credentials не сохраняются в отчёте. Тесты работали во временных БД, persistent dev-БД не изменялась.

| Команда / проверка | Фактический результат |
|---|---|
| `npm test` | **49/49 PASS**, без skips; unit/reference + PGlite |
| `npm run typecheck` | PASS |
| `npm run api:build` | PASS |
| `npm run api:smoke` | PASS; fixture API |
| `npm run schema:validate` | PASS |
| `npm run db:check:pg17` | PASS; четыре миграции, structural/FK invariants, RLS, identities, runtime-role guard, pool reuse |
| `npm run test:pg` | **22/22 PASS**, без skips; Prisma deploy, roles.sql, seed, auth, DB API, R1 и разные права одного actor |
| `npm run db:check:drift` | PASS; diff пустой |
| Исходная HTTP/PG-проба R1 из `4a38d5c:REVIEW_REPORT.md` | **6/6**: HTTP 403, ровно одна ожидаемая audit-запись |
| `git diff --check` | PASS |

Для узкого повторения R1 после сборки: `node --experimental-strip-types --test tests/pg/api-input.pg.test.ts` с настроенным `ATLAS_PG_ADMIN_URL`. Общие текстовые правила проверяются командой `node --experimental-strip-types --test tests/audit-sanitize.test.ts`.

## Оставшиеся gates и ограничения

- **Непройденных обязательных PostgreSQL-gates Checkpoint A в проверяемом объёме нет.** Данные graph и HTTP probes синтетические. Исторические ручные действия на persistent dev-БД заново не воспроизводились.
- **Live Atera/Huntress/OpenAI не выполнялся:** реальные credentials и mapping не использовались. Mocked transport и fixture tests не являются live verification.
- Durable pipeline/worker, DB-транзакция observation/audit, recovery нескольких workers, snapshots/freshness и последующие задания 1.4–1.10 остаются следующими этапами. Зелёные reference/SQL-тесты не подтверждают их реализацию через DB worker.
- В повторном ревью не запускались `npm ci`, `npm audit`, Node 24, Windows и негативный контроль на старом коде. Сообщённое автором зависание Prisma не воспроизводилось; его причина здесь не подтверждена. Заявленные в checkpoint dependency advisories остаются отдельным вопросом; версии не изменялись.
- Структурно неверные JSON-тела и недекодируемые URL по-прежнему могут получить 400 до scope-решения. Это отделено от проверенных scope/tool-denials и не является остатком R1.

## Что безопасно делать дальше

Можно переходить к **1.4 Mapping workflow**: scoped `ResolvedConnection`, явный connection → customer/organization mapping, candidate/manual-confirm с resourceType/entityKind, отказ для cross-client/ambiguous links и quarantine conflicting confirmed mappings.

Обязательных исправлений перед этим переходом по результатам ревью нет. UI, write-actions, remediation и новые интеграции вне Stage 1 scope не добавлять; production-ready статус не присваивать.
