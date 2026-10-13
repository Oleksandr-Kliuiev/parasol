# Atlas — roadmap после Stage 1

Дата: 2026-10-08. Это план развития, а не подтверждение реализации будущих этапов.
Текущие архитектурные вердикты: [Stage 2 review status](stage2/REVIEW_STATUS.md).

## Исходная точка

**Stage 1 — Atlas Foundation: инженерный объём 1.1–1.10 принят.**
Основание: [Checkpoint C, revision 2](../REVIEW_REPORT.md), APPROVE от 2026-10-08, C1–C3 закрыты.
Ревью относится к коду HEAD `916a4d6` с исправлениями `cbb511f`; сам отчёт на момент подготовки roadmap был незакоммичен.
В отчёте: 81/81 unit/PGlite и 114/114 PostgreSQL; здесь проверки приложения заново не заявляются.

В Stage 1 уже есть PostgreSQL/RLS, Client Graph, mapping review, Atera/Huntress read adapters,
durable inbox, observations, Decision Layer, read Gateway, audit и операторский CLI.
Live-read Atera/Huntress/Decisions остаётся отдельным открытым gate. Stage 1 не объявлена production-ready.

## Последовательность поставки

Ниже — единая нумерация **этапов реализации**. Она развивает slices 2–5 из
[Stage 1 spec](01_STAGE_1_SPEC.md#следующие-slices), не переименовывая завершённую Stage 1.
Даты и трудозатраты появятся после декомпозиции и проверки предпосылок каждого этапа.

| Этап | Пользовательский результат | Зависимости и exit gate | Статус |
|---|---|---|---|
| 1. Atlas Foundation | Проверенный клиентский контекст Atera/Huntress, observations и read tools | Checkpoints A/B/C; live отдельно | Engineering accepted; live open |
| 2. M365 Correlation | Инцидент Huntress связан с подтверждёнными M365 identities и доступными событиями входа; неопределённость видна | [Пакет Stage 2](stage2/README.md), два архитектурных ревью, S2-A/B/C, отдельный S2-LIVE | Specification prepared; verdicts in review status |
| 3. First Governed Action | Предпросмотр и создание одного Atera ticket с проверенным результатом | Stage 1; policy + approval + idempotency + execute/verify/audit входят в этот же этап, до первого write | Planned; отдельный пакет и два ревью нужны |
| 4. PowerOffice Context | Ограниченный read-only бизнес-контекст в scope клиента | Foundation; отдельные API/data/privacy contracts и live gate | Planned; отдельный пакет и два ревью нужны |
| 5. Operator UI / Ask Atlas | Очередь → ситуация → доказательства → следующее действие; read-only Ask Atlas | Стабильные API Stage 1/2; модель «ситуации», auth, permissions, UX acceptance | Planned; отдельный пакет и два ревью нужны |
| 6. AI Orchestration / Workflows | Ограниченные многошаговые расследования и проверяемые workflows | Проверенные read tools; для write — все гарантии Stage 3; eval, budget, recovery | Planned; отдельный пакет и два ревью нужны |
| 7. Operational Readiness / Pilot | Работа с реальными клиентами: provisioning, secrets, scheduler, retention, deployment и recovery | Закрытые live gates, dependency audit, backup/restore, monitoring, нагрузка, владелец pilot | Planned; production gate |
| 8. Proactive Operations | Событийные workflows, дедупликация ситуаций, управляемая эскалация | Operational readiness + workflow recovery/verification | Planned |
| 9. Customer Packs | Повторяемая настройка платформы для клиента | Stable permissions, connectors, workflows, onboarding/upgrade isolation | Planned |

Порядок — приоритет поставки, не утверждение, что каждый этап технически зависит от всех предыдущих.
Stage 4 read-only и Stage 5 UI могут разрабатываться после своих прямых зависимостей.
Production-требования нельзя откладывать до Stage 7, если реальный pilot начинается раньше: они становятся gate этого pilot.
Открытый live gate Stage 1 не блокирует подготовку/локальную реализацию Stage 2, но блокирует заявление о проверенной сквозной live-корреляции.

## Соответствие старому roadmap Stage 0–9

Старая таблица из чата «Дорожная карта этапов» описывала направления продукта.
Сохранённые названия ниже имеют префикс **Legacy**, чтобы их не путали с этапами реализации.

| Старое направление | Где теперь реализуется |
|---|---|
| Legacy 0 Foundation; 1 Client Graph | Уже входят в фактическую Stage 1 |
| Legacy 2 Connectors | Atera/Huntress в Stage 1; M365 в Stage 2; PowerOffice в Stage 4 |
| Legacy 3 Command Center; 4 AI Read | Stage 5; read Gateway и Decision Layer уже есть в Stage 1 |
| Legacy 5 Actions; 6 Approval Engine | Совместный первый срез в Stage 3; approval не поставляется после небезопасных действий |
| Legacy 7 Workflows | Stage 6, затем Stage 8 |
| Legacy 8 Events | Ingestion уже в Stage 1; проактивные workflows в Stage 8 |
| Legacy 9 Customer Packs | Stage 9 |

## Архитектура и управление изменениями

Сохраняем PostgreSQL, domain boundaries, scoped repositories/RLS, canonical/external separation,
visible uncertainty, authoritative tool registry, deterministic policy и allowlisted audit.
Decision Layer классифицирует; Orchestrator исследует; Policy проверяет полномочия; Approval подтверждает
конкретный неизменяемый запрос; Gateway исполняет; Verification проверяет результат.
Внешнее действие возможно только после policy и требуемого approval.

Для каждого этапа: спецификация → фиксированный пакет с hash → **независимые Fable 5.1 и Astra** →
исправления и повторное ревью изменённого пакета → реализация по checkpoint → приёмка реализации → live gate при необходимости.
APPROVE спецификации не означает APPROVE кода или реальных интеграций. Отсутствующее ревью имеет статус PENDING/BLOCKED, никогда APPROVED по умолчанию.
Сейчас детализирована только Stage 2; строки 3–9 не являются архитектурными approvals.

## Ближайшая работа

1. Закрыть архитектурные замечания к Stage 2 и получить два вердикта на одну версию.
2. Реализовать задачи 2.1–2.3, предъявить S2-A; далее S2-B и S2-C по пакету.
3. При наличии tenant/credentials и указания владельца пройти Stage 1 live-read и S2-LIVE.
4. Подготовить отдельный пакет Stage 3 до добавления write tools.
