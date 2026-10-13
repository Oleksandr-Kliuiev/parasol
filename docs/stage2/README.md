# Stage 2 Development Pack — M365 Correlation

Подготовлен 2026-10-08. Версия и SHA-256: [REVIEW_MANIFEST.json](REVIEW_MANIFEST.json).
Статус ревью: [REVIEW_STATUS.md](REVIEW_STATUS.md). Это спецификация; Stage 2 ещё не реализована.

Цель: добавить к Huntress incident проверяемую цепочку устройства/человека/M365 identity и
доступные sign-in evidence, сохраняя отдельные признаки неизвестного, свежести и полноты.
Архитектуру Atlas не начинаем заново. [Roadmap](../ROADMAP.md) согласует прежние направления с фактической Stage 1.

| Задача | Читать |
|---|---|
| Scope, сценарий, решения | [01_SPEC.md](01_SPEC.md) |
| DTO, schema, permissions, correlation | [02_CONTRACTS.md](02_CONTRACTS.md) |
| Microsoft Graph, auth, sync, recovery | [03_CONNECTOR_SYNC.md](03_CONNECTOR_SYNC.md) |
| Порядок реализации и checkpoints | [04_IMPLEMENTATION_PLAN.md](04_IMPLEMENTATION_PLAN.md) |
| Проверки и live acceptance | [05_ACCEPTANCE.md](05_ACCEPTANCE.md) |
| Проверенные источники и допущения | [06_SOURCES_AND_ADR.md](06_SOURCES_AND_ADR.md) |
| Независимое ревью пакета | [REVIEW_STAGE_2.md](../../prompts/REVIEW_STAGE_2.md) |
| Будущая реализация | [IMPLEMENT_STAGE_2.md](../../prompts/IMPLEMENT_STAGE_2.md) |

## Gates

- S2-ARCH: Fable 5.1 и Astra независимо одобряют один и тот же hash пакета.
- S2-A: scoped schema/auth/contracts и совместимость Stage 1.
- S2-B: Graph adapters, durable sync и recovery на mock/recorded данных + PostgreSQL.
- S2-C: correlation, read API/tools, CLI и E2E; инженерная приёмка.
- S2-LIVE: фактическая проверка tenant/permissions/data; самостоятельный статус, не подмена S2-C.

Решение APPROVE по S2-ARCH разрешает следующий инженерный checkpoint, а не все будущие stages.
Нет записей во внешние системы, UI, AI-input fields или deployment в этом пакете; `m365-disable` меняет только локальное состояние Atlas.

Первый срез обновляет directory и sign-in окна операторскими pass-ами, без фонового scheduler.
Directory ограничен 20 000 строками/40 страницами на ресурс; превышение лимита не публикует обрезанный результат.
Сохранённая активная directory generation после 60 минут помечается STALE и остаётся пригодной для существующих
подтверждённых связей до 24 часов; затем identity DTO скрываются, а соответствующее разрешение становится UNRESOLVED.
