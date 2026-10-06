# Gate 4 Full Calibration Plan v1

**Status:** prepared, NOT authorized to run  
**Remaining scientific budget:** 1 run  
**TTS budget:** 0  
**Paid API budget:** 0  
**Production mutation:** prohibited

## Goal

Use the single remaining Gate 4 scientific slot, if explicitly authorized by the
project owner, to test **generalization** rather than repeat Pilot #1.

## Scope

One model load, one bounded workflow run:

1. 7/7 immutable Exact articles as positive controls.
2. 7 deterministic transcript-only lexical negative controls, one per Exact article.
3. Approved representation-equivalence controls from Adjudication v5.
4. 7 active pending articles:
   - re-check the two Pilot #1 cases for reproducibility;
   - evaluate the five previously untested active-pending articles.
5. The intentionally excluded morning article remains outside this campaign.

## Hard preconditions

The run must not start unless:
- owner explicitly authorizes Scientific Run 4/4;
- TTS freeze is active and strategy remains 29/30;
- the workflow is manual `workflow_dispatch` only;
- preflight proves the estimated work fits the 45-minute cap;
- `public/audio` is read-only;
- the retained campaign evidence is available;
- no paid API, provider TTS, or external ASR call is required.

If the preflight estimate cannot fit the cap, the run is not started and a new
owner decision is required.

## Required report

The run must report, at minimum:

### Positive controls
- Exact articles processed / 7;
- alignment coverage for each;
- any Exact false alarm;
- score distribution, not just a single mean.

### Negative controls
- controls detected / 7;
- controls missed / 7;
- localization details and score degradation.

### Representation controls
- preserved as non-substantive / total;
- any false substantive classification.

### Active pending
For every pending mismatch:
- localized / unlocalized;
- classification;
- target score;
- corroborating/contradicting evidence;
- recommended next action.

## Calibration rule

Pilot value `0.6114` is not carried forward as a production threshold.

Any proposed threshold after the full calibration must:
- be derived from the expanded control distributions;
- show the trade-off between Exact false alarms and negative-control misses;
- include uncertainty;
- be validated against controls not used to choose it where practical.

If the evidence is insufficient to select a defensible threshold, no threshold is
adopted. Human Arbitration remains the dispute resolver.

## Acceptance

The full calibration is considered operationally useful only if:
- 7/7 Exact originals avoid hard audio-error classification;
- each Exact article reaches >=95% alignable-word coverage;
- >=6/7 lexical negative controls are detected/localized;
- 100% of approved representation controls remain non-substantive;
- every active pending mismatch is localized or explicitly routed to
  `VALIDATOR_AMBIGUITY` / `UNLOCATED`;
- no production audio changes;
- 0 TTS and 0 paid API calls.

This does not itself authorize Gate 5 synthesis.
