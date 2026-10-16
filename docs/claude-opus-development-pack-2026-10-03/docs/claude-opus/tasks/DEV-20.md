# DEV-20 Пробная миграция и качество клиентских данных

Приоритет: **P1**. Аудит: **дополнительное направление целевого решения**.

Зависимости реализации: DEV-03, DEV-09, DEV-11. Проверки: Q1, Q2, Q3, Q7.

Внешняя приёмка: EXT-01, EXT-09.

## Контекст

Импорт с preview есть, но реальная v1/история, глубина миграции и сверка полноты не подтверждены.

## Результат

Миграция сохраняет источники, владельцев, финансовую историю и выявляет потери до переключения компании.

## Прочитать перед изменением

- [src/Modules/Customers/Crm.Customers/Features/Organizations/MigrationImport.cs](../../../src/Modules/Customers/Crm.Customers/Features/Organizations/MigrationImport.cs)
- [src/Integrations/Crm.Integrations.Core/ExternalImportService.cs](../../../src/Integrations/Crm.Integrations.Core/ExternalImportService.cs)
- [src/Modules/Customers/Crm.Customers/Domain/DuplicateDetector.cs](../../../src/Modules/Customers/Crm.Customers/Domain/DuplicateDetector.cs)
- [web/src/features/admin/MigrationPage.tsx](../../../web/src/features/admin/MigrationPage.tsx)
- [web/e2e/migration.spec.ts](../../../web/e2e/migration.spec.ts)
- [docs/09-assumptions-questions.md](../../09-assumptions-questions.md)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Составить mapping реальных источников в entities/links/owners/statuses/periods; заранее решить какие данные импортируются, архивируются или остаются во внешних системах.
2. Ввести import run manifest: source fingerprint, schema/mapping version, счётчики, суммы, row-level outcomes и repeat key; хранить минимум PII в ошибках.
3. Добавить quality checks: orgnumber, дубликаты, пустые owners, разорванные ссылки, валюты/НДС, неизвестные продукты, контрактные даты, временные зоны и external IDs.
4. Запускать dry-run и повторный реальный импорт на тестовой копии; заполненные вручную CRM поля не затирать. Конфликты идут в ручной разбор.
5. Проверить миграцию финансовых legacy данных с DEV-03 и исторических PDF с DEV-08; происхождение неподтверждённых данных явно обозначено.
6. Подготовить cutover delta, freeze window, сверку count/amounts и план отказа от переключения. Не удалять старую систему до приёмки.

## Критерии приёмки

- **DEV-20-AC01** — Dry-run и реальный импорт показывают согласованные created/updated/unchanged/rejected counts.
- **DEV-20-AC02** — Повтор того же source manifest не дублирует клиентов, ссылки и начисления.
- **DEV-20-AC03** — Все исходные записи имеют результат или объяснённое исключение; суммы сверены по клиентам/периодам/валютам.
- **DEV-20-AC04** — Ошибки середины batch не теряют позицию продолжения и не оставляют необъяснимые частичные связи.
- **DEV-20-AC05** — Импортированные owners соответствуют утверждённым scopes; персональные данные подпадают под политику.
- **DEV-20-AC06** — Finance и Product Owner подтвердили пробную миграцию в EXT-09.

## Данные и обратимость

Рабочую миграцию не выполнять при разработке. Каждая batch имеет marker и plan компенсации, не destructive rollback всей БД. Реальные файлы в Git не добавлять.

## Границы

Не угадывать бизнес-связи по похожим названиям без отчёта и подтверждения.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-20.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
