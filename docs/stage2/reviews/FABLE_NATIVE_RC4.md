Я прочитал все 11 нормативных файлов и точечно проверил код. Ниже отчёт.

---

# Независимое архитектурное ревью Atlas Stage 2 (M365 Correlation)

**Дата:** 2026-10-08
**Пакет:** 1.0-rc4, `docs/stage2/REVIEW_MANIFEST.json`, package SHA-256 `9c19f6053bec6676fc20799ceb60995a61140b35c9480474018f1a1c57ae9067`, baseline commit `916a4d6`
**Рецензент:** запрошенное ревью Fable 5.1. Проверка транспорта/модели фиксируется оркестратором отдельно; самоидентификация модели доказательством не является.
**Вердикт: APPROVE** (S2-ARCH, только для этого hash). Обязательных findings нет.

## Scope

Проверены: root `AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `prompts/REVIEW_STAGE_2.md`, `prompts/IMPLEMENT_STAGE_2.md`, `docs/ROADMAP.md`, `docs/stage2/{AGENTS,README,01_SPEC,02_CONTRACTS,03_CONNECTOR_SYNC,04_IMPLEMENTATION_PLAN,05_ACCEPTANCE,06_SOURCES_AND_ADR}.md`. Одобрение относится к дизайну Stage 2 и последовательности roadmap. Оно не одобряет код, live-интеграцию, production readiness или архитектуру Stages 3–9 (roadmap корректно помечает их как Planned без approvals).

Фокус: авторизация/изоляция, identity (directory id vs deviceId, guest), tenant/token/URL, durability/concurrency/recovery, coverage/freshness/retention, реализуемость Prisma/SQL/RLS.

## Проверенные допущения совместимости (код Stage 1)

| Допущение пакета | Факт в коде | Статус |
|---|---|---|
| `System` содержит microsoft365; bind сегодня отклонён | `packages/core/contracts.ts:2`; `BINDABLE_SYSTEMS` = atera, huntress (`packages/connections/connections.ts:18`); задача 2.4 добавляет | OK |
| Пары линков расширяются новой миграцией | TS-карта `LINKABLE` (`packages/graph/mapping.ts:22`) и SQL CHECK в `202610071700` строка 76; старые пары сохраняются | OK |
| Старый контекст и очередь mapping требуют явной фильтрации m365_* | `prisma-context.ts:40` берёт все CONFIRMED links без фильтра по типу; `listMappingReview` (`mapping.ts:219`) тоже. Пакет требует фильтрацию до запроса/проекции (02 §1, §5) | OK, корректно выявлено |
| ToolDefinition с единственным `permission`, any-of по клиентам | `registry.ts:21`; `tool-policy.ts:26,32`; `gateway.ts:44` и `apps/api/src/db/tools.ts:27` используют реестр по умолчанию. Пакет требует all-of, один composed registry, legacy DTO | OK, корректно выявлено |
| Connection: статусы DISABLED/FIXTURE/ACTIVE, binding immutable, можно добавить `lifecycleVersion` | Триггер `202610071700` строки 38–50 блокирует только id/system/tenant/provenance; статус и новая колонка меняются свободно; `secretRef` не защищён, что пакет закрывает версией | OK |
| Activation-purpose capability существует | `resolveConnectionForActivation` (`connections.ts:54–64`), in-memory WeakMap без версии/срока; расширение реализуемо | OK |
| Отдельный helper с RepeatableRead | `withScope` (`scoped-db.ts:21–28`) использует default isolation; Prisma 6.19 interactive transaction принимает `isolationLevel` | OK |
| RLS-политики не привязаны к ролям, definer-роль под RLS | Политики через `atlas_app_workspace()`/`atlas_app_clients()` (`202610071200` строки 144–164), без `TO role`; `app.actor_id` уже есть (`202610071600`) | OK |
| Шаг 1 корреляции читает `RawEvent.normalized.externalDevice` | Inbox хранит весь NormalizedEvent (`inbox.ts:58`); Huntress vendor path задаёт `{agent, agentId}` или null (`huntress/contract.ts:74`) | OK |
| `Device.personId` для assigned-person пути | `schema.prisma:104` | OK |
| Порядок попыток как в Stage 1 | `sync-state.ts` (attemptSeq/recordedSeq под FOR UPDATE) переносим на M365ResourceState | OK |
| Audit allowlist по ключам | `sanitize.ts:10–20`: незнакомые ключи молча отбрасываются; новые ключи должны быть добавлены явно (02 §6, задача 2.3) | OK |
| Runtime-роль: default privileges дают INSERT/UPDATE новым таблицам | `roles.sql:25`; пакет требует явный revoke/guard и fail-closed проверку | OK, см. заметку 2 |

## Обязательные findings

**Нет.** По каждому классу отказов пакет даёт согласованные, проверяемые правила:

- **Authority/tenant/token.** Tenant только из immutable binding; `/organization` проверка на каждом токене; cache key включает scope/connection/tenant/appId/secretRef/lifecycleVersion; nextLink валидируется по origin/path/version без пересборки; `m365-disable` блокирует Connection, инкрементирует версию даже для DISABLED и фенсит in-flight публикацию (02 §1, §3; 03 §2). Lock order «Connection → resource/root» общий для публикации, disable и cleanup.
- **Identity.** Сравнение `signIn.deviceDetail.deviceId` с `device.deviceId`, не с `device.id`; дубликат deviceId → AMBIGUOUS; guest — локальный объект; только ручные CONFIRMED; `Observation.entityId` не используется как fallback; переподтверждение после ingest берёт текущий mapping (02 §4).
- **Durability/concurrency.** Claim/lease/attemptSeq до I/O; публикация только последним seq под фенсом; immutable published attempt; бюджет retry на root job, переживает рестарт; разбиение окон с проверкой точного разбиения; crash на любой границе сохраняет last-good (03 §4–5; B4/B5/B5a/B5b).
- **Coverage/freshness/retention.** Coverage, freshness и directory-state независимы; «нет данных» ≠ «всё чисто»; expiry применяется в запросах до cleanup; cursor с MAC, фингерпринтом и будущими переходами (02 §5–6; C4/C4a/C4b).
- **Permissions/privacy.** `m365:read` обязателен сверх `context:read` во всех путях (API, tools, CLI, mapping queue, старый context); Decisions не получают M365 данных; sign-in DTO без IP/geo/UPN; audit — только локальные ID/коды.

## Неблокирующие заметки

1. **Фильтр `createdDateTime lt to` (03 §1).** Документация signIns перечисляет для `createdDateTime` операторы eq/ge/le; `lt` я не могу подтвердить без live-проверки. Пакет сам запрещает недокументированные параметры. Рекомендация: в задаче 2.6 использовать `le` плюс локальное исключение границы `to` (локальная проверка границ уже обязательна), а поддержку `lt` зафиксировать в L2. Тест: `tests/pg/m365-windows.pg.test.ts` — строка с `createdDateTime == to` не попадает в окно.
2. **Путь upgrade для ролей (02 §3, задача 2.2/2.9).** `roles.sql` начинается с non-idempotent `CREATE ROLE atlas_app`; на уже развёрнутой базе расширенный скрипт не выполнится целиком, а default privileges уже выдадут INSERT/UPDATE на новые таблицы. Fail-closed runtime-проверка защищает от запуска, но в пакете не описан сам шаг upgrade. Рекомендация: отдельный `prisma/upgrades/stage2_roles.sql` или DO-блоки с проверкой `pg_roles`; A4a проверять и для «существующая роль + новая миграция». Тест: `tests/pg/m365-upgrade.pg.test.ts`.
3. **Ключ MAC для cursor (02 §5).** Источник ключа не назван. Per-process random key даёт 409 при нескольких инстансах API. Рекомендация: указать `env://` secret reference либо серверную scoped-таблицу курсоров; для Stage 2 (один процесс, без deployment) достаточно задокументировать.
4. **`lifecycleVersion` при activation Stage 1 (02 §1).** Правило «activation increments» затрагивает и `packages/sync/activation.ts:34` для Atera/Huntress. Уточнить: инкремент во всех activation-путях или только M365; тест на R1/R2 регрессию.
5. **FK зеркала directory object → ExternalEntity.** Typed key `ExternalEntity_typed_key` не содержит `connectionId`; для «FK с connection» используйте unique `(workspaceId, clientId, connectionId, resourceType, externalId)` с `sourceObjectId`. Деталь реализации, не дефект дизайна.
6. **Операционная нагрузка.** Публикация до 20 000 зеркал в одной транзакции держит lock Connection секунды; retry с `retryAt` без scheduler требует повторного операторского pass. Оба решения приняты осознанно; RUNBOOK (2.9) должен их назвать.
7. **Коллизия имён в harness.** `renderRolesSql` (`pg-harness.ts:36–41`) проверяет форму файла; новые роли с префиксом `atlas_app_` не перекроются регулярным выражением `\batlas_app\b`, но assertion по числу вхождений потребует обновления, как пакет и предписывает.

## Ограничения ревью

- Инструменты только Read/Glob/Grep: я **не пересчитывал SHA-256** файлов и пакета и полагаюсь на проверку оркестратора; **не запускал** тесты, typecheck, миграции, PGlite или PostgreSQL; не обращался к tenant.
- Я не читал `REVIEW_STATUS.md`, `reviews/` и отчёты других рецензентов. Один вывод grep случайно показал совпадающие строки из `docs/stage2/reviews/*`; файлы не открывались, вердикт сформирован независимо.
- Факты о Microsoft Graph — из моих знаний документации, не из live-запросов; заметка 1 помечена как непроверенная.
- Approve = соответствие дизайна заявленным инвариантам и реализуемость на базе Stage 1. Утверждения S2-A/B/C требуют отдельных доказательств; S2-LIVE остаётся открытым; изменённые нормативные файлы требуют повторного ревью нового hash.
