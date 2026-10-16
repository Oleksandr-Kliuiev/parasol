# Provider decision and current evidence

Checked 2026-10-10 against official documentation. No account access, API key, billable probe or customer transfer.
Owner rejected the initial GPT-4.1 mini proposal as too old. That proposal was never implemented or dispatched.

## Selection

| Candidate | Decision and workload fit |
|---|---|
| OpenAI GPT-6 Luna | SELECTED for the first remote adapter: current small model, none effort, closed JSON intent classification; known API ecosystem in this repo, with a separate key/project and independent adapter |
| Anthropic Claude Haiku5.5 | Current small alternative suited to classification/routing; not a fallback. A second adapter would add protocol/retention/account/eval scope before the first is validated |
| GPT-6.1 Sol / Claude Sonnet5.5 | Current larger alternatives for a later evidence-based escalation if the bounded semantic eval fails; no automatic model promotion |
| GPT-4.1 mini / GPT-5.6 Luna | Excluded from this new baseline in favor of the current generation; no legacy fallback |

This is an architectural choice, not a measured ranking. Only a separately admitted synthetic eval can demonstrate
quality/latency on Ask. Current account availability is unknown. No provider wins by self-identification or API pricing
alone. Fable architecture review is development work on the native Max subscription, distinct from product inference.

## Official source facts (bounded paraphrase)

[OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna): the current documented ID is gpt-6-luna;
it supports none effort, Chat Completions and structured outputs, with1,050,000 context. No dated snapshot is published.
[OpenAI pricing](https://developers.openai.com/api/docs/pricing): Standard short input/output US$0.10/0.50 per million;
long input/output0.20/0.75, cache-write0.25 long; applicable regional uplift10%. Rates are rechecked at admission.
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data): API content is not training data by
default; abuse retention can last30days with exceptions. Storefalse alone does not establish zero retention. EU
controls/ZDR need account eligibility and configuration; none is assumed from the hostname.
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): explicit mode without breakpoints
creates no prompt-cache writes. This request profile uses it; provider/account guarantees remain separately verified.
[Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create):
strict JSON-schema output, max_completion_tokens and explicit default service tier support this narrow wire contract.
[Anthropic current models](https://platform.claude.com/docs/en/models/overview): Haiku5.5 targets high-volume low-latency
classification/routing. The architecture selects one provider to keep the first admission and evaluation bounded.

Official pages differ on which nonstandard processing tiers support EU. This design requires Standard only and makes
no claim for Fast/Flex/Batch. Upstream options/response support and exact account controls remain R-EVAL prerequisites.
Exact ID/model response establishes API selection, not immutable weights or provider internal-routing attestation.

## Pricing interpretation

UI reservation US$0.30 is deliberately above the model's full-window conservative token bound, not a prediction that
one short question costs thirty cents. Successful verified usage releases unused reserve; unknown outcomes retain it.
Example conservative retained cost:1000 input +100 output →ceil((1000×275+100×825)/1000)=358 microUSD (US$0.000358).
Proposed US$2/day andUS$10/month cover this service's token accounting under its admitted price revision. They are not
payment authorization, a provider invoice cap, taxes or a guarantee about provider behavior. No charges incurred here.
