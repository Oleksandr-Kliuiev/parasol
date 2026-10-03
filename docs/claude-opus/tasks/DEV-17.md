# DEV-17 Мониторинг и рабочее место разбора исключений

Приоритет: **P1**. Аудит: **A06, A07**.

Зависимости реализации: DEV-06, DEV-07. Проверки: Q1, Q2, Q3, Q4.

Внешняя приёмка: EXT-01.

## Контекст

Логи и App Insights настроены, но не найдены готовые правила оповещения с адресатами и полноценный контроль доменного outbox.

## Результат

Оператор видит проблемы до обращения клиента и может безопасно довести каждое исключение до решения.

## Прочитать перед изменением

- [infra/modules/monitoring.bicep](../../../infra/modules/monitoring.bicep)
- [src/Hosts/Crm.ServiceDefaults/ServiceDefaultsExtensions.cs](../../../src/Hosts/Crm.ServiceDefaults/ServiceDefaultsExtensions.cs)
- [src/Integrations/Crm.Integrations.Core/IntegrationsCoreModule.cs](../../../src/Integrations/Crm.Integrations.Core/IntegrationsCoreModule.cs)
- [src/Integrations/Crm.Integrations.Core/SyncRunner.cs](../../../src/Integrations/Crm.Integrations.Core/SyncRunner.cs)
- [web/src/features/admin/IntegrationsPage.tsx](../../../web/src/features/admin/IntegrationsPage.tsx)
- [web/src/features/integrations/SystemsPanels.tsx](../../../web/src/features/integrations/SystemsPanels.tsx)
- [docs/runbooks/02-integrations.md](../../runbooks/02-integrations.md)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Метрики: HTTP ошибки/latency, SQL readiness, worker heartbeat, outbox age/depth/dead-letter, outbound errors, возраст последней успешной sync, unmapped/unbilled records и финансовые расхождения.
2. Создать alert rules, action groups и workbook/dashboard через Bicep. Назначение адресатов идёт из конфигурации/EXT-01; не придумывать почту и не посылать реальные уведомления при локальных тестах.
3. В UI добавить источник, время последнего успеха, свежесть, последствия, назначенного ответственного, статус разбора и комментарий к исключению. Разделить интеграционные ошибки, денежные аномалии и намеренную паузу.
4. Сделать фильтры/сохранённые представления, ограниченные bulk operations, retry/replay с причиной и проверкой прав; подтверждение показывается для конкретного состава действия.
5. Для свежести использовать last succeeded, а не последний failed/skipped run. Базовые границы спецификации: Atera тикеты 15 минут, оплаты PowerOffice 90 минут; другие пороги конфигурируемы.
6. Свести сигналы в runbook: кто получает, когда эскалация, что делать, как проверить восстановление. Не дублировать одно событие письмом каждую минуту.

## Критерии приёмки

- **DEV-17-AC01** — Искусственная ошибка создаёт сигнал, доступный оператору, с runbook и владельцем; после исправления состояние обновляется.
- **DEV-17-AC02** — Новая failed/skipped синхронизация не делает устаревшие данные свежими.
- **DEV-17-AC03** — Пользователь без финансового доступа не видит суммы в исключениях, уведомлениях и общих логах.
- **DEV-17-AC04** — Массовый replay проверяет каждую запись и повторное нажатие; есть результаты по элементам и аудит.
- **DEV-17-AC05** — У alerts определены severity, suppression/recovery и адресат; без реального адресата внешняя часть не считается принятой.
- **DEV-17-AC06** — Проверена деградация одной системы при продолжающейся работе независимых функций CRM.

## Данные и обратимость

Служебные состояния добавлять с retention и минимальным PII. Новые метрики не использовать с высококардинальными label на каждый customer/id. Изменения алертов сначала в test.

## Границы

Не отправлять уведомления внешним клиентам и не превращать alerts в бесконечный шум.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-17.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
