# Stage 2 — specification

## 1. Результат и границы

Техник открывает существующую Huntress observation и получает:

1. Исходный инцидент и его неизменённые severity/priority/route.
2. Подтверждённое каноническое устройство, если оно известно.
3. Подтверждённые M365 device/user mappings; человека, назначенного устройству в Atlas, как отдельный контекст.
4. Sign-ins в запрошенном окне с доказательством каждого совпадения и явным отсутствием/неполнотой данных.

Совпадение по времени не доказывает причинность. Вход пользователя с устройства не доказывает владельца устройства.
Отсутствие записи не означает, что входов/компрометации не было.
Gasta/Kari/GASTA-LT-07 остаются синтетическим сценарием до отдельной live-проверки.

В scope: Microsoft Graph v1.0, global commercial cloud, application access, один tenant на Connection;
directory users/devices, доступные через v1.0 user sign-ins; ручное подтверждение mappings;
bounded durable sync; отдельные read API/tools/CLI; PostgreSQL/RLS и privacy tests.

Вне scope: Intune inventory, Defender, mailbox/Teams content, Lighthouse/WorkIQ, GDAP provisioning,
cross-tenant guest home-directory resolution, service-principal/managed-identity sign-ins, Graph beta/delta,
webhooks, автоматическое объединение людей, write-actions, UI и расширение Decisions evidence.
Directory full reads и sign-in time windows достаточны для первого среза; delta — отдельная оптимизация после измерений.

## 2. Принятые проектные решения для ревью

| ID | Решение | Причина |
|---|---|---|
| S2-ADR-01 | Отдельный M365 evidence domain поверх существующего graph | Sign-in не является Huntress incident и не имеет Atlas source severity |
| S2-ADR-02 | M365 data не добавляется в ClientContextV1 | Сохраняет контракт и не раскрывает новые identity данные существующим context:read callers |
| S2-ADR-03 | Новый permission `m365:read`, совместно с `context:read` | Разделяет общие observations и подробные M365 identities/sign-ins |
| S2-ADR-04 | Только ручные CONFIRMED links для первого среза | UPN, email, hostname и displayName сами по себе не являются доказательством |
| S2-ADR-05 | Exact vendor references + подтверждённый canonical mapping | Автоматическая связь source evidence внутри tenant отделена от решения о canonical identity |
| S2-ADR-06 | Отдельные directory generations и sign-in windows | Нельзя переносить snapshot replacement открытых инцидентов на поток входов |
| S2-ADR-07 | OAuth transport отдельно от GET-only vendor transport | Token POST допустим только фиксированному authority; write Graph calls по-прежнему запрещены |
| S2-ADR-08 | Источники/coverage/freshness возвращаются с каждым результатом | Полное прохождение страниц не гарантирует полноту реального мира |

## 3. Совместимость с Foundation

Повторно используем Actor, per-client memberships, issued ResolvedConnection, immutable connection binding,
withScope, RLS, audit sinks, mapping statuses, ToolExecution ledger и HTTP boundary.
Новые таблицы включаются в PROTECTED_TABLES, SQL invariants и explicit runtime grants.
Составные FK всегда включают workspace/client и connection там, где привязка относится к нему.

Новые resource types: `m365_user`, `m365_device`, `m365_signin`.
Только первые два linkable: PERSON/DEVICE соответственно; signin никогда не identity.
SQL CHECK для EntityLink расширяется новой миграцией; старые pairs agent/DEVICE и contact/PERSON сохраняются.
`System` уже содержит microsoft365; это не доказательство готового adapter.

Из общего context, mapping CLI/list, audit и старых tools не должны появляться новые M365 поля/IDs у caller
без `m365:read`. V1 исключает все m365_* links/resources даже у привилегированного caller.
В API новый отдельный versioned ответ. Fixture и DB режимы соблюдают одинаковые разрешения.

Существующие observations/RawEvent/DecisionRun не изменяются и не дополняются M365 payload.
Корреляция вычисляется при чтении по опубликованному evidence и текущим подтверждённым links.
Изменение/rejection link отражается в следующем чтении; прежнее человеческое triage не отменяется.

## 4. Модули и границы

| Boundary | Планируемые entry files | Ответственность |
|---|---|---|
| Graph vendor I/O | connectors/microsoft365/{auth,http,contract,connector}.ts | Scoped auth, endpoint allowlist, DTO projection, pages |
| Directory | packages/m365/directory.ts | Generation publication, active membership, opaque external registration |
| Sign-in ingestion | packages/m365/{windows,ingest}.ts | Claim/retry, staging, immutable evidence, coverage |
| Persistence | packages/m365/{repository,retention}.ts | Scoped reads, bounded cleanup, atomic state |
| Correlation | packages/correlation/{contracts,resolve,query}.ts | Evidence chain, unknown states, paging; no vendor I/O |
| Surfaces | apps/api/src/db/correlations.ts, packages/ops/m365.ts | Thin controllers/CLI delegating domain services |
| Tools | packages/tools/m365.ts | Two read tools with authoritative permissions/risk |

Имена — целевые границы, не требование создавать пустые файлы. Перед расширением существующей смешанной
логики извлечь boundary; сохранять ~500 строк, абсолютный потолок 700. Не создавать central barrel.

## 5. Завершение

Engineering complete означает S2-A/B/C accepted, отсутствие обязательных findings и проверенную регрессию Stage 1.
Live verified означает отдельно пройденный S2-LIVE. Если tenant/credentials недоступны, это единственный
допустимый внешний blocker для локально завершённого объёма; лицензии и реальные данные не выдумываются.
Production readiness остаётся отдельной областью roadmap.
