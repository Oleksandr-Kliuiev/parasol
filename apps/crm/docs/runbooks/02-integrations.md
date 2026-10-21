# Runbook 02. Подключение PowerOffice Go и Atera

Ключи API — секреты. Не пересылайте их в чатах и письмах, не коммитьте в репозиторий: локально — `dotnet user-secrets`, в Azure — Key Vault.

Свежесть, ответственные, разбор исключений и подтверждение retry/replay описаны в [runbook 15](15-monitoring.md). Failed/skipped и проверка соединения не обновляют время успешной синхронизации. Доставка алертов и реальные владельцы проверяются по EXT-01.

## 1. PowerOffice Go (демо-среда)

### 1.1 Ключи
| Ключ | Где взять | Конфигурация | Секрет в Key Vault |
|---|---|---|---|
| Application Key | developer.poweroffice.net → приложение CRM | `Integrations:PowerOffice:ApplicationKey` | `poweroffice-application-key` |
| Subscription Key | developer.poweroffice.net → профиль → подписка | `Integrations:PowerOffice:SubscriptionKey` | `poweroffice-subscription-key` |
| Client Key | PowerOffice Go (демо-клиент) → Settings → Integrations → добавить интеграцию CRM | `Integrations:PowerOffice:ClientKey` | `poweroffice-client-key` |

### 1.2 Локально
Секреты общие для crm-web и crm-worker (одинаковый `UserSecretsId`):
```bash
dotnet user-secrets set "Integrations:PowerOffice:Enabled" "true" --project src/Hosts/Crm.Web
```
```bash
dotnet user-secrets set "Integrations:PowerOffice:ApplicationKey" "<application key>" --project src/Hosts/Crm.Web
```
```bash
dotnet user-secrets set "Integrations:PowerOffice:ClientKey" "<client key>" --project src/Hosts/Crm.Web
```
```bash
dotnet user-secrets set "Integrations:PowerOffice:SubscriptionKey" "<subscription key>" --project src/Hosts/Crm.Web
```
`Environment` по умолчанию `Demo` (`https://goapi.poweroffice.net/Demo/v2`).

### 1.3 Первая загрузка (миграция клиентов)
1. Администрирование → **Интеграции** → PowerOffice Go → **Проверить подключение**.
2. Запустить вручную задачи «Клиенты (PowerOffice)», «Контактные лица», «Продукты».
3. **Сопоставления** → PowerOffice Go → Клиенты:
   - клиенты с оргномером, который уже есть в CRM, связываются автоматически;
   - **Связать точные совпадения** — повторно для ранее импортированных;
   - **Импортировать все несвязанные…** — сначала показывает предпросмотр; записи, похожие на существующие организации без совпадения оргномера, пропускаются и остаются для ручного решения (**Связать с …**, **Выбрать организацию…** или **Создать в CRM**).
4. То же для контактных лиц: сначала связываются по e-mail, остальные импортируются в связанные организации.
5. Продукты: **Сопоставления** → PowerOffice Go → Продукты. Продукты, у которых артикул в CRM совпадает с кодом в PowerOffice, предлагаются и связываются кнопкой **Связать точные совпадения**; недостающие можно импортировать в каталог (тип и единица — по умолчанию, проверьте в карточке продукта). У каждого продукта, выставляемого через PowerOffice, в карточке должна быть связь.

### 1.4 Запись в PowerOffice
По умолчанию CRM только читает. Проверка в демо-клиенте:
1. `Integrations:PowerOffice:WriteEnabled=true`.
2. В карточке организации без связи → **Создать в PowerOffice Go**; через минуту клиент появится в Go (поле External import reference = `crm:<id>`), связь — «создано в системе».
3. Изменить телефон связанной организации в CRM → в Go меняется только телефон (JSON Patch по изменённым полям).
4. Контакт с ролью «Счета» у связанной организации создаётся в Go как контактное лицо (External code = `crm:<id>`); смена e-mail в CRM отправляет в Go только e-mail.
5. Очередь изменений и ошибки — Интеграции → «Изменения, отправляемые в другие системы» (повтор/отмена).

### 1.5 Выгрузка биллинга (S7)
Перед первым прогоном на реальном клиенте PowerOffice:
- [ ] `Integrations:PowerOffice:WriteEnabled=true` (иначе выгрузка отклоняется с понятной причиной в журнале основания);
- [ ] клиенты, которых выставляем, связаны с клиентами PowerOffice (экран «Сопоставления»), продукты — с продуктами PowerOffice;
- [ ] артикул продукта CRM совпадает с кодом продукта в PowerOffice: именно артикул уходит в строку заказа;
- [ ] подтвердить вариант выгрузки с заказчиком: заказы на продажу (по умолчанию) или черновики исходящих счетов — второй вариант меняет только обработчик, модель основания та же;
- [ ] проверить на одном клиенте: прогон → утверждение → заказ в Go → выставление счёта → синхронизация счёта обратно (номер, срок, остаток);
- [ ] повторно запустить «Отправить снова» и убедиться, что второго заказа не появилось (внешняя ссылка `{период}-{клиент}-{прогон}`);
- [ ] решить, кто закрывает прогон и когда: закрытый прогон нельзя пересобрать.

### 1.6 Мастер реквизитов для счетов
`Customers:BillingDetailsMaster`:
- `Crm` (по умолчанию) — e-mail для счетов, EHF и адрес для счетов редактируются в CRM и отправляются в PowerOffice;
- `PowerOffice` — эти поля в CRM только для чтения и обновляются из PowerOffice при синхронизации.

Решение отложено заказчиком; переключение не требует миграции данных.

## 2. Atera

### 2.1 Ключ
Atera → Admin → API → скопировать ключ. Ключ даёт полный доступ к аккаунту (включая RMM): только администратор, хранение в Key Vault (`atera-api-key`), ротация раз в 6 месяцев.

```bash
dotnet user-secrets set "Integrations:Atera:Enabled" "true" --project src/Hosts/Crm.Web
```
```bash
dotnet user-secrets set "Integrations:Atera:ApiKey" "<api key>" --project src/Hosts/Crm.Web
```

### 2.2 Проверка (PoC) до включения записи
У Atera нет песочницы, а публичная спецификация закрыта логином. Чтение устойчиво к разным именам полей; перед `WriteEnabled=true` подтвердить на реальном ключе:
- [ ] «Проверить подключение» успешно, задачи «Клиенты (Atera)» и «Контакты (Atera)» читают все страницы;
- [ ] у контактов заполнены имя, e-mail и клиент (поля `EndUserID`/`ContactID`, `Firstname`/`FirstName`);
- [ ] создание клиента (`POST /customers`) возвращает id в `ActionID`;
- [ ] обновление клиента — `PUT /customers/{id}`;
- [ ] для первой проверки задать `Integrations:Atera:WriteAllowedCustomerIds` = id тестового клиента;
- [ ] тикеты: задача «Тикеты (Atera)» читает страницы (`GET /tickets?ticketStatus=Open`), в карточке клиента видны открытые тикеты со ссылкой в Atera;
- [ ] недавние тикеты: задача «Тикеты за период» доходит до 60 дней назад и останавливается (если API отдаёт тикеты не от новых к старым — увеличить `RecentTicketDays` или оставить полный проход);
- [ ] часы: `GET /tickets/{id}/workhoursrecords` возвращает длительность, признак «оплачиваемая» и техника; записи появляются в «Учёте времени» со статусом «Новая»;
- [ ] техники: в «Администрирование → Техники» появились записи; сопоставить их с пользователями CRM (по e-mail сопоставляются автоматически);
- [ ] устройства: задача «Устройства (Atera)» разносит агентов по клиентам, типы (рабочая станция/сервер/сеть) определяются верно;
- [ ] алерты: `GET /alerts?alertStatus=Open` читает все страницы; во вкладке «Drift» и очереди `/alerts` видны только Critical и Warning сопоставленных клиентов; оповещение, закрытое в Atera, после следующего полного чтения становится решённым ([05 §3.5](../05-integrations.md#35-оповещения-жизненный-цикл-m38)); ссылку на оповещение включать (`AlertUrlTemplate`) только после проверки адреса страницы в Atera;
- [ ] создание тикета: из карточки клиента (`POST /tickets`, при необходимости `POST /contacts`) — сначала на тестовом клиенте из `WriteAllowedCustomerIds`;
- [ ] уровень SLA: создать в Atera поле клиента (Admin → Custom fields → Customer), указать его имя в `Integrations:Atera:SlaCustomFieldName`, активировать контракт с SLA у тестового клиента — значение появляется в поле (`GET/PUT /customvalues/customerfield/{customerId}/{fieldName}`, тело `{"Value": "..."}`).

### 2.3 Первая загрузка
Как для PowerOffice (§1.3): синхронизация → автосвязь по оргномеру (поле BusinessNumber в Atera) → ручное сопоставление остальных. Импорт клиентов Atera в CRM возможен, но рекомендуется сначала загрузить клиентов из PowerOffice (финансовый мастер), затем сопоставить Atera.

## 3. Microsoft Partner Center (CSP)

### 3.1 Доступ
Нужен refresh token по Secure Application Model (см. [05 §2.2](../05-integrations.md#22-аутентификация--secure-application-model)): мульти-тенантное приложение партнёра + сервисный аккаунт с MFA. Токен и ключи приложения хранятся в Key Vault, локально — в `user-secrets`. Ключи не передаются в переписке и не попадают в журналы.

**Azure (DEV-21, F-G4-02).** Два секрета Key Vault: `partnercenter-client-secret` и `partnercenter-refresh-token`. Включение — переменные окружения GitHub `CRM_ENABLE_PARTNERCENTER=true`, `CRM_PARTNERCENTER_TENANT_ID`, `CRM_PARTNERCENTER_CLIENT_ID` (идентификаторы, не секреты). Bicep выдаёт `crm-worker` (и только ему) роль чтения на каждый из этих двух секретов и передаёт значения контейнеру как ссылки Key Vault; оба секрета должны существовать в хранилище до включения (так же, как секреты PowerOffice и Atera). Не проверено на реальном развёртывании. `crm-web` их не получает.

Ограничения, которые остаются на стороне приложения: (1) приложение читает refresh-токен, но **не записывает обратно** новый токен, выданный при обмене, — оператор следит за сроком токена и при отказе повторяет согласие сервисного аккаунта и обновляет секрет; (2) вход по client secret, а не сертификатом (SEC-AUTH-05) — замена требует изменения кода.

```bash
dotnet user-secrets set "Integrations:PartnerCenter:Enabled" "true" --project src/Hosts/Crm.Worker
dotnet user-secrets set "Integrations:PartnerCenter:TenantId" "<partner tenant id>" --project src/Hosts/Crm.Worker
dotnet user-secrets set "Integrations:PartnerCenter:ClientId" "<app id>" --project src/Hosts/Crm.Worker
dotnet user-secrets set "Integrations:PartnerCenter:ClientSecret" "<secret>" --project src/Hosts/Crm.Worker
dotnet user-secrets set "Integrations:PartnerCenter:RefreshToken" "<refresh token>" --project src/Hosts/Crm.Worker
```

### 3.2 Проверка (PoC) до расширения интеграции
Ответы Partner Center читаются защитно (отсутствующие поля → `Unknown`), но модель участия и часть полей подтверждаются только на живом ключе:
- [ ] задача «Клиенты (Partner Center)» читает все страницы `GET /v1/customers` (continuation token) и показывает CSP-клиентов на экране «Сопоставления»;
- [ ] задача «Подписки (Partner Center)» заполняет экран «Лицензии»: количество, срок (`P1M`/`P1Y`/`P3Y`), период выставления, автопродление, дата продления;
- [ ] у новой подписки окно отмены (168 ч) открыто, у исторической — закрыто; повторный прогон не меняет записи (изменения определяются по хешу);
- [ ] автосвязь с организациями: сопоставленный CSP-клиент → другая подписка того же клиента → точное совпадение по орг. номеру; неоднозначные попадают в предупреждения и сопоставляются вручную;
- [ ] уточнить модель участия (direct bill или indirect reseller) — от неё зависит источник цен партнёра: Price sheet API или выгрузка дистрибьютора;
- [ ] подтвердить `GET /v1/customers/{id}/subscribedskus` (куплено/использовано) — при отказе остаётся Graph через GDAP.

Запись в Partner Center (заказы NCE, изменение количества, отмена в окне) в R1 не реализована. До PoC отмена выполняется в Partner Center вручную; CRM только показывает, когда закрывается окно.

### 3.3 Лицензии в тенантах клиентов (GDAP) и сверка с Microsoft
Задание «Лицензии (Partner Center)» (`50 2 * * *`) читает `subscribedskus` у сопоставленных CSP-клиентов и раз в сутки пишет «куплено / назначено» по SKU. Смотреть — «Лицензии» → вкладка «Использование лицензий»; переключатель «Только неиспользуемые 30 дней» показывает то, что можно сократить (BR-LIC-04). Тенант без живой GDAP-связи отвечает 403/404 и просто остаётся без записи за день — проверьте GDAP-связь и роль `Directory Readers` у группы партнёра.

Эти же числа берёт биллинг для позиций `PerM365User`: если снимка нет, прогон считает по оценке из контракта и помечает позицию `BIL_ESTIMATED_QUANTITY`.

Сверка затрат Microsoft (FR-LIC-04) — «Лицензии» → «Сверка с Microsoft» (право `finance.cost.read`):
- **direct bill:** включить `Integrations:PartnerCenter:BillingReconciliationEnabled=true`; задание `partnercenter-billing` (`20 4 * * *`) запрашивает экспорт `billed reconciliation` в Graph по счетам за два последних месяца, ждёт операцию и загружает строки. Файлы экспорта скачиваются без токена Graph и только по https-ссылкам с SAS-подписью на хостах `Integrations:PartnerCenter:BillingStorageHostSuffixes` (не задан — всё `blob.core.windows.net`). Список (`…:BillingStorageHostSuffixes:0`, `:1`, …) заменяет это значение целиком, поэтому в нём перечисляются все нужные хосты; после первой успешной выгрузки на тенанте его стоит сузить до учётных записей хранилища, которые отдал Microsoft. Если запуск падает с `PartnerBillingLinkRefusedException` (запись запуска, журнал и Hangfire хранят только имя типа, ссылка никуда не пишется), Microsoft отдал ссылку на хост вне Graph и вне списка: убедиться по документации Microsoft, что хост принадлежит хранилищу экспорта, и добавить его в список; адрес Graph не расширять. По записи запуска причину не различить, поэтому смотрят сам ответ Microsoft (операцию и манифест): если в манифесте нет `rootDirectory` или он относительный, адрес файла оказался бы на Graph, и список тут не поможет — это расхождение с контрактом Microsoft (docs/05 § 2.4);
- **indirect:** загрузить файл затрат дистрибьютора кнопкой «Импорт счёта Microsoft» — «Предпросмотр» показывает, что появится, и сколько строк не нашли клиента.

Повторная загрузка того же файла (и повторный запуск задания) ничего не дублирует: строка идентифицируется ключом `источник:счёт:подписка:предложение:период`. Строка «Не выставлено» в отчёте означает, что за месяц клиенту не выставлено ни одной лицензионной позиции — обычно это отсутствующая позиция контракта.

### 3.4 Прайс-лист Microsoft (NCE)
Каталог → «Прайс-листы» → черновик прайс-листа → «Импорт прайс-листа» (право `finance.cost.read`). Укажите курс (крон за единицу валюты файла); наценка берётся из категории клиента, если поле пустое. «Предпросмотр» показывает новые цены и сколько предложений не нашли продукта — продукты сопоставляются по Microsoft offer id (`ProductId:SkuId` в файле NCE), строка выбирается по сроку обязательства продукта (`P1M`/`P1Y`/`P3Y`). Записывается только в черновик: активный прайс-лист сначала деактивируют.

### 3.5 Импорт от дистрибьютора
Экран «Лицензии» → «Импорт от дистрибьютора»: загрузить CSV или вставить строки, «Предпросмотр» показывает, сколько подписок будет создано, обновлено и оставлено без изменений, и перечисляет проигнорированные столбцы. Поддерживаемые заголовки — [05 §6](../05-integrations.md#6-дистрибьютор-csp-если-индирект). Импорт требует роли с `licensing.manage` (Admin) и записывается в журнал аудита.

## 4. Уведомления по e-mail (S8)

### 4.1 Общий ящик и разрешение
1. Создать общий ящик, например `crm@<домен>` (без лицензии, только для отправки).
2. Дать управляемой идентичности crm-worker `id-crm-worker-<env>` (сводку отправляет worker) разрешение Graph `Mail.Send` (Application) и **ограничить его этим ящиком** через RBAC for Applications в Exchange Online:
   ```powershell
   New-ServicePrincipal -AppId <appId> -ServiceId <objectId> -DisplayName "Vardahei CRM"
   New-ManagementScope -Name "CRM mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'crm@<домен>'"
   New-ManagementRoleAssignment -App <appId> -Role "Application Mail.Send" -CustomResourceScope "CRM mailbox"
   ```
3. Настройки CRM (Key Vault или переменные окружения контейнера):
   ```bash
   dotnet user-secrets set "Notifications:EmailEnabled" "true" --project src/Hosts/Crm.Worker
   dotnet user-secrets set "Notifications:FromAddress" "crm@<домен>" --project src/Hosts/Crm.Worker
   dotnet user-secrets set "Notifications:AppBaseUrl" "https://crm.<домен>" --project src/Hosts/Crm.Worker
   ```

### 4.2 Проверка
- [ ] задача «Уведомления: обход» (`notification-scan`) создаёт уведомления: активируйте контракт, который истекает через 30 дней, и запустите `contract-lifecycle` — колокольчик у ответственного показывает запись;
- [ ] поставьте в настройках уведомлений текущий час и запустите `notification-digest` — письмо приходит в ящик получателя, а запись получает статус «отправлено»;
- [ ] выключите `Notifications:EmailEnabled` и убедитесь, что новые уведомления помечаются «не отправлено» и остаются в CRM;
- [ ] отключите вид уведомления в настройках и проверьте, что он больше не попадает в письмо;
- [ ] письма не оседают в «Отправленных» общего ящика (`saveToSentItems: false`).

## 4a. Отправка предложений из ящика продавца (S9)

### 4a.1 Разрешение и настройки
1. Собрать продавцов, которые отправляют предложения, в почтовую группу безопасности, например `crm-quote-senders@<домен>`.
2. Дать управляемой идентичности crm-web `id-crm-app-<env>` (предложение отправляется из web) `Mail.Send`, ограниченный этой группой (общий ящик из §4.1 ей не нужен):
   ```powershell
   New-ManagementScope -Name "CRM quote senders" -RecipientRestrictionFilter "MemberOfGroup -eq 'CN=crm-quote-senders,...'"
   New-ManagementRoleAssignment -App <appId> -Role "Application Mail.Send" -CustomResourceScope "CRM quote senders"
   ```
   Если такая политика неприемлема, оставьте отправку выключенной: продавец скачивает PDF и отправляет его из Outlook сам (функционально то же письмо).
3. Настройки CRM — выключатель и шапка документа (шапка попадает в PDF, поэтому её задают до первого предложения):
   ```bash
   dotnet user-secrets set "Sales:EmailEnabled" "true" --project src/Hosts/Crm.Web
   dotnet user-secrets set "Sales:Company:Name" "Vardahei AS" --project src/Hosts/Crm.Web
   dotnet user-secrets set "Sales:Company:OrgNumber" "<оргномер>" --project src/Hosts/Crm.Web
   dotnet user-secrets set "Sales:Company:Street" "<адрес>" --project src/Hosts/Crm.Web
   dotnet user-secrets set "Sales:Company:PostalCode" "<пост. код>" --project src/Hosts/Crm.Web
   dotnet user-secrets set "Sales:Company:City" "<город>" --project src/Hosts/Crm.Web
   dotnet user-secrets set "Sales:Company:Email" "salg@<домен>" --project src/Hosts/Crm.Web
   dotnet user-secrets set "Sales:Company:Phone" "<телефон>" --project src/Hosts/Crm.Web
   ```
4. Предел скидки без согласования — `Sales:DiscountLimitPercent` (по умолчанию 15 %), срок действия предложения по умолчанию — `Sales:QuoteValidityDays` (30 дней) или срок из шаблона.

### 4a.2 Проверка
- [ ] шаблоны на экране «Шаблоны предложений» содержат реквизиты и условия компании (после правки текст новых предложений меняется, старые остаются как были);
- [ ] предложение со скидкой выше предела уходит на согласование, и PDF до согласования недоступен;
- [ ] PDF открывается в читалке, норвежские буквы и суммы на месте, в колонтитуле — номер страницы;
- [ ] отправка приходит клиенту, письмо лежит в «Отправленных» у продавца, а ответ возвращается продавцу;
- [ ] при выключенном `Sales:EmailEnabled` кнопка отправки объясняет, что письма отключены, и PDF по-прежнему скачивается.

## 4b. Microsoft 365 для сотрудников (S10)

### 4b.1 Календарь и почта (делегированно)
1. В регистрации приложения `Vardahei CRM` добавить делегированные разрешения `Calendars.ReadWrite` и `Mail.Read` и выдать согласие администратора (иначе каждый сотрудник увидит «не подключено»).
2. Включить функции: `Integrations:MicrosoftGraph:CalendarEnabled=true`, `:MailEnabled=true`.
3. Общие ящики, которые нужно просматривать в карточке клиента, перечислить в `Integrations:MicrosoftGraph:SharedMailboxes` (сотрудник должен иметь к ним доступ в Exchange; иначе ящик просто пропускается).
4. Проверка: у встречи включить «Добавить в мой календарь Outlook» — событие появляется в Outlook с приглашением контакта; перенести встречу в Outlook и нажать «Получить изменения из Outlook» — время в CRM меняется; вкладка «Почта» показывает переписку, «Сохранить в CRM» создаёт активность-письмо со ссылкой.

### 4b.2 Документы в SharePoint
1. Создать сайт «Kunder» и библиотеку «Dokumenter».
2. Дать управляемым идентичностям `id-crm-worker-<env>` (создаёт и переименовывает папки) и `id-crm-app-<env>` (вкладка «Документы») разрешение `Sites.Selected` и выдать каждой доступ **только к этому сайту**:
   ```http
   POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
   { "roles": ["write"], "grantedToIdentities": [ { "application": { "id": "<appId>", "displayName": "Vardahei CRM" } } ] }
   ```
3. Узнать идентификаторы: `GET /sites/{домен}:/sites/Kunder` → `id`; `GET /sites/{siteId}/drives` → `id` библиотеки.
4. Настройки: `Integrations:MicrosoftGraph:SharePoint:Enabled=true`, `:SiteId`, `:DriveId` (или `:DriveName`, по умолчанию `Dokumenter`).
5. Проверка: сделать организацию клиентом — папка `Название (оргномер)` появляется в библиотеке; переименовать организацию — папка переименовывается; вкладка «Документы» показывает содержимое и открывает SharePoint.

### 4b.3 Сообщения в каналы Teams
1. В каждом канале («Salg», «Økonomi», «Drift») создать поток Power Automate «When a Teams webhook request is received» и скопировать URL (это секрет — в Key Vault; сообщения отправляет worker, поэтому секрет получает только он — [runbook 08 §3](08-database-permissions.md#3-новый-модуль-таблица-или-секрет)). Секреты Key Vault: `teams-webhook-sales`, `teams-webhook-finance`, `teams-webhook-operations`; включение — переменная окружения GitHub `CRM_ENABLE_TEAMS=true` (Bicep передаёт `Integrations__MicrosoftGraph__Teams__Channels__*` ссылками Key Vault только `crm-worker`; все три секрета должны существовать).
2. Настройки (вне Azure/локально): `Integrations:MicrosoftGraph:Teams:Enabled=true`, `:Channels:Sales`, `:Channels:Finance`, `:Channels:Operations`, порог `:WonDealThreshold` (по умолчанию 100 000 NOK).
3. Проверка: выиграть сделку дороже порога — карточка появляется в «Salg»; утвердить биллинг-прогон — карточка в «Økonomi».

## 5. Azure
1. Создать секреты в Key Vault (временно открыв доступ, как в [runbook 01 §5](01-first-deployment.md#5-сертификат-приложения-учётные-данные-вместо-client-secret)).
2. Переменные GitHub окружения: `CRM_ENABLE_POWEROFFICE=true`, `CRM_ENABLE_ATERA=true`, `CRM_ENABLE_PARTNERCENTER=true` (+ `CRM_PARTNERCENTER_TENANT_ID`, `CRM_PARTNERCENTER_CLIENT_ID`), `CRM_ENABLE_TEAMS=true`. Среда PowerOffice не переменная: она зафиксирована в `infra/env/*.bicepparam` (test — Demo, prod — Production).
3. Выкатить через `release.yml`/`promote.yml` (DEV-05, ADR-015). `WriteEnabled` включается настройкой `Integrations__PowerOffice__WriteEnabled` / `Integrations__Atera__WriteEnabled`; в `infra/modules/apps.bicep` такой переменной нет (по умолчанию выключено), поэтому её нужно добавить в шаблон и в `infra/env/*.bicepparam`, иначе следующая выкладка вернёт значение по умолчанию. Включать только после проверки в нужной среде.
