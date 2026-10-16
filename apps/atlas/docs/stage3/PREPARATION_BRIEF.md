# Stage 3 preparation brief — first governed Atera ticket

Date: 2026-10-08. Draft scope from docs/ROADMAP.md; no architecture or implementation approval is claimed.

## Outcome and boundaries

Prepare one cohesive action slice: deterministic preview → policy → approval of an immutable request → execution →
verification → allowlisted audit. These guarantees must ship together before the first actual vendor write.
Initial action scope is one Atera ticket. No automatic remediation, multi-step workflows, new UI, PowerOffice integration
or broad action catalogue is part of this slice.

The owner asked to defer real live execution and continue engineering. Stage 3 design and synthetic implementation depend
on accepted Foundation contracts. They can proceed while Stage 1/2 live gates remain open. Real Atera POSTs, rollout and
production claims stay gated independently. S2-LIVE preparation, its empty pilot DB and proposed operator setup are not
inputs to synthetic ticket fixtures and do not provide live acceptance evidence.

## Required design decisions

- Define ticket draft fields, trusted source attribution and bounded text handling. Confirm the actual Atera create/read
  contract from primary vendor documentation before freezing the adapter specification; no endpoint/schema is presumed here.
- Define per-client action permissions, policy outcomes and distinct request/approval/execution authorities. Caller-supplied
  identifiers or model output cannot grant authority. Preserve RLS and safe workspace denial audit.
- Define the immutable request digest and approval lifetime/revocation behavior. An approval must bind the exact target,
  payload and policy context; changed input requires a new approval.
- Define persisted state, concurrency, idempotency, attempt ownership and recovery. Explicitly resolve the ambiguous outcome
  when a remote create succeeds but the local response/commit is lost; retries must not blindly duplicate tickets.
- Define execution and verification results separately, including partial/unverified failure. Verify the remote ticket against
  the approved request using a reviewed read path; local success is not proof of a vendor-side result.
- Keep audit output allowlisted and separate secret-bearing private configuration from public status. Raw ticket content and
  arbitrary free text must not flow into Decisions under the existing evidence contract.
- Define the API/tool/CLI exposure, request validation, error codes and compatibility with accepted read-only operations.
- Define bounded retention/recovery and migration/upgrade behavior. Add new migrations; preserve every frozen migration.

## Package and implementation gates

Build a concise spec, contracts, data/permission/state-machine design, adapter contract, implementation checkpoints and
acceptance matrix. Include context routing and model assignments. Freeze the same artifact for two fresh independent
reviews: explicit gpt-6-astra/xhigh and native claude-fable-5-1/high, with verified subscription routing and no silent fallback.
Neither reviewer receives the other's initial verdict. Required findings must close against the same current artifact.

Implementation follows only after both approvals. Use native Claude Code Opus 5.5/high for authorization, persistence,
concurrency, recovery and execution safety; bounded independent work follows the project model policy. Give each writer an
exact baseline and stopping checkpoint. Astra independently accepts actual code and evidence at every checkpoint.

Synthetic acceptance must exercise scope/permission denials, stale or changed approvals, collisions/concurrent execution,
timeouts and ambiguous remote outcomes, verification mismatch, audit atomicity, secret/privacy canaries and read regressions.
Use focused tests during work and the required checkpoint suite. Mock success never closes a live gate.

## Preserved baseline and open work

HEAD 916a4d69853ff6da636e8609a2e0bd33aa787f66, branch planning/stage2-m365, with extensive accepted dirty work.
S2-A/B/C engineering is accepted; recorder S2LIVE-RECORDER-rc2 package
a02667ee81ef7f3ad809a7952d562a688d9caee408484a905c4e3b28212203e3 has 324 accepted files. Preserve their identities while
preparing this separate package. Stage 2 normative hash: 1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb.

Open next work: vendor contract verification; detailed action/approval/recovery decisions; complete frozen Stage 3 package;
dual architecture review. No Stage 3 source code, action grants or actual vendor writes have been introduced by this brief.
