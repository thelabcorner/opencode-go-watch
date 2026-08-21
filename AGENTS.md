# Repository agent instructions

## Semantic monitoring changes

For any commit that changes scrape-source interpretation or semantic monitoring behavior — including `src/parsers.js`, `src/diff.js`, `src/watcher.js`, `src/zen-watcher.js`, residual normalization, semantic alert types, or fixes prompted by an **UNCLASSIFIED** Telegram notification — load and follow the repository skill:

`.opencode/skills/semantic-source-review/SKILL.md`

The source-review phase is mandatory **before** classifier edits. Do not implement a classifier from the alert snippet alone. Re-fetch the current configured scrape surfaces, inspect companion/authoritative sources and upstream OpenCode source when available, then encode the most general semantic rule that fits the evidence.

A classifier fix should normally include a second synthetic/sibling positive case and a negative-control case so the test suite proves the rule is not merely hardcoded to the reported model or exact markup fragment.

Preserve the unclassified residual fallback for genuinely unknown future source changes.

## Merge gate

Use a branch and PR for repository changes. Run the current validation/coverage/Cloudflare dry-run pipeline and inspect actual failed job logs when CI is red. Merge only the exact PR head that passed the required checks.
