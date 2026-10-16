# DEV-06 Готовность сервиса и контроль работоспособности worker

Приоритет: **P1**. Аудит: **A06**.

Зависимости реализации: DEV-00. Проверки: Q1, Q2, Q4.

Внешняя приёмка: не требуется отдельный внешний gate; нужны фактические локальные доказательства.

## Контекст

В readiness участвует только self Healthy. Развёртывание может пройти без рабочего доступа к SQL.

## Результат

Балансировщик принимает только готовый web; зависание фоновой обработки видно отдельно.

## Прочитать перед изменением

- [src/Hosts/Crm.ServiceDefaults/ServiceDefaultsExtensions.cs](../../../src/Hosts/Crm.ServiceDefaults/ServiceDefaultsExtensions.cs)
- [src/BuildingBlocks/Crm.Infrastructure/DependencyInjection/ModuleRegistration.cs](../../../src/BuildingBlocks/Crm.Infrastructure/DependencyInjection/ModuleRegistration.cs)
- [src/Hosts/Crm.Web/Program.cs](../../../src/Hosts/Crm.Web/Program.cs)
- [src/Hosts/Crm.Worker/Program.cs](../../../src/Hosts/Crm.Worker/Program.cs)
- [infra/modules/apps.bicep](../../../infra/modules/apps.bicep)
- [tests/Crm.IntegrationTests/LaunchReadinessTests.cs](../../../tests/Crm.IntegrationTests/LaunchReadinessTests.cs)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Развести live, ready и диагностику интеграций. Добавить короткую проверку SQL/необходимой схемы с таймаутом и без утечки строки подключения.
2. Не привязывать liveness к SQL, чтобы не создавать restart storm при общем отказе. Не включать внешние API в readiness.
3. Для worker добавить heartbeat и состояние обработки; проверять возраст исполнения, а не только запуск процесса.
4. Обновить startup/readiness probes и deployment smoke. При migrations-only не запускать прикладную обработку.
5. Добавить явные, ограниченные таймауты и деградированное состояние, где это согласовано; диагностические детали доступны только нужным ролям.

## Критерии приёмки

- **DEV-06-AC01** — Web жив, SQL недоступен: live успешен, ready возвращает неуспех за ограниченное время.
- **DEV-06-AC02** — После восстановления SQL ready восстанавливается без ручного пересоздания данных.
- **DEV-06-AC03** — Отказ Atera/PowerOffice не выключает независимый CRUD CRM.
- **DEV-06-AC04** — Worker с остановленной обработкой при живом HTTP-процессе имеет просроченный heartbeat.
- **DEV-06-AC05** — Миграции и startup на пустой тестовой БД проходят; health-ответ не раскрывает секреты/SQL детали.

## Данные и обратимость

Проверки схемы обратно совместимы на expand-периоде. Не запускать тяжёлые запросы на каждом probe. Для heartbeat — небольшая таблица/метрика с bounded retention.

## Границы

Алерты и дашборд оператора завершаются в DEV-17.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-06.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
