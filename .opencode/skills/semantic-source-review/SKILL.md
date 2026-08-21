---
name: semantic-source-review
description: Review the live OpenCode Go/Zen scrape surfaces and upstream source before changing parsers, snapshot schemas, semantic diffs, fallback normalization, Telegram classifications, or dashboard history in response to an unclassified watcher alert. Use this whenever a semantic alert is unclassified, a monitored source changes shape, or a new model/limit/pricing/free/unlimited/promotion pattern appears.
compatibility: opencode
metadata:
  audience: maintainers
  workflow: semantic-monitoring
---

# Semantic Source Review Protocol

Use this protocol **before editing the semantic classifier**. An unclassified alert is a sensor report, not a patch specification.

The goal is not to teach the watcher one literal incident. The goal is to discover the underlying semantic dimension and encode a classifier that will also recognize the next model, provider, pricing tier, promotion, availability state, or markup variant that follows the same pattern.

## Core rule

**Do not patch from the Telegram `Before` / `After` snippet alone.**

The snippet tells you where the residual detector noticed a difference. It does not establish what the change means. First reconstruct the current source semantics from the live monitored surfaces and, when available, OpenCode's upstream implementation.

## 1. Inventory the sources from the repository, not from memory

Start by reading:

- `wrangler.toml`
- `src/parsers.js`
- `src/diff.js`
- `src/watcher.js`
- `src/zen-watcher.js`
- `src/telegram.js`
- `src/zen-telegram.js`
- relevant tests under `test/`

Treat the URL variables in `wrangler.toml` as the current monitored-source inventory. Then read `references/source-map.md` for the current authority map and known supporting sources.

Do not assume the source list is unchanged just because the skill mentions a URL. Configuration is the source of truth for what the Worker actually polls.

## 2. Re-fetch the live relevant surfaces before reasoning about the alert

For a Go alert, inspect at minimum:

1. the configured Go landing/chart URL,
2. the configured Go docs URL,
3. the Go models API advertised by the current Go docs when model identity/availability is involved,
4. the upstream OpenCode Go route/component and Go docs source when public source is available.

For a Zen alert, inspect at minimum:

1. the configured Zen models API,
2. the configured Zen docs URL,
3. the upstream Zen docs source when public source is available.

Do **not** use `https://opencode.ai/zen/` as a semantic source unless the architecture is intentionally changed; it is currently not a monitored information surface.

If the alert concerns a model that exists in both Go and Zen, inspect both namespaces. A model's Go ID and Zen ID may legitimately differ. Never infer a global rename merely because the human-readable model name is the same.

## 3. Establish source authority before choosing a classifier

Build a short source matrix:

| Question | Prefer | Supporting evidence |
|---|---|---|
| Go chart/effective 5-hour presentation, promo multiplier, `∞` state | Go landing chart | Go docs and upstream chart component |
| Go documented limits, request estimates, pricing tiers, endpoints, model IDs, notes | Go docs | Go models API and upstream `go.mdx` |
| Go API availability/metadata | Go models API advertised by Go docs | Go docs endpoint/model lists |
| Zen availability | Zen `/v1/models` API | Zen docs endpoint table |
| Zen pricing/free offers/deprecations/endpoints/policy text | Zen docs | Zen API for availability |
| Rendered markup intent | Upstream OpenCode source | live HTML |

Authority is **semantic and field-specific**. Do not force one source to be authoritative for every dimension.

When sources disagree, represent the disagreement explicitly if it is meaningful. Do not silently choose the source that makes the alert disappear.

## 4. Classify the dimension, not the incident

Before touching code, answer these questions:

1. **Entity:** What stable entity changed? Model, pricing row, quota window, endpoint, offer, policy note, source coverage, etc.
2. **Dimension:** What property changed? ID, availability, free/paid state, finite/unlimited state, price, threshold, multiplier, region policy, endpoint family, retention note, etc.
3. **Representation:** Which raw signals encode that dimension today?
4. **Equivalence:** Which alternate markup/text forms mean the same thing?
5. **Boundary:** Which similar-looking changes should *not* be classified the same way?
6. **Authority:** Which source proves the semantic interpretation?

If you cannot answer those, keep the event unclassified rather than adding a guess.

## 5. Prefer reusable semantic fields over literal residual matchers

Order of preference:

### A. Extend an existing generic semantic field

If the parser already has the concept, teach it another representation.

Example pattern: finite request count versus quota-exempt/infinite state. Parse the state generically from stable signals (`∞`, an explicit infinite marker, or the documented all-empty quota row) and diff the `unlimited` dimension. Do not special-case one model name.

### B. Add a new semantic field to the snapshot

If the source exposes a reusable dimension that the snapshot does not model, add it to the parser/snapshot and diff it generically.

Good candidates include stable model IDs, endpoint type, availability state, pricing variant, promotion multiplier, or an explicit source flag.

A new semantic field should usually be keyed by a stable entity and should survive presentation reorder.

### C. Add canonicalization for proven presentation equivalence

Use residual normalization only when two source shapes are proven to mean the same thing and there is no useful new semantic field to preserve.

Canonicalization should retain any semantic payload that could actually change. For example, if two region-warning wrapper shapes are equivalent, preserve the policy URL in the canonical token so a real policy target change still alerts.

### D. Last resort: narrow special case

A model-specific alias or historical migration is acceptable only when the upstream source itself makes the irregularity genuinely specific and there is no safe generalized rule. Document why it is exceptional and add a sibling negative-control test.

## 6. Generalization gate

Before committing a classifier, ask:

> If OpenCode applied the same source pattern tomorrow to a completely different model, would this code classify it correctly without another patch?

If the answer is no, the implementation is probably too literal.

Useful generalization patterns:

- match by structural role or stable attributes, not DOM position;
- pair model identity using stable name/ID relationships rather than array index;
- treat row/table ordering as presentation;
- parse thresholded pricing variants as variants of a base model, not as unrelated magic strings;
- distinguish `free` from `unlimited` unless a source explicitly proves both;
- distinguish Go namespace IDs from Zen namespace IDs;
- model finite ↔ unlimited, paid ↔ free, present ↔ absent, and documented ↔ API-only as state transitions;
- prefer a generic enum/boolean/field transition over one-off event names tied to a model.

## 7. Preserve uncertainty honestly

Do not infer hidden production behavior from public presentation.

Examples:

- `∞` on Go can support a Go quota-exempt/unlimited **Go allowance** state; it does not by itself prove the underlying anonymous/free API bucket has no rate limit.
- a `-free` model ID can support free-model identity, but it does not prove whether several free models share one private rate-limit bucket.
- a docs/API disagreement may be docs lag, rollout staging, or a real inconsistency. Preserve the observable facts unless another public source resolves it.

The watcher should report what the sources establish, not the most convenient explanation.

## 8. Keep the residual fallback alive

The unclassified fallback is intentional coverage for future schema drift.

When adding a classifier:

- suppress the residual alert **only** when the new semantic event fully explains that source delta;
- do not globally strip an attribute merely because one alert was noisy;
- do not broaden an ignore regex until you have proven that the ignored material is presentation-only;
- retain unfamiliar attributes/text in `monitorStructure` whenever they could represent a future semantic dimension.

A successful classifier converts a known pattern from yellow residual noise into a meaningful semantic event without making the detector blind to nearby unknown patterns.

## 9. Test the pattern, not just the reported example

Every semantic-classifier update should include the smallest useful set of tests below.

1. **Reported positive:** reproduce the actual alert pattern.
2. **Sibling positive:** apply the same pattern to another synthetic model/entity and verify the same classifier works. This is the anti-hardcoding test.
3. **Negative control:** a visually or structurally similar presentation-only change remains silent.
4. **Real semantic neighbor:** a nearby meaningful change still alerts.
5. **Diff shape:** assert the semantic `type`, `field`, `before`, and `after`, not merely `changes.length`.
6. **Telegram/history:** if the event is user-visible, assert the useful human-readable classification and archived history category.
7. **Watcher path:** when parser/baseline behavior changed materially, cover the end-to-end watcher path and baseline-preservation semantics.
8. **Old snapshot compatibility:** whenever practical, ensure the new classifier can interpret an existing stored snapshot without requiring a baseline reset. If a schema bump is required, make migration behavior explicit and silent.

Avoid tests whose only purpose is to freeze incidental markup.

## 10. Source-review checklist for a pasted unclassified alert

When the maintainer gives you a Telegram alert, do this sequence:

1. Read the alert and identify which monitored source reported it.
2. Read the current repository configuration and classifier code.
3. Fetch the live implicated source.
4. Fetch the companion source(s) for the same semantic entity.
5. Inspect the relevant upstream OpenCode implementation/source file when available.
6. Determine whether the delta is:
   - a new semantic dimension,
   - a new representation of an existing dimension,
   - a true source inconsistency,
   - or presentation-only churn.
7. State the generalized rule you intend to implement in one sentence before editing.
8. Implement the narrowest generic parser/snapshot/diff change that captures that rule.
9. Add sibling-positive and negative-control tests.
10. Run the full repository validation and Cloudflare dry run.
11. Inspect failed CI job logs directly; do not patch from a red badge alone.
12. Merge only the exact validated PR head.

## 11. Files most likely to change

Use this as navigation, not as a mandatory edit list:

- `src/parsers.js` — Go source preparation and semantic extraction.
- `src/diff.js` — Go semantic transitions and residual fallback.
- `src/watcher.js` — Go snapshot schema/validation and baseline semantics.
- `src/zen-watcher.js` — Zen parsing, snapshot construction, semantic diffing, source authority.
- `src/telegram.js` / `src/zen-telegram.js` — human rendering after the semantic type is correct.
- `src/history.js` — historical alert classification.
- `src/dashboard.js` / `src/zen-dashboard.js` — only when a new semantic field should be displayed.
- `test/*.test.js` — generalized regression coverage.

Do not start in Telegram rendering. The semantic model should be correct before presentation code names the event.

## 12. Validation gate

Before merge, run the repository's actual validation commands. At the time this skill was created, CI runs:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run validate
npm run test:coverage
npm run cf:dry-run
```

If package scripts or CI change, follow the current repository configuration instead of this cached command list.

Do not merge a semantic classifier update while its PR-head CI is failing.

## Compact decision rule

**Source review → semantic hypothesis → generalized representation → parser/snapshot → generic diff → residual still protects unknowns → sibling/negative tests → full CI → merge.**

That is the protocol. The alert is only the trigger.
