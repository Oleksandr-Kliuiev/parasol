# ADR-028 — допуск Billing к точной версии часов

Статус: M25 принят локально; 925 unit, 94 architecture, 195 affected SQL, 562 frontend, 76 browser и 9 composition проходят. Публикации и развёртывания нет.

## Проблема

После сохранения Sending/Exported basis часы оставались Approved до асинхронной
доставки `BillingBasisExported`. Отдельный Time writer мог вернуть банк или применить
изменившийся импорт. Обработчик события проверял только EntryId и мог пометить новую
approval revision как Invoiced. Четыре управляемых SQL-сценария воспроизвели эти ошибки.

Одной проверки перед отправкой недостаточно: утверждённый basis уже неизменен, а
проверка без общего допуска проигрывает конкурентному withdrawal. Нельзя держать
транзакцию вокруг внешнего HTTP или исправлять исторические суммы автоматически.

## Решение

Используются существующие immutable Billing lines, их `timeEntryIds`/`allocationIds`
и статусы basis. Новая financial table, миграция, очередь и dependencies не нужны.

`ITimeBillingAdmission` — контракт Time для короткой read lease. При утверждении и
перед MarkSending Billing получает все упорядоченные M23 Exclusive month admissions
и Time row locks. Проверяются точные активные allocations, их EntryId, source organization
и статус Approved. Lease удерживается до локального Billing SaveChanges, затем его
завершение/исключение освобождает read transaction. Time здесь ничего не сохраняет;
Billing пишет только свою схему. Внешний вызов начинается после возврата MarkSending,
когда lease уже освобождена. Произвольный внешний transaction owner, inbox handler
и execution-strategy callback для этого command admission запрещены.

`ITimeBillingReader` — отдельный read-only контракт Billing без зависимости от Time API.
Он устраняет DI cycle и возвращает только source identities, Proven/Exported и basis ID,
без финансовых сумм. Запросы ограничиваются нужными EntryId внутри собственной Billing
схемы; SQL JSON параметры не превращаются в произвольный SQL. Неопознаваемая историческая
ссылка на time line требует проверки в пределах source organization. Для консолидированных
счетов используется SourceOrganizationId дочерней организации, а не только payer.

После успешного Billing commit его неизменные не исключённые time lines в Approved,
Exported, Failed или ReconciliationRequired запрещают финансовую правку Time. Guard
выполняется под M23 admission у всех команд approve/withdraw/edit/adjust/delete и у
существующих импортируемых строк. Withdrawal проверяет весь batch до M24 bank effects.
Изменившийся импорт сохраняет старые часы/allocations/банк и ReviewNote. Draft,
Cancelled basis и Exclusion не устанавливают такой запрет. Finance может отменить
неотправленный basis с причиной; подтверждённый/неопределённый внешний результат
по-прежнему требует существующей reconciliation/correction процедуры.

Потерянное подтверждение Billing commit не освобождает принятую финансовую обязанность:
после disposal краткого SQL lock новый Time writer видит durable Billing state. Если
сохранение не принято, lease освобождается, а неподтверждённая подпись не сохраняется.
Проверка source выполняется до изменения tracked approval state, чтобы последующий
SaveChanges в том же scope не мог случайно принять отклонённую подпись.

## Точная финализация и частичное выставление

Обработчик читает экспортированный snapshot через `ITimeBillingReader`, проверяет
точные allocations и сохраняет только Time в своей прежней inbox transaction.
Несовпадение старой и текущей revision даёт ReviewNote и не делает новую revision
Invoiced. Неподтверждённая legacy-ссылка без allocation IDs не выдаётся за доказанную.

Одна запись времени может содержать HourBank/covered и Rate allocations. Если Finance
исключил Rate, а Info уже экспортирован, вся запись пока остаётся Approved. Контракт
`BillableTime.Invoiced` учитывает экспорт каждой allocation отдельно: дополнительный
сбор получает оставшийся Rate и не теряет его из-за статуса целой записи. TimeEntry
становится Invoiced, когда экспортированы все текущие allocations. Известное историческое
несовпадение или source organization conflict требует Finance review; сбор возвращает
код TIM_BILLING_SOURCE_CHANGED вместо скрытого повторного начисления.

## Проверки и ограничения

SQL проверяет исходные четыре расхождения, допуск до Billing save, rollback, lost commit
acknowledgement, отмену, повреждённые references и реальный дополнительный сбор после
частичного исключения. Сценарии с намеренно задержанной доставкой используют существующую
непараллельную collection: другие классы тестов явно дренируют общий outbox. Отказавший
194/195 запуск сохранён; в нём событие уже было доставлено, банк оставался списанным.
Предусловие Approved и все исходные проверки сохранены, пропусков нет.

Это cooperative protocol согласованного комплекта Web/Worker. Нельзя смешивать версии
до/после M25; будущий upgrade/restore требует остановленных writers и проверки истории.
Произвольный DBA SQL не становится безопасным от application locks. Автоматической
перезаписи исторических финансов, подтверждения рабочих провайдеров или VPS здесь нет.
