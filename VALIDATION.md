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

## Local verification

The project has no runtime npm dependencies. The validation suite exercises parsing, semantic diffing, historical regressions, Telegram rendering/API payloads, retry semantics, parser circuit breakers, and HTTP/admin endpoints.

Run:

```bash
npm run validate
npm run test:coverage
```

The bot token and admin token are never committed and must be installed as Cloudflare Worker secrets.
