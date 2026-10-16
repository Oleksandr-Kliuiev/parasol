# DEV-16 Производительность на целевом объёме

Приоритет: **P2**. Аудит: **A16**.

Зависимости реализации: DEV-03, DEV-07, DEV-12, DEV-15. Проверки: Q1, Q2, Q6.

Внешняя приёмка: EXT-05.

## Контекст

Есть повторное чтение всех подписок внутри цикла по клиентам. Текущий нагрузочный сценарий не подтверждает запись, полный биллинг и пятилетние объёмы.

## Результат

Целевые SLO подтверждены измерениями, а память и число запросов ограничены размером необходимых данных.

## Прочитать перед изменением

- [src/Modules/Billing/Crm.Billing/Features/BillingCollector.cs](../../../src/Modules/Billing/Crm.Billing/Features/BillingCollector.cs)
- [src/Modules/Reports/Crm.Reports/DashboardService.cs](../../../src/Modules/Reports/Crm.Reports/DashboardService.cs)
- [src/Modules/Reports/Crm.Reports/MartService.cs](../../../src/Modules/Reports/Crm.Reports/MartService.cs)
- [src/Modules/Customers/Crm.Customers/Features/Search/CustomerSearchProviders.cs](../../../src/Modules/Customers/Crm.Customers/Features/Search/CustomerSearchProviders.cs)
- [tools/load-test/workday.js](../../../tools/load-test/workday.js)
- [tools/load-test/README.md](../../../tools/load-test/README.md)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Создать детерминированный генератор синтетических 5000 организаций, 50000 контактов, 1 млн тикетов, 1 млн time entries и 10 млн audit entries. Поддержать малый smoke profile и полный профиль.
2. Вынести общие запросы из per-customer loop, группировать один раз; смотреть SQL query count, планы, индексы и allocations. Не применять Task.WhenAll к одному DbContext.
3. Расширить k6 чтением, записью с конкурентностью, поиском, dashboard и async billing для 500 клиентов. Не считать ожидаемый 403 успешным чтением бизнес-данных нужной роли.
4. Отделить скорость CRM от квот реального внешнего API; mock latency/failures реалистичны и отмечены как simulated.
5. Использовать isolated auth harness на тестовой среде без production bypass. Нагрузку на реальный Entra/provider согласовать отдельно.
6. Записать профиль среды, dataset checksum, warmup, длительность, ошибки, percentiles и графики. Проверить, нужна ли оптимизация отчётного read model после измерений.

## Критерии приёмки

- **DEV-16-AC01** — 50 concurrent пользователей: p95 чтения ≤500 мс, записи ≤1 с; поиск ≤1 с при целевых объёмах.
- **DEV-16-AC02** — Биллинг 500 клиентов собирается ≤5 минут; экспорт ≤30 минут либо отклонение подтверждено ограничением provider и отдельно согласовано.
- **DEV-16-AC03** — Первый полезный контент карточки ≤2 с, LCP ≤2.5 с в зафиксированном клиентском профиле; серверный k6 не выдаётся за browser LCP.
- **DEV-16-AC04** — Нет OOM, неограниченных materializations и повторного чтения всего portfolio на каждого клиента.
- **DEV-16-AC05** — Ошибки/таймауты не исключены из percentiles; протокол содержит failed checks.
- **DEV-16-AC06** — Полный прогон в согласованной среде приложен к EXT-05; малый ноутбучный smoke не помечен как целевая нагрузка.

## Данные и обратимость

Индексы вводить по измеренным запросам с оценкой блокировок. Synthetic seed ограничен явной тестовой БД с marker; cleanup проверяет ownership. Rollback индекса не удаляет данные.

## Границы

Не менять поставленные SLO или добавлять микросервисы ради зелёного графика без ADR.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-16.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
