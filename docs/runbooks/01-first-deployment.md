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
> Для строгого варианта ограничьте «Role Based Access Control Administrator» условием на назначаемые роли (Key Vault Secrets/Certificate/Crypto User, Storage Blob Data Contributor, AcrPull).

## 3. Регистрация приложения в Entra ID
```bash
./infra/entra/register-app.sh test https://<временный-адрес-или-домен>
az ad app permission admin-consent --id <APP_ID из вывода>
```
Скрипт создаёт App Roles, группы `CRM-<Role>-test` и назначает роли группам. После шага 4 запустите его ещё раз с третьим аргументом — `principalId` управляемой идентичности crm-worker `id-crm-worker-test` (`az identity show -g rg-crm-test -n id-crm-worker-test --query principalId -o tsv`): она получит право Graph `User.Read.All` для синхронизации пользователей. crm-web (`id-crm-app-test`) это право не нужно ([runbook 08](08-database-permissions.md)). Redirect URI обновляется повторным запуском скрипта, когда станет известен итоговый адрес (шаг 6).

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

az keyvault certificate create --vault-name $KV -n crm-web-auth -p "$(az keyvault certificate get-default-policy | jq '.x509CertificateProperties.subject="CN=vardahei-crm-test" | .lifetimeActions[0].trigger.daysBeforeExpiry=30 | del(.lifetimeActions[0].trigger.lifetimePercentage)')"
az keyvault certificate download --vault-name $KV -n crm-web-auth -f crm-web-auth.cer -e DER
az ad app credential reset --id <APP_ID> --cert @crm-web-auth.cer --append

# Закрыть доступ обратно
az keyvault network-rule remove -n $KV --ip-address $MY_IP
az keyvault update -n $KV --public-network-access Disabled
rm crm-web-auth.cer
```
Сертификат продлевается Key Vault автоматически; после продления новый публичный ключ нужно загрузить в регистрацию (алерт «сертификат истекает через 30 дней» — [07 § 4.2](../07-nfr-devops.md#42-алерты)).

## 6. Переменные GitHub и первый деплой
```bash
gh variable set AZURE_CLIENT_ID --env test --body <clientId из шага 2>
gh variable set AZURE_SUBSCRIPTION_ID --body <subscription-id>
gh variable set CRM_ENTRA_TENANT_ID --body <tenant-id>
gh variable set CRM_ENTRA_CLIENT_ID_TEST --body <app-id>
gh workflow run deploy.yml -f environment=test
```
Пайплайн: SPA → образы в ACR → идентичность `id-crm-worker-test` (создаётся, если её нет) → задача миграций `caj-crm-migrate-test` (схемы, роли `crm_web`/`crm_worker`, права; `id-crm-app-test` становится членом `crm_web`, `id-crm-worker-test` — `crm_worker`, без `db_datawriter`) → Bicep с новым тегом → smoke-проверка `/health/ready`. Матрица прав — [runbook 08](08-database-permissions.md).

Для `prod` в настройках GitHub Environment `prod` включите **Required reviewers**.

## 7. Домен и вход
1. Container Apps → `ca-crm-web-test` → Custom domains: добавить `crm-test.<домен>`, управляемый сертификат.
2. Повторить шаг 3 с итоговым адресом (обновит Redirect URI).
3. Conditional Access (Entra ID → Protection): политика для приложения «Vardahei CRM (test)» — MFA для всех; phishing-resistant MFA для групп `CRM-Admin-*` и `CRM-Finance-*`; при необходимости — только совместимые устройства.
4. Добавить сотрудников в группы `CRM-<Role>-test`; группу `CRM-Admin-test` вести через PIM.

## 8. Проверка
- Вход сотрудником каждой роли; `/bff/user` возвращает ожидаемые `roles` и `permissions`.
- Создать организацию через поиск в Brreg → запись в журнале аудита.
- Application Insights: запросы видны, ошибок 5xx нет.
- Hangfire (`/admin/jobs`, роль Admin): задача `brreg-registry-check` запланирована на 02:00 Europe/Oslo.
