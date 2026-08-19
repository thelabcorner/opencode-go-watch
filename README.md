# OpenCode Go Watch

A zero-server Cloudflare Worker that watches the **OpenCode Go usage chart** and the **OpenCode Go docs request-limit table**, computes semantic diffs, and sends rich Telegram alerts only when meaningful data changes.

## What it watches

- `https://opencode.ai/go`
  - chart model additions/removals
  - 5-hour request-count changes
  - chart promotions such as `8x usage`
- `https://opencode.ai/docs/go/`
  - model additions/removals
  - 5-hour / weekly / monthly request-count changes
  - global `$12 / $30 / $60` usage allowance changes

It deliberately does **not** hash the whole page. CSS, navigation, deployment chunk names, whitespace, analytics, and unrelated copy changes cannot spam Telegram.

## Telegram UX

Alerts use Telegram HTML formatting, compact model-centric diff blocks, percentages, timestamps, and inline buttons to open the Go page or docs. Large diffs are automatically split below Telegram's message-size limit.

The baseline is only advanced after a notification succeeds, so a temporary Telegram failure retries the same change on the next cron run instead of silently losing it.

## Architecture

```text
Cloudflare Cron (*/5 min)
        |
        v
 read ~300 B hot state from KV
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
        +---- parse/fetch failure ---> preserve baseline + operational Telegram alert
        |
        v
 read full semantic baseline + validate + diff
        |
  semantically unchanged -> update tiny hot state only
        |
     changed
        |
        v
 rich Telegram notification
        |
        v
 persist semantic baseline, then hot state
```


## Hot-path optimization

The steady-state path is designed specifically around Cloudflare Free's tight CPU budget:

1. A dedicated KV hot record stores only source validators and fingerprints (roughly a few hundred bytes). Normal five-minute checks do **not** read the much larger semantic snapshot.
2. Requests send `If-None-Match` or `If-Modified-Since`. A `304 Not Modified` reuses the baseline with **zero response-body decoding, HTML parsing, validation walking, or semantic diffing**.
3. If a CDN returns `200` with the exact same ETag, the response body is cancelled immediately and treated as unchanged.
4. If the origin provides no useful validator, only the monitored regions are extracted and hashed with native `crypto.subtle` SHA-256. An identical fingerprint skips the semantic parsers and diff engine.
5. If only one surface changes, only that surface is parsed; the unchanged Go/docs half is reused directly.
6. The Go parser scans the graph figure instead of the whole landing page. The docs parser slices directly to `#usage-limits` before table/text parsing.
7. Stable runs do not rewrite the large semantic snapshot. Raw markup/validator churn with identical semantics updates only the tiny hot record. Operational heartbeat metadata is touched only once per hour.
8. Regexes and number/date formatters are compiled/cached at module scope, and grouped-model profile lookup uses a prebuilt canonical-name index rather than repeated scans.

The repository includes `npm run bench` as a repeatable microbenchmark. Representative Node 22 runs on the captured production-shaped fixtures measured roughly **0.02–0.05 ms/run on the 304 hot path**, **~0.3–0.8 ms/run on the no-validator fingerprint fallback**, **~0.49–0.61 ms for both semantic parsers combined**, and **~0.02–0.03 ms to render a seven-field Telegram change card**. These are local wall-clock microbenchmarks with fake KV/fetch, not Cloudflare billed CPU measurements; production Worker CPU metrics remain the source of truth after deployment.

## Parser resilience

The parser is intentionally shaped around change patterns seen in OpenCode Go history, not a one-off snapshot. Regression tests cover:

- model additions that touch the request table, grouped request-profile labels, pricing rows, and endpoint/model lists
- promotions represented by `baseReq`, separate `data-bonus` text, or historically embedded `(2x usage)` model names
- promotion banner handoffs such as MiniMax → GPT → DeepSeek → Hy3
- price changes in tiered and Peak/Off-Peak rows
- row reordering with zero semantic alert noise
- suspicious mass parser shrink, which fails closed instead of reporting a fake mass model removal

The 2026-08-19 fixture matches the live surfaces observed during development: 19 request-table models, 25 pricing rows, 11 chart models, and the Hy3 `8x usage` chart promotion.

## Security

Never commit the Telegram bot token or admin token. Production values are Cloudflare Worker secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

`TELEGRAM_CHAT_ID` is optional. If omitted, message your bot `/start` and call the protected `/telegram/setup` endpoint; the Worker discovers the latest private chat through Telegram `getUpdates` and stores only the chat ID in KV.

## Deploy

Prerequisites: Node 20+ and a Cloudflare account.

```bash
npm install
npx wrangler login
npm run validate
npm run test:coverage
npm run deploy
```

Wrangler 4 automatically provisions and binds the `STATE` KV namespace because the binding is declared without an account-specific ID. Then add the two runtime secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

The Worker is configured for `*/5 * * * *`. Cloudflare Cron uses UTC, but this cadence is timezone-independent.

### Deploy from the existing GitHub repository

In Cloudflare Workers, choose **Import a repository**, select `thelabcorner/opencode-go-watch`, use `main`, and keep the default deploy command `npx wrangler deploy`. The KV binding is automatically provisioned on first deploy. After that, add `TELEGRAM_BOT_TOKEN` and `ADMIN_TOKEN` under **Settings → Variables & Secrets** as encrypted secrets, then redeploy.

### Connect Telegram without manually finding chat ID

1. Send `/start` to your bot in Telegram.
2. Call:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/telegram/setup
```

The bot should immediately reply with a connection-verification message.

### Trigger first baseline immediately

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/check
```

The first successful run captures the baseline and, by default, sends a “watch is live” Telegram message.

## Endpoints

- `GET /health` — public minimal health state; never exposes snapshots or secrets.
- `GET /status` — admin-only full status + baseline.
- `POST /check` — admin-only immediate check.
- `POST /telegram/setup` — admin-only chat discovery + Telegram test.
- `POST /baseline/reset` — admin-only; next successful check becomes a new baseline.

Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

## Failure behavior

- Fetch error: baseline is untouched and an operational alert is sent (deduplicated by error signature).
- Parser returns suspiciously few models: treated as failure, not as “all models removed.”
- Telegram send failure: baseline is untouched so the semantic diff retries on the next run.
- Unchanged data: zero Telegram messages and no baseline write.

## Local tests

The core has no runtime dependencies and is tested with Node's built-in test runner:

```bash
npm test
npm run test:coverage
npm run check
npm run bench
```

Fixtures reflect the OpenCode values observed on 2026-08-19, including the Hy3 chart promotion (`34,400` chart vs `4,300` docs base, `8x usage`).
