# Перечень секретов и переменных окружения (продакшен, VPS)

Статус: справочник оператора, 2026-10-13 (после печати RS-D-C). Не допуск к деплою: деплой и вход через Microsoft Entra ID требуют
отдельного архитектурного брифа и ревью (`docs/deploy/`, пока не написан). Живое чтение Atera/Huntress/M365 допущено владельцем (§F).

Правила:
- Значения никогда не попадают в репозиторий, чат, argv, логи или квитанции. В БД хранятся только ссылки `env://ИМЯ`
  (`connectors/secrets.ts`, RUNBOOK §1).
- На VPS значения лежат в root-файле `/etc/atlas-admin/secrets.env` (0600, владелец root), который systemd/compose передаёт процессу
  как EnvironmentFile. Несекретная конфигурация — в `/etc/atlas-admin/atlas.env` (0644). Шаблон: `deploy/atlas.env.example`.
- Секреты третьих сторон вводит владелец сам: `ssh vardahei-vps`, затем `sudo atlas-admin-secret set ИМЯ` (скрытый ввод, запись в
  `secrets.env`, без эха и без истории shell). Источник скрипта — `deploy/atlas-admin-secret` (уже установлен, §F); проверка — `atlas-admin-secret list` (только имена).
- Генерируемые секреты создаются на сервере (`openssl rand`/`crypto.randomBytes`) и сразу пишутся в файл, без вывода.

## A. Внешние, вводит владелец

| Имя (`env://…`) | Значение | Где взять | Нужно для | Статус |
|---|---|---|---|---|
| `ATERA_<КЛИЕНТ>` | API-ключ Atera (Bearer) | Atera → Admin → API | live-чтение Stage 1 (`bind --system atera --tenant <AteraCustomerID>`) | live НЕ допущен |
| `HUNTRESS_<КЛИЕНТ>` | `<api key>:<api secret>` одной строкой (Basic) | Huntress → API Credentials | live-чтение Stage 1 (`--tenant <HuntressOrgID>`) | live НЕ допущен |
| `M365_<КЛИЕНТ>` | `<application id>:<client secret>` одной строкой | Entra приложения Graph в тенанте клиента | `m365-probe`/`m365-sync` (Stage 2) | live НЕ допущен; коннектор поддерживает только client secret |
| `ATLAS_ASK_REMOTE_<ИМЯ>` | ключ выделенного проекта провайдера | платформа провайдера | Ask remote / R-EVAL | только после допуска данных и бюджета; ключ PENDING |
| `OPENAI_API_KEY` | ключ провайдера для Decisions | платформа провайдера | `ATLAS_DECISIONS_MODE` ≠ `rules` | не включено |

Несекретные идентификаторы (tenant ID клиента, AteraCustomerID, HuntressOrgID) передаются в `ops bind --tenant` и хранятся в БД.

## B. Генерируются на сервере

| Имя | Что | Требование |
|---|---|---|
| пароль роли-владельца БД | миграции, `roles.sql`, seed | только для операций владельца; не в окружении API |
| `ATLAS_RUNTIME_DATABASE_URL` | URL роли runtime с паролем | API и CLI; `assertRuntimeRole` отказывает владельцу |
| `ATLAS_CORRELATION_CURSOR_SECRET_REF` → `env://ИМЯ` | секрет курсора корреляции | ≥32 байт; один на все процессы |
| `ATLAS_M365_CLEANUP_RUNNER_SECRET_REF` → `env://ИМЯ` | URL роли `atlas_m365_cleanup_runner` | цель совпадает с runtime URL (RUNBOOK §8) |
| `ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF` → `env://ИМЯ` | URL роли очистки PowerOffice | RUNBOOK §10 |
| ключ сессий входа | подпись/шифрование cookie сессии Entra | ≥32 байт; имя — в брифе деплоя |
| ключ шифрования резервных копий БД | шифрование дампов | хранится отдельно от дампов |

## C. Сертификаты

- TLS для `admin.vardahei.tech`: Let's Encrypt через обратный прокси (ACME, автоматически). Требует A-записи DNS на VPS.
- Учётные данные приложения входа Entra ID: сертификат, а не client secret. Ключ генерируется на VPS и не покидает его; в Entra
  загружается только публичный сертификат. Срок и ротация — в брифе деплоя.

## D. Уходит в продакшене

`ATLAS_DEMO_TOKEN`, `ATLAS_OPERATOR_TOKEN` — синтетические токены разработки/seed. Продакшен-вход: Entra ID, доступ только
назначенным пользователям (oleksandr@, asbjorn@, bjarte@vardahei.no). До реализации входа консоль наружу не публикуется.

Ограничение принятой архитектуры: консоль Stage 5 спроектирована как локальная. Её граница (`apps/api/src/operator/http.ts`)
принимает только `Host: 127.0.0.1:<port>` и не доверяет прокси и forwarded-заголовкам (защита от DNS rebinding), а API
аутентифицирует Bearer-токеном актора. Публикация на `admin.vardahei.tech` за обратным прокси со входом Entra ID меняет эту
принятую границу безопасности. Нужен отдельный архитектурный бриф деплоя и входа с независимым ревью до любой реализации.

## E. Запрещено в окружении продакшена

- `ATLAS_POWEROFFICE_{LIVE,TENANT,CLIENT_KEY,APPLICATION_KEY,TOKEN,SECRET_REF,…}` — их присутствие отказывает запуск
  (`POWEROFFICE_REFUSED_VARIABLES`, `packages/poweroffice/composition.ts`); live PowerOffice не реализован.
- `ATLAS_REVAL_*` — только локальная R-EVAL на darwin, не на VPS.

## F. Состояние на 2026-10-13 (с подтверждения владельца)

Идентификаторы тенанта и приложений в репозиторий не записываются (приватные входные данные, бриф S2-LIVE RC5); они видны в
Entra и в приватной конфигурации оператора.

- **Вход (Entra ID, тенант Vardahei IT).** Приложение «Vardahei Atlas (admin.vardahei.tech)»: только этот тенант, Web redirect
  `https://admin.vardahei.tech/auth/callback`, делегированные openid/profile/email (User.Read удалён), «назначение обязательно»,
  назначены ровно oleksandr@, asbjorn@, bjarte@vardahei.no. Учётных данных нет: сертификат появится при деплое (ключ на VPS).
- **Чтение M365 (Entra ID).** Приложение «Vardahei Atlas Graph Reader»: только этот тенант, без redirect; права ПРИЛОЖЕНИЯ Microsoft
  Graph Organization.Read.All, User.Read.All, Device.Read.All, AuditLog.Read.All, согласие администратора дано; делегированный
  User.Read удалён. Client secret создан владельцем (срок выбран владельцем — ротация до истечения).
- **DNS.** A `admin.vardahei.tech` → IP VPS, TTL 3600 (Hostinger).
- **VPS.** `deploy/atlas-admin-secret` установлен как `/usr/local/sbin/atlas-admin-secret` (root 0750); `/etc/atlas-admin/` (0700),
  `secrets.env` (0600) содержит `ATERA_VARDAHEI`, `HUNTRESS_VARDAHEI`, `M365_VARDAHEI` (введены владельцем; значения Claude не видел).
  `/etc/atlas` на VPS — другой, старый проект: не трогать. Общий Caddy (`/etc/atlas-edge/Caddyfile`, compose-проект
  `/opt/atlas/deploy`): сайт `admin.vardahei.tech` — заглушка 503 «not deployed yet», HSTS, noindex; сертификат Let's Encrypt получен.
- **Локально (оператор).** Копия секретов для приватной локальной сессии живого чтения: `~/.config/atlas-live/secrets.env` (0600).
- **Допуски.** Владелец 2026-10-13 допустил живое ЧТЕНИЕ Atera, Huntress и M365 (процедуры RUNBOOK §5 и S2-LIVE RC5, локальная
  пилотная БД, данные хранятся пару дней). Деплой Atlas на VPS не допущен: нужен архитектурный бриф деплоя и входа (консоль Stage 5
  принимает только `Host: 127.0.0.1:<port>`).
