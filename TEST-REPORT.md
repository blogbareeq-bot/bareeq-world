# Bareeq V4.21.0 — Test Report

Validation date: 2026-08-20

## Baseline

- Input package: `bareeq-world-main(4).zip`.
- Input SHA-256: `2525516b659511baab0f78cf1f52d1863769de0aab3859d278abdb1086e956ff`.
- Input ZIP integrity: PASS.
- Stable baseline version: V4.20.0.
- Published content retained: 13 articles; no article body changed by V4.21.0.

## V4.21.0 checks

- `npm ci --ignore-scripts`: PASS (252 packages installed).
- JavaScript syntax checks: PASS for all added and modified runtime, rollout, smoke, and audit scripts.
- `npm run audit:v4210`: PASS.
  - V4.19.0, V4.20.0, and V4.21.0 preparation fixtures passed.
  - Google Cloud TTS offline contract test passed with mock transport only.
  - Audio UI seek tests passed at 390 px and 1440 px.
  - V4.21.0 release gate passed.
- `npm run plan:audio:cloud:pending`: PASS.
  - 11 pending articles.
  - 61 planned synthesis requests.
  - 95,441 planned billable characters.
  - 0 API requests during planning.
- `npm run audit:audio`: PASS.
  - 13/13 articles covered.
  - 51 source-audit audio parts and 1,094 synchronized reading blocks verified.
  - Arabic speech QA passed for 13/13 articles and 44 pronunciation checks.
  - Mobile and tablet behavior checks passed.

## Full production-equivalent safe build

Executed with all live provider credentials removed from the process environment and with `BAREEQ_CLOUD_TTS_ACTIVATE=0`.

- Preparation and source gates: PASS.
- Google Cloud TTS paid requests: 0.
- Production-cache restore: PASS.
- Astro static build: PASS (57 pages).
- Final audio distribution: PASS.
  - 13/13 articles.
  - 53 synchronized parts.
  - 53 verified MP3 files.
  - 2 current-source Gemini Sadaltager articles retained.
  - 4 bundled Hamed articles retained.
  - 7 generated Hamed articles retained.
- Distribution checks: PASS for 57 HTML files.
- Responsive layout: PASS from 320 px through wide desktop.
- WCAG AA contrast: PASS for 22 tested combinations.
- Interaction checks: PASS.
- Secret-leak checks: PASS.

## V4.21.0 behavior verified

- Audio manifests are fetched only after the reader selects Listen.
- Provider and voice metadata are not embedded in the initial article HTML and are not exposed below the player.
- Seeking highlights and scrolls to the matching paragraph on mobile and desktop, including while paused and across part changes.
- Existing elapsed/total time, controls, AI disclosure, and 30-day saved progress remain intact.
- The Google Cloud TTS path is fail-closed and remains disabled unless `BAREEQ_CLOUD_TTS_ACTIVATE=1` is explicitly supplied.
- Default Google Cloud target: `gemini-2.5-flash-tts`, Sadaltager, `ar-EG`, MP3 at 24 kHz.
- Azure cumulative usage warning is available through `AZURE_SPEECH_MONTHLY_USED_CHARS`, with 400,000 warning and 500,000 allowance defaults.
- Experimental knowledge layers remain disabled.
- Contact address remains `blogbareeq@gmail.com` until an exact replacement is confirmed.

## Not consumed or triggered

- No real Google Cloud TTS request was sent.
- No real Gemini Developer API request was sent.
- No real Azure synthesis request was sent.
- No deployment was triggered while preparing or validating the package.

## Activation boundary

Keep `BAREEQ_CLOUD_TTS_ACTIVATE=0` until CNTXT billing and the required Google Cloud permissions are confirmed. Run the one-request live smoke test first; only then set the activation flag to `1` for the planned 11-article rollout.
