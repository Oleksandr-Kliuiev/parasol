# DEV-11 Персональные данные и сроки хранения

Приоритет: **P1**. Аудит: **A10**.

Зависимости реализации: DEV-04, DEV-09. Проверки: Q1, Q2, Q3, Q4.

Внешняя приёмка: EXT-07.

## Контекст

Не найдены полные subject export, анонимизация и jobs retention. Удаление карточки не удаляет копии персональных данных в истории и snapshots.

## Результат

Запрос субъекта обрабатывается полно и воспроизводимо; удаление не разрушает обязательные финансовые доказательства.

## Прочитать перед изменением

- [docs/06-security.md](../../06-security.md)
- [docs/04-data-model.md](../../04-data-model.md)
- [src/Modules/Customers/Crm.Customers/Features/Contacts/ContactFeatures.cs](../../../src/Modules/Customers/Crm.Customers/Features/Contacts/ContactFeatures.cs)
- [src/Modules/Activities/Crm.Activities/Features/ActivityFeatures.cs](../../../src/Modules/Activities/Crm.Activities/Features/ActivityFeatures.cs)
- [src/BuildingBlocks/Crm.Infrastructure/Persistence/AuditingInterceptor.cs](../../../src/BuildingBlocks/Crm.Infrastructure/Persistence/AuditingInterceptor.cs)
- [src/Integrations/Crm.Integrations.Core/ExternalRecords.cs](../../../src/Integrations/Crm.Integrations.Core/ExternalRecords.cs)
- [src/Hosts/Crm.Worker/Program.cs](../../../src/Hosts/Crm.Worker/Program.cs)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Составить inventory данных: контакты/лиды, activities, quotes/PDF, custom fields, service mirrors, identity, audit, external records, outbox/inbox, notifications, exports и backups.
2. Добавить процесс case → identity verification → preview → legal hold/policy evaluation → execute → receipt. Права и причины отдельно от обычного customers.write; публичный unauthenticated erase endpoint не нужен.
3. Экспортировать связанные данные через контракты модулей, с manifest и исключениями. Исключить данные других субъектов, внутренние секреты и чужую переписку.
4. Реализовать pseudonymization/erasure по классам данных. Для обязательных финансовых документов — ограничение обработки и retention/hold, а не автоматическое удаление. Неизменяемый факт аудита отделить от удаляемого/защищённого PII payload.
5. Предотвратить повторный импорт удалённых данных при синхронизации; минимальный suppression/tombstone хранить по утверждённой политике, не оставлять полную копию личности.
6. Ночной job: dry-run по умолчанию до EXT-07, bounded batches, progress, retries, отчёт, наблюдаемость. Сроки и основания не придумывать; их задаёт ответственное лицо.
7. После restore до удаления повторно применить журнал выполненных privacy-действий перед доступом пользователей и синхронизацией. Не обещать немедленное физическое исчезновение из неизменяемых backups.

## Критерии приёмки

- **DEV-11-AC01** — Синтетический контакт с данными во всех применимых модулях полностью попадает в scoped export.
- **DEV-11-AC02** — После операции обычные API, поиск, аудит-представление и snapshots не раскрывают подлежащие удалению PII.
- **DEV-11-AC03** — Повтор кейса/job идемпотентен; частичный сбой продолжает работу без разрушения финансовых ссылок.
- **DEV-11-AC04** — Legal hold сохраняет требуемый документ и объяснение; он не маскирует бессрочное хранение всего профиля.
- **DEV-11-AC05** — Следующая внешняя синхронизация не восстанавливает удалённый профиль без нового законного основания.
- **DEV-11-AC06** — Восстановление старой базы повторно применяет deletion manifest; доказательство хранится без самих удалённых данных.
- **DEV-11-AC07** — Автоматическое удаление остаётся выключенным, пока утверждённая матрица сроков не приложена к EXT-07.

## Данные и обратимость

Расширить схему cases/policies/holds, отдельно привилегии retention. Сначала inventory и preview. Необратимое удаление — отдельная операторская операция по выбранной среде и политике; rollback кода не возвращает стёртые данные.

## Границы

Не объявлять соответствие GDPR только по тестам кода и не задавать универсальный срок хранения всех записей.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-11.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
