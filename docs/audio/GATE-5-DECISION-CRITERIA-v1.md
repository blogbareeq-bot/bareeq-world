# Gate 5 Synthesis Decision Criteria v1

**Status:** approved decision contract; Gate 5 is currently CLOSED  
**Current strategy:** 29/30  
**TTS freeze:** active  
**Automatic synthesis:** prohibited

## 1. Gate 5 entry conditions

A case may be presented to Gate 5 only when all of these are true:

1. The disputed region is precisely localized.
2. Gate 4 has produced a reproducible classification.
3. A claimed audio defect has independent corroboration or a binding Human
   Arbitration decision of `ACTUAL_AUDIO_ERROR`.
4. Technical QA does not show corruption/damage that should be fixed without TTS.
5. The seven current Exact publications remain unchanged.
6. The fallback for the target article remains safe and live.
7. Request 30/30 is still unused.
8. A written experiment plan states:
   - exact target article/segment;
   - hypothesis;
   - why existing evidence cannot resolve the issue offline;
   - what new information the request yields even if the generated audio fails;
   - success/failure criteria;
   - rollback and artifact-retention plan.
9. The project owner explicitly authorizes the exact number of successful TTS
   requests. Default authorization is zero.

If any condition is missing, Gate 5 stays closed.

## 2. Decision matrix

| Corroborated result | Gate 5 decision |
|---|---|
| `REPRESENTATION_EQUIVALENT` | Offline adjudication; **no TTS** |
| `VALIDATOR_AMBIGUITY` | More evidence / Human Arbitration; **no TTS** |
| `UNLOCATED` | Evidence recovery / arbitration; **no TTS** |
| `EXPECTED_PRONUNCIATION_CONFIRMED` | Validator/adjudication correction; **no TTS** |
| `ACTUAL_AUDIO_ERROR` | One targeted TTS experiment may be proposed |
| `INCONCLUSIVE` | Second independent reviewer or bounded validation research; **no TTS** |
| Technical corruption | Repair/recover file path first; **no TTS** |

## 3. If one TTS request is authorized

The request must be:
- target-specific;
- isolated from `public/audio`;
- no broader paragraph/part regeneration unless explicitly justified;
- preserved as a candidate even when rejected;
- compared against the immutable baseline;
- validated with Technical QA + existing production Dual-ASR + approved
  adjudication evidence.

A successful synthesis request counts as request 30/30 whether or not the candidate
is accepted.

A rejected candidate must never replace the live fallback.

Publication still requires the existing Exact gate:
- substitutions = 0;
- deletions = 0;
- insertions = 0;
- unresolved = 0;
- Technical QA / sync / fingerprint / SHA identity pass.

## 4. If TTS is not authorized

The safe alternatives are:
- keep the current fallback;
- resolve representation/validator issues offline;
- complete Human Arbitration;
- use the final scientific Gate 4 slot only under a separate explicit decision;
- later evaluate an alternate engine under a separately bounded budget.

"No TTS" is a valid Gate 5 decision.

## 5. No automatic expansion

A successful targeted experiment does not:
- unfreeze all TTS;
- raise the 30-request threshold;
- authorize Generate-Select;
- authorize another engine;
- permit automatic publication.

Each later synthesis action requires its own evidence and owner authorization.
