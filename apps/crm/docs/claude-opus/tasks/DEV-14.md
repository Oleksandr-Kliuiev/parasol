# DEV-14 Рабочая BI-интеграция и определения показателей

Приоритет: **P2**. Аудит: **A13**.

Зависимости реализации: DEV-09, DEV-10, DEV-12. Проверки: Q1, Q2, Q4.

Внешняя приёмка: EXT-08.

## Контекст

JSON/CSV за BFF-cookie не доказывает scheduled refresh Power BI Service; отчёты не хранят исторический срез.

## Результат

Витрина имеет подтверждённый способ автоматического чтения, устойчивую схему и однозначные финансовые определения.

## Прочитать перед изменением

- [src/Modules/Reports/Crm.Reports/ReportsModule.cs](../../../src/Modules/Reports/Crm.Reports/ReportsModule.cs)
- [src/Modules/Reports/Crm.Reports/MartService.cs](../../../src/Modules/Reports/Crm.Reports/MartService.cs)
- [src/Modules/Reports/Crm.Reports/MarginService.cs](../../../src/Modules/Reports/Crm.Reports/MarginService.cs)
- [src/Hosts/Crm.Web/Auth/AuthenticationSetup.cs](../../../src/Hosts/Crm.Web/Auth/AuthenticationSetup.cs)
- [infra/entra/register-app.sh](../../../infra/entra/register-app.sh)
- [tests/Crm.IntegrationTests/AnalyticsApiTests.cs](../../../tests/Crm.IntegrationTests/AnalyticsApiTests.cs)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Подготовить ADR: совместимый Entra-protected read API/connector либо контролируемая выгрузка. Рекомендованный локальный путь — отдельная read-only authentication policy для mart; bearer не должен автоматически открывать остальные cookie API.
2. Проверять issuer/tenant/audience/scopes или app roles, выбранного субъекта/сервисную identity и разрешённые datasets. Machine identity не получает scope всех записей из-за UserId=null.
3. Добавить стабильные schemaVersion, asOf, boundaries, pagination/watermark и ограничения экспорта. Поддержать rate limits, реальные refresh запросы и контролируемую нагрузку.
4. Зафиксировать словарь MRR/ARR, выручка выставленная/признанная, задолженность/оплаты, маржа и источник себестоимости. Не называть уменьшение остатка оплатой без соответствующей семантики.
5. Историю финансового состояния получать из зафиксированных снимков модуля-владельца. Если нужна reporting storage, обосновать отдельным ADR; не обходить модульные границы прямыми cross-schema запросами.
6. Создать пример подключения и процедуру scheduled refresh с обновлением токена; не публиковать токены/credentials в пример.

## Критерии приёмки

- **DEV-14-AC01** — Просроченный, чужой tenant/audience и неподходящий scope токены получают отказ.
- **DEV-14-AC02** — Правильно выданный BI-доступ читает только разрешённые наборы; UI permissions и record scope не ослаблены.
- **DEV-14-AC03** — Выборка содержит все страницы, стабильные имена и типы полей; повтор refresh не теряет изменения на границе watermark.
- **DEV-14-AC04** — Исторический отчёт закрытого месяца не меняется от редактирования текущего прайса/категории клиента.
- **DEV-14-AC05** — Power BI Service выполняет плановое обновление без browser-cookie, в том числе после истечения исходного токена; свидетельство EXT-08.
- **DEV-14-AC06** — Числа BI сверены с определёнными источниками и не смешивают выставленную сумму с реально полученной оплатой.

## Данные и обратимость

Схему витрины версионировать, а не ломать существующую без периода перехода. Снимки backfill имеют provenance/asOf и не выдаются за реальные исторические данные при отсутствии источника.

## Границы

Не открывать публичный SQL и не использовать персональную cookie/постоянный bearer token в Power BI.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-14.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
