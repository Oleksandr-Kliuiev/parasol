# Security policy

Vardahei CRM v2 is an internal system of an IT company. This file says how a vulnerability is reported and how fast the
project answers. The detailed internal process, the exception register and the evidence package for an independent
reviewer are in [docs/runbooks/17-vulnerability-intake.md](docs/runbooks/17-vulnerability-intake.md) (Russian, like the other
runbooks). The security model and its assessment boundaries are in [docs/06-security.md](docs/06-security.md).

## Status of this policy

Everything marked **PROPOSED** below is a proposal that waits for approval by the product owner (PO). Until it is approved it
describes the intention, not a commitment. The repository settings that make parts of it work (private vulnerability
reporting, secret scanning, branch protection, code owners) are tracked as **EXT-11** and are not verified from files.

## Reporting a vulnerability

- Do not open a public issue or pull request for a suspected vulnerability.
- Reporting channel: **PLACEHOLDER (EXT-11)**. The intended channel is GitHub private vulnerability reporting on this
  repository, with a security mailbox owned by the Security owner role as the fallback. Neither is confirmed; no address is
  published here until the owner role names one.
- Send what is needed to reproduce: the affected endpoint or screen, the role used, the steps, the expected and the actual
  result. Do not include real customer data, tokens or passwords; the test environment is the place to reproduce.
- Please do not test against production, do not access data that is not yours and do not run denial-of-service tests.

## Response targets (PROPOSED, pending PO approval)

Severity follows the impact in this system (CVSS as a starting point, adjusted for exploitability and for whether the data is
financial or personal). The clock starts when the report reaches the Security owner role.

| Severity | Acknowledge | Fix released to test and promoted | Notes |
|---|---|---|---|
| Critical | 24 hours | 7 days | Interim mitigation (pause an integration, read-only maintenance, revoke a role) within 24 hours where possible |
| High | 3 days | 14 days | |
| Medium | 7 days | 30 days | |
| Low | 14 days | Next planned release | |

A fix is not "done" until the retest in the runbook has been recorded. A target that cannot be met needs an exception: a
written decision with an owner, a reason, a compensating control and an **expiry date**, kept in the register described in
the runbook. An exception without an expiry date is not accepted.

## Roles (names of roles, not people)

| Role | Responsibility | Named person |
|---|---|---|
| Security owner | Receives reports, assigns severity, tracks the fix and the exception register | not assigned (EXT-11) |
| Product owner | Approves this policy, accepts or refuses exceptions for High and Critical | not assigned (EXT-11) |
| Repository owner | Repository and branch settings, secret scanning, private reporting, code owners | not assigned (EXT-11) |
| Operations | Mitigations in the environment (pause, maintenance, rotation) | not assigned (EXT-01) |

## Supported versions

Only the release currently deployed to production and the release in test are supported. Fixes go forward as a new release
through the normal pipeline (ADR-015); there are no backports.

## Secure Software Development Framework (SSDF) mapping

NIST SP 800-218 practices and where this project does them. "Gap" means the practice is not (fully) in place.

| SSDF practice | In this repository | Gap |
|---|---|---|
| PO.1 Define security requirements | docs/06-security.md, ASVS 5.0.0 L2 baseline, architecture tests | Independent confirmation (EXT-06) |
| PO.2 Roles and responsibilities | Role names in this file and runbook 17 | Named people (EXT-11) |
| PO.3 Supporting toolchains | CI pipeline, pinned actions, pinned SDK (`global.json`), release tooling | Lock files not enabled (decision in docs/06 §4) |
| PO.4 Criteria for security checks | Release gates: High/Critical packages, image scan, CodeQL, tests | Medium/Low deadlines are proposed only |
| PO.5 Secure environments | Separate test and prod, OIDC deployment, no secrets in CI | Real tenant controls (EXT-02) |
| PS.1 Protect code | Branch rules documented in runbook 01 | Actual repository settings unverified (EXT-11) |
| PS.2 Verify release integrity | Images by digest, provenance attestation verified on promotion | |
| PS.3 Archive releases | Release manifest, SBOM per image | |
| PW.1 / PW.2 Design and design review | ADRs, threat model in docs/06 §1 | Independent review (EXT-06) |
| PW.4 Reuse secure components | Central package versions, vulnerable-package gate, dependency review on pull requests | Transitive versions float (no lock files) |
| PW.5 Secure coding | Server-side authorization on every endpoint (architecture test), parameterized queries, analyzers as errors | |
| PW.6 Build configuration | Warnings as errors, SDK container build, non-root image check at release | Base image pinned by tag, not digest |
| PW.7 Code review and analysis | CodeQL; pull-request review is a repository setting | Required reviews and code owners (EXT-11) |
| PW.8 Test executable code | Unit, integration, architecture, end-to-end and accessibility tests; ZAP baseline workflow on test | ZAP is unauthenticated; no independent test yet (EXT-06) |
| PW.9 Secure default configuration | Production refuses unsafe settings at start; environment-bound settings fixed in `infra/env` | |
| RV.1 Identify vulnerabilities | This policy, dependency scans, Dependabot, scheduled base-image rescan | Private reporting channel (EXT-11) |
| RV.2 Assess, prioritize, remediate | Severity targets above and runbook 17 | Targets are PROPOSED |
| RV.3 Analyze root causes | Findings recorded with evidence in docs/claude-opus/evidence/DEV-21 | |
