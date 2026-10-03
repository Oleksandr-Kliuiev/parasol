# Передача работы

Дата состояния: 03.10.2026.

Текущая задача реализации: **DEV-15** (следующая по execution_order). Завершено локально: DEV-00 (code_verified).

## Ветки и коммиты

- `main` — baseline `2bed19e5520ac4061cbf1ad2e680a8a2b6e79320`: рабочая копия на дату аудита плюс этот пакет (670 файлов явного списка, см. [evidence/DEV-00.md](evidence/DEV-00.md)).
- `codex/readiness` — рабочая ветка доработок от `2bed19e`. Коммит DEV-00: «DEV-00: baseline regressions for A01–A03 and fresh baseline checks» (SHA — `git log codex/readiness`). Push не выполнялся, remote отсутствует.
- Оставлены вне Git на диске без изменений: `.claude/launch.json`, `docs/claude-opus-development-pack-2026-10-03.zip` и распакованная копия `docs/claude-opus-development-pack-2026-10-03/` (их SHA-256 в manifest DEV-00). Если копия появилась случайно при открытии архива, удалить её может только владелец.

## Выполнено

- **DEV-00** — baseline-коммит, сверка 597/597 со снимком аудита, проверка секретов, сборка чистой копии коммита, новые базовые прогоны, регрессии A01/A02/A03 (домен и API), агрегатная инвентаризация локальных баз. Статус code_verified; accepted оставлено владельцу/независимому review.

## Известные красные проверки (не маскировать)

- unit `Crm.UnitTests.BillingRegressionTests`: A01 ×2 (→ DEV-01), A02 ×3 (→ DEV-02);
- integration `Crm.IntegrationTests.BillingRegressionApiTests`: A01 (→ DEV-01), A02 ×3 (→ DEV-02), A03 (→ DEV-03);
- E2E `web/e2e/billing.spec.ts:12` — гонка `freeBillingPeriod`, BIL_PERIOD_BUSY (→ DEV-15);
- нестабильно: `CrmWebFactory.DisposeAsync` → `NullReferenceException` в `WebApplicationFactory.DisposeAsync` (1 из 4 прогонов) (→ DEV-15).

Фактические базовые результаты на `2bed19e` (03.10.2026 21:30–21:45 UTC): build 0/0; unit 252/252; architecture 54/54; integration 80/80; lint, typecheck ok; vitest 29/29; bundle 282.7 KB; E2E 37/38. С регрессиями: unit 252 + 5 red, integration 80 + 5 red.

## Следующий конкретный шаг

DEV-15: атомарное выделение периода/изоляция данных E2E без ретраев, автоматическое обнаружение модулей в архитектурных тестах (Projects и CustomFields сейчас не охвачены), сбор покрытия под Microsoft Testing Platform с порогами NFR-10 в CI, браузерная матрица, разбор нестабильного teardown fixture. Затем DEV-01 → DEV-02 → DEV-03.

## Открытые решения и блокеры

Внешние решения DEC-01…10 и gates EXT-01…11 не подтверждены. DEV-00 не требует внешних gates.

## Временные ресурсы

Нет активных. Контейнер `crm-e2e-dev00-20261003` и временный worktree удалены. Чужие контейнеры (crm-postgres, crm-redis, vaultwarden, atera-ops-bot-*, for-release-postgres) не затрагивались; `vardahei-crm-sql` использовался только для агрегатных SELECT.

## Шаблон записи после сессии

Заменять разделы выше актуальной записью без потери незавершённого контекста:

- Дата и задача; commit/manifest; изменения других авторов, которые сохранены.
- Что реализовано и что ещё не реализовано, с точными файлами/методами.
- Какие проверки выполнены: команда, результат, evidence path; какие не выполнены и почему.
- Новые решения и блокеры: владелец/EXT/нужная информация, без секретов.
- Созданные временные ресурсы и их состояние; не удалять чужие ресурсы.
- Следующий воспроизводимый шаг и условия завершения карточки.
