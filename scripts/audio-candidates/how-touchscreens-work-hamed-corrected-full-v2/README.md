# Candidate: how-touchscreens-work — Azure Hamed corrected full v2 (NOT PUBLISHED)

**Status:** needs-review — failed the zero-lexical-error ASR gate; kept for reference and rollback analysis only.

- Article: `how-touchscreens-work` (`de93f3d9f91c8b8b`), speech script `dd0e74ec…` (reviewVersion 1).
- Provider/voice: Microsoft Azure AI Speech, `ar-SA-HamedNeural`, 5 parts, 872.28 s.
- Technical checks (2026-08-26, `scripts/check-audio-technical.mjs`): **passed** — no clipping, RMS spread 0.18 dB, no abnormal silence, edges natural.
- Lexical ASR gate: **failed** — two independent `gemini-3.6-flash` passes over the whole article left **9 stable substitutions out of 1507 words** (evidence: `scripts/speech-transcript-evidence/how-touchscreens-work-hamed-corrected-full-v2.json` and `…-v2-recheck.json`), including three dropped ta-marbuta endings (`الشاشة`→`الشاش`), `اللمسة`→`اللمس`, and `اعتدناه`→`اعتادناه`.
- Per user gate policy this candidate must not be published; the live article keeps its earlier published 3-part Hamed audio (`hamed-part-00*-53830592.mp3` in `public/audio/articles/de93f3d9f91c8b8b/`).
- The Gemini Sadaltager resume path for this article keeps its checkpoint part 1 in `scripts/gemini-checkpoints/de93f3d9f91c8b8b-6ab2c58b980e11d8-gemini-3.1-flash-tts-preview/` (156.6 s, valid MP3) plus the passed cross-model pilot evidence.

Files here are immutable inputs; do not import them into `public/` without a new zero-error verification run.
