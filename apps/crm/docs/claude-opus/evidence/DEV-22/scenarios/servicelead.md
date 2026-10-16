# Сценарии приёмки: ServiceLead (руководитель сервиса)

Статус документа: **шаблон сценариев, не результат**. Исполнители, даты, оценки и подписи не заполнены; результаты вносятся только в [протокол](../protocol-template.md) в среде `test` (EXT-10).

## 1. Назначение

Проверить, что руководитель сервиса: одобряет и корректирует часы так, что в биллинг попадают только одобренные записи; закрывает период; следит за SLA и тикетами; управляет проектами; и не видит и не меняет деньги, которых у роли нет.

## 2. Предусловия

- Тестовая учётная запись с ролью `Crm.ServiceLead` ([runbook 17 §4.2](../../../../runbooks/17-vulnerability-intake.md), [runbook 12](../../../../runbooks/12-roles-and-sessions.md)). Для шага «Reopen» и негативных проверок - тестовые `Crm.Finance` (у неё `time.unlock`) и `Crm.Technician`.
- В среде есть неодобренные часы нескольких техников за прошлый период по клиентам A (покрыто договором), B (пакет часов), C (по ставке); часы внесены по сценарию TEC-1 или подготовлены Admin.
- Atera: только демо/зеркало, запись выключена.

## 3. Нужные данные

| Что | Примечание |
|---|---|
| 6-10 записей часов в статусе «New» за закрываемый период | в том числе «Outside support hours» и «On site» |
| Договор с политикой SLA и тикеты в зеркале Atera | для отчёта SLA |
| Клиент с банком часов ниже 20 % остатка | предупреждение «Low hour bank» |
| Проект с фазами и задачами у руководителя сервиса | `projects.write` |

## 4. Сценарии

### SL-1. Одобрение часов и закрытие периода

| № | Действие | Ожидаемый результат |
|---|---|---|
| SL-1.1 | Меню «Time entries» (`/time/entries`). Выбрать месяц («Months»), отфильтровать ожидающие («waiting»). | Список по периоду с итогами; видны техники, клиенты, часы. Колонки «Amount»/«to bill» не показывают деньги (нет `finance.read`) - записать. |
| SL-1.2 | Выбрать одну запись -> «Correct» (adjust): изменить часы или тип работы, указать причину. | «Entry corrected»; значение до коррекции и причина сохраняются (смотреть историю записи). |
| SL-1.3 | «Select all entries waiting for approval» -> «Approve (N)». | «N entries approved»; статус «Approved»; видна классификация «Covered by contract» / «Hour bank» / «By rate». |
| SL-1.4 | Для одной записи «Withdraw approval». | «Approval withdrawn»; запись снова «New». |
| SL-1.5 | «Close the period». | «The period is closed»; видно, кем и когда закрыт; новые часы за период технику недоступны. |
| SL-1.6 | Попытаться нажать «Reopen». | У роли нет `time.unlock` - действие недоступно или отклонено; открыть период может Finance/Admin с причиной (в журнал аудита). Шаг «Reopen» выполняет Finance. |

### SL-2. SLA, тикеты, договоры

| № | Действие | Ожидаемый результат |
|---|---|---|
| SL-2.1 | Меню «SLA report» (`/service/sla`). | Отчёт по тикетам относительно политики договора; время считается только внутри окна поддержки и не идёт в выходные и по норвежским праздникам. |
| SL-2.2 | Выбрать тикет с нарушением, сверить вручную: окно поддержки договора (8x5 / 12x5 / 24x7), даты, праздники. | Расчёт исполнителя совпадает с отчётом; расхождение - замечание. |
| SL-2.3 | «Contracts» -> «SLA policies» (`/contracts/sla-policies`). | Политики читаются. Изменение политики - только если у роли есть `contracts.write` (у ServiceLead его нет); фиксировать фактическое поведение. |
| SL-2.4 | Карточка клиента -> «Service», «Licenses». | Тикеты, устройства, предупреждения читаются. Создание тикета: см. TEC-2.6. |

### SL-3. Проекты и банк часов

| № | Действие | Ожидаемый результат |
|---|---|---|
| SL-3.1 | «Projects» -> проект -> «Add phase», «Add task»; назначить техника. | «Phase added»/«Task added». Если у фазы указан Fee и включено «Invoice the fee when the phase is completed», по завершении фазы показывается «Phase completed; the fee is waiting for the next billing run». |
| SL-3.2 | Проверить «Hours» проекта (план/факт). | Факт берётся из табеля (проект не хранит часы, BR-PRJ-01); сумма часов проекта совпадает с одобренными записями с этим проектом. |
| SL-3.3 | «My day» -> «Needs attention»: напоминание «Low hour bank». | Предупреждение показано один раз; после пополнения пакета перевооружается. |
| SL-3.4 | «Dashboard» (`/dashboard`) - блок «Hours this month», «Service and licences». | Часы и доля оплачиваемых совпадают с «Time entries»; денежные плитки (MRR, ARR, «Invoiced per month») для роли без `finance.read` отсутствуют или без сумм - записать. |

## 5. Денежные правила, которые проверяются

- Одобренная запись попадает в прогон; неодобренная - нет. Классификация часов (covered / hour bank / rate) определяет, какая часть идёт «по ставке».
- Пример приёмки: 3 ч по ставке 1 250 NOK = 3 750 NOK (часть основания 15 000 NOK). ServiceLead одобряет ровно эти 3 часа; сумму основания проверяет Finance (FIN-2).
- Пакет часов: движение остатка привязано к записи и номеру одобрения; **повторное одобрение (SL-1.4 затем SL-1.3) не списывает остаток дважды**. Проверить: остаток пакета до и после «Withdraw approval» и повторного «Approve» (записать оба значения).
- Закрытый период не принимает новые часы; позднее одобренные часы выставляет дополнительный прогон (BR-BIL-01).

## 6. Негативные проверки

Права ServiceLead по `Permissions.cs`: `time.own/read/manage`, `billing.read`, `reports.read`, `projects.read/write/all`, `service.read/write`, `contracts.read`, `customers.read`, `contacts.write`, `sales.read`; нет `finance.read`, `time.unlock`, `customers.write`, `contracts.write`, `catalog.write`.

| № | Проверка | Должно быть по коду | Примечание |
|---|---|---|---|
| SL-N1 | Суммы в «Billing» (`/billing`): итог прогона, суммы клиентов, счета | Суммы удалены сервером (нет `finance.read`); раздел и список счетов при этом **видны** (`billing.read`) | Расхождение №5 в [role-matrix-mismatches.md](../../DEV-21/role-matrix-mismatches.md): документ - «R» для прогонов и «—» для счетов. К подтверждению |
| SL-N2 | Кнопки «Collect», «Approve», «Send to PowerOffice», «Add line» | Нет (нет `billing.manage`/`billing.approve`) | |
| SL-N3 | «Reopen» закрытый период | Нет (нет `time.unlock`) | |
| SL-N4 | Маржа, закупочные цены | «Margins» не виден; cost-поля скрыты | нет `finance.cost.read` |
| SL-N5 | Редактирование организации и договора | Недоступно | нет `customers.write`, `contracts.write` |
| SL-N6 | Предложения чужих продавцов | 404 | охват записей; DEC-01 к подтверждению |
| SL-N7 | Журнал аудита и интеграции | Недоступны | нет `audit.read`, `integrations.manage` |

## 7. Доступность и клавиатура

1. Таблица «Time entries» с флажками: выбор строк и «Approve (N)» с клавиатуры; у каждого флажка есть понятное имя («Select the entry of <date> for <org>»).
2. Диалоги «Correct», «Close the period», «Reopen» - фокус возвращается на кнопку вызова; Esc закрывает.
3. Сообщения о результате («N entries approved») объявляются скринридером, не только показываются.
4. Страницы отчётов на 200 % масштабе и в тёмной теме; цвет не единственный носитель информации о нарушении SLA.
5. Телефон: список часов и кнопки читаются. Реальные устройства и скринридер - вручную (EXT-10).

## 8. Автоматика

| Область | Тест |
|---|---|
| Техник вносит, ServiceLead одобряет | `web/e2e/service-time.spec.ts`: «a technician books hours and the service lead approves them» |
| Отчёт SLA и маржа | `web/e2e/analytics.spec.ts`: «the sla report measures tickets against the contract and finance sees the margins» |
| Пакет часов, предупреждение | `tests/Crm.UnitTests/ContractsDomainTests.cs`: `Hour_bank_warns_below_twenty_percent_and_records_overage`; `tests/Crm.IntegrationTests/ContractsApiTests.cs`: `Hour_bank_consumption_warns_the_owner_below_twenty_percent` |
| Учёт времени, доменная логика | `tests/Crm.UnitTests/TimeTrackingDomainTests.cs`, `tests/Crm.IntegrationTests/ServiceAndTimeTests.cs` |
| Окно поддержки, праздники | `tests/Crm.UnitTests/BusinessTimeTests.cs` |
| Проект и план/факт, фаза в очередь биллинга | `web/e2e/projects.spec.ts`: «a project is planned in phases and a completed phase queues its fee»; `tests/Crm.IntegrationTests/ProjectsApiTests.cs` |
| Устаревшие часы в основании | `tests/Crm.IntegrationTests/BillingQuantityFreshnessTests.cs`: `AC05_stale_missing_and_incomplete_quantities_are_flagged_on_the_basis_and_the_signal_clears_when_they_are_fresh` |

В UAT остаётся: достаточность экрана одобрения для реального объёма (сотни записей), понятность причин коррекции, сверка SLA с практикой, реальное устройство и скринридер.
