# Validation record

Validated on 2026-08-19 against the live OpenCode Go surfaces and historical OpenCode repository changes.

## Live surface baseline

The captured fixtures represent the live values observed during validation:

- Go chart: 11 models
- request estimate table: 19 models
- pricing table: 25 rows
- global usage windows: `$12 / 5h`, `$30 / week`, `$60 / month`
- active chart promotion: `Hy3` at `34,400 / 5h` versus the docs base of `4,300 / 5h`, labeled `8x usage`

## Historical structural cases modeled

Regression coverage was designed from real change shapes in the OpenCode repository:

- model additions (for example, adding GLM-5.3 across model lists, request tables, grouped request profiles, pricing, and endpoints)
- model-lineup additions such as Hy3
- promotion handoffs and multiplier changes (MiniMax M3, GPT 5.6 Luna, DeepSeek V4 Flash, Hy3)
- promotion representation changes using `baseReq`, bonus labels, and older promotion text embedded in the model name
- independent landing-page and docs changes
- request estimate, pricing, request-profile, and global allowance changes
- harmless DOM/table row reordering

## Performance validation

The watcher now has three steady-state gates before semantic parsing: conditional `304`, exact ETag identity on a `200`, and SHA-256 fingerprinting of only the monitored regions. A dedicated hot KV record (roughly a few hundred bytes) means normal checks avoid loading the ~10 KB captured semantic snapshot entirely. Only changed surfaces are parsed.

Development microbenchmark (`npm run bench`, Node 22, captured production-shaped fixtures):

- conditional `304` hot path: ~0.02–0.05 ms/run
- no-validator fingerprint fallback: typically ~0.3–0.8 ms/run
- Go + docs semantic parsers combined: ~0.49–0.61 ms
- seven-field rich Telegram render: ~0.02–0.03 ms

These timings are local wall-clock microbenchmarks using fake KV/fetch and intentionally are not presented as Cloudflare billed CPU time. Production Cloudflare Worker CPU metrics must be checked after deployment.

Regression tests explicitly verify `304`, same-ETag `200`, fingerprint fallback, unrelated-page-chrome immunity, changed-surface-only parsing, and that the 304 hot path does not read the full semantic snapshot.

## Local verification

The project has no runtime npm dependencies. The current suite passes 37/37 tests and exercises parsing, semantic diffing, historical regressions, Telegram rendering/API payloads, retry semantics, parser circuit breakers, and HTTP/admin endpoints.

Run:

```bash
npm run validate
npm run test:coverage
npm run bench
```

The bot token and admin token are never committed and must be installed as Cloudflare Worker secrets.

## Incremental self-test — 2026-08-21 caller cancellation hardening

Issue #3 adds an explicit cancellation contract to resilient source GETs: caller aborts are composed with each attempt's fresh timeout signal, pre-aborted requests do not start, and caller-driven aborts are not retried as transient upstream failures.

Targeted branch-local evidence executed against the changed module/test pair on Node 22.16.0:

```bash
node --check src/resilient-fetch.js
node --check test/resilient-fetch.test.js
node --test test/resilient-fetch.test.js
```

Result: 5/5 targeted tests passed, covering transient timeout retry, transient 5xx retry, in-flight caller cancellation (one attempt), pre-aborted caller cancellation (zero attempts), and non-retrying POST behavior.

This incremental record does **not** replace the 2026-08-19 full-suite baseline above. `npm run validate`, coverage, benchmarks, deployed Worker metrics, and human acceptance were not rerun as part of this connector-driven change and remain pending for the draft PR review.
