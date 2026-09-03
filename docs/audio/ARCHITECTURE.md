# Bareeq audio production architecture (V4.22.1)

One production path. Cloudflare Pages builds must not synthesize.

Canonical workflow: `docs/audio/github-audio-production.yml` (cannot push `.github/workflows/` from this app). Modes:

1. `dry-run` — zero provider requests
2. `generate-candidate` — writes `audio-candidates/<articleId>/<fingerprint>/` only. Never publishes. HTTP 429 exits **75** after saving completed parts.
3. `validate-candidate` — merge full.mp3, technical QA, ASR `gemini-3.5-transcribe` (Interactions + Files API), ASR `gemini-3.6-flash` (Interactions + audio), 0/0/0, listening pack. Never publishes.
4. `publish-approved` — copies a candidate over live audio only after dual ASR, technical QA, sync QA, and **human listening bound to the same file SHA-256**.

Live Hamed/Sadaltager under `public/audio/articles/<key>/` is not modified by generate-candidate or validate-candidate.

## Resume

Each part is stored immediately under `audio-candidates/` with a fingerprint of article + spoken text + model + voice + performance instructions + split settings + part index. GitHub restores that directory with `actions/cache` and always uploads artifacts, including on 429.

## Dual ASR

- Allowed: `gemini-3.5-transcribe`, `gemini-3.6-flash`
- Forbidden: `gemini-3.6-transcribe`
- Same model twice is a failure
- Empty transcript is a failure
- Missing model → `pending-independent-asr`, not publishable
- ASR runs on the merged full file only

## Chunking

Legacy 2400-byte cap produced 63 TTS requests. Quota pack uses sentence/paragraph boundaries, live-duration estimates, target 2.5–3 minutes, official 4000-byte text / 655s output caps, and a 180s drift cap.

`BAREEQ_CLOUD_TTS_ACTIVATE` stays `0`. `BAREEQ_GEMINI_FREE_ROLLOUT` stays `0`.
