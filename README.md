# Parasol

Общий проект Vardahei для трёх сотрудников — одно приложение, CRM (в интерфейсе **Parasoll**): клиенты, договоры,
задачи, заявки и часы, биллинг и финансы, а также «Drift» — устройства и оповещения клиентов. Atera подключена к CRM
напрямую, PowerOffice и Microsoft Partner Center — тоже; Huntress и CloudAlly подключаются следующими этапами (M41,
M42). Целевая среда — **VPS Hostinger**.

## Этапы

- [M01–M03](docs/migration/M01-M03.md) объединяют исходники, историю Git, сборку и CI; [описание импорта](docs/migration/IMPORT.md).
- [M05: вход и ключи сессий](docs/migration/M05-WORKSPACE.md) — единый вход через BFF CRM (Entra ID) и ключи
  Data Protection на постоянном каталоге VPS.
- [M06: документы](docs/migration/M06-VPS-DOCUMENTS.md) переносит хранилище на постоянный том VPS с атомарной
  записью и проверкой неизменности.
- [M07: комплект VPS](docs/migration/M07-HOSTINGER.md) добавляет Linux-образы, Caddy, закрытую конфигурацию,
  зашифрованные backup и отдельное учение restore ([инструкция](deploy/hostinger/README.md)). Реальный запуск и
  подключение провайдеров ещё не выполнены.
- [M16: редактирование задачи](docs/migration/M16-TASK-EDITING.md) сохраняет точный срок и версию черновика,
  показывает отказ назначения/конфликт и защищает новый черновик от позднего ответа.
- [M17: личные задачи](docs/migration/M17-PERSONAL-TASK-RELIABILITY.md) различает ошибку и пустой список, добавляет
  явное обновление и изолирует данные/уведомления сотрудника.
- [M18: контакт Atera-заявки](docs/migration/M18-SERVICE-CONTACT-SAFETY.md) проверяет текущую принадлежность,
  владельца внешней записи и неизменность связей перед новой отправкой.
- [M19: точное открытие задачи](docs/migration/M19-EXACT-ACTIVITY-NAVIGATION.md) ведёт из «Моего дня» к выбранной
  записи клиента, включая задачи за первой страницей; обновление перечитывает её текущую версию и закрывает прежний
  редактор.
- [M20: безопасная смена статуса](docs/migration/M20-ACTIVITY-STATUS-CONCURRENCY.md) проверяет показанную версию при
  завершении и повторном открытии, сохраняет чужую правку и объясняет конфликт без автоматического повтора команды.
- [M21: сохранённые данные сервиса](docs/migration/M21-SAVED-SERVICE-DATA.md) различает загрузку, ошибку и пустой
  результат, перечитывает разделы без live sync Atera и изолирует клиентские формы и ответы.
- [M22: задача → заявка → часы](docs/migration/M22-TASK-TICKET-TIME.md) добавляет проверенную связь с сохранённой
  заявкой клиента, собственные явно введённые часы и защиту повторной отправки.
- [M23: согласованность периодов](docs/migration/M23-TIME-PERIOD-ADMISSION.md) защищает закрытие месяца от
  конкурентной записи, сериализует расход лимита SLA при утверждении и сохраняет закрытую историю.
- [M24: часы и предоплаченный банк](docs/migration/M24-TIME-BANK-ATOMICITY.md) фиксирует списания, возвраты и время
  в одной локальной SQL-транзакции; старые расхождения требуют сверки Finance.
- [M25: часы и утверждённый счёт](docs/migration/M25-TIME-BILLING-ADMISSION.md) защищает включённые часы до доставки
  экспорта и сохраняет исключённую платную часть для дополнительного счёта.
- [M26: сверка выбранных часов](docs/migration/M26-TIME-FINANCIAL-REVIEW.md) показывает Finance ожидаемые и
  фактические списания и связанную версию счёта; просмотр не меняет финансовые данные.
- [M27: заявка из «Моих задач»](docs/migration/M27-MY-DAY-TICKET-SHORTCUT.md) открывает сохранённую заявку и форму
  собственных часов прямо из личной задачи.
- [M29: восстановление рабочей цепочки](docs/migration/M29-CURRENT-WORKFLOW-RECOVERY.md) проверяет, что задача,
  связанная заявка и часы переживают backup и restore.
- [M32: компактная карточка и понятная навигация](docs/migration/M32-NAVIGATION-CLARITY.md);
  [M34: разделы «Моего дня»](docs/migration/M34-MY-DAY-SECTIONS.md) — прямой переход к своей работе без прокрутки.
- M37 — финансы клиента из PowerOffice: [карточка](docs/migration/M37-CUSTOMER-FINANCE-CARD.md),
  [история счетов](docs/migration/M37-POWEROFFICE-INVOICE-HISTORY.md), [PDF](docs/migration/M37-POWEROFFICE-INVOICE-PDFS.md),
  [платежи и операции](docs/migration/M37-POWEROFFICE-CUSTOMER-LEDGER.md),
  [возобновляемый импорт](docs/migration/M37-POWEROFFICE-RESUME.md); PowerOffice остаётся системой учёта
  ([решение и объём копии](docs/migration/M37-POWEROFFICE-REPLICA-PLAN.md)), рабочий аккаунт подключается по
  [плану подключения](docs/migration/M37-POWEROFFICE-LIVE-PLAN.md).
- [M38: «Drift» в CRM](docs/migration/M38-OPERATIONS-IN-CRM.md) выводит отдельный сервис интеграций: устройства и
  оповещения Atera, очередь `/alerts`, полный доступ сотрудников через одну группу Entra, этапы M39–M44.

Этапы M04, M08–M15, M28, M30, M31, M33, M35 и M36 относились к удалённому сервису; их документы убраны в M38 и
читаются из Git (список и команды — в [M38](docs/migration/M38-OPERATIONS-IN-CRM.md#что-удалено-и-где-это-прочитать)).
Оставшиеся задачи до ежедневного использования — в [готовности продукта](docs/PRODUCT_READINESS.md); интерфейс —
[UX-концепция](docs/ux/UX-CONCEPT.md), [разбор 2026](docs/ux/UX-2026.md) и [демо](docs/ux/demo/README.md).

## Структура

| Путь | Назначение |
| --- | --- |
| `apps/crm` | CRM: .NET 10 (модульный монолит, Hangfire), React/Vite и Fluent UI, SQL Server; интеграции — `apps/crm/src/Integrations` |
| `deploy/hostinger` | Docker Compose (Caddy, CRM Web и Worker, SQL Server), секреты в файлах, backup/restic, изолированное restore |
| `scripts` | Общие команды сборки, проверка истории импорта и результатов тестов |
| `.github/workflows/ci.yml` | Единственный активный CI, без развёртывания |
| `docs/migration` | Источники, способ импорта, этапы и известные ограничения |
| `docs/ux` | UX-концепция, разбор и статическое демо на синтетических данных |
| `docs/AI_CONTEXT_MAP.md` | Карта кода и документов для агентов |

## Быстрый старт

Требуются Git с полной историей, Node **24**, npm и .NET SDK **10.0.401 или совместимый 10.0.4xx** (точные правила
SDK — `apps/crm/global.json`). Для интеграционных и браузерных проверок нужен Docker (локальный SQL Server);
обычная сборка не обращается к рабочим системам.

```sh
git clone https://github.com/Oleksandr-Kliuiev/parasol.git
cd parasol
nvm use
npm run bootstrap
npm run build
npm run check
```

Если `dotnet` отсутствует в PATH, задайте `DOTNET` полным путём к бинарному файлу и `DOTNET_ROOT` каталогом
установленного SDK. Корневой npm-пакет не добавляет зависимостей; приложение сохраняет свой lockfile и инструменты.

## Команды

| Команда | Результат |
| --- | --- |
| `npm run bootstrap` | `npm ci` интерфейса CRM и `dotnet restore` |
| `npm run build` | CRM backend (Release) и SPA; то же, что `npm run build:crm` |
| `npm run check` | История импорта и `check:crm` |
| `npm run check:history` | Проверка SHA, точности импорта и архивных веток |
| `npm run check:crm` | Lint, типы и тесты интерфейса, CRM unit и architecture |
| `npm run test:crm:unit`, `npm run test:crm:architecture` | Отдельно unit и архитектурные тесты после Release-сборки |
| `npm run test:crm:integration` | SQL Server и storage integration в локальных контейнерах после Release-сборки |
| `npm run test:crm:e2e` | CRM Web + Worker + локальная SQL test DB + макеты внешних API, Chromium, Firefox и WebKit |
| `npm run test:harness:unit` | Unit-тесты помощников запуска финансового сценария (`apps/crm/tools/testing/harness`) |
| `npm --prefix apps/crm/web run e2e:finance -- /absolute/new/run` | Финансы клиента на настоящих Web/Worker и SQL Server в своём контейнере, с уборкой |
| `node --test scripts/*.test.mjs` | Тесты корневых инструментов |
| `node docs/ux/demo/tools/check-locales.mjs`, `node docs/ux/demo/tools/smoke.mjs` | Переводы и браузерные проверки UX-демо |

SPA CRM собирается в `apps/crm/src/Hosts/Crm.Web/wwwroot`, .NET-сборки — в каталоги `bin/Release`. Для контейнеров
и эксплуатации использовать [комплект Hostinger](deploy/hostinger/README.md), а не копировать локальные
build-каталоги на сервер.

## Что означает зелёный CI

| Job | Что проверяет |
| --- | --- |
| `history` | История импорта (`check:history`), тесты корневых инструментов, `test:harness:unit` |
| `crm-backend` | Release-сборка без предупреждений, аудит зависимостей, unit, architecture, SQL Server и storage integration в локальных контейнерах, порог покрытия |
| `crm-frontend` | Lint, типы, unit-тесты интерфейса, тесты инструмента нагрузки, сборка с бюджетом первой загрузки, `npm audit` |
| `crm-e2e` | Браузерные сценарии в Chromium, Firefox и WebKit на настоящих Web/Worker, SQL Server и макетах внешних API |
| `hostinger` | Тесты отказов и изоляции комплекта, сборка образов, миграция базы, настоящий restic backup и restore в новый изолированный стек на синтетических данных |
| `required` | Все перечисленные jobs прошли |

Приёмка строгая: каждый unit, architecture, SQL integration и браузерный тест должен пройти, без пропусков и без
списка разрешённых ошибок. Рабочие базы и внешние интеграции не используются.

Текущие результаты и ограничения: [VERIFICATION.md](docs/migration/VERIFICATION.md). Локальные результаты не
подменяют подтверждение выполнения CI на GitHub.

История и SHA исходников сохранены: [описание импорта](docs/migration/IMPORT.md), план и границы первого этапа —
[M01–M03](docs/migration/M01-M03.md). Вложенные Azure workflows и инфраструктурные файлы CRM сохранены как исходный
материал; GitHub не запускает workflows из `apps/crm/.github`. В корневом CI нет Azure, публикации образов, деплоя,
рабочих ключей или подключения к Microsoft 365/Atera/Huntress/PowerOffice.
