# R-EVAL: инструмент исполнения (ревизия RS-C-B, дополнена RS-D-A … RS-D-C) — порядок работы оператора

Только darwin/arm64, без допуска (UNADMITTED): живого/платного режима нет. Контракты: `IMPLEMENTATION_BRIEF_B.md`,
`../rs-d/IMPLEMENTATION_BRIEF_A.md`, `…_B.md` и `…_C.md`. Сквозной порядок R-EVAL — `../rs-d/REVAL_RUNBOOK.md`, раздел RS-D-C. Ключ провайдера не передаётся (решение владельца PENDING): мостовой S никогда не резолвит ключ,
каждый кейс — `NO_DISPATCH`.

1. Сеанс владельца (RS-A/RS-C-A): `snapshot`, `fixture-check` при PAUSED, затем владелец активирует политику (ACTIVE).
2. В отдельном терминале: `node scripts/reval-instrument/cli.ts session --owner-config <абс. путь> --receipt-dir <каталог>`;
   дождаться `ARTIFACT VERIFIED` и строки `ORDER FIXTURE_GROUPED_FIRST_APPEARANCE_V1 <sha256>`. Порядок кейсов сгруппирован по
   фикстурам (решение владельца D1): FX07, FX05, FX10, FX02, FX03, FX09, FX11, FX04, FX01, FX08, FX06 — 10 переключений.
   Терминал в raw-режиме весь сеанс (эхо выключено).
3. `connect` → `CONNECTED <controlId> <handoffId>`; владелец вводит в O `pair <controlId> <handoffId>`, браузер выполняет PAIR с
   nonce из строки `SECRET PAIRING_NONCE`. В инструменте: `pair-ack` — вставить строку владельца `OK PAIR_ACK {…}` целиком (pairId и
   `expiresAt`; RS-D-C rc2). Пара живёт не больше 10 минут после PAIR в браузере, а PAIR возможен только до `expiresAt` из PAIR_ACK (окно nonce 2 минуты),
   поэтому пара гарантированно жива до `expiresAt` + 8 минут. Инструмент отказывает GO с `BLOCKED_PAIR_REFRESH_REQUIRED` (ничего не
   потреблено), когда от этого срока остаётся меньше 200 с (GO, окно ARM 26 с, слот 120 с, передача). Отправить ответ кнопкой
   «Send evaluation evidence» нужно до конца пары. Тогда владелец `end-pair <pairId>` и `pair …`, браузер — PAIR,
   инструмент — новый `pair-ack`.
4. `admission` (значения владельца; сверяются со снимком C: допуск, лимиты, срок, fence), `confirm`, `capability` (вставка ответа
   `/ask/capabilities` из браузера), `next`, `stage` (вставить вопрос ровно как в браузере), `consent`.
5. `go`: при первом GO (или первом `proofs`) — IDENTITY C один раз: сборка C записывается в квитанцию (RS-D-C) →
   перепись процессов S (PROCESS_CENSUS) → снимок PRE → потребление кейса (маркер `armIssued` сохраняется до ARM) → ARM → READY →
   `GO_CLICK_ASK_NOW <caseId> <секунд>`. Нажимать Ask только после этой строки и до истечения секунд. Перед каждым GO инструмент
   заново забирает терминальное наблюдение прошлого кейса.
   - Сбой ДО потребления даёт `BLOCKED_*`: кейс не потреблён, можно повторить позже.
   - Сбой ПОСЛЕ потребления даёт `ARM_FAILED_*`: кейс потреблён, прогон остановлен (`ARM_STOP`), своя пара инструмента завершается
     (END_PAIR), дальнейших GO в этом процессе нет. Закрытие: `pause-export` владельца, `drain`, новый сеанс.
   - Потеря непрерывности S (другая эпоха переписи, C отвечает `IDENTITY_UNVERIFIED`, или S недоступен — `IPC_LOST`) или посторонняя
     активность между кейсами (в т.ч. новая строка попытки в БД): `BLOCKED_ARM_STOPPED_CENSUS_*` — прогон остановлен, остановка
     записана в квитанцию. Прочие сбои чтения переписи — `BLOCKED_PRE_CENSUS_*`, можно повторить.
   - Запись прошлого кейса, удалённая S несобранной (подтверждение сбора потеряно, прошло 10 минут), — отдельная остановка
     `BLOCKED_ARM_STOPPED_TERMINAL_EXPIRED_UNCOLLECTED` до потребления (RS-D-C); собранная и затем убранная запись — норма.
6. Получив ответ в браузере, оператор вручную нажимает кнопку «Send evaluation evidence» измерительной консоли. `handoff` ждёт не
   дольше 5 с и показывает `HANDOFF_COMMITTED`, `HANDOFF_UNVERIFIED_<код>` или `HANDOFF_PENDING`. Если передачи не будет, введите
   `abandon-handoff`: кейс не засчитывается и помечается `abandonedByOperator`.
7. `finish` доступен только после итога передачи (иначе `BLOCKED_HANDOFF_PENDING`). Он выводит
   `CASE_RECORDED <caseId> <состояние> <handoff> [NO_CREDIT_<причина>]`.
   - Кейс без FINAL-наблюдения, с обнаруженным сбоем (detectedFault) или с публикацией, которая расходится с переданным ответом,
     не засчитывается.
   - POST-перепись S сверяется с PRE: ровно одна отправка, резерв/диспетчеризация в соответствии с записью кейса, все владельцы
     освобождены. Расхождение — `NO_CREDIT_CENSUS_UNVERIFIED` и остановка прогона; лишняя отправка/резерв/диспетчеризация — нарушение
     целостности RC5 (TERMINAL_FAILED). Если запись ещё не FINAL, POST-перепись делается перед следующим GO.
   - Любой сбой останавливает прогон (`effective` TERMINAL_FAILED).
8. **Граница сегментов фикстур** (решения D1/D2: S и C продолжают работать). `next` показывает кейс другой фикстуры; `go` без
   подготовки даёт `BLOCKED_SEGMENT_CLOSURE_REQUIRED`. Порядок:
   1. инструмент: `pause` → `PAUSED_CLOSURE_PENDING`;
   2. владелец в O: `pause-export <admissionId> <текущая версия> 0 0` → `OK CLOSURE {…}`;
   3. инструмент: `closure` (ввести четыре значения закрытия) → `CONFIRMED`;
   4. инструмент: `drain` → нужен `DRAIN QUIESCENT INTACT …` (снять ДО переключения: DRAIN должен совпасть с версией политики и fence
      закрытия); иначе (`PENDING`/`UNKNOWN`) не продолжать, повторить позже или остановить прогон. С части B `QUIESCENT` требует
      инвентаризации процессов C: S в песочнице и тот же экземпляр, в БД только сессии S и читателя C. Открытая сессия владельца
      (psql, утилита обслуживания) во время `drain` даёт `UNKNOWN` — закрыть её и повторить `drain`;
   5. владелец: `drain` в O (тот же итог), `end-pair <pairId>`;
   6. владелец: утилита обслуживания `install <FXnn> <поколение>` — S и C остаются запущенными, но браузер и консоль не используются
      (допускаются только простаивающие сессии зарегистрированных S/C, `ANOTHER_WRITER` — найти и закрыть постороннюю сессию);
   7. владелец: `fixture-check` → все шесть доказательств `true`; затем ручное возобновление политики (новая версия ACTIVE);
   8. владелец: `pair <controlId> <handoffId>`, браузер: PAIR с новым nonce, обновить контекст/очередь в консоли;
   9. инструмент: `resume-pause` → `RESUMED_CONFIRM_NEWER_TUPLE`, `confirm` (новая версия), `pair-ack` (новая строка PAIR_ACK), далее как
      в шагах 4–7.
9. Квитанция `REVAL_INSTRUMENT_<admissionId>.json` (v6 = v4 + `proofs` + `build`): `base` — неизменная квитанция v2 RC5; ни один флаг не повышен
   (`verifiedPass:false`, `liveAcceptanceEligible:false`, BLOCKED); по каждому кейсу — записи переписи PRE/POST и вердикт; `drains` —
   все снятые DRAIN (с версией политики и fence закрытия); `order` — фактический порядок (правило, sha256, sha256 замороженного порядка);
   `proofs` — все снятые пары PLATFORM_PROOF/PRIVACY_PROOF (точные данные C и кейс, после которого они сняты; той же регистрации,
   запуска S и сборки); `build` — сборка C из IDENTITY (RS-D-C).
10. Доказательства (RS-D-B): `proofs` между кейсами (не во время кейса — `BLOCKED_CASE_IN_FLIGHT`) → `PROOFS platform=<ref>
    process=<покрытие> destinations=UNKNOWN verifiedZero=false privacy=<состояние> unreadable=<n> matches=<n> verifiedZero=false`
    (записывается в квитанцию; сбой — `PROOF_FAILED_<код>`; доказательство другой регистрации или другого запуска S отклоняется). На этой
    платформе проверенного нуля нет; `matches` больше 0 — вопрос корпуса найден в каталоге конфигурации: остановить прогон и выяснить
    источник. Сканирование приватности — одно, в момент `proofs`: снимать ПЕРЕД первым GO, после каждого сегмента и в конце. Каталог
    квитанций (`--receipt-dir`) держать вне каталога конфигурации владельца.
11. Диагностика: `census` (перепись S, ничего не записывает). После последнего кейса: `drain`, `proofs`, `pause`, закрытие владельца, `quit`.

**Проверки.** `tests/reval-instrument-{units,identity,run,census}.test.ts`, `tests/reval-{census,proofs,platform}.test.ts`,
`tests/pg/reval-instrument-e2e.pg.test.ts`, `tests/pg/reval-census.pg.test.ts`, `tests/pg/reval-segments.pg.test.ts`,
`tests/pg/reval-native-instrument.pg.test.ts` (при `ATLAS_REVAL_NATIVE_PG_FIXTURE`).
