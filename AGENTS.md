# Parasol working agreements

- Target hosting is Hostinger VPS. Do not introduce Azure infrastructure or activate imported deployment workflows.
- Read `docs/AI_CONTEXT_MAP.md` and relevant module documentation before changing code.
- Preserve original import commits and `archive/*` refs. Never force-push or rewrite imported history.
- The nested source-project instructions and approval seals describe their historical development. The owner explicitly waived those historical model/review restrictions for this integration; do not reintroduce them as Parasol gates.
- Preserve unrelated local changes and source repositories. Changes belong in Parasol.
- Keep secrets out of Git, logs, fixtures and reports. Use synthetic data for CI.
- Keep independent concerns in cohesive files; aim near 500 lines and split before 700 where practical.
- Run the smallest relevant checks. For root tooling use `node --test scripts/*.test.mjs`; for builds/tests see README.
- Atlas acceptance is strict: every unit, PostgreSQL and browser test must pass, with no skips or failure allowlist. Historical manifests are immutable test inputs, not approval for current code.
- Ask before adding production dependencies, deploying, changing credentials or contacting people. Repository creation and the initial private push are already authorized for M01–M03.
