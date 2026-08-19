# OpenCode Go Watch

A zero-server Cloudflare Worker that watches the **OpenCode Go usage chart** and the **OpenCode Go usage-limit documentation**, computes semantic diffs, and sends rich Telegram alerts only when something meaningful changes.

Instead of treating a webpage as an opaque blob, the watcher understands the things you actually care about: models, request limits, pricing, request profiles, promotions, global subscription allowances, documentation notes, and chart/docs consistency. If the monitored surface changes in a way the semantic parser does **not** understand yet, a second fallback layer still surfaces the unexplained change.

## What it watches

### `https://opencode.ai/go`

The Go landing-page chart is parsed into model-level semantic data:

- model added to / removed from the chart
- effective requests per 5-hour window
- promotion multiplier / bonus, such as `8x usage`
- promotion-banner changes
- unexplained chart-vs-docs request-count mismatches
- newly introduced chart structure, attributes, or text that the semantic parser does not yet classify

### `https://opencode.ai/docs/go/`

The `Usage limits` documentation section is parsed into:

- model additions and removals
- 5-hour request estimates
- weekly request estimates
- monthly request estimates
- global 5-hour / weekly / monthly dollar allowances
- typical request-profile assumptions:
  - input tokens per request
  - cached tokens per request
  - output tokens per request
- pricing rows:
  - input price / 1M tokens
  - output price / 1M tokens
  - cached-read price / 1M tokens
  - cached-write price / 1M tokens
  - included-usage value
- tracked usage notes such as DeepSeek peak-hour wording and the limits disclaimer
- other meaningful wording changes inside the Usage Limits section
- newly introduced structure or attributes that the semantic parser does not yet classify

It deliberately does **not** hash the whole page. Navigation, CSS, unrelated marketing sections, deployment chunk names, analytics, and ordinary presentation churn do not become Telegram noise.

## Semantic change vocabulary

The diff engine currently recognizes these semantic event classes:

| Category | Detected change | Telegram treatment |
| --- | --- | --- |
| Model lifecycle | model added / removed from request table | rich `NEW MODEL` / `MODEL REMOVED` card |
| Request limits | 5-hour / weekly / monthly request estimate changed | grouped per-model delta card with percentage |
| Subscription allowance | global 5-hour / weekly / monthly dollar limit changed | grouped allowance card |
| Request profile | profile added / removed / input-cached-output assumption changed | request-profile card |
| Pricing | row added / removed / field changed | pricing card with dollar delta + percentage |
| Go chart | chart model added / removed | chart lifecycle card |
| Go chart | effective 5-hour count changed | chart delta card |
| Promotion | model bonus / multiplier changed | usage-update card |
| Promotion | promotion banner changed | before / after banner card |
| Cross-check | chart and docs unexpectedly disagree | warning card |
| Cross-check | a previous mismatch resolves | recovery-style consistency card |
| Usage notes | tracked note added / removed / changed | before / after note card |
| Usage copy | other meaningful Usage Limits wording changed | compact before / after text delta |
| Unknown semantic | monitored source changed but known fields did not | `UNCLASSIFIED MONITORED CHANGE` with residual before / after structure |
| Operational | fetch / parse / validation failure | immediate error card; good baseline preserved |
| Operational | watcher becomes healthy again | recovery card |

Model lifecycle changes are **coalesced**. For example, if a launch adds the request-table row, pricing row, request profile, and chart entry at once, Telegram gets one model-centric launch card instead of four separate notifications.

## What Telegram alerts look like

The examples below use illustrative values, but the formatting mirrors the actual renderer.

### New model

A launch is collapsed into one rich card containing every related piece of information the watcher knows:

```text
🆕 OPENCODE GO · NEW MODEL
━━━━━━━━━━━━━━━━━━━━
4 semantic field changes · 1 update card

🆕 MODEL ADDED
Example Model

5 hour   2,050
week     5,100
month   10,250

📈 Go chart  2,050 / 5h
🧠 Typical request  in 20,000 · cached 50,000 · out 8,000

💰 Pricing / 1M tokens
• in $0.40 · cache $0.10 · out $1.20 · usage $15

🕒 Aug 19, 2026, 3:20 PM CDT
🔎 Go chart + usage docs
```

### Request-limit change

All changed windows for one model are grouped together:

```text
🚨 OPENCODE GO WATCH
━━━━━━━━━━━━━━━━━━━━
3 semantic field changes · 1 update card

📊 REQUEST LIMIT CHANGED
GPT 5.6 Luna
5 hour   2,050 → 2,300  ▲ +12.2%
Weekly   5,100 → 5,750  ▲ +12.7%
Monthly 10,250 → 11,500 ▲ +12.2%

🕒 Aug 19, 2026, 3:30 PM CDT
🔎 Go chart + usage docs
```

### Pricing change

```text
💰 OPENCODE GO · PRICING UPDATE
━━━━━━━━━━━━━━━━━━━━
2 semantic field changes · 1 update card

💰 PRICING CHANGED
Example Model
Input / 1M: $0.27 → $0.22 ▼ -18.5%
Output / 1M: $1.10 → $0.90 ▼ -18.2%

🕒 Aug 19, 2026, 3:35 PM CDT
🔎 Go chart + usage docs
```

### Promotion / chart change

```text
🎁 OPENCODE GO · USAGE UPDATE
━━━━━━━━━━━━━━━━━━━━
2 semantic field changes · 1 update card

📈 GO CHART CHANGED
Hy3
5 hour: 4,300 → 34,400 ▲ +700.0%
Promotion: none → 8x usage

🕒 Aug 19, 2026, 3:45 PM CDT
🔎 Go chart + usage docs
```

### Global subscription allowance change

```text
🚨 OPENCODE GO WATCH
━━━━━━━━━━━━━━━━━━━━
2 semantic field changes · 1 update card

💳 SUBSCRIPTION ALLOWANCE CHANGED
5 hour: $12 → $15 ▲ +25.0%
Weekly: $30 → $35 ▲ +16.7%

🕒 Aug 19, 2026, 3:50 PM CDT
🔎 Go chart + usage docs
```

### Chart / docs mismatch

If the chart and documentation disagree and the difference cannot be explained by a recognized promotion:

```text
⚠️ CHART / DOCS MISMATCH
Example Model
chart 8,600 · docs 4,300
```

When the disagreement disappears:

```text
✅ CHART / DOCS MISMATCH RESOLVED
Example Model
```

### Usage wording or note change

```text
📝 USAGE SECTION WORDING CHANGED
Before  old relevant wording…
After   new relevant wording…
```

Tracked note changes use their own label, for example:

```text
🕒 DeepSeek peak hours changed
old wording…
↓
new wording…
```

### Unknown / unclassified monitored change

This is the fallback for **“the page definitely changed, but our semantic model does not know what the new thing means yet.”**

The watcher keeps a noise-normalized residual representation of each monitored surface. Presentation-only noise such as classes, styles, hydration metadata, comments, and SVG geometry is stripped, while unfamiliar attributes, text, links, and structure remain visible.

For example, if OpenCode introduced an unknown field such as:

```html
<span data-item data-model="hy3" data-context-window="1m">
```

without changing any known request-count or promotion field, Telegram would still alert:

```text
🟡 OPENCODE GO · UNCLASSIFIED CHANGE
━━━━━━━━━━━━━━━━━━━━
1 semantic field change · 1 update card

🟡 UNCLASSIFIED MONITORED CHANGE
Go usage chart
The monitored surface changed, but all semantic fields the
watcher currently knows about stayed the same.

Before  <span data-item data-model="hy3">
After   <span data-context-window="1m" data-item data-model="hy3">

🕒 Aug 19, 2026, 4:00 PM CDT
🔎 Go chart + usage docs
```

This closes the important blind spot where a parser can still succeed while OpenCode introduces a brand-new concept the watcher has never seen before.

### Degraded watcher

Parser/fetch failures are operational alerts, not fake semantic removals. The previous known-good baseline is retained:

```text
🔴 OPENCODE GO WATCH · ERROR
━━━━━━━━━━━━━━━━━━━━
A monitoring run failed. The previous semantic baseline was preserved,
so no false removals will be recorded.

Snapshot validation failed: chart parser found 2 models;
refusing baseline update

🕒 Aug 19, 2026, 4:05 PM CDT
```

Repeated identical failures are deduplicated rather than sent every five minutes.

When the watcher becomes healthy again:

```text
✅ OPENCODE GO WATCH · RECOVERED
━━━━━━━━━━━━━━━━━━━━
Both monitored surfaces parsed successfully again.

Last error
Snapshot validation failed: chart parser found 2 models;
refusing baseline update

🕒 Aug 19, 2026, 4:10 PM CDT
```

### First baseline / manual health check

The first successful baseline produces an `ARMED` card with model counts, subscription allowances, active recognized promotions, and chart/docs cross-check status. A forced `/check/notify` uses the same compact status layout as a manual check.

## Telegram anti-spam behavior

The bot is intentionally quiet in steady state:

- unchanged checks send **nothing**
- related lifecycle changes are coalesced into one model card
- all changed fields of the same request/pricing/profile/chart object are grouped together
- one polling run produces as few messages as possible
- messages are split only when the rendered Telegram payload would exceed the ~3,850-character safety limit
- repeated identical operational errors are deduplicated
- a Telegram delivery failure does **not** advance the semantic baseline, so the same real change is retried later instead of being lost

The watcher currently coalesces changes within a polling run. Separate real changes published across separate five-minute snapshots can still produce separate notifications.

## Architecture

```text
Cloudflare Cron (*/5 min)
        |
        v
 read tiny hot state from KV
        |
        v
 conditional fetches (ETag / Last-Modified)
        |
        +---- 304 / same ETag ----> unchanged; no body decode, parser, snapshot read, or diff
        |
        v
 watched-region SHA-256
        |
        +---- same fingerprint ---> unchanged; no semantic parser or diff
        |
        v
 parse only changed surface(s)
        |
        +---- parse/fetch failure ---> preserve baseline + Telegram operational alert
        |
        v
 read full semantic baseline + validate transition
        |
        v
 semantic diff
        |
        +---- known semantic change ---> rich coalesced Telegram alert
        |
        +---- no known semantic change
        |           |
        |           v
        |    normalized residual diff
        |           |
        |           +---- residual changed ---> UNCLASSIFIED MONITORED CHANGE
        |           |
        |           +---- residual same ------> harmless presentation/markup churn
        |
        v
 persist semantic baseline + hot state only after successful notification
```

## Hot-path optimization

The steady-state path is designed specifically around Cloudflare Free's tight CPU budget:

1. A dedicated KV hot record stores only source validators and fingerprints. Normal five-minute checks do **not** read the larger semantic snapshot.
2. Requests send `If-None-Match` or `If-Modified-Since`. A `304 Not Modified` reuses the baseline with **zero response-body decoding, HTML parsing, validation walking, or semantic diffing**.
3. If a CDN returns `200` with the exact same ETag, the response body is cancelled immediately and treated as unchanged.
4. If the origin provides no useful validator, only the monitored regions are extracted and hashed with native `crypto.subtle` SHA-256. An identical fingerprint skips the semantic parsers and diff engine.
5. If only one surface changes, only that surface is parsed; the unchanged Go/docs half is reused directly.
6. The Go parser scans the graph figure instead of the whole landing page. The docs parser slices directly to `#usage-limits` before table/text parsing.
7. Stable runs do not rewrite the large semantic snapshot. Raw validator churn with identical monitored content updates only the tiny hot record. Operational heartbeat metadata is touched only once per hour.
8. The more expensive normalized-residual fallback is only relevant after a monitored region has actually changed; it does not burden the normal `304` path.

The repository includes `npm run bench` as a repeatable microbenchmark. Representative Node 22 development runs measured roughly **0.02–0.05 ms/run on the 304 hot path**, **~0.3–0.8 ms/run on the no-validator fingerprint fallback**, **~0.49–0.61 ms for both semantic parsers combined**, and **~0.02–0.03 ms to render a seven-field Telegram change card**. These are local wall-clock microbenchmarks with fake KV/fetch, not Cloudflare billed CPU measurements.

## Parser resilience

The parser is intentionally shaped around change patterns seen in OpenCode Go history, not a one-off snapshot. Regression tests cover:

- model additions touching request tables, grouped request-profile labels, pricing rows, and chart entries
- promotions represented by separate `data-bonus` text or historically embedded `(2x usage)` model names
- promotion-banner handoffs
- pricing changes in tiered and Peak/Off-Peak rows
- row reordering with zero semantic alert noise
- suspicious mass parser shrink, which fails closed instead of reporting fake mass removals
- unknown chart attributes that leave known semantics unchanged but must still generate an unclassified-change Telegram alert
- conditional `304`, same-ETag, fingerprint, and changed-surface-only hot paths

The captured historical fixture contains 19 request-table models, 25 pricing rows, 11 chart models, and the Hy3 `8x usage` promotion. Live OpenCode can and does change; that is exactly what the watcher is built to detect.

## Security

Never commit the Telegram bot token or admin token. Production values should be Cloudflare Worker secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

`TELEGRAM_CHAT_ID` is optional. If omitted, message your bot `/start` and call the protected `/telegram/setup` endpoint; the Worker discovers the latest private chat through Telegram `getUpdates` and stores only the chat ID in KV.

`keep_vars = true` is enabled in `wrangler.toml`, so dashboard-configured runtime variables survive Git-connected redeployments.

## Deploy

Prerequisites: Node 20+ and a Cloudflare account.

```bash
npm install
npx wrangler login
npm run validate
npm run test:coverage
npm run deploy
```

Wrangler automatically provisions and binds the `STATE` KV namespace because the binding is declared without an account-specific ID. Then add the two runtime secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

The Worker is configured for `*/5 * * * *`. Cloudflare Cron uses UTC, but this cadence is timezone-independent.

### Deploy from the existing GitHub repository

In Cloudflare Workers, choose **Import a repository**, select `thelabcorner/opencode-go-watch`, use `main`, and keep the default deploy command `npx wrangler deploy`. The KV binding is automatically provisioned on first deploy. After that, add `TELEGRAM_BOT_TOKEN` and `ADMIN_TOKEN` under **Settings → Variables & Secrets** as encrypted secrets.

### Connect Telegram without manually finding the chat ID

1. Send `/start` to your bot in Telegram.
2. Call:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/telegram/setup
```

The bot should immediately reply with a connection-verification message.

### Trigger the first baseline immediately

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/check
```

The first successful run captures the baseline and, by default, sends the `ARMED` Telegram message.

## Endpoints

- `GET /health` — public minimal operational state; never exposes snapshots or secrets
- `GET /status` — admin-only full status + semantic baseline
- `GET /snapshot` — admin-only current semantic snapshot
- `POST /check` — admin-only immediate check
- `POST /check/notify` — admin-only immediate check that also sends the current status when unchanged
- `POST /telegram/setup` — admin-only Telegram chat discovery + connection message
- `POST /telegram/test` — admin-only Telegram delivery test
- `POST /baseline/reset` — admin-only; next successful check becomes a new baseline

Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>` or the equivalent admin-token header supported by the Worker.

## Failure behavior

- **Fetch error:** baseline is untouched and an operational alert is sent.
- **Parser returns suspiciously few models:** treated as degradation, not as “all models removed.”
- **Unknown but meaningful monitored change:** surfaced as an unclassified-change card rather than silently discarded.
- **Telegram send failure:** baseline is untouched, so the same semantic diff retries on the next run.
- **Unchanged data:** zero Telegram messages and no semantic-baseline write.
- **Recovery after degradation:** sends a dedicated recovery message.

## Local tests

The core has no runtime dependencies and is tested with Node's built-in test runner:

```bash
npm run validate
npm run test:coverage
npm run bench
```

The regression suite includes parser history, semantic diffing, Telegram rendering, delivery retry semantics, circuit breakers, hot-path optimizations, and the unclassified-change fallback.