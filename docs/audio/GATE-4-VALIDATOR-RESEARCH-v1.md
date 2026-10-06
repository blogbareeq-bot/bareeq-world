# Gate 4 — Validator v5 Research Contract

**Status:** approved research contract  
**Scope:** read-only validator research for the current Sadaltager completion campaign  
**TTS:** prohibited  
**Production mutation:** prohibited  
**Owner review deadline:** 2026-10-13  
**Parent policy:** `docs/audio/BAREEQ-AUDIO-RECOVERY-DECISION-v1.md`

## 1. Question Gate 4 is allowed to answer

Gate 4 does **not** attempt to reconstruct why the historical rejected trial in run
`37284619084` moved from score 1 to 4. The rejected trial audio was not retained,
so that historical causal question is formally classified `INSUFFICIENT_EVIDENCE`.

Gate 4 answers the current operational question instead:

> For each remaining baseline candidate, is the unresolved mismatch supported by
> independent acoustic/alignment evidence as a likely spoken-audio error, or is the
> current validator/ASR evidence too ambiguous to justify synthesis?

This is the only question Gate 4 needs to answer before Gate 5.

## 2. Research architecture

Dual-ASR remains the production evidence path. Gate 4 is research-only and adds
an evidence stream of a different type.

### Stage A — Arabic text/character forced alignment
Primary research candidate: WhisperX forced alignment using its Arabic
Wav2Vec2 alignment model.

Stage A is preferred over immediately introducing a hand-built G2P layer because:
- Arabic text in the campaign is not guaranteed to be fully vocalized;
- forced alignment can be calibrated against immutable Exact audio first;
- introducing a phoneme normalizer before calibration would add a second source of error.

### Stage B — phonetic/G2P evidence
Stage B is permitted only if Stage A proves alignment viability but leaves specific
Arabic pronunciation ambiguities unresolved.

Any G2P/phonetic layer must:
- be verification-only;
- never change synthesis text or fingerprints;
- preserve the written expected token alongside phonetic variants;
- be versioned;
- include positive and negative controls;
- never promote a candidate to Exact by itself.

## 3. Pilot scope

The first research run is deliberately small:

- 2 immutable Exact articles as positive controls.
- 2 active one-error pending articles:
  - `اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا`
  - `كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه`
- synthetic transcript-negative controls made from the Exact audio by deliberately
  changing one expected lexical token; **audio is never modified**.
- existing representation-equivalence controls from adjudication v5.

Expansion to all 7 Exact + 7 active pending is forbidden until the pilot acceptance
criteria below pass.

## 4. Pilot acceptance criteria

The pilot is **viable** only if all of the following hold:

1. TTS/provider calls = 0.
2. `public/audio` diff = 0.
3. Exact audio SHA/fingerprints remain unchanged.
4. Both Exact control files are processed without a hard runtime/model failure.
5. At least 95% of alignable expected word tokens in each Exact control receive
   a timestamp/alignment result.
6. The original Exact transcript is not classified as `ACTUAL_AUDIO_ERROR`.
7. Each deliberate lexical negative control is either:
   - unaligned at the modified token, or
   - shows a target-token confidence degradation of at least 0.15 relative to the
     unmodified control at that location.
8. Representation-only controls remain representation-only after canonicalization.
9. Both one-error pending cases produce a localized diagnostic region; an
   unlocalized global score alone is insufficient.

Failure of any mandatory item keeps the validator research-only and blocks expansion.

## 5. Full Gate 4 acceptance criteria

After a viable pilot, the expanded calibration must satisfy:

- 7/7 immutable Exact articles process successfully.
- 7/7 Exact originals remain free of hard `ACTUAL_AUDIO_ERROR` classifications.
- At least 6/7 deliberate lexical negative controls are detected/localized.
- 100% of approved representation-only controls remain non-substantive.
- Every active pending mismatch is localized or explicitly classified
  `VALIDATOR_AMBIGUITY`; silent score-only failure is prohibited.
- The two current one-error cases each end in one of:
  - `AUDIO_ERROR_CANDIDATE`
  - `REPRESENTATION_EQUIVALENT`
  - `VALIDATOR_AMBIGUITY`
- Any `AUDIO_ERROR_CANDIDATE` requires independent corroboration or human
  arbitration before Gate 5 can authorize synthesis.
- Forced alignment alone can never publish or promote a candidate to Exact.

## 6. Gate 4 failure criteria

Gate 4 is formally rejected if any of these occur:

- Exact controls repeatedly fail alignment or are falsely classified as audio errors.
- Negative lexical controls cannot be distinguished from their originals.
- Arabic alignment coverage is materially below the pilot threshold.
- the research requires paid API calls or TTS to produce a verdict;
- resource use exceeds the approved budget;
- after the approved research budget, both one-error cases remain unlocalized and
  diagnostically indistinguishable.

A failed Gate 4 is an acceptable project result. It does not authorize threshold
extension or synthesis.

## 7. Exit paths

### PASS
Gate 4 produces calibrated, reproducible diagnostic evidence. Gate 5 may consider
a single controlled action for a confirmed baseline audio error.

### PARTIAL
Alignment is useful but one or more cases remain ambiguous. Route only those
specific clips to Human Arbitration. Do not synthesize.

### FAIL
Keep v4/v5 production validation unchanged. Do not spend request 30. The campaign
remains safely at its current state until the project owner separately approves
one of:
- a bounded alternate-engine diagnostic pilot;
- a dedicated local validation worker;
- closure of the current campaign with remaining fallbacks.

No redefinition of Exact is implicit in Gate 4 failure.

## 8. Success definition and campaign closure

Long-term program goal remains:

`15/15 Verified Exact/Equivalent Quality`.

Current campaign closure target remains:

`14/15 Exact + 1 intentionally excluded/frozen`.

The excluded article is not a blocker for the seven active pending articles and
may re-enter only through a separately approved mini-campaign.

## 9. Human Arbitration activation

Human Arbitration is active as a dispute-resolution mechanism after Gate 4 produces
a localized conflict.

Rules are defined in `docs/audio/HUMAN-ARBITRATION-v1.md`.
The queue is `docs/audio/HUMAN-ARBITRATION-QUEUE.json`.

No human decision can bypass Technical QA, corruption checks, identity binding,
or the publication gate.

## 10. Evidence retention

- rejected synthesis trial diagnostics: minimum **90 days**;
- Gate 4 research outputs: **30 days**;
- final Gate 4 decision document: retained in git;
- source run `37284619084` artifact remains the historical evidence anchor while
  available.

Research output must not contain credentials or secrets.
