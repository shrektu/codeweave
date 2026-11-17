# Model routing by task class

A task class (`light`, `standard`, `heavy`) says how demanding a piece of work is. For an OpenCode API
account Codeweave turns the class into a concrete model; every other account keeps its CLI default.

## How a class is chosen

The first layer that sets a class wins:

1. the prompt
2. the flow node (`taskClass` on a node in `flows/*.md`)
3. the agent (`taskClass` in `agents/*.md`)
4. the settings default, `standard`

Agent files and flow nodes accept only `light`, `standard` and `heavy`. Any other value is rejected with
`Task class must be one of: light, standard, heavy`.

## How a model is selected

Applies to OpenCode accounts that use an API provider (`routeByClass` in `src/domain/routing.ts`):

- Subscription accounts (Claude, Codex, Gemini) are not routed: the CLI default model is used.
- Candidates are the rows of the table below for the account's API provider.
- On a free-tier provider whose free models are marked (Z.ai here), only rows marked free are candidates.
  A paid model is never picked.
- The class is the requested one when the provider has a candidate for it. Otherwise the nearest class
  wins; on equal distance the stronger class wins (a missing `standard` is served by `heavy` before
  `light`).
- Within the chosen class the account's own model is preferred when it is listed there, otherwise the
  first row in table order.
- A provider without candidates (no tier data) keeps the account's configured model.

The result records the requested class, the class actually served and the source: `routed`, `account`
(configured model kept) or `cli_default`.

## How a tier is assigned

Within one provider, models are ranked by the output price the provider publishes: the cheapest is
`light`, the most expensive is `heavy`, anything in between is `standard`. Providers with two models get
`light` and `heavy` only. Only current, stable, tool-calling text models that exist in the OpenCode 1.19.5
model snapshot are listed.

## Table (checked 2026-11-17)

| Provider | Model id | Class | Free | In $/1M | Out $/1M | Source |
|---|---|---|---|---|---|---|
| groq | openai/gpt-oss-20b | light | yes | 0.075 | 0.30 | https://console.groq.com/docs/models |
| groq | openai/gpt-oss-120b | heavy | yes | 0.15 | 0.60 | https://console.groq.com/docs/models |
| cerebras | gpt-oss-120b | light | yes | 0.35 | 0.75 | https://inference-docs.cerebras.ai/models/openai-oss |
| cerebras | qwen-3.8-27b | heavy | yes | 0.99 | 1.49 | https://inference-docs.cerebras.ai/models/qwen-3.8-27b |
| google | gemini-3.5-flash-lite | light | yes | 0.30 | 2.50 | https://aistudio.google.com/docs/pricing |
| google | gemini-3.8-flash | heavy | yes | 0.75 | 3.75 | https://aistudio.google.com/docs/pricing |
| mistral | ministral-8b-2512 | light | no | 0.15 | 0.15 | https://docs.mistral.ai/inference/pricing |
| mistral | mistral-small-2603 | standard | no | 0.15 | 0.60 | https://docs.mistral.ai/inference/pricing |
| mistral | mistral-large-4 | heavy | no | 0.70 | 2.10 | https://docs.mistral.ai/inference/pricing |
| zai | glm-4.7-flash | light | yes | 0 | 0 | https://docs.z.ai/guides/overview/pricing |
| zai | glm-5.3-flash | light | no | 0.15 | 0.50 | https://docs.z.ai/guides/overview/pricing |
| zai | glm-5.3-flashx | standard | no | 0.37 | 1.25 | https://docs.z.ai/guides/overview/pricing |
| zai | glm-5.3 | heavy | no | 1.40 | 4.40 | https://docs.z.ai/guides/overview/pricing |
| deepseek | deepseek-flash | light | no | 0.30 | 1.20 | https://api-docs.deepseek.com/quick_start/pricing |
| deepseek | deepseek-v4-pro | heavy | no | 1.32 | 3.96 | https://api-docs.deepseek.com/quick_start/pricing |

Prices are the peak-rate list prices. Google announces higher `gemini-3.8-flash` prices (1.50 in, 7.50 out)
from 2027-01-01; DeepSeek halves its prices off-peak.

## Excluded

These providers have no rows, so their accounts keep the configured model:

- Kimi (moonshotai): the pricing page https://platform.kimi.ai/docs/pricing/chat renders empty price
  tables, so there is nothing to rank.
- OpenRouter: the free model list changes weekly (the current list says "Going away November 28, 2026").
- Custom endpoints: the models are the user's own.

Left out of the table on purpose:

- Gemini 4 models (`gemini-4-hydrogen`, `gemini-4-carbon`): on Google's pricing page but missing from the
  OpenCode 1.19.5 snapshot.
- Groq `qwen/qwen3.8-27b`: preview, "for evaluation purposes only".
