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
  Worker fetches both pages
        |
        v
 semantic parsers + validation
        |
        +---- parse/fetch failure ---> operational Telegram alert
        |
        v
     semantic diff
        |
  unchanged -> stop
        |
     changed
        |
        v
 rich Telegram notification
        |
        v
  persist new snapshot in KV
```

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
npx wrangler kv namespace create OPENCODE_GO_WATCH_STATE
```

Copy the returned namespace ID into `wrangler.toml` as the `STATE` binding, then:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN
npm run validate
npm run test:coverage
npm run deploy
```

The Worker is configured for `*/5 * * * *`. Cloudflare Cron uses UTC, but this cadence is timezone-independent.

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
```

Fixtures reflect the OpenCode values observed on 2026-08-19, including the Hy3 chart promotion (`34,400` chart vs `4,300` docs base, `8x usage`).
