# DEV-05 — доказательства выполнения

## Версия и среда

- Дата/исполнитель: 04.10.2026, Claude Opus 5.5 в Claude Code.
- Версия: ветка `codex/readiness`, от коммита DEV-04 `1721a15`; изменения DEV-05 — следующий коммит (SHA в [PROGRESS](../PROGRESS.md)).
- Среда: как в [DEV-15](DEV-15.md); дополнительно установлены локальные линтеры actionlint 1.7.12 и ShellCheck 0.11.0 (Homebrew), Bicep 0.47.16 (Azure CLI 2.89.1), bash 3.2 локально (в GitHub — bash 5; скрипты совместимы с обоими).
- Данные: только синтетические. **GitHub Actions и Azure не выполнялись**: у репозитория нет remote, развёртывание и изменение настроек не разрешены поручением. Digests в сухом прогоне — синтетические.
- Область: CI/CD — gate обязательных job'ов, сборка один раз с digest, manifest, SBOM, сканирование и provenance, развёртывание в test с кандидатной ревизией и smoke, продвижение в prod без пересборки, откат без миграций, разрывы схемы, fail-closed сканеры, фиксированная конфигурация PowerOffice по окружениям, закрепление actions; Bicep (digests, кандидат, тег релиза, имя окружения); проверка конфигурации при старте; документация.

## Подтверждённая проблема и реализация

**До** (воспроизведено чтением и запуском): `deploy.yml` срабатывал на тот же push в `main`, что и CI, независимо от его результата, и собирал образы заново (`dotnet publish -t:PublishContainer` в каждом запуске, в том числе для prod), ссылаясь на тег `:${sha}`; reviewers prod — комментарий в YAML; smoke — `curl /health/ready`; `CRM_POWEROFFICE_ENVIRONMENT: ${{ vars.CRM_POWEROFFICE_ENVIRONMENT || 'Demo' }}` давал prod значение Demo, перекрывая `Production` из `prod.bicepparam`; шаг «Vulnerable packages» (`dotnet list … | tee vulnerable.txt; ! grep …`) в стандартной оболочке GitHub (`bash -e` без `pipefail`) проходил при ошибке источника; `npm audit --omit=dev` не проверял сборочные зависимости; первый запуск задачи миграций после bootstrap шёл с пустыми аргументами заглушки (crm-web запустился бы веб-сервером, а не миграцией). Проверки совместимости отката не было — и она нашла реальный дефект (см. AC04).

**После** ([ADR-015](../../adr/ADR-015-release-pipeline.md), [runbook 01](../../runbooks/01-first-deployment.md) §2, §6, §6a, §9):

- `ci.yml`: job `release` с `needs: [backend, frontend, e2e, infrastructure, codeql]`, только для push в `main`; отмена устаревших прогонов только для PR; fail-closed сканеры через `tools/release/release.py`; job `infrastructure` запускает тесты инструментов выпуска.
- `release.yml` (`workflow_call`): `publish` — SPA, образы один раз, digest, SBOM (syft), grype (High/Critical, ошибка = провал), provenance-аттестации, manifest с версиями схемы и разрывами, проверка на секреты, артефакт 90 дней; `deploy-test` — проверка manifest, schema guard, `deploy.sh`, запись развёртывания.
- `promote.yml` (`workflow_dispatch`: SHA, окружение, `rollback`, `accept_schema_break`): `verify` без учётных данных окружения (CI-прогон, job'ы, manifest, запись test) → `deploy` в окружении (reviewers): schema guard, `gh attestation verify`, `az acr import` по digest со сверкой, `deploy.sh`, запись.
- `tools/release/`: `release.py` (сканеры, секреты, схема, manifest, запись, promotion-check, schema-guard), `deploy.sh` (миграции → Bicep с кандидатом → проверка digest всех контейнеров → smoke кандидата → трафик → smoke → запись; при провале публичного smoke трафик возвращается), `smoke.sh`, `current-release.sh`, `rollback-compat.sh`, `release-settings.sh` (сбор фактических настроек для EXT-11), `schema-breaks.json`, тесты `test_release.py` и `test_deploy.py`. `deploy.yml` удалён.
- Bicep: `webImageDigest`/`workerImageDigest` вместо тега, `webStableRevision` (кандидат с 0 % трафика, `webCandidateUrl`), `releaseCommit` → тег `crmRelease`, `Deployment__Environment` всем контейнерам; `powerOfficeEnvironment` без значения по умолчанию, зафиксирован в `*.bicepparam`.
- Приложение: `PowerOfficeOptions.FitsDeployment` + `ValidateOnStart` — prod только с Production, test только с Demo, неизвестное имя окружения — отказ.
- `.gitignore`: шаблон `[Rr]elease/` скрывал бы `tools/release/` от Git — добавлено исключение.

Изменённые и новые файлы: `.github/workflows/{ci.yml, release.yml (новый), promote.yml (новый), deploy.yml (удалён)}`, `tools/release/*` (новые), `.gitignore`, `infra/{main.bicep, modules/apps.bicep, env/test.bicepparam, env/prod.bicepparam}`, `src/Integrations/Crm.Integrations.PowerOffice/{PowerOfficeOptions.cs, PowerOfficeModule.cs}`, тесты (`ReleasePipelineTests`, `MigrationCompatibilityTests`, `DeploymentGuardTests` — новые), документация (ADR-015 — новый, runbook 01, docs/07, CLAUDE.md).

## Проверка критериев

| AC | Входные данные / действие | Ожидаемый результат | Фактический результат | Статус | Тест/протокол/артефакт |
|---|---|---|---|---|---|
| DEV-05-AC01 | Структура CI (архитектурный тест сверяет `needs` job'а `release` со всеми job'ами CI, условие push в `main`, нет `always()`/`continue-on-error`); manifest при `e2e=failure`; CLI-прогон | Падение любого обязательного CI job исключает публикацию/продвижение | `release` зависит от всех пяти job'ов (новый job CI без решения валит тест); manifest с красным job'ом — отказ «required CI jobs not successful: e2e»; продвижение с красным job'ом в прогоне — отказ. GitHub-исполнение не проверено (нет remote) | pass (локально) | `ReleasePipelineTests.Every_required_ci_job_gates_the_release`, `test_release.Manifest.*`, [pipeline-dryrun](DEV-05/pipeline-dryrun.txt) §1, §5 |
| DEV-05-AC02 | `promotion-check` с чужим/коротким SHA, digest, которого не было в test, проваленным или отсутствующим job'ом, одной упавшей ногой матрицы, проваленным smoke, записью не из test; структура `promote.yml` (verify до deploy, без учётных данных, вход только через env, attestation verify до import) | Ручной запуск с непроверенным SHA или digest отклоняется | Все 8 негативных случаев — отказ; проверенный релиз — допуск. В workflow проверка выполняется до использования учётных данных окружения; provenance сверяется до копирования образа | pass (локально) | `test_release.Promotion.test_an_unverified_sha_or_digest_is_refused`, `ReleasePipelineTests.A_promotion_never_rebuilds…`, `…Only_the_release_and_promotion_workflows_reach_an_environment`, [pipeline-dryrun](DEV-05/pipeline-dryrun.txt) §4–5 |
| DEV-05-AC03 | Записи test и prod одного manifest; `promote.yml` без сборки (тест), импорт по digest со сверкой | Test и prod release manifest ссылаются на одинаковые digests | Digests web/worker/migrator в записях test и prod идентичны (разные реестры); запись отказывает, если контейнер работает с другим digest; в `promote.yml` нет `dotnet publish`/`docker build`/`npm` | pass (локально) | `test_release.Promotion.test_the_tested_artifact_is_promoted…`, `test_deploy.*another_digest*`, [pipeline-dryrun](DEV-05/pipeline-dryrun.txt) §6 |
| DEV-05-AC04 | (а) `deploy.sh` против поддельного `az` и локального стенда crm-web: миграция Failed, провал smoke кандидата, чужой digest, нет образа в реестре, успех, провал публичного smoke, откат. (б) `rollback-compat.sh`: E2E прежнего релиза на временной БД со схемой нового — DEV-02 на расширенной схеме DEV-03 (новая таблица `Charges`, колонки `Kind`/`SendStartedAt`, расширенные статусы); DEV-04 на схеме DEV-05; DEV-03 на схеме DEV-04. (в) Правило expand-only и реестр разрывов | Сбой миграции не переключает трафик; есть проверенный сценарий отката с расширенной схемой | (а) 7/7: при сбое миграции нет ни Bicep, ни трафика; провал кандидата/digest — нет трафика; провал публичного smoke — трафик возвращён; откат без миграций. (б) DEV-02 на схеме DEV-03 — **52/52**, DEV-04 на схеме DEV-05 — **54/54**; DEV-03 на схеме DEV-04 — **9 сценариев биллинга падают** (HTTP 500 на сборе: модель без `HasTrigger` пишет с OUTPUT, ошибка 334) — разрыв зарегистрирован, откат ниже него и развёртывание поверх старого релиза без окна отклоняются schema guard. (в) все миграции expand-only, миграции с триггерами зарегистрированы | pass (локально) | [test_deploy](DEV-05/release-tools-tests.txt), [bf0eda5 на 646a565](DEV-05/rollback-compat-bf0eda5-on-646a565.txt), [1721a15](DEV-05/rollback-compat-1721a15.txt), [646a565](DEV-05/rollback-compat-646a565.txt), `MigrationCompatibilityTests.*`, `test_release.SchemaBreaks.*`, [pipeline-dryrun](DEV-05/pipeline-dryrun.txt) §7 |
| DEV-05-AC05 | Параметры окружений, workflows, старт приложения с `Deployment:Environment` prod/test и PowerOffice Demo/Production; проверка артефактов и записей на шаблоны секретов | Production не получает Demo по умолчанию; секретов нет в artifacts/logs | prod.bicepparam — `'Production'`, test — `'Demo'`, без значения по умолчанию и без переменной workflow (тест); приложение не стартует с чужой средой (юнит-тесты); manifest, SBOM, записи развёртывания и сам evidence проверены `scan-secrets` (тесты ловят пароли строк подключения, ключи, SAS, JWT, токены). Конвейер не использует секретов (OIDC) и не печатает их | pass (локально) | `DeploymentGuardTests`, `ReleasePipelineTests.Images_are_deployed_by_digest…`, `test_release.SecretScan.*`, [bicep-build](DEV-05/bicep-build.txt) |
| DEV-05-AC06 | Фактические настройки: защита `main`, required checks, reviewers и политика веток окружения `prod`, права Actions, федерация OIDC, роли identities; исполнение конвейера | EXT-11 содержит фактические настройки окружения и свидетельство исполнения | **Не выполнено**: у репозитория нет remote, доступа к настройкам GitHub и Azure нет, развёртывание не разрешено. Подготовлен сбор фактических настроек (`tools/release/release-settings.sh`, только чтение) и порядок настройки (runbook 01 §2, §6) | blocked (EXT-11) | — |

## Запуски

| Время (UTC, 04.10.2026) | Команда | Exit | Результат |
|---|---|---|---|
| 02:26–02:27 | `smoke.sh` против локального crm-web (временная БД `crm-smoke-dev05`, удалена) и негативный прогон по неверному адресу | 0 / 1 | 10/10 проверок; негативный — 8 провалов, exit 1 ([json](DEV-05/smoke-local.json), [негатив](DEV-05/smoke-local-negative.json)) |
| 02:34–02:37 | `rollback-compat.sh 646a565` (DEV-03 на схеме DEV-04) | 1 | 44 passed, 9 failed — найден разрыв схемы ([лог](DEV-05/rollback-compat-646a565.txt)) |
| 02:41–02:44 | `rollback-compat.sh 1721a15` (DEV-04 на текущей схеме) | 0 | 54/54 |
| 02:45–02:48 | `ROLLBACK_SCHEMA_FROM=646a565 rollback-compat.sh bf0eda5` (DEV-02 на схеме DEV-03) | 0 | 52/52 |
| 02:48 | Сухой прогон цепочки через CLI | — | см. [протокол](DEV-05/pipeline-dryrun.txt) |
| 02:49–02:50 | Шаги job'ов `backend` и `infrastructure` из ci.yml локально | **PASSED** | Unit 354/354, Architecture 82/82, Integration 127/127, Coverage: домен 96.41 % (1262/1309), backend 85.44 % (15 250/17 848); новый шаг пакетов (JSON-gate) — без находок; тесты инструментов и сборка Bicep ([backend](DEV-05/ci-local-backend.txt), [infrastructure](DEV-05/ci-local-infrastructure.txt), [покрытие](DEV-05/coverage-summary.md)) |
| 02:50 | Шаги job'а `frontend` (lint, typecheck, vitest, build, новый npm audit-gate со сборочными зависимостями) | 0 | vitest 39/39, бандл 283.0 KB, уязвимостей нет ([сводка](DEV-05/frontend.txt)) |
| 02:51–02:54 | Полный E2E (новая БД, сборка SPA) | 0 | 54/54 ([список](DEV-05/e2e.txt)) |
| после | Тесты инструментов (26), actionlint, ShellCheck | 0 | 26/26, без находок ([тесты](DEV-05/release-tools-tests.txt), [линтеры](DEV-05/lint.txt)) |

**Известных красных проверок нет.**

## Данные и обратимость

Схема БД не менялась. Выпуск: миграции до любых изменений ревизий и трафика, разрушающий откат схемы автоматически не выполняется; откат приложения — трафик на прежнюю ревизию или повторное развёртывание прежнего релиза без миграций, если его manifest и запись доступны и он не ниже применённого разрыва схемы. Возможность вернуть прошлый совместимый digest сохраняется (артефакты 90 дней; реестры хранят образы).

Найденный разрыв: схема DEV-04 (триггеры биллинга) несовместима с релизами до DEV-04 — их запись в биллинг падает. Следствия: (1) откат ниже DEV-04 — только после отката миграции `ProtectApprovedBilling` администратором БД (данные не теряются) и ручного развёртывания; (2) первое развёртывание DEV-04+ поверх старого релиза ломает старую ревизию между миграцией и переключением — в prod только в maintenance window (runbook 01 §6a), в test принимается. Правильная последовательность для будущих подобных изменений — сначала релиз с `HasTrigger`, затем релиз с триггерами (ADR-015).

## Самопроверка и остаточные риски

Самопроверка (не независимое review): diff workflows и скриптов, actionlint/ShellCheck, инъекция через входы `workflow_dispatch` (только через env, тест), права job'ов, порядок «проверка → учётные данные → изменения», поведение при недоступности manifest (fail-closed), первый выпуск после bootstrap (аргументы задачи миграций), совместимость bash 3.2/5. Найдено и исправлено при самопроверке: `[Rr]elease/` в .gitignore скрыл бы инструменты от Git; задача миграций после bootstrap осталась бы с пустыми аргументами; тестовый запуск отката выявил разрыв схемы DEV-04, для которого добавлены реестр и guard.

Остаточные риски и владельцы:

- **EXT-11** (владелец репозитория + operations + PO): создать remote, environments `test`/`prod` с reviewers и политикой веток, защиту `main` с required checks, права Actions, федерацию OIDC и AcrPull идентичности prod на реестр test; выполнить конвейер и приложить `release-settings.sh` + прогоны; принять конкретный release manifest.
- Поведение `az acr import` по digest, `gh attestation verify` для приватного ACR и метки `candidate` Container Apps проверены только по документации и статически — первый прогон в test это подтвердит.
- Хранение manifest и записей дольше 90 дней — решение владельца.
- ZAP baseline, автооткат по алерту 5xx, what-if в PR — не реализованы и не заявлены.

Статус **code_verified**: AC01–AC05 проверены локально, AC06 blocked до EXT-11; `accepted` — после выполнения конвейера в реальном окружении, EXT-11 и независимой проверки.
