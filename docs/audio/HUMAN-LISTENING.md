# Human listening

This environment cannot play the 15 merged files to a human reviewer.

Worksheets: `docs/audio/listening-packs/<articleId>.md`.

Rules:

- Listen to the **full merged file**, not a clip.
- Bind the review to the candidate `full.mp3` SHA-256. `publish-approved` refuses a review that does not match that fingerprint.
- Do not stamp `humanListening.status = passed` from CI, from ASR, or from a green workflow.
- Record `reviewedBy`, `reviewedAt` (ISO), and notes on skips, jumps, stalls, clipping, volume, and unnatural pause endings.
- Publication remains blocked without this review even if dual ASR is 0/0/0.
