# Bareeq V4.21.1 — Replacement Package Validation

Validation date: 2026-08-21

- Package mode: full source replacement inside the current repository; keep `.git`.
- Source baseline: verified Bareeq V4.21.0 final package.
- Target version: V4.21.1.
- Published articles: 13; article-body changes: 0.
- Approved header: design one, implemented natively and responsively.
- Logo: original SVG mark and wording, clearly isolated on white at desktop widths.
- Tablet/mobile: compressed and simplified breakpoints; no decorative-wave crowding.
- Header functions retained: navigation, reading list, search, theme, menu, ticker, categories.
- Gemini baseline: 2 completed Sadaltager articles retained.
- Gemini pending set: 11 articles.
- Full pending plan: 81 parts/requests and 95,441 source characters; planning requests: 0.
- Free rollout: enabled by default only when `GEMINI_API_KEY` exists.
- Per-build limit: exactly one unresolved article, shortest first.
- Publication: atomic per article.
- 429/budget behavior: approved Hamed/Cedar fallback remains; build can finish.
- Missing-key behavior: zero synthesis requests; build can finish.
- Paid Cloud TTS: disabled by default and still pending CNTXT.
- Claude audit adopted: email-obfuscation protection and local-storage privacy disclosure.
- Claude audit already satisfied: local reading list.
- Deferred pending real values/accounts: domain email, `ads.txt`, newsletter, and ad units.
- Safe full build: PASS.
- Astro output: 57 pages.
- Audio output: 13/13 articles, 53 synchronized MP3 parts.
- Static distribution, responsive layout, WCAG AA contrast, interactions, Arabic speech, and secret-leak checks: PASS.
- Built HTML contains Cloudflare `email_off` boundaries and zero `/cdn-cgi/l/email-protection` links.
- Real provider requests during preparation and validation: 0.

## Required deployment sequence

1. Copy all files from the package's `bareeq-world-main` into the existing repository and replace matching files; do not delete `.git`.
2. Confirm `GEMINI_API_KEY` exists as a Cloudflare Production Secret without exposing its value.
3. Keep `BAREEQ_CLOUD_TTS_ACTIVATE=0`.
4. Commit and Push once using the summary/description in `README-REPLACE-FIRST.md`.
5. Let one Cloudflare deployment finish; do not run concurrent deployments.
6. Read the log for success, 429-safe pause, or missing-key message.
7. After a successful article, a later deployment automatically restores it and chooses the next shortest unresolved article.
8. After 429, wait for the quota window to renew before one later Redeploy.

The V4.21.1 source package is ready for replacement and deployment with the approved header and safe progressive free-tier audio path. Paid Cloud TTS remains inactive.
