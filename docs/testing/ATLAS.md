# Полные проверки Atlas

Общие команды не имеют списка допустимых ошибок. Ошибка процесса, failed, skipped,
cancelled или todo завершают проверку ошибкой. Playwright работает без retries и запрещает
`test.only`. Длительные сценарии на 200 случаев входят в обычную приёмку.

## Окружение

Node 24, установленный `apps/atlas/node_modules`, собранный Atlas, PostgreSQL 17 и Chromium.
Полный набор требует **macOS arm64**: унаследованные проверки Unix peer credentials,
Seatbelt и F_FULLFSYNC привязаны к этой платформе. Для Hostinger отдельно проверяется
сборка на Linux; это не заявление о переносимости нативного R-EVAL инструмента на Linux.
CI использует `macos-15` для полного набора и `ubuntu-24.04` для Linux-сборки.

```sh
npm run build:atlas
npm run test:atlas
# test:atlas:strict — тот же строгий runner, отдельного baseline-режима больше нет.
```

Для PostgreSQL задайте `ATLAS_PG_ADMIN_URL` на отдельную тестовую базу и
`ATLAS_REVAL_NATIVE_PG_FIXTURE` на JSON-дескриптор локального Unix-кластера:

```json
{
  "socketDir": "/private/tmp/your-test-cluster",
  "port": 55437,
  "dataDirectory": "/private/tmp/your-test-cluster/data",
  "adminRole": "parasol_test",
  "adminSecretFile": "/private/tmp/your-test-cluster/admin-password"
}
```

Все пути должны быть реальными, без symlink, каталоги — 0700, файл пароля — 0600.
Не используйте рабочую БД: тесты создают и удаляют собственные базы и роли.

`node scripts/atlas-postgres.mjs start` создаёт такой кластер из установленного
PostgreSQL 17 (`PG_BIN` либо `brew --prefix postgresql@17`), слушающий только Unix socket
и loopback. Команда выводит путь к `env.json` с переменными для тестов. В GitHub Actions
они автоматически добавляются в `GITHUB_ENV`; шаг `stop` выполняется с `always()`.
Для локального запуска перенесите переменные из `env.json` в окружение процесса.

```sh
npm run test:atlas:pg
# Полный набор, включая 200 случаев с реальными временными ограничениями; около часа.
(cd apps/atlas && npx playwright install chromium)
npm run test:atlas:ui
# Все браузерные сценарии; около 25 минут, включая 200 запросов с реальным rate limit.
node scripts/atlas-postgres.mjs stop
```

В CI нет production secrets, платных вызовов LLM, рабочих внешних интеграций или deployment.
Время полного набора предусмотрено в timeout job. Ограничения темпа, deadlines и проверки
безопасности продукта ради ускорения тестов не отключаются.

## Историческая целостность и текущая логика

`tests/fixtures/reval-history/rsdc.json.gz` содержит архивные байты для Reader-интерфейса
проверки артефакта. `verifyRevision(historicalReader)` проверяет исходные манифесты,
печати, source/build hashes и candidate seal; ошибка fixture блокирует загрузку корпуса.
Текущие state machines, CLI dispatcher, HTTP-код и браузерный код выполняются из Parasol.
Тестовые CLI-композиции передают историческую identity явным аргументом. Production entry
не читает тестовых флагов и по умолчанию проверяет текущее дерево: архивный допуск остаётся
отклонённым после изменения исходников. Подмены `ok: true`, новых «принятых» хешей и изменений
старых seals нет. Положительные и tamper-проверки полной цепочки выполняются на fixture;
отказ старого RC5 проверяется на историческом RS-D-C и на текущем дереве.

Это регрессионные тесты на синтетических данных, а не разрешение на live R-EVAL или
подтверждение готовности к рабочему развёртыванию.


## Текущая локальная проверка M35, 17 октября 2026

Полные строгие наборы прошли: unit **717/717**, PostgreSQL **802/802**, browser **90/90**.
Ноль failures, skips, todos, cancellations и browser retries. Длительные 200-case
native/browser сценарии сохранены. Проверены 1428 неизменных source/input файлов;
все три owned native кластера, loopback listeners, private-окружения и принадлежащий
запуску временный runtime prefix удалены.

[Текущее свидетельство](evidence/atlas-strict-current-2026-10-17.json) совпадает с
[неизменяемым M35](evidence/atlas-strict-M35-2026-10-17.json). Прежние
[M31 714/797/90](evidence/atlas-strict-M31-2026-10-17.json) и dated report от 16 октября
сохранены. Новые device-scoped проверки включают серверные counts/paging, same-name
devices, foreign scope, закрытую историю, отзыв текущей связи и привязку cursor.
Исторические seals/manifest/fixtures ради новых исходников не менялись. Это локальная
синтетическая регрессия, не разрешение рабочего R-EVAL и не приёмка провайдеров или VPS.
