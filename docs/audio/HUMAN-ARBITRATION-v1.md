# Human Arbitration v1 — Bareeq Audio

**Status:** active for localized Gate 4 disputes only  
**Purpose:** resolve evidence conflicts, not weaken the automated quality gate.

## Reviewer qualification

A first reviewer must be an Arabic-competent listener able to compare the expected
Modern Standard Arabic wording with the supplied clip.

A second independent Arabic-competent reviewer is required only when the first
review is `INCONCLUSIVE` or when policy explicitly requests a second opinion.

## Review packet

The reviewer receives only:
- expected text;
- short clip containing the disputed word/phrase;
- short context before and after;
- timestamp/location;
- optional phonetic expectation when Gate 4 generated one;
- audio SHA and validator version in metadata.

The first-pass packet should hide ASR verdict labels where practical to reduce
anchoring bias.

## Allowed decisions

- `EXPECTED_PRONUNCIATION_CONFIRMED`
- `ACTUAL_AUDIO_ERROR`
- `REPRESENTATION_EQUIVALENT`
- `INCONCLUSIVE`

## Decision binding

Every decision must record:
- article id;
- fingerprint;
- full audio SHA;
- clip start/end;
- validator version;
- reviewer role/id label;
- decision;
- decision date;
- rationale.

## Conflict handling

- First review `INCONCLUSIVE` -> second independent review.
- Reviewers disagree -> case remains unresolved; no override and no TTS authorization.
- Human review never overrides failed Technical QA or known corrupt audio.

## Human-review budget

Per Gate 4 round:
- no more than 7 disputed clips;
- each clip should normally be <= 45 seconds;
- full-article listening is not required by this arbitration mechanism.

The publication policy remains authoritative for campaign-level listening requirements.
