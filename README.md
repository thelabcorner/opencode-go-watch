# OpenCode Go + Zen Watch

A zero-server Cloudflare Worker that semantically monitors **OpenCode Go** usage economics and model availability plus the **OpenCode Zen** model catalog, then sends rich Telegram alerts only when something meaningful changes.

The project is deliberately not a whole-page hash watcher. It understands models, request limits, pricing variants, promotions, free-model availability, endpoint routing, deprecations, documentation notes, and cross-source consistency. If a monitored source changes in a way the semantic model does not understand yet, a residual fallback still surfaces the unexplained change instead of silently discarding it.

## Dashboards

- `/` — OpenCode Go dashboard: allowances, all monitored Go models, model-maker logos, chart/docs values, pricing tiers, DeepSeek peak economics, and Brotli-backed alert history.
- `/zen` — OpenCode Zen dashboard: all currently available Zen models, **free models highlighted first**, complete published pricing variants, API-only/docs-lag models, current offers/discount wording, deprecations, and Zen alert history.

Both dashboards are server-rendered, dependency-free, responsive across desktop/tablet/mobile, and expose no Worker secrets.

---

## OpenCode Go monitoring

Go is monitored from three complementary surfaces rather than treating any single page as the complete source of truth:

### Sources

1. `https://opencode.ai/zen/go/v1/models` — **authoritative public Go availability catalog**. This is the machine-readable list of model IDs OpenCode currently advertises through the Go API namespace.
2. `https://opencode.ai/go` — live Go request chart and promotions.
3. `https://opencode.ai/docs/go/` — usage limits, pricing, request profiles, notes, and global subscription allowances.

The API catalog and docs are intentionally **not required to contain identical model sets**. OpenCode can expose a model through the Go API before the human-facing docs or economic tables are updated. The watcher therefore treats an API-only model as a real availability state, not as a parser failure or automatic docs mismatch.

The Go models API also emits a fresh `created` timestamp on every response. The watcher canonicalizes the catalog before fingerprinting, ignores that volatile timestamp, sorts model IDs, and tracks only stable availability/metadata. Polling the API therefore does not generate false changes on every request.

### Semantic changes

| Category | Detected change | Telegram treatment |
| --- | --- | --- |
| Model lifecycle | request-table model added / removed | rich `NEW MODEL` / `MODEL REMOVED` card |
| **API availability** | model added / removed from `/zen/go/v1/models` | dedicated Go API model availability card |
| **API metadata** | stable advertised API metadata changes | dedicated Go API metadata card |
| Request limits | 5-hour / weekly / monthly estimate changed | grouped per-model percentage deltas |
| Subscription allowance | 5-hour / weekly / monthly dollar allowance changed | grouped allowance card |
| Request profile | input/cached/output request assumptions changed | request-profile card |
| Pricing | pricing row or field added / removed / changed | exact row + dollar/percentage delta |
| Go chart | chart model added / removed / request count changed | chart card |
| Promotion | multiplier / bonus / banner changed | usage-update card |
| Cross-check | chart and docs disagree unexpectedly | mismatch warning / resolved notice |
| Usage notes | DeepSeek peak hours, disclaimers, relevant wording | before/after note card |
| Unknown semantic | monitored landing/docs source changed but known fields did not | residual `UNCLASSIFIED MONITORED CHANGE` |
| **Unknown API semantic** | stable unmodeled Go API metadata changes | residual Go API unclassified card |
| Operational | fetch / parse / validation failure | error alert; known-good baseline preserved |
| Recovery | source becomes healthy again | recovery alert |

Related lifecycle changes are coalesced. A new model that simultaneously adds a request row, price row, request profile, and chart entry becomes one Telegram model card rather than four notifications.

The Go API source also has its own catastrophic-shrink protection. A suspicious mass disappearance from the catalog is rejected rather than being accepted as dozens of model removals, and the known-good baseline is preserved.

When the API source is introduced to an existing installation, its current catalog is silently seeded into the Go baseline. Existing models are not announced as newly added simply because the watcher gained a new source.

---

## OpenCode Zen monitoring

Zen is intentionally monitored from the two surfaces that actually carry machine-useful state:

1. `https://opencode.ai/zen/v1/models` — **authoritative availability** list.
2. `https://opencode.ai/docs/zen/` — human-readable model catalog, model IDs, endpoints, AI SDK routing, pricing, free-model notes, policy text, and deprecations.

`https://opencode.ai/zen/` is **not monitored**. It is a marketing/product surface and does not provide the structured catalog/economic information this watcher cares about.

### Reverse-engineered Zen structure

The Zen docs currently expose:

- `## Endpoints`
  - Model
  - Model ID
  - Endpoint
  - AI SDK Package
- `### Models`
  - points to the public `/zen/v1/models` catalog
- `## Pricing`
  - Model
  - Input / 1M
  - Output / 1M
  - Cached Read / 1M
  - Cached Write / 1M
- free-model descriptions
- DeepSeek peak/off-peak information and other policy/economic notes
- deprecated-model rows with deprecation dates

The watcher cross-references those docs against the API instead of assuming the two sources update atomically. A model can therefore appear as **API-only / docs catching up** without being misreported as parser failure.

### Zen semantic changes

| Category | Detected change | Telegram treatment |
| --- | --- | --- |
| **Free availability** | new free model appears | `🆓 OPENCODE ZEN · NEW FREE MODEL` |
| **Free availability** | free model disappears | `🚫 OPENCODE ZEN · FREE MODEL REMOVED` |
| **Free transition** | existing model becomes free | `🆓 OPENCODE ZEN · MODEL IS NOW FREE` |
| **Free transition** | free access becomes paid | `💳 OPENCODE ZEN · FREE ACCESS ENDED` |
| Model availability | model added / removed from `/v1/models` | model lifecycle card |
| Model metadata | API `owned_by` changes | owner-change card |
| Pricing | input/output/cache price changes | exact pricing-row delta |
| **Price decrease** | any numeric price falls | `🏷️ OPENCODE ZEN · PRICE DROP` |
| Pricing rows | variant added / removed | pricing-row card |
| Discount / promotion text | new tracked offer wording appears/disappears | `NEW OFFER / DISCOUNT` card |
| Endpoint routing | endpoint, name, or SDK route changes | endpoint card |
| Deprecation | row added / removed / date changed | deprecation card |
| Free-model notes | free offer wording changes | free-note card |
| Docs/API coverage | API-only or docs-only set changes | consistency card |
| Unknown docs change | residual monitored docs structure/text changes | unclassified Zen card |
| Unknown API change | new unmodeled API metadata changes | unclassified Zen card |
| Operational | Zen fetch/parser/validation failure | Zen error alert; Zen baseline preserved |
| Recovery | both Zen sources healthy again | Zen recovery alert |

### What counts as “free”

The Zen watcher deliberately combines several signals:

- model ID ending in `-free`
- a docs pricing row whose input/output/cached-read values are all `Free`
- a model listed in the docs free-model section

This handles models such as `Big Pickle`, which can be free without using a `-free` suffix, while still recognizing API-first free additions whose documentation has not caught up yet.

### Pricing variants are never collapsed

Rows such as:

- `Off-Peak` / `Peak`
- `≤ 200K tokens` / `> 200K tokens`
- any future parenthesized pricing variant

remain separate semantic rows. A change to one tier does not contaminate another tier, and the Zen dashboard displays every published variant.

### Example Zen alerts

New free model:

```text
🆓 OPENCODE ZEN · NEW FREE MODEL
━━━━━━━━━━━━━━━━━━━━
3 semantic field changes · 2 update cards

🆓 FREE MODEL ADDED
Laguna S 2.1 Free
opencode/laguna-s-2.1-free
Free access is now available

🕒 Aug 20, 2026, 11:30 PM CDT
🔎 Zen models API + Zen docs
```

Price drop:

```text
🏷️ OPENCODE ZEN · PRICE DROP
━━━━━━━━━━━━━━━━━━━━
2 semantic field changes · 1 update card

🏷️ ZEN PRICE DROP
DeepSeek V4 Flash (Off-Peak)
Input: $0.22 → $0.18  ▼ -18.2%
Output: $0.66 → $0.54 ▼ -18.2%
```

Unknown future concept:

```text
🟡 OPENCODE ZEN · UNCLASSIFIED CHANGE
━━━━━━━━━━━━━━━━━━━━

🟡 UNCLASSIFIED ZEN CHANGE
Zen models API
The monitored source changed, but known Zen semantic fields stayed the same.

Before  …
After   …new metadata…
```

---

## Failure-safe architecture

Go and Zen have **independent baselines and error states**. A Zen outage cannot prevent Go from checking, and a Go parser failure cannot stop Zen monitoring.

```text
Cloudflare Cron · every 5 minutes
        |
        +--------------------------+
        |                          |
        v                          v
   Go monitor                 Zen monitor
 API + chart + docs        Zen API + Zen docs
        |                          |
        v                          v
 conditional GETs / ETag / Last-Modified
        |
        v
 canonical semantic fingerprint / SHA-256 fallback
        |
        +---- identical ----> no semantic parse / no Telegram / no baseline write
        |
        v
 semantic parser + transition validation
        |
        +---- suspicious parser/catalog shrink or failure
        |          |
        |          +---- preserve previous baseline + operational alert
        |
        v
 semantic diff
        |
        +---- known change ------> coalesced rich Telegram alert
        |
        +---- no known change
                   |
                   v
             residual fallback
              /           \
        meaningful       normalized noise
           |                  |
   unclassified alert       silent
```

The baseline advances only after required Telegram delivery succeeds. If notification delivery fails, the old baseline remains so the real change retries on the next run instead of being lost.

### Independent Zen KV state

- `zen:snapshot:v1`
- `zen:hot:v1`
- `zen:meta:v1`
- `zen:error:v1`

Go retains its existing independent state, with the Go API catalog stored inside the same Go semantic snapshot and hot-source inventory as the landing and docs sources.

---

## Hot-path optimization

Both monitors are designed around Cloudflare Free-tier efficiency:

1. tiny hot records hold validators + fingerprints
2. conditional GETs use ETag / Last-Modified where representation validators are stable
3. `304` skips body decoding, parsing, snapshot reads, and semantic diffing
4. same-ETag `200` bodies are cancelled
5. if validators are absent or unsuitable, native `crypto.subtle` SHA-256 gates semantic parsing
6. the Go models API is canonicalized before fingerprinting so its volatile `created` timestamp cannot dirty state
7. only changed sources are reparsed; unchanged sources reuse the baseline
8. unchanged checks do not rewrite the semantic snapshot
9. heartbeat metadata persists only about hourly
10. Go and Zen scheduled work runs concurrently and fails independently
11. expensive residual normalization only runs after a monitored source actually changes

Source GETs get one safe retry on transient network/timeout/5xx failures. Telegram POSTs are deliberately **not** automatically retried because an ambiguous POST retry could duplicate an alert.

---

## Brotli-compressed alert history

The dashboards use one shared rolling alert archive in KV:

- actionable alerts only — unchanged checks add nothing
- newest first
- maximum 96 retained events
- maximum 96 KiB of JSON before compression
- one binary KV value rather than one key per alert
- Brotli quality 5 using Cloudflare `node:zlib`
- history failure is observability-only and never blocks monitoring/baseline advancement

The Go dashboard shows recent Go activity; `/zen` filters the same archive to Zen events.

---

## Telegram anti-spam behavior

- unchanged checks send **nothing**
- related model lifecycle changes are coalesced
- fields for one pricing/request/profile/chart/API object are grouped
- one polling run emits as few messages as possible
- Telegram payloads split only near the 3,850-character safety threshold
- identical operational failures are deduplicated with long reminder spacing
- Go and Zen use separate operational error states
- enabling Go API monitoring on an existing baseline does not announce the existing catalog as newly added

Separate real changes published in different five-minute snapshots can still generate separate notifications.

---

## Endpoints

### Public dashboards / health

- `GET /` — Go dashboard
- `GET /zen` — Zen dashboard
- `GET /health` — compact Go health state
- `GET /zen/health` — compact Zen health + current model/free counts
- `GET /dashboard.js` — Go dashboard client behavior
- `GET /zen-dashboard.js` — Zen dashboard client behavior

### Admin Go

- `GET /status`
- `GET /snapshot`
- `POST /check`
- `POST /check/notify`
- `POST /baseline/reset`

### Admin Zen

- `GET /zen/status`
- `GET /zen/snapshot`
- `POST /zen/check`
- `POST /zen/baseline/reset`

### Telegram

- `POST /telegram/setup`
- `POST /telegram/test`

Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>` or the supported admin-token header.

---

## Security

Never commit the Telegram bot token or admin token. Production values should be Worker secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

`TELEGRAM_CHAT_ID` is optional. If omitted, send the bot `/start` and call `/telegram/setup`; the Worker discovers the latest private chat and stores only its chat ID in KV.

`keep_vars = true` is enabled so dashboard-configured runtime variables survive Git-connected redeployments.

---

## Configuration

The committed non-secret source configuration is:

```toml
OPENCODE_GO_URL = "https://opencode.ai/go"
OPENCODE_DOCS_URL = "https://opencode.ai/docs/go/"
OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models"
OPENCODE_ZEN_DOCS_URL = "https://opencode.ai/docs/zen/"
OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models"
TIMEZONE = "America/Chicago"
NOTIFY_ON_BOOTSTRAP = "true"
NOTIFY_ON_ZEN_BOOTSTRAP = "true"
```

`OPENCODE_GO_MODELS_URL` enables the machine-readable Go availability watcher. On migration from an older baseline, the current API catalog is seeded silently; subsequent stable additions, removals, or metadata changes become semantic Go alerts.

`NOTIFY_ON_ZEN_BOOTSTRAP=true` means the first successful Zen baseline sends one compact `ZEN WATCH · ARMED` message containing current API/documented/free counts. It does **not** announce every existing model as newly added.

---

## Deploy

```bash
npm install
npm run validate
npm run test:coverage
npx wrangler deploy
```

Wrangler automatically provisions/binds the `STATE` KV namespace when required. The same `*/5 * * * *` cron drives Go and Zen; no second scheduled Worker is needed.

To trigger Go's three-source check immediately after deployment:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/check
```

To trigger Zen baseline creation immediately after deployment:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/zen/check
```

Then open:

```text
https://YOUR-WORKER.workers.dev/
https://YOUR-WORKER.workers.dev/zen
```

---

## Tests

```bash
npm run validate
npm run test:coverage
npm run bench
```

The regression suite covers Go parser history, Go models API canonicalization and semantic availability diffs, volatile timestamp suppression, API baseline migration, suspicious catalog shrink protection, semantic diffs, unknown-change fallback, Telegram grouping, delivery safety, transition circuit breakers, conditional-request hot paths, Brotli history, responsive dashboards, Zen docs/API parsing, free-model lifecycle, discounts/price drops, owner changes, deprecations, Zen unknown-change fallback, Zen route security, independent baseline reset, and Zen `304` fast paths.
