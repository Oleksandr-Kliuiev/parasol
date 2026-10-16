# Покрытие аудита и предлагаемого направления

Все находки аудита имеют задания; это карта объёма, а не отметка выполнения. Статусы находятся в backlog.json.

Колонка «Статус после DEV-22» рассчитана по acceptance.csv для всех критериев перечисленных задач (на 05.10.2026; DEV-23 не выполнялся). `pass (локально)` — критерий проверен локально; `blocked-by-EXT-xx` — критерий ждёт внешний gate, `passed` у gates нет. Это не отметка приёмки. Состав задач каждой находки — по полю `audit` в backlog.json; учитываются все критерии этих задач, а не только относящиеся к находке; evidence — файлы задач.

| Находка | Суть | Задания | Evidence | Статус после DEV-22 |
|---|---|---|---|---|
| A01 | Ручная правка суммы строки теряется / даёт дубль при повторном сборе | [DEV-00](tasks/DEV-00.md), [DEV-01](tasks/DEV-01.md) | [DEV-00](evidence/DEV-00.md), [DEV-01](evidence/DEV-01.md) | AC: pass 11, blocked 0, not_run 0; pass (локально) |
| A02 | Согласование: тот же согласующий, устаревшее согласование, порог после правки | [DEV-00](tasks/DEV-00.md), [DEV-02](tasks/DEV-02.md) | [DEV-00](evidence/DEV-00.md), [DEV-02](evidence/DEV-02.md) | AC: pass 11, blocked 0, not_run 0; pass (локально) |
| A03 | Экономический дубль начисления между прогонами | [DEV-00](tasks/DEV-00.md), [DEV-03](tasks/DEV-03.md) | [DEV-00](evidence/DEV-00.md), [DEV-03](evidence/DEV-03.md) | AC: pass 11, blocked 1, not_run 0; blocked-by-EXT-01 (DEV-03·AC07) |
| A04 | Права БД db_datawriter, изменяемый аудит | [DEV-04](tasks/DEV-04.md), [DEV-21](tasks/DEV-21.md) | [DEV-04](evidence/DEV-04.md), [DEV-21](evidence/DEV-21.md) | AC: pass 10, blocked 2, not_run 0; blocked-by-EXT-02/EXT-06 (DEV-21·AC03, DEV-21·AC04); gate не пройден (все связанные AC pass): EXT-07 |
| A05 | CI и Deploy независимы, выпуск без проверенного артефакта | [DEV-00](tasks/DEV-00.md), [DEV-05](tasks/DEV-05.md) | [DEV-00](evidence/DEV-00.md), [DEV-05](evidence/DEV-05.md) | AC: pass 10, blocked 1, not_run 0; blocked-by-EXT-11 (DEV-05·AC06) |
| A06 | Health всегда Healthy, readiness без БД | [DEV-06](tasks/DEV-06.md), [DEV-17](tasks/DEV-17.md) | [DEV-06](evidence/DEV-06.md), [DEV-17](evidence/DEV-17.md) | AC: pass 10, blocked 1, not_run 0; blocked-by-EXT-01 (DEV-17·AC05) |
| A07 | Outbox: событие застревает после 10 неудач | [DEV-07](tasks/DEV-07.md), [DEV-17](tasks/DEV-17.md) | [DEV-07](evidence/DEV-07.md), [DEV-17](evidence/DEV-17.md) | AC: pass 12, blocked 1, not_run 0; blocked-by-EXT-01 (DEV-17·AC05) |
| A08 | PDF предложения перерисовывается из текущих данных | [DEV-08](tasks/DEV-08.md) | [DEV-08](evidence/DEV-08.md) | AC: pass 6, blocked 0, not_run 0; pass (локально) |
| A09 | Record scope (свои КП, назначенные проекты) | [DEV-09](tasks/DEV-09.md), [DEV-21](tasks/DEV-21.md) | [DEV-09](evidence/DEV-09.md), [DEV-21](evidence/DEV-21.md) | AC: pass 9, blocked 3, not_run 0; blocked-by-EXT-01/EXT-02/EXT-06 (DEV-09·AC06, DEV-21·AC03, DEV-21·AC04); gate не пройден (все связанные AC pass): EXT-07 |
| A10 | Персональные данные: выгрузка, анонимизация, retention | [DEV-11](tasks/DEV-11.md), [DEV-21](tasks/DEV-21.md) | [DEV-11](evidence/DEV-11.md), [DEV-21](evidence/DEV-21.md) | AC: pass 11, blocked 2, not_run 0; blocked-by-EXT-02/EXT-06 (DEV-21·AC03, DEV-21·AC04); gate не пройден (все связанные AC pass): EXT-07 |
| A11 | Суммы задолженности считаются после Take | [DEV-12](tasks/DEV-12.md) | [DEV-12](evidence/DEV-12.md) | AC: pass 6, blocked 0, not_run 0; pass (локально) |
| A12 | Восстановление: web не в read-only, расхождения runbook | [DEV-13](tasks/DEV-13.md) | [DEV-13](evidence/DEV-13.md) | AC: pass 4, blocked 2, not_run 0; blocked-by-EXT-04 (DEV-13·AC05, DEV-13·AC06) |
| A13 | BI: нет поддерживаемого обновления Power BI Service | [DEV-14](tasks/DEV-14.md) | [DEV-14](evidence/DEV-14.md) | AC: pass 5, blocked 1, not_run 0; blocked-by-EXT-08 (DEV-14·AC05) |
| A14 | E2E гонка за свободный месяц | [DEV-00](tasks/DEV-00.md), [DEV-15](tasks/DEV-15.md) | [DEV-00](evidence/DEV-00.md), [DEV-15](evidence/DEV-15.md) | AC: pass 11, blocked 0, not_run 0; pass (локально) |
| A15 | Роли в сессии не пересоздаются при обновлении | [DEV-10](tasks/DEV-10.md), [DEV-21](tasks/DEV-21.md) | [DEV-10](evidence/DEV-10.md), [DEV-21](evidence/DEV-21.md) | AC: pass 10, blocked 2, not_run 0; blocked-by-EXT-02/EXT-06 (DEV-21·AC03, DEV-21·AC04); gate не пройден (все связанные AC pass): EXT-07 |
| A16 | Повторные запросы в цикле, списки с фиксированным Take | [DEV-12](tasks/DEV-12.md), [DEV-16](tasks/DEV-16.md) | [DEV-12](evidence/DEV-12.md), [DEV-16](evidence/DEV-16.md) | AC: pass 8, blocked 4, not_run 0; blocked-by-EXT-05 (DEV-16·AC01, DEV-16·AC02, DEV-16·AC03, DEV-16·AC06) |

Сверка: набор задач каждой находки в таблице совпадает с полем `audit` в backlog.json (скрипт проверки при подготовке: расхождений нет).

## Дополнительные направления

| Направление | Задания | Evidence | Статус после DEV-22 |
|---|---|---|---|
| Финансовый реестр и контролируемые исправления | DEV-01, DEV-02, DEV-03, DEV-19 | [DEV-01](evidence/DEV-01.md), [DEV-02](evidence/DEV-02.md), [DEV-03](evidence/DEV-03.md), [DEV-19](evidence/DEV-19.md) | AC: pass 23, blocked 2, not_run 0; blocked-by-EXT-01/EXT-03 (DEV-03·AC07, DEV-19·AC06); gate не пройден (все связанные AC pass): EXT-02;  |
| Запуск, происхождение артефактов, SBOM | DEV-00, DEV-05, DEV-23 | [DEV-00](evidence/DEV-00.md), [DEV-05](evidence/DEV-05.md) | AC: pass 10, blocked 1, not_run 0; blocked-by-EXT-11 (DEV-05·AC06); DEV-23: not_run (6 AC) |
| Права и персональные данные | DEV-04, DEV-09, DEV-10, DEV-11, DEV-21 | [DEV-04](evidence/DEV-04.md), [DEV-09](evidence/DEV-09.md), [DEV-10](evidence/DEV-10.md), [DEV-11](evidence/DEV-11.md), [DEV-21](evidence/DEV-21.md) | AC: pass 28, blocked 3, not_run 0; blocked-by-EXT-01/EXT-02/EXT-06 (DEV-09·AC06, DEV-21·AC03, DEV-21·AC04); gate не пройден (все связанные AC pass): EXT-07;  |
| Свежесть данных и операционные исключения | DEV-06, DEV-07, DEV-17, DEV-19 | [DEV-06](evidence/DEV-06.md), [DEV-07](evidence/DEV-07.md), [DEV-17](evidence/DEV-17.md), [DEV-19](evidence/DEV-19.md) | AC: pass 22, blocked 2, not_run 0; blocked-by-EXT-01/EXT-03 (DEV-17·AC05, DEV-19·AC06); gate не пройден (все связанные AC pass): EXT-02;  |
| Документы и исторические показатели | DEV-08, DEV-14 | [DEV-08](evidence/DEV-08.md), [DEV-14](evidence/DEV-14.md) | AC: pass 11, blocked 1, not_run 0; blocked-by-EXT-08 (DEV-14·AC05);  |
| Ежедневный UX и WCAG 2.2 | DEV-12, DEV-18, DEV-22 | [DEV-12](evidence/DEV-12.md), [DEV-18](evidence/DEV-18.md), [DEV-22](evidence/DEV-22.md) | AC: pass 12, blocked 6, not_run 0; blocked-by-EXT-09/EXT-10 (DEV-18·AC01, DEV-22·AC01, DEV-22·AC02, DEV-22·AC03, DEV-22·AC04, DEV-22·AC05);  |
| Тесты, границы модулей и целевой масштаб | DEV-15, DEV-16 | [DEV-15](evidence/DEV-15.md), [DEV-16](evidence/DEV-16.md) | AC: pass 8, blocked 4, not_run 0; blocked-by-EXT-05 (DEV-16·AC01, DEV-16·AC02, DEV-16·AC03, DEV-16·AC06);  |
| Реальные поставщики и безопасная миграция | DEV-19, DEV-20 | [DEV-19](evidence/DEV-19.md), [DEV-20](evidence/DEV-20.md) | AC: pass 10, blocked 2, not_run 0; blocked-by-EXT-03/EXT-09 (DEV-19·AC06, DEV-20·AC06); gate не пройден (все связанные AC pass): EXT-01, EXT-02;  |
| Независимая безопасность, восстановление, месячный пилот | DEV-13, DEV-21, DEV-22 | [DEV-13](evidence/DEV-13.md), [DEV-21](evidence/DEV-21.md), [DEV-22](evidence/DEV-22.md) | AC: pass 9, blocked 9, not_run 0; blocked-by-EXT-02/EXT-04/EXT-06/EXT-09/EXT-10 (DEV-13·AC05, DEV-13·AC06, DEV-21·AC03, DEV-21·AC04, DEV-22·AC01, DEV-22·AC02, DEV-22·AC03, DEV-22·AC04, DEV-22·AC05); gate не пройден (все связанные AC pass): EXT-07;  |
| Эксплуатационная приёмка и поддержка | DEV-23 | нет (DEV-23 не выполнялся) | DEV-23: not_run (6 AC) |

## Направления, названные в DEV-23, и где они учтены

| Направление | Задания | Ключевые AC, ждущие внешнего gate |
|---|---|---|
| UX / доступность | DEV-12, DEV-18, DEV-22 | DEV-18-AC01 (EXT-10), DEV-22-AC01 (EXT-10) |
| Безопасность | DEV-04, DEV-09, DEV-10, DEV-21 | DEV-21-AC03 (EXT-06), DEV-21-AC04 (EXT-02), DEV-09-AC06 (EXT-01) |
| Миграция | DEV-20, DEV-22 | DEV-20-AC06 (EXT-09), DEV-22-AC02…AC05 (EXT-09) |
| UAT | DEV-18, DEV-22 | DEV-18-AC01, DEV-22-AC01 (EXT-10) |
| Мониторинг | DEV-06, DEV-17 | DEV-17-AC05 (EXT-01) |
| Масштаб | DEV-12, DEV-16 | DEV-16-AC01/02/03/06 (EXT-05) |
| Интеграции | DEV-19, DEV-07 | DEV-19-AC06 (EXT-03) |

Новые юрлица/валюты, Azure consumption, электронная подпись, shared mailboxes, клиентский портал и AI находятся в DECISIONS.md как требующие подтверждения расширения. Они не потеряны, но не выданы за уже согласованный обязательный объём.
