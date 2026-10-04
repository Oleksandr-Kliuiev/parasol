# DEV-05 Проверенный артефакт и управляемый выпуск

Приоритет: **P1**. Аудит: **A05**.

Зависимости реализации: DEV-00, DEV-15. Проверки: Q1, Q3, Q4.

Внешняя приёмка: EXT-11.

## Контекст

Deploy и CI запускаются независимо. Образы собираются заново, production reviewers известны только из комментария.

## Результат

В production попадает тот же неизменяемый артефакт, который проверен и принят в test.

## Прочитать перед изменением

- [.github/workflows/ci.yml](../../../.github/workflows/ci.yml)
- [.github/workflows/release.yml](../../../.github/workflows/release.yml) и [.github/workflows/promote.yml](../../../.github/workflows/promote.yml) (заменили `deploy.yml` в DEV-05)
- [.github/dependabot.yml](../../../.github/dependabot.yml)
- [infra/env/test.bicepparam](../../../infra/env/test.bicepparam)
- [infra/env/prod.bicepparam](../../../infra/env/prod.bicepparam)
- [docs/runbooks/01-first-deployment.md](../../runbooks/01-first-deployment.md)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Спроектировать CI → build/publish → test deployment → smoke → promote prod с проверкой успешных required jobs и конкретного commit SHA.
2. Закрепить release manifest: git SHA, image digests web/worker/migrator, версии схемы, SBOM, результаты проверок и происхождение артефакта. Продвижение без пересборки.
3. Учитывать безопасность workflow_run/reusable workflows: не давать untrusted fork-коду privileged credentials, не исполнять произвольный artifact при повышенных правах.
4. Настроить ограниченную федерацию OIDC, branch/environment protections и реальные required reviewers как отдельную внешнюю проверку; не путать YAML-комментарий с настройкой.
5. Миграции выполнять отдельной identity внутри VNet. Проверять expand/contract и совместимость предыдущего образа. Добавить существенный smoke, а не только health 200.
6. Разделить значения PowerOffice test/prod явным fail-closed validation; убрать неявное применение Demo к prod. Сканировать prod и build-time зависимости; ошибки scanner/source должны проваливать gate, а не считаться чистым результатом.

## Критерии приёмки

- **DEV-05-AC01** — Падение любого обязательного CI job исключает публикацию/продвижение этой версии.
- **DEV-05-AC02** — Ручной запуск с непроверенным SHA или непроверенным digest отклоняется.
- **DEV-05-AC03** — Test и prod release manifest ссылаются на одинаковые image digests.
- **DEV-05-AC04** — Сбой миграции не переключает трафик; есть проверенный сценарий отката приложения с расширенной схемой.
- **DEV-05-AC05** — Production-конфигурация не получает Demo по умолчанию; секреты отсутствуют в artifacts/logs.
- **DEV-05-AC06** — EXT-11 содержит фактические настройки окружения и свидетельство исполнения, а не только наличие workflow.

## Данные и обратимость

Изменения процесса выпуска проверять сначала на тестовом окружении. Сохранить возможность вернуть прошлый совместимый digest; автоматический destructive database downgrade запрещён.

## Границы

Не создавать production deployment во время локальной реализации задания без явно выбранного окружения и существующей авторизации.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-05.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
