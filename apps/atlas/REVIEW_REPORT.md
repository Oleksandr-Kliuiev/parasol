# Independent review — Checkpoint C, revision 2

Дата: 2026-10-08. Ветка: `stage1/foundation`, HEAD `916a4d6`; исправления — `cbb511f`.
Область: повторная проверка C1–C3 и второй редакции CHECKPOINT_REPORT по `prompts/REVIEW_STAGE_1.md`. Diff от предыдущего ревью `4724036`: 27 файлов, +707/−366, включая обновлённые verification artifacts. Рабочее дерево до проверки чистое. Первоначальные находки и воспроизведение сохранены в `4724036:REVIEW_REPORT.md`.

## Вердикт

**APPROVE — Checkpoint C принят в заявленном mock/recorded-объёме. C1, C2 и C3 закрыты; обязательных находок не осталось.**

Проверено: **81/81 unit/PGlite, 114/114 PostgreSQL**, typecheck, API build/smoke, schema validation, PostgreSQL invariants и пустой migration drift. Независимая PostgreSQL-проба подтвердила исправление прежних сценариев C1/C2 и сохранение настроенных версий C3. Новых дефектов корректности или межклиентского доступа в проверенном diff не обнаружено.

Это принятие заданий 1.7–1.10 с документированными ограничениями. Live-read gate остаётся открытым; production-ready не подтверждается.

## Закрытие находок

| Находка | Исправление и подтверждение |
|---|---|
| **C1 — закрыта** | `packages/observations/lifecycle.ts`: supersede делает условный updateMany только для OPEN/ACKNOWLEDGED; при нуле изменений audit не создаётся. Lifecycle-trigger не изменён. Новые PostgreSQL-тесты проверяют resolve/suppress в обоих порядках относительно commit ревизии. |
| **C2 — закрыта** | `packages/ops/worker-pass.ts`, `packages/ops/commands.ts`, `scripts/ops.ts`: worker-once обрабатывает только события, shadow-once — только shadow jobs. В shadow-режиме baseline не вызывает провайдера. Новый тест проверяет CRITICAL другого клиента при удерживаемом shadow-вызове; E2E и CLI-проверки обновлены. RUNBOOK требует независимых запусков. |
| **C3 — закрыта** | `packages/decisions/provider.ts`, `packages/decisions/runtime.ts`: RulesDecisionProvider и FixtureDecisionProvider получают promptVersion из config. Новый тест проверяет classification и DecisionRun data для rules, fixture и shadow; независимая проба дополнительно проверила реальные сохранённые DecisionRun в rules/fixture. |

**Независимая проба на PostgreSQL 17.11**, два Prisma-пула, confined runtime-роль:

1. **C1, исходный порядок ревью.** Старую LOW observation закрывает настоящий `triageObservation(resolve, expectedStatus=OPEN)`. Только во временной БД тестовый trigger задерживает транзакцию перед записью audit/commit; worker новой CRITICAL-ревизии читает старый committed OPEN и ждёт UPDATE той же строки. После освобождения triage старое состояние — RESOLVED, новое событие — **PROCESSED**, observation — **OPEN / CRITICAL / URGENT / HUMAN_REVIEW**, applied runs — **1**. Ложных `observation.superseded` для закрытой человеком строки — **0**. Искусственно генерируемого исключения нет.
2. **C2, операторские команды.** Через `runOperatorCommand(worker-once)` создан baseline первого клиента без вызовов AI. Отдельный `shadow-once` удержан внутри provider call первого клиента; в это время добавлен CRITICAL второго и выполнен ещё один `worker-once`. До освобождения shadow второй клиент уже имеет **PROCESSED / CRITICAL / URGENT / HUMAN_REVIEW**. Число provider calls в этот момент — **1**, только удержанный shadow. После освобождения shadow-проход завершается нормально.
3. **C3, реальные строки БД.** Config с `promptVersion=event-route-v2`, `configVersion=review-config-v2`; построенные `createDecisionRuntime` rules/fixture-провайдеры обрабатывают отдельные события. В обоих сохранённых DecisionRun ровно эти две версии, без подстановки встроенной v1.

Прежние ограничения не замаскированы: guard остаётся в памяти процесса и при отдельном процессе на проход не сохраняет бюджет/circuit между запусками. Это теперь явно описано в CHECKPOINT_REPORT и RUNBOOK; при устойчивом outage указан переход в rules. Scope работы не расширялся до планировщика или live-вызовов.

## Выполненные проверки

Среда: Node 25.8.1, PostgreSQL 17.11, локальный compose; существующие зависимости. PostgreSQL-команды запускались с локальным `ATLAS_PG_ADMIN_URL`. Persistent dev-БД не изменялась.

| Команда / проба | Результат |
|---|---|
| `npm test` | **81/81 PASS**, без skips: 68 unit/fixture, 13 PGlite |
| `npm run typecheck` | PASS |
| `npm run api:build` | PASS |
| `npm run api:smoke` | PASS, fixture API |
| `npm run schema:validate` | PASS |
| `npm run test:pg` | **114/114 PASS**, без skips, включая lifecycle-race, operator-passes, E2E и CLI-процесс |
| `npm run db:check:pg17` | PASS: 12 миграций, structural/FK/RLS invariants, decision/shadow, lifecycle, tool ledger, runtime guard и pool reuse |
| `npm run db:check:drift` | PASS, diff пустой |
| `node --experimental-strip-types --input-type=module` проба через stdin | C1/C2 и сохранённые версии C3 — PASS, результаты выше |
| `git diff --check` | PASS |

Проба использовала `tests/support/pg-harness.ts:createTestDatabase/runSeed`, actor/event fixtures и выданные ResolvedConnection. Прикладные операции выполнялись runtime-ролью; владелец использовался для установки, синтетических fixtures и тестового механизма синхронизации. После проверки оба пула закрыты, временная БД с trigger и роль удалены; контрольный запрос показал **0 временных БД / 0 ролей**. Исходники и штатные тесты не менялись.

Схема, миграции и ограничения БД в исправлении не изменены. Принятые исправления A/B и проверки изоляции, audit, durable recovery, source urgency и gateway повторно прошли в полном наборе.

## Неблокирующая редакционная неточность

В краткой таблице слоёв `CHECKPOINT_REPORT.md:144–146` остались старые числа **67 unit/fixture и 108 PostgreSQL**. Актуальные — **68 и 114**, как уже правильно указано в разделе Verification. Это не влияет на принятие кода; обязательных исправлений нет.

## Границы и следующий шаг

**Все перечисленные PostgreSQL-gates выполнены. Live Atera/Huntress/OpenAI не выполнялся.** HTTP в тестах идёт через mock transport/scripted endpoint с синтетическими данными. Контракт Atera требует сверки с аккаунтом до live-активации; tenant-фильтры, реальные права ключей, rate limits, модель и usage ещё требуют live validation.

`npm ci`, `npm audit`, мутационные проверки автора, отдельный `npm run demo`, Node 24/другие ОС и persistent-dev deployment повторно не выполнялись. E2E повторён внутри test:pg без перезаписи сохранённых JSON evidence. Планировщик, lease renewal, vault/provisioning, retention и dependency audit остаются ограничениями из CHECKPOINT_REPORT.

**Следующий разрешённый этап после отдельного указания владельца и получения credentials — live-read gate по RUNBOOK:** сверка Atera account contract, tenant-scoped чтения Atera/Huntress и Decisions smoke, с отдельной записью фактического результата. До этого checkpoint принят только по проверенному локальному объёму. Deployment, изменения аккаунтов, UI, remediation и новые коннекторы этим ревью не разрешаются и не выполнялись.

В рамках повторного ревью изменён только `REVIEW_REPORT.md`. Ветка `stage1/foundation` сохранена, коммиты не создавались.
