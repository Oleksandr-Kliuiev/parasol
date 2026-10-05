# Сценарии приёмки: Finance (финансы)

Статус документа: **шаблон сценариев, не результат**. Исполнители, даты, суммы «получилось», оценки и подписи не заполнены; результаты вносятся только в [протокол](../protocol-template.md) в среде `test` (EXT-10). Сценарии FIN-2..FIN-4 - **тренировочный прогон на синтетических данных**; он не заменяет параллельный месячный пилот на реальных данных ([runbook 18](../../../../runbooks/18-pilot-billing.md), DEV-22-AC02).

## 1. Назначение

Проверить, что сотрудник Finance без подсказок разработчика: собирает прогон, находит и объясняет аномалии, вносит ручные правки с причиной, получает правильные суммы (в том числе пропорцию, скидки, MVA, квартал/год, дочерний плательщик), утверждает, отправляет (в демо-среду), сверяет неизвестный результат отправки, закрывает прогон и оформляет дополнительный прогон.

## 2. Предусловия

- Среда `test`, вход через Entra. Тестовые учётные записи: `Crm.Finance` (исполнитель), `Crm.Management` (второе утверждение), `Crm.Admin` (подготовка данных, связи PowerOffice, пауза). Список и порядок создания: [runbook 17 §4.2](../../../../runbooks/17-vulnerability-intake.md), [runbook 12](../../../../runbooks/12-roles-and-sessions.md).
- PowerOffice: демо-окружение (`Integrations:PowerOffice:Environment` = Demo) или `WriteEnabled` = false. В `test` не должно быть возможности отправить заказ в производственную бухгалтерию (проверка в runbook 18 §3).
- Клиенты и продукты связаны с PowerOffice на экране «Mappings» (`/admin/mappings`; его открывает Admin - у Finance нет `integrations.manage`).
- Для каждого прогона выбран **незанятый тестовый период**: период, в который в этой базе нет другого незакрытого прогона (BR-BIL-01).
- Привилегированные действия (Collect, Approve, Send, Close, вторая подпись) требуют свежего подтверждения ролей каталогом (не старше 5 минут, `Auth:PrivilegedFreshness`). При отказе `403 AUTH_REVERIFY_REQUIRED` интерфейс должен открыть подтверждение личности и вернуть на ту же страницу ([runbook 12](../../../../runbooks/12-roles-and-sessions.md)).

## 3. Нужные данные

| Что | Значение для сверки |
|---|---|
| Клиент FIN-A: договор Monthly, строка абонплаты 5 000 NOK; 25 лицензий Microsoft по 250 NOK; одобренные часы 3 ч по ставке 1 250 NOK | Ожидаемое основание **15 000 NOK без MVA** (5 000 + 6 250 + 3 750); пример приёмки docs/02 §4.9 |
| Клиент FIN-B: строка договора с началом в середине периода (например, с 16-го числа 30-дневного месяца) | Доля `15/30`; цена за единицу x доля, количество без изменения (BR-BIL-11) |
| Клиент FIN-C: договор Quarterly | Выставляется в каждом третьем месяце от старта |
| Клиент FIN-D: договор Yearly | Выставляется в месяц годовщины |
| Дочерняя компания FIN-E с флагом «invoiced through the parent» и материнская FIN-P | Строки FIN-E на основании FIN-P с префиксом названия (BR-BIL-12) |
| Клиент FIN-F: пакет часов (покупка в периоде) | Покупка выставляется один раз, повторная сборка не удваивает |
| Клиент FIN-G: основание строго выше 200 000 NOK без MVA | Требует второго утверждения Management; ровно 200 000 не требует |
| Клиент без связи с PowerOffice | Аномалия «customer not linked»; отмена основания |
| Расчёт исполнителя «вручную» для каждого клиента | Таблица: часы/подписки, цена, пропорция, скидка, MVA - до просмотра результата CRM |

Исполнитель **сам готовит ожидаемые суммы по исходным данным до сбора прогона** и записывает их в протокол; сравнение с экраном CRM - только после.

## 4. Сценарии

### FIN-1. Продукт и прайс-лист

| № | Действие | Ожидаемый результат |
|---|---|---|
| FIN-1.1 | «Catalog» (`/catalog`) -> «New product» (`/catalog/products/new`): SKU, название, тип, периодичность, ставка MVA, цена, закупочная цена. | Продукт создан. Закупочная цена видна только ролям с `finance.cost.read` (Finance - да). Ставка MVA продукта определяет ставку в основании; код PowerOffice - из сопоставления. |
| FIN-1.2 | Открыть прайс-лист (`/catalog/price-lists/<id>`), добавить цену продукта. | Цена в прайс-листе; активный прайс-лист меняется только через версию/индексацию, прайс-лист цен NCE применяется только к черновику. |
| FIN-1.3 | «Contracts» -> «Indexation» (`/contracts/indexation`): предпросмотр годовой индексации. | Предпросмотр показывает новые цены; записывается только то, что показал предпросмотр; строки на цене прайс-листа индексируются вместе с прайс-листом (BR-CON-06). |

### FIN-2. Прогон по примеру приёмки (15 000 NOK)

| № | Действие | Ожидаемый результат |
|---|---|---|
| FIN-2.1 | Подготовка: данные FIN-A (Admin). Часы 3 ч одобрены (ServiceLead, SL-1.3). | Подготовка завершена. |
| FIN-2.2 | «Billing» (`/billing`) -> «New run»: выбрать месяц (поля «Year», «Month»), без «Supplementary run». | «Run for <period> created»; статус «Draft». Если период уже занят закрытым прогоном - `BIL_PERIOD_ALREADY_BILLED`, выбрать другой период. |
| FIN-2.3 | «Collect». | «The run was collected»; статус «Collected»; в списке «Customers in this run» есть FIN-A. |
| FIN-2.4 | Открыть основание FIN-A (`/billing/bases/<id>`). | Три группы позиций: «Recurring services» 5 000,00; «Microsoft licences» 6 250,00; «Hours at rate» 3 750,00; «Total excluding VAT» **15 000,00 NOK**. Сумма MVA и «Total including VAT» считаются по ставке продукта: исполнитель считает отдельно (при 25 % MVA: 18 750,00). |
| FIN-2.5 | Описание строк: период в виде даты начала-окончания (BR-BIL-07); для часов - дата, тикет, техник (если детализация включена по клиенту). | Описание читается и совпадает с исходными данными. |
| FIN-2.6 | Сравнить итог CRM с таблицей исполнителя по каждой строке (количество, цена, скидка, MVA). | Расхождений нет, либо каждое записано в журнал замечаний протокола с причиной. |
| FIN-2.7 | На странице прогона «Pilot reconciliation» (`/billing/runs/<id>/pilot`, кнопка видна только с правом `billing.reconcile`): проверить «Readiness», открыть «Trace of the run» (при необходимости «Export to Excel»), загрузить или вставить файл `orgnr;period;currency;group;productCode;quantity;amountExVat;externalRef` с расчётом исполнителя и нажать «Compare». | Вердикты по ключам и итоги по плательщикам и валютам. Каждый плательщик прогона, которого нет в файле, виден как «Missing in file»; MVA программа не сравнивает (заказ в PowerOffice несёт только код продукта) - её исполнитель сверяет с документом PowerOffice отдельно. |

### FIN-3. Исключения и ручные правки в прогоне

| № | Действие | Ожидаемый результат |
|---|---|---|
| FIN-3.1 | Основание FIN-B (часть периода). | Цена за единицу умножена на долю (`15/30`), количество прежнее, окно и доля в описании; две части при смене в середине месяца в сумме дают ровно один период. |
| FIN-3.2 | Период, в котором FIN-C (квартал) и FIN-D (год) должны / не должны быть выставлены. | FIN-C только в каждом третьем месяце от старта; FIN-D в месяц годовщины; в остальные месяцы основания нет. |
| FIN-3.3 | FIN-E / FIN-P. | У FIN-E нет собственного основания; её строки в основании FIN-P с префиксом названия FIN-E; аномалии перенесены. |
| FIN-3.4 | «Add line» (разовая позиция вручную) с суммой и описанием. | «Line added»; помечена «Added by hand»; итог пересчитан; разовая позиция - без привязки к источнику. |
| FIN-3.5 | «Edit line» на собранной позиции: изменить цену, указать причину. | Без причины - отказ (`BIL_REASON_REQUIRED`); с причиной - «Line saved»; показаны «Corrected: <причина>» и «Source: <сумма источника>», автор и дата. |
| FIN-3.6 | «Leave out» позицию с причиной. | Позиция видна, но не выставляется; итог уменьшен. |
| FIN-3.7 | «Collect again». | Правка из FIN-3.5 и исключение из FIN-3.6 сохранены; позиции не удвоены. |
| FIN-3.8 | Admin меняет источник скорректированной позиции (например, количество). Finance заново открывает основание. | Позиция получает конфликт («The source changed after Finance decided about this line»); баннер «N lines need a decision»; утвердить прогон нельзя, пока конфликт не решён («Use the source» / «Keep the decision» с причиной). |
| FIN-3.9 | Аномалии: клиент без связи с PowerOffice; позиция без цены; изменение суммы клиента более чем на 20 % к прошлому периоду; подписка CSP без позиции договора; продукт без кода PowerOffice. | Каждая аномалия видна в колонке «Needs a look» / фильтр «Needs a look only», с понятным текстом; «Previous period: <сумма>» показана. |
| FIN-3.10 | Скидка на позиции договора. | Сумма строки = количество x цена x (1 - скидка %); в строке «<N> % discount». |
| FIN-3.11 | Устаревшее количество (по устройству Atera / по подписке старше лимита). | Показана аномалия «the quantity comes from a reading of <date>, which is older than the limit»; не молчаливое старое число. |

### FIN-4. Утверждение, отправка, сверка, закрытие

| № | Действие | Ожидаемый результат |
|---|---|---|
| FIN-4.1 | «Approve» (Finance) при всех основаниях не выше 200 000 NOK. | «The run is approved»; блок «Approvals» показывает ревизию и подписавшего. |
| FIN-4.2 | Если есть основание строго выше 200 000 NOK без MVA (FIN-G): «Approve» одним человеком. | Прогон не выпущен: «A customer is above the threshold: Finance and management have to approve, two different people, in either order». |
| FIN-4.3 | `Crm.Management`: «Approve as management». Попытка подписать обе подписи одним человеком (в том числе Admin). | Выпускается только со второй, **другой** персоной (`BIL_SAME_APPROVER`); подпись одного человека дважды не засчитывается. |
| FIN-4.4 | После утверждения Finance меняет строку (или собирает заново). | Утверждение аннулировано с видимой причиной («Earlier approvals no longer count; revision N has to be approved again»). |
| FIN-4.5 | «Send to PowerOffice» (демо). Страница опрашивается, пока воркер отправляет. | «The run is being sent»; прогресс «N sent, N failed, out of N customers»; затем статус «Sent» и номер заказа в основании. Закрыть вкладку можно: ничего не отправится дважды. |
| FIN-4.6 | Основание «Failed»: причина (нет связи клиента, нет кода продукта). Исправить и «Send again». | Основание возвращается в очередь; второй заказ не создаётся (идемпотентность). Таблица причин: [runbook 04](../../../../runbooks/04-billing-export.md) §2. |
| FIN-4.7 | Основание «Needs reconciliation»: найти заказ в PowerOffice (демо), «Reconcile» -> «The order exists» с номером либо «There is no order» с причиной. | До сверки основание нельзя отменить (`BIL_RECONCILE_FIRST`); после «The order exists» оно «Sent», начисления выставлены. |
| FIN-4.8 | «Add a correction» к уже отправленной позиции. | Исходный заказ не меняется; сумма попадает в следующий прогон отдельной позицией со ссылкой на исходную. Отрицательная сумма (кредит) оформляется в бухгалтерии, а не в CRM (`BIL_CREDIT_NOT_ENABLED`, DEC-02). |
| FIN-4.9 | «Billing» -> «Invoices» (`/billing/invoices`) и вкладка клиента «Invoices»: поиск счёта, «Outstanding», «Overdue». | Счета и остатки как их отдаёт PowerOffice; статусы «Nothing outstanding», «Partly settled», «Credited» отражают внешний документ. «Paid» в CRM не заявляется: колонка называется «outstanding». |
| FIN-4.10 | «Close the run». | «The run is closed»; закрытый период второго обычного прогона не получает (`BIL_PERIOD_ALREADY_BILLED`). |
| FIN-4.11 | Новый прогон того же месяца с флагом «Supplementary run» (после одобрения позднего часа). | Выставляется только то, что не держит реестр начислений; месяц договора и покупка пакета часов повторно не выставляются. |

### FIN-5. Лицензии, маржа, затраты

| № | Действие | Ожидаемый результат |
|---|---|---|
| FIN-5.1 | «Licenses» -> вкладка «Microsoft reconciliation»: «Import Microsoft invoice» (предпросмотр -> импорт). | Предпросмотр считает так же, как реальный импорт; повтор того же файла - без изменений. Показаны «Cost», «Billed», «Margin», «Not billed on». |
| FIN-5.2 | «Margins» (`/reports/margins`), «Dashboard». | Маржа и «Invoiced per month» совпадают с суммами основания и затратами; затраты видны потому что у Finance есть `finance.cost.read`. |

## 5. Денежные правила, которые проверяются

Из docs/02 §4.9: BR-BIL-01 (один незакрытый прогон на период; дополнительный прогон для закрытого), 02 (пересборка до утверждения, правки с причиной, переживают пересборку, конфликты), 03 (аномалии: +/-20 %, позиция без цены, продукт/клиент без PowerOffice, подписка CSP без позиции), 04 (порог строго выше 200 000 без MVA, два разных человека, подписи привязаны к ревизии), 05 (идемпотентная отправка, сверка неизвестного результата), 06 (один заказ на организацию и период), 07 (период в описании), 08 (часы получают «Выставлена» после отправки), 09 (отмена/кредит-нота), 10 (неизменяемость 5 лет), 11 (пропорция по дням), 12 (материнский плательщик).

Пример приёмки: 5 000 + 25 x 250 + 3 ч x 1 250 = **15 000 NOK без MVA**, три группы позиций.

## 6. Негативные проверки

Права Finance по `Permissions.cs`: `billing.read/manage/approve`, `finance.read`, `finance.cost.read`, `catalog.write`, `contracts.write`, `time.read`, `time.unlock`, `audit.read`, `reports.mart`, `projects.all`, `sales.quotes.all`; нет `billing.approve.second`, `integrations.manage`, `customers.write`, `sales.write`, `time.manage`.

| № | Проверка | Должно быть по коду | Примечание |
|---|---|---|---|
| FIN-N1 | «Approve as management» | Недоступно роли Finance (нет `billing.approve.second`) | Admin имеет оба права, но две подписи одного человека не засчитываются (тест `A02_a_user_with_both_approval_rights_cannot_release_a_run_alone_by_signing_the_second_approval_first`) |
| FIN-N2 | Связать клиента с PowerOffice, поставить интеграцию на паузу | Недоступно (нет `integrations.manage`); это делает Admin ([runbook 05](../../../../runbooks/05-pause-integration.md)) | |
| FIN-N3 | Редактировать организацию, создавать предложение | Недоступно (нет `customers.write`, `sales.write`) | |
| FIN-N4 | Одобрять часы | Недоступно (нет `time.manage`) | Расхождение №2: Finance может открыть закрытый период (`time.unlock`); документ - «R». К подтверждению |
| FIN-N5 | Отменить основание после отправки заказа | Запрещено; кредит-нота в бухгалтерской системе, корректировка в следующем прогоне (BR-BIL-09) | |
| FIN-N6 | Удалить прогон, основание, начисление, запись аудита | Невозможно через интерфейс; в базе запрещено правами и триггерами | Не пытаться «обойти» SQL-ом |
| FIN-N7 | Привилегированное действие без свежей роли | `403 AUTH_REVERIFY_REQUIRED`, затем подтверждение и возврат | Не обходить повторным входом в другой вкладке |
| FIN-N8 | Утвердить прогон с неразрешёнными конфликтами | Невозможно (`BIL_UNRESOLVED_CONFLICTS`) | |

## 7. Доступность и клавиатура

1. Таблицы прогонов и оснований: сортировка/фильтр «Needs a look only», поиск «Search customer» с клавиатуры; каждая строка имеет ссылку с именем клиента.
2. Диалоги «Add line», «Edit line», «Leave out», «Reconcile», «Close the run» - фокус возвращается; Esc закрывает; ошибка валидации связана с полем.
3. Результаты длительных операций («The run is being sent», статус и счётчики) доступны скринридеру и не пропадают при потере связи («Could not refresh the run…»).
4. Предупреждения аномалий не передаются только цветом.
5. Масштаб 200 %, ширина 320 px, тёмная тема: суммы не обрезаются, горизонтального скролла страницы нет.
6. Скринридер и реальные устройства - вручную (EXT-10).

## 8. Автоматика, закрывающая тот же сценарий

| Область | Тест |
|---|---|
| Прогон от «New run» до «Sent» и счёт в карточке клиента | `web/e2e/billing.spec.ts`: «a monthly run is collected, approved and sent to PowerOffice» |
| Клиент без связи, отмена основания | `billing.spec.ts`: «a run without a PowerOffice customer reports the anomaly and can be cancelled» |
| Правка переживает пересборку, исключённая строка остаётся исключённой | `billing.spec.ts`: «a correction survives a new collect and a line left out stays out» |
| Утверждение привязано к ревизии | `billing.spec.ts`: «an approval belongs to the revision on screen and a change sets it aside with the reason» |
| Дополнительный прогон | `billing.spec.ts`: «a billed and closed month gets a supplementary run that bills nothing twice» |
| 15 000 NOK: доменный и API-уровень | `tests/Crm.UnitTests/BillingDomainTests.cs`: `The_total_is_the_sum_of_the_lines_after_discount`; `tests/Crm.IntegrationTests/BillingApiTests.cs`: `A_monthly_run_collects_contracts_licences_and_hours_then_exports_to_poweroffice` |
| Дочерний плательщик | `web/e2e/projects.spec.ts`: «a subsidiary can be put on the parent company invoice»; `tests/Crm.IntegrationTests/GroupAndIndexationTests.cs`: `A_subsidiary_billed_through_its_parent_lands_on_the_parent_invoice` |
| Индексация | `projects.spec.ts`: «finance previews the yearly indexation before the prices change» |
| Затраты Microsoft и прайс-лист NCE | `web/e2e/sales-licensing.spec.ts`: «microsoft cost lines are reconciled against what the customer was billed»; `web/e2e/catalog-contracts.spec.ts`: «the microsoft price sheet prices a draft price list after a preview» |
| Продукт и прайс-лист | `catalog-contracts.spec.ts`: «finance adds a product and prices it in a price list» |
| Подтверждение личности | `web/e2e/reverify.spec.ts`: «a refused privileged action opens the identity confirmation, which returns to the same page» |
| Порог и вторая подпись | `tests/Crm.IntegrationTests/BillingApprovalApiTests.cs`: `AC02_a_second_person_is_needed_only_when_a_customer_basis_is_strictly_above_200000_excluding_VAT` |

В UAT остаётся то, чего автоматика не умеет: **независимый ручной расчёт исполнителя** до просмотра CRM, понимание аномалий и причин реальным бухгалтером, соответствие описаний строк требованиям счёта клиента, работа со сложным реальным составом данных.
