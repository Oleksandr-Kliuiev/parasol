# DEV-09 Авторизация на уровне записи

Приоритет: **P1**. Аудит: **A09**.

Зависимости реализации: DEV-00. Проверки: Q1, Q2, Q3.

Внешняя приёмка: EXT-01.

## Контекст

MineOnly — пользовательский фильтр, не проверка доступа. Требования о своих предложениях/назначенных проектах противоречат части описаний общего доступа.

## Результат

Видимость и изменение записи следуют согласованной политике на всех путях доступа.

## Прочитать перед изменением

- [src/BuildingBlocks/Crm.Authorization/Permissions.cs](../../../src/BuildingBlocks/Crm.Authorization/Permissions.cs)
- [src/Modules/Sales/Crm.Sales/Features/QuoteService.cs](../../../src/Modules/Sales/Crm.Sales/Features/QuoteService.cs)
- [src/Modules/Projects/Crm.Projects/Features/ProjectFeatures.cs](../../../src/Modules/Projects/Crm.Projects/Features/ProjectFeatures.cs)
- [src/Hosts/Crm.Web/Search/SearchEndpoints.cs](../../../src/Hosts/Crm.Web/Search/SearchEndpoints.cs)
- [src/Modules/CustomFields/Crm.CustomFields/Features/CustomFieldFeatures.cs](../../../src/Modules/CustomFields/Crm.CustomFields/Features/CustomFieldFeatures.cs)
- [tests/Crm.UnitTests/AuthorizationTests.cs](../../../tests/Crm.UnitTests/AuthorizationTests.cs)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Подготовить матрицу role × entity × action × scope из DECISIONS.md. До бизнес-подтверждения использовать существующее SEC-AZ-03 как основу тестируемого restricted режима, не объявляя политику организации утверждённой.
2. Сделать общий контракт проверки доступа и обязательное ограничение запросов; точка реализации сохраняется в модуле-владельце. Не полагаться на frontend или переданный MineOnly/OwnerId.
3. Проверять get-by-id, update/delete, переходы, PDF, глобальный поиск, историю, notifications, custom fields, экспорт и аналитические агрегаты на утечку записей.
4. Определить модель назначений проекта и перенос ответственного; отсутствие назначения не трактуется как глобальный доступ. Материнская/дочерняя организация не расширяет видимость неявно.
5. Применять permission на каждом endpoint плюс scope записи. Административные исключения должны быть явно перечислены и аудироваться там, где это требуется.
6. Добавить UI состояний no access/not found и корректные запросы списка без раскрытия существования закрытых записей.

## Критерии приёмки

- **DEV-09-AC01** — Sales A не получает предложение Sales B изменением id или выключением MineOnly в restricted режиме.
- **DEV-09-AC02** — Technician видит только назначенные проекты согласно выбранной политике; изменение фильтра не расширяет доступ.
- **DEV-09-AC03** — Поиск, CSV/PDF, count/sum, история и custom fields не обходят scope.
- **DEV-09-AC04** — Передача владельца меняет доступ предсказуемо; сохранённые URL и cache другого пользователя не раскрывают данные.
- **DEV-09-AC05** — Finance/Management сохраняют ровно согласованный доступ; пользовательские роли не устанавливаются данными запроса.
- **DEV-09-AC06** — Матрица и результат бизнес-подтверждения записаны в EXT-01 до rollout персональных данных.

## Данные и обратимость

Добавить назначения/области доступа и dry-run отчёт о том, кто потеряет/получит доступ. Не назначать всем доступ для обхода отсутствующих данных. Перевод existing records выполнять после сверки владельцев.

## Границы

Не превращать single-tenant CRM в SaaS multi-tenant; не добавлять права по клиентскому флагу.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-09.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
