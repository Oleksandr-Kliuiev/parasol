# R-EVAL offline package — context routing

Offline preparation artifact for ASK-REMOTE R-EVAL (plan `../S5ASKREMOTE_REVAL_PLAN.md` RC6). Status: DRAFT labels,
HUMAN_ATTESTATION_PENDING, data/budget NOT_ADMITTED, paid provider calls 0. Nothing here authorizes a live run.

Read `README.md` first (procedure, commands, interpretation, residuals), then only what the task needs:
`RUBRIC.md` (labelling rules), `adjudication/HUMAN_REVIEW_CHECKLIST.md` (human reviewers), `IMPLEMENTATION_REPORT.md`.

Do NOT load whole data or evidence files into a prompt:
- `data/*.jsonl` — 200 frozen synthetic cases (holdout: ALL 200; never tune the prompt against them). Query one case with
  `node -e` / `rg '"caseId":"RE-SUM-001"'`; see `data/AGENTS.md`.
- `data/fixtures.json` — 11 source fixtures with declared expectations; open one fixture by `fixtureId`.
- `rehearsal/OFFLINE_REHEARSAL_RECEIPT.json` — generated receipt (~2000 lines); read the top-level summary keys only.
- `adjudication/*.jsonl` — empty PENDING review templates; only humans fill them, never a model.

Code: `scripts/ask-remote-eval/` (see its `AGENTS.md`); tests `tests/ask-remote-eval-*.test.ts`.
Changing any data/fixture byte changes the manifest identity and requires renewed independent acceptance.
