# Деплой Atlas на VPS (admin.vardahei.tech)

Статус: пилот, решение владельца 2026-10-13 (консоль на сервере, вход только учёткой Microsoft, API для другого проекта на том же
VPS, автоматическая синхронизация, безопасность уровня пилота). Секреты и их ввод — `SECRETS_INVENTORY.md`.

## Схема

```
браузер ──https──► Caddy (общий, atlas-edge-caddy-1) ──► atlas-admin-oauth2:4180 (вход Microsoft, Entra «Vardahei Atlas»)
                                                            └─► atlas-admin-api:3100 с Authorization: Basic <email>:<секрет прокси>
машина (Bearer) ─► Caddy ─────────────────────────────────► atlas-admin-api:3100 (свой токен актора)
другой проект на VPS (сеть atlas_edge) ───────────────────► http://atlas-admin-api:3100 (свой токен актора)
atlas-admin-scheduler ─► scripts/ops.ts по расписанию ─► Atera / Huntress / Microsoft Graph (только GET)
atlas-admin-db (PostgreSQL 17, без опубликованного порта, сеть internal)
```

- **Вход людей.** oauth2-proxy пускает только тех, кому назначено приложение Entra (oleksandr@, asbjorn@, bjarte@vardahei.no) и чей
  домен vardahei.no. Он передаёт API `Basic email:секрет`; `apps/api/src/deploy/proxy-identity.ts` проверяет секрет и подставляет
  токен собственного актора этого человека. Дальше — принятые проверки токена, права по клиентам и RLS без изменений.
- **Машины.** Сервисный актор (`svc-integration`: `context:read`, `m365:read`) с Bearer-токеном. Описание API — `GET /openapi.json`.
- **Консоль.** `https://admin.vardahei.tech/operator/` подключается сессией входа (без ввода токена). Проверка Host пропускает
  `127.0.0.1:<порт>` и `ATLAS_ALLOWED_HOSTS` (`admin.vardahei.tech`, `atlas-admin-api:3100`).
- **Синхронизация.** `scripts/scheduler.ts` (`ATLAS_SYNC_JOBS`): Atera/Huntress `live-read` каждые 15 мин, входы M365 каждый час
  (закрытые часы с задержкой 1 ч), каталог M365 каждые 6 ч, обработка событий каждые 5 мин — от имени актора `scheduler`.

## Файлы на сервере (`/etc/atlas-admin`, root, 0700/0600)

| Файл | Кто пишет | Что |
|---|---|---|
| `secrets.env` | владелец, `atlas-admin-secret set` | `ATERA_*`, `HUNTRESS_*`, `M365_*`, `OAUTH2_PROXY_CLIENT_SECRET` |
| `atlas.env` | оператор | `ATLAS_ENTRA_TENANT_ID`, `ATLAS_ENTRA_LOGIN_CLIENT_ID`, `ATLAS_CLIENTS`, `ATLAS_PEOPLE`, `ATLAS_SERVICES`, `ATLAS_SYNC_JOBS`, ID арендаторов для bind |
| `db.env`, `generated.env` | `deploy/bootstrap.sh` | пароль PostgreSQL, пароли ролей, секрет курсора, секрет прокси, cookie-секрет |
| `tokens.env`, `api.env`, `scheduler.env`, `oauth2.env` | `deploy/setup.ts` | токены акторов и env каждого контейнера (только нужное ему) |

## Порядок

1. Код: `rsync` или `git clone` в `/opt/atlas-admin` (не `/opt/atlas` — это другой, старый проект).
2. `sudo /opt/atlas-admin/deploy/bootstrap.sh` — один раз.
3. `docker compose -f deploy/compose.yaml -p atlas-admin build` и `… up -d db`.
4. `docker compose -f deploy/compose.yaml -p atlas-admin run --rm admin node --experimental-strip-types deploy/setup.ts`
   (миграции, `roles.sql`, акторы и токены, env-файлы; повторный запуск ничего не меняет и не ротирует).
5. Владелец: client secret приложения входа Entra → `sudo atlas-admin-secret set OAUTH2_PROXY_CLIENT_SECRET`; затем снова шаг 4.
6. Подключения (один раз): в контейнере `admin` под токеном оператора — `ops bind` (`--tenant` из `atlas.env`), `m365-probe`.
7. `… up -d api oauth2 scheduler`; в общий Caddyfile — блок `deploy/Caddyfile.admin`, `caddy validate`, затем `caddy reload`.
8. Проверка: `/openapi.json` 200; без входа `/operator/` ведёт на вход Microsoft; после входа консоль видит клиентов; Bearer
   сервисного актора — `GET /clients` 200; логи планировщика — одна JSON-строка на задачу.

## Откат

`docker compose -p atlas-admin down` (данные в томе `atlas-admin-pgdata` остаются); в Caddyfile вернуть заглушку 503 из резервной
копии и `caddy reload`. Другие проекты VPS и их контейнеры не затрагиваются.

## Влияние на R-EVAL

Печати R-EVAL (RS-A…RS-D-C) закрепляют почти все файлы репозитория. Деплой меняет закреплённые `apps/api/src/main.ts`,
`apps/api/src/operator/{http,console}.ts`, `apps/operator/src/{credential,controller,main,origin}.ts` и тесты, поэтому
`scripts/reval-instrument/cli.ts artifact-check` показывает `BUILD_DRIFT`/`SOURCE_DRIFT`, и тесты идентичности R-EVAL
(`reval-instrument-{identity,census,run,units}`, `reval-rc5-guard`) падают по построению. Свойство «сервер оценки S не читает
переменные деплоя» сохранено: все чтения деплоя в `main.ts` стоят за `bridge ?`, это проверяет `tests/reval-static.test.ts`.
Перед запуском R-EVAL нужна новая ревизия инструмента, которая закрепит текущее дерево. R-EVAL сейчас не допущен (данные, бюджет, ключ).
