# Offline Adjudication v4 — decision record

Date: 2026-09-28

## Scope

This change is intentionally offline-only. It does not synthesize audio, change any `public/audio` bytes, weaken the 0/0/0/0 gate, or change the approved Gemini/Sadaltager production voice.

## Evidence found in the latest preserved production artifact

The latest 6/15 checkpoint contains raw independent ASR evidence showing three representation-only patterns that were still counted as spoken errors:

1. Visual flow marker `→` omitted by both ASR models. This is layout punctuation, not spoken lexical content.
2. Arabic `ب` proclitic split by ASR as an adjacent token, e.g. `بما` represented as `ب` + `ما` and `بسفر` as `ب` + `سفر`. The equivalence is accepted only when the raw ASR explicitly records the adjacent `ب` insertion; a missing audible `ب` without that insertion remains an error.
3. Written/spoken number representations `عشرين`/`20` and `تسعين`/`90`.

## Predicted effect from replaying the preserved raw reports

- `كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار`: 6 consensus errors -> 0.
- `كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه`: 4 -> 2.
- `why-some-passports-are-stronger`: 6 -> 2.
- Other pending candidates remain unchanged by these narrow rules.

The production workflow must independently reproduce these results from the preserved checkpoint before any publication occurs.

## Safety rules

- Policy version increments to 4 so cached policy-v3 adjudication is not reused.
- Raw ASR reports remain immutable.
- No fuzzy matching, stemming, synonyms, or generic prefix masking.
- Only the observed visual arrow `→` is treated as a silent marker.
- Only the Arabic `ب` proclitic split is accepted, and only with an explicit adjacent insertion in the raw ASR evidence.
- Exact publication still requires technical QA, sync/fingerprint/digest gates and Dual-ASR 0 substitutions / 0 deletions / 0 insertions / 0 unresolved.

## Next engine decision

Cloud TTS / Chirp 3 HD remains a separate pilot decision. It must not be mixed into the current checkpoint or candidate fingerprints. Billing/API enablement is an external account gate and is not performed by this change.
