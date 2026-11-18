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
- OpenCode Go accounts are routed like any other API provider. Go is not a free-tier provider, so all Go
  rows are candidates.
- The class is the requested one when the provider has a candidate for it. Otherwise the nearest class
  wins; on equal distance the stronger class wins (a missing `standard` is served by `heavy` before
  `light`).
- Within the chosen class the account's own model is preferred when it is listed there, otherwise the
  first row in table order.
- A provider without candidates (no tier data) keeps the account's configured model.

The result records the requested class, the class actually served and the source: `routed`, `account`
(configured model kept) or `cli_default`.

## In the app

- The composer has a class selector (Auto, Light, Standard, Heavy) and a model field next to the prompt.
  Auto sends no class, an empty model sends no model. The choice stays until you change it, and a change
  made while a turn runs applies to the next prompt. For an OpenCode API account the model field suggests
  that provider's table rows and the account's own model as `<provider>/<model>`; other accounts take free
  text.
- Every turn shows a badge under its prompt: the model that handled it and the class, for example
  `groq/openai/gpt-oss-20b · light`. A fallback reads `heavy → standard` (requested → served). A turn that
  was not routed reads `standard · not routed`, an explicit model `override` or `agent model`, and a
  subscription account `CLI default`.
- Settings has a "Default task class" that is the last layer above.
- The flow inspector sets a node's class; it is saved to the flow file.

## How a tier is assigned

For every provider except OpenCode Go, models are ranked within the provider by the output price the
provider publishes: the cheapest is `light`, the most expensive is `heavy`, anything in between is
`standard`. Providers with two models get `light` and `heavy` only. Only current, stable, tool-calling text
models that exist in the OpenCode 1.19.5 model snapshot are listed.

OpenCode Go is a flat-rate plan, so its rows are not ranked by token price but by how fast a model uses up
the plan's allowance. The measure is the "Est. requests / 5 hr" figure the Go page publishes for the $10
plan: under 500 is `heavy`, 500 to 2,999 is `standard`, 3,000 and more is `light`. The first row of each
class is its default (heavy: fewest requests; standard: the median model; light: most requests), and the
account's own model wins inside its class. Go Plus and Go Teams use the same rows (same models and ids,
higher limits).

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

## OpenCode Go table (checked 2026-11-18)

| Model id | Class | Est. requests / 5 h | In $/1M | Out $/1M | Source |
|---|---|---|---|---|---|
| kimi-k3 | heavy | 98 | 3 | 15 | https://opencode.ai/go |
| kimi-k3.1-pro | heavy | 147 | 2 | 10 | https://opencode.ai/go |
| qwen3.8-max | heavy | 162 | 2 | 6 | https://opencode.ai/go |
| grok-4.7 | heavy | 169 | 2 | 6 | https://opencode.ai/go |
| kimi-k2.7-code | standard | 994 | 0.95 | 4 | https://opencode.ai/go |
| glm-5.2 | standard | 792 | 1.40 | 4.40 | https://opencode.ai/go |
| gpt-5.6-luna | standard | 2,050 | 0.20 | 1.20 | https://opencode.ai/go |
| mimo-v2.6-flash | light | 30,100 | 0.14 | 0.28 | https://opencode.ai/go |
| longcat-2.0 | light | 11,400 | 0.30 | 1.20 | https://opencode.ai/go |
| glm-5.3-flash | light | 6,320 | 0.15 | 0.50 | https://opencode.ai/go |
| qwen3.8-flash | light | 5,400 | 0.15 | 0.47 | https://opencode.ai/go |
| qwen3.7-plus | light | 4,310 | 0.40 | 1.60 | https://opencode.ai/go |
| hy3 | light | 4,300 | 0.14 | 0.58 | https://opencode.ai/go |
| gpt-6-luna | light | 4,230 | 0.10 | 0.50 | https://opencode.ai/go |
| minimax-m3.1-flash | light | 3,880 | 0.15 | 0.60 | https://opencode.ai/go |
| claude-haiku-5-5 | light | 3,850 | 0.10 | 0.50 | https://opencode.ai/go |
| mimo-v2.6-pro | light | 3,260 | 0.435 | 0.87 | https://opencode.ai/go |
| minimax-m3 | light | 3,210 | 0.30 | 1.20 | https://opencode.ai/go |

Token prices are from https://opencode.ai/inference/go/v1/models.

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
- OpenCode Go `step-5-preview`, `hy4-preview`: previews.
- OpenCode Go `gemini-4-argon`: its 50% discount ends 2026-11-30.
- OpenCode Go `glm-5.3`: its raised limits end 2026-11-22.
- OpenCode Go `deepseek-v4-pro`, `deepseek-v4.1-flash`: need the Global region in the Console privacy
  settings.
- OpenCode Go `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`: need the training opt-in and are
  limited to some regions.
- OpenCode Go `beam-free`, `iceman-contributor-free`, `hy4-flash-free`, `longcat-2.5-free`: free for a
  limited time.
- OpenCode Go `qwen4-max`, `hy4`: not in the OpenCode 1.19.5 snapshot.
- OpenCode Go `mimo-v2.5`, `mimo-v2.5-pro`: in the snapshot, but no longer on the Go list.

Apart from the four models missing from the OpenCode 1.19.5 snapshot and the two that left the Go list,
the OpenCode Go models above stay usable as the account model or an explicit model.
