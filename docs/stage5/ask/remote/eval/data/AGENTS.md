# R-EVAL frozen synthetic data — handling rules

This directory is the frozen synthetic dataset, stored separately from runtime evidence. Do not load the JSONL files
wholesale into model context; look up single cases by ID. Never paste these questions into any external service.

- One case per line: `caseId, group, category, language, fixtureId, hasFocus, question, expectedIntent, rationale,
  labelStatus (DRAFT_MODEL_ASSISTED), attestation (HUMAN_ATTESTATION_PENDING)`. Files ≤500 lines.
- `cases-supported-*.jsonl` 4×25, `cases-unsupported.jsonl` 60, `cases-adversarial.jsonl` 40 (case IDs RE-SUM/URG/SRC/ENT/UNS/ADV-NNN).
- `fixtures.json` — source scenarios and hand-declared expectations for all five observed intents.
- `DATASET_MANIFEST.json` — file SHA-256 values, counts, order seed/hash. Regenerate ONLY with
  `node --experimental-strip-types scripts/ask-remote-eval/cli.ts write-manifest` after an intended, reviewed change.

Every identifier, label and secret-looking marker is synthetic (`syn-*`, `SYNTH-*`, `NOT-REAL`). No real customer, person,
tenant, email, phone or credential may be added. Labels are drafts: they become frozen expectations only after the
human review in `../adjudication/` and independent acceptance.
