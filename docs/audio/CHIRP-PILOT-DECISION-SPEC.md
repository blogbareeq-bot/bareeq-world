# Chirp 3 HD / Sadaltager pilot — decision specification

Date: 2026-09-28
Status: prepared, blocked only by external Google Cloud account enablement.

## Non-negotiable safety boundary

The pilot is isolated from the current `sadaltager-openrouter-20260901-v1` checkpoint. It must not replace or mutate any of the 6 exact published candidates, reuse Gemini candidate fingerprints for Chirp output, or publish mixed-engine audio without an explicit engine decision.

## Account gate (human action)

Before any Chirp request:

- Enable Google Cloud Billing on the intended project.
- Enable the Cloud Text-to-Speech API.
- Provision credentials usable by the isolated pilot.
- Confirm no production workflow secret or provider default is changed.

Pilot volume is expected to be only a few thousand Arabic characters; cost should be negligible and normally within the documented monthly free-character allowance, but billing enablement is still required by Google Cloud.

## Mandatory samples

Select from the preserved pending candidates using the latest raw evidence:

A. One real lexical error inside a short sentence.
B. Two or more real errors inside one repairable paragraph.
C. A segment that previously worsened after a Gemini stochastic regeneration trial.

Representation-only cases are excluded from the pilot because they belong to offline adjudication, not TTS evaluation.

## Measurements per sample

Record:

- articleId and source fingerprint
- exact source text
- Gemini baseline consensus errors
- Chirp consensus errors
- delta = Gemini baseline errors - Chirp errors
- Technical QA result
- splice click/overlap result
- whether an engine transition is perceptible in an A/B listening check

## Technical success rule

The three-sample pilot passes only when:

- no sample fails Technical QA;
- no sample worsens by 3 or more consensus errors;
- total delta across all three samples is positive;
- at least two samples improve;
- the third sample is no worse by more than one error.

Otherwise the pilot fails and Chirp is not enabled as a production repair engine.

## Voice/splice decision

- If the Gemini/Chirp transition is not perceptible in the splice test, Chirp may be considered as a secondary segment-repair engine.
- If Chirp is high quality but the transition is perceptible, do not mix engines inside one article. Chirp may only be considered for full-article regeneration of still-pending articles after a separate human product decision.
- If Chirp quality is materially worse, reject the engine.

## Gemini-only kill switch

After this specification is adopted, 20 additional successful Gemini TTS requests without publishing any newly exact article ends the Gemini-only strategy. It does not weaken any quality gate; it forces an engine-strategy review.

## Required decision record

After the pilot, create `docs/audio/MOTOR-DECISION.md` containing the three sample results, deltas, splice/listening result, selected engine mode (`chirp-segment-secondary`, `chirp-full-article-only`, or `reject-chirp`), and the human approval required before changing production defaults.
