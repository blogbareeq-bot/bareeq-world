# Verified micro-cut recovery — 2026-10-05

The production checkpoint remains 7 exact / 15. The previous push-triggered
run spent the two remaining requests and rejected both regressions (1→8 and
1→4). Weighted sync ratios and silence boundaries did not prove which words
were removed. This review does not certify any additional article.

Production repair now accepts only scheduled or explicitly dispatched events.
Push runs execute offline gates; the real synthesizer also rejects push events.
The reviewed window preserves all 28 historical successful TTS calls and adds
at most two one-request runs, one per UTC day, for the search-autocomplete
article only. A new exact publication retires the temporary review window.

For this window, locate the smallest complete sentence containing the error.
Enumerate at most eight internal silence-boundary hypotheses, each no longer
than 12 seconds. Before TTS, transcribe the actual extracted cut. Both independent
ASR models must contain every expected word, allowing substitutions only at the
already confirmed error positions. A failed first transcript discards that cut
without a second call. Transport/quota failure stops the attempt.

No verified cut means no TTS and no fallback to paragraph or part regeneration.
Correction notes repeat the approved word only. After splicing, the unchanged
Technical QA, sync/fingerprint checks, and complete-file Dual-ASR zero-error
gates still apply. Any rejected or unverified replacement restores the candidate.

Local validation: daily coordinator, segment repair, strategy guard, micro-cut
mock transport/cleanup, and Dual-ASR adjudication suites; YAML parsing and syntax
checks. No public/audio files are part of this code change.
