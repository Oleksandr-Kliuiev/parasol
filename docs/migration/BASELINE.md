# Унаследованные сбои Atlas

На исходном Atlas main `992fdf7` при Node 24: **610 тестов, 595 passed, 14 failed, 1 skipped**
на macOS. На Linux платформенные skip могут отличаться. Импортированное дерево совпадает
с upstream побайтно; это не сбои из-за перемещения под `apps/atlas`.

Точный список имён, файлов и ожидаемых диагностик — `atlas-baseline.json`.

| Причина | Сбои |
| --- | --- |
| Архивный execution artifact уже не проходит проверку, `bindCorpus` выдаёт `CORPUS_IDENTITY_MISMATCH` | 7 execution test files, instrument run/units, grouped census — 10 |
| PTY-сценарий не доходит до следующего запроса после отказа проверки артефакта | 1 |
| Ожидания старых seal/source/build manifests не соответствуют текущему дереву | chained identity и RC5 guard — 2 |
| В тесте старый список операторских команд, без добавленного `onboard` | pilot admission — 1 |

Это связано с изменениями исходного проекта после зафиксированных проверочных ревизий.
См. также `apps/atlas/docs/deploy/DEPLOY.md`, раздел о влиянии на R-EVAL.
Исторические seals и manifests не изменены. Пины и отказы production guards сохранены.

## Механизм исключений удалён

После исправления Atlas корневые runner-ы больше не читают `atlas-baseline.json`.
Файл сохранён только как историческая запись состояния импорта. `test:atlas` и
`test:atlas:strict` выполняют одинаковую строгую проверку; skipped, todo, cancelled
и любой failed запрещены. PostgreSQL и браузерные проверки также выполняются полностью.

Верификационные манифесты и seals не переписаны. Логические тесты получают проверенный
исторический fixture через явную тестовую композицию; production CLI продолжает отвергать
дрейф текущего дерева. Подробности: [ATLAS.md](../testing/ATLAS.md).

Актуальные результаты: [VERIFICATION.md](VERIFICATION.md).
