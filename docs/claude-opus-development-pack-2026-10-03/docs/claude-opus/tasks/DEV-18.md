# DEV-18 Ежедневные сценарии и доступность интерфейса

Приоритет: **P2**. Аудит: **дополнительное направление целевого решения**.

Зависимости реализации: DEV-09, DEV-12, DEV-15, DEV-17. Проверки: Q3, Q5.

Внешняя приёмка: EXT-10.

## Контекст

Есть мобильная/тёмная тема и axe-тесты, но нет полной пользовательской приёмки и проверки WCAG 2.2 AA.

## Результат

Основные роли выполняют задачи с понятными статусами, сохранёнными фильтрами, доступной навигацией и корректными ошибками.

## Прочитать перед изменением

- [web/src/app/router.tsx](../../../web/src/app/router.tsx)
- [web/src/features/dashboard/MyDayPage.tsx](../../../web/src/features/dashboard/MyDayPage.tsx)
- [web/src/features/activities/MyTasksPanel.tsx](../../../web/src/features/activities/MyTasksPanel.tsx)
- [web/src/features/billing/BillingRunPage.tsx](../../../web/src/features/billing/BillingRunPage.tsx)
- [web/src/shared/components/ErrorState.tsx](../../../web/src/shared/components/ErrorState.tsx)
- [web/src/i18n/locales/nb.json](../../../web/src/i18n/locales/nb.json)
- [web/src/i18n/locales/en.json](../../../web/src/i18n/locales/en.json)
- [web/src/i18n/locales/ru.json](../../../web/src/i18n/locales/ru.json)
- [web/e2e/a11y.spec.ts](../../../web/e2e/a11y.spec.ts)
- [web/e2e/mobile.spec.ts](../../../web/e2e/mobile.spec.ts)

Также применяются [правила исполнения](../EXECUTION.md), [финансовые инварианты](../FINANCIAL_DESIGN.md), [решения](../DECISIONS.md) и [проверки](../VALIDATION.md). Пути указывают исходные точки, а не исчерпывающий список разрешённых файлов; следовать изменениям структуры проекта.

## Объём реализации

1. Пройти end-to-end workflows Sales/Technician/ServiceLead/Finance. Убрать разрывы следующего действия: ответственный, срок и действие по клиенту/сделке доступны из контекста.
2. Добавить или завершить сохранённые представления и нужные bulk operations; сохранять filters/sort/page, не финансовые payload в общий browser storage. Проверять права на каждую запись.
3. Обработать unsaved changes, повтор submit, 412 conflict, 429 retry-after, partial bulk failure, offline/timeout и длительный async export понятными действиями пользователя.
4. Расширить проверки до применимых WCAG 2.2 AA: focus not obscured, target size, keyboard, error association, accessible auth, reflow/zoom, touch; автоматическую проверку дополнить ручной.
5. Проверить nb/en/ru, длинные названия, даты Europe/Oslo, NOK/MVA, пустые и большие списки, светлую/тёмную тему и 360px.
6. Сохранить Fluent UI и lazy routes; UI новых security/privacy/replay workflows также входит в проверку.

## Критерии приёмки

- **DEV-18-AC01** — Сотрудник каждой роли завершает основной сценарий без подсказки разработчика на UAT.
- **DEV-18-AC02** — Keyboard-only пользователь создаёт/исправляет запись и закрывает диалог с возвратом фокуса; ошибки объявляются assistive technology.
- **DEV-18-AC03** — Долгий export показывает актуальное состояние и действия; двойное нажатие не создаёт вторую операцию.
- **DEV-18-AC04** — 412 предлагает перечитать и сопоставить изменения; не выполняется молчаливый overwrite.
- **DEV-18-AC05** — На 360px и увеличении масштаба не теряются управляющие элементы; полная проверка WCAG не сведена к axe serious=0.
- **DEV-18-AC06** — Первая загрузка остаётся ≤300 КБ gzip по принятому инструменту; новые строки есть во всех трёх локалях.

## Данные и обратимость

Изменение сохраняемых пользовательских представлений версионировать; старые filters мигрировать или корректно сбросить с объяснением. Не хранить чужие права локально как authority.

## Границы

Не делать редизайн ради редизайна и не добавлять offline-редактирование финансовых данных.

## Завершение задания

Для каждого AC записать способ проверки, фактический результат, ссылку на тест/протокол и commit или manifest в evidence/DEV-18.md по [шаблону](../evidence/TEMPLATE.md). Новые endpoints требуют permissions, record scope, CSRF для cookie mutation и concurrency control по применимости; новый UI — nb/en/ru и доступность. Не оставлять TODO вместо бизнес-инварианта.

Провести самопроверку diff и миграций; обновить backlog.json и PROGRESS.md. Если код проверен, но внешний gate не пройден, статус code_verified и точная причина. Не помечать accepted по существованию файлов, макетов или заглушек.
