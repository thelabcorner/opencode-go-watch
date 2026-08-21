# OpenCode watcher source map

> Seed context, not cached truth. Re-fetch the live sources before every semantic-classifier update. This map was reviewed on 2026-08-21 and exists to tell an update agent **where to look and what each surface can establish**.

## Monitored sources: derive these from `wrangler.toml` first

Current configuration:

| Config variable | Current URL | Role in this watcher |
|---|---|---|
| `OPENCODE_GO_URL` | `https://opencode.ai/go` | Go landing-page chart: curated visible chart rows, effective 5-hour request presentation, promotion markers, finite/`∞` state, limited-time/region annotations. |
| `OPENCODE_DOCS_URL` | `https://opencode.ai/docs/go/` | Go documentation: model lists, request estimates, global dollar limits, request profiles, pricing variants, notes, endpoints/model IDs. |
| `OPENCODE_ZEN_DOCS_URL` | `https://opencode.ai/docs/zen/` | Zen documentation: endpoint/model-ID table, pricing variants, free-model notes, offers/policy text, deprecations. |
| `OPENCODE_ZEN_MODELS_URL` | `https://opencode.ai/zen/v1/models` | Zen availability truth: model IDs currently exposed by the Zen models API plus public metadata such as `owned_by`. |

If these values change in `wrangler.toml`, update this reference in the same PR. A repository regression test intentionally checks that every configured OpenCode scrape URL is represented here.

## Supporting source that is currently *reviewed*, not polled

### Go models API

`https://opencode.ai/zen/go/v1/models`

The Go docs explicitly advertise this endpoint as the full list of available Go models and metadata. It is extremely useful when an unclassified Go alert involves model identity, rollout, or availability.

It is **not currently one of the Worker's four configured scrape URLs**. Do not silently turn it into a fifth monitored source during a classifier hotfix; that is an architectural change with its own KV/fetch/failure-budget implications.

## Source authority by semantic dimension

### Go landing page

Use for what the chart actually claims:

- displayed model rows;
- effective chart request value;
- `∞` / `data-infinite` presentation;
- `data-model` routing identifier in the chart;
- explicit promo multiplier/bonus markup;
- limited-time and limited-regions annotations.

The landing page is a curated visualization, **not a complete Go availability catalog**. A model missing from the chart is not automatically removed from Go.

Current upstream implementation path:

`anomalyco/opencode:packages/console/app/src/routes/go/index.tsx`

Review this file when rendered HTML changes shape. It often reveals intent more reliably than reverse-engineering SSR markup from a tiny residual delta.

### Go docs

Use for documented Go economics and API routing:

- the current documented model list;
- 5-hour / weekly / monthly request estimates;
- `$12 / $30 / $60` global allowance text when current;
- observed request-profile assumptions;
- pricing rows and threshold/peak variants;
- usage-included amounts;
- endpoint, Model ID, and SDK tables;
- usage notes and policy wording.

Current upstream source path:

`anomalyco/opencode:packages/web/src/content/docs/go.mdx`

### Go models API

Use as supporting evidence for Go API availability and model IDs. It may contain models that are not in the curated landing chart or the prose model list.

This distinction matters: **chart membership, docs membership, and API availability are separate dimensions**.

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

Those observations support a Go routing-ID change and a distinct Zen routing ID. They do **not** support globally rewriting `x-preview-f-free` to `ox-alpha-free` everywhere.

This is the type of context an agent misses when it patches directly from a Telegram residual snippet.

## Important state lesson: `free` and `unlimited` are different dimensions

At the same review:

- Go renders Ox Alpha Free with `∞` and the Go docs use `- / - / -` request estimates plus `-` pricing cells and say it is free for a limited time.
- Zen documents several free models and the Zen API exposes their IDs, but those public Zen surfaces do not prove the private free-model rate-limit bucket behavior.

Therefore:

- Go may legitimately classify the **Go allowance presentation** as quota-exempt/unlimited.
- Zen may classify a model as **free**.
- Neither observation alone proves an absence of an independent request-rate limit.

Keep these dimensions separate in snapshot schemas, diffs, Telegram copy, and dashboards.

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

- Go chart markup/intent: `packages/console/app/src/routes/go/index.tsx`
- Go docs content: `packages/web/src/content/docs/go.mdx`
- Zen docs content: `packages/web/src/content/docs/zen.mdx`

Use the live page/API to establish what is deployed. Use the upstream source to understand the intended structure and identify stable signals. Do not assume `dev` source has already reached production.

## What to bring back into the implementation

After source review, the update agent should be able to state something like:

> "This is a generic transition in `<semantic dimension>` represented by `<stable signals>` and keyed by `<stable entity>`. I will parse that dimension directly, diff it generically, preserve `<nearby unknown payload>` in the residual monitor, and prove generalization with a second synthetic entity plus a negative control."

If the agent can only say:

> "When I see exactly this string/model/DOM fragment, suppress it or emit this card,"

then source review is not finished.
