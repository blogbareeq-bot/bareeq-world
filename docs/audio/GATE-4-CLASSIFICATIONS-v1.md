# Gate 4 Classification Semantics v1

**Status:** normative for Gate 4 research interpretation  
**Scope:** Validator v5 / forced-alignment research only  
**Production Exact gate:** unchanged

## 1. Meaning of PILOT_PASS

`PILOT_PASS` means only that the bounded validator pilot is **technically and
diagnostically viable** under its approved controls.

It does **not** mean:
- Validator v5 is production-ready;
- a global score threshold is calibrated;
- the five untested active-pending articles are understood;
- a pending article can be promoted to Exact;
- Gate 5 is automatically open.

The current project state after Pilot #1 is therefore:

`PILOT_PASS_CORROBORATION_REQUIRED`

## 2. Alignment coverage

For Pilot #1, `alignment coverage` is:

`number of expected verification-text words receiving an aligned timestamp / number of expected words in that pilot segment`.

The 100% result is a segment-level pilot result. It is not a statement that every
word in every full article has been validated by forced alignment.

## 3. Negative control

A Gate 4 lexical negative control keeps the **audio unchanged** and deliberately
changes one expected lexical token in the verification transcript.

For Pilot #1, the negative control is considered detected when the modified token:
- does not receive a usable alignment, or
- has a target-token score degradation of at least 0.15 compared with the
  unmodified expected token.

Negative controls test whether the aligner reacts to known-wrong expected text;
they do not prove production error rates by themselves.

## 4. Current classifications

### VALIDATOR_AMBIGUITY

A localized dispute for which Gate 4 does not provide sufficient independent
acoustic evidence to call the baseline audio wrong.

In the current Stage A implementation, a localized expected token that does not
fall below the pilot descriptive low-score reference is routed here when ASR still
disagrees.

Action:
- no TTS;
- human arbitration or additional independent evidence;
- if the expected pronunciation is confirmed, re-adjudicate offline and rerun the
  existing production Exact gate; forced alignment alone never promotes Exact.

### AUDIO_ERROR_CANDIDATE

A localized dispute whose alignment evidence is materially suspicious relative to
the pilot reference and is consistent with an already observed lexical mismatch.

This is a **candidate** classification, not a confirmed audio defect.

Action:
- independent corroboration or Human Arbitration is mandatory;
- no TTS until Gate 5 entry criteria are satisfied;
- no publication status change.

### REPRESENTATION_EQUIVALENT

A proven difference in orthographic/textual representation where the spoken audio
is acceptable for the intended canonical wording.

This classification is **not emitted by a score threshold alone**. It requires a
declared adjudication rule or Human Arbitration evidence.

Action:
- offline adjudication only;
- rerun the existing production Exact gate after the approved equivalence rule;
- no TTS when equivalence resolves the mismatch.

### UNLOCATED

The disputed expected token cannot be reliably localized by the research
validator.

Action:
- insufficient validator evidence;
- no TTS;
- route to alternative evidence or Human Arbitration.

### ACTUAL_AUDIO_ERROR

A Human Arbitration / independently corroborated conclusion that the baseline
audio itself contains the wrong spoken lexical content.

Action:
- may become a Gate 5 synthesis candidate;
- still does not authorize TTS automatically.

## 5. Status of 0.6114

The value `0.6114` from Pilot #1 is a **descriptive pilot statistic only**.

Implementation detail:
- the pilot collected word-level alignment scores from the original verification
  text for all four pilot entries (2 Exact controls + 2 pending controls);
- `0.6114` was the 5th percentile of that small pilot score pool.

Therefore it is **not**:
- a production threshold;
- a statistically validated classifier threshold;
- evidence of a known false-positive or false-negative rate;
- valid for unseen articles without broader calibration.

No policy may promote an article, authorize TTS, or redefine Exact solely because
a score is above or below 0.6114.

## 6. Required calibration before broad reliance

Before Validator v5 may be treated as broadly calibrated, an owner-authorized
calibration run must evaluate:
- all 7 immutable Exact articles, read-only;
- deterministic negative lexical controls on the Exact set;
- all approved representation-equivalence controls;
- all 7 active pending articles, including the 5 not used in Pilot #1.

The report must publish raw counts and uncertainty, including:
- Exact false-alarm count;
- negative-control miss count;
- per-article alignment coverage;
- pending localization/classification counts;
- score distributions by control type;
- false-positive and false-negative estimates only if the sample supports them.

If the sample is too small for a defensible rate estimate, the report must say so
and use counts/intervals rather than a misleading single percentage.
