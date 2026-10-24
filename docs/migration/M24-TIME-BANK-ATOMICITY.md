# M24 — атомарный учёт времени и банка часов

Локальная доработка от M23 (`f6f99b4`). Публикации и развёртывания нет.
Решение: [ADR-027](../../apps/crm/docs/adr/ADR-027-local-time-bank-transaction.md).

## Исправленный сценарий

Раньше Contracts сохранял списание/возврат банка отдельно от Time. При сбое перед
Time SaveChanges банк мог уже измениться. Реальный управляемый SQL-сбой доказал три
расхождения: failed 1h approval → edit 2h → retry давал used 1 / allocated 2;
failed 2h → edit 1h → retry давал used 2 / allocated 1; failed withdrawal оставлял
used 0 / allocated 2. Три исходных consistency assertions сохранились и проходят.

Теперь approve, withdraw и изменение импортированной утверждённой записи используют
одну локальную SQL-транзакцию Time. Contracts подключает отдельный контекст к той же
connection/transaction через существующий модульный API. Изменение банка, часы,
allocations, аудит и outbox фиксируются вместе. Сбой откатывает весь пакет; успешный
commit с потерянным подтверждением не создаёт второе списание при явном повторе.

## Реализация и границы модулей

- `TimeBankTransaction` — явный scoped bridge, только Time → Contracts в одной CRM БД
  под той же SQL identity. Несовпадение БД/identity отвергается до открытия соединения.
- `TimeMutationScope.RequireFinancialOwner` запрещает присоединять финансовую команду
  к произвольной внешней транзакции. Повтор execution-strategy callback запрещён, включая
  уже активный внешний retry callback. Standalone Contracts сохраняет прежний retry;
  участник общей транзакции не повторяет SaveChanges самостоятельно.
- Порядок: source fences импортера → все упорядоченные M23 month locks → один
  `time:bank-financial-work` → Time rows → bank work → commit владельца. Финансовый lock
  сериализует небольшое число команд и устраняет обратный порядок нескольких банков.
- `GetBillingTermsAsync` читает собственные незавершённые изменения банка в пакете,
  вместо блокировки на отдельном соединении. Контексты работают последовательно.
- `ContractsApi` выделен из ReminderFeatures; API и доменные правила остаются Contracts.
  Time не обращается к чужим таблицам, cross-schema FK/DDL и новых dependencies нет.
- Inbox handlers сохраняют ADR-016 и M23: один модуль и commit владельца inbox.
  Активный MessageHandlingContext не может включить эту command boundary.

## Исторические расхождения

Перед новым утверждением проверяются source receipts очередного approval number,
включая закрытые/исчерпанные банки и soft-deleted строки. Неожиданный след возвращает
409 `TIM_BANK_RECONCILIATION_REQUIRED`, локализованный на nb/en/ru. Случайные новые ключи
не маскируют старое частичное списание. Withdrawal сверяет фактические списания с текущими
allocations; уже полностью возвращённое корректное списание завершает Time без второго
возврата. Несогласованные ledger facts требуют Finance review. Автоматической правки
старой финансовой истории и нового HTTP-интерфейса ledger нет.

## Локальная приёмка

Безопасное свидетельство (удалено в M38:
`git show 73c0158:docs/testing/evidence/time-bank-M24-2026-10-17.json`):
919/919 CRM unit, 94/94 architecture, 118/118 затронутых SQL integration;
562/562 frontend в 64 файлах. ESLint, app/E2E/composition TypeScript, production SPA
и бюджет 291.7/300 KB проходят. Это не полный SQL-набор CRM.

SQL проверяет общий откат после нескольких банковских SaveChanges, остаток 10h для
пакета 6+6h, потерянное подтверждение commit, откат implicit withdrawal импортера,
исторические receipts закрытого/исчерпанного банка, завершение уже возвращённого
списания, общую physical connection/transaction, disposal участника, повторное disposal
старого binding, несовпадение database/identity/endpoint и запрет внешнего retry callback.
Исходные три failure-regression assertions проверены до исправления (0/3) и после (3/3).
Первый прототип остановился на CS8604; захват проверенной non-null транзакции исправил
компиляцию без suppression. Все диагностические запуски сохранены и очищены.

CRM browser — 73/73 без retries/skips/flaky, включая новый реальный staff workflow
в Chromium/Firefox/WebKit: банк 10 → approve 2h → 8 → withdraw → 10 → reapprove → 8.
ServiceLead не получает закрытые финансовые поля. Полный совместный source-build — 9/9,
571 запрос к прежнему сервису интеграций (удалён в [M38](M38-OPERATIONS-IN-CRM.md)),
0 mutating requests; подтверждены restricted SQL/PostgreSQL roles,
точные Task/ticket/time/receipt/privacy facts и очистка. Все 2644 входа совпадают до и
после; 833 backend/build и 390 web inputs остаются неизменными. Прежний сервис не менялся:
его строгие 711 unit / 789 PostgreSQL / 90 browser поддержаны 1421 неизменным входом,
повторного полного прогона прежнего сервиса не было.

## Дальнейшая работа

Атомарность здесь относится только к одной CRM SQL-базе. Очередь durable intents для
того же сохранения не нужна; первоначальная гипотеза о recovery queue заменена более
прямым решением после доказательства общей БД. Внешний PowerOffice export и последующая
асинхронная отметка Invoiced остаются отдельной обязательной границей M25. До финансового
пилота нужна сверка существующей истории, а рабочие провайдеры, Entra и VPS требуют
отдельной приёмки. При будущем обновлении остановить все Web/Worker writers и jobs;
старую и новую версии нельзя смешивать. Оригинальные проекты и их изменения сохранены.

## Продолжение M25

[M25](M25-TIME-BILLING-ADMISSION.md) добавляет допуск к точной Billing revision и
поэлементную финализацию, сохраняя M24 Time/HourBank transaction. Исторический M24 run
сохранён в архивном composition (свидетельство удалено в M38:
`git show 73c0158:docs/testing/evidence/composition-M24-2026-10-17.json`).
Сверка старой финансовой истории и рабочая приёмка остаются отдельными воротами.
