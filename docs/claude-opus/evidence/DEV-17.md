# DEV-17 — мониторинг и разбор исключений

## Версия и среда

- Дата: 04.10.2026. Исполнитель: Codex; дополнительный review выполнен агентами той же сессии, это не независимая внешняя приёмка.
- Исходная версия: `97457037320ffe2f1b1afcd72f99402098b6d120` (DEV-14), ветка `codex/readiness`. Изменения DEV-17 в рабочей копии; проверенный состав — [source-manifest.sha256](DEV-17/source-manifest.sha256).
- .NET SDK 10.0.401, Node 24.19.0, SQL Server 2022 Testcontainers/Docker Desktop, Bicep 0.47.16, Playwright Chromium/Firefox/WebKit. Production images не собирались и не развёртывались.
- Все данные синтетические. SQL fixture создаёт отдельные контейнеры, браузерные сценарии — отдельные базы `crm_e2e_dev17` / `crm_e2e_dev17_final` в собственном контейнере. Внешние API заменены WireMock/dev-mocks. Реальных уведомлений, писем и счетов не отправляли.
- Существовавшие `.claude/` и development-pack ZIP/распакованная копия сохранены без изменений.

## Проблема и реализация

Последний запуск раньше мог быть failed/skipped; он не доказывал свежесть. Добавлена долговечная отметка полного успеха `integration.SyncSuccesses`, включая тихие запуски. Частичные результаты, отмена, пауза и connection-test не обновляют свежесть. Начало новой попытки не скрывает прежнюю ошибку. `/health/integrations` теперь описывает потоки system/job; старые retry-клиенты без ETag/Replays отвергаются безопасно (428/409), после обновления требуется перезагрузить открытую вкладку. Оба потока тикетов Atera имеют порог 15 мин; recent cron исправлен с часового на каждые 10 мин со сдвигом 5 мин. PowerOffice invoices — 90 мин; остальные пороги конфигурируемы.

`ExceptionTriages` сохраняет владельца, статус, комментарий, категорию и требуемое право. Изменение с If-Match и аудитом; неизвестный/скрытый кейс — 404. После восстановления незавершённый кейс остаётся доступен для итогового комментария и Resolved. Повторное появление возвращает Open вместо старого Resolved. Финансовый доступ проверяется сервером и для исчезнувшего сигнала.

В интерфейсе — свежесть, влияние, owner picker, статус, комментарий, фильтры и до 10 представлений на пользователя в этом браузере (только фильтры, без комментариев). Таблицы прокручиваются с клавиатуры. Retry/replay ограничены 100 конкретными записями, требуют причины и подтверждённого поколения (outbound ETag, outbox Replays). Устаревшие и частичные результаты возвращаются по элементам. Подробности и обратимость — [ADR-023](../../adr/ADR-023-operational-monitoring.md).

Добавлены `Crm.Health`/`Crm.Operations`: SQL, heartbeat, outbox, outbound, last-success, failed sync, unmapped, просроченные начисления, финансовые расхождения, Preparing PDF и подтверждение Entra. Модульные contributors через SharedKernel не нарушают границы. Метрики содержат счётчики/возраст и ограниченные labels, без сумм и customer ids; восстановление выдаёт 0. Provider/legacy diagnostics не возвращают сырой текст ошибок. SyncRunner передаёт планировщику безопасное исключение без raw message, inner exception и Data; requested cancellation сохраняет семантику отмены. Endpoint permissions и CSRF остаются обязательными; запись разбора и replay аудируются.

Bicep создаёт workbook, 16 правил и группы operations/finance. Severity, stateful suppression и recovery заданы; реальные адреса не выдуманы, доставка по умолчанию выключена. [Runbook 15](../../runbooks/15-monitoring.md) описывает параметры, реакцию и протокол EXT-01. Переводы nb/en/ru согласованы.

## Проверка критериев

| AC | Действие и фактический результат | Статус | Доказательство |
|---|---|---|---|
| DEV-17-AC01 | Ошибка даёт сигнал с runbook; owner/status/comment сохраняются, устаревший ETag — 412. После успеха можно завершить разбор; повторный сбой снова Open | pass | `MonitoringApiTests.AC01…`, `web/e2e/monitoring.spec.ts` |
| DEV-17-AC02 | Failed, partial, skipped, connection-test и новый Running не продвигают last-success и не объявляют восстановление. Quiet success продвигает отметку; удаление журнала её не теряет | pass | `MonitoringApiTests.AC02…`, `MonitoringInfrastructureTests.Upgrade…` |
| DEV-17-AC03 | Роль без monitoring получает 403; оператор без finance не видит финансовый кейс/комментарий, включая direct GET и inactive case. Синтетическая сумма отсутствует в общих failure diagnostics, polling connection-test и metric labels | pass | `MonitoringApiTests.AC03…`, `OutboxDeliveryTests` (unsafe note), collector MeterListener |
| DEV-17-AC04 | Проверяется каждый ID и поколение, причина, лимит, CSRF и права. Два одновременных запроса создают одну заявку; старый запрос после нового сбоя worker отклоняется. Частичный сбой сообщает Requested/Unknown/NotRequested и сохраняет доказанные commit/audit | pass | `MonitoringApiTests.AC04…`, `OutboxDeliveryTests`, `DeliveryPanel.test.tsx`, `MonitoringPanel.test.tsx` |
| DEV-17-AC05 | 16 Bicep rules, severity, autoMitigate/recovery и конфигурация получателей реализованы; main/test/prod компилируются. Реальные владельцы/получатели, облачный KQL и Fired/Resolved не проверены | blocked (EXT-01) | `infra/modules/monitoring-operations.bicep`, [протокол](../../runbooks/15-monitoring.md#протокол-ext-01-для-мониторинга) |
| DEV-17-AC06 | Ошибка одного синтетического источника сохраняется в диагностике; другой источник успешно обновляется, SQL readiness и чтение организаций продолжают отвечать 200 | pass | `MonitoringApiTests.AC06…`, существующие проверки outage/worker/outbox полного SQL-набора |

## Запуски

Backend: сборка без предупреждений; 423 unit, 91 architecture, 257 SQL/API тестов прошли. Coverage: domain 96,88%, остальной backend 88,73%, оба gate пройдены. Worker assembly исключён из знаменателя явно; реальный код collector дополнительно связан с integration tests и проверен MeterListener. Frontend: 86/86 при двух workers, lint/typecheck/build успешны, bundle 287,2 KB gzip при бюджете 300 KB. Полная браузерная матрица — 61/61 без retry, включая Chromium/Firefox/WebKit, light/dark, mobile и новый lifecycle кейса.

Итоговые команды, результаты и очищенные логи фиксируются в [checks.txt](DEV-17/checks.txt), [backend.txt](DEV-17/backend.txt), [e2e.txt](DEV-17/e2e.txt). Проверки выполняются из корня, frontend — из `web/`; dotnet использует SDK из `~/.dotnet`. Для Docker/браузера требуется выход из файловой песочницы, все базы локальные и временные.

В ходе проверки исправлены: несовпадение legacy assertions после удаления raw messages, число privacy retention categories, некорректный ожидаемый идентификатор адаптера, горизонтальное переполнение шапки, keyboard scrolling и ожидание завершения анимации тёмной темы. Дополнительный review нашёл premature recovery, незавершаемый inactive triage, утечку connection polling, повтор подтверждения после быстрого сбоя, частичный replay, отмену pause и скрытые результаты в диалоге — добавлены исправления и регрессии. Один default-parallel Vitest прогон дал transient timeout существующего privacy dialog; изолированный тест прошёл, полный ограниченный двумя workers прогон — зелёный. Сбой не назван успешным retry и отражён в протоколе.

## Данные и обратимость

Миграция `20261004201458_OperationalMonitoring` expand-only: две новые таблицы и индексы, исходные SyncRuns не меняются. На копии прежней схемы из пяти synthetic rows (полный успех, failed, skipped, partial, connection-test) переносится ровно одна правильная отметка; исходных строк остаётся пять. Прерывание после создания таблиц/backfill имитируется DDL trigger на CREATE_INDEX: вся миграция откатывается, SyncSuccesses отсутствует; после снятия искусственного отказа migrate успешно возобновляется. Повтор migrate — без дубликатов. Пустая база создаётся полным integration fixture и e2e. Runtime SQL-тесты работают с `crm_worker`, миграции выполняются отдельно с административными правами fixture. EF model проверяется на отсутствие pending changes.

Числа денежных операций миграция не меняет: reconciliation сумм неприменима, проверяется сохранение исходных rows и выбор timestamp. Масштаб/планы/длительность backfill на целевом объёме не измерялись — DEV-16. Откат проверен скриптом rollback-compat: предыдущая версия `9745703` прошла 7/7 критических browser сценариев на новой схеме ([протокол](DEV-17/rollback.txt)), без Down; прежняя версия не обновляет новые отметки свежести. Никаких внешних необратимых эффектов этой миграции нет.

Notes содержат минимальный PII; approved retention `integration.exception-triage` применим только к старым Resolved. Без подтверждения политики EXT-07 удаления нет. Saved views содержат только выбор фильтров и ограничены числом/длиной.

## Остаточные условия

EXT-01 остаётся blocked: PO/operations/Finance должны подтвердить владельцев и получателей, SLA реакции/эскалации, публикацию runbook и проверить Fired → отсутствие дублей → Resolved в разрешённой test-среде. Весь EXT-01 также включает решения DEC-01/02/08; DEV-17 не закрывает их. Конфигурация должна сохраняться в `infra/env/<env>.bicepparam`, иначе следующий штатный release вернёт значения по умолчанию. Реальные устройства Safari/iOS, масштаб и промышленная эксплуатация не доказаны локальной матрицей.

Итоговый статус **code_verified**. Локальные критерии pass, AC05 blocked (EXT-01); `accepted` не выставлен. Пакет, diff и manifest проверены. Собственные временные SQL-контейнеры, worktree и браузерная конфигурация удалены; пользовательские ресурсы сохранены.
