# DEV-21 Проверка безопасности по ASVS и устранение замечаний

Приоритет: **P1**. Аудит: **A04, A09, A10, A15**.

Зависимости реализации: DEV-04, DEV-05, DEV-08, DEV-09, DEV-10, DEV-11, DEV-13, DEV-14, DEV-17, DEV-18. Проверки: Q1, Q2, Q3, Q4, Q7.

Внешняя приёмка: EXT-02, EXT-06, EXT-07.

## Контекст

Есть базовые механизмы, но ASVS L2 не подтверждён. Наличие CodeQL/Dependency scan не заменяет проверки авторизации, сессий и бизнес-логики.

## Результат

Проверяемая матрица ASVS 5.0.0 L2 и независимая оценка запускаемого контура с исправлением существенных находок.

## Прочитать перед изменением

- [docs/06-security.md](../../06-security.md)
- [src/Hosts/Crm.Web/Http/WebInfrastructure.cs](../../../src/Hosts/Crm.Web/Http/WebInfrastructure.cs)
- [src/Hosts/Crm.Web/Auth/AuthenticationSetup.cs](../../../src/Hosts/Crm.Web/Auth/AuthenticationSetup.cs)
- [src/BuildingBlocks/Crm.Authorization/PermissionAuthorization.cs](../../../src/BuildingBlocks/Crm.Authorization/PermissionAuthorization.cs)
- [.github/workflows/ci.yml](../../../.github/workflows/ci.yml)
- [infra/modules/network.bicep](../../../infra/modules/network.bicep)
- [infra/modules/data.bicep](../../../infra/modules/data.bicep)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Из официальной версии ASVS получить точные requirement IDs, applicability, owner, implementation/test/evidence. Не придумывать номера; исключения обосновать и сохранить как решения.
2. Обновить threat model: BFF/session, trusted proxies/forwarded host, CSRF/CORS, XSS/CSP, imports/exports, CSV formula injection, SSRF/external URLs, webhook authenticity если используется, secrets, SQL identities, document download, BI, replay и финансовая авторизация.
3. Добавить SAST/secrets/dependency/container scan и разрешённый DAST на test. Secret scanning проверяется настройками репозитория; baseline ZAP не выдаётся за authenticated pentest.
4. Проверить Entra single tenant, assignment required, MFA/CA, PIM и Graph permissions в реальном tenant через EXT-02; отделить недоступные лицензии от выполненных контролей.
5. Подготовить обезличенный пакет для независимого проверяющего, тестовые роли и выбранную среду. Исправить находки и получить повторную проверку.
6. Определить процесс vulnerability intake, сроки реакции по severity, владельца и документирование исключений по SSDF. Не публиковать отчёт или репозиторий наружу без существующей авторизации.

## Критерии приёмки

- **DEV-21-AC01** — Каждое применимое ASVS L1/L2 требование имеет доказательство либо явный незакрытый gap; нет общей галочки соответствия.
- **DEV-21-AC02** — Негативные проверки scope, отзыва ролей, CSRF, экспорта и replay проходят после изменений.
- **DEV-21-AC03** — По независимой проверке нет известных незакрытых Critical/High в запускаемом контуре; retest приложен.
- **DEV-21-AC04** — Реальные CA/MFA и least privilege доказаны; снимок локальной конфигурации не заменяет их.
- **DEV-21-AC05** — Логи/telemetry/artifacts не содержат secrets и лишние PII; тестовые trace очищены перед передачей.
- **DEV-21-AC06** — Документация версии baseline обновлена до ASVS 5.0.0 и объясняет границы оценки.

## Данные и обратимость

Изменения заголовков/proxy policies и auth тестировать на реальном ingress test, чтобы не сломать OIDC callbacks/Teams. При обнаружении критического дефекта сохранять воспроизведение и выпускать минимальный исправляющий patch.

## Границы

Самопроверку Claude не называть независимым пентестом; внешнее заключение остаётся EXT-06.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-21.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
