# Исправление Atlas в Parasol — 16 октября 2026

Ветка `fix/atlas-strict-tests`. Удалён механизм допуска наследованных ошибок.
Полные unit/PG/browser runner-ы требуют ноль failures, skips, cancellations и todos.
Тесты используют синтетические данные и отдельные временные базы.

| Проверка | Текущий результат |
| --- | --- |
| Atlas unit, Node 24.22.0 | 694/694, ноль failed/skipped/cancelled/todo |
| Нативная PostgreSQL 17 цепочка | 4/4, без пропусков |
| Браузерный сценарий на 200 запросов | Прошёл целиком, 19,7 минуты, без retries |
| Общий browser gate | Полный прогон продолжается |
| PostgreSQL полный набор | Прогон всех файлов продолжается, включая длительный 200-case rehearsal |
| Atlas types/schema/build | Успешно |
| Root acceptance gates | 2/2 regression tests; workflow — actionlint без ошибок |
| История и оригинальные каталоги | SHA/архивные ветки проверены; HEAD, refs и working tree оригиналов совпадают со снимком |
| CRM | Не изменён в этом исправлении; результаты импорта приведены ниже |

Полный прогон не объявляется успешным до завершения длительных проверок. Текущие логи
остаются вне Git и не содержат рабочих данных. Настройка и границы проверки описаны
в [ATLAS.md](../testing/ATLAS.md).

Следующий раздел — результат **до исправления**. Он сохранён для сравнения и не является
действующим списком разрешённых ошибок.

---

# Историческая проверка первоначального импорта — 16 октября 2026

Проверяемая реализация: `0fcf46fc27a9c12c86fc2495a619dbba356bc1f7`.
Документация результатов добавлена отдельным коммитом; продуктовый код после этой проверки не менялся.

## Подтверждено

| Проверка | Результат |
| --- | --- |
| Приватность GitHub | `isPrivate: true`, default branch `main` |
| История | Оригинальные SHA и деревья импорта совпадают; все 3 архивные ветки опубликованы |
| Оригинальные локальные каталоги | HEAD, refs, origin и working tree совпадают со снимком до работы |
| Исходные GitHub main | Обе ветки остались на исходных SHA |
| Общая сборка `npm run build` | Успешно, Node 24.22.0 и .NET SDK 10.0.402 |
| Общий `npm run check` | Успешно с явным Atlas import baseline, см. ниже |
| Root tooling | 3 теста baseline gate прошли |
| Workflow | actionlint 1.7.12 — без ошибок |
| CRM backend | 603 unit + 94 architecture + 436 integration tests прошли |
| CRM frontend | 159 тестов, lint/types/build и bundle budget прошли |
| CRM browser E2E | Все 91 тест прошёл; Chromium, Firefox и WebKit; отдельная локальная SQL test DB и API mocks |
| CRM load tooling | Python и Node regression suites прошли |
| Atlas unit | 595 passed, 14 inherited failures, 1 skipped; все 610 тестов выполнены |
| Atlas UI, проверенная часть | 14 тестов artifact/console-render/console-fixture прошли в Chromium |
| Atlas PostgreSQL полный набор | 779 тестов: 767 passed, 9 failed, 3 skipped; 13.8 минуты. Строгий gate остаётся красным |
| Atlas PostgreSQL schema | Проверки PG17 и drift migrations/Prisma прошли на отдельном временном контейнере |
| Аудит CRM npm | 0 известных уязвимостей после обновления source-map-js |
| Аудит CRM NuGet | Нет High/Critical; 1 Moderate в транзитивном MessagePack у development AppHost |

Низкоуровневые логи с локальными путями остаются вне Git. Рабочие ключи, пароли,
сессии пользователей и клиентские данные для проверок не использовались.

## Блокеры полной приёмки M03

1. GitHub Actions **не исполнил ни одного шага**. Первый [run](https://github.com/Oleksandr-Kliuiev/parasol/actions/runs/38879607137)
   отклонён инфраструктурой GitHub: недавние платежи аккаунта не прошли либо нужно увеличить spending limit.
   Настройки оплаты и лимитов не менялись. После исправления владельцем можно запустить Parasol CI через
   `Actions → Parasol CI → Run workflow` (workflow_dispatch уже настроен).
2. Atlas сохраняет [14 известных unit-сбоев](BASELINE.md). Исключение действует только для
   неизменённого дерева исходного main и не распространяется на integration/browser tests.
3. Полный Atlas browser suite не собирается: старые eval fixtures требуют уже невалидный artifact
   и получают `CORPUS_IDENTITY_MISMATCH`. Обычная консоль проверена отдельно; это не замена всему suite.
4. Полный PostgreSQL-набор Atlas завершился с 9 ошибками. Они не включены в baseline:
   - `ops-cli`: тест ожидает 21 команду, текущий код возвращает 22 (добавлен `onboard`);
   - `poweroffice-api`: в отказе авторизации приходит текст `Unauthorized` вместо ожидаемого JSON;
   - `reval-eval-console`: размер текущего logo asset не совпадает со sealed inventory;
   - пять instrument/rehearsal/segments test files: `CORPUS_IDENTITY_MISMATCH`;
   - `reval-eval-e2e`: `CENSUS_UNAVAILABLE`; причина отдельно не установлена, требуется точечная диагностика.
   Весь исходный Atlas при этом сохранён неизменённым. Перенос не является исправлением этих ошибок.
5. Coverage gate CRM настроен по исходному workflow; локальный интеграционный прогон выполнен без
   coverage instrumentation. Численные coverage thresholds на Linux пока не подтверждены.

GitHub green CI, готовность к deployment и live R-EVAL **не подтверждены**.
Созданные для этой проверки PostgreSQL/SQL контейнеры остановлены и удалены;
существующие контейнеры и базы пользователя не изменялись.

Рабочие базы/интерфейсы/авторизация ещё не объединены; Hostinger deployment относится к следующему этапу.
