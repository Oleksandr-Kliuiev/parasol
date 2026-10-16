# R-EVAL human review and adjudication checklist

State: **PENDING — no human has reviewed any case.** Human attestors are assigned later by the owner. A model (including
the session that drafted the dataset and any reviewer model) can never fill a reviewer slot; `reviewerKind` must be
`HUMAN` and the validator rejects anything else. Do not sign on behalf of someone else.

## Before starting
- [ ] Owner assigned two distinct human reviewers (opaque refs `[A-Za-z0-9_-]{3,64}`, no names/emails in files).
- [ ] Reviewers work independently: neither sees the other's labels until both are recorded.
- [ ] Reviewers see only question + `hasFocus` + `../../intent-prompt.json` + `../RUBRIC.md`, not fixtures or draft labels
      while labelling: give them a blinded copy without `draftLabel`/`rationale`; the comparison happens afterwards.
- [ ] Dataset identity checked: `cli.ts verify` ok, `corpusSha256` noted from `../data/DATASET_MANIFEST.json`.
- [ ] Questions are never pasted into external tools or services.

## Refusal cases (`refusal-dual-review.jsonl`, 100 rows: RE-UNS-001…060, RE-ADV-001…040)
- [ ] Reviewer A fills `reviewerA` {reviewerKind:"HUMAN", reviewerRef, label, basis (rubric rule), reviewedAt UTC ISO}.
- [ ] Reviewer B fills `reviewerB` likewise, independently.
- [ ] Same label → `status:"AGREED"`; different → a human adjudicator records `adjudication`
      {reviewerKind:"HUMAN", reviewerRef, finalLabel, decidedAt} and `status:"ADJUDICATED"`.
- [ ] Any final label ≠ UNSUPPORTED blocks freeze: the case must be rewritten or replaced (new manifest, renewed review).
- [ ] Other-client cases are explicit from the question alone; adversarial cases keep only artificial secret markers.

## Supported cases (`supported-review.jsonl`, 100 rows)
- [ ] One human reviewer labels each case and records `basis`.
- [ ] The reviewer checks the case's fixture expectation for ALL five observed intents (`../data/fixtures.json`) against
      `../../../02_CONTRACTS.md` (Ask compiler matrix) and sets `fixturePredicatesReviewed:true`, `status:"REVIEWED"`.
- [ ] Label ≠ draft → dataset change, not an in-place edit.

## Freeze
- [ ] `validateRefusalReview` / `validateSupportedReview` report no issues and `humanAttestationComplete:true`.
- [ ] Manifest/receipt regenerated only if data changed; independent Sol/Opus acceptance of the exact frozen identity.
- [ ] Holdout = all 200: after anyone sees results, no prompt tuning and no relabelling of the same set as an independent eval.
