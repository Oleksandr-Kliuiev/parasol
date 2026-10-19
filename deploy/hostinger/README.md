# Parasol на Hostinger VPS

Комплект одного Linux x64 сервера: Caddy → CRM web + Atlas по loopback, отдельный
CRM worker, SQL Server 2022 и PostgreSQL 17. Azure-инфраструктуры нет. Microsoft 365
остаётся провайдером входа; название секции `AzureAd` — формат Microsoft.Identity.Web.

Это инструкция подготовки и эксплуатации. Наличие файлов не означает, что рабочий VPS,
DNS, Entra, резервная площадка или мониторинг уже настроены.

## Состав и границы

- `compose.yaml`: наружу опубликованы только 80/443 Caddy; SQL, PostgreSQL, web, worker
  и Atlas не публикуют порты. Atlas разделяет сетевое пространство web и слушает
  `127.0.0.1:3100`, сохраняя правило M05 «HTTPS либо loopback» для employee credentials.
- `crm.Dockerfile`, `atlas.Dockerfile`: воспроизводимые версии и digest базовых образов;
  web/worker работают UID 1654, Atlas UID 1000, с read-only rootfs, без capabilities.
  Prisma CLI находится в отдельном `atlas-admin` образе. Docker context исключает секреты
  и результаты локальных сборок. Образы собираются локально; публикации в registry нет.
- `parasol.py`: создание **нового** state, build, миграции, запуск, backup, проверка и
  восстановление. Python ≥3.11, OpenSSL и Docker Engine с Compose v2; pip не нужен.
- `rehearse.py`: повторяемое учение на синтетических данных, также обязательный CI job.
- `systemd/`: шаблоны ежедневного backup и еженедельного полного чтения restic.

Для первоначального размещения заложить 4 vCPU / 8 GB RAM и SSD с местом для данных,
двух наборов образов и временной полной копии БД/документов. Это стартовый бюджет,
а не измеренная производственная ёмкость. Учение восстановления лучше выполнять на
втором хосте с таким же runtime: два SQL Server на рабочем VPS требуют дополнительной памяти.

SQL настроен как **Express**, не Developer/Evaluation. Express имеет предел 10 GB на
реляционную БД и ограничение buffer pool; при росте нужна лицензированная редакция либо
отдельный проект переноса CRM на другую БД. См. [матрицу SQL Server 2022 Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-editions-and-components-2022?view=sql-server-ver16).
Перед эксплуатацией оператор подтверждает условия лицензии (`ACCEPT_EULA=Y` в Compose).

## Новая инсталляция

Команды ниже выполняет оператор после разрешения на реальное развёртывание. Не применять
их к существующей CRM/Atlas базе. Перенос имеющихся данных — отдельная операция.

1. Подготовить Linux x64, Docker/Compose, Python 3.11+, OpenSSL. Использовать отдельного
   оператора/sudo; членство в Docker group равносильно root. Открыть 80/443, ограничить SSH.
   Учитывать правила Docker firewall, а не полагаться только на UFW. Не добавлять DB ports.
2. Разместить checkout выбранного коммита в `/opt/parasol`, полную историю Git сохранить.
   Для каждого выпуска использовать новый `--release` (например короткий SHA); не
   перетегировать предыдущий образ. Держать предыдущие образы для восстановления.
3. Подготовить DNS, адрес оператора TLS и single-tenant Entra application registration.
   Redirect URI: `https://<домен>/signin-oidc`, logout callback: `/signout-callback-oidc`.
   Назначить app roles трём сотрудникам по M05. Публичную часть сертификата загрузить в Entra;
   закрытый PFX и пароль передать защищёнными файлами. Не помещать их в Git/командную строку.
4. Создать **отсутствующий** каталог состояния вне checkout:

   ```sh
   sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/parasol init \
     --release <commit> --domain <домен> --tenant <tenant-guid> --client <app-guid> \
     --oidc /secure/entra.pfx --password-file /secure/entra-password
   ```

   Генерируются отдельные случайные пароли БД, UUID документов, сертификат шифрования
   DataProtection и пароль restic. Существующие каталоги не перезаписываются, пароли не
   выводятся. Самостоятельно сгенерированный DP сертификат не нужно загружать в Entra.
5. В `/srv/parasol/stack.json` задать `TLS_EMAIL`, проверить свободную `PROXY_SUBNET`
   (не пересекается с сетями хоста/VPN/Docker), IP Caddy `.254`, порты и редакцию SQL.
   При смене subnet обновить `Forwarded:KnownProxies` в `config/web.json` и `migrate.json`.
   `READ_ONLY=true` оставить до завершения первоначальной настройки.
6. Настроить offsite backup (ниже), вынести recovery kit в отдельное защищённое место.
7. Выполнить последовательно:

   ```sh
   sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/parasol build
   sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/parasol migrate
   sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/parasol up
   ```

   Migrations работают один раз с admin-доступом. Web/worker получают разные SQL logins
   и только роли `crm_web`/`crm_worker`; Atlas — `atlas_app`, без owner/superuser/BYPASSRLS.
   Runtime не выполняет DDL. Обновления выполнять в окне обслуживания, после backup,
   остановив приложения; все команды оператора используют один file lock.
8. В maintenance проверить HTTPS, локальный 401, offsite backup + restore на отдельном
   хосте. Для **первого** Entra входа в пустую БД требуется запись профиля: в согласованном
   окне bootstrap установить `READ_ONLY=false`, сохранив внешние интеграции выключенными,
   перезапустить и проверить вход/выход, роли/отзыв роли, карточку клиента и PDF. При ошибке
   вернуть maintenance. Не открывать обычную работу сотрудников до этой проверки.
   `up` создаёт контейнеры заново при
   изменении Compose env; после правки содержимого bind-mounted JSON нужен stop/up либо
   явный restart: конфигурация загружается один раз на процесс.

### Секреты, интеграции и сертификаты

`/srv/parasol` и `config/` — 0700, владелец root/оператор. Отдельные файлы, монтируемые в
непривилегированные контейнеры, — 0444 **внутри закрытого родительского каталога**. Это
намеренно: Compose bind mounts не меняют UID file secrets. Контейнер видит только свои
явные mounts; web не получает SA/PG owner/restic password. Не открывать родительский каталог.
`data/documents` и `data/keyring` принадлежат UID/GID 1654, 0700. Том и маркер нельзя
пересоздавать при обычном обновлении. State включает TLS данные Caddy.

SQL TLS внутри закрытой bridge-сети использует `TrustServerCertificate=True`; DB порты
не должны быть опубликованы. Для вынесенной БД требуется проверяемый сертификат и другое
развёртывание, а не удаление проверки соединения.

Внешние интеграции, mail/SharePoint/Teams, provider writes, Ask и Atlas scheduler выключены.
Для Graph application permissions добавить в private JSON `Integrations:MicrosoftGraph`:
`Enabled`, `TenantId`, `ClientId`, `CertificatePath=/run/secrets/oidc.pfx`, `CertificatePassword`.
Если Graph использует отдельную app registration, смонтировать отдельный PFX только нужным
сервисам. Нет DefaultAzureCredential, managed identity, Key Vault или Application Insights.
Delegated календарь/почта продолжают использовать сессию вошедшего сотрудника.

Общий workspace включается после создания отдельных Atlas actors и tokens каждого
сотрудника: `Parasol:Atlas:Enabled=true`, `Employees` по M05, `BaseUrl=http://127.0.0.1:3100/`.
Provisioning не создаёт реальные фирмы/пользователей автоматически. Документация M05 описывает
права; не запускать исторический Atlas `deploy/setup.ts` с жёстко заданными пользователями.

Сертификаты ротировать отдельной согласованной операцией. Для DP сохранить старые PFX в
`PreviousCertificatePaths`, пока существуют зашифрованные ими ключи; включить дополнительные
mounts и backup. Для входа сначала добавить новый публичный сертификат в Entra, затем заменить
PFX/config и перезапустить. Старый DP сертификат нужен и для старых backup.

## Резервные копии

Backup останавливает Caddy, web, worker и Atlas, делает SQL `COPY_ONLY ... CHECKSUM`
и `RESTORE VERIFYONLY`, PostgreSQL custom dump + globals/роли, копирует документы,
keyring, TLS данные и private config. SHA-256 inventory охватывает весь набор.
Затем запускает **только ранее работавшие** сервисы, а зашифрованную загрузку restic
выполняет уже после возобновления работы. Ночное окно включает краткую недоступность.
Файловая блокировка исключает параллельные операции. Restic читает и восстанавливает файлы
через временный Linux volume (это также устраняет несовместимость read flags с shared folders
Docker Desktop). Планировать место ещё для одной staging-копии. Временные plaintext dumps и volumes очищаются
после попытки; это не гарантирует физическое стирание SSD. Ограничить доступ к диску/снимкам хоста.

Production-команда принимает SFTP repository; локальное хранилище разрешено только в
синтетическом rehearsal. Настроить защищённые файлы в `backup/`:

- `repository`: `sftp:backup-host:/absolute/path/parasol`, отдельный хост/аккаунт/диск.
- `password`: сгенерированный пароль шифрования restic, 0600.
- `id_ed25519`: отдельный ключ backup account, 0600.
- `known_hosts`: fingerprint удалённого SSH сервера, проверенный отдельным доверенным каналом.
- `ssh_config`: заменить REPLACE, оставить `StrictHostKeyChecking yes`, `BatchMode yes` и
  пути `/run/backup/...`; пароль в URL не нужен.

Конфигурация соответствует [restic repository setup](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html).
Само шифрование не защищает от удаления backup обладателем SFTP ключа. На стороне offsite
включить отдельные snapshots/защиту удаления, которые учётная запись VPS не может отменить.
Ежедневный backup даёт целевой RPO до 24 часов при исправном расписании; после сбоя RPO
увеличивается. Для более строгого RPO нужны более частые копии/отдельный WAL/log shipping проект.

```sh
sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/parasol backup-init
sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/parasol backup
sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/parasol check
sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/parasol snapshots
```

`backup-init` — один раз; backup не создаёт пустой repository при опечатке/сбое доступа.
Ненулевой exit, restic partial backup или отсутствующий snapshot ID означают неуспех.
`check` читает **все** данные (`--read-data`), а не только индекс;
см. [restic integrity checks](https://restic.readthedocs.io/en/stable/045_working_with_repos.html).

После первого успешного offsite restore установить шаблоны systemd, подставив фактические
пути, включить timers. Скрипт `status` возвращает ошибку, если backup старше 36 часов,
полная проверка старше 8 дней или последняя попытка не завершилась успешно. Использовать
это как Atera script monitor; уведомления/адресатов настроить при запуске. Логи systemd
содержат только итог и snapshot ID, без вывода конфигурации. Контролировать свободный диск.
Если хост/процесс был аварийно остановлен во время backup, проверить также временные контейнеры и volumes с label
`com.parasol.scratch=<project>` и `.snapshot-*` в private state: авария может оставить
незашифрованную временную копию. Удалять только после проверки отсутствия активной операции.
Проверить состояние сервисов
и `backup-status.json`: Python finally не выполняется после SIGKILL/потери питания.

Retention: 7 daily / 4 weekly / 6 monthly. `retention` делает только dry run;
`retention --apply` удаляет старые snapshots/unused packs и требует свежие backup/check
и restore proof не старше 31 дня. Автоматическое удаление не включено в timers.
Перед удалением отдельно проверить требования к срокам хранения. Restic retention относится
к резервным копиям, а не к законному удалению персональных данных из приложения.

### Recovery kit вне VPS

Отдельно хранить в защищённом хранилище `stack.json`, адрес repository, пароль restic,
SSH recovery key и verified known_hosts; доступ к исходникам/конкретным образам и Docker/Compose.
Без пароля restic его содержимое нельзя расшифровать. Сам backup содержит оба DB dumps,
приложенческие credentials, PFX, документы/keyring и manifest, но **не** ключи доступа к себе.
Для переноса приложения на другой сервер сохранить образы через `docker image save` либо
согласовать private registry; manifest проверяет точные image IDs, а не доверяет перетегированному tag.

## Восстановление и возврат в работу

```sh
sudo python3 /opt/parasol/deploy/hostinger/parasol.py --state /srv/recovery-kit restore \
  --snapshot <точный-ID> --destination /srv/parasol-restored-20261016
```

`/srv/recovery-kit` содержит сохранённые `stack.json` и `backup/`. Можно также использовать
state исправного исходного сервера как источник repository. Destination должен отсутствовать
и находиться вне source. `latest` не принимается: оператор выбирает конкретный snapshot.

Восстановление сверяет restic AEAD/хеши, manifest и точные application image IDs; поднимает
**новые** Compose project, сети и DB volumes; восстанавливает PostgreSQL roles до данных,
SQL с CHECKSUM/VERIFYONLY/CHECKDB, перепривязывает SQL logins и проверяет runtime roles.
Документы, маркер тома, PFX и keyring копируются побайтно. Поднимаются только web и Atlas
для внутренних readiness checks: все их сети internal, worker и Caddy выключены,
портов наружу нет, `Maintenance:ForceReadOnly=true`.

Результат — `quarantined`, не готовая замена production. Команда `up` отказывает для
восстановленного состояния. Это исключает автоматическую отправку старых заданий в
PowerOffice/почту и показ клиентских данных до reconciliation.

Для возврата в работу требуется отдельная согласованная операция:

1. Оставить старую инсталляцию в maintenance и остановить всех авторов. Сохранить её
   текущие documents, **особенно** `privacy/manifests/`, `operations/effects/` и
   `operations/maintenance/`. Копия этих журналов должна быть не старее последних внешних
   действий/удалений. Восстановление старого SQL не может отменить совершённое удаление
   или повторить отправленный счёт. Если актуальные журналы потеряны вместе с VPS,
   автоматический возврат в запись запрещён: нужен анализ offsite snapshots и поставщиков.
2. Сверить актуальные append-only записи с восстановленным store: одинаковый ключ обязан
   иметь те же байты; новые записи перенести без перезаписи. Не удалять записи ради совпадения
   с более старым backup. При расхождении остановиться. Сохранить исходную копию для расследования.
3. Применить существующий privacy replay, затем restore reconciliation сначала dry run,
   затем подтверждённое применение. Не включать orphan cleanup/worker/outbound до завершения.
   Порядок и API описаны в ADR-021 и историческом runbook 03; команды Azure из него
   не применять. Этот комплект не подменяет бизнес-проверку сопоставлением числа файлов.
4. Проверить SQL Ready-документы: каждый ключ существует, SHA-256 и длина совпадают;
   открыть выборку PDF/версий, проверить роли, customer mapping, сводку Atlas и вход/выход.
   Старая сессия/TokenCache расшифровываются только с правильным keyring/PFX; при компрометации
   хоста следует согласованно отозвать сессии и заменить credentials вместо их восстановления.
5. Проверить актуальные Entra credentials и сертификаты, отключённые интеграции, новые
   DNS/proxy настройки и offsite backup. Зафиксировать разрешение на снятие quarantine,
   новый release/config и план переключения. Сначала открыть проверенный web, затем worker
   и отдельно разрешённые интеграции. Старые состояние/образы сохранять до проверки результата.

Обратимый откат **кода до появления новых записей** использует предыдущий image tag на
совместимой схеме. После миграций нельзя произвольно вернуть прежний образ; после новых
записей нельзя вернуть только БД или только папку документов. Нужна согласованная пара
состояния и повторная reconciliation. `down --volumes` для production запрещён.

## Локальное учение и проверки

```sh
python3 -m unittest discover -s deploy/hostinger/tests -v
sudo python3 deploy/hostinger/rehearse.py --directory /absolute/new/private/drill --release rehearsal
```

Скрипт создаёт только синтетические tenant IDs/сертификаты/данные; приложения не имеют
внешней сети. Caddy доступен на случайном localhost HTTP порту; ACME и реальный вход не
вызываются. Проверяются production-режим приложений, schema migrations, ограниченные роли,
защита API, native backup, последующее изменение обеих БД/потеря документа, восстановление
прежнего содержимого в новый стек, точное совпадение документов/keyring, отказ при повреждении
зашифрованного restic pack и последующая полная проверка исправленного repository.

Текущий сценарий дополнительно сохраняет синтетическую цепочку наблюдение Atlas →
назначенная CRM-задача → подтверждённый сохранённый тикет → свои 0,25 часа → постоянная
квитанция создания. После backup исходные задача, часы и состояние наблюдения меняются.
В восстановленной копии должны совпасть все поля 8 SQL и 5 PostgreSQL записей, включая
rowversion, исходный hash квитанции и связи. Проверяются ключи SourceTaskLinks/квитанции
и фактический запрет UPDATE/DELETE квитанций под обоими runtime SQL login.
Seeder работает только в изолированном rehearsal с пустыми бизнес-таблицами; рабочий
restore новых таблиц не требует и старые backups не переписывает. Это проверка хранения
через owner, а не входа Entra или HTTP-повтора: API-сценарий отдельно проверяет composition.

`--skip-build` использует уже собранные образы указанного release. По умолчанию finally
удаляет только контейнеры/сети/volumes созданных тестовых Compose projects; глобального prune
нет. `--keep` оставляет их для приватной диагностики. На диске остаётся закрытый каталог с
синтетическими credentials/backup и `report.json`; после изучения удалить **именно этот**
каталог. В CI публикуется только report, никогда state или Docker logs.

Числа локального учения показывают работоспособность процедуры на маленьком синтетическом
наборе. RTO реальных клиентов измеряется на Hostinger и выбранном offsite канале отдельно.
TLS issuance, реальный Entra вход, доступность offsite и уведомления остаются внешними
проверками перед вводом в эксплуатацию.
