# DEV-21: отложенное и принятое

Дата: 2026-10-05. Это реестр всего, что после исправлений осталось не закрытым. **Ничто в нём не принято автоматически:** «принято» появляется только после решения владельца, записанного как `DEC-EXC-<номер>` в `docs/claude-opus/DECISIONS.md` с владельцем, компенсирующим контролем и **датой окончания** (формат и сроки реакции — runbook 17 § 2–3; сроки пока ПРЕДЛОЖЕНИЕ, ждут утверждения PO). Владельцы названы ролями; людей в репозитории не назначено, имена не придуманы. Столбец «Запись решения» — заглушка, которую заполняет владелец.

Это самооценка исполнителя, не независимая проверка; внешние gate EXT-02, EXT-06, EXT-07, EXT-11 остаются открытыми.

## A. Находки самооценки, не исправленные или исправленные не полностью

| Находка | Состояние | Серьёзность | Требования | Почему не закрыто | Предлагаемый владелец (роль) | Нужное решение | Запись решения / срок окончания |
|---|---|---|---|---|---|---|---|
| F-G1-14 | partly | low | V2.4.1 | ExportsData endpoints all rate limited (test); limiters remain per replica (documented in docs/06 section 4) | Dev team / PO | Accept per-replica limits or fund a distributed limiter; record with expiry date | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G2-02 | deferred | low | V7.1.2, V7.4.5, V7.5.2 | session list / administrator termination / concurrency policy not built | PO / Dev team | Decide whether sessions must be listable and endable by an administrator; if yes, a privileged endpoint + UI task | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G2-03 | partly | low | V7.2.4, V7.4.2 | deactivation ends open sessions (UserDirectorySync); re-authentication still leaves the previous session valid | Dev team | End the previous session on StartAsync, or accept (cookie is bound to a server row and expires) | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G2-11 | open | low | V7.6.2 | login CSRF not addressed; only a client loop guard added | Dev team | Require a same-site marker or a user gesture on /bff/login, or accept the risk | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G2-13 | partly | low | V7.3.1 | idle expiry test added; 8 h window unchanged | PO / Security owner | Decide on a shorter idle limit for privileged roles | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G3-04 | deferred | low | V8.1.1, V8.2.1, V8.2.2 | docs/02 section 2 and Permissions.cs still differ; see role-matrix-mismatches.md | PO | Confirm the role matrix (DEC-01/EXT-01); then align docs or code | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G3-05 | partly | low | V9.1.2, V9.2.2, V10.3.1 | RS256 allowlist, token types, access-token-kind check done; BI audience is still the interactive app registration (runbook 14) | Security owner / Operations | Give BI its own app registration/audience at the next tenant change (EXT-02) | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G3-10 | partly | low | V8.2.1 | acknowledge needs contracts.write; RequiresFreshRoles on indexation and price-list activation; large paged lists are still not ExportsData | Dev team / PO | Decide whether paged reads of financial lists count as exports | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G3-11 | deferred | low | V8.2.2 | quote discount approver may be the author: product decision | PO | Decide on separation of duties for discount approval (four-eyes) or record acceptance | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G4-02 | partly | medium | V13.3.1 | Key Vault references for Partner Center and Teams secrets in apps.bicep; refresh-token write-back and certificate auth are code changes | Dev team / Operations | Schedule the Partner Center rotation/write-back change | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G4-09 | open | low | V14.3.1 | Clear-Site-Data not sent on sign-out | Dev team | Decide whether saved views must be cleared on sign-out | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G4-11 | deferred | low | V11.1.1, V14.1.2 | privacy HMAC key stays in privacy.Keys next to the hashes | Security owner / PO | Accept (documented) or move to Key Vault; record with expiry date | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G4-12 | open | low | V13.2.4, V13.2.5, V13.3.2 | no egress filtering, AzureServices bypass kept, ACR Basic public endpoint | Operations / PO | Cost and risk decision; verify bypass dependency in test | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G4-14 | partly | low | V13.4.2, V12.1.1 | non-root release check and weekly base image scan added; base image stays a tag, not a digest (decision in docs/06) | Repository owner | Revisit if bit-for-bit reproducibility is required | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G5-02 | partly | medium | V16.4.2, V16.4.3 | Bicep switch and publisher roles prepared; default false until hosts authenticate to the exporter (code change) | Dev team / Operations | Implement Entra credential in the Azure Monitor exporter, then set monitoringEntraOnlyIngestion=true | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G5-05 | partly | low | V15.1.1, V15.2.1 | time frames written as a PROPOSAL (docs/06, runbook 17, SECURITY.md) | PO | Approve or change the time frames | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G5-06 | partly | low | V15.2.1, V15.2.3 | workflows added; no CODEOWNERS (no confirmed owners), secret scanning/push protection are repository settings | Repository owner | EXT-11 | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G5-14 | deferred | low | V16.4.2 | audit chain does not cover who/where/what; schema/format change needs an ADR | Dev team / Security owner | ADR: second checkpoint over actor/IP/changes with a keyed hash | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |
| F-G5-16 | partly | low | V15.1.2 | nuget.config source mapping added; NuGet lock files deliberately not enabled (docs/06 section 4); base image tag | Repository owner | Revisit lock files if reproducibility is required | `DEC-EXC-<номер>` / `<дата окончания — назначает владелец>` |

## B. Открытые требования матрицы без отдельной находки

| Требование | Статус | Серьёзность | Почему открыто | Владелец (роль) | Gate |
|---|---|---|---|---|---|
| V2.1.1 | partial | low | No validation-rule catalogue was added (not done in DEV-21); owner Dev team | Dev team | — |
| V2.1.2 | partial | low | No consolidated combined-field rule list was added | Dev team | — |
| V2.4.1 | partial | low | All ExportsData endpoints are under a rate limit (RequestHardeningTests.Every_endpoint_that_exports_data_is_under_the_export_rate_limit), but limiters are in-process per replica (up to 4); documented, not changed (F-G1-14 deferred) | Dev team / PO | — |
| V3.5.4 | partial | low | Hangfire dashboard still shares the origin with the SPA; now never framed, no-store, anti-forgery token on POSTs; separate host or disabling the dashboard in production is an infra decision | Operations / PO | — |
| V4.2.1 | partial | low | Message framing behind the Container Apps ingress needs request-smuggling probes in the independent test (EXT-06); no code change expected | Security owner | EXT-06 |
| V6.3.1 | external | — | Brute-force and credential-stuffing protection exists only in Entra (Smart Lockout, Conditional Access, MFA); the application never receives credentials. Configuration of those controls in the real tenant cannot be verified from the repo. | infra | EXT-02 |
| V6.4.4 | external | — | Re-enrolment after a lost MFA factor happens in Entra / the IT helpdesk, not in the CRM; the identity-proofing procedure is not documented in the repo. | process | EXT-02 |
| V6.6.1 | external | — | Whether SMS/voice OTP is allowed is decided by the Entra authentication-methods policy; the CRM offers no PSTN mechanism itself. The tenant policy cannot be verified from the repo. | infra | EXT-02 |
| V7.1.2 | gap | low | Deferred: no concurrent-session policy, no session list/terminate (F-G2-02); needs a product decision | PO / Dev team | — |
| V7.1.3 | partial | low | Entra session policy (sign-in frequency, persistence) is tenant configuration | Security owner | EXT-02 |
| V7.2.4 | partial | low | Deactivation now ends sessions (V7.4.2) but a re-authentication still leaves the previous session of the user valid (StartAsync does not end it); F-G2-03 partly fixed | Dev team | — |
| V7.3.1 | partial | low | Idle expiry is now tested (SessionLifecycleTests.An_idle_session_ends_at_the_sliding_lifetime_and_activity_keeps_it_going_until_the_absolute_one) but the 8 h sliding window is unchanged and spans a working day (documented in SEC-AUTH-04); PO decision | PO / Security owner | — |
| V7.4.5 | gap | low | Deferred: no administrator "end sessions" command or UI (ADR-019 states it explicitly); needs a product decision and privileged endpoint | PO / Dev team | — |
| V7.5.2 | gap | low | Deferred: no per-user session list/terminate in the UI | PO / Dev team | — |
| V7.6.1 | partial | low | Front-channel logout and the hourly refresh-token check close the RP session; Entra-side sign-in frequency and sid delivery are tenant facts | Security owner | EXT-02 |
| V7.6.2 | partial | low | Login CSRF (F-G2-11) is not fixed: /bff/login still creates a session by navigation. Only a client-side loop guard (web/src/auth/loginAttempts.ts) was added, which is not this control | Dev team | — |
| V8.2.2 | partial | low | Quote discount approver may be the author (F-G3-11): product decision; kept as accepted-by-default until PO decides | PO | — |
| V10.4.1 | external | — | Entra is the authorization server and compares redirect URIs exactly; the app registration script registers the single URI {BASE_URL}/signin-oidc. What is actually registered in the real tenant (no wildcards, no extras) cannot be proven from the repo. | external | EXT-02 |
| V10.4.4 | external | — | The registration script switches implicit id/access token issuance off and the client only uses the code flow; no password grant exists in the code. That the real tenant registration has implicit and public-client flows disabled needs checking. | external | EXT-02 |
| V10.4.6 | external | — | The client sends PKCE, but whether Entra enforces PKCE for this confidential web registration is not configurable by us; a stolen code is additionally useless without the client certificate. | external | EXT-02 |
| V10.4.8 | external | — | Refresh-token lifetimes are Entra policy. On our side the cookie session ends at 12 h absolute regardless of refresh, and an hourly forced refresh-token redemption ends the session when Entra refuses; the real token lifetime and CA sign-in frequency need confirming in the tenant. | external | EXT-02 |
| V10.4.9 | external | — | Revoking tokens and sessions is done in Entra (admin revoke sessions, user My Account); the CRM reacts by ending the session when the refresh token is refused and by the role/deactivation sync (ADR-019). Tenant procedure and test of revocation are EXT-02. | external | EXT-02 |
| V10.4.11 | external | — | The registration script declares only Graph User.Read, while the code requests Calendars.ReadWrite and Mail.Read dynamically (consent said to be granted once) so the declared and used permissions differ; whether admin consent in the tenant is limited to what is needed must be checked. | external | EXT-02 |
| V10.6.1 | external | — | The client requests only response_type=code and the registration disables implicit issuance, so hybrid/implicit are not used; the OP (Entra) setting itself is verified in the tenant. | external | EXT-02 |
| V10.7.1 | external | — | Consent is Entra tenant configuration: the app asks for delegated Calendars.ReadWrite and Mail.Read and the docs say consent is granted once for the application, so user-consent policy and admin consent in the tenant are what to check. | external | EXT-02 |
| V11.2.2 | partial | low | Digest calls are still direct (~12 sites); ADR-024 lists them but no central helper or architecture test exists | Dev team | — |
| V11.3.2 | partial | low | Data Protection algorithm is the framework default (AES-256-CBC + HMACSHA256, as documented in ADR-024); no UseCryptographicAlgorithms pin and no test | Dev team | — |
| V12.1.1 | partial | low | No post-deploy TLS version check was added to tools/release/smoke.sh; platform-managed | Operations | EXT-06 |
| V12.1.2 | external | — | Cipher suites on the public endpoint are chosen by the Azure Container Apps ingress and cannot be configured from this repository; Kestrel only listens on plain HTTP 8080 behind it. Needs an external scan of the real FQDN. | infra | EXT-06 |
| V12.3.3 | partial | low | peerTrafficConfiguration encryption not enabled in apps.bicep; platform hop is an accepted risk not yet recorded in docs/03 | Operations / PO | — |
| V13.1.1 | partial | low | No communication matrix added to docs/03; ADR-024 and docs/06 section 5/6 cover keys and secrets only | Dev team | — |
| V13.2.4 | partial | low | https-only validated, Teams host allowlist, redirects off, Graph same-origin (2026-10-21: also the Partner Center billing export; its storage files only https with a SAS signature on `BillingStorageHostSuffixes`, without the token, [addendum](addendum-2026-10-21-partner-billing-links.md)); no general per-integration host allowlist or egress filtering (F-G4-12 open) | Operations / PO | — |
| V13.2.5 | partial | low | Server egress still unfiltered (F-G4-12 open, owner decision recorded in docs/06 section 6) | Operations / PO | — |
| V13.3.2 | partial | low | crm-web still has vault-wide Reader and a storage-account-wide blob role; Key Vault bypass AzureServices kept unverified (F-G4-12) | Operations | — |
| V13.4.4 | partial | low | TRACE check not added to tools/release/smoke.sh | Operations | — |
| V14.1.1 | partial | low | No data classification table (EXT-07 decisions) | PO | EXT-07 |
| V14.1.2 | partial | low | Per-class protection requirements not written | PO | EXT-07 |
| V14.2.1 | partial | low | Search terms still travel in GET query strings; redaction in Azure Monitor not confirmed | Dev team | — |
| V14.2.4 | partial | low | Depends on V14.1.2 | PO | EXT-07 |
| V14.3.1 | partial | low | Clear-Site-Data on sign-out not implemented (F-G4-09 open); saved views survive sign-out | Dev team | — |
| V15.1.1 | partial | low | Time frames are written (docs/06 section 4, runbook 17, SECURITY.md) but labelled PROPOSAL awaiting PO approval; Medium/Low not checked automatically | PO | EXT-11 |
| V15.1.3 | partial | low | No inventory of resource-demanding functions | Dev team | — |
| V15.2.1 | partial | low | Depends on approval of the V15.1.1 time frames; dependency-review.yml and base-image-scan.yml added | PO / Repository owner | EXT-11 |
| V15.3.7 | partial | low | No test for duplicated scalar query parameters | Dev team | — |
| V16.2.5 | partial | low | Several sites still pass exceptions to the logger; not changed. Mitigations: three log-capture tests, ADR-025 | Dev team | — |
| V16.4.3 | partial | medium | Alert rules exist; delivery recipients are EXT-01; telemetry ingestion not Entra-only yet (F-G5-02) | Operations | EXT-11 |

## C. Решения, которые нужны от владельца продукта (сводка)

1. Разделение обязанностей при согласовании скидки в предложении (F-G3-11, V8.2.2).
2. Матрица ролей docs/02 §2 и `Permissions.cs`: ответить на вопросы в `role-matrix-mismatches.md` (F-G3-04, V8.1.1/V8.2.1) — до ответа политика не утверждена (EXT-01, DEC-01).
3. Нужны ли список сессий, принудительное завершение администратором и политика параллельных сессий (F-G2-02, V7.1.2/V7.4.5/V7.5.2).
4. Принять или переработать хранение ключа HMAC приватности рядом с хешами (F-G4-11).
5. Покрытие цепочки аудита: ADR на хеш по пользователю, IP и изменениям (F-G5-14).
6. Лимиты запросов на реплику: принять или перейти на распределённый лимитер (F-G1-14).
7. Утвердить или изменить сроки устранения уязвимостей (F-G5-05, runbook 17).
8. Egress-политика, Premium-реестр с private endpoint и снятие `bypass: AzureServices` (F-G4-12).

## D. Не решения, а внешние шаги

- EXT-02: зарегистрировать `auth_time` (и проверить `sid`) в приложении Entra, решить `Auth:RequiredAcr`, проверить Conditional Access/MFA, PIM, front-channel logout, audience BI.
- EXT-11: secret scanning, push protection, защита ветки, назначение владельцев для `CODEOWNERS`, переменная `CRM_TEST_URL` для ZAP.
- EXT-06: независимая проверка и retest, включая TLS на ingress и request smuggling.
- EXT-07: классификация данных и сроки хранения.
- Код: включить `monitoringEntraOnlyIngestion` только после того, как хосты передают Entra-учётные данные в экспортёр Azure Monitor.
