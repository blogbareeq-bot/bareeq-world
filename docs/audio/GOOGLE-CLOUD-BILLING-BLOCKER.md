# Google Cloud Billing blocker — audio completion path

Decision date: 2026-09-28

Google Cloud Billing is treated as **unavailable for the Bareeq audio completion path** after repeated owner-side activation attempts failed.

Consequences:

- Chirp 3 HD / Sadaltager remains a documented technical experiment only.
- No completion milestone, timeout, or repair queue may wait on Google Cloud Billing.
- No code should prompt repeated Cloud Billing retries as part of the current 15/15 completion campaign.
- The active alternative evaluation path is OpenRouter using `google/gemini-3.1-flash-tts-preview` + `Sadaltager` through OpenRouter's own billing and `/api/v1/audio/speech` endpoint.
- Existing exact production audio remains immutable.

This decision can be revisited later if Google Cloud Billing becomes available, but it is not a dependency for finishing the current campaign.
