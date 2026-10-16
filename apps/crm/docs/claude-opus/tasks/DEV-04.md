# DEV-04 Неизменяемость аудита и минимальные права приложения

Приоритет: **P1**. Аудит: **A04**.

Зависимости реализации: DEV-03. Проверки: Q1, Q2, Q4.

Внешняя приёмка: EXT-07.

## Контекст

Общая identity web/worker получает db_datawriter; audit и утверждённые финансовые данные не имеют заявленной защиты БД.

## Результат

Обычные identities не изменяют историю аудита и финансовый снимок; фоновые статусы и штатная работа остаются доступны.

## Прочитать перед изменением

- [src/Hosts/Crm.Web/Http/DatabaseMigrator.cs](../../../src/Hosts/Crm.Web/Http/DatabaseMigrator.cs)
- [src/BuildingBlocks/Crm.Infrastructure/Persistence/AuditingInterceptor.cs](../../../src/BuildingBlocks/Crm.Infrastructure/Persistence/AuditingInterceptor.cs)
- [src/Modules/Audit/Crm.Audit/Persistence/AuditDbContext.cs](../../../src/Modules/Audit/Crm.Audit/Persistence/AuditDbContext.cs)
- [src/Modules/Billing/Crm.Billing/Persistence/BillingDbContext.cs](../../../src/Modules/Billing/Crm.Billing/Persistence/BillingDbContext.cs)
- [infra/modules/identities.bicep](../../../infra/modules/identities.bicep)
- [infra/modules/data.bicep](../../../infra/modules/data.bicep)
- [infra/modules/apps.bicep](../../../infra/modules/apps.bicep)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Составить таблицу разрешений web, worker, migrator и privacy-retention operator. Отказаться от db_datawriter в пользу явных минимальных grants; отделить identities web и worker, если привилегии различаются.
2. Запретить обычным runtime identities UPDATE/DELETE аудита. Сохранять INSERT в одной транзакции с бизнес-данными.
3. Защитить утверждённые суммы, строки и происхождение в SQL; разрешить отдельный транспортный статус, попытки отправки и подтверждённые внешние номера без разблокировки суммы. Проверить прямое изменение дочерней строки и cascade delete.
4. Согласовать стратегию аудита с GDPR: неизменяемый факт действия отделяется от персонального payload, к которому применима политика. Не выдавать worker общее право удалять аудит ради retention.
5. Обновить grants для существующих и добавляемых этой задачей таблиц, миграционный bootstrap, runbook и тестовый provisioning пользователей SQL. Описать обязательное подключение будущих inbox/privacy таблиц к тем же ограничениям в DEV-07/11.
6. Предусмотреть независимое хранение/контроль целостности событий с периодической проверкой; hash без внешнего якоря не называть защитой от владельца БД.

## Критерии приёмки

- **DEV-04-AC01** — Под реальной runtime SQL-ролью INSERT аудита успешен, UPDATE/DELETE и DDL отклоняются.
- **DEV-04-AC02** — Попытки менять approved lines напрямую через SQL отклоняются; фиксация Exported и номера заказа работает.
- **DEV-04-AC03** — Триггеры/защита совместимы с EF OUTPUT и SaveChanges; нет подавления concurrency checks.
- **DEV-04-AC04** — Аудит и бизнес-запись либо оба сохранены, либо оба отменены.
- **DEV-04-AC05** — Секреты поставщиков, доступные только worker, недоступны web там, где web не выполняет соответствующую операцию.
- **DEV-04-AC06** — Есть отдельный тест привилегированной процедуры retention, не обходящей сохранение обязательных финансовых доказательств.

## Данные и обратимость

Миграции добавлять отдельно от предыдущих исторических. Сначала создать и проверить роли, затем переключать identities и снимать широкие grants. Для SQL-триггеров проверить EF mappings. Откат приложения не должен автоматически возвращать широкие права.

## Границы

Не заявлять абсолютную неизменяемость против администратора SQL; итоговый security review учитывает угрозу привилегированного доступа.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-04.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
