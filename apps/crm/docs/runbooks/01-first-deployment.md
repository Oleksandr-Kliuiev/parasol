# Runbook 01. Первое развёртывание окружения (test / prod)

Выполняется один раз на окружение. Роли: **Azure Owner** на подписку/группу ресурсов, **Global или Privileged Role Administrator** в Entra ID, администратор репозитория GitHub.

Команды ниже — для окружения `test`; для `prod` замените `test` → `prod`.

## 0. Предварительно
- `az login --tenant <tenant-id>` и `az account set --subscription <subscription-id>`.
- Установлены Azure CLI ≥ 2.60 (Bicep подтягивается автоматически), `gh`, Python 3.

## 1. Группа ресурсов
```bash
az group create -n rg-crm-test -l norwayeast --tags application=vardahei-crm environment=test
```

## 2. Идентичность для GitHub Actions (OIDC, без секретов)
```bash
az identity create -g rg-crm-test -n id-crm-github-test
PRINCIPAL=$(az identity show -g rg-crm-test -n id-crm-github-test --query principalId -o tsv)
CLIENT=$(az identity show -g rg-crm-test -n id-crm-github-test --query clientId -o tsv)
RG_ID=$(az group show -n rg-crm-test --query id -o tsv)
# Contributor — ресурсы; Role Based Access Control Administrator — назначения ролей из Bicep
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal --role Contributor --scope $RG_ID
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal --role "Role Based Access Control Administrator" --scope $RG_ID
az identity federated-credential create -g rg-crm-test --identity-name id-crm-github-test -n github-test \
  --issuer https://token.actions.githubusercontent.com \
  --subject "repo:<org>/<repo>:environment:test" --audiences api://AzureADTokenExchange
```
> Для строгого варианта ограничьте «Role Based Access Control Administrator» условием на назначаемые роли (Key Vault Secrets User, Key Vault Reader, Key Vault Crypto User, Storage Blob Data Contributor, AcrPull).

Для `prod` то же с `-prod`, и дополнительно идентичности `id-crm-github-prod` право **AcrPull на реестр test**: продвижение копирует проверенные образы из реестра test по digest, ничего не собирая заново (ADR-015):
```bash
TEST_ACR_ID=$(az acr list -g rg-crm-test --query "[0].id" -o tsv)
az role assignment create --assignee-object-id $(az identity show -g rg-crm-prod -n id-crm-github-prod --query principalId -o tsv) \
  --assignee-principal-type ServicePrincipal --role AcrPull --scope $TEST_ACR_ID
```
Federated credential prod — только `repo:<org>/<repo>:environment:prod`: токен получает лишь job, привязанный к окружению `prod`, т.е. прошедший его reviewers.

## 3. Регистрация приложения в Entra ID
```bash
./infra/entra/register-app.sh test https://<временный-адрес-или-домен>
az ad app permission admin-consent --id <APP_ID из вывода>
```
Скрипт создаёт App Roles, группы `CRM-<Role>-test` и назначает роли группам. После шага 4 запустите его ещё раз с третьим аргументом — `principalId` управляемой идентичности crm-worker `id-crm-worker-test` (`az identity show -g rg-crm-test -n id-crm-worker-test --query principalId -o tsv`): она получит права Graph `User.Read.All` (синхронизация пользователей), `Application.Read.All` и `GroupMember.Read.All` (синхронизация ролей каждые 2 минуты, [runbook 12](12-roles-and-sessions.md)). crm-web (`id-crm-app-test`) это право не нужно ([runbook 08](08-database-permissions.md)). Redirect URI обновляется повторным запуском скрипта, когда станет известен итоговый адрес (шаг 6).

## 4. Инфраструктура без образов (bootstrap)
```bash
export CRM_ENTRA_TENANT_ID=<tenant-id> CRM_ENTRA_CLIENT_ID_TEST=<app-id> CRM_BOOTSTRAP=true
az deployment group create -g rg-crm-test -f infra/main.bicep -p infra/env/test.bicepparam
```
Создаются сеть, SQL, Key Vault, Storage, реестр, окружение Container Apps с тестовым образом-заглушкой. Выходные значения: `webUrl`, `keyVaultName`, `natPublicIp`.

## 5. Сертификат приложения (учётные данные вместо client secret)
Key Vault закрыт от интернета, поэтому доступ открывается временно только для IP администратора:
```bash
KV=<keyVaultName>
MY_IP=$(curl -s https://api.ipify.org)
az role assignment create --assignee $(az ad signed-in-user show --query id -o tsv) --role "Key Vault Certificates Officer" --scope $(az keyvault show -n $KV --query id -o tsv)
az keyvault update -n $KV --public-network-access Enabled --default-action Deny
az keyvault network-rule add -n $KV --ip-address $MY_IP

az keyvault certificate create --vault-name $KV -n crm-web-auth -p "$(az keyvault certificate get-default-policy | jq '.x509CertificateProperties.subject="CN=vardahei-crm-test" | .keyProperties.keySize=3072 | .lifetimeActions[0].trigger.daysBeforeExpiry=30 | del(.lifetimeActions[0].trigger.lifetimePercentage)')"
az keyvault certificate download --vault-name $KV -n crm-web-auth -f crm-web-auth.cer -e DER
az ad app credential reset --id <APP_ID> --cert @crm-web-auth.cer --append

# Закрыть доступ обратно
az keyvault network-rule remove -n $KV --ip-address $MY_IP
az keyvault update -n $KV --public-network-access Disabled
rm crm-web-auth.cer
```
Ключ сертификата — RSA 3072 (DEV-21, F-G4-08). Сертификат остаётся экспортируемым: crm-web читает закрытый ключ через секрет Key Vault, неэкспортируемый ключ приложение не получит — риск принят и ограничен правом на один секрет (DEV-04-AC05).
Сертификат продлевается Key Vault автоматически; после продления новый публичный ключ нужно загрузить в регистрацию (алерт «сертификат истекает через 30 дней» — [07 § 4.2](../07-nfr-devops.md#42-алерты)).

## 6. Настройки GitHub и первый выпуск
Переменные (значения — идентификаторы, не секреты; у каждого окружения своя `AZURE_CLIENT_ID`):
```bash
gh variable set AZURE_SUBSCRIPTION_ID --body <subscription-id>
gh variable set CRM_ENTRA_TENANT_ID --body <tenant-id>
gh variable set AZURE_CLIENT_ID --env test --body <clientId id-crm-github-test>
gh variable set CRM_ENTRA_CLIENT_ID_TEST --env test --body <app-id test>
gh variable set AZURE_CLIENT_ID --env prod --body <clientId id-crm-github-prod>
gh variable set CRM_ENTRA_CLIENT_ID_PROD --env prod --body <app-id prod>
```
Защита (выполняет владелец репозитория; это и есть EXT-11, YAML её не заменяет):
- Environment `prod`: **Required reviewers** (не автор выпуска), **Deployment branches**: только `main`; environment `test`: только `main`.
- Ветка `main`: PR обязателен, ≥ 1 approve, **required status checks**: `backend`, `frontend`, `e2e`, `infrastructure`, `codeql (csharp)`, `codeql (javascript-typescript)`; без force push; правила и для администраторов.
- Actions: default workflow permissions — read; разрешены только actions, закреплённые SHA (или выбранные).
- Сбор фактических настроек для приёмки: `tools/release/release-settings.sh <org>/<repo> release-settings.json` (только чтение, без секретов).

Выпуск (ADR-015): merge в `main` → CI → job `release`: образы собираются один раз, manifest с digests, SBOM, сканирование, provenance → `deploy-test`: проверка схемы, миграции (задача `caj-crm-migrate-test`, identity мигратора внутри VNet; сбой — без изменений ревизий и трафика), новая ревизия под меткой `candidate` с 0 % трафика, smoke, сверка digests, переключение трафика, smoke, запись развёртывания. Роли БД: `id-crm-app-test` → `crm_web`, `id-crm-worker-test` → `crm_worker` ([runbook 08](08-database-permissions.md)).

В prod — только проверенный релиз: Actions → **Promote** → полный SHA коммита, окружение `prod`. Workflow проверяет прогон CI, manifest и запись test, ждёт reviewers окружения `prod`, импортирует те же digests в реестр prod и разворачивает их тем же скриптом.

### 6a. Релиз с разрывом схемы
Если проверка схемы отвечает, что работающий релиз не переживёт разрыв (`tools/release/schema-breaks.json`, например первое развёртывание DEV-04 поверх более старой версии): договориться об окне, приостановить интеграции и биллинг ([runbook 05](05-pause-integration.md)), включить режим обслуживания (только чтение, [runbook 03 § 2](03-database-restore.md#2-режим-обслуживания-t1)) — он останавливает и записи, и отправки worker, запустить Promote с `accept_schema_break`, после проверки вернуть обычную работу и снять паузу. `--max-replicas 0` Container Apps не принимает; если worker нужно именно выключить — `python3 tools/ops/restore.py --env prod worker-off` (затем `worker-on`).

## 7. Домен и вход
1. Container Apps → `ca-crm-web-test` → Custom domains: добавить `crm-test.<домен>`, управляемый сертификат.
2. Повторить шаг 3 с итоговым адресом (обновит Redirect URI).
3. Conditional Access (Entra ID → Protection, нужен Entra ID P1): политика для приложения «Vardahei CRM (test)» — MFA для всех; phishing-resistant MFA для групп `CRM-Admin-*` и `CRM-Finance-*`, а в Parasol — для группы «Parasoll – full tilgang»; при необходимости — только совместимые устройства. Без P1 — security defaults tenant: MFA регистрируют все, а запрашивается она по правилам Microsoft, не на каждом входе (проверить на tenant, EXT-02).
4. **Parasol ([ADR-030](../adr/ADR-030-full-access-group.md)):** создать группу «Parasoll – full tilgang (test)», назначить её роли `Crm.Admin` и добавить трёх сотрудников прямыми членами; группы `CRM-<Role>-test` оставить пустыми, PIM не включать. Без Entra ID P1 назначить `Crm.Admin` трём пользователям напрямую. Команды и проверка — [runbook 12 §1а](12-roles-and-sessions.md#1а-полный-доступ-через-одну-группу).
   Общая модель CRM (если роли разделяются): добавить сотрудников в группы `CRM-<Role>-test`; группу `CRM-Admin-test` вести через PIM.

## 8. Проверка
- Вход сотрудником каждой роли; `/bff/user` возвращает ожидаемые `roles` и `permissions`. В Parasol — вход каждым из трёх сотрудников: `roles: ["Crm.Admin"]` и полный список `permissions`.
- Создать организацию через поиск в Brreg → запись в журнале аудита.
- Application Insights: запросы видны, ошибок 5xx нет.
- Hangfire (`/admin/jobs`, роль Admin): задача `brreg-registry-check` запланирована на 02:00 Europe/Oslo.

## 9. Откат
1. **Быстро (≤ 5 мин)**, пока предыдущая ревизия crm-web активна: `az containerapp ingress traffic set -g rg-crm-prod -n ca-crm-web-prod --revision-weight <предыдущая ревизия>=100`. Worker в режиме одной ревизии — его откатывают п. 2.
2. **Штатно**: Actions → **Promote** → SHA релиза, который уже работал в окружении, `rollback: true`. Миграции не выполняются (схема остаётся новой, expand/contract), разворачиваются digests того релиза с той же проверкой smoke. Отклоняется, если релиз ниже разрыва схемы, уже применённого в окружении (`tools/release/schema-breaks.json`), или его manifest и запись развёртывания недоступны.
3. **Ниже разрыва схемы** автоматически нельзя: администратор БД откатывает конкретную миграцию (например, `ProtectApprovedBilling` снимает триггеры, данные не трогает) и разворачивает вручную по решению владельца; разрушающий откат схемы с потерей данных запрещён.
4. Совместимость предыдущего релиза со схемой нового проверяется заранее: `tools/release/rollback-compat.sh <SHA предыдущего релиза>` (временная БД, E2E предыдущего релиза на схеме текущего).
