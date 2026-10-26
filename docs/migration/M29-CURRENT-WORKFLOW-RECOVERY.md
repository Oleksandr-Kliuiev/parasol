# M29 — восстановление текущей рабочей цепочки

Первое учение M07 предшествовало SourceTaskLinks (M12), связанным Task/ticket/time
и постоянным квитанциям создания времени (M22). Сборка и composition M28 проверяли
живую работу, но не восстановление этих данных из native backup. M29 закрывает
этот локальный пробел; запуск Hostinger и рабочие провайдеры остаются отдельными воротами.

## Что изменилось

`deploy/hostinger/tools/rehearsal_workload.py` добавляет owner-seeded синтетический
набор в существующее учение `rehearse.py`: сотрудник, клиент, Atera customer link,
сохранённый тикет с owner provenance, назначенная Task с постоянным SourceTaskLink,
ручные 0,25 часа с SourceActivityId/TicketId и постоянная TimeEntryCreateReceipt.
В Atlas сохраняются workspace/client/connection, исходное событие и OPEN-наблюдение.

Seeder допускает только rehearsal, loopback, изолированные сети и read-only режим;
бизнес-таблицы SQL и каталог workspace Atlas должны быть пустыми. Он не меняет
production restore и не требует новых таблиц при восстановлении старых backups.
Все значения синтетические; живой вход Entra и API-повтор после восстановления
не проверяются этим fixture. Их локальная семантика проверяется отдельно composition.

До backup проверяются отношения Task → ticket → Time → receipt, привязка сотрудника,
hash исходного запроса, ключи/FK и фактические SELECT/UPDATE/DELETE permissions обоих
runtime SQL login. SHA-256 охватывает все поля 8 SQL и 5 PostgreSQL строк, включая
rowversion и null. SQL хеширует JSON внутри сервера, чтобы SQLCMD не усекал длинную строку.

После backup изменяются Subject/rowversion задачи, Hours/rowversion времени и lifecycle
наблюдения OPEN → ACKNOWLEDGED. Учение требует изменения именно этих трёх fingerprints,
затем останавливает исходный стек. Восстановленная копия должна вернуть исходные поля,
версии, OPEN-состояние, relations, ключи и запрет UPDATE/DELETE квитанций для web/worker.
Существующие проверки native SQL/PG, документа, keyring, edge и повреждённого restic pack
сохраняются полностью.

## Локальная проверка, 17 октября 2026

- Собраны четыре текущих Linux image: CRM Web, CRM Worker, Atlas и Atlas migrator.
  До/после сборки и учения совпали 2703 принятых application/build inputs;
  изменённые rehearsal/fixture отдельно зафиксированы для текущего прогона.
- Operations: 21/21, без пропусков. Новые отрицательные проверки отвергают
  неподходящий стек, неполные fingerprints, пропавшую квитанцию, изменённую версию,
  неэффективную mutation и утрату runtime permissions. Unit не заменяет native SQL/PG.
- Финальный обычный CLI-прогон `native-04` прошёл полностью без автоматических retry:
  SQL COPY_ONLY/CHECKSUM/VERIFYONLY/CHECKDB, PG dump/restore, restic restore --verify,
  точные 13 строк, документ/keyring и повреждение pack. Backup — 16,51 с,
  restore — 25,19 с на маленьком синтетическом наборе. Это не Hostinger RTO.
- Независимое чтение фактических Docker containers/networks во время восстановления
  подтвердило отсутствие опубликованных портов, только внутренние сети, остановленный
  source, отсутствие worker/Caddy у target, точные текущие app images, read-only
  Production CRM с сохранённым Entra auth. Ни Development auth, ни promotion не включались.

Первые три попытки сохранены в приватной диагностике: две локализовали T-SQL 156
из-за неэкранированного имени схемы `identity`; третья дошла до backup, но обнаружила
T-SQL 1934 из-за отсутствующего QUOTED_IDENTIFIER ON у последующих UPDATE fixture.
Исправлены команды учения, без ослабления SQL-схемы, ролей или проверок. Финальный
прогон использовал стандартный CLI без диагностического monkey patch.

[Компактное свидетельство](../testing/evidence/recovery-M29-2026-10-17.json) отделяет
новые результаты от ранее принятых областей. Код CRM/Atlas и Dockerfiles не менялись;
прежние строгие Atlas 711/789/90 и CRM/composition gates не выдаются за новые прогоны.
Старое свидетельство M07 сохранено. CI уже обнаруживает все operations tests и запускает
этот же rehearsal; удалённый workflow не публиковался и не запускался.

## Границы

Это проверка хранения синтетических данных через owner, без новых production dependencies.
Она не доказывает совместимость рабочих Atera/Huntress/M365/PowerOffice accounts,
Entra consent, offsite SFTP, ACME, длительность простоя реальной базы или восстановление
старой финансовой истории. Для оценки удобства и экономии времени по-прежнему нужен
пробный проход сотрудников по LOCAL-DEMO.md и их отзыв. Общая цель продукта не завершена.
