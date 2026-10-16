# ASK-REMOTE — question-only remote intent recognition

Owner requested architecture/provider/data/billing preparation, independent Astra/xhigh and Fable5.1/high review,
then implementation only after both approvals. Owner authorized a reasoned provider choice and conservative proposed
limits; actual paid calls require separate data/budget admission. GPT-4.1 mini was rejected as too old and is excluded.

This amendment upgrades natural-language recognition of the four accepted Ask intents. OpenAI GPT-6 Luna returns
one closed intent enum. Atlas selects request-local references and compiles the existing factual claims locally.
No stored customer evidence goes to the provider. The original free-text question does, subject to explicit consent;
it can contain sensitive content and is not called sanitized. No general research, remediation or free-form answer.

Normative package: AGENTS.md, README.md, 01_SCOPE.md, 02_CONTRACTS.md, 03_DATA_AND_PROVIDER.md,
04_AUTHORITY_AND_BILLING.md, 05_ACCEPTANCE.md, 06_PROVIDER_DECISION.md, intent-prompt.json and intent-schema.json.
DESIGN_STATUS.md and review receipts are administrative. Manifest binds these ten files and accepted dependencies.

Dependencies: ASK-A S5ASKA-rc3, ASK-B S5ASKB-rc2, Ask architecture RC3 and console S5B-rc1. Their accepted source and
seals must match the recorded baseline before implementation. OFF/MOCK contracts remain byte-for-byte compatible.
Remote uses explicit V2 request/capability/answer DTOs; the independent evidence/claim predicates remain unchanged.

Implementation stages: R-A durable admission/ledger and permission; R-B adapter/server through offline provider seams;
R-C browser disclosure/consent and offline E2E. Each stops for fresh Astra/xhigh acceptance. R-EVAL is a separate
owner-admitted synthetic paid evaluation. Real customer use and production deployment remain separate gates.
Design approval can authorize engineering without authorizing data egress or an account charge.

Routing: [scope](01_SCOPE.md), [public contract](02_CONTRACTS.md), [data/provider](03_DATA_AND_PROVIDER.md),
[authority/billing](04_AUTHORITY_AND_BILLING.md), [acceptance](05_ACCEPTANCE.md), [provider decision](06_PROVIDER_DECISION.md).
