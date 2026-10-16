# Correction: the Claude Code reviews were incorrectly attributed to Fable

Date: 2026-10-08. Trigger: the owner questioned the provider used by the local Claude Code CLI.

## Finding

The root agent incorrectly treated the requested CLI model name and the generated review's self-identification as
proof that Claude Fable 5.1 performed the review. **That attribution is withdrawn.**
The available evidence indicates a DeepSeek-backed review through the Anthropic-compatible API, not a verified
Anthropic Fable invocation. The historical file names FABLE_RC1/RC2/RC3 are retained for traceability, with notices.

## Evidence actually checked

1. The shell environment used to launch Claude Code contains `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`.
   The review commands did not override/unset this variable. Other current model variables name deepseek-v4-pro
   and deepseek-v4-flash. Presence of a token was checked without printing or saving its value.
2. All three saved original CLI results have modelUsage keys `deepseek-v4-flash` and `claude-fable-5-1`.
   They also label the latter canonicalModel=claude-fable-5 and provider=firstParty. These client labels and estimated
   costs do not establish the actual upstream inference model, provider or bill.
3. A minimal direct diagnostic call to the configured HTTPS endpoint requested `model=claude-fable-5-1`.
   The API response was HTTP 200 with **`model=deepseek-flash`**. The prompt was only `Reply exactly OK.`;
   no repository content was sent in this diagnostic. Sanitized evidence: [PROVIDER_PROBE_2026-10-08.json](PROVIDER_PROBE_2026-10-08.json).
4. DeepSeek documents fallback from unsupported model names to deepseek-flash in its
   [Anthropic API compatibility guide](https://api-docs.deepseek.com/guides/anthropic_api/).
   Its [current API overview](https://api-docs.deepseek.com/) states that legacy Flash names are now served by
   DeepSeek-V4.1-Flash. Thus V4.1 Flash is the supported inference about the backing model, not the CLI's Fable label.

The exact upstream response model for each historical review request was not captured. Those sessions have no
available per-session debug logs at the standard paths, and no-session-persistence was used. Current routing plus
the documented and reproduced fallback explains the successful requests without proving an Anthropic invocation.
We therefore do not upgrade inferred historical model/version to independently captured response provenance.
CLI auth status also used generic firstParty/login labels; these do not override an explicitly configured API URL.

## Consequence

- Required Fable 5.1 approval is **NOT VERIFIED / PENDING**.
- Astra RC3 approval remains documented under its explicit Codex subagent dispatch.
- The external CLI review remains useful supplemental feedback, with corrected DeepSeek attribution and the stated
  historical model-evidence limit. Its findings/fixes are not discarded.
- **S2-ARCH is reopened.** The previous ACCEPTED status was based on an invalid reviewer attribution.
- Normative RC3 files and their hash are unchanged; no application code, credentials, CLI configuration or account was changed.

## Rule for the replacement Fable review

Before sending the package, verify the actual provider endpoint and credential source. Confirm a server-reported
model identity through an authenticated Anthropic route (or a demonstrably Fable-serving provider), not a prompt
asking the model who it is. Record requested model, provider route and response model with secrets excluded.
If they disagree, mark the requested reviewer unavailable rather than silently accepting fallback.
Then obtain a genuine Fable verdict against the unchanged RC3 package hash and update REVIEW_STATUS.
