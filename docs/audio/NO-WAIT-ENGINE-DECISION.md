# No-wait audio engine decision policy

Bareeq will not keep the current audio campaign in an open-ended Gemini-only loop.

- Existing exact published audio remains immutable.
- Current Gemini-only work is bounded by the durable 20-successful-request kill switch.
- Chirp 3 HD / Sadaltager is evaluated in one isolated three-sample pilot after the Google Cloud account gate is satisfied.
- The technical result is decided by the encoded delta/QA thresholds, not by elapsed days.
- A technical pass advances immediately to the human voice/splice gate; it does not trigger an automatic engine switch.
- A technical failure rejects Chirp as a secondary segment-repair engine unless a new explicit experiment is approved.
- If a mixed-engine splice is audibly different, Chirp must not patch a Gemini article; whole-article replacement for a still-pending article remains a separate human product decision.

This policy exists to turn the current evidence into a bounded decision rather than another indefinite monitoring phase.
