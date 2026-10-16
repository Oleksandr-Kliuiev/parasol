# DEV-21: сводка матрицы ASVS 5.0.0 (уровни 1 и 2)

Дата повторной оценки: 2026-10-05. Состояние — коммит «DEV-21: …» (`git log codex/readiness`); ничего не развёрнуто.

## Граница утверждения

**Это самооценка исполнителя (Claude, реализовавший исправления), а не независимая оценка.** Оценка выполнена чтением кода, конфигурации и результатов локальных тестов; реальный тенант Entra, живое окружение Azure и репозиторий GitHub не проверялись. Матрица не утверждает соответствие ASVS L2. Внешние gate остаются открытыми:

- **EXT-02** — реальный тенант Entra: Conditional Access/MFA, `Assignment required`, PIM, права Graph, claim `auth_time`/`sid`, redirect URI;
- **EXT-06** — независимая проверка и повторное тестирование (retest), включая TLS/ingress и request smuggling;
- **EXT-07** — решения по данным: классификация, сроки хранения, DPIA;
- **EXT-11** — настройки репозитория: secret scanning, push protection, защита ветки, CODEOWNERS, `CRM_TEST_URL` для ZAP;
- (EXT-01 — получатели алертов.)

Состав: ровно 253 требования уровней 1 и 2 официального CSV ASVS 5.0.0 (SHA-256 `98c8fe911b9edb403af8ee05d3ce8201ecac2659e313b053890a62847cdcf680`); идентификаторы, уровни и тексты сверены скриптом. Файлы: `asvs-5.0.0-l2-matrix.csv`, `matrix/G1..G5.json` (первичная оценка), `matrix/final/G1..G5.json` (после исправлений).

Проверки, выполненные локально 2026-10-05 при повторной оценке: `dotnet test` юнит (603 из 603), архитектурные (94 из 94), целевые интеграционные классы `WebHostSecurityTests`, `RequestHardeningTests`, `ReverificationTests` (94 из 94) и `SessionLifecycleTests`, `BiApiTests`, `ProjectsApiTests`, `AccessAndConcurrencyTests`, `MigrationImportTests` (39 из 39). Полные наборы после всех исправлений запускались отдельно (см. evidence/DEV-21.md): интеграционные 427 из 427, Playwright 88 из 88 на свежих хостах, vitest 143 из 143.

## Итоги по статусам

| Статус | До исправлений | После |
|---|---|---|
| met | 78 | 129 |
| partial | 81 | 36 |
| gap | 9 | 3 |
| external | 13 | 13 |
| not_applicable | 72 | 72 |
| **Всего** | 253 | 253 |

Из 253 требований 181 применимо; 72 неприменимы (обоснование в матрице).

## По главам (после; в скобках до)

| Глава | met | partial | gap | external | n/a |
|---|---|---|---|---|---|
| V1 Encoding and Sanitization | 13 (9) | 0 (4) | 0 (0) | 0 (0) | 14 (14) |
| V2 Validation and Business Logic | 8 (5) | 3 (6) | 0 (0) | 0 (0) | 0 (0) |
| V3 Web Frontend Security | 17 (10) | 1 (6) | 0 (2) | 0 (0) | 1 (1) |
| V4 API and Web Service | 3 (1) | 1 (3) | 0 (0) | 0 (0) | 6 (6) |
| V5 File Handling | 7 (4) | 0 (3) | 0 (0) | 0 (0) | 2 (2) |
| V6 Authentication | 7 (2) | 0 (5) | 0 (0) | 4 (4) | 24 (24) |
| V7 Session Management | 8 (6) | 5 (7) | 3 (3) | 0 (0) | 2 (2) |
| V8 Authorization | 3 (2) | 3 (3) | 0 (1) | 0 (0) | 1 (1) |
| V9 Self-contained Tokens | 6 (4) | 0 (2) | 0 (0) | 0 (0) | 1 (1) |
| V10 OAuth and OIDC | 10 (9) | 0 (1) | 0 (0) | 8 (8) | 11 (11) |
| V11 Cryptography | 10 (7) | 2 (4) | 0 (1) | 0 (0) | 2 (2) |
| V12 Secure Communication | 5 (4) | 2 (3) | 0 (0) | 1 (1) | 1 (1) |
| V13 Configuration | 7 (5) | 6 (8) | 0 (0) | 0 (0) | 0 (0) |
| V14 Data Protection | 4 (2) | 5 (7) | 0 (0) | 0 (0) | 0 (0) |
| V15 Secure Coding and Architecture | 9 (3) | 4 (10) | 0 (0) | 0 (0) | 0 (0) |
| V16 Security Logging and Error Handling | 12 (5) | 4 (9) | 0 (2) | 0 (0) | 0 (0) |
| V17 WebRTC | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 7 (7) |

## Открытые пункты (52)

Владелец — роль, не человек (имена не назначены).

| Требование | Статус | Серьёзность | Владелец | Gate | Находки | Что осталось |
|---|---|---|---|---|---|---|
| V2.1.1 | partial | low | Dev team | — | — | No validation-rule catalogue was added (not done in DEV-21); owner Dev team |
| V2.1.2 | partial | low | Dev team | — | — | No consolidated combined-field rule list was added |
| V2.4.1 | partial | low | Dev team / PO | — | — | All ExportsData endpoints are under a rate limit (RequestHardeningTests.Every_endpoint_that_exports_data_is_under_the_export_rate_limit), but limiters are in-process per replica (up to 4); documented, not changed (F-G1-14 deferred) |
| V3.5.4 | partial | low | Operations / PO | — | — | Hangfire dashboard still shares the origin with the SPA; now never framed, no-store, anti-forgery token on POSTs; separate host or disabling the dashboard in production is an infra decision |
| V4.2.1 | partial | low | Security owner | EXT-06 | — | Message framing behind the Container Apps ingress needs request-smuggling probes in the independent test (EXT-06); no code change expected |
| V6.3.1 | external | — | infra | EXT-02 | — | Brute-force and credential-stuffing protection exists only in Entra (Smart Lockout, Conditional Access, MFA); the application never receives credentials. Configuration of those controls in the real te |
| V6.3.3 | external | — | infra | EXT-02 | F-G2-08 | MFA is a Conditional Access requirement in Entra (SEC-AUTH-02); the application does not inspect amr/acr claims, so it cannot detect a token issued without MFA. See F-G2-08 (medium). |
| V6.4.4 | external | — | process | EXT-02 | — | Re-enrolment after a lost MFA factor happens in Entra / the IT helpdesk, not in the CRM; the identity-proofing procedure is not documented in the repo. |
| V6.6.1 | external | — | infra | EXT-02 | — | Whether SMS/voice OTP is allowed is decided by the Entra authentication-methods policy; the CRM offers no PSTN mechanism itself. The tenant policy cannot be verified from the repo. |
| V7.1.2 | gap | low | PO / Dev team | — | — | Deferred: no concurrent-session policy, no session list/terminate (F-G2-02); needs a product decision |
| V7.1.3 | partial | low | Security owner | EXT-02 | — | Entra session policy (sign-in frequency, persistence) is tenant configuration |
| V7.2.4 | partial | low | Dev team | — | — | Deactivation now ends sessions (V7.4.2) but a re-authentication still leaves the previous session of the user valid (StartAsync does not end it); F-G2-03 partly fixed |
| V7.3.1 | partial | low | PO / Security owner | — | — | Idle expiry is now tested (SessionLifecycleTests.An_idle_session_ends_at_the_sliding_lifetime_and_activity_keeps_it_going_until_the_absolute_one) but the 8 h sliding window is unchanged and spans a working day (documented in SEC-AUTH-04); PO decision |
| V7.4.5 | gap | low | PO / Dev team | — | — | Deferred: no administrator "end sessions" command or UI (ADR-019 states it explicitly); needs a product decision and privileged endpoint |
| V7.5.2 | gap | low | PO / Dev team | — | — | Deferred: no per-user session list/terminate in the UI |
| V7.6.1 | partial | low | Security owner | EXT-02 | — | Front-channel logout and the hourly refresh-token check close the RP session; Entra-side sign-in frequency and sid delivery are tenant facts |
| V7.6.2 | partial | low | Dev team | — | — | Login CSRF (F-G2-11) is not fixed: /bff/login still creates a session by navigation. Only a client-side loop guard (web/src/auth/loginAttempts.ts) was added, which is not this control |
| V8.1.2 | partial | low | PO / Dev team | — | F-G3-01 | SEC-AZ-04 now names [SensitiveData] and states the write-side rule (F-G3-01 fixed in code), but no per-field list of sensitive DTO fields exists and the docs/02 mismatch list (F-G3-04) is open; see role-matrix-mismatches.md |
| V8.2.1 | partial | low | PO / Dev team | — | F-G3-02, F-G3-04, F-G3-10 | Mart per-dataset permission, reminder acknowledge (contracts.write) and RequiresFreshRoles on indexation/price-list activation are fixed; open: docs/02 vs Permissions.cs mismatches (F-G3-04) and ExportsData is not applied to large paged lists (F-G3-10 partly) |
| V8.2.2 | partial | low | PO | — | — | Quote discount approver may be the author (F-G3-11): product decision; kept as accepted-by-default until PO decides |
| V10.4.1 | external | — | external | EXT-02 | — | Entra is the authorization server and compares redirect URIs exactly; the app registration script registers the single URI {BASE_URL}/signin-oidc. What is actually registered in the real tenant (no wi |
| V10.4.4 | external | — | external | EXT-02 | — | The registration script switches implicit id/access token issuance off and the client only uses the code flow; no password grant exists in the code. That the real tenant registration has implicit and  |
| V10.4.6 | external | — | external | EXT-02 | — | The client sends PKCE, but whether Entra enforces PKCE for this confidential web registration is not configurable by us; a stolen code is additionally useless without the client certificate. |
| V10.4.8 | external | — | external | EXT-02 | — | Refresh-token lifetimes are Entra policy. On our side the cookie session ends at 12 h absolute regardless of refresh, and an hourly forced refresh-token redemption ends the session when Entra refuses; |
| V10.4.9 | external | — | external | EXT-02 | — | Revoking tokens and sessions is done in Entra (admin revoke sessions, user My Account); the CRM reacts by ending the session when the refresh token is refused and by the role/deactivation sync (ADR-01 |
| V10.4.11 | external | — | external | EXT-02 | — | The registration script declares only Graph User.Read, while the code requests Calendars.ReadWrite and Mail.Read dynamically (consent said to be granted once) so the declared and used permissions diff |
| V10.6.1 | external | — | external | EXT-02 | — | The client requests only response_type=code and the registration disables implicit issuance, so hybrid/implicit are not used; the OP (Entra) setting itself is verified in the tenant. |
| V10.7.1 | external | — | external | EXT-02 | — | Consent is Entra tenant configuration: the app asks for delegated Calendars.ReadWrite and Mail.Read and the docs say consent is granted once for the application, so user-consent policy and admin conse |
| V11.2.2 | partial | low | Dev team | — | — | Digest calls are still direct (~12 sites); ADR-024 lists them but no central helper or architecture test exists |
| V11.3.2 | partial | low | Dev team | — | — | Data Protection algorithm is the framework default (AES-256-CBC + HMACSHA256, as documented in ADR-024); no UseCryptographicAlgorithms pin and no test |
| V12.1.1 | partial | low | Operations | EXT-06 | — | No post-deploy TLS version check was added to tools/release/smoke.sh; platform-managed |
| V12.1.2 | external | — | infra | EXT-06 | — | Cipher suites on the public endpoint are chosen by the Azure Container Apps ingress and cannot be configured from this repository; Kestrel only listens on plain HTTP 8080 behind it. Needs an external  |
| V12.3.3 | partial | low | Operations / PO | — | — | peerTrafficConfiguration encryption not enabled in apps.bicep; platform hop is an accepted risk not yet recorded in docs/03 |
| V13.1.1 | partial | low | Dev team | — | — | No communication matrix added to docs/03; ADR-024 and docs/06 section 5/6 cover keys and secrets only |
| V13.2.4 | partial | low | Operations / PO | — | — | https-only validated, Teams host allowlist, redirects off, Graph same-origin; no per-integration host allowlist or egress filtering (F-G4-12 open) |
| V13.2.5 | partial | low | Operations / PO | — | — | Server egress still unfiltered (F-G4-12 open, owner decision recorded in docs/06 section 6) |
| V13.3.1 | partial | low | Dev team / Operations | — | F-G4-01 | Partner Center and Teams secrets now Key Vault references for the worker (apps.bicep:179; InfrastructureTests.Partner_center_and_teams_secrets_are_per_secret_key_vault_references_for_the_worker). Open: refresh token is not written back after rotation, client secret instead of certificate (code change) |
| V13.3.2 | partial | low | Operations | — | — | crm-web still has vault-wide Reader and a storage-account-wide blob role; Key Vault bypass AzureServices kept unverified (F-G4-12) |
| V13.4.4 | partial | low | Operations | — | — | TRACE check not added to tools/release/smoke.sh |
| V14.1.1 | partial | low | PO | EXT-07 | — | No data classification table (EXT-07 decisions) |
| V14.1.2 | partial | low | PO | EXT-07 | — | Per-class protection requirements not written |
| V14.2.1 | partial | low | Dev team | — | — | Search terms still travel in GET query strings; redaction in Azure Monitor not confirmed |
| V14.2.4 | partial | low | PO | EXT-07 | — | Depends on V14.1.2 |
| V14.3.1 | partial | low | Dev team | — | — | Clear-Site-Data on sign-out not implemented (F-G4-09 open); saved views survive sign-out |
| V15.1.1 | partial | low | PO | EXT-11 | — | Time frames are written (docs/06 section 4, runbook 17, SECURITY.md) but labelled PROPOSAL awaiting PO approval; Medium/Low not checked automatically |
| V15.1.3 | partial | low | Dev team | — | — | No inventory of resource-demanding functions |
| V15.2.1 | partial | low | PO / Repository owner | EXT-11 | — | Depends on approval of the V15.1.1 time frames; dependency-review.yml and base-image-scan.yml added |
| V15.3.7 | partial | low | Dev team | — | — | No test for duplicated scalar query parameters |
| V16.2.1 | partial | low | Dev team | — | F-G5-03 | Security log lines carry user id; no actor-id log scope on every request log line |
| V16.2.5 | partial | low | Dev team | — | — | Several sites still pass exceptions to the logger; not changed. Mitigations: three log-capture tests, ADR-025 |
| V16.4.2 | partial | medium | Dev team / Operations / Security owner | EXT-11 | F-G5-02 | Mismatch/missing-checkpoint alerts added (monitoring-operations.bicep:209, InfrastructureTests.A_mismatch_of_the_audit_chain_raises_a_severity_1_alert). Open: App Insights still accepts non-Entra ingestion (monitoringEntraOnlyIngestion=false), so anchors can be forged; chain does not cover who/where/what (F-G5-14 defer |
| V16.4.3 | partial | medium | Operations | EXT-11 | — | Alert rules exist; delivery recipients are EXT-01; telemetry ingestion not Entra-only yet (F-G5-02) |

## Находки

72 находки первичной оценки (с дубликатами): исправлено 53, частично 11, открыто 3, отложено 5. Подробности и решения — `deferred-and-accepted.md`.

## Требования уровня 3, не оцененные (92)

Уровень 3 вне границы DEV-21. Не оценивались: V1.2.10, V1.3.12, V1.5.3, V2.3.5, V2.4.2, V3.1.1, V3.2.3, V3.3.5, V3.4.7, V3.4.8, V3.5.6, V3.5.7, V3.5.8, V3.6.1, V3.7.3, V3.7.4, V3.7.5, V4.1.4, V4.1.5, V4.2.2, V4.2.3, V4.2.4, V4.2.5, V5.2.4, V5.2.5, V5.2.6, V5.3.3, V6.3.5, V6.3.6, V6.3.7, V6.3.8, V6.4.5, V6.4.6, V6.5.6, V6.5.7, V6.5.8, V6.6.4, V6.7.1, V6.7.2, V7.5.3, V8.1.3, V8.1.4, V8.2.4, V8.3.2, V8.3.3, V8.4.2, V10.2.3, V10.3.5, V10.4.12, V10.4.13, V10.4.14, V10.4.15, V10.4.16, V11.1.3, V11.1.4, V11.2.4, V11.2.5, V11.3.4, V11.3.5, V11.5.2, V11.6.2, V11.7.1, V11.7.2, V12.1.4, V12.1.5, V12.3.5, V13.1.2, V13.1.3, V13.1.4, V13.2.6, V13.3.3, V13.3.4, V13.4.6, V13.4.7, V14.2.5, V14.2.6, V14.2.7, V14.2.8, V15.1.4, V15.1.5, V15.2.4, V15.2.5, V15.4.1, V15.4.2, V15.4.3, V15.4.4, V16.5.4, V17.1.2, V17.2.5, V17.2.6, V17.2.7, V17.2.8.

## Расхождения и оговорки

- `AllowedHosts: "*"` остаётся в `src/Hosts/Crm.Web/appsettings.json` для Development/Testing; в Production приложение не стартует без перечня хостов (`HostSecurity.AllowedHostsProblem`), Bicep их задаёт.
- `Forwarded:KnownNetworks` не обязателен: без настройки вне Development применяются частные диапазоны (`HostSecurity.PrivateNetworks`); Bicep задаёт подсеть приложений.
- Привилегированные действия требуют claim `auth_time` в id_token: пока он не зарегистрирован в тенанте, они закрыты для всех (безопасный отказ).
- Статусы «met» для ингресса, Entra и Key Vault означают «в коде и IaC», не «на живом окружении».
