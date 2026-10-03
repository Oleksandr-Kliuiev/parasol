# DEV-07 Доставка событий и безопасный повтор

Приоритет: **P1**. Аудит: **A07**.

Зависимости реализации: DEV-00. Проверки: Q1, Q2, Q3.

Внешняя приёмка: не требуется отдельный внешний gate; нужны фактические локальные доказательства.

## Контекст

После 10 ошибок outbox перестаёт выбирать сообщение. Lease не гарантирует единственного исполнителя при долгой обработке. Повтор внешнего эффекта не контролируется одним локальным флагом.

## Результат

События не теряются операционно; повторная доставка и частичное выполнение не размножают бизнес-эффекты.

## Прочитать перед изменением

- [src/BuildingBlocks/Crm.Infrastructure/Outbox/OutboxProcessor.cs](../../../src/BuildingBlocks/Crm.Infrastructure/Outbox/OutboxProcessor.cs)
- [src/BuildingBlocks/Crm.Infrastructure/Persistence/OutboxMessage.cs](../../../src/BuildingBlocks/Crm.Infrastructure/Persistence/OutboxMessage.cs)
- [src/BuildingBlocks/Crm.Infrastructure/Persistence/AuditingInterceptor.cs](../../../src/BuildingBlocks/Crm.Infrastructure/Persistence/AuditingInterceptor.cs)
- [src/Integrations/Crm.Integrations.Core/Outbound.cs](../../../src/Integrations/Crm.Integrations.Core/Outbound.cs)
- [src/Modules/Contracts/Crm.Contracts/Features/QuoteAcceptedHandler.cs](../../../src/Modules/Contracts/Crm.Contracts/Features/QuoteAcceptedHandler.cs)
- [src/Hosts/Crm.Worker/Program.cs](../../../src/Hosts/Crm.Worker/Program.cs)
- [web/src/features/admin/IntegrationsPage.tsx](../../../web/src/features/admin/IntegrationsPage.tsx)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Ввести явные pending/processing/retry/dead-letter/processed состояния или равноценную модель, next-attempt с backoff/jitter и диагностируемую последнюю ошибку.
2. Добавить owner token/fencing для lease и compare-and-set при завершении; старый worker не должен снимать новую чужую аренду. Долгие обработчики продлевают lease либо прерываются безопасно.
3. Ввести consumer inbox или уникальные бизнес-ключи для каждого подписчика. Учесть несколько handlers одного события: успех первого не должен повторять его эффект, если второй упал.
4. Ограничить атомарность границей одного модуля; локальная запись + consumer receipt фиксируются вместе. Внешняя отправка использует provider idempotency/reconciliation, а не обещание exactly-once.
5. Добавить защищённые список, диагностику и replay доменного outbox; повтор запускается по неизменённому payload, фиксирует оператора и причину. Не давать произвольный Type/JSON для исполнения.
6. Проверить совместимость версий payload между старыми/новыми образами; неизвестный тип безопасно карантинировать. Добавить метрики для DEV-17 и retention только успешно обработанных записей по политике.

## Критерии приёмки

- **DEV-07-AC01** — Ошибка после десятой попытки видна в dead-letter и доступна безопасному replay после исправления причины.
- **DEV-07-AC02** — Два worker и истёкший lease не создают два контракта/начисления/списания часов.
- **DEV-07-AC03** — После успеха handler A и падения B повтор не воспроизводит эффект A; B завершается.
- **DEV-07-AC04** — Остановка после бизнес-коммита до ack приводит к доставке без второго эффекта.
- **DEV-07-AC05** — Старый исполнитель не может пометить успешным или разблокировать сообщение, арендованное новым.
- **DEV-07-AC06** — Пауза интеграции сохраняет очередь; массовый replay ограничен, авторизован, подтверждён UI и аудируется.
- **DEV-07-AC07** — Повреждённый payload не блокирует остальные сообщения и не раскрывает персональные данные в общих логах.

## Данные и обратимость

Миграции всех module outbox должны быть согласованы с registry и очередностью. Старые строки с Attempts>=10 перенести в явный dead-letter без автоматического массового повтора. Consumer receipts сохраняются дольше окна возможного replay.

## Границы

Не вводить Kafka/Service Bus как обязательную замену; сохранять существующую архитектуру.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-07.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
