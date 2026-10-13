# Независимое архитектурное ревью Stage 2 RC4

- Дата: 2026-10-08.
- Модель: `gpt-6-astra`, задана оркестратором; `reasoning_effort=xhigh`.
- Отдельная проверка upstream response-model в этой reviewer-сессии не выполнялась; атрибуция запуска относится к evidence оркестратора.
- Версия: `1.0-rc4`.
- Package hash: `9c19f6053bec6676fc20799ceb60995a61140b35c9480474018f1a1c57ae9067`.
- Вердикт: **REQUEST_CHANGES**.

## Scope и целостность

Независимо прочитаны ровно 11 нормативных файлов из `REVIEW_MANIFEST.json`, root/Stage 2 routing instructions и context map. Чужие вердикты, REVIEW_STATUS и исторические review reports не читались.

Все 11 фактических SHA-256 совпали с manifest. Повторная проверка перед записью отчёта подтвердила неизменность пакета. Указанный aggregate воспроизводится при сортировке записей по относительному пути; неоднозначность описания алгоритма отмечена ниже.

Узко проверена совместимость со Stage 1: scoped transactions/runtime-role guard, connection issuance/binding/activation, mapping registration, context/audit projections, tool registry/policy, `prisma/roles.sql`, PostgreSQL harness, PGlite migration loading и SQL-check entry points. HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; проверенные implementation files не имеют tracked dirty changes.

Дополнительные входы reviewer:

| Файл | Фактический SHA-256 |
|---|---|
| `AGENTS.md` (dirty) | `a86026d65e55ce365ebed9a2dfd13873ee20e9862a6f612cd50886e857e8a631` |
| `docs/AI_CONTEXT_MAP.md` (dirty) | `638a86f88a079de63a31cf424e8bb5412e70e764dac8dd5badd1f2e78b05abc6` |
| `docs/stage2/REVIEW_MANIFEST.json` | `20bd431a14e29cdaaf7cb461edecdde97f819c91a6af822bed39f2cb896e512c` |

Scope заключения — архитектура Stage 2 и последовательность roadmap. Это не приёмка реализации, live-интеграции, production readiness или детальной архитектуры Stages 3–9.

## Обязательная находка

### RC4-A1 — P2: права cleanup definer не покрывают обязательный Connection lock

- **Файл/раздел:** `docs/stage2/02_CONTRACTS.md`, §6, строки 243–253; также §3, строки 114–116. Acceptance: A4a, C5a/C5b.
- **Сценарий:** роли provisioned буквально по §6: definer получает SELECT/DELETE только на новых M365 payload/membership/attempt tables, ограниченный UPDATE pointer/status fields и INSERT AuditEvent. Затем EXECUTE-only runner вызывает cleanup для истёкшей публикации. Routine обязана первой заблокировать существующую таблицу `Connection`, но описанный закрытый набор прав не даёт ей SELECT на `Connection` и не фиксирует необходимый UPDATE grant для row lock. Runner также не может получить этот lock сам.
- **Последствие:** корректно ограниченный definer получает `permission denied` до удаления payload. Реализация должна либо добавить права сверх описанного security contract, либо пропустить обязательный общий fence. Последний вариант нарушает согласованный порядок блокировок cleanup/publication/disable.
- **Основание:** в PostgreSQL 17 все варианты SELECT row locking, включая FOR SHARE/KEY SHARE, требуют SELECT используемых столбцов и UPDATE хотя бы одного столбца блокируемой таблицы. См. [PostgreSQL 17 SELECT](https://www.postgresql.org/docs/17/sql-select.html#SQL-SELECT-DESCRIPTION).
- **Необходимое исправление:** явно включить в контракт минимальные SELECT-права на нужные столбцы `Connection` и ограниченный UPDATE grant, необходимый только для row locking, либо описать эквивалентный защищённый способ получения того же Connection fence. Сохранить NOLOGIN/non-owner/NOBYPASSRLS, отсутствие direct DML у runner, неизменяемость binding и запрет изменения Connection самой cleanup routine. Grants должны применяться через `roles.sql`; общий порядок Connection → state остаётся обязательным.
- **Проверка:** реальный PostgreSQL: после migrate + role provisioning вызвать routine через настоящий EXECUTE-only runner для ACTIVE и DISABLED connection; expired payload/pointer/audit изменяются атомарно без owner fallback. В параллельной транзакции удержать Connection lock и доказать, что cleanup ждёт его; затем проверить гонку с publication. Отдельно проверить, что runner не читает/меняет Connection напрямую, routine не меняет binding/status/version и RLS сохраняет другой client. Привязать проверку минимальных grants к A4a, поведение — к C5a/C5b.

Других обязательных находок в проверенном архитектурном scope нет.

## Необязательные заметки

1. `hashAlgorithm` говорит «sorted lines», но hash воспроизводится при сортировке **по path**. Буквальная лексикографическая сортировка полных строк `<hash>  <path>\n` даёт `6a903a2427ffedc1df0c070592b4d436555414fad2400fe6f5c2d3733f721151`. Уточнить ключ сортировки в manifest или привести маленький verifier. Это не блокирует идентификацию RC4: все индивидуальные hashes совпали, а path-sorted aggregate равен заявленному.
2. При реализации role provisioning учитывать не только `renderRolesSql`: `scripts/pg17-check.ts` и `tests/database.test.ts` сейчас имеют собственные grants. Пакет уже требует обновления explicit role checks; независимая реализация этих путей не должна случайно тестировать более широкую роль, чем production `roles.sql`.

Scope/tenant confinement, all-of permissions, отделение V1/Decisions, различение directory id/deviceId, stale/expired identity, immutable sign-in versions, root publication, retry budgets, local disable/version fence и отдельные live gates описаны согласованно. API-факты по application permissions/полям sign-ins и organization проверены по [Microsoft signIns](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0), [organization](https://learn.microsoft.com/en-us/graph/api/organization-list?view=graph-rest-1.0) и [deviceDetail](https://learn.microsoft.com/en-us/graph/api/resources/devicedetail?view=graph-rest-1.0). Это не доказывает доступ конкретного tenant и не заменяет S2-LIVE.

## Ограничения и следующий gate

Код, schema, нормативные документы и accounts не изменялись. Тесты приложения/миграции и live-вызовы не запускались; SQL-находка основана на текущем grant-контракте и документации PostgreSQL, а не на ещё отсутствующей Stage 2 routine. Единственная запись reviewer — этот отчёт.

После исправления RC4-A1 нужен новый manifest hash и независимая приёмка изменённого grant/lock-контракта. Этот вердикт не разрешает продвижение через S2-ARCH.
