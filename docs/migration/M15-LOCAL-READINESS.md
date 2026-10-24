# M15 — локальная готовность подключений

Разработка выполняется локально. Экран не проверяет рабочие аккаунты и не запускает
синхронизацию. Цель — дать сотруднику понятную сводку того, что настроено в Parasol,
что известно из сохранённых результатов и какие связи клиентов требуют разбора.

## Рабочий сценарий и права

Страница `/connections` доступна при `parasol.atlas.read` **или** `integrations.manage`.
`GET /api/v1/parasol/local-readiness` проверяет те же права и возвращает `no-store`.
Ни HTTP boundary, ни reader не выводят доступ из названия роли.

- Сотрудник с AtlasRead видит только присутствие своей личной конфигурации Atlas:
  `DISABLED`, `PERSONAL_ENTRY_PRESENT` или `PERSONAL_ENTRY_MISSING`. Значения токенов,
  workspace IDs и наличие конфигурации других сотрудников не выводятся.
- IntegrationsManage открывает административную сводку локальных флагов Atera,
  PowerOffice и Microsoft Graph и сохранённых результатов. Проверка mappings дополнительно
  требует CustomersRead. Отсутствующий доступ означает `null`, а не нулевые счётчики.
- Finance/Sales без этих permissions получают отказ. Роли и их permission matrix не расширяются.

На странице нет действий test, sync, pause, edit или изменения credentials. Ручное обновление
получает новый локальный результат; автоматического polling/retry нет. Смена сотрудника,
permissions, refresh или ошибка убирают прежние сведения. Кнопка остаётся доступной
для клавиатурного фокуса во время чтения и блокирует повторный запрос.

## Что означает локальная готовность

Ответ имеет `scope: LOCAL_ONLY`, `connectivity: NOT_CHECKED` и статус `LOCAL_SNAPSHOT`
либо `PARTIAL`. Наличие настройки или прошлый успех не означает `CONNECTED`, `HEALTHY`
или действующий доступ к провайдеру. Entra-вход отделён от Graph monitoring.

Web читает только типизированные флаги включённости и разрешения записи. Credentials
Atera/PowerOffice могут находиться в Worker; их отсутствие в Web не используется для
вывода об ошибке подключения. Показанные флаги относятся к конфигурации Web; у Worker
может быть отдельная конфигурация. Они не описывают его фактическую текущую включённость.
Teams показывает свой флаг независимо от Graph.Enabled.
Huntress обозначен как управляемый Atlas с неизвестной локальной конфигурацией.

Сохранённые provider states включают paused, lastSucceededAt, records/unlinkedRecords,
pendingOutbound/failedOutbound. Graph отдельно показывает последний сохранённый успех
`entra-user-sync` и `entra-role-sync`. Учитывается фиксированный allowlist систем/потоков;
connection-test и посторонние job names не подменяют последний sync success.
Messages, pause reasons, cursors, URL, payload и credentials исключены из DTO.

## Ограниченная проверка связей

Диагностика относится только к сохранённому локальному реестру `Atlas/Client`.
Она не знает полного каталога провайдера, существования клиента в Atlas или текущего
доступа сотрудников к нему. Даже пустой реестр не означает, что все клиенты сопоставлены.

Проверяются максимум 500 links в детерминированном порядке. DTO содержит:

- `coverage`: storedLinks, examinedLinks, omittedLinks, unlinkedStoredReferences;
- `counts`: validLinks, invalidIdentities, missingReferences, goneReferences,
  invalidReferences, unavailableCustomers;
- `status`: CHECKED, INCOMPLETE, CHANGED или UNAVAILABLE;
- `reviewStatus`: NO_LOCAL_ISSUES_FOUND, REQUIRED или UNKNOWN.

Шесть взаимоисключающих счётчиков в сумме равны examinedLinks; storedLinks равен examinedLinks
плюс omittedLinks. Проверяются canonical lowercase hash, точная ordinal namespace/tuple,
строгий bounded JSON reference, IsGone, live CRM organization и дубликаты. Дубликаты для
выбранных keys/entities обнаруживаются и среди записей за пределами первых 500.
Live означает существующую запись с учётом фильтра удаления/слияния, а не бизнес-статус Active.

Сохранённые ссылки без links показываются как повод для ручного разбора; они могут быть
намеренно не сопоставлены. Превышение лимита также требует разбора. NO_LOCAL_ISSUES_FOUND
возможно только при полном локальном охвате без выявленных проблем и не означает здоровье
источника или проверенную общую полноту связей.

Перед публикацией повторно проверяются локальные входные данные и live CRM IDs. Изменение
даёт CHANGED/UNKNOWN без прежних счётчиков. Это повторная проверка на момент чтения,
а не распределённый неизменяемый snapshot. SQL failure/deadline дают UNAVAILABLE/UNKNOWN.

Reader ограничен пятью секундами, mapping — тремя в пределах общего бюджета. Все EF/module
чтения получают cancellation token. Provider/Atlas HTTP, собственных retries и фоновых
jobs нет; глобальная SQL execution strategy может повторять transient SQL queries
в пределах переданного cancellation budget.

## Проверки

| Проверка | Результат на 16 октября 2026 |
| --- | --- |
| M15 backend unit | 35/35, без пропусков |
| M15 SQL Server | 17/17 плюс 2/2 auth-mode регрессии, без пропусков; роли, classifications/cap, удаление, изменение реестра, отсутствие endpoint writes и HTTP |
| Повтор M14/identity | M14 unit 29/29 и SQL 10/10; identity unit 5/5, без пропусков |
| Web/Worker/Unit Release | 0 warnings/errors, сборка текущих исходников |
| CRM architecture | 94/94, без пропусков |
| Frontend | Полный набор после M17 415/415, 50 файлов; после последней правки фокуса карточки/очереди отдельно 56/56; 0 skipped/errors; TypeScript/ESLint/SPA проходят, 290,5/300 KB |
| Браузер | Итоговый совместный набор 38/38, 0 skipped/retried; три движка, обе темы, клавиатура, узкий экран и прямой contrast ratio статусов; cleanup подтверждён |
| Настоящий локальный composition | [Текущий полный запуск](../testing/evidence/composition-current-2026-10-16.json): 8/8, новая сборка в том же запуске, точные SQL/privacy/role evidence и cleanup подтверждены |

Независимая проверка обнаружила гонку inventory: два SQL commands могли вернуть
unlinkedRecords больше records при вставке между чтениями. Оба значения теперь вычисляются
одним grouped inventory query; детерминированный SQL interceptor проверяет вставку сразу
после чтения и следующий refresh 0/0 → 1/1. Frontend invariant не ослаблен.

Настоящий composition выявил, что новый flags adapter читал незарегистрированный
IOptions<CrmAuthOptions> вместо singleton, используемого аутентификацией. Поэтому сводка
ошибочно сообщала ENTRA при действующем Development-входе. Adapter теперь читает тот же
фактический singleton; SQL-регрессии реального host проверили ENTRA и DEVELOPMENT, 2/2.
Ожидаемый DEVELOPMENT в composition сохранён. Authentication flow и данные доступа не менялись.
Первый полный прогон получил 7/8; последующие полные прогоны прошли 8/8. Сохранённое
текущее свидетельство относится к последнему запуску после M17/M18 и правки фокуса карточки/очереди.

Два промежуточных полных frontend-прогона получили отсутствующий dialog в разных прежних
тестах Privacy/Identity (378/379 каждый); их логи сохранены, эти тесты byte-identical.
Диагностика отдельно доказала конфликт двух Keyborg implementations: Fluent использовал
2.14.1, Tabster — 3.498.0; обе копии регистрировали owner k1 в одном window. Конфликт
присутствовал и в production bundle. Проверка API/call sites позволила выбрать уже установленную
3.498.0 через точный npm override. Lock изменил только hoisted Keyborg и удалил его nested
duplicate, новых packages нет; reification прошёл offline/ignore-scripts.

Две новые регрессии проверяют фактическую identity модуля у обоих consumers, двух независимых
owners/callbacks, оба порядка dispose и восстановление focus descriptor без скрытия ошибок.
Итоговый полный набор прошёл 381/381 с нулём Keyborg warnings, в bundle одна реализация.
Причинная связь прежнего missing-dialog failure именно с конфликтом не доказана; она не
выдаётся за установленный факт. Assertions, timeouts, retries и exclusions этих тестов не менялись.

Просмотр фактического composition screenshot обнаружил белые надписи Badge на белом фоне:
`subtle + outline` выбирал инвертированный foreground. В 17 нейтральных статусах существующих
экранов выбран `informative + outline`. Axe помечал contrast 1:1 как incomplete; поэтому
light/dark регрессии дополнительно проверяют вычисленные foreground/background и ratio
не ниже 4,5 для всех 12 статусов readiness. Итоговый браузер 38/38 прошёл; screenshots
обеих тем и реального composition просмотрены, надписи видны. Текст и meaning статусов
не изменились.

Первый SQL-прогон имел 15/16: проверка отсутствия audit writes захватывала также законный
первый вход второго тестового сотрудника. Итоговая проверка ограничена двумя endpoint reads
уже аутентифицированного сотрудника и подтверждает отсутствие записей. Данные источника,
права и количество ожидаемых writes не изменялись для обхода проверки.

SQL использовал точную копию 759 source/test/tool файлов; generated bin/obj/wwwroot явно
исключены. Только scratch factory получила pinned cached image, private loopback port и
метки владения. Оба итоговых fixture удалены, private credentials очищены; исходные
репозитории и общая factory не менялись. Итоговый браузерный и полный composition gates
проходят. Отдельные Atlas strict unit 711/711, PostgreSQL 789/789 и browser 90/90 также
проходят без исключений; очистка и неизменность 1421 source/input файлов подтверждены.
