# Исправление Atlas в Parasol — 16 октября 2026

Ветка `fix/atlas-strict-tests`. Удалён механизм допуска наследованных ошибок.
Полные unit/PG/browser runner-ы требуют ноль failures, skips, cancellations и todos.
Тесты используют синтетические данные и отдельные временные базы.

| Проверка | Текущий результат |
| --- | --- |
| Atlas unit, Node 24.22.0 | 694/694, ноль failed/skipped/cancelled/todo |
| Нативная PostgreSQL 17 цепочка | 4/4, без пропусков |
| PostgreSQL сценарий на 200 случаев | Прошёл целиком, 44,1 минуты: 11 сегментов, 10 переходов, 12 proofs, завершение процессов проверено |
| Браузерный сценарий на 200 запросов | Прошёл целиком, 19,7 минуты, без retries |
| Общий browser gate | 90/90, 21,9 минуты; ноль failures/skips/retries |
| PostgreSQL полный набор | 781/781 из всех 165 файлов; ноль failed/skipped/cancelled/todo |
| Atlas types/schema/build | Успешно |
| Root acceptance gates | 2/2 regression tests; workflow — actionlint без ошибок |
| История и оригинальные каталоги | SHA/архивные ветки проверены; HEAD, refs и working tree оригиналов совпадают со снимком |
| CRM | Не изменён в этом исправлении; результаты импорта приведены ниже |
| GitHub Actions | Задания не запущены: GitHub отклоняет запуск из-за оплаты или spending limit аккаунта |

Проверка выполнена на Node 24.22.0, macOS arm64, PostgreSQL 17. PostgreSQL-набор локально
запущен тремя непересекающимися группами: 776 тестов основной части (160 файлов), 4 нативных
теста и один интегрированный сценарий на 200 случаев. Объединение групп сверено с полным
списком `tests/pg/*.test.ts`: исключённых файлов нет. Все три процесса завершились с кодом 0;
итог основной части дополнительно проверен тем же `requireCompletePass`, что используется в CI.
В CI все эти файлы запускаются одной командой `npm run test:atlas:pg`.
Логи остаются вне Git и не содержат рабочих данных. Настройка и границы проверки описаны
в [ATLAS.md](../testing/ATLAS.md).

Исправлены JSON-ответы отказа авторизации PowerOffice, устаревшие ожидания списка CLI,
проверка размера бинарного HTTP-ответа и ложное совпадение суммы внутри случайного UUID.
Архивный R-EVAL corpus теперь проверяется через отдельную историческую fixture; старые
hashes/seals не переписаны, а текущий production CLI по-прежнему отказывает при drift.
Raw mode терминала включается до загрузки dispatcher, чтобы ввод не попадал в echo.
Тестовый HTTP-сервер получает свободный порт от ОС и закрывает ресурсы при ошибке старта:
повторный прогон подтвердил причину прежнего нестабильного сбоя — `EADDRINUSE`.

После последнего изменения тестового сервера отдельно прошли TypeScript, три PostgreSQL
проверки HTTP-консоли и браузерный сценарий eval-pane. Общий браузерный прогон выше
завершился на той же продуктовой реализации до этой правки тестового helper.

Последний [GitHub run](https://github.com/Oleksandr-Kliuiev/parasol/actions/runs/38887724404)
не исполнил ни одного шага. Локальные результаты не означают зелёный GitHub CI;
настройки оплаты и лимитов не менялись.

После проверки оба созданных для этой задачи PostgreSQL-кластера остановлены и удалены,
включая временные sockets и синтетические пароли. Существующие базы пользователя не затронуты.

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
