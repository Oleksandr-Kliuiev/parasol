# ASK-REMOTE R-EVAL — текущая подготовка

2026-10-11. Текущий пакет: **S5ASKREMOTE-REVAL-PREP-rc4**.
Hash: `fdff112c181dd2a653449afd7590de007d8086a4551705a378f1ed8210f1a6e9`.
**PREPARATION_READY_FOR_REMAINING_REVIEW / NOT_ADMITTED.** Платные продуктовые вызовы:0.

[План](S5ASKREMOTE_REVAL_PLAN.md) и [лист допусков](S5ASKREMOTE_REVAL_ADMISSION.md).
Manifest/checks/archive и точный current status: verification/stage5/S5ASKREMOTE_REVAL_PREPARATION_STATUS.json.
В manifest сохранён initial pending snapshot; актуальные verdicts находятся в status receipt.

| Независимое ревью текущего RC4 | Итог |
|---|---|
| GPT-6 Astra / xhigh | APPROVE_PREPARATION, required findings0 |
| GPT-6.1 Sol / xhigh | APPROVE_PREPARATION, required findings0; supplemental plan review |
| Native Claude Opus5.5 / xhigh | APPROVE_PREPARATION, required findings0; actual response model verified; supplemental plan review |
| Native Claude Fable5.1 / xhigh | PENDING_BILLING_PROOF; не запускался, отдельная оплата не разрешена |

[Отчёт Astra](../../reviews/ASTRA_S5ASKREMOTE_REVAL_RC4.md),
[Sol](../../reviews/SOL_S5ASKREMOTE_REVAL_RC4.md),
[Opus](../../reviews/OPUS_S5ASKREMOTE_REVAL_RC4.md).
Fable нельзя заменить Opus; dual architecture/preparation gate ещё не закрыт.
Astra/Sol launched explicitly native; provider telemetry/usage unavailable. Opus native Max, extraUsage=false,
no API/credits/fast/fallback; requested effortxhigh и фактический response-model сохранены в receipts.
Точная attributable subscription quota неизвестна; API estimates не считаются расходом подписки.

В ходе ревью закрыты evidence/stop/resume/closure/gate/rubric пробелы и две важные ошибки:
успешный ответ может удержать полный резерв; grounded wrong intent не становится ложным claim.
RC1–RC3, исходные findings и transcript/model evidence сохранены отдельно; текущие files rehashed.
Проверены18 current hashes,1555 accepted source/build entries и неизменность10 normative files.
Изменения только в документации/административном routing; runtime suites/live eval не запускались.

До платного запуска остаются: отдельный frozen dataset200, human labels/rubric, принятый execution
artifact и offline rehearsal; EU/project/key/retention/price evidence; отдельное явное owner data/budget
approval текущего пакета. После запуска нужны full200 evidence и fresh Sol/Opus acceptance.
Лимиты предложены, не утверждены: reserve$0.30, DAY≤$2, MONTH≤$10; validity≤7days внутри одного UTC month.
Никаких provisioning, policy activation реального проекта, interactive use или deployment сейчас.

Неблокирующий residual Opus: boolean evidence не воспроизводит полный неправильно классифицированный
ответ без observed enum/answer. Execution artifact должен доказать независимую truth-проверку;
не считать re-derivation ожиданий полным replay и не ослаблять запрет runtime/provider content persistence.
Прочие residuals: mutable model weights, несанитизированный вопрос, необратимый egress, возможный charge
при abort и отсутствие invoice guarantee. Недоступность Fable billing proof сохраняет gate pending.
