# Independent review — Checkpoint B, revision 3

Дата: 2026-10-07. Ветка: `stage1/foundation`, HEAD `91fda0d`; код исправления — `ce466ae`.
Область: третья редакция CHECKPOINT_REPORT и закрытие оставшейся ветки B3 по `prompts/REVIEW_STAGE_1.md`. Diff от предыдущего ревью `17bd661`: 13 файлов, +175/−37. Рабочее дерево до проверки чистое. История находок: `13336c9:REVIEW_REPORT.md` (B1–B4), `17bd661:REVIEW_REPORT.md` (первые попытки B3). Checkpoint A принят ранее (`a04d805`).

## Вердикт

**APPROVE — Checkpoint B принят. Все обязательные находки B1–B4 закрыты; блокирующих находок не осталось.**

Повторно проверены **60/60 unit/PGlite, 75/75 PostgreSQL**, typecheck, API build/smoke, schema validation, SQL/RLS invariants и пустой migration drift. Две независимые пробы из предыдущего ревью теперь дают ожидаемый результат. В проверенном изменении новых дефектов корректности или межклиентского доступа не обнаружено.

Принятие относится к заданиям 1.4–1.6 и заявленным ограничениям checkpoint; live-интеграции и последующие задания этим не подтверждаются.

## B3 — закрыта, включая первые чтения

- `packages/sync/sync-state.ts:16`: `INSERT … ON CONFLICT DO UPDATE` атомарно создаёт первую строку и выдаёт номер каждой попытке до vendor I/O. Ветка с `seq=null` удалена.
- `packages/sync/sync-state.ts:36`: запись исхода выполняется под блокировкой уже существующей строки; сравниваются номер попытки и время. Success/error обновляют состояние через `update`. Устаревший результат сохраняет свои события, но не заменяет более новое состояние.
- `prisma/migrations/202610072100_stage1_sync_attempt_pending/migration.sql`: новый статус PENDING допускает начатое чтение без выдуманного результата; CHECK запрещает ему время исхода/успеха, код ошибки и записанный номер.
- `packages/graph/context-mapper.ts:75`: PENDING отображается как MISSING / SYNC_NOT_COMPLETED, с `items=null`.
- `tests/pg/sync-order.pg.test.ts`: проверены первые success/success, success/error, error/success в обоих порядках завершения, одинаковые времена, identity sync и защита от отката времени. Сценарии действительно запускают обе попытки до завершения любой.

**Независимые PostgreSQL-пробы**, каждая на свежей throwaway-БД, два Prisma-пула, confined runtime-роль, исходно отсутствующий SyncState:

| Порядок | Ожидаемый и полученный результат |
|---|---|
| A начинается в T и задержан; B начинается в T+100 ms и задержан; A сохраняет пустой набор, затем B читает два инцидента | B: OK, superseded=false; контекст: OK, два элемента, asOf=T+100 ms. Новый результат не отбрасывается |
| Тот же порядок; A читает два инцидента, затем B завершается UPSTREAM_UNAVAILABLE | B: ERROR, superseded=false; контекст: STALE / UPSTREAM_UNAVAILABLE, прежние два элемента и asOf=T. Ошибка видима |
| Контекст до завершения обеих попыток | В БД PENDING, attemptSeq=2, recordedSeq=0; контекст MISSING / SYNC_NOT_COMPLETED, items=null |
| 12 одновременно начатых первых попыток другого ресурса через два пула | 12 разных последовательных номеров 1–12, без потери инкрементов |

B1, B2 и B4 были закрыты в предыдущем ревью; соответствующий код в текущем diff не менялся, регрессии worker-recovery и pagination повторно прошли в полном PostgreSQL-наборе. R1 из Checkpoint A также остаётся покрыта проходящими тестами.

## Выполненные проверки

Среда: Node 25.8.1, PostgreSQL 17.11. Использованы существующие зависимости и локальный compose. PostgreSQL-команды запускались с локальным `ATLAS_PG_ADMIN_URL`; persistent dev-БД не изменялась.

| Команда | Результат |
|---|---|
| `npm test` | **60/60 PASS**, без skips |
| `npm run typecheck` | PASS |
| `npm run api:build` | PASS |
| `npm run api:smoke` | PASS, fixture API |
| `npm run schema:validate` | PASS |
| `npm run test:pg` | **75/75 PASS**, без skips |
| `npm run db:check:pg17` | PASS: 9 миграций, structural/FK/RLS invariants, PENDING CHECK, claim-token CHECK, runtime-role guard, pool reuse |
| `npm run db:check:drift` | PASS, diff пустой |
| Дополнительная `node --experimental-strip-types --input-type=module` проба через stdin | Все четыре проверки из таблицы выше PASS |
| `git diff --check` | PASS |

Проба использовала `tests/support/pg-harness.ts:createTestDatabase/runSeed`, `actors/gasta`, `liveHuntressWithConfirmedAgent` и настоящий Huntress adapter с mock transport. Чтения задерживались Promise-gate; runtime-код не изменялся. После проверок соединения закрыты, временные БД и роли удалены; контрольный запрос показал 0/0. В diff добавлена только миграция 2100, предыдущие миграции не изменены.

## Неблокирующая неточность отчёта

В `CHECKPOINT_REPORT.md:155` вводный абзац Verification всё ещё связывает команды с деревом `f7ae5fb`, хотя таблица уже включает PENDING, 9 миграций и 75 тестов из `ce466ae`. Стоит уточнить commit для свежего прогона и отдельно оставить дату/commit прежнего `npm ci`. На принятие кода это не влияет: перечисленные выше проверки независимо повторены на текущем HEAD. Обязательных исправлений кода нет.

## Границы проверки и следующий шаг

**Невыполненных PostgreSQL-gates из списка выше нет. Live Atera/Huntress/OpenAI не выполнялся.** HTTP-проверки используют mock transport и синтетические fixtures. Контракт Atera по-прежнему требует сверки с аккаунтом до live-активации; Atera alerts остаются недоступны по принятому решению владельца. Реальные credentials и аккаунты в этом ревью не использовались.

`npm ci`, `npm audit`, Node 24/Windows, мутационные проверки автора и persistent-dev deployment повторно не выполнялись. Известные ограничения worker — отсутствие отдельного процесса по расписанию, продления lease и отдельной shadow-job — не объявляются здесь готовыми возможностями. Возможный лишний provider call при перехвате lease остаётся документированным ограничением.

**Безопасный следующий шаг: задание 1.7 Decision Layer** — отдельная shadow-job, versioned DecisionConfig, модель/allowlist, MODEL_MISMATCH, advisory failure → HUMAN_REVIEW, timeout/budget/retry, circuit-breaker и telemetry. Проверить, что медленный shadow не задерживает следующее CRITICAL-событие. Live smoke остаётся отдельным gate; UI, remediation, новые коннекторы и orchestration вне текущего scope.

В рамках ревью изменён только `REVIEW_REPORT.md`. Ветка не переключалась, коммиты не создавались.
