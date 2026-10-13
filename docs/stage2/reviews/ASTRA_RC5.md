# Независимое архитектурное re-review Stage 2 RC5

- Дата: 2026-10-08.
- Модель: `gpt-6-astra`, задана оркестратором; `reasoning_effort=xhigh` сохранён из-за критичности lock/privilege contract.
- Отдельная проверка upstream response-model в этой reviewer-сессии не выполнялась; атрибуция запуска относится к evidence оркестратора.
- Версия: `1.0-rc5`.
- Package hash: `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`.
- Вердикт: **APPROVE** для всего текущего архитектурного пакета RC5.

## Scope и идентичность артефакта

Проведено ограниченное повторное ревью после собственного `ASTRA_RC4.md`, без чтения чужих вердиктов или REVIEW_STATUS. Из `RC4_PACKAGE.zip` адресно прочитаны сравниваемые нормативные файлы; архив целиком не распаковывался.

Независимо пересчитаны SHA-256 всех 11 текущих нормативных файлов и aggregate по уточнённому алгоритму «сортировка по относительному пути → UTF-8 `<hash>  <path>\n`». Все значения совпали с manifest. Изменились ровно `02_CONTRACTS`, `03_CONNECTOR_SYNC`, `04_IMPLEMENTATION_PLAN`, `05_ACCEPTANCE`; остальные семь нормативных hashes совпадают с RC4, полностью рассмотренным в предыдущем ревью.

HEAD остаётся `916a4d69853ff6da636e8609a2e0bd33aa787f66`; `git diff --stat -- prisma packages tests scripts` пуст. Hashes root AGENTS/context map совпадают с зафиксированными в RC4. SHA-256 текущего manifest: `b88069dbc32eef0007f0e152b85687dce370605260eeb8a60bee9c36d5463577`.

## Закрытие RC4-A1

**CLOSED на уровне дизайна.** `02_CONTRACTS` §6 явно добавляет definer SELECT шести необходимых столбцов Connection и UPDATE(id) для row locking. Это покрывает требование [PostgreSQL 17 SELECT](https://www.postgresql.org/docs/17/sql-select.html#SQL-SELECT-DESCRIPTION) без общего UPDATE grant.

Узкая проверка `prisma/migrations/202610071700_stage1_mapping_workflow/migration.sql:38` подтверждает, что существующий `atlas_reject_connection_rebinding` сравнивает в том числе NEW.id/OLD.id и запрещает его изменение. Connection RLS остаётся применимым; routine не выполняет Connection DML, runner не имеет прямых прав и не может SET ROLE в definer. Порядок Connection → resource/root state сохранён.

A4a проверяет точные grants, C5a — вызов через настоящий EXECUTE-only runner, ожидание Connection lock, ACTIVE/DISABLED cleanup, неизменность binding/status/version, запрет direct SELECT/UPDATE/SET ROLE и гонку с publication. C5b сохраняет cleanup после disable. Обязательный сценарий прошлого замечания покрыт без owner fallback.

## Проверка остальных изменений

- Graph ge/le вместе с локальным `[from,to)` согласованы: точная верхняя граница валидируется, учитывается в retrieval limits и отбрасывается до staging; значения за пределами закрытого upstream-интервала отклоняются. Границы соседних leaf/root не дают двойного включения. Используемый ge/le пример соответствует [Microsoft signIns](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0).
- Fresh/upgrade provisioning теперь явно сохраняет существующие credentials, проверяет confinement и повторно применяет grants/revokes. Test-role naming и parity для PostgreSQL/PGlite включены в план; schema migrations не получают cluster-wide role operations.
- Общий MAC secret или shared scoped cursor storage сохраняет межпроцессную проверку cursor; отсутствие конфигурации закрывает доступ, прежние permission/freshness/retention проверки остаются обязательными.
- Increment общего lifecycleVersion распространяется на старые activation paths. Проверен существующий entry point `packages/sync/activation.ts`; изменение совместимо с сохранением старого публичного DTO и не отменяет M365 one-use capability/fence.
- Неоднозначность aggregate sorting из RC4 устранена в manifest.

## Findings и ограничения

**Обязательные findings: none.** Новых обязательных или необязательных архитектурных замечаний нет.

APPROVE распространяется на весь названный RC5 design hash и последовательность Stage 2 roadmap. Это не приёмка кода, миграций, live-интеграции, production readiness или архитектуры Stages 3–9. S2-A/B/C должны подтвердить реализацию и реальные PostgreSQL/Prisma проверки, S2-LIVE остаётся отдельным gate.

В этом re-review тесты приложения/миграций и live-вызовы не запускались; код, schema и нормативные файлы не изменялись. Проверки состояли из read-only сравнения/хеширования пакета и узкого чтения текущего Stage 1 кода. Единственный новый файл reviewer — этот отчёт. Итоговое закрытие S2-ARCH также требует второго независимого named-model approval на тот же RC5 hash.
