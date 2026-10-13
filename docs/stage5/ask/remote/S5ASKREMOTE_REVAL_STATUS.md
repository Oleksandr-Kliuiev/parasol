# ASK-REMOTE R-EVAL — текущая приёмка подготовки

Текущий пакет **S5ASKREMOTE-REVAL-PREP-rc6**.
Hash:`66dcc033c71f5836e8904b289c0aeb493b5de96264098f884eded931e01b6fa7`.
**REQUIRED SOL/OPUS PREPARATION APPROVED.** Данные/бюджет NOT_ADMITTED, платных продуктовых вызовов0.

| Обязательное независимое ревью одного текущего пакета | Итог |
|---|---|
| GPT-6.1 Sol / xhigh | APPROVE_PREPARATION, required findings0 |
| Native Claude Opus5.5 / xhigh | APPROVE_PREPARATION, required findings0; actual response model verified |

Оба начали RC5 в НОВЫХ ЧИСТЫХ независимых сессиях: Sol fork_turns:none, Opus новый UUID без resume.
История автора/implementer и verdict другого reviewer не передавались. Уточнение RC6 закрыто bounded
re-review в этих же независимых сессиях на xhigh, согласно workflow. Все18 hashes проверены обоими;
Sol дополнительно сравнил1555 accepted source/build entries — только2 объявленных administrative deltas.

[Sol report](../../reviews/SOL_S5ASKREMOTE_REVAL_RC6.md),
[Opus report](../../reviews/OPUS_S5ASKREMOTE_REVAL_RC6.md).
[План](S5ASKREMOTE_REVAL_PLAN.md), [лист допусков](S5ASKREMOTE_REVAL_ADMISSION.md).
Receipts/assignment/model evidence: verification/stage5/S5ASKREMOTE_REVAL_PREPARATION_STATUS.json.
Immutable manifest сохраняет dispatch-time pending snapshot; актуальные verdicts — в status receipt.

Astra — дополнительное историческое ревью, не обязательная приёмка этого checkpoint.
**Fable не требуется и не является блокером.** R-EVAL — проверка внутри уже принятой ASK-REMOTE
architecture, не новая/материально изменённая architecture. Ошибочная классификация RC4 исправлена
по уточнению владельца2026-10-11; исторические свидетельства сохранены без переписывания approvals.

Opus native Max, extraUsage=false, no API/credits/fast/fallback; actual response model claude-opus-5-5
подтверждён message stream, effortxhigh зафиксирован invocation. Sol explicit native assignment;
backend telemetry/attributable usage недоступны. Точный subscription quota расход неизвестен.
Новых runtime/normative/architecture изменений нет; broad runtime tests и live eval не запускались.

До запуска нужны отдельные frozen dataset/rubric/labels и принятый execution artifact/rehearsal,
EU/project/key/retention/currentprice proof и явное owner data/budget approval. Actual live evidence
после200 случаев требует новой независимой Sol/Opus приёмки. Подготовка не разрешает provisioning,
activation, inference, interactive use или deployment.

Residuals для execution artifact: full replay невозможен только по bool без transient answer/observed
enum; определить проверяемость comparator/projections без persistence provider content. Уточнить полный
latency/censoring расчёт, pacing с capability preflight/ASK_BUSY, blocking text mismatch, labels adjudication,
voluntary pause и feasibility reference. Любой UNAVAILABLE останавливает run консервативно, даже429/5xx;
generic transport CASE_FAIL не переопределяет специальное terminal правило. Неожиданная inactive
preflight блокирует submission и ведёт к существующему terminal incomplete loss-of-authority stop.

Administrative role-policy clarification2026-10-11: root AGENTS.md and the current workflow now
explicitly separate Astra/Fable architecture development/agreement from clean Sol/Opus acceptance,
including priority over legacy nested assignments. Exact before/after hashes and prior bytes:
verification/ROLE_POLICY_20261011_ADMIN_DELTA.json and its before archive. The accepted RC6 snapshot,
review reports and normative package are unchanged; current workflow has this declared administrative delta.
