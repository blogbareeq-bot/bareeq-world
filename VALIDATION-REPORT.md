# Bareeq V4.21.0 — Replacement Package Validation

Validation date: 2026-08-20

- Package mode: full source replacement over the current repository.
- Source baseline: verified V4.20.0 package supplied by the user.
- Target version: V4.21.0.
- Published articles: 13; content changes: 0.
- Stable visual system: preserved.
- Mobile categories: wrapped and visible without horizontal scrolling; verified from 320 px upward.
- Initial article HTML: no audio manifest payload and no provider/voice metadata.
- Listen selection: lazily fetches the article audio manifest.
- Seek behavior: synchronized highlight plus forced paragraph scrolling on mobile and desktop.
- Current-source Gemini cache: 2 compatible Sadaltager articles retained.
- Cloud TTS pending set: 11 articles, 61 planned requests, 95,441 planned characters.
- Cloud TTS activation: fail-closed and disabled by default.
- Paid synthesis during preparation and validation: 0 requests.
- Safe full build: PASS.
- Astro output: 57 pages.
- Audio output: 13/13 articles, 53 synchronized MP3 parts.
- Static distribution, responsive layout, contrast, interaction, Arabic speech, and secret-leak checks: PASS.

## Required pre-activation sequence

1. Link CNTXT billing and confirm the Cloud Text-to-Speech API and IAM permission.
2. Add one supported authentication method to the deployment secrets.
3. Keep `BAREEQ_CLOUD_TTS_ACTIVATE=0` and run `npm run smoke:audio:cloud:live` once.
4. Confirm the smoke MP3 and request accounting.
5. Set `BAREEQ_CLOUD_TTS_ACTIVATE=1` for the rollout build.
6. Review the rollout totals and final audio audit before publishing.

The V4.21.0 source package is ready for repository replacement and deployment while the paid Google Cloud generation path remains inactive.
