# DEV-23 — сводка допуска к выпуску (gate summary)

Состояние на 05.10.2026. Источники: [backlog.json](../../backlog.json), [acceptance.csv](../../acceptance.csv), [external-gates.json](../../external-gates.json), [PROGRESS.md](../../PROGRESS.md), evidence соответствующих задач. Числа в разделах (а)–(d) посчитаны скриптом (текст скрипта — внизу) и могут быть воспроизведены; ничего здесь не является решением о запуске, подписью или принятием. Локальный/mock-результат не заменяет внешнее свидетельство.

Итого по acceptance.csv: **145** критериев — pass **120**, blocked **25**, not_run **0** (из них у самой DEV-23: pass 2, blocked 4; у DEV-00…22: pass 118, blocked 21). Задач в backlog: 24; статусы: code_verified=24 (DEV-23 включена после этого досье), accepted=0. Внешних gates: 11; статусы: blocked=7, not_run=4; passed — 0.

## (а) Задачи DEV-00…DEV-22

Колонки AC: pass / blocked / not_run. «pass» означает локальную проверку критерия, а не внешнюю приёмку. Статус задачи — из backlog.json (`code_verified` = код проверен локально, не `accepted`).

| Задача | Приоритет | Статус (backlog) | AC pass / blocked / not_run | Внешние gates (backlog) | Evidence |
|---|---|---|---|---|---|
| [DEV-00](../../tasks/DEV-00.md) Зафиксировать исходное состояние и регрессии | P1 | code_verified | 5 / 0 / 0 (из 5) | нет | [DEV-00.md](../DEV-00.md) |
| [DEV-01](../../tasks/DEV-01.md) Идентичность начисления и сохранение ручных корректировок | P1 | code_verified | 6 / 0 / 0 (из 6) | нет | [DEV-01.md](../DEV-01.md) |
| [DEV-02](../../tasks/DEV-02.md) Согласования конкретной версии расчёта | P1 | code_verified | 6 / 0 / 0 (из 6) | нет | [DEV-02.md](../DEV-02.md) |
| [DEV-03](../../tasks/DEV-03.md) Реестр начислений и корректирующие прогоны | P1 | code_verified | 6 / 1 / 0 (из 7) | EXT-01 | [DEV-03.md](../DEV-03.md) |
| [DEV-04](../../tasks/DEV-04.md) Неизменяемость аудита и минимальные права приложения | P1 | code_verified | 6 / 0 / 0 (из 6) | EXT-07 | [DEV-04.md](../DEV-04.md) |
| [DEV-05](../../tasks/DEV-05.md) Проверенный артефакт и управляемый выпуск | P1 | code_verified | 5 / 1 / 0 (из 6) | EXT-11 | [DEV-05.md](../DEV-05.md) |
| [DEV-06](../../tasks/DEV-06.md) Готовность сервиса и контроль работоспособности worker | P1 | code_verified | 5 / 0 / 0 (из 5) | нет | [DEV-06.md](../DEV-06.md) |
| [DEV-07](../../tasks/DEV-07.md) Доставка событий и безопасный повтор | P1 | code_verified | 7 / 0 / 0 (из 7) | нет | [DEV-07.md](../DEV-07.md) |
| [DEV-08](../../tasks/DEV-08.md) Фиксация отправленных коммерческих предложений | P1 | code_verified | 6 / 0 / 0 (из 6) | нет | [DEV-08.md](../DEV-08.md) |
| [DEV-09](../../tasks/DEV-09.md) Авторизация на уровне записи | P1 | code_verified | 5 / 1 / 0 (из 6) | EXT-01 | [DEV-09.md](../DEV-09.md) |
| [DEV-10](../../tasks/DEV-10.md) Отзыв привилегий и жизненный цикл сессии | P1 | code_verified | 6 / 0 / 0 (из 6) | EXT-02 | [DEV-10.md](../DEV-10.md) |
| [DEV-11](../../tasks/DEV-11.md) Персональные данные и сроки хранения | P1 | code_verified | 7 / 0 / 0 (из 7) | EXT-07 | [DEV-11.md](../DEV-11.md) |
| [DEV-12](../../tasks/DEV-12.md) Полные списки и корректные финансовые итоги | P2 | code_verified | 6 / 0 / 0 (из 6) | нет | [DEV-12.md](../DEV-12.md) |
| [DEV-13](../../tasks/DEV-13.md) Режим обслуживания и восстановление | P1 | code_verified | 4 / 2 / 0 (из 6) | EXT-04 | [DEV-13.md](../DEV-13.md) |
| [DEV-14](../../tasks/DEV-14.md) Рабочая BI-интеграция и определения показателей | P2 | code_verified | 5 / 1 / 0 (из 6) | EXT-08 | [DEV-14.md](../DEV-14.md) |
| [DEV-15](../../tasks/DEV-15.md) Надёжные тесты и полное покрытие архитектурных правил | P1 | code_verified | 6 / 0 / 0 (из 6) | нет | [DEV-15.md](../DEV-15.md) |
| [DEV-16](../../tasks/DEV-16.md) Производительность на целевом объёме | P2 | code_verified | 2 / 4 / 0 (из 6) | EXT-05 | [DEV-16.md](../DEV-16.md) |
| [DEV-17](../../tasks/DEV-17.md) Мониторинг и рабочее место разбора исключений | P1 | code_verified | 5 / 1 / 0 (из 6) | EXT-01 | [DEV-17.md](../DEV-17.md) |
| [DEV-18](../../tasks/DEV-18.md) Ежедневные сценарии и доступность интерфейса | P2 | code_verified | 5 / 1 / 0 (из 6) | EXT-10 | [DEV-18.md](../DEV-18.md) |
| [DEV-19](../../tasks/DEV-19.md) Реальные интеграции и сверка внешних эффектов | P1 | code_verified | 5 / 1 / 0 (из 6) | EXT-02, EXT-03 | [DEV-19.md](../DEV-19.md) |
| [DEV-20](../../tasks/DEV-20.md) Пробная миграция и качество клиентских данных | P1 | code_verified | 5 / 1 / 0 (из 6) | EXT-01, EXT-09 | [DEV-20.md](../DEV-20.md) |
| [DEV-21](../../tasks/DEV-21.md) Проверка безопасности по ASVS и устранение замечаний | P1 | code_verified | 4 / 2 / 0 (из 6) | EXT-02, EXT-06, EXT-07 | [DEV-21.md](../DEV-21.md) |
| [DEV-22](../../tasks/DEV-22.md) Приёмка по ролям и параллельный месячный биллинг | P1 | code_verified | 1 / 5 / 0 (из 6) | EXT-09, EXT-10 | [DEV-22.md](../DEV-22.md) |
| **Итого DEV-00…22** | | | **118 / 21 / 0** | | |

DEV-23 (эта задача): статус `code_verified`, AC pass / blocked / not_run = 2 / 4 / 0 — см. [DEV-23.md](../DEV-23.md): AC01 и AC06 выполнены, AC02–AC05 заблокированы отсутствием внешних свидетельств, решений и владельцев.

## (б) Внешние gates EXT-01…EXT-11

### EXT-01 — Бизнес-правила, данные и владельцы исключений

- Требуемые роли владельца: PO / Finance / Sales / ServiceLead / operations; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **blocked**.
- Blocker (из external-gates.json): Не подтверждены бизнес-решения DEC-01/02/08 и владельцы/получатели исключений DEC-09. Для DEV-17 нужны разрешённая test-среда, утверждённая постоянная конфигурация operations/finance и протокол Fired, отсутствие дублей, Resolved с реальными адресатами по runbook 15. Локальные тесты и компиляция Bicep не закрывают EXT-01.
- Задачи, ожидающие gate (external-gates.json): DEV-03, DEV-09, DEV-17, DEV-20, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-03-AC07, DEV-09-AC06, DEV-17-AC05.
- Ссылки на evidence из gate: evidence/DEV-03.md, evidence/DEV-09.md, evidence/DEV-17.md, ../runbooks/15-monitoring.md.
- Следующее действие владельца: Назначить владельцев (PO, Finance, Sales, ServiceLead, operations) и подтвердить DEC-01/02/08/09 (DECISIONS.md); принять Finance-отчёт неоднозначных legacy-начислений (evidence/DEV-03/migration-upgrade.txt); в разрешённой test-среде утвердить постоянную конфигурацию operations/finance и провести протокол Fired / без дублей / Resolved с реальными адресатами по runbook 15. Опора: [runbook 15](../../../runbooks/15-monitoring.md).

### EXT-02 — Реальный Entra tenant и отзыв прав

- Требуемые роли владельца: Tenant owner / security; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **blocked**.
- Blocker (из external-gates.json): Владелец tenant/security не назначен. Не проверены в реальном tenant: single tenant, Assignment required, Conditional Access/MFA и PIM, права Graph (least privilege), optional claim auth_time (register-app.sh нужно выполнить до выкладки DEV-21, иначе привилегированные действия остаются закрытыми), redirect URI, front-channel logout, срок отзыва прав (runbook 12 §5).
- Задачи, ожидающие gate (external-gates.json): DEV-10, DEV-19, DEV-21, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-21-AC04.
- Ссылки на evidence из gate: evidence/DEV-21.md, evidence/DEV-21/asvs-5.0.0-l2-matrix.csv.
- Следующее действие владельца: Назначить владельца tenant/security; в реальном tenant проверить single tenant, Assignment required, Conditional Access/MFA/PIM, least privilege Graph, optional claim auth_time (выполнить register-app.sh до выкладки DEV-21), redirect URI, front-channel logout и измерить срок отзыва прав по runbook 12 §5. Опора: [runbook 12](../../../runbooks/12-roles-and-sessions.md).

### EXT-03 — Контракты реальных поставщиков и сверка эффектов

- Требуемые роли владельца: Integration owner / Finance; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **blocked**.
- Blocker (из external-gates.json): Integration owner и Finance не назначены; нет разрешённых sandbox-аккаунтов PowerOffice Go, Atera и Partner Center и ключей. Нужно: сверка с актуальной документацией (с датами), сценарии чтения, инкрементальной синхронизации, права на поля, 429/таймауты, неопределённый исход отправки и поиск дубля, различение заказа/счёта/оплаты/кредита/списания, очищенные доказательства по contract-matrix.md. Локальные WireMock-тесты и синтетические фикстуры этого не заменяют.
- Задачи, ожидающие gate (external-gates.json): DEV-19, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-19-AC06.
- Ссылки на evidence из gate: evidence/DEV-19.md, evidence/DEV-19/contract-matrix.md.
- Следующее действие владельца: Назначить Integration owner и Finance; получить разрешённые sandbox-аккаунты и ключи PowerOffice Go, Atera, Partner Center; пройти сценарии по contract-matrix.md (чтение, инкремент, права на поля, 429/таймауты, неопределённый исход отправки и поиск дубля, различение заказа/счёта/оплаты/кредита/списания) и приложить очищенные доказательства. Опора: [runbook 02](../../../runbooks/02-integrations.md), [contract-matrix](../DEV-19/contract-matrix.md).

### EXT-04 — Учение восстановления и RPO/RTO

- Требуемые роли владельца: Operations; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **not_run**.
- Blocker (из external-gates.json): текст не заполнен (поле пусто); статус not_run
- Задачи, ожидающие gate (external-gates.json): DEV-13, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-13-AC05, DEV-13-AC06.
- Ссылки на evidence из gate: нет.
- Следующее действие владельца: Назначить владельца Operations; провести облачное учение восстановления в выделенной разрешённой среде (PITR, rename, перезапуск ревизии, migration job) с метками времени RPO/RTO по DEC-04 и сверкой внешних эффектов; исправить найденные дефекты runbook. В external-gates.json blocker пуст. Опора: [runbook 03](../../../runbooks/03-database-restore.md).

### EXT-05 — Целевой масштаб и нагрузка

- Требуемые роли владельца: QA / operations / PO; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **blocked**.
- Blocker (из external-gates.json): QA / operations / PO должны назначить владельца и согласовать DEC-07: инфраструктуру, смесь действий, длительность/пики, 50 различных identities и квоты реальных провайдеров. Локальные synthetic smoke/full и simulated export не заменяют внешний протокол.
- Задачи, ожидающие gate (external-gates.json): DEV-16, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-16-AC01, DEV-16-AC02, DEV-16-AC03, DEV-16-AC06.
- Ссылки на evidence из gate: evidence/DEV-16.md.
- Следующее действие владельца: Назначить владельца (QA / operations / PO), согласовать DEC-07 (инфраструктура, смесь действий, пики, 50 различных identities, квоты провайдеров) и провести полный прогон в согласованной среде с внешним протоколом (k6 + браузерный LCP). Опора: evidence/DEV-16.md, `tools/load-test/`.

### EXT-06 — Независимая проверка безопасности

- Требуемые роли владельца: Security reviewer / PO; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **blocked**.
- Blocker (из external-gates.json): Не назначен независимый проверяющий (security reviewer / PO), не выбрана и не подготовлена тестовая среда с реальными ролями. Самооценка по ASVS 5.0.0 и пакет по runbook 17 готовы, но независимое заключение и повторная проверка (retest) не проведены.
- Задачи, ожидающие gate (external-gates.json): DEV-21, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-21-AC03.
- Ссылки на evidence из gate: evidence/DEV-21.md, evidence/DEV-21/matrix-summary.md, ../runbooks/17-vulnerability-intake.md.
- Следующее действие владельца: Назначить независимого проверяющего (security reviewer / PO), подготовить тестовую среду с реальными ролями; провести проверку и retest по пакету runbook 17; зафиксировать отсутствие открытых Critical/High. Опора: [runbook 17](../../../runbooks/17-vulnerability-intake.md), [matrix-summary](../DEV-21/matrix-summary.md).

### EXT-07 — Персональные данные, retention и legal holds

- Требуемые роли владельца: Data owner / Finance; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **not_run**.
- Blocker (из external-gates.json): текст не заполнен (поле пусто); статус not_run
- Задачи, ожидающие gate (external-gates.json): DEV-04, DEV-11, DEV-21, DEV-23.
- Критерии со статусом blocked по этому gate: нет (критерии задач этого gate имеют статус pass локально; сам gate не пройден).
- Ссылки на evidence из gate: evidence/DEV-21/deferred-and-accepted.md.
- Следующее действие владельца: Назначить Data owner / Finance; принять сроки retention, legal holds, порядок запросов субъекта, ограничения аудита, роль регламентного удаления и обработку копий (DEC-03; см. evidence/DEV-21/deferred-and-accepted.md). В external-gates.json blocker пуст. Опора: [runbook 13](../../../runbooks/13-personal-data.md).

### EXT-08 — Обновление Power BI Service

- Требуемые роли владельца: BI owner; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **not_run**.
- Blocker (из external-gates.json): текст не заполнен (поле пусто); статус not_run
- Задачи, ожидающие gate (external-gates.json): DEV-14, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-14-AC05.
- Ссылки на evidence из gate: нет.
- Следующее действие владельца: Назначить BI owner; в реальном tenant с клиентским приложением и Power BI Service выполнить плановое обновление без browser-cookie, в том числе после истечения токена и ротации credentials (runbook 14 §5). В external-gates.json blocker пуст. Опора: [runbook 14](../../../runbooks/14-power-bi-refresh.md).

### EXT-09 — Репетиция миграции и сверка

- Требуемые роли владельца: Data owners / Finance; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **blocked**.
- Blocker (из external-gates.json): Finance и Product Owner не подтвердили пробную миграцию: нужны реальный образец источника (A-08), решение о глубине миграции (финансовая история, PDF), тестовая копия, прогон по runbook 16 (dry-run, real, повтор, сверка сумм по клиентам/периодам/валютам) и подписанный протокол. Локальный импорт на синтетических данных этого не заменяет. Для DEV-22 нужен полный пилотный месяц (runbook 18) с независимым расчётом, пояснениями расхождений и подписью Finance; инструменты (трасса, сравнение, подпись, готовность, KPI) готовы, реального прогона нет.
- Задачи, ожидающие gate (external-gates.json): DEV-20, DEV-22, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-20-AC06, DEV-22-AC02, DEV-22-AC03, DEV-22-AC04, DEV-22-AC05.
- Ссылки на evidence из gate: ../runbooks/16-migration.md, ../runbooks/18-pilot-billing.md, evidence/DEV-20.md, evidence/DEV-22.md.
- Следующее действие владельца: Finance и PO: предоставить реальный образец источника (A-08), решить глубину миграции, подготовить тестовую копию; прогнать runbook 16 (dry-run, real, повтор, сверка по клиентам/периодам/валютам) и подписать протокол; провести полный пилотный месяц по runbook 18 с независимым расчётом, объяснением расхождений и подписью Finance. Опора: [runbook 16](../../../runbooks/16-migration.md), [runbook 18](../../../runbooks/18-pilot-billing.md).

### EXT-10 — UAT и полный месячный параллельный биллинг

- Требуемые роли владельца: PO / users / Finance; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **blocked**.
- Blocker (из external-gates.json): PO / пользователи / Finance должны назначить владельца и провести UAT по ролям (Sales, Technician, ServiceLead, Finance) без подсказок разработчика, ручную проверку со скринридером и реальными Safari/iOS/Android. Локальные Playwright-сценарии и автоматические проверки WCAG 2.2 не заменяют UAT. Месячный параллельный биллинг (DEV-22/23) здесь отдельно. Для DEV-22 готовы сценарии, бланки протоколов и план обучения (evidence/DEV-22/); заполненных протоколов, замера времени обучения и подписей нет.
- Задачи, ожидающие gate (external-gates.json): DEV-18, DEV-22, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-18-AC01, DEV-22-AC01.
- Ссылки на evidence из gate: evidence/DEV-18.md, evidence/DEV-22.md, evidence/DEV-22/README.md.
- Следующее действие владельца: PO назначает владельца; провести UAT по ролям (Sales, Technician, ServiceLead, Finance) без подсказок разработчика по бланкам evidence/DEV-22/, ручную проверку скринридером и на реальных Safari/iOS/Android, замерить время обучения; полный месячный параллельный биллинг — вместе с EXT-09. Опора: [evidence/DEV-22/README](../DEV-22/README.md), [runbook 18](../../../runbooks/18-pilot-billing.md).

### EXT-11 — Проверенная конфигурация выпуска и поддержка

- Требуемые роли владельца: Repository owner / operations / PO; назначенный owner в external-gates.json: не назначен (поле пусто); verified_at: пусто.
- Статус: **not_run**.
- Blocker (из external-gates.json): текст не заполнен (поле пусто); статус not_run
- Задачи, ожидающие gate (external-gates.json): DEV-05, DEV-23.
- Критерии со статусом blocked по этому gate: DEV-05-AC06.
- Ссылки на evidence из gate: нет.
- Следующее действие владельца: Repository owner / operations / PO: собрать фактические настройки (branch protection, reviewers окружения prod, права Actions, OIDC, роли identities) через `tools/release/release-settings.sh` и исполнить release.yml / promote.yml на main с проверенным digest; назначить владельцев поддержки и выпускного решения; принять конкретный release manifest. В external-gates.json blocker пуст. Опора: [runbook 01](../../../runbooks/01-first-deployment.md) §2, §6, §9.

## (c) P1 / обязательные gates не замаскированы под выполненные (DEV-23-AC01, локальная проверка)

| Проверка | Результат (скрипт) |
|---|---|
| P1-задач в backlog | 20: DEV-00, DEV-01, DEV-02, DEV-03, DEV-04, DEV-05, DEV-06, DEV-07, DEV-08, DEV-09, DEV-10, DEV-11, DEV-13, DEV-15, DEV-17, DEV-19, DEV-20, DEV-21, DEV-22, DEV-23 |
| Статусы P1-задач | code_verified=20 (DEV-23 после подготовки досье), accepted=0 |
| P1-задач со статусом accepted | 0 |
| Всех задач со статусом accepted | 0 |
| Задач DEV-00…22 со статусом code_verified | 23 из 23; DEV-23 — тоже code_verified (досье подготовлено, допуск не дан) |
| Внешних gates со статусом passed | 0 из 11 |
| Gates с назначенным owner | 0 из 11 |
| Gates со статусом blocked / not_run | 7 / 4 |
| Критериев acceptance.csv blocked / not_run (не pass) | 21 / 6 |
| `python3 validate-package.py --release` | должен завершаться ошибкой, пока не все задачи accepted и не все gates passed (проверка ниже в отчёте) |

Вывод по данным: ни одна P1-задача и ни один обязательный gate не отмечены accepted/passed. Это констатация состояния файлов, не оценка готовности.

P1-задачи с внешними зависимостями (все остаются `code_verified`): DEV-03 → EXT-01; DEV-04 → EXT-07; DEV-05 → EXT-11; DEV-09 → EXT-01; DEV-10 → EXT-02; DEV-11 → EXT-07; DEV-13 → EXT-04; DEV-17 → EXT-01; DEV-19 → EXT-02, EXT-03; DEV-20 → EXT-01, EXT-09; DEV-21 → EXT-02, EXT-06, EXT-07; DEV-22 → EXT-09, EXT-10; DEV-23 → EXT-01, EXT-02, EXT-03, EXT-04, EXT-05, EXT-06, EXT-07, EXT-08, EXT-09, EXT-10, EXT-11.

## (d) Blocked критерии по gates

Всего blocked: 21.

### EXT-01 (3)

- **DEV-03-AC07** — Отчёт миграции показывает неоднозначные legacy charges и их суммы; принятие Finance отражено в EXT-01.
- **DEV-09-AC06** — Матрица и результат бизнес-подтверждения записаны в EXT-01 до rollout персональных данных.
- **DEV-17-AC05** — У alerts определены severity, suppression/recovery и адресат; без реального адресата внешняя часть не считается принятой.

### EXT-02 (1)

- **DEV-21-AC04** — Реальные CA/MFA и least privilege доказаны; снимок локальной конфигурации не заменяет их.

### EXT-03 (1)

- **DEV-19-AC06** — EXT-03 содержит выбранный test tenant/account, сценарии, timestamps и очищенные доказательства; неизвестные credentials не считаются настроенной интеграцией.

### EXT-04 (2)

- **DEV-13-AC05** — На учении приложены timestamps: RPO ≤ 1 ч, RTO ≤ 4 ч; если не выполнено, gate отмечен failed.
- **DEV-13-AC06** — Обнаруженные дефекты runbook исправлены по результату учения, а не только компиляции Bicep.

### EXT-05 (4)

- **DEV-16-AC01** — 50 concurrent пользователей: p95 чтения ≤500 мс, записи ≤1 с; поиск ≤1 с при целевых объёмах.
- **DEV-16-AC02** — Биллинг 500 клиентов собирается ≤5 минут; экспорт ≤30 минут либо отклонение подтверждено ограничением provider и отдельно согласовано.
- **DEV-16-AC03** — Первый полезный контент карточки ≤2 с, LCP ≤2.5 с в зафиксированном клиентском профиле; серверный k6 не выдаётся за browser LCP.
- **DEV-16-AC06** — Полный прогон в согласованной среде приложен к EXT-05; малый ноутбучный smoke не помечен как целевая нагрузка.

### EXT-06 (1)

- **DEV-21-AC03** — По независимой проверке нет известных незакрытых Critical/High в запускаемом контуре; retest приложен.

### EXT-08 (1)

- **DEV-14-AC05** — Power BI Service выполняет плановое обновление без browser-cookie, в том числе после истечения исходного токена; свидетельство EXT-08.

### EXT-09 (5)

- **DEV-20-AC06** — Finance и Product Owner подтвердили пробную миграцию в EXT-09.
- **DEV-22-AC02** — Полный месячный цикл завершён; одного успешного sandbox заказа недостаточно.
- **DEV-22-AC03** — 100% применимых оплачиваемых источников имеют объяснённый результат; необъяснённых расхождений сумм нет.
- **DEV-22-AC04** — Нет двойной отправки клиентам; пилотные references сопоставлены с реальными документами.
- **DEV-22-AC05** — Владелец каждого исключения и резервный ручной процесс определены; Finance подписал сверку.

### EXT-10 (2)

- **DEV-18-AC01** — Сотрудник каждой роли завершает основной сценарий без подсказки разработчика на UAT.
- **DEV-22-AC01** — У каждой роли есть заполненный протокол с исполнителем, датой, результатом и закрытыми блокирующими замечаниями.

### EXT-11 (1)

- **DEV-05-AC06** — EXT-11 содержит фактические настройки окружения и свидетельство исполнения, а не только наличие workflow.

Gates без blocked-критериев: EXT-07. Для них все связанные критерии задач имеют локальный pass, а gate остаётся не пройденным (EXT-07: задачи DEV-04, DEV-11, DEV-21 — критерии AC pass или относятся к другим gates; EXT-02 имеет blocked только DEV-21-AC04).

## Наблюдения о согласованности источников

Перечислены в итоговом отчёте исполнителя и ниже; evidence других задач не изменялись.

- PROGRESS.md, раздел DEV-17: «без commit/push», тогда как `git log` содержит коммит `3a1ec89` («DEV-17 and DEV-16»); раздел «Ветки и коммиты» PROGRESS.md перечисляет SHA только до DEV-14, а DEV-18…DEV-22 (`8005bd1`, `7f3b4ec`, `c16e86c`, `bd70452`, `b6da6a8`) в шапке не названы.
- external-gates.json: у EXT-04, EXT-07, EXT-08, EXT-11 поле blocker пусто при статусе not_run; EXT-04/08/11 без ссылок на evidence.
- Ни у одного gate не назначен owner; ни у одного нет verified_at.

## Скрипт расчёта

```python
import json, csv, collections
b = json.load(open("backlog.json")); rows = list(csv.DictReader(open("acceptance.csv")))
for t in b["tasks"]:
    c = collections.Counter(r["result"] for r in rows if r["task_id"] == t["id"])
    print(t["id"], t["priority"], t["status"], c["pass"], c["blocked"], c["not_run"])
```

Запуск из `docs/claude-opus/`. Привязка blocked-критерия к gate сделана по ссылке EXT-xx в колонке evidence acceptance.csv (первый указанный gate; DEV-22-AC03 дополнительно упоминает EXT-03 как внешнюю причину отсутствия НДС в заказе PowerOffice).
