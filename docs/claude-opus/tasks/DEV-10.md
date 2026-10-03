# DEV-10 Отзыв привилегий и жизненный цикл сессии

Приоритет: **P1**. Аудит: **A15**.

Зависимости реализации: DEV-09. Проверки: Q1, Q2.

Внешняя приёмка: EXT-02.

## Контекст

Refresh Graph User.Read не обновляет CRM app roles. Синхронизация accountEnabled не отслеживает отзыв назначения роли.

## Результат

Изменение разрешений прекращает старые привилегии во всех репликах в измеряемое время.

## Прочитать перед изменением

- [src/Hosts/Crm.Web/Auth/AuthenticationSetup.cs](../../../src/Hosts/Crm.Web/Auth/AuthenticationSetup.cs)
- [src/Hosts/Crm.Web/Auth/AuthOptions.cs](../../../src/Hosts/Crm.Web/Auth/AuthOptions.cs)
- [src/Hosts/Crm.Web/Http/ActiveUserMiddleware.cs](../../../src/Hosts/Crm.Web/Http/ActiveUserMiddleware.cs)
- [src/Modules/Identity/Crm.Identity/Features/UserServices.cs](../../../src/Modules/Identity/Crm.Identity/Features/UserServices.cs)
- [src/Integrations/Crm.Integrations.MicrosoftGraph/EntraUserSyncJob.cs](../../../src/Integrations/Crm.Integrations.MicrosoftGraph/EntraUserSyncJob.cs)
- [src/Hosts/Crm.Web/Http/DataProtectionSetup.cs](../../../src/Hosts/Crm.Web/Http/DataProtectionSetup.cs)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Определить authoritative role assignments с учётом групп Entra и истечения PIM; не считать Graph User.Read проверкой CRM-назначений.
2. Ввести серверную версию полномочий/сессии и ограниченный cache; обновлять или отклонять cookie при изменении версии. Проектный ориентир — отзыв привилегии в пределах 5 минут, подтвердить в EXT-02.
3. Проверять актуальность непосредственно перед критической финансовой командой, экспортом и административным действием; не полагаться только на UI.
4. Определить fail-closed поведение для привилегированных действий при невозможности проверить свежесть; обычное чтение подчиняется документированной политике ограниченного grace period.
5. Обеспечить logout/session invalidation на нескольких репликах; cookies и token cache защищены одинаковым стабильным keyring. Проверить production startup при неполной DataProtection-конфигурации.
6. Сохранить single-tenant ограничения, MFA/Conditional Access, абсолютный срок сессии и невозможность Development auth в production.

## Критерии приёмки

- **DEV-10-AC01** — При удалении Finance/Admin существующая cookie теряет права без повторного входа в пределах согласованного SLA.
- **DEV-10-AC02** — Деактивация пользователя, снятие группы и истечение PIM проверены отдельно; disabled account не реактивируется старой сессией.
- **DEV-10-AC03** — Старый token/cookie на второй реплике не восстанавливает отозванную роль.
- **DEV-10-AC04** — Недоступность источника полномочий не позволяет бессрочно выполнять финансовые действия со старой ролью.
- **DEV-10-AC05** — Локальные тесты используют fake time и test authority; успешный mock не считается живой Entra-проверкой EXT-02.
- **DEV-10-AC06** — В логах нет access/refresh tokens, session cookies и сырых identity claims.

## Данные и обратимость

Версия сессии добавляется с безопасным default; legacy cookies при необходимости один раз требуют нового входа. Миграции не стирают всех пользователей. Ротация ключей отдельно от массового разлогинивания.

## Границы

Не вводить обход MFA и не синхронизировать роли из пользовательского ввода.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-10.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
