# Independent review — Checkpoint C

Дата: 2026-10-07. Ветка: `stage1/foundation`, HEAD `136088e`; код checkpoint — `1a95845`.
База принятого Checkpoint B: `2a753d2`. Diff: 87 файлов, +4809/−802, включая сохранённые verification artifacts. Рабочее дерево до ревью чистое.
Область: задания 1.7–1.10, CHECKPOINT_REPORT, `prompts/REVIEW_STAGE_1.md`, AGENTS.md и соответствующие требования docs/02, docs/04, docs/05. История принятого B сохранена в `2a753d2:REVIEW_REPORT.md`.

## Вердикт

**REQUEST_CHANGES — две обязательные находки P2: C1 и C2. Checkpoint C пока не принят.**

Штатные проверки подтверждены: **80/80 unit/PGlite, 108/108 PostgreSQL**, typecheck, API build/smoke, schema validation, PostgreSQL invariants и пустой migration drift. Дополнительные пробы выявили гонку triage с обработкой ревизии и блокировку baseline следующего клиента ожиданием shadow в операторском проходе. Есть также неблокирующая C3 (P3) о версии конфигурации. P0/P1 и межклиентских утечек в проверенных сценариях не найдено.

Отсутствие credentials корректно отмечено как отдельный live gate, но до принятия mock/recorded-объёма необходимо закрыть C1/C2.

## C1 — [P2] Конкурентный triage отправляет новую CRITICAL-ревизию в dead letter

**Место:** `packages/observations/lifecycle.ts:84–88`, `:91–95`, `:103–105`; безусловный UPDATE — строки 92–93.

`applyRevisionLifecycle` читает статус старой observation без блокировки строки, выбирает активные строки в JavaScript и затем безусловно переводит их в SUPPRESSED. Advisory lock сериализует workers одного source object, но `triageObservation` его не использует. Если оператор успевает закрыть выбранную observation, UPDATE пытается выполнить RESOLVED → SUPPRESSED. Триггер правильно запрещает этот переход, однако вся финальная транзакция новой ревизии откатывается, а worker классифицирует исключение как PERMANENT/UNEXPECTED_ERROR и пишет DEAD_LETTER.

**Воспроизведение на PostgreSQL 17.11 через два Prisma-пула и runtime-роль:**

1. Сохранить и обработать LOW-ревизию Huntress `review-triage-race` с revision `2026-10-07T06:00:00.000Z` — OPEN observation.
2. Сохранить новую CRITICAL-ревизию того же инцидента с revision `2026-10-07T07:00:00.000Z`.
3. Начать настоящий `triageObservation(..., 'resolve', {expectedStatus:'OPEN'})` и задержать его транзакцию после UPDATE, до commit.
4. Запустить `processPending` для новой ревизии: SELECT видит прежний committed OPEN, а UPDATE старой строки ждёт завершения triage.
5. Дать triage завершиться; дождаться worker.

**Факт:** triage успешно возвращает RESOLVED; новая CRITICAL-ревизия — **DEAD_LETTER, safeErrorCode=UNEXPECTED_ERROR, observationId=null**. Старое LOW закрыто, а новая срочная observation отсутствует. RawEvent сохранён и dead letter видим, но корректное входное событие требует ручного requeue из-за обычного пересечения двух разрешённых операций.

Для воспроизводимого порядка только во временной БД установлен тестовый BEFORE INSERT trigger на audit `observation.resolved`: advisory gate удерживает triage перед commit. Через pg_stat_activity подтверждено, что worker уже ждёт UPDATE Observation; затем gate освобождён. Сервисы, авторизация, обработка события и ограничения схемы работают без подмены; искусственно генерируемого исключения нет.

**Обязательное исправление:** согласовать supersede с triage — блокировать и перечитывать состояние либо условно менять только всё ещё активные строки с проверкой числа обновлений. Уже закрытую человеком observation сохранять; superseded-audit писать только при состоявшемся переходе. Новое событие должно завершаться нормально. Не скрывать гонку ослаблением lifecycle-trigger.

**Регрессия:** оба порядка конкурентного resolve/suppress старой observation и commit новой ревизии; новая CRITICAL получает ровно одну applied DecisionRun и URGENT/HUMAN_REVIEW observation, triage и audit остаются согласованными. Существующие тесты отдельно проверяют triage и конкуренцию двух workers, но не их пересечение.

## C2 — [P2] `worker-once` ждёт shadow первого клиента перед baseline следующего

**Место:** `packages/ops/worker-pass.ts:20–26`, прежде всего `await processShadowJobs` на строке 25.

Отдельная ShadowJob создана правильно, и `processPending` сам провайдера в shadow-режиме не вызывает. Но документированный entry point снова соединяет эти пути последовательно: для каждого клиента сначала baseline, затем весь пакет shadow, и лишь после этого — следующий клиент. Поэтому медленный эксперимент первого клиента задерживает уже сохранённый CRITICAL другого клиента. Это нарушает требование 1.7 о неблокирующем shadow на реальном операторском пути, хотя отдельный unit/service-сценарий проходит.

**Воспроизведение:** два клиента в memberships оператора; у `demo-gasta` LOW, у следующего по сортировке `demo-other` CRITICAL. Вызвать настоящий `runWorkerPass` с shadow-провайдером, задержанным на Promise-gate. Проверить БД после начала первого AI-вызова, затем освободить его.

| Момент | Первый клиент | Второй клиент |
|---|---|---|
| Первый shadow ещё выполняется | PROCESSED, 1 observation | **RECEIVED, 0 observations** |
| Shadow освобождён, проход завершён | PROCESSED, shadow DONE | PROCESSED, shadow DONE |

Использованы выданные ResolvedConnection, синтетические события и настоящий операторский проход под runtime-ролью. Второй connection — fixture Atera; события Atlas DTO, внешних вызовов нет. Задержка моделирует незавершённый вызов; реальная задержка ограничивается deadline каждого вызова и суммируется по пакету shadow.

**Обязательное исправление:** развести baseline и shadow на уровне операторского entry point. Как минимум baseline всех клиентов текущего прохода должен завершаться до ожидания shadow; независимый запуск shadow также допустим и обеспечивает более явное разделение. Обновить CLI/RUNBOOK при изменении команд. Отсутствие планировщика не требует смешивать два пути.

**Регрессия:** два клиента, held shadow первого; CRITICAL второго уже имеет applied baseline и URGENT observation до освобождения held-вызова. Дополнительно сохранить существующую проверку, что новая CRITICAL может обрабатываться параллельно отдельному shadow runner.

## C3 — [P3, неблокирующая] Rules/fixture игнорируют настроенный promptVersion

**Место:** `packages/decisions/runtime.ts:13–14`; `RulesDecisionProvider` и `FixtureDecisionProvider` в `packages/decisions/provider.ts`.

`createDecisionRuntime(config)` передаёт конфигурацию только OpenAI-провайдеру. В rules/fixture классификация берёт `defaultDecisionConfig.promptVersion`, а `decisionRunData` предпочитает это значение версии из переданного config. После изменения versioned config строки будут иметь новый configVersion, но старый promptVersion; shadow-baseline при том же config ведёт себя иначе.

**Проба без БД:** config с `configVersion=review-config-v2`, `promptVersion=event-route-v2`; `createDecisionRuntime` → `draftDecision`. В обоих режимах rules/fixture возвращается **event-route-v1**. Текущее значение в репозитории совпадает с default, поэтому это не блокирует текущие маршруты.

Рекомендуется передавать promptVersion/config локальным провайдерам и добавить проверку с отличающимся от default значением. Если rules требуют отдельной версии, сделать это явным контрактом вместо неявного test default.

## Воспроизведённые команды и результаты

Среда: Node 25.8.1, PostgreSQL 17.11, локальный compose. Использованы установленные зависимости. Команды PostgreSQL получают локальный `ATLAS_PG_ADMIN_URL`; credentials не сохраняются в отчёте. Persistent dev-БД не изменялась.

| Команда / проба | Результат |
|---|---|
| `npm test` | **80/80 PASS**, без skips: 67 unit/fixture, 13 PGlite |
| `npm run typecheck` | PASS |
| `npm run api:build` | PASS |
| `npm run api:smoke` | PASS, fixture API |
| `npm run schema:validate` | PASS |
| `npm run test:pg` | **108/108 PASS**, без skips, включая E2E и CLI-процесс |
| `npm run db:check:pg17` | PASS: 12 миграций, structural/FK/RLS invariants, decision/shadow, lifecycle, tool ledger, runtime guard и pool reuse |
| `npm run db:check:drift` | PASS, diff пустой |
| Дополнительные `node --experimental-strip-types --input-type=module` пробы через stdin | C1/C2 воспроизведены на PostgreSQL; C3 — через реальные функции runtime/draft |
| `git diff --check` | PASS |

PostgreSQL-пробы создавали отдельные throwaway-БД через `tests/support/pg-harness.ts`, применяли migrate deploy/roles.sql и synthetic seed; прикладной код подключался confined runtime-ролью. После проб временные БД, роли и тестовый trigger удалены; контрольный запрос показал **0 временных БД / 0 ролей**. Исходники и штатные тесты не менялись.

## Подтверждённое и границы

- Scope/permission checks предшествуют чтениям; новые FK несут workspace/client scope. Проверки guard включают ShadowJob. Миграции 2200/2300/080000 новые; предыдущие не менялись.
- Baseline, applied flag, observation, client audit, inbox completion и создание ShadowJob атомарны. При retry сохранённое решение переиспользуется. Shadow runs остаются non-applied; claim tokens и bounded retry проверены. C2 ограничивает независимость на уровне CLI.
- Source urgency floor, сохранение конфликтного evidence, защита urgent от не-urgent ревизии, keyset pages и ожидаемый статус triage покрыты проходящими тестами. C1 ограничивает вывод о конкурентном lifecycle.
- Gateway проверяет authoritative registry/risk/permission и схемы параметров; неоднозначное connection отклоняется. Execution ledger и audit пишутся транзакционно, scope denials — в security audit; malformed-input регрессии R1 проходят.
- Mock vendor transport, scripted Decisions и синтетические DTO не выдаются за live-данные. E2E повторён в полном test:pg; исторические JSON evidence отдельно не перезаписывались.
- **Live Atera/Huntress/OpenAI не выполнялся.** Реальные credentials, фильтры и контракты аккаунтов ещё требуют отдельного gate. Дополнительной проверки внешней документации в этом ревью не было.
- `npm ci`, `npm audit`, мутационные проверки автора, отдельный `npm run demo`, Node 24/другие ОС и persistent-dev deployment не повторялись. Известные ограничения из CHECKPOINT_REPORT — планировщик, lease renewal, vault/provisioning, retention, dependency audit — не объявляются готовыми возможностями.

## Обязательные исправления и следующий шаг

Закрыть **C1 и C2** в текущих доменах, добавить указанные регрессии, затем повторить tests/typecheck/build/smoke и PostgreSQL-проверки. C3 — рекомендуемая небольшая правка. В CHECKPOINT_REPORT скорректировать утверждение, что весь mock/recorded-объём готов и остаются только credentials.

После повторного принятия C безопасен отдельный live-read gate по RUNBOOK: сверка Atera account contract, tenant-scoped чтения Atera/Huntress и Decisions smoke, только при наличии credentials и указания владельца. Deployment, изменения аккаунтов, UI, remediation и новые коннекторы в это ревью не входят.

Изменён только `REVIEW_REPORT.md`; ветка `stage1/foundation` сохранена, коммиты не создавались.
