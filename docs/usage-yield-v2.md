# Usage Yield V2

## Goal

Usage Yield V2 answers one question:

> Which model gives the most comparable coding-agent usage for the money?

The watcher no longer treats a low headline token price as sufficient evidence of good value. Paid models are evaluated against the same standardized coding-agent workload corpus derived from OpenCode Go's published observed request profiles.

## Core metric

For a standardized workload `w` and applicable pricing row `p`:

```text
cost(w,p) =
  fresh_input_tokens * input_price
+ cached_read_tokens * cached_read_price
+ output_tokens * output_price
```

Prices are per 1M tokens, so the result is divided by 1,000,000.

The primary Zen paid-model metric is:

```text
equivalent requests per $1 = 1 / standardized request cost
```

Higher is better.

For Go, the primary model-value metric additionally accounts for the model-specific effective included usage published by OpenCode:

```text
Go monthly equivalent requests = model included usage USD / standardized request cost
```

This means Go ranking measures how much standardized work the actual subscription can buy through each model, not merely public token rates.

## Shared workload corpus

The corpus is derived from `docs.profiles` parsed from OpenCode Go documentation.

Each workload contains:

- fresh input tokens
- cached-read tokens
- output tokens
- input context (`fresh + cached`)

Exact duplicate workload tuples are deduplicated so sibling models sharing one published profile do not overweight that shape.

The paid-model score uses the median cost across the full standardized workload corpus. Light / Typical / Heavy diagnostics are derived from context-size quartiles.

## Pricing semantics

### Context thresholds

Variants such as `≤ 256K tokens` and `> 256K tokens` are selected according to the standardized workload's actual input context. V2 never ranks a tiered model by blindly taking its cheapest published row.

### Peak / off-peak

When OpenCode publishes both Peak and Off-Peak rows and a parseable schedule, V2 computes a time-weighted expected cost. The current DeepSeek schedule is 01:00-04:00 and 06:00-10:00 UTC Monday-Friday, which is 35 peak hours in a 168-hour week.

Best-case and worst-case regime values are retained for presentation.

### Unknown variants

Unknown pricing variants lower confidence. The engine prefers explicit uncertainty over silently treating an unfamiliar label as a known regime.

## Free and quota-exempt semantics

Free is not synonymous with unlimited.

V2 distinguishes:

- `quota-exempt`: Go explicitly presents an allowance as infinite/outside the Go dollar quota
- `free-limited-known`: free with a comparable published capacity
- `free-limited-unknown`: free, but public sources do not establish a comparable capacity
- `paid`
- `unranked`: insufficient evidence

Zen free models are not assigned fake infinite requests-per-dollar. Unless public capacity is established, they are shown as free with unknown comparable capacity.

## Ranking semantics

Paid models are ranked using deterministic competition ranking. Exact score ties share the same rank.

Every ranked entry also exposes:

- fraction of the best paid value
- cost multiple versus the best paid value
- percentile
- standardized cost/request
- standardized requests/$
- Light / Typical / Heavy yield
- applicable time/context regimes
- confidence and warnings

Rank is derived state and is recomputed whenever model pricing, model membership, relevant pricing regimes, or the Go workload corpus changes.

## Notification policy

Cost-related Telegram notifications show the affected model's current V2 rank and value.

The watcher does **not** emit one alert for every model whose ordinal rank moves because another model changed price. This avoids rank-cascade spam. The full dashboard is the canonical live leaderboard.

Request-profile changes explicitly indicate that the shared workload calibration changed and therefore all paid ranks were recomputed.

## Source authority

The Usage Yield engine consumes the watcher's parsed semantic snapshots rather than scraping sources independently.

Current source roles:

- Go docs: observed request profiles, model pricing, pricing variants, included usage, request estimates, pricing-regime notes
- Go landing chart: Go allowance presentation including quota-exempt/infinite state and promotions
- Zen docs: Zen pricing/free status and pricing variants
- Zen models API: Zen availability

The semantic-source-review protocol remains mandatory before changing scrape interpretation.

## Failure policy

V2 must fail conservatively:

- missing fresh-input or output pricing makes a paid workload unpriceable
- cached-read pricing is required when the standardized workload contains cached tokens unless the source explicitly establishes zero cost
- malformed/unknown pricing regimes are not silently interpreted as the cheapest tier
- no division-by-zero is used to rank free models
- no new external network dependency is added to the hot ranking path

## Compatibility

`src/cost-ranking.js` remains as a compatibility facade while existing imports migrate. New implementation should prefer `src/usage-yield.js`.
