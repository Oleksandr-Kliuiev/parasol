# DEV-12 Полные списки и корректные финансовые итоги

Приоритет: **P2**. Аудит: **A11, A16**.

Зависимости реализации: DEV-00. Проверки: Q1, Q2, Q3.

Внешняя приёмка: не требуется отдельный внешний gate; нужны фактические локальные доказательства.

## Контекст

Задолженность считается после Take; часть списков молча обрезается по 100/200/300/500.

## Результат

Итоги относятся ко всему разрешённому фильтру, а каждую подходящую запись можно получить через страницы.

## Прочитать перед изменением

- [src/Modules/Billing/Crm.Billing/Features/BillingService.cs](../../../src/Modules/Billing/Crm.Billing/Features/BillingService.cs)
- [src/Modules/Billing/Crm.Billing/Features/BillingFeatures.cs](../../../src/Modules/Billing/Crm.Billing/Features/BillingFeatures.cs)
- [web/src/features/billing/InvoicesPage.tsx](../../../web/src/features/billing/InvoicesPage.tsx)
- [web/src/features/billing/api.ts](../../../web/src/features/billing/api.ts)
- [src/Modules/Sales/Crm.Sales/Features/QuoteService.cs](../../../src/Modules/Sales/Crm.Sales/Features/QuoteService.cs)
- [src/Modules/Projects/Crm.Projects/Features/ProjectFeatures.cs](../../../src/Modules/Projects/Crm.Projects/Features/ProjectFeatures.cs)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Разделить list page и aggregates/count по одному filter/scope контракту. Итоги вычислять в SQL до ограничений страницы.
2. Использовать устойчивую сортировку с уникальным tie-breaker и cursor, либо обоснованную pagination-модель; выдавать nextCursor/hasMore и ясный totalCount.
3. Проверить todos фиксированных Take во всех пользовательских списках. Для намеренных top-N виджетов явно подписать ограничение; не делать full table response.
4. Обновить frontend types/query keys, фильтры, состояния загрузки, empty/error и явную подпись области итогов. Не сохранять финансовые данные в общий cache между пользователями.
5. Сохранить [SensitiveData] и record scope: aggregate также не должен раскрывать чужие деньги.
6. Обновить API contracts и совместимость consumers, включая BI и экспорт; указать период/дату среза для финансовых показателей.

## Критерии приёмки

- **DEV-12-AC01** — На 501+ счетах общий долг включает все подходящие записи, даже при page size 25/100.
- **DEV-12-AC02** — Все страницы вместе возвращают каждый id ровно один раз при стабильном наборе; одинаковые даты и номера не ломают cursor.
- **DEV-12-AC03** — Смена фильтра изменяет totals и list согласованно; пользователь видит общий count и остаток страниц.
- **DEV-12-AC04** — Finance-hidden роль не получает суммы через totals, sort metadata или export.
- **DEV-12-AC05** — Проекты/предложения за пределами прежнего Take доступны; top-N widgets обозначены.
- **DEV-12-AC06** — UI обрабатывает добавление/изменение данных между запросами без ложного обещания строгого snapshot.

## Данные и обратимость

Предпочтительно расширение response без потери старых полей на переходе, затем обновление всех repo consumers. Новые индексы по реальным predicates и сортировке; проверить планы и нагрузку.

## Границы

Не заменять ошибочный Take неограниченным ToList и не суммировать деньги на frontend.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-12.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
