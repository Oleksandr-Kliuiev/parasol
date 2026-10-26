# M07 — развёртывание и восстановление на Hostinger

PR #4 слит в main merge-коммитом `ee571738859e05b740b69ee4aa00822c70f81f21`.
Новая работа выполнена в Parasol; исходные репозитории CRM и прежнего сервиса интеграций
(удалён в [M38](M38-OPERATIONS-IN-CRM.md)), их HEAD, refs и локальные изменения сверены с исходным
снимком и не изменены.

## Изменения

- Linux x64 образы CRM web/worker, образ прежнего сервиса и его отдельный migrator. Версии Caddy,
  restic, PostgreSQL, SQL Server, Node и .NET закреплены digest. Приватного registry
  и автоматической публикации/деплоя нет.
- Общий Compose: HTTPS через Caddy, внутренние сети/БД, loopback прежнего сервиса при web,
  постоянные документы/keyring/TLS, отдельные runtime и migration credentials.
- Private JSON/PFX mounts; загрузка конфигурации до регистрации сервисов и небольшой
  health probe из существующего .NET runtime. В образах нет локальных секретов.
- Microsoft 365 app authentication по файловому сертификату, без managed identity
  fallback; Azure Monitor SDK удалён. Entra login сохраняется. Исправлена обнаруженная
  в production-режиме ошибка: неавторизованный API возвращает 401 локально;
  явный login по-прежнему запускает OIDC.
- Согласованные SQL/PG dumps + полный store/config/keyring, шифрование restic,
  hash inventory, отдельные offsite credentials и recovery kit. Проверка backup,
  статус для мониторинга, systemd templates, ограниченная retention после restore proof.
- Restore создаёт новый проект и новые volumes, проверяет native DB backups и права,
  поднимает web и прежний сервис без внешней сети. Worker/публичный вход остаются выключены;
  promotion требует актуальных privacy/effect journals и reconciliation.
- Новый обязательный CI job выполняет образную сборку и реальный synthetic restore drill;
  существующие gates CRM и прежнего сервиса сохранены без исключений.

Новые инфраструктурные компоненты Caddy и restic явно разрешены владельцем в этом чате.
Новых NuGet/npm production dependencies нет.

## Эксплуатация и границы

Пошаговая инструкция: [deploy/hostinger/README.md](../../deploy/hostinger/README.md).
Инсталляция выключает внешние интеграции/запись и требует явной настройки Entra,
employee tokens, DNS, SFTP backup и мониторинга перед открытием доступа.

Рабочий VPS, DNS, реальные клиентские данные, credentials и провайдеры не изменялись.
Локальное учение не доказывает действительность Entra app registration, выдачу ACME
сертификата, доступность внешнего SFTP или производственный RTO/RPO. Их проверяют перед запуском.
SQL Express выбран явно; ограничения ёмкости и лицензирование описаны в runbook.

## Проверки

Локально, 16.10.2026, без пропусков и без retry:

| Проверка | Результат |
| --- | --- |
| CRM Release solution build | 0 ошибок, 0 предупреждений |
| CRM unit, включая сертификаты Graph | 652/652 |
| CRM architecture | 94/94 |
| CRM SQL/storage/auth integration | 466/466 |
| Browser: workspace, роли, reverify, PDF/версии | 12/12; Chromium, Firefox, WebKit |
| Operations: ошибки backup, inventory, isolation, retention | 12/12 |
| Coverage | Critical domain 96.92%; backend 90.89%; пороги соблюдены |
| Root tooling, history, actionlint, Caddy config, secret scan | Пройдены |
| Native SQL/PG + restic backup/restore | Проверено в отдельном контейнерном стеке |

Полный протокол учения (удалён в M38: `git show 73c0158:docs/migration/evidence/M07-restore.json`).
На маленьком синтетическом наборе backup занял 14.31 с, restore — 21.38 с; это не производственный RTO.

Учение меняет значения в обеих исходных БД после backup, удаляет синтетический PDF,
останавливает source и восстанавливает прежние значения и точные документы/keyring
в новую инсталляцию. Повреждение зашифрованного pack обнаруживается `check --read-data`.
Неполная копия, отсутствующий keyring и несовпадающий volume ID отвергаются; восстановленная
инсталляция не получает внешнюю сеть и не возвращается в production автоматически.

В аудитe NuGet нет High/Critical. Сохраняется прежняя Moderate в MessagePack 2.5.302
у локального Aspire Crm.AppHost ([GHSA-qhrr-8q5h-9q3h](https://github.com/advisories/GHSA-qhrr-8q5h-9q3h));
этот dev host не входит в production images.

Исходный код прежнего сервиса не изменялся; новые entrypoint/build/restore пути проверены
контейнерным учением, а полные прежние unit/PG/browser gates остаются в CI.
Удалённый GitHub CI оценивается отдельно: ранее jobs не стартовали из-за billing/spending limit.
