# ASK-REMOTE R-EVAL — лист допусков RC6

2026-10-11. Все поля ниже PENDING, пока владелец не подтвердит конкретное значение и evidence reference.
Решение сейчас: NOT_ADMITTED. Этот файл не является approval и не активирует RemoteAskPolicy.
Не записывать ключи, токены, env, реальные вопросы или персональные данные.

| Допуск | Что зафиксировать до платного вызова | Статус |
|---|---|---|
| Artifact | commit, dirty/source/build inventory, accepted dependency seals/closure, review manifest hashes | PENDING |
| Dataset | 200 уникальных synthetic RU/EN, dual-adjudicated refusal labels/rubric, all200 holdout; hashes до admission | PENDING |
| Offline readiness | Принятый runner/ручная процедура, rehearsal receipt, no retry, stop/resume, numeric-only evidence | PENDING |
| Provider identity | Точный gpt-6-luna, ask-remote-openai-luna-v1, prompt/schema hashes; без fallback/alias | PENDING |
| EU account/project | Dedicated EU account/project identity и project-level EU evidence; global-project keys запрещены, hostname недостаточен | PENDING |
| Retention | Owner-verified ZDR/MAM-class eligibility/configuration refs для проекта и нужного endpoint; store=false недостаточен | PENDING |
| Key | Только secret reference/dedicated EU project; no global keys, subscription/Codex/Claude login reuse или hidden API credits; provisioning отдельно | PENDING |
| Data scope | SYNTHETIC workspace/client/actor allowlist без wildcard, trusted operator и зарегистрированная synthetic DB | PENDING |
| Permissions | context:read + ask:remote в одной membership; owner provisioning, policy/admission/fence revision tuple | PENDING |
| Privacy | Внешне уходит только original synthetic question + hasFocus; bank/refs/IDs локальны; body APM/log/trace off | PENDING |
| Egress | Только direct TLS443 eu.api.openai.com, no proxy/redirect/retry; platform allowlist evidence | PENDING |
| Price contract | Документальный priceRevision/rates/window evidence + срок действия; без billable discovery probe | PENDING |
| Validity | start/expiry UTC ≤7days в одном UTC month; exact policyVersion/admissionId, no automatic extension | PENDING |
| Budget | reserve=$0.30; $0.30≤DAY≤$2, DAY≤MONTH≤$10; opening liabilities, available и полный remainingMONTH owner ceiling | PENDING |
| Calls | ≤200 initial, 1/case; явный отдельный allowance для manual reruns (по умолчанию 0) | PENDING |
| Stop/resume | Единственный оператор, consumed-case rule, stop-on-certain-failure=true, same fixture/time-invariant expectations; fence-first pause каждого interval/terminal | PENDING |
| Owner decision | Явное approval текущего artifact + данных + платного бюджета, evidence ref и дата; checkbox недостаточен | PENDING |
| Independent gates | Свежие чистые Sol6.1/Opus5.5 xhigh для текущего плана; отдельно dataset/procedure/rehearsal и actual changes/eval evidence; один hash | PENDING |

Бюджет ревью отдельно от продукта: только включённая подписка, API/credits/fast/fallback запрещены.
Fable не является required reviewer этого R-EVAL checkpoint; его billing не блокирует пакет.
Opus запуск допустим только после read-only auth/extraUsage/provider preflight; quota unknown не считать 0.
Если subscription limit блокирует роль, остановить её, не включать оплату автоматически.

Владелец одобряет заполненный лист и точный package hash отдельным решением после подготовки/ревью.
Утверждение плана не означает допуск реальных данных, interactive synthetic use или deployment.

Current owner policy supersession: docs/DEVELOPMENT_WORKFLOW.md section Current role policy—2026-10-11,
exact hash в manifest. Она назначает Sol/Opus для нового checkpoint вместо исторического Astra-only
05_ACCEPTANCE.md; исторический normative artifact неизменён. Уточнение владельца2026-10-11:
required независимое ревью плана — Sol6.1/xhigh и Opus5.5/xhigh в чистых сессиях. Это не новый
architecture stage; Astra/Fable gate не переоткрывается, Fable здесь не блокер. При материальном
изменении architecture её собственный gate остаётся обязательным.
Продукт не использует development subscriptions: только отдельно owner-admitted dedicated API project;
никакого hidden credit enablement или billable discovery. Это будущий допуск, сейчас NOT_ADMITTED.
Evidence hooks/supervisor и privacy-classification/rehearsal должны иметь собственную Sol/Opus приёмку;
простая ручная запись без in-memory equality и predicate checks не удовлетворяет readiness.
