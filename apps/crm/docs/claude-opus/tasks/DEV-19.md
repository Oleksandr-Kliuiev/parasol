# DEV-19 Реальные интеграции и сверка внешних эффектов

Приоритет: **P1**. Аудит: **дополнительное направление целевого решения**.

Зависимости реализации: DEV-03, DEV-07, DEV-08, DEV-10, DEV-17. Проверки: Q1, Q2, Q7.

Внешняя приёмка: EXT-02, EXT-03.

## Контекст

Автотесты работают с заглушками. Нужны проверка реальных договорённостей API, разрешений и поведения при неопределённом результате запроса.

## Результат

Интеграции подтверждены разрешёнными тестовыми сценариями, а неопределённый ответ не вызывает дубль или потерю денег.

## Прочитать перед изменением

- [src/Integrations/Crm.Integrations.PowerOffice/PowerOfficeModule.cs](../../../src/Integrations/Crm.Integrations.PowerOffice/PowerOfficeModule.cs)
- [src/Integrations/Crm.Integrations.PowerOffice/PowerOfficeBilling.cs](../../../src/Integrations/Crm.Integrations.PowerOffice/PowerOfficeBilling.cs)
- [src/Integrations/Crm.Integrations.Atera/AteraModule.cs](../../../src/Integrations/Crm.Integrations.Atera/AteraModule.cs)
- [src/Integrations/Crm.Integrations.PartnerCenter/PartnerCenterModule.cs](../../../src/Integrations/Crm.Integrations.PartnerCenter/PartnerCenterModule.cs)
- [src/Integrations/Crm.Integrations.MicrosoftGraph/MicrosoftGraphModule.cs](../../../src/Integrations/Crm.Integrations.MicrosoftGraph/MicrosoftGraphModule.cs)
- [docs/05-integrations.md](../../05-integrations.md)
- [docs/runbooks/02-integrations.md](../../runbooks/02-integrations.md)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Сверить endpoints, версии, scopes, методы, pagination, rate limits и форматы с актуальной официальной документацией каждого provider при реализации; даты проверки записать.
2. Проверить создание/поиск заказа по внешнему reference. Не считать любой 503 доказательством отсутствия внешнего эффекта; при timeout/неопределённом ответе переходить к reconciliation.
3. Сверять order → invoice → payments/credit/write-off. При отсутствии реального payment ledger показывать факт изменения остатка и происхождение, не выдумывать денежный платёж.
4. Проверить ownership полей CRM vs provider, mapping по настоящим external IDs/product codes, переименование SKU, удаление/merge клиента и ручные изменения во внешней системе.
5. Для количества лицензий/устройств и часов учитывать дату среза, завершённость и свежесть. Оценочные количества отмечаются; правила разрешения биллинга с estimate утверждает Finance.
6. Составить test contract matrix и sanitized fixtures на основе разрешённых sandbox ответов. Локальные tests должны оставаться полностью воспроизводимыми без реальных ключей.
7. Проверить отмену/продление подписки, ограничения direct/indirect CSP и доступ GDAP; недоступный продукт отражать как limitation, не скрывать пустым списком.

## Критерии приёмки

- **DEV-19-AC01** — При потере ответа после реально созданного заказа повтор находит тот же заказ, а не создаёт второй.
- **DEV-19-AC02** — После 429/backoff все разрешённые записи прочитаны; cursor не перескакивает необработанный диапазон.
- **DEV-19-AC03** — Сверка различает оплату, кредитование и списание; реальные возможности API и ограничения приложены.
- **DEV-19-AC04** — CRM обновляет только принадлежащие ей поля и не затирает чужие изменения.
- **DEV-19-AC05** — Устаревшие/неполные количества видны Finance и попадают в список исключений.
- **DEV-19-AC06** — EXT-03 содержит выбранный test tenant/account, сценарии, timestamps и очищенные доказательства; неизвестные credentials не считаются настроенной интеграцией.

## Данные и обратимость

Внешние системы не откатываются SQL rollback. Все тестовые записи маркировать и очищать только в выбранном sandbox по согласованному процессу. WriteEnabled остаётся выключенным до готовности соответствующей среды.

## Границы

Никаких настоящих писем клиентам, заказов или записей RMM без явно выбранной тестовой среды и разрешённого сценария.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-19.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
