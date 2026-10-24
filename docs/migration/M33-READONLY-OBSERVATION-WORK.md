# M33 — просмотр работы по активному наблюдению для читателя

Обнаруженный разрыв: сервер уже разрешал task-preview сотруднику с AtlasRead AND ActivitiesRead,
но кнопка для OPEN/ACKNOWLEDGED требовала ActivitiesWrite. Crm.ReadOnly мог читать связанную
задачу из Activities и смотреть её источник, но не мог обнаружить ту же работу со стороны
активного наблюдения. Дополнительно UI предлагал Assign work при AtlasRead+ActivitiesWrite
без обязательного серверного ActivitiesRead.

Кнопка теперь требует оба read permission. Для активной записи writer видит Assign work,
reader — View work; terminal остаётся View linked work. Читатель получает отдельный заголовок
View observation work, актуальный preview и точную локальную ссылку существующей задачи.
Если задачи нет, это явно сказано; нет формы назначения, чекбокса, Create task или users lookup.
Это не глобальный индекс назначенной работы: никаких фоновых чтений по строкам нет.

Query key включает отсортированный набор permissions, а ключ диалога — сотрудника,
permissions, клиента и наблюдение. При потере write сбрасываются старая форма, confirmation
и preview; новая read-only версия ждёт свежий GET. Утрата любого read убирает действие.
Имена и отсутствие связанной работы переведены на nb/en/ru. Сервер, Atlas, контракты,
схемы и production зависимости не менялись. Credentials/провайдеры/VPS не подключались.

Новый unit baseline: 6 ошибок действительно воспроизводили расхождения поведения; ещё одна
была ошибкой harness (пропущен обязательный initialPath). В следующей фикстуре users lookup
не был отделён от preview; адресный mock исправлен, semantic assertions не удалены.
TypeScript также отклонил неподдерживаемый exact в Testing Library ByRoleOptions: удалён
избыточный параметр; строковое accessible name по-прежнему совпадает точно.

Один неограниченный по workers полный прогон прошёл 633/633 до удаления лишних TS options,
следующий дал 631/633: timeout старого CreateTicketDialog и ожидание Register hours в
TaskTimeEntry. Для финального полного запуска параллелизм ограничен двумя workers;
assertions, timeout, tests и skips не менялись.

Первый browser run: 92/96, четыре contrast findings. В новом сценарии три движка
сканировали окно до завершения штатной анимации; добавлено ожидание фактических animations,
а отчёт Axe расширен до target/reason. Старый phone Activity тест попал в автозатухание
успешного toast. Теперь проверяется контраст подтверждения при hover (таймер приостановлен),
затем ожидается реальное удаление toast и выполняется прежний полный Axe итоговой страницы.
Правила и nodes не исключались; добавлена отдельная проверка contrast>=4.5.
После этих двух browser-only правок unit/app inputs не менялись: весь unit набор633
не повторяется без необходимости; отдельно повторяются E2E types/lint и весь browser набор.

Отдельный диагностический visual launcher сначала не собрал ни одного теста из-за CJS/ESM
импорта audit.mjs вне репозитория. Приватный пакет явно отмечен ESM, отдельный matrix
прогон прошёл16/16 с cleanup; эти шаги не являются тестами приложения и не исключают
96 прошедших browser cases. Предварительный composition guard затем корректно отказал
старому M32 web manifest; подключён точный текущий M33 manifest, исторические hashes не
переписывались. В этом отказе приложения и БД composition ещё не создавались.

Первый полный source-build composition прошёл9/10 с cleanup. Последняя проверка терминального
наблюдения ещё ожидала Assign observation work/cannot create; теперь явно требует read-only
заголовок и No CRM task is linked, отсутствие Create task и combobox. Изменён только
composition spec, app/unit и все96 обычных browser inputs не менялись. Повторены его
lint/types и полный source-build composition; это не ослабление permission/creation checks.

Финальная приёмка: affected frontend **102/102**, полный **633/633** в 72 файлах
с двумя workers; ESLint/TypeScript/SPA проходят, initial gzip **292,4/300 КБ**.
После полного unit прогона менялись только три browser/composition spec; все app/unit inputs побайтово
неизменны. Повторены lint/types и полный широкий browser набор: **96/96**,
0 skipped/unexpected/flaky. Последняя правка затрагивала только composition spec;
все inputs обычного browser набора неизменны относительно этого96-case запуска. Новый путь проверен в Chromium/Firefox/WebKit на четырёх
ширинах и в обеих темах, в том числе реальный HTTP403 на создание под ReadOnly,
отсутствие UI writes, keyboard focus restoration и переход в точную реальную CRM задачу.
Atlas preview этого browser пути — управляемый BFF-контракт, не реальный источник.

Отдельный измеримый Chromium аудит — **16/16** для empty/linked, 1440/768/390/320 px,
light/dark, без errors/warnings. Все 16 снимков просмотрены; информационные Fluent spacing
findings проверены без правок канонических компонентов. Правила Axe/контраста сохранены.

Нормальный [source-build composition](../testing/evidence/composition-M33-2026-10-17.json)
`d25a7dc41b53` проходит **10/10**, tooling **22/22**, 575 Atlas GET и 0 mutating
Atlas requests, restricted runtimes, точные durable/privacy факты и cleanup. Все **2723**
application/tool inputs совпадают до/после. [M32 report](../testing/evidence/composition-M32-2026-10-17.json)
остался побайтово неизменным. [Компактное свидетельство](../testing/evidence/readonly-work-M33-2026-10-17.json)
разделяет эти области; приватный измеримый аудит не подменяет actual joined-app acceptance.

Backend/SQL/Atlas не менялись. M31 CRM963/94/93 и Atlas714/797/90 переиспользованы по точным
804/856/1426 inputs; это не новые полные серверные прогоны M33. M26 financial SQL208
и M29 native restore также не повторялись.
Границы: synthetic controlled BFF для UI; actual composition отдельно с реальными
CRM/Atlas/SQL; серверные старые proof применимы только при совпадении точных inputs.
Отзывы сотрудников и измеренная человеческая экономия времени остаются открыты.
