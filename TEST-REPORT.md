# Bareeq V4.21.1 — Test Report

Validation date: 2026-08-21

## Baseline

- Input package: `Bareeq-V4.21.0-FINAL.zip`.
- Input SHA-256: `239903f6c0833a54c63f4149edc97772deaa1c5abf96266e6fe8b385424f0ecd`.
- Input ZIP integrity: PASS.
- Stable baseline version: V4.21.0.
- Published content retained: 13 articles; article-body changes in V4.21.1: 0.

## Source and contract checks

- `npm ci --ignore-scripts`: PASS (252 packages installed).
- JSON and JavaScript syntax: PASS.
- `npm run audit:v4211`: PASS.
  - V4.19.0, V4.20.0, V4.21.0, and V4.21.1 preparation gates passed.
  - Google Cloud TTS offline contract passed; paid requests: 0.
  - Gemini free-tier contract passed against a local mock.
  - Exactly one article per build and shortest-first selection verified.
  - Persistent 429 returned success while preserving fallback and leaving no partial directory.
  - Audio UI tests passed at 390px and 1440px.
  - Design-one source gate passed for desktop, tablet, mobile, search, theme, reading list, ticker, and categories.
  - V4.21.0 compatibility and V4.21.1 release gates passed.

## Backlog plan

- `npm run plan:audio:gemini:pending`: PASS.
- Pending articles: 11.
- Complete-backlog parts/requests: 81.
- Complete-backlog source characters: 95,441.
- API requests during planning: 0.
- Initial shortest unresolved article: 4 parts.

## Full production-equivalent safe build

Executed with all live speech credentials removed, `BAREEQ_GEMINI_FREE_ROLLOUT=0`, and `BAREEQ_CLOUD_TTS_ACTIVATE=0`.

- Preparation, syntax, and source gates: PASS.
- Real Gemini, Google Cloud, Azure, and OpenAI synthesis requests: 0.
- Production-cache restore: PASS.
- Astro static build: PASS (57 pages).
- Final audio distribution: PASS.
  - 13/13 articles.
  - 53 synchronized parts.
  - 53 verified MP3 files.
  - Gemini Sadaltager: 2 articles.
  - Bundled Hamed: 4 articles.
  - Generated Hamed: 7 articles.
- Distribution checks: PASS for 57 HTML files.
- Responsive CSS checks: PASS from 320px through wide desktop.
- WCAG AA contrast: PASS for 22 combinations.
- Interaction checks: PASS.
- Secret-leak checks: PASS.
- Cloudflare email exclusion comments present in final HTML: PASS.
- `/cdn-cgi/l/email-protection` links in final output: 0.

## Missing-key production branch

The V4.21.1 runner was executed with free rollout enabled by default and without `GEMINI_API_KEY`.

- Result: PASS.
- Synthesis requests: 0.
- All 13 fallback/retained audio manifests remained complete.
- Explicit missing-key safe message emitted.

## Behavior verified

- Completed Sadaltager audio is restored before any synthesis.
- Only the shortest unresolved article is selected and only one article can be attempted per build.
- A new article directory replaces fallback only after every MP3 and manifest is complete.
- Persistent 429 or build-time budget preserves fallback and allows deployment to continue.
- Paid Cloud TTS remains fail-closed unless `BAREEQ_CLOUD_TTS_ACTIVATE=1` is deliberately set.
- The design-one header uses the native logo and components; it does not embed the supplied concept PNG.
- Desktop uses the white logo panel and navy/teal wave; mobile removes the decorative wave to prevent crowding.
- Email remains `blogbareeq@gmail.com` until an exact working domain address is confirmed.
- Empty/placeholder `ads.txt`, newsletter integration, ad slots, and editorial expansions were not added.

## Not consumed or triggered

- No real speech-provider request was sent.
- No paid Cloud service was activated.
- No deployment or external repository write was triggered while preparing the package.
