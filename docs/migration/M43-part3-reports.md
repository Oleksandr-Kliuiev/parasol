# M43, часть 3 — месячные отчёты в документах клиента

Раздел для [M43-ONBOARDING-MONEY.md](M43-ONBOARDING-MONEY.md) (сливается туда). Ветка `feat/m43-part3-reports` от `b081311` (ветка M43);
только локальные коммиты, ничего не опубликовано. Рабочего аккаунта Huntress нет: всё проверено на синтетических данных, заглушке
`apps/crm/tools/dev-mocks/huntress.mjs` и WireMock.

## Что видит сотрудник

- **Вкладка клиента «Dokumenter» — раздел «Månedsrapporter»** под папкой SharePoint. Каждый месяц там появляются два PDF:
  «Huntress-rapport · september 2026» (отчёт самого Huntress) и «Parasoll-oppsummering · september 2026» (сводка Parasoll по
  клиенту). У строки — когда сохранено и размер, «Last ned»; сводка, сделанная позже, чем через 5 дней после конца месяца, помечена
  «Rekonstruert» с пояснением в подсказке. Под списком — фраза, что файл сверяется с отпечатком перед скачиванием; пустой список
  говорит, что отчёты появятся после первого прочитанного месяца. Раздел видят те, кто может видеть и клиента, и «Drift»
  (`customers.read` и `service.read`): отчёты описывают ИТ клиента.
- **«Drift» → «Sikkerhet» → «Månedsrapporter»:** рядом со ссылкой на PDF в Huntress — «Kopi i Parasoll», если отчёт уже сохранён:
  копия скачивается без входа в Huntress (нужен ли вход для ссылки Huntress — не проверено, M41).
- **Сводка Parasoll** (PDF, бокмол по умолчанию, английский — настройкой): оповещения месяца по источнику и важности (новые, решённые,
  открытые на конец месяца, итог), заявки servicedesk (создано, решено, открыто), устройства Atera на конец месяца (по дневному
  подсчёту), цифры месячного отчёта Huntress (инциденты, сигналы, агенты), состояние копий CloudAlly по службам (в копии, в порядке,
  не удалось, просрочено, пауза, не в копии) с временем чтения, отработанные и оплачиваемые часы. Только числа и даты: ни заголовков
  оповещений, ни имён устройств, ни людей, ни денег. Чего нет — сказано прямо («Ingen driftsvarsler i måneden.», «Ingen
  CloudAlly-konto koblet til kunden.»).

## Как устроено

### Документы клиента, которые хранит CRM (модуль Customers)

- Таблица `customers.StoredDocuments` (миграция `StoredDocuments`, только контекст Customers): организация, вид
  (`huntress-monthly` | `parasoll-monthly`), ключ источника (`huntress:report:{id}` | `parasoll:summary:{yyyy-MM}`), период, имя файла,
  тип, ключ объекта `customers/documents/{orgId:N}/{sha256}.pdf`, SHA-256, длина, происхождение (`Source`, `Captured`,
  `Reconstructed`), версия рендерера, когда сохранено. Уникальность — (организация, источник, хеш): повтор той же сдачи возвращает
  прежнюю строку. Внешнего ключа на организацию нет: строки неизменяемы, поэтому документы слитой организации остаются под ней и
  показываются у той, в которую её слили.
- Неизменяемость как у PDF счетов M37: `DENY UPDATE, DELETE` для `crm_runtime` (`CustomersDatabasePermissions`); объект кладётся
  create-only, перечитывается и сверяется (длина, SHA-256) **до** сохранения строки; объект, оставшийся от упавшей сдачи, принимается
  по тому же ключу (те же байты). Скачивание перечитывает объект и сверяет длину и хеш, иначе `CUS_DOCUMENT_INTEGRITY` (500, без
  байтов). Участник восстановления `customer-documents` проверяет байты каждой строки. Автоматической чистки сирот нет (как у M37).
- Контракт `ICustomerDocuments` (`FileAsync`, `FiledAsync`) в `Crm.Customers.Contracts/StoredDocumentContracts.cs`; чтение
  `GET /api/v1/customers/organizations/{id}/stored-documents` (keyset по месяцу и id, `totalCount`) и
  `…/stored-documents/{documentId}/download` (`no-store`, `nosniff`, `X-Document-Sha256`) — оба требуют `customers.read` **и**
  `service.read`.
- Исключение из FR-DOC-01 / SEC-GDPR-06b записано в `apps/crm/docs/02-functional-spec.md` и `06-security.md`: файлы клиента остаются в
  SharePoint, CRM хранит только то, что делает или получает сама (PDF предложений и счетов, месячные отчёты).

### PDF Huntress (`huntress-report-files`)

- Задание Worker `huntress-report-files` (`Integrations:Huntress:ReportFileSyncCron`, по умолчанию `55 4 * * *` — через 10 минут после
  `huntress-reports`): берёт месячные отчёты зеркала Security за `ReportMonths` (13) через новый контракт `ISecurityReports`, оставляет
  уже сохранённые, отчёты без ссылки и отчёты организаций, которые сейчас не связаны с тем же клиентом, и для остальных скачивает PDF и
  сдаёт его в документы клиента.
- Скачивает `HuntressReportFileClient` — **свой** HttpClient без учётных данных (клиент API Huntress шлёт Basic с ключом в каждом
  запросе; ему ссылки на файлы не доверяются), без автоматических переходов: не больше 3 перенаправлений вручную, каждый шаг — https
  (http только к loopback-заглушке) на хосте из `Integrations:Huntress:ReportFileHosts` (пусто = `huntress.io` с поддоменами).
  Ответ `text/html`/JSON (страница входа) — отказ; больше 30 МБ (по заголовку и по прочитанному) — отказ; не целый PDF — отказ.
  Относительный `Location` вида `/blobs/…` (на Linux/macOS он разбирается как файловый путь) решается от текущего шага.
- Отказ (хост, схема, переходы, статус 4xx, тип, размер, PDF) и сбой (5xx, 429, сеть) не останавливают остальные файлы, но считаются
  «не прочитано» (`SyncRun.Failed`): чтение неполное, `/connections` показывает задание как пробел, следующее чтение пробует снова.
  В сообщении прогона — числа и **только имена хостов** отказов (без адресов и текста ответа).
- Ссылка отчёта хранится, только если она https **или** http к loopback (`WebUrl.IsSecureEndpoint`; раньше — только https): иначе
  заглушка на `localhost` не давала бы ссылок.

### Сводка Parasoll (`reports-customer-months`, модуль Reports без своей схемы)

- `CustomerMonthReports` собирает месяц одного клиента из контрактов модулей: новый `IServiceMonthFacts` (оповещения по источнику и
  важности, заявки; счёт в SQL), `IServiceApi.GetDeviceCountReadingsAsync` (устройства на последний день), `ISecurityReports` (месячный
  отчёт Huntress), новый `IBackupFacts` (те же счётчики, что во вкладке «Sikkerhetskopi»), `ITimeTrackingApi.GetHoursByOrganizationAsync`
  (только часы; суммы не берутся). Рендер — `CustomerMonthPdf` на `PdfBuilder` (`RendererVersion = customer-month-pdf/1`; каждое поле
  целиком, таблица переносится с повтором шапки; числа без символов вне WinAnsi). Язык — `Reports:CustomerMonthLanguage` (`nb`|`en`;
  нюношк читает бокмол).
- Задание Worker `reports-customer-months` (ежедневно в 05:20 по Осло): прошлый месяц для обслуживаемых клиентов — договор в силе в
  месяце или записи связанных Atera/Huntress/CloudAlly (зеркала хранят только связанных), — у которых сводки ещё нет. Сводка
  сдаётся один раз и **никогда не перерисовывается**. В пределах `Reports:SnapshotTimelyDays` (5) после конца месяца —
  `Captured`, позже — `Reconstructed` с пометкой под заголовком и в колонтитуле каждой страницы (ADR-022). Каждый клиент — в своём
  DI-scope: сбой одного (логируется по id) не мешает остальным.

### Заглушка

`/huntress/v1/reports` отдаёт ссылку на саму заглушку `/huntress-files/reports/{id}.pdf` (на том хосте, куда пришёл запрос), она
отвечает `302` на `/huntress-blobs/{id}.pdf?disposition=download` — небольшой целый одностраничный PDF; ключ API не нужен, сбой
задаётся через `/_mock/huntress/faults`. В e2e `--Integrations:Huntress:ReportFileHosts:0=localhost`, cron файлов — «никогда».

## Проверка (часть 3)

| Проверка | Итог |
| --- | --- |
| `dotnet build Vardahei.Crm.slnx` | 0 предупреждений, 0 ошибок |
| Unit (`Crm.UnitTests`) | 1271 из 1271 (новые: `CustomerMonthPdfTests`, `HuntressReportFileClientTests`, `StoredDocumentTests`) |
| Architecture | 108 из 108 |
| SQL, фильтр по затронутым классам | 36 из 36 за 37 с: `StoredDocumentTests` (сдача, повтор, страницы, слияние, `DENY` → 229, подмена и удаление файла → 500 и участник восстановления), `HuntressReportFileTests` (перенаправление, без ключа, повтор не качает; чужой хост и страница входа → неполное чтение, следующий прогон сдаёт), `CustomerMonthReportTests`, `ConnectionStatusApiTests`, `HuntressSyncTests`, `AccessAndConcurrencyTests`, `RestoreReconciliationTests`, `RequestHardeningTests` |
| vitest (документы, безопасность, i18n, «Drift») | 43 из 43; lint и типы чисто |
| e2e | `web/e2e/monthly-reports.spec.ts` написан (`@critical`: три задания → обе строки, скачивание из вкладки и из «Sikkerhet»; 320 px и клавиатура), **не запускался** — его запускает итоговая приёмка M43 |

## Риски

- **Ссылка на PDF Huntress не проверена на рабочем аккаунте:** куда она перенаправляет (хост хранилища файлов) и нужен ли вход.
  По справочнику это «прямая ссылка на PDF» на huntress.io; при перенаправлении на хост вне `ReportFileHosts` файл не сдаётся,
  прогон неполный, в сообщении — имя хоста: его надо добавить в настройку. Страница входа вместо файла отклоняется по типу.
- **Хранение и персональные данные:** PDF Huntress может называть хосты и учётные записи людей клиента. Срок хранения не утверждён
  (EXT-07; предложение — пока длятся отношения), класса хранения нет: строки и файлы неизменяемы, удаление — операторская
  процедура, которой пока нет (как у `sales.ClearErasedDocuments`). Записано в `04-data-model` § 8 и § 9.
- **Сводка за прошлый период «Reconstructed»:** решённые оповещения и закрытые инциденты могут уйти по сроку хранения, копии видны
  на момент сводки — так и написано в документе. Первая сводка после развёртывания чаще всего будет «Rekonstruert».
- **Объём:** сводка — один PDF на обслуживаемого клиента в месяц (~40), отчёт Huntress — один на связанную организацию; сироты
  после упавшей сдачи не чистятся (как у M37).
- **Откат:** прежний релиз не знает таблицы `customers.StoredDocuments` и не читает её; заданий `huntress-report-files` и
  `reports-customer-months` в нём нет — Hangfire оставит их записи без исполнителя до удаления.
