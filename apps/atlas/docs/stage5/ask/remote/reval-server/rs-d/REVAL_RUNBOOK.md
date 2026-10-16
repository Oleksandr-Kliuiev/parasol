# R-EVAL server: регламент оператора (RS-A … RS-D)

Перенесено из `docs/RUNBOOK.md` в RS-D-A rc2 (общий регламент превысил 700 строк). Порядок работы инструмента —
`../rs-c/INSTRUMENT_RUNBOOK.md`. Ничего из этого не активирует оценку, не передаёт ключ провайдера и не выполняет платных вызовов.

## RS-A: локальный канал владельца (без активации)

Контракт: `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md` (+ `ACCEPTANCE_CHECKS.md`, `VERIFICATION_ADDENDUM.md`).
Только darwin/arm64. Миграция `202610131000_stage5_reval_registration` добавляет неизменяемую регистрацию песочницы и её
привязку фикстуры (только владелец таблиц; охранник ENABLE ALWAYS) и `atlas_reval_snapshot()`; `roles/reval.sql` создаёт
девятую роль (NOLOGIN evidence definer) и десятую (LOGIN evidence reader, только EXECUTE snapshot). С RS-B runtime получает
ровно SELECT по перечисленным столбцам регистрации/привязки (и ничего больше на Reval-таблицах). Регистрация и заполнение
привязки — RS-B (раздел ниже).

1. Помощник: `node scripts/reval-server/build-peer.ts` (фиксированный clang, `dist/native/reval-peer`), sha256 — в конфиг.
2. Конфиг владельца `RevalOwnerConfigV1` (0600, каталог 0700, без симлинков): UNIX_SOCKET-эндпоинт и физический кортеж
   (system identifier, OID БД, `postmaster.pid`, dev/inode сокета), пути к трём файлам паролей (только пароль), `approvedPriceRevision`.
   Владелец ОС должен читать `<dataDirectory>/postmaster.pid`.
3. В своём терминале: `node scripts/reval-server/owner.ts --config <абс. путь>`; команды `identity`, `snapshot`,
   `pause-export <admissionId> <expectedPolicyVersion> <policyFloor> <fenceFloor>`, `quit`. `LOCAL <code>` — локальное
   отображение кода выхода контроллера 10/11/12 (платформа, помощник/конфиг, peer; не ответ контроллера). После peer-доказательства
   несовпадение физики, регистрации или сборки — ответ `FAILURE REGISTRATION_MISMATCH` на каждую операцию, S не запускается.
   Время старта в кортеже — ровно строка 3 `postmaster.pid`; запрос `pg_postmaster_start_time()` (floor epoch) должен совпасть точно.

`loadedBinding` всегда `UNVERIFIED` (полный образ — RS-D). PAUSE_EXPORT вызывает только принятую `atlas_ask_remote_policy_revise(…,'PAUSED',…)`
через короткоживущий исполнитель; неизвестный COMMIT блокирует сессию (`CONTAINMENT_UNCONFIRMED`), повторов нет.
**Проверки.** `npm test` (`tests/reval-*.test.ts`), `npm run test:pg` (`tests/pg/reval-*.pg.test.ts`; нативный Unix PG17 —
при `ATLAS_REVAL_NATIVE_PG_FIXTURE`). Текущий RC5-инструмент исполнения отказывает только из-за перечисленных RS-A дельт
(`tests/reval-rc5-guard.test.ts`); совместимость RC5 с образом RS-A — PENDING.

## RS-B: синтетическая песочница фикстур и FIXTURE_CHECK (без активации)

Контракт: `docs/stage5/ask/remote/reval-server/rs-b/IMPLEMENTATION_BRIEF.md`; архитектура `03_FIXTURES_AND_CLOCK.md`.
Только изолированная одноразовая БД PG17 с одним синтетическим workspace `syn-ws-reval` / клиентом `syn-client-reval` /
назначенным актором (членство `context:read` + `ask:remote`) и политикой строго PAUSED (INACTIVE отклоняется: ACTIVE→INACTIVE —
допустимая ревизия владельца). Workspace/Client/Actor/членство/
политику создают существующие механизмы владельца; RS-B их только проверяет. Runtime получил ровно SELECT по столбцам
регистрации/привязки (`roles/reval.sql`, `REVAL_RUNTIME_COLUMNS`): после обновления — `prisma/roles.sql` заново.

1. `register`: API-сервер и контроллер ОСТАНОВЛЕНЫ — любой другой процесс в этой БД (клиент, фоновый/параллельный воркер,
   walsender) → `ANOTHER_WRITER`; не считается только autovacuum. `install` (RS-D-A, решение D2): допускаются ещё только
   ПРОСТАИВАЮЩИЕ сессии зарегистрированных S (роль runtime, `atlas-reval-s-runtime`) и C (роль reader, `atlas-reval-c-reader`) —
   см. раздел RS-D-A. Отказ ничего не меняет — команду можно повторить.
2. `node scripts/reval-server/maintain.ts --config <абс. путь> probe` печатает наблюдаемый физический кортеж (каталог данных —
   знание владельца); перенести в 0600-конфиг владельца.
3. `… register` — одна транзакция владельца, только строка `RevalSandboxRegistration` (неизменяемая).
4. `… install FXnn <ожидаемое поколение>` (0 до первой установки) — fence → политика → привязка FOR UPDATE, точная
   инвентаризация, DELETE прежнего плана, INSERT нового, поколение +1, COMMIT; затем независимая проверка вторым подключением.
   Отказы — фиксированные коды (`GENERATION_MISMATCH`, `POLICY_NOT_PAUSED`, `DRAIN_INCOMPLETE`, `EXTRA_ROWS`, `LIVE_EGRESS`,
   `FK_DEPENDENCY`, `ANOTHER_WRITER`, `REGISTRATION_MISMATCH`, `PLAN_INVALID`, …); при отказе ничего не меняется.
   **FX04:** замороженная исключённая кандидат-ссылка `agent↔PERSON` противоречит `EntityLink_type_compat_check`; по решению
   владельца (2026-10-11) карта сидирования хранит её как `contact↔PERSON` (точное исключение `schemaExceptions`; читатель Ask
   выбирает только CONFIRMED-ссылки, поэтому ответы и ожидания не меняются). Это отличие «хранится vs объявлено» и `itemCount=1`
   для усечённых пустых снимков нужно отразить в следующей ревизии плана R-EVAL. Любая другая непредставимая ссылка → `PLAN_INVALID`.
   Первый `fixture-check` нового сеанса под нагрузкой может вернуть `CENSUS_UNAVAILABLE`/`DEADLINE` (старт контроллера расходует
   бюджет первого снимка): повторить; лучше начинать сеанс с `snapshot`.
5. Запустить сеанс владельца (раздел RS-A) и выполнить `fixture-check`: `OK FIXTURE_CHECK {…}` с булевыми
   `rowIdentity/sourceProjection/expectedFacts/allFiveIntents/financeUnchanged` и `realTimeFreshnessClaim:false`.
   Политика должна быть PAUSED в обоих снапшотах (иначе `FAILURE POLICY_CHANGED`). Любой `false` или `FAILURE` блокирует отправку. Опорное время источника `2026-10-10T07:30:00.000Z` влияет только на
   свежесть ресурсов внутри верификатора; это не утверждение о реальной свежести.

**Проверки.** `tests/reval-seed.test.ts`, `tests/pg/reval-{fixtures,materialize,maintain-cli,fixture-check}.pg.test.ts`.

## RS-C-A: сервер оценки и контроллер (без активации и без ключа провайдера)

Контракт: `docs/stage5/ask/remote/reval-server/rs-c/IMPLEMENTATION_BRIEF.md`; архитектура `04_TRANSIENT_HANDOFF.md`, `06_LOCAL_PROTOCOL.md`.
S в режиме моста получает Ask REMOTE только из кадра запуска `RevalServerLaunchV2` и использует швы провайдера, которые НИКОГДА
не резолвят ключ (что бы ни попало в окружение, в т.ч. из `.env` через Prisma): вызов не отправляется (`503 ASK_REMOTE_UNAVAILABLE`,
попытка `NO_DISPATCH`, 0 списаний). Передача ключа (предварительно — переменные окружения Azure) — отдельное решение владельца
(PENDING). Инструмент I в части A — тестовый клиент.

1. Сеанс владельца (RS-A) начать с `snapshot`, затем `fixture-check` при политике PAUSED; затем владелец активирует политику.
2. I подключается к `<каталог конфига>/reval-instrument.sock` (C) и `reval-handoff.sock` (S) под TTY; C/S доказывают peer помощником.
3. `pair <controlConnectionId> <handoffConnectionId>` → `OK PAIR_ACK {…}` и строка `SECRET PAIRING_NONCE <nonce> <expiresAt>`
   (только в терминале владельца; nonce ≤120 с, однократный). Браузер: `POST /clients/<id>/ask/evaluation-handoff` (PAIR) → токен сеанса.
4. Кейс: I делает `SNAPSHOT` (PRE) и не позже 2 с — `ARM_CASE`; затем READY; браузер отправляет вопрос с `X-Atlas-Evaluation-Session`
   в течение окна ≤26 с (не продлевается); ответ несёт `X-Atlas-Evaluation-Receipt`; RESPONSE → TRANSFER/ACK/COMMIT → `204`.
5. `terminal-observation <armId>` (O) или `TERMINAL_OBSERVATION` (I): C сначала атомарно пишет безопасную запись в `reval-journal.jsonl` (0600), затем
   подтверждает сбор. `FAILURE METADATA_PERSIST_FAILED` останавливает армирование до конца сеанса.
Каждый caseId — один раз (`CASE_CONSUMED`); повтор вопроса тем же токеном останавливает приём до перезапуска S; `end-pair <pairId>`,
потеря соединения I или обнаруженное изменение учётных данных/политики/фикстуры завершает пару. Любой сбой после потребления
кейса (или неиспользованный истёкший арм) останавливает армирование до конца сеанса C: закрытие `pause-export`, POST-перепись
(RS-D) и новый сеанс владельца; автоматического продолжения нет. **Проверки.** `tests/reval-eval-*.test.ts`, `tests/pg/reval-eval-*.pg.test.ts`,
`tests/pg/reval-native-rsc.pg.test.ts` (при `ATLAS_REVAL_NATIVE_PG_FIXTURE`).

## RS-C-B/RS-C-C: инструмент (ревизия) и измерительная консоль (без активации и без ключа провайдера)

Инструмент — `scripts/reval-instrument/`; порядок оператора описан в `docs/stage5/ask/remote/reval-server/rs-c/INSTRUMENT_RUNBOOK.md`.

Измерительная консоль — отдельная запечатанная сборка `dist/operator-measured`; `npm run ui:build` собирает обе консоли. Её раздаёт
ТОЛЬКО мостовой S по `/operator/`. Обычная консоль не меняется, и элемента сопряжения в ней нет.

Порядок в браузере:
1. Подключить токен и выбрать клиента.
2. Ввести код сопряжения из сеанса владельца.
3. Для каждого кейса: набрать вопрос в точности, выбрать единственный фиксированный вариант фокуса и отметить согласие.
4. Нажать Ask только после строки `GO_CLICK_ASK_NOW`.
5. Вручную нажать «Send evaluation evidence».

Любое изменение очищает форму, а правка после выбора снимает и выбор, и согласие. Темп — не более 10 вопросов за 60 с на актёра.

Ошибки текущего запроса:
- 401 — консоль отключается.
- 403 — пара завершается; снова выберите клиента в списке и сопрягитесь новым кодом.
- Смена политики (409 или RESPONSE с POLICY_CHANGED/ADMISSION_NOT_ACTIVE) — пара завершается; отключитесь и подключитесь снова,
  чтобы обновить раскрытие, затем сопрягитесь новым кодом.

Все обращения к мостовому S проходят Host-гейт консоли: неверный Host получает 421.

Замороженный порядок чередует фикстуры; по решениям владельца D1/D2 прогон идёт в порядке, сгруппированном по фикстурам, а S и C
работают через все переключения (раздел RS-D-A).

**Проверки.** `tests/operator-eval-*.test.ts`, `tests/ui/eval-pane.spec.ts`, `tests/ui/eval-200.spec.ts` (при `ATLAS_REVAL_E2E_200=1`),
`tests/pg/reval-eval-console.pg.test.ts`, `tests/pg/reval-nb7-rehearsal.pg.test.ts`.

## RS-D-A: перепись процессов, DRAIN и сегменты фикстур (без активации и без ключа провайдера)

Контракт: `docs/stage5/ask/remote/reval-server/rs-d/IMPLEMENTATION_BRIEF_A.md`; решения владельца `rs-d/OWNER_DECISIONS.md`.

- `process-census` (O) / `census` (инструмент): точная перепись S (05 PROCESS_CENSUS) — счётчики входов, резервов, диспетчеризации,
  публикаций и освобождений в одной эпохе процесса, текущие датчики владельцев/коммитов, `coverage`. Только метаданные.
- `drain` (O и инструмент): C собирает перепись → атомарный снимок БД → перепись (≤2 с). `QUIESCENT` — только при равных счётчиках,
  нулевых датчиках, непрерывной эпохе и когда каждая НЕурегулированная попытка БД (`EGRESS_COMMITTED`) сопоставлена задаче переписи;
  иначе `PENDING` или `UNKNOWN`. DRAIN ничего не ждёт и не опрашивает.
- **Ограничение части A (не 02-QUIESCENT).** `QUIESCENT` части A означает только «перепись S + снимок БД»: независимой инвентаризации
  процессов платформы ещё нет (02: неполная инвентаризация — `UNKNOWN`, никогда не ноль). Часть B обязана выдавать `UNKNOWN`, пока
  адаптер платформы C не докажет полную инвентаризацию; DRAIN части A не являются доказательством 02-QUIESCENT.
- Порядок прогона сгруппирован по фикстурам (D1): 10 переключений; на каждой границе — пауза инструмента, `pause-export` владельца,
  `closure`, `drain` QUIESCENT, `end-pair`, переключение утилитой обслуживания при работающих S и C (D2), `fixture-check`, ручное
  возобновление, новый `pair`. Подробные шаги — `rs-c/INSTRUMENT_RUNBOOK.md`, шаг 8.
- Утилита `install` теперь допускает только простаивающие сессии зарегистрированных ролей S (runtime, `atlas-reval-s-runtime`) и
  C (reader, `atlas-reval-c-reader`): без транзакции, без блокировок (`pg_locks`), без xid/xmin. Всё остальное — `ANOTHER_WRITER`.
  Во время переключения не пользоваться браузером и консолью.

**Проверки.** `tests/reval-census.test.ts`, `tests/reval-instrument-census.test.ts`, `tests/pg/reval-census.pg.test.ts`,
`tests/pg/reval-segments.pg.test.ts` (darwin/arm64).

## RS-D-B: песочница S, инвентаризация процессов в DRAIN, доказательства платформы и приватности (без активации)

Контракт: `docs/stage5/ask/remote/reval-server/rs-d/IMPLEMENTATION_BRIEF_B.md`.

- C запускает S только через `/usr/bin/sandbox-exec` с закреплённым профилем (`packages/reval/platform.ts`): исходящие соединения
  к любым IP, кроме localhost, запрещены; исходящие unix-сокеты — только ровно к файлу сокета PG `<каталог>/.s.PGSQL.<порт>` из
  конфигурации (RS-D-C; сокет Docker и других локальных служб недоступен); запрещён сокет DNS-резолвера; S не может напрямую читать
  файлы паролей владельца и читателя и писать в дерево проекта, в helper, в файлы паролей, в файл конфигурации, в журнал C и в сокет
  инструмента C, переименовывать или удалять любой каталог выше этих файлов и выше корня проекта, делать жёсткие ссылки на эти файлы
  (RS-D-C rc3); каталог конфигурации владельца — вне дерева проекта; exec разрешён только для node и закреплённого helper'а (профиль
  наследуют все потомки S). Это нижняя граница исходящего трафика плюс запреты на эти пути, а не изоляция взломанного S: при
  `(allow default)` S работает под тем же пользователем и может писать в остальные его файлы (см. «Ожидающие ограничения»). Пути
  конфигурации (helper, каталог сокета PG, файлы паролей) должны состоять из `[A-Za-z0-9._/@+-]` — иначе S не запускается. Сразу после
  проверки пира S и до кадра запуска (S ещё не слушает) C спрашивает helper (`sandbox <pid>`) и требует `sandboxed` и `resolverDenied`
  для pid S; иначе запуск отклоняется и S завершается. Root, pf и системные настройки журналирования не нужны и не меняются.
- `drain`: `QUIESCENT` теперь только при независимой инвентаризации C — S всё ещё тот же экземпляр и в песочнице, и КАЖДЫЙ backend
  зарегистрированной БД — это сессия S (runtime, `atlas-reval-s-runtime`) или читателя C (`atlas-reval-c-reader`). Открытая сессия
  владельца, верификатора или любая посторонняя сессия → `UNKNOWN`. Поэтому во время `drain` не держать открытыми psql/утилиты
  обслуживания/другие подключения к этой БД.
- `platform-proof` (O) / `proofs` (инструмент): точный PLATFORM_PROOF (05) от C. Честный итог на этой платформе: при проверенной
  песочнице `policyEvidenceRef` = `rsd-seatbelt-s-v2`, `processCoverage` = `COMPLETE`, `destinationCoverage`
  = `UNKNOWN` (отказы Seatbelt не считаются), `unmeasuredProcessCount` = 4 (O, C, I, браузер), `countsAsVerifiedZero` = `false`.
  Нули `unexpectedDestinationCount`/`unknownDestinationCount` при `destinationCoverage` = `UNKNOWN` — НЕ измерение: считать их пустыми.
- `privacy-proof` (O) / `proofs` (инструмент): точный PRIVACY_PROOF (05) от C — ОДНО сканирование в момент запроса. Локальный сканер
  проверяет каждый обычный файл каталога конфигурации владельца (вопросы и обоснования замороженного корпуса — только в памяти,
  совпадения лишь считаются), отсутствие вывода S (stdio `ignore`) и журналирование PG для сессий S и C. Файлы паролей C НЕ открывает
  (они учитываются как место хранения вне проверки); симлинки не разыменовываются (нечитаемые). Вне проверки C (считаются
  нечитаемыми) — минимум 05: строки попыток/аудита/безопасности в БД, файлы журналов сервера PG, бэкапы/реплики, логи служб/прокси/APM,
  дампы, temp/spool, записи сессий, swap, профиль/хранилище/devtools и расширения браузера, менеджеры буфера обмена, TTY/история/argv,
  квитанции/экспорт инструмента, остатки атомарного сохранения вне каталога конфигурации, хранение у провайдера — поэтому
  `countsAsVerifiedZero` = `false`. `collectionState` = `DISABLED_AS_REQUIRED` только если: `log_statement` none/ddl,
  `log_min_duration_statement`/`_sample` = −1, `log_transaction_sample_rate` = 0, `log_parameter_max_length_on_error` = 0,
  `log_min_error_statement` = `panic` (по умолчанию в PG `error` — тогда `UNKNOWN`), `debug_print_parse/rewritten/plan` = off, и
  нет `ALTER ROLE … SET` этих параметров для ролей runtime (S) и reader (C) — ни в этой БД, ни во всех. Логгеры расширений (например,
  auto_explain) — в файлах журналов сервера PG, вне проверки. Каталог квитанций держать ВНЕ каталога конфигурации. Посторонний файл в
  каталоге конфигурации — `newUnclassified`; найденный вопрос корпуса — `forbiddenContentMatchCount` (удалить файл и выяснить источник).
- Ни одно доказательство не повышает флаги квитанции; проверенного нуля на этой платформе нет (провайдерский egress — отдельный слой на
  целевой платформе, решение о ключе PENDING).

**Проверки.** `tests/reval-platform.test.ts` (darwin/arm64: реальный профиль), `tests/reval-proofs.test.ts`,
`tests/pg/reval-launch.pg.test.ts` (S в песочнице, отказ S без профиля, оба доказательства через O, C не открывает пароли владельца и
runtime — проверка на уровне fs), `tests/pg/reval-census.pg.test.ts` (инвентаризация и переопределения ролей), `tests/pg/reval-segments.pg.test.ts`.

## RS-D-C: сквозной порядок R-EVAL (итоговый регламент, без активации)

Контракт: `docs/stage5/ask/remote/reval-server/rs-d/IMPLEMENTATION_BRIEF_C.md`. Этот раздел собирает RS-A … RS-D в один порядок
работы. Он НЕ разрешает прогон: R-EVAL начинается только после отдельных решений владельца (см. «Открытые условия»).

**Открытые условия (каждое — отдельное решение владельца, не часть RS-D).** Допуск данных и бюджета; передача ключа провайдера
(PENDING — до решения S работает без ключа, каждый кейс `NO_DISPATCH`); слой контроля исходящего трафика провайдера на целевой
платформе (Seatbelt не умеет разрешать по имени хоста); человеческая аттестация меток корпуса; отдельная приёмка фактических
результатов прогона. Ограничения, которые остаются и после этого: см. «Ожидающие ограничения» в конце раздела.

1. **Окружение (один раз).**
   - Только darwin/arm64. Каталог конфигурации владельца (0700) — ВНЕ дерева проекта (иначе S не создаст свой handoff-сокет:
     профиль запрещает S запись в проект). Пути конфигурации, helper'а, файлов паролей и каталога сокета PG — только символы
     `[A-Za-z0-9._/@+-]` (иначе S не запускается).
   - PG17: свой каталог Unix-сокета (не общий `/tmp`): профиль разрешает S ровно `<каталог>/.s.PGSQL.<порт>`.
   - Журналирование PG для `collectionState` = `DISABLED_AS_REQUIRED`: `log_statement` none/ddl, `log_min_duration_statement` и
     `log_min_duration_sample` = −1, `log_transaction_sample_rate` = 0, `log_parameter_max_length_on_error` = 0,
     `log_min_error_statement` = `panic`, `debug_print_*` = off, и никаких `ALTER ROLE … SET` этих параметров для ролей runtime и
     reader. Иначе доказательство приватности честно показывает `UNKNOWN`.
   - `npm run api:build`; `node scripts/reval-server/build-peer.ts` (sha256 helper'а — в конфиг);
     `node scripts/reval-instrument/cli.ts artifact-check` → `ok: true`, `drift: []`, кандидат `RS-D-C` с `accepted: true`
     (после печати RS-D-C). Любой `BUILD_DRIFT`/`SOURCE_DRIFT` — не начинать: пересобрать из принятых исходников или выяснить причину.
2. **Регистрация и первая фикстура** (RS-B): политика PAUSED, `register`, затем `install FX07 <поколение>` — первая группа
   сгруппированного порядка (D1). Все посторонние сессии этой БД закрыты.
3. **Запуск владельцем** (RS-A/RS-C-A): `owner.ts --config …` → `identity`, `snapshot`, `fixture-check` (все шесть доказательств
   `true`), `platform-proof` (`processCoverage` COMPLETE, `policyEvidenceRef` `rsd-seatbelt-s-v2`), `privacy-proof`
   (`forbiddenContentMatchCount` 0, `newUnclassifiedDestinationCount` 0). Затем владелец активирует политику (ACTIVE).
4. **Инструмент** (`rs-c/INSTRUMENT_RUNBOOK.md`): `session`, `connect`, PAIR, `admission`, `confirm`, `pair-ack` (строка владельца
   `OK PAIR_ACK {…}` целиком), затем `proofs` ПЕРЕД первым GO (один раз спрашивает IDENTITY C и привязывает прогон к его сборке).
5. **Кейсы**: шаги 4–7 INSTRUMENT_RUNBOOK, по одному, с паузой не короче 12,5 с между кейсами (лимит 10 вопросов в минуту и
   учёт RC5 — запрос возможностей и вопрос).
   **Обновление пары внутри сегмента.** Ручной сегмент длится дольше пары (04): пара живёт не больше 10 минут после PAIR в браузере, а PAIR возможен только до `expiresAt` из PAIR_ACK (окно nonce 2 минуты),
   поэтому пара гарантированно жива до `expiresAt` + 8 минут. Инструмент отказывает GO с `BLOCKED_PAIR_REFRESH_REQUIRED` (ничего не
   потреблено), когда от этого срока остаётся меньше 200 с (GO, окно ARM 26 с, слот 120 с, передача). Отправить ответ кнопкой
   «Send evaluation evidence» нужно до конца пары.
   Тогда: владелец `end-pair <pairId>`, `pair <controlId> <handoffId>`, браузер — PAIR с новым nonce, инструмент — `pair-ack` (новая
   строка). Политика и фикстура не меняются, `confirm` не нужен.
6. **Граница сегмента** (10 раз за прогон): шаг 8 INSTRUMENT_RUNBOOK — пауза инструмента, `pause-export` владельца, `closure`,
   `drain` QUIESCENT (если `UNKNOWN` — закрыть посторонние сессии БД и повторить), `proofs`, `drain` и `end-pair` владельца,
   переключение утилитой обслуживания при работающих S и C, `fixture-check`, ручное возобновление (ACTIVE), новый `pair`,
   `resume-pause`, `confirm`, `pair-ack`.
7. **Завершение**: `drain` (QUIESCENT), `proofs`, `pause`, `pause-export` владельца, `quit` инструмента и владельца. Квитанция
   `REVAL_INSTRUMENT_<admissionId>.json` (v6): `build` — сборка C; `proofs` — 12 записей (до первого GO, после каждого из 11
   сегментов); `drains` — 10 граничных и финальный QUIESCENT; у каждого кейса `census` MATCH; флаги не повышены (`verifiedPass`
   false, `liveAcceptanceEligible` false, `BLOCKED`).
8. **Остановки и что делать.**
   - `BLOCKED_*` (кроме `BLOCKED_ARM_STOPPED_*`) — ничего не потреблено; устранить причину и повторить GO.
   - `BLOCKED_ARM_STOPPED_<причина>` — прогон остановлен и записан в квитанцию; дальнейших GO нет. Причины:
     `CENSUS_CHANGED_UNEXPECTEDLY` (посторонняя активность), `CENSUS_CONTINUITY_LOST` (другой экземпляр S или S недоступен),
     `TERMINAL_EXPIRED_UNCOLLECTED` (S не получил подтверждение сбора записи и через 10 минут удалил её несобранной — RS-D-C),
     `ARM_*`, `TERMINAL_FAULT`, `OBSERVATION_INVALID`, `PERSIST_FAILED`.
     Закрытие: `drain`, `pause-export` владельца, новый сеанс только после разбора.
   - `BLOCKED_PAIR_REFRESH_REQUIRED` — обновить пару (шаг 5), затем повторить GO.
   - `BLOCKED_C_IDENTITY_<код>` — C не ответил IDENTITY по другой причине (например, `DEADLINE`): проверить C, повторить. Ответ C о
     потере S (`IDENTITY_UNVERIFIED`, `IPC_LOST`) — это остановка `BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST` (RS-D-C rc2).
   - `PROOF_FAILED_<код>` — доказательство не записано; `matches` > 0 — вопрос корпуса найден в каталоге конфигурации: остановить,
     удалить файл, выяснить источник.
   - `DRAIN UNKNOWN` — посторонняя сессия БД, S не в песочнице или потеря непрерывности: не переключать фикстуру.
9. **Уборка.** Остановить O/C/S/инструмент; квитанции и журнал C хранить вне каталога проекта; никаких вопросов/ответов в
   истории оболочки, буфере обмена и временных файлах; профиль браузера измерительной консоли — отдельный, очистить после прогона.

**Ожидающие ограничения (заявлены, не реализованы).** T2: управляющий и handoff-сокеты инструмента не привязаны к одному процессу
I (нужно расширение замороженного протокола 06; сейчас оба пира — тот же uid, закреплённый node, TTY, не C и не S). Проверенного
нуля на этой платформе нет (отказы Seatbelt не считаются; O/C/I/браузер без песочницы); доказательство приватности неполно по
построению (места хранения вне проверки C, внешних доказательств хранения нет). Риск D1: фикстура совпадает с позицией в порядке.
Профиль S (RS-D-C rc3, F5 ревью) — нижняя граница исходящего трафика и прямые запреты на пути, а не изоляция взломанного S: S работает
под тем же uid, профиль разрешает всё остальное (`allow default`), поэтому S может переписать файлы пользователя, которые потом
исполняют компоненты без песочницы (node из Homebrew и его библиотеки — их запускают C, исполнитель владельца E и верификатор V;
стартовые файлы shell/launchd). Закрыть это — решение владельца: профиль с явным списком разрешённой записи, защита каталогов
инструментов или отдельный пользователь для S.

**Проверки.** `tests/pg/reval-rehearsal.pg.test.ts` (`ATLAS_REVAL_REHEARSAL=1`, ≈ 50 мин: все 200 кейсов, 11 сегментов, 10 границ
с работающими S и C, обновление пары внутри сегмента, переписи MATCH, QUIESCENT, 12 доказательств, квитанция v6), `tests/reval-instrument-identity.test.ts`
(финальная ревизия, инвентарь сборки), `tests/reval-fsync.test.ts` (F_FULLFSYNC измерен), `tests/reval-instrument-run.test.ts`
(`TERMINAL_EXPIRED_UNCOLLECTED`, `CENSUS_CONTINUITY_LOST` при потере S, `BLOCKED_PAIR_REFRESH_REQUIRED`), `tests/reval-platform.test.ts`
(профиль S под настоящим Seatbelt, включая переименование каталогов выше паролей, helper'а и корня проекта; проводка `productionDeps`).
