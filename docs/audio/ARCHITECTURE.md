# Bareeq audio production architecture (V4.22.1)

One production path. Cloudflare Pages builds must not synthesize.

The GitHub App used to push this branch cannot write `.github/workflows/` (`workflows` permission missing). The production workflow therefore lives at `docs/audio/github-audio-production.yml` until a repo admin copies it to `.github/workflows/audio-production.yml`. After that copy, it is the only workflow allowed to spend Gemini quota (`concurrency` group `bareeq-audio-production`). Existing passport/touchscreen generate workflows remain in the repo as rollback history; do not dispatch them.

## Stages

`text_ready` → `generation_authorized` → `generated` → `asr_passed` → `human_approved` → `technical_passed` → `publishable` → `published`

Generation authorization comes from a reviewed Speech Script plus a current test-clip *plan file*. It does **not** require listening evidence, ASR, or `fullSynthesisAllowed`. Those are later publication gates. Requiring them before the first TTS request is circular and forbidden.

## Narrator

- Primary: Google Gemini API / `gemini-3.1-flash-tts-preview` / Sadaltager / `ar` / generatorVersion 8 / pcm-s16le-24000hz-mono → mp3 48 kHz 96 kbps.
- Fallback/rollback only: Azure `ar-SA-HamedNeural` or `ar-KW-FahedNeural`.
- Live 2026-08-28: 9 Sadaltager + 6 Hamed. Reuse the 9. Generate candidates only for the 6. Keep live Hamed until the candidate is publishable.

## Conflicting Fahed decision

`docs/قرار-وتنفيذ-صوت-فهد-v4.22.0.md` on `audio/fahed-v4220` (2026-08-25) selected Azure Fahed as an immediate production narrator. The later 2026-08-28 closure instruction selects Sadaltager as primary. No Fahed corpus was generated in this closure path. Speech Scripts from that branch are reused as text, not as a Fahed production order.

## Dual ASR

Independent models: `gemini-3.5-transcribe` and `gemini-3.6-transcribe`. Same model twice is a failure. Exact match after NFC/diacritic-strip/tatweel/punctuation/whitespace only. Pass = 0 substitutions / 0 deletions / 0 insertions on the full merged file.

## Commands

```
node scripts/audio-inventory.mjs
node scripts/audio-production.mjs --dry-run
node scripts/audio-production.mjs --execute --article=<id>   # requires BAREEQ_AUDIO_PRODUCTION_LOCK=1
node scripts/audio-asr-transcribe.mjs --dry-run --model=gemini-3.5-transcribe
node scripts/audio-technical-qa.mjs --article=<id>
```

`BAREEQ_CLOUD_TTS_ACTIVATE` stays `0`. `BAREEQ_GEMINI_FREE_ROLLOUT` stays `0` on Cloudflare so the Pages build cannot compete for quota.
