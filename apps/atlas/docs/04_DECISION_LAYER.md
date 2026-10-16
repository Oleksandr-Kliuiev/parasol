# 04 — Atlas Decision Layer

## Роль

Decision Layer даёт advisory classification/routing. Policy Engine отдельно проверяет actor, scope, permissions и authoritative tool risk. В этой Stage 1 отсутствуют write-actions; ни одна probability не разрешает выполнить инструмент.

Официальный контракт проверен 7 октября 2026: `POST https://api.openai.com/v1/decisions`, общий `input` и `questions`; для route используется `choice`; ответ содержит `model`, `answers[]` (`choice` с `choice/confidence/probabilities[{value, probability}]` или `refusal`) и `usage`. По guide `gpt-6-luna` — единственная доступная модель на дату проверки; пример ответа с фактическим значением поля `model` в документации не приведён. Поэтому имя модели — **конфигурация** (`OPENAI_DECISIONS_MODEL`), а допустимые идентификаторы в ответе — явный allowlist (`OPENAI_DECISIONS_ALLOWED_MODELS`, без автоматического принятия суффиксов). Несовпадение — отдельный код `MODEL_MISMATCH`, который сохраняется в `DecisionRun.safeErrorCode` и метриках, а не растворяется в общем `catch`; `DecisionRun` хранит и запрошенную, и возвращённую модель. Реализация HTTP находится в `packages/decisions/openai.ts`; фактический upstream вызов здесь не выполнялся. Источники: [API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create), [guide](https://developers.openai.com/api/docs/guides/decisions).

## Контракт первой версии

Одна задача: route ∈ MONITOR / INVESTIGATE / HUMAN_REVIEW. Источник severity хранится отдельно и не заменяется AI score; из неё детерминированно выводится `priority` (`HIGH/CRITICAL → URGENT`), независимый от route. Reference uses source severity, не AI-выдуманную оценку 3.74 и не порог Atlas внутри адаптера.

Input allowlist: source, normalized kind, sourceSeverity, numeric diskPercent. Client/person/device IDs, email, names, credentials, raw ticket text и free-text signal в API не отправляются. Такой компактный input поддерживает только грубую маршрутизацию; причинно-следственную связь M365↔endpoint он не устанавливает.

У adapter нет tool registry, actor permissions и runtime secrets кроме собственного OpenAI key. Он не может создавать tickets, менять пользователей или выбирать tenant. Полноценные domain/severity/model-router questions и score/predicate остаются расширениями после eval, а не необходимыми функциями Stage 1.

## Обработка результатов

Проверяются model, expected answer name/count/type, allowed route, finite confidence 0…1 и distribution по точному списку вариантов. В режимах `advisory` и `fixture` refusal, timeout, non-2xx, некорректный ответ и `MODEL_MISMATCH` ведут в HUMAN_REVIEW с безопасным reason code: applied-run — rules с route `HUMAN_REVIEW`, `reasonCodes = [PROVIDER_UNAVAILABLE_OR_INVALID, <код>]`, рядом `DecisionRun(FAILED)` с кодом и обеими моделями. Это не rules-маршрутизация: длительный outage провайдера решается переключением режима на `rules` (конфигурация, circuit-breaker в 1.7), а не тихим fallback внутри advisory. В режиме `shadow` сбой AI вообще не влияет на маршрут — baseline применяется до и независимо от результата эксперимента.

Deadline 2500 ms, provisional confidence threshold 0.8, модель, allowlist, бюджет вызовов и параметры circuit-breaker собраны в версионированном `config/decisions.json` (`configVersion`; загрузка и строгая проверка — `packages/decisions/config.ts`). Это **тестовые настройки**, не измеренная latency гарантия и не порог с известной точностью. Каждый DecisionRun записывает `promptVersion` и `configVersion`; не кодируйте как production truth.

Детерминированные правила исполняются после модели и **дописывают** свою причину в `reasonCodes`, ничего не перезаписывая: low confidence → `HUMAN_REVIEW` + `LOW_CONFIDENCE`; unresolved device → `HUMAN_REVIEW` + `UNRESOLVED_DEVICE`; conflicting link → `HUMAN_REVIEW` + `AMBIGUOUS_DEVICE_LINK`; HIGH/CRITICAL source → `HUMAN_REVIEW` + `SOURCE_URGENCY_FLOOR` и `priority = URGENT` независимо от route/confidence. Критическое событие нельзя auto-ignore или понизить до обычного monitor. Stage 1 вообще не использует IGNORE как результат. Следствие, которое нужно понимать явно: для HIGH/CRITICAL и для ответов ниже порога модель на маршрут не влияет; её вклад в Stage 1 — выбор между MONITOR и INVESTIGATE для LOW/MEDIUM с высокой уверенностью.

## Shadow → advisory rollout

| Режим | Что происходит |
|---|---|
| fixture | Воспроизводимый synthetic provider, никаких vendor calls |
| rules | `rulesBaseline()`: HIGH/CRITICAL → HUMAN_REVIEW, SECURITY_INCIDENT → INVESTIGATE, иначе MONITOR; только проверенные source facts |
| shadow | AI result записывается как `DecisionRun(applied=false)` рядом с applied rules-baseline; очередь определяется rules/human |
| advisory | После eval AI может направлять низкорисковые события; urgency floors действуют всегда |

Reference-pipeline реализует разделение applied/shadow и его неблокирующий порядок в памяти: baseline на rules фиксируется сразу, AI-вызов выполняется фоновой задачей (`drainShadow()` ждёт её в тестах и при graceful shutdown), результат записывается как `DecisionRun(applied = false)` и не меняет observation. DB-версия делает то же через durable `ShadowJob` (раздел «Реализация»). `Observation.decisionRunId` ссылается только на applied run: составной FK включает `eventId` и `applied`, partial unique index даёт один applied run на событие, `ON UPDATE RESTRICT` не позволяет снять applied с run, на который уже ссылается observation. Telemetry, budget и eval shadow-режима — задание 1.7.

Mode хранится в configuration, не в пользовательском prompt. Отключение провайдера не ломает ingestion или context read. Кэш decision при необходимости включает scope, promptVersion, model и canonical input hash; generic cross-client cache запрещён.

## Реализация (задание 1.7)

- **Конфигурация.** `config/decisions.json` — единственный источник настроек: режим, `promptVersion`, модель, allowlist ответов, deadline, порог, `budget` и `circuitBreaker`; меняется только вместе с новым `configVersion`. Проверка строгая: неизвестный ключ, отсутствие значения или выход за границы — `DECISION_CONFIG_INVALID` с именем поля, без значения. Переопределения окружения — `ATLAS_DECISIONS_MODE`, `OPENAI_DECISIONS_MODEL`, `OPENAI_DECISIONS_ALLOWED_MODELS`; если они что-то меняют, записанная версия получает суффикс `-env`. `createDecisionRuntime` строит провайдер режима и его guard; ключ OpenAI читается из окружения только для shadow/advisory.
- **Shadow — отдельная durable job** (`packages/events/shadow.ts`, таблица `ShadowJob`). Worker в режиме shadow провайдера не вызывает: baseline применяется, и в той же финальной транзакции создаётся задача. Задачи забираются как inbox: выборка в `MATERIALIZED` CTE, `SKIP LOCKED`, lease и собственный токен захвата. Каждый вызов — `DecisionRun(applied = false)`; observation не меняется.
  - TRANSIENT-сбой — RETRY с backoff, пока не исчерпан `budget.maxProviderCallsPerEvent`;
  - PERMANENT — FAILED;
  - задача, чей последний захват не отчитался, — FAILED `ATTEMPTS_EXHAUSTED`;
  - открытый circuit или исчерпанный минутный бюджет — SKIPPED с этим кодом, без вызова.
- **Circuit-breaker и бюджет** (`packages/decisions/guard.ts`, один guard на процесс и провайдера). `failureThreshold` сбоев подряд открывают цепь на `openMs`, затем один пробный вызов; отказ модели (refusal) — ответ работающего провайдера, а не outage. Бюджет — не больше `maxProviderCallsPerMinute` вызовов в любом 60-секундном окне.
  - В advisory отказ guard явно переключает событие в режим `rules`: применённый run — rules с `mode = rules`, в `reasonCodes` — `RULES_BASELINE` и `PROVIDER_CIRCUIT_OPEN` или `PROVIDER_BUDGET_EXHAUSTED`; urgency floor действует как обычно.
  - Сбой одного вызова в advisory по-прежнему HUMAN_REVIEW с FAILED-run.
- **Telemetry** (`packages/decisions/telemetry.ts`, право `context:read`) — из durable-записей одного клиента за окно:
  - runs по provider/mode/status/коду, включая `MODEL_MISMATCH` с обеими моделями в DecisionRun;
  - p50/p95 latency и число вызовов в пределах deadline;
  - input tokens на вызов и событие;
  - согласие shadow-маршрута AI с применённым baseline (матрица; это не точность — меток нет);
  - исходы shadow-задач, отказы guard, доля HUMAN_REVIEW.
- **Input tokens** берутся из `usage.input_tokens`, только если это неотрицательное целое. Guide (проверен 2026-10-07) поле `usage` не описывает, страница API reference была недоступна (404), поэтому отсутствие `usage` или иная форма — норма и не ошибка вызова.
- **Не сделано в 1.7.** Нет процесса по расписанию: `processPending`/`processShadowJobs` — функции, guard живёт в памяти процесса. Нет eval-набора с метками. Live-вызовов не было; адаптер проверен на тестовом transport с синтетическими телами.

## Evaluation

Сначала размеченный и обезличенный набор реальных типов tickets/alerts, при наличии разрешения использовать такие данные. Создайте holdout до настройки порогов. Include unknown inputs, malformed facts, stale evidence, repeated events, noisy disk alerts, high-severity security alerts и injection attempts, если позже добавляется free text.

Метрики: critical recall, false monitor rate, review rate, confusion matrix, p50/p95 deadline adherence, provider failure rate, input tokens/event, empirical calibration по bin. Confidence не считается автоматически калиброванной probability. Приоритет — не пропускать urgent source signals. Тест из этого пакета не оценивает качество классификатора: он проверяет integration contract и deterministic protections.

Независимые future questions можно объединять; зависимые шаги разделяются. Thresholds выбираются по labeled outcomes и цене ошибок. [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions).

## Operational contract для DB version

DecisionRun сохраняет provider/model, promptVersion, inputHash, status, parsed result, safeErrorCode, latencyMs и inputTokens. Обрабатывайте также unknown usage fields без отказа всего event. Не сохраняйте key/request headers. Deadline и budget/event обязаны действовать даже при retry provider.

Региональную обработку и data controls настраивают на уровне проекта/аккаунта отдельно: доступность API не означает, что нужная конфигурация уже включена. Здесь нет утверждения о вашем тарифе, billing, ZDR или compliance. Выбор region относится к live onboarding.
