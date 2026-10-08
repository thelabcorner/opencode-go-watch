# OpenCode watcher source map

> Seed context, not cached truth. Re-fetch the live sources before every semantic-classifier update. This map was re-reviewed on 2026-10-08 and exists to tell an update agent **where to look and what each surface can establish**.

## Monitored sources: derive these from `wrangler.toml` first

Current configuration:

| Config variable | Current URL | Role in this watcher |
|---|---|---|
| `OPENCODE_GO_URL` | `https://opencode.ai/go` | Go landing-page usage table: curated visible rows, effective 5-hour request presentation, monthly-usage display, promotion markers, finite/`∞` state, limited-time/region annotations. |
| `OPENCODE_DOCS_URL` | `https://opencode.ai/docs/go/` | Go documentation: model lists, request estimates, per-model monthly limits, request profiles, pricing variants, notes, endpoints/model IDs. |
| `OPENCODE_GO_MODELS_URL` | `https://opencode.ai/zen/go/v1/models` | Go API availability truth: the full model-ID catalog advertised by the Go docs plus stable public model metadata. Volatile per-request `created` timestamps are not semantic state. |
| `OPENCODE_ZEN_DOCS_URL` | `https://opencode.ai/docs/zen/` | Zen documentation: endpoint/model-ID table, pricing variants, free-model notes, offers/policy text, deprecations. |
| `OPENCODE_ZEN_MODELS_URL` | `https://opencode.ai/zen/v1/models` | Zen availability truth: model IDs currently exposed by the Zen models API plus public metadata such as `owned_by`. |

If these values change in `wrangler.toml`, update this reference in the same PR. A repository regression test intentionally checks that every configured OpenCode scrape URL is represented here.

## Source authority by semantic dimension

### Go landing page

Use for what the chart actually claims:

- displayed model rows;
- effective chart request value;
- promotion baseline request value when the chart renders a struck-through base;
- effective monthly usage/allowance and its struck-through promotion baseline;
- `∞` / `data-infinite` presentation;
- `data-model` chart-row identifier (do **not** assume this equals the Go API routing ID);
- explicit promo multiplier/bonus markup;
- limited-time and limited-regions annotations, including the region-policy target.

The landing page is a curated visualization, **not a complete Go availability catalog**. A model missing from the chart is not automatically removed from Go.

Current upstream implementation paths:

- `anomalyco/opencode:packages/console/app/src/routes/go/index.tsx`
- `anomalyco/opencode:packages/console/app/src/component/limits-graph.tsx`
- `anomalyco/opencode:packages/console/app/src/component/go-models.ts`

As of 2026-10-08, the deployed landing-page comparison uses `data-component="go-plan-chart"` with two explicit plan tiers (`data-tier="go"`, `data-tier="plus"`). Each model is a table row with `<th scope="row"><bdi>Model</bdi>` and two `data-slot="number"` cells: Go/Go Plus requests per five hours, then Go/Go Plus monthly dollar allowance. Values within each cell follow the legend's Go-first, Plus-second order. A label-level **Limited Regions** link carries the regional policy URL. The first 13 curated rows are rendered into SSR; the "View all" control indicates more models, so this is not an exhaustive availability list. Historical `go-usage`, `limit-graph` and `data-item` markup remain supported for baseline compatibility.

The September 2026 observation that all rows were finite is obsolete. In the October 8 deployed chart and docs, LongCat 2.5 Preview Free and Step 5 Preview Free have explicit `∞` / `Unlimited` allowance evidence, while other entries have finite numeric limits. Preserve explicit finite/unlimited/unknown distinctions independently for **each plan**. Blank/dash does not establish infinity; contradictory request and allowance signals fail closed.

The current/base allowance distinction must propagate into downstream Usage Yield semantics. If the chart publishes an effective monthly allowance, treat that as direct current-capacity evidence and do not multiply it by the promotion badge again. A struck-through base allowance may establish the pre-promotion baseline. If monthly allowance is absent, retain the conservative historical rule: a chart promotion changes current 5-hour capacity only; do not infer monthly promotion coverage.

Review these files when rendered HTML changes shape. They often reveal intent more reliably than reverse-engineering SSR markup from a tiny residual delta.

### Go docs

Use for documented Go economics and API routing:

- the current documented model list;
- 5-hour / weekly / monthly request estimates;
- the documented 5-hour / weekly / monthly allowance relationship and example dollar amounts;
- observed request-profile assumptions;
- pricing rows and threshold/peak variants;
- per-model monthly limits / included usage (currently the `Monthly limit` pricing column);
- separate Go and Go Plus request/pricing tables (both tier tabs render in the same SSR document; do not discard the second one);
- endpoint, Model ID, and SDK tables;
- usage notes and policy wording.

Temporary promotion annotations nested in a request-table model cell (for example a multiplier plus an end date) are metadata about that row, **not part of the stable model identity**. Keep the request/profile/pricing/chart entity keyed to the underlying model name and represent the promotion through its semantic fields.

Likewise, the landing page's `data-model` value belongs to the chart namespace. As of this review, `DeepSeek V4.1 Flash` demonstrates that it can differ from the documented/API model ID. Track it as a chart identifier and use the docs/models API—not the landing attribute—for API routing identity.

Current upstream source path:

`anomalyco/opencode:packages/web/src/content/docs/go.mdx`

### Go models API

`https://opencode.ai/zen/go/v1/models`

Use as the primary public availability surface for Go model IDs. The Go docs explicitly advertise this endpoint as the full list of available models and metadata, and the upstream route currently builds it from `ZenData.list("lite").models`.

The API may contain models that are not in the curated landing chart or prose model list. This is expected source coverage, not automatically an inconsistency: **chart membership, docs membership, and API availability are separate dimensions**.

The upstream models response currently stamps each item with `created: Math.floor(Date.now() / 1000)` at request time. That value is transport noise. The watcher must canonicalize the API before fingerprinting so a new timestamp alone never produces work or an alert. Stable known fields such as `id`, `object`, and `owned_by` are semantic; unfamiliar stable fields remain covered by the API residual monitor.

Current upstream implementation paths:

- `anomalyco/opencode:packages/console/app/src/routes/zen/go/v1/models.ts`
- `anomalyco/opencode:packages/console/app/src/routes/zen/util/modelsHandler.ts`

### Zen models API

`https://opencode.ai/zen/v1/models`

Use as the primary public availability surface for Zen. The current watcher deliberately treats API IDs as authoritative availability and the docs as enrichment.

The API can lead the docs. An API-only model is therefore not automatically parser noise; it may be a rollout/docs-lag state that deserves explicit consistency semantics.

### Zen docs

Use for:

- display names and Zen Model IDs;
- endpoint/SDK routing;
- numeric pricing and pricing variants;
- explicit `Free` pricing;
- free-model descriptive notes;
- promotions/discount wording;
- deprecations;
- operational/policy notes.

Current upstream source path:

`anomalyco/opencode:packages/web/src/content/docs/zen.mdx`

### `https://opencode.ai/zen/`

Do not use this as classifier evidence by default. It is not part of the current monitored-source architecture and does not currently expose the structured information this watcher tracks.

## Important cross-namespace lesson: same model name does not imply same model ID

At the 2026-08-21 review, **Ox Alpha Free** demonstrated why every alert must be scoped to its product/source namespace:

- Go landing chart: `data-model="ox-alpha-free"` and `∞`.
- Go docs endpoint table: Model ID `ox-alpha-free`.
- Go models API: ID `ox-alpha-free`.
- Zen docs endpoint table: Model ID `x-preview-f-free`.
- Zen models API: ID `x-preview-f-free`.

The Go docs/models API observations support a Go routing-ID change, while the Zen docs/API establish the distinct Zen routing ID. The landing `data-model` value is corroborating chart state, not routing authority by itself. These observations do **not** support globally rewriting `x-preview-f-free` to `ox-alpha-free` everywhere.

This is the type of context an agent misses when it patches directly from a Telegram residual snippet.

## Important state lesson: `free`, quota exemption, and unknown evidence are different dimensions

At the 2026-08-21 historical review:

- Go rendered Ox Alpha Free with explicit `∞`; the Go docs used `- / - / -` request estimates plus `-` pricing cells and separately said it was free for a limited time.
- Zen documents several free models and the Zen API exposes their IDs, but those public Zen surfaces do not prove the private free-model rate-limit bucket behavior.

The 2026-09-19 re-review sharpens the evidence rule:

- Explicit `∞` was affirmative evidence for the **Go allowance presentation** being quota-exempt. The docs dashes were not independent proof of infinity; they were merely missing numeric request estimates.
- Three blank/dash request cells now map to `unknown`, not unlimited. Unknown values must not become `∞` simply because parsing failed to recover numbers.
- A stored legacy `unlimited: true` boolean without evidence provenance is not sufficient to satisfy the modern unlimited evidence gate.
- If one source is explicitly finite and another explicitly says `∞`, preserve a conflict and refuse to rank/classify the model as quota-exempt until the sources converge.
- Zen may classify a model as **free**.
- Go quota exemption does not imply `free`; neither observation proves absence of an independent provider/API request-rate limit.

Keep `limitState` (`finite | unlimited | unknown`), evidence provenance, free/paid state, and source consistency separate in snapshot schemas, diffs, Telegram copy, ranking, and dashboards.

## Important coverage lesson: curated docs/chart versus API catalog

The Go models API currently exposes entries beyond the curated Go landing chart. The Zen models API can likewise expose IDs that are missing from the current Zen docs tables/free prose.

Do not respond to that pattern by making a parser demand exact set equality. Prefer explicit source-coverage/consistency states.

When investigating an unclassified model event, ask separately:

1. Is the model visible on the curated chart?
2. Is it documented?
3. Is it present in the product's models API?
4. Is it free/paid according to public pricing/docs?
5. What routing ID is valid in this namespace?

## Upstream-source review protocol

When public upstream source is available, inspect it after the live surface and before writing a classifier:

- Go landing markup/intent: `packages/console/app/src/routes/go/index.tsx`, `packages/console/app/src/component/limits-graph.tsx`, and `packages/console/app/src/component/go-models.ts`
- Go docs content: `packages/web/src/content/docs/go.mdx`
- Go API route: `packages/console/app/src/routes/zen/go/v1/models.ts`
- shared models response builder: `packages/console/app/src/routes/zen/util/modelsHandler.ts`
- Zen docs content: `packages/web/src/content/docs/zen.mdx`

Use the live page/API to establish what is deployed. Use the upstream source to understand the intended structure and identify stable signals. Do not assume `dev` source has already reached production.

## What to bring back into the implementation

After source review, the update agent should be able to state something like:

> "This is a generic transition in `<semantic dimension>` represented by `<stable signals>` and keyed by `<stable entity>`. I will parse that dimension directly, diff it generically, preserve `<nearby unknown payload>` in the residual monitor, and prove generalization with a second synthetic entity plus a negative control."

If the agent can only say:

> "When I see exactly this string/model/DOM fragment, suppress it or emit this card,"

then source review is not finished.
