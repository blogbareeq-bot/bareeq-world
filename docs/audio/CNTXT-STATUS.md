# CNTXT Cloud TTS status

- Project: `bareeq-tts` (existing). No new Google Cloud project or billing account.
- `BAREEQ_CLOUD_TTS_ACTIVATE=0` in `.env.example` and in the production audio workflow.
- Normal Cloudflare builds run `BAREEQ_GEMINI_FREE_ROLLOUT=0 BAREEQ_CLOUD_TTS_ACTIVATE=0 node scripts/run-v4211-audio.mjs`.
- Paid Cloud TTS (`gemini-2.5-flash-tts` via Vertex/Cloud TTS) is not part of this closure. Do not enable it from this branch.
- Remaining CNTXT work after Sadaltager certification: billing link confirmation, `roles/aiplatform.user`, one-article paid smoke, then an explicit later approval to set `BAREEQ_CLOUD_TTS_ACTIVATE=1`.
- This file is not an activation.
