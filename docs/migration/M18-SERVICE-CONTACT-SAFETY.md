# M18 — проверка контакта перед Atera-заявкой

Это локальное исправление существующего Service/Atera пути, выявленное при read-only аудите
следующего рабочего сценария. Новая функция создания заявок из прежнего сервиса интеграций
(удалён в [M38](M38-OPERATIONS-IN-CRM.md)), provider API, production dependencies, credentials
и deployment не добавляются. Проверки используют только синтетические контакты и собственные
fake/loopback fixtures.

## Выявленная граница

POST `/api/v1/service/ticket-requests` проверял существование организации, но не текущую
принадлежность выбранного контакта. Worker использовал существующую глобальную Contact
link без проверки Customers либо экспортировал `GetContactForSyncAsync` результат.
Этот Customers read намеренно включает удалённые контакты для других sync/erasure сценариев;
он уже предоставляет `IsDeleted` и активность не удалённых affiliations.

Контакт с несколькими организациями также может иметь одну Atera Contact link, принадлежащую
другому Atera customer. Наличие CRM affiliation не подтверждает владельца этой external link.
Изменять общий Customers read-контракт или автоматически переносить/создавать второй контакт
для другой affiliation не следует.

## Ограниченное исправление

- Admission требует usable organization, не удалённый контакт и активную affiliation
  ровно к выбранной организации. Отказ происходит до Request/outbox write.
- Перед новым contact/ticket POST worker заново проверяет текущие customer/contact данные,
  включая уже связанный контакт. После создания/согласования контакта проверка повторяется
  перед новым ticket POST. Наблюдаемое изменение customer mapping должно блокировать запись.
- Existing linked ContactId и известный contact journal reference проверяются по точному
  external ContactId/CustomerId и ignore state. Используется существующий GetContactsAsync,
  ограниченный десятью секундами и 1000 возвращённых записей. Unknown/foreign/unusable owner
  блокирует новую запись; email не заменяет точную linked identity.
- Resolved Contact link также проверяется по LinkId/externalId перед новым ticket POST:
  исправление связи во время owner read не оставляет прежний EndUserId действующим.
  Нулевой/отрицательный known/new/recovered contact ID отвергается до owner scan/adoption.
- Mirror `ParentExternalId/IsGone` описывает последний сохранённый результат и сам по себе
  не доказывает текущего владельца. Новый provider endpoint не вводится.
- Ticket `MayExist` reconciliation остаётся перед проверками новой отправки: уже созданный
  ticket должен согласовываться без повторного POST даже после удаления контакта.
- Неопределённый contact effect не превращается во второй contact POST. Сохраняются
  прежние marker/journal правила неопределённости и ручного разбора.

Customers `WithUsableOrganizationAsync` использует повторяемый EF callback. Удалённые POST
и неидемпотентные записи другого модуля нельзя помещать внутрь него. Проверки перед новой
отправкой относятся к моменту чтения; это не атомарный snapshot CRM и Atera и не возможность
отменить уже отправленный provider effect.

## Обязательные проверки

1. Missing/deleted/foreign/inactive контакт и deleted/merged organization отвергаются при
   admission без Request/outbox writes. Положительный контакт выбранной affiliation проходит.
2. После очереди контакт/affiliation/customer становятся непригодны: ноль новых contact/
   ticket POST, как для linked, так и для unlinked контакта.
3. Multi-affiliation и known contact journal ref другого Atera customer: ноль новых записей,
   без автоматического unlink/recreate; missing/gone/malformed owner не разрешает ticket.
4. Контакт создан, затем affiliation/customer меняется: contact journal сохраняется,
   новый ticket POST блокируется. Положительный путь создаёт ровно один контакт и ticket.
5. Прежние lost-answer, marker-found/not-found и journal-known-ID сценарии достигают прежней
   точки отказа и продолжают доказывать отсутствие повторных эффектов. Положительные
   fixtures получают явные корректные ownership данные; assertions не ослабляются.

## Результаты локальных проверок

| Проверка | Результат |
| --- | --- |
| Полный адресный SQL после contact field-error metadata | 65/65, 0 failures/skips: 42 новых случая и 23 прежних регрессии |
| После последнего positive-ID guard | Адресный набор 7/7: шесть новых known/new/recovered случаев 0/-1 и прежний positive create control, 0 failures/skips |
| Web/Worker Release финальных исходников | 0 warnings/errors |
| Scratch Web/Integration Release | 0 warnings/errors; 765 точных source/test/tool файлов, только factory адаптирована для fixture |
| CRM architecture после выделения handler/нового контракта | 94/94, 0 skipped |
| Независимая финальная проверка | Границы, фактическое достижение прежних resilience faults и форма contact400 проверены; оставшихся замечаний в этом объёме нет |
| Cleanup | Все три owned pinned-loopback SQL fixtures и private credentials/temp удалены |

65 и последующие 7 — разные запуски; это не объявляется одним финальным набором 71.
После последних 7 production code не менялся. Handler выделен в `AteraTicketCreation.cs`,
а основной sync файл сохранён для чтения/зеркалирования. Отказ admission содержит
фиксированные `errors.ContactId`: существующий ApiError приводит ключ к `contactId`,
и форма показывает его рядом с выбором контакта вместо скрытого generic400.

Реальные Atera schema/account/eventual consistency не проверены. После M17/M18 текущий
CRM browser-набор прошёл 38/38, а полный composition (свидетельство удалено в M38:
`git show 73c0158:docs/testing/evidence/composition-current-2026-10-16.json`)
со сборкой обоих приложений — 8/8, без пропусков/retries и с очисткой. Эти наборы не
заменяют указанные targeted provider-safety проверки.
