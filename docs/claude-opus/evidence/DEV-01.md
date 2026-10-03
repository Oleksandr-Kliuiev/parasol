# DEV-01 — доказательства выполнения

## Версия и среда

- Дата/исполнитель: 04.10.2026, Claude Opus 5.5 в Claude Code.
- Версия: ветка `codex/readiness`, от коммита DEV-15 `041d4df`; изменения DEV-01 — следующий коммит (SHA в [PROGRESS](../PROGRESS.md)).
- Среда: как в [DEV-15](DEV-15.md): .NET SDK 10.0.401, MTP 2.4, SQL Server 2022 (Testcontainers и временные контейнеры), Playwright 1.63 (Chromium/Firefox/WebKit), dotnet-ef 10.0.12.
- Данные: только синтетические.
- Область: Billing — идентичность начисления в основании, решения Finance, конфликты, миграция `ChargeIdentity`; контракты модуля Contracts (`BillableContractLine.SeriesId`, `HourBankPurchase.EntryId`); API, UI, nb/en/ru.

## Подтверждённая проблема и реализация

**До.** Регрессии DEV-00 на `2bed19e`: 1000 → 900 → пересборка давала 1900 (домен и API). Причины: один флаг `ManuallyAdjusted` для ручной и для исправленной строки и добавление источников без сопоставления; удалённая Finance строка возвращалась при сборе, причина решения нигде не хранилась.

**После** ([ADR-011](../../adr/ADR-011-charge-identity.md)):

- Ключ начисления у каждой собранной строки, не зависящий от run/collect: договор — `contract:{SeriesId}:{с}:{по}` (серия сквозь версии и выставляемые дни), время — `time:{AllocationId}` (сводно `time:{вид}:{ставка}`), информационные часы — `info:{тип}`, покупка пакета — `hourbank:{EntryId}`, отложенное начисление — `pending:{Id}`. Сбор отклоняет строку без ключа и повтор ключа; в БД уникальный индекс `(BasisId, SourceKey)` среди текущих строк.
- `BillingLine`: `Origin` (Collected/Manual), значения и сигнатура источника, `Decision` (Override/Exclusion) с `DecisionSignature`, `Conflict` (SourceChanged/SourceRemoved/LegacyUnmatched), `ChangedBy/ChangedAt/ChangeReason`, `SourceOrganizationId` (кому оказана услуга). `BillingBasis.Revision` растёт при каждом изменении строк.
- Пересборка (`ApplyCollected`) сопоставляет по ключу: строка без решения берёт значения источника; решение сохраняется, а при иной сигнатуре источника строка получает конфликт; исчезнувший источник удаляет строку без решения и ставит конфликт исправлению; исключение остаётся записью и не возвращается.
- Исправление и исключение собранной строки — только с причиной (`BIL_REASON_REQUIRED`); ручная строка правится и удаляется свободно. Новые команды: `exclude`, `revert` (вернуться к источнику / включить снова), `keep` (оставить решение против нового источника, с причиной). Все требуют `If-Match` и `billing.manage`; матрица прав из DEV-15 подхватила их автоматически.
- Утверждение прогона отклоняется при любом конфликте (`BIL_UNRESOLVED_CONFLICTS`), до изменения статусов.
- Исключённые строки не идут в итог, экспорт PowerOffice, выручку, сверку лицензий и не закрывают свои источники: часы и отложенные начисления остаются следующему прогону.
- UI: состояние строки (исправлено/исключено с причиной, автором и временем, «Источник: …», «Оказано для …»), предупреждение о конфликте, действия «Оставить решение» / «Взять из источника» / «Включить снова» / «Исключить», поле причины в правке собранной строки, баннер конфликтов на основании и прогоне, кнопки утверждения заблокированы при конфликтах. Переведённые коды ошибок (`errors.codes.*`) вместо английского текста сервера. Ключи nb/en/ru синхронны (vitest).

Попутно исправлены три дефекта, найденные при реализации:

1. Сбор оставлял собранные строки клиента, у которого больше нет источников, если в основании была хоть одна строка (выставлялось уже не причитающееся). Теперь такие строки удаляются, решения остаются с конфликтом.
2. Клиент, выпавший из прогона и вернувшийся при следующем сборе, ломал сбор: ключ `{period}-{customer}-{run}` уникален и для удалённого основания. Теперь удалённое основание восстанавливается.
3. Исключённая (раньше удалённая) строка не должна закрывать источники при экспорте — обработчик `BillingBasisExported` теперь смотрит только выставленные строки.

Изменение API-поведения, записанное решением, а не подгонкой теста: исправление собранной строки требует причины. Регрессия `BillingRegressionApiTests.A01` теперь отправляет `reason`; проверяемый инвариант (одна позиция 900 после пересборки) не менялся.

Изменённые файлы: `src/Modules/Billing/Crm.Billing/{Domain/BillingBasis.cs, Domain/BillingRun.cs, Features/BillingCollector.cs, Features/BillingService.cs, Features/BillingFeatures.cs, Features/BillingApi.cs, BillingModule.cs, Persistence/BillingDbContext.cs, Persistence/Migrations/*ChargeIdentity*}`, `src/Modules/Contracts/{Crm.Contracts.Contracts/ContractsContracts.cs, Crm.Contracts/Features/ReminderFeatures.cs}`, `web/src/features/billing/{BillingBasisPage,BillingRunPage}.tsx`, `web/src/features/billing/{api,types}.ts`, `web/src/shared/utils/errors.ts`, локали nb/en/ru, тесты (`BillingChargeIdentityTests`, `ChargeIdentityApiTests`, обновлённые `BillingDomainTests`, `BillingRegressionTests`, `BillingRegressionApiTests`, E2E `billing.spec.ts`), документация (ADR-011, docs/02 BR-BIL-02, docs/03 таблица ADR, docs/04 модель).

## Проверка критериев

| AC | Входные данные / действие | Ожидаемый результат | Фактический результат | Статус | Тест/протокол/артефакт |
|---|---|---|---|---|---|
| DEV-01-AC01 | 1000 → ручные 900 → 1 и 10 пересборок; домен и API | Одна экономическая позиция 900 | Домен: одна строка 900 (решение Override, источник 1000) при 1 и 10 сборах; API: та же строка после 10 сборов, итог 3400 вместе с ручной 2500. Регрессии A01 DEV-00 (unit ×2, API) зелёные | pass | `BillingChargeIdentityTests.An_override_and_a_manual_line_each_stay_once_through_any_number_of_collects`, `ChargeIdentityApiTests.An_override_and_a_manual_line_each_stay_once_through_ten_collects`, `BillingRegressionTests.A01_*`, `BillingRegressionApiTests.A01_*` |
| DEV-01-AC02 | Ручная 2500 + исправление; три строки с одинаковым описанием (два источника и ручная) | Ручная строка однократно; одинаковые описания разных источников не сливаются | 2500 одна после 10 сборов; три строки с одним текстом сохраняются раздельно, итог 2800 | pass | `…each_stay_once…`, `Lines_with_the_same_text_from_different_sources_stay_apart`, API-тест AC01 |
| DEV-01-AC03 | Исправление 900, затем цена источника 1000→1100 (в API — ревизия строки договора с первого дня месяца) | Явное разрешение конфликта; старое решение не исчезает | Конфликт SourceChanged, строка остаётся 900, источник 1100 показан; approve → 409 `BIL_UNRESOLVED_CONFLICTS`, статус прогона не меняется; `keep` без причины → 400, с причиной → конфликт снят, затем approve успешен; `revert` переводит на 1200; исчезнувший источник → SourceRemoved, keep/revert | pass | `A_source_that_changes_after_an_override_is_a_conflict_until_finance_decides`, `A_source_that_disappears_under_an_override_is_a_conflict_and_can_be_kept_or_dropped`, `ChargeIdentityApiTests.A_price_change_at_the_source_after_an_override_waits_for_finance_before_approval` |
| DEV-01-AC04 | Исключение собранной строки, 3 (API) / 10 (домен) пересборок, история аудита | Не возвращается незаметно; действие и причина в истории | DELETE собранной строки → 400 `BIL_REASON_REQUIRED`; после `exclude` строка остаётся исключённой после всех сборов, итог 0; в DTO причина, автор, время; запись аудита `BillingLine` содержит `Exclusion` и причину; изменение источника исключённой строки → конфликт; «включить снова» возвращает сумму | pass | `An_excluded_line_stays_out_on_every_collect_and_says_who_excluded_it_and_why`, `ChargeIdentityApiTests.An_excluded_line_does_not_come_back_and_the_history_says_who_and_why` |
| DEV-01-AC05 | Дочерняя компания «счёт материнской», повторный сбор и 3 параллельных сбора | Источник сохраняется; повтор и параллельные запросы не дублируют | Одно основание материнской, 2 строки с разными ключами, итог 1500; строка дочерней с `sourceOrganization` = дочерняя; параллельные сборы отвечают 200/412/409, без 5xx, без второго основания или строки; уникальный индекс `(BasisId, SourceKey)` | pass | `ChargeIdentityApiTests.A_subsidiary_billed_through_its_parent_keeps_its_customer_and_parallel_collects_do_not_duplicate_it`, `The_customer_a_line_was_delivered_to_travels_with_it` |
| DEV-01-AC06 | Утверждённое основание: правка, исключение, revert, keep, новая строка; сбор прогона | Невозможно пересобрать или поправить; согласованный код конфликта | Все пять команд → 409 `BIL_BASIS_LOCKED`; сбор → 409 `BIL_INVALID_STATUS`; сумма не изменилась | pass | `BillingBasisTests.An_approved_basis_cannot_be_changed_any_more`, `ChargeIdentityApiTests.An_approved_basis_refuses_every_change_with_the_agreed_code` |

## Запуски

| Время (UTC) | Команда | Exit | Результат |
|---|---|---|---|
| 23:19:06–23:19:56 | Шаги job `backend` из ci.yml локально | job FAILED | Restore, Build (0/0), Vulnerable packages, Architecture 67/67, Coverage gate — success. Unit 292: 3 failed — только регрессии A02 (DEV-02). Integration 95: 4 failed — A02 ×3 (DEV-02) и A03 (DEV-03). Coverage: критический домен 96.55 % (1008/1044), backend 85.10 % (14 538/17 084) → passed ([лог](DEV-01/ci-local-backend.txt)) |
| 23:0x | integration ×3 подряд | 2 (известные) | 95 тестов, каждый раз ровно 4 известные регрессии, teardown-ошибок нет |
| 23:13–23:15 | E2E billing + a11y (новый сценарий исправления и исключения) | 0 | 9/9 |
| 23:17:52–23:17:53 | Миграция на копии прежней схемы с данными прежнего формата | 0 | См. «Данные и обратимость» |
| 23:20–23:23 | lint, typecheck, vitest, build, полный E2E (3 workers, новая БД) | 0 | vitest 29/29; bundle 282.9 KB; E2E 51/51 ([список](DEV-01/e2e.txt)) |

Регрессии A01 DEV-00 стали зелёными. Красными по-прежнему зарегистрированы A02 (unit ×3, API ×3 → DEV-02) и A03 (API → DEV-03). Новых неожиданных ошибок нет.

## Данные и обратимость

Миграция `ChargeIdentity` — только expand: 14 nullable/default-колонок `BillingLines`, `Revision` у `BillingBases`, фильтрованный уникальный индекс, backfill `Origin = Manual` для строк, которые прежняя версия писала как ручные. Проверено на копии прежней схемы ([протокол](DEV-01/migration-upgrade.txt), скрипты рядом):

1. Миграции до `PendingCharges`, синтетические данные прежнего формата: открытое основание (обычная собранная, исправленная собранная, ручная и удалённая строки) и утверждённое основание.
2. Применение `ChargeIdentity` (~1 с на этом объёме): количества и суммы по основаниям не изменились (Draft 3 строки / 3400, Approved 2 / 1500); ручные строки → Manual, собранные → Collected без ключа, Decision/Conflict = None, Revision = 0; индекс создан с фильтром `[SourceKey] IS NOT NULL AND [IsDeleted]=(0)`.
3. INSERT со списком колонок прежней модели проходит; новые колонки получают значения по умолчанию. Такая строка старой версии без `SourceRefs` при следующем сборе принимается как ручная (проверено API-тестом).
4. Повторное применение — «No migrations were applied».
5. Откат схемы до `PendingCharges` удаляет новые колонки; суммы прежних колонок сохранены.

На пустой БД миграции применяются integration-фикстурой и E2E. Пересборка открытых оснований после выпуска: обычные строки без ключа заменяются строками с ключом, исправленные ждут решения Finance (`LegacyUnmatched`), ручные остаются; dry-run — `GET /api/v1/billing/legacy-lines` (проверен API-тестом на старом формате данных). Утверждённые и выгруженные основания не изменяются; их сверка — DEV-03. Внешних эффектов миграция не вызывает. Откат приложения после начала записи в новые поля безопасен для схемы, но решения Finance (`Decision`, причины) в старой версии не видны; окно отката — до первых решений в продуктиве.

## Самопроверка и остаточные риски

Просмотрены весь diff, обработка конфликтов во всех ветках, права новых endpoints (матрица DEV-15), скрытие денег источника для ролей без finance.read (API-тест), конкуренция (RowVersion основания/прогона, уникальные индексы), сериализация enum в DTO и ключи переводов. Проверку выполнял тот же агент — это не независимый review.

- Межпрогонная уникальность (второй runId закрытого месяца, A03) этим заданием не закрывается — DEV-03. Повторно собираются и уже выставленные часы (`GetBillableTimeAsync` берёт и Invoiced) — тоже DEV-03.
- Согласование конкретной ревизии (A02) — DEV-02; `Revision` основания уже готов для этого.
- Бизнес-правила корректировок (DEC-02) владельцем не утверждены: механизм требует причину и не меняет суммы автоматически.

Итоговый статус: **code_verified**. Внешних gates у карточки нет; accepted оставлено владельцу/независимому review.
