# Bareeq Audio Recovery Decision v1

**Status:** Approved execution policy  
**Scope:** Current Sadaltager completion campaign  
**Effective date:** 2026-10-05  
**Canonical production state at approval:** 7/15 exact, 8 fallback, 29/30 successful TTS requests since the last new exact publication  
**Evidence run:** `37284619084`  
**Evidence artifact:** `bareeq-progressive-validation-37284619084` (artifact id `11334211844`, retained through 2027-01-03)

## 1. Decision

The project is no longer allowed to spend synthesis requests as a default debugging mechanism.

Three rules are now policy:

1. **No TTS request may leave the repository unless the experiment can produce new information even if the audio candidate fails.**
2. **If the problem can be solved by correctly reinterpreting existing evidence, audio regeneration is prohibited.**
3. **If the available evidence is insufficient for a decision, that insufficiency is recorded as a formal result; no technical conclusion or synthesis decision may be invented without evidence.**

The current provider state is frozen until Gates 0–4 below are satisfied and Gate 5 authorizes one explicit action.

## 2. Success definitions

### Long-term program goal
`15/15 Verified Exact/Equivalent Quality`.

This remains the long-term product target.

### Verified Exact vs Equivalent Quality

**Verified Exact** means the current canonical publication gate passes exactly: 0 substitutions, 0 deletions, 0 insertions, 0 unresolved, plus Technical QA, sync/fingerprint checks, and bound full-file SHA.

**Equivalent Quality** is a separate long-term product classification that may only be used when calibrated non-ASR evidence plus the required human arbitration proves the spoken result equivalent in quality and meaning. It does **not** silently become Exact and does **not** change the current campaign accounting without a separate owner-approved policy change.

### Current completion campaign
The active campaign contains:
- 7 already-exact immutable articles.
- 7 active pending articles.
- 1 intentionally excluded/frozen article: `اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع`.

Therefore the current campaign may close at **14/15 exact + 1 intentionally excluded**. That closes the current campaign only; it does **not** claim the long-term 15/15 program goal has been achieved.

The excluded article keeps its safe fallback and may only re-enter through a separately approved mini-campaign.

## 3. Exactness and immutability

The existing exact publication gate remains:

- substitutions = 0
- deletions = 0
- insertions = 0
- unresolved = 0
- Technical QA passes
- sync/fingerprint checks pass
- published audio identity is bound to fingerprint and full-file SHA-256

The seven already-exact articles are immutable for this recovery campaign. Validator research may read them as a calibration set, but it must not rewrite audio, fingerprints, SHA values, or publication status.

## 4. Strategic threshold

`30/30` is an internal strategy kill-switch, not a permanent technical limit of Gemini.

Current state:
- threshold: 30
- successful TTS since last new exact: 29
- exact baseline: 7

A 429, transport failure, or request that never successfully synthesizes audio does not count as a successful TTS request.

Raising the threshold requires both:
1. Explicit approval from the project owner.
2. A written technical justification explaining what new information the extension can produce, why prior attempts failed, why the next experiment is materially different, and the exact number of additional successful requests authorized.

Extensions must be bounded tranches (normally no more than 3 successful requests). Open-ended extensions are prohibited.

## 5. Gate 0 — Provider freeze

### Required state
- No scheduled or push-triggered workflow may synthesize audio.
- Push and pull-request workflows may run offline tests only.
- Manual/live provider workflows must respect the repository TTS freeze guard.
- Provider freeze must be testable in CI.
- Strategy remains 29/30.

### Exit condition
A repository audit proves that automatic synthesis is impossible while the freeze is active.

## 6. Gate 1 — Operational truth and governance

`docs/audio/PROGRESSIVE-STATUS.json` is the canonical publication/status snapshot.

Required invariants:
- status exact/published/fallback counts are internally consistent.
- exact rows in status match the partial publication marker by article id, fingerprint, and full SHA.
- strategy `exactBaseline` equals the current exact milestone unless a documented transition is in progress.
- baseline metrics and rejected-trial metrics are separate fields.
- the repair-session report must not claim zero provider calls when the run log proves successful synthesis.
- provider and transport names must describe current execution rather than historical campaign naming.
- any workflow with TTS or publish authority is explicitly identified.

### Exit condition
`audio-state-consistency.mjs` passes and CI includes it as an offline gate.

## 7. Gate 2 — Differential forensics for run 37284619084

No TTS is permitted to recreate missing evidence.

Evidence to recover from retained artifacts, caches, logs, or checkpoints where available:
- baseline full audio
- rejected trial full audio
- replacement clip
- splice boundaries
- raw ASR outputs
- adjudicated ASR outputs
- technical/sync metadata

The known verified micro-cut was:
- article: predictive-search
- cut: 38.355–41.985 seconds
- both preflight transcripts: `هل تعتمد التوقعات على بيانات الشخصية؟`
- baseline score: 1
- rejected trial score: 4
- rollback: successful

### Operational classifications

#### `ASR_CONTEXT_INSTABILITY`
PCM/waveform outside the splice guard band is unchanged, while ASR output changes outside that unchanged region.

Action: fix validator; **0 TTS**.

#### `REPRESENTATION_MISMATCH`
The acoustic content is acceptable and the mismatch is a proven textual/orthographic representation issue.

Action: offline adjudication; **0 TTS**.

#### `SPLICE_EFFECT`
New acoustic or ASR problems concentrate at the splice/transition guard band.

Action: repair splice/boundary/crossfade technique before any synthesis decision.

#### `TRUE_TTS_REGRESSION`
The replacement region itself contains a new pronunciation/lexical/acoustic regression attributable to the synthesized candidate.

Action: a new TTS or alternate-engine experiment may be justified only after Gate 5 approval.

#### `TRUE_BASELINE_LEXICAL_ERROR`
The current baseline contains a real spoken lexical error in a precisely identified region.

Action: targeted synthesis may be justified after Gate 5 approval.

#### `MIXED_CAUSE`
More than one independently supported cause is present.

Action: remove non-TTS causes first; no synthesis until the TTS-specific component is isolated.

#### `INSUFFICIENT_EVIDENCE`
Required artifacts are unavailable or cannot establish causality.

Action: recover evidence or use human arbitration/validator research. Do not spend TTS merely to recreate the incident.

### Exit condition
`docs/audio/FORENSICS-37284619084.md` records one of the classifications above with reproducible evidence.

## 8. Gate 3 — Adjudication v5, offline only

Scope: **7 active pending articles only**. The excluded morning article is not part of this gate.

Rules:
- synthesis representation remains unchanged.
- verification representation is separate.
- no fingerprint change.
- every equivalence rule must be narrow, deterministic, versioned, documented, and tested.
- each new rule requires positive cases and negative controls.
- no fuzzy synonym, stemming, or broad prefix rule may convert a real lexical error into Exact.

A rule is "narrow" when it describes a specific declared representation transformation and cannot affect tokens outside that transformation.

### Exit condition
All available raw ASR evidence for the seven active pending articles has been re-adjudicated; every accepted equivalence has tests; remaining mismatches are explicitly classified.

## 9. Gate 4 — Validator v5 research

The bounded execution contract is `docs/audio/GATE-4-VALIDATOR-RESEARCH-v1.md` and the resource cap is `docs/audio/GATE-4-BUDGET.json`.

Gate 4 is explicitly time/resource bounded. Missing its review deadline does **not** lift the freeze; the project remains fail-closed until the owner reviews continuation.

Dual-ASR is not removed by default. Validator v5 adds independent evidence:

`expected spoken text -> canonical verification text -> Arabic phonetic/G2P representation -> forced alignment -> word/segment confidence -> independent ASR -> adjudication -> human arbitration only at genuine conflict`

### Calibration requirements
- the seven exact articles are read-only positive calibration cases.
- historical true audio errors remain negative controls.
- known representation-only differences are handled correctly.
- failure to align is not an automatic audio failure; it routes to arbitration/research.
- a validator that breaks accepted exact audio or passes known true errors remains research-only and cannot replace v4.

### Exit condition
Validator v5 either demonstrates improved discrimination on positive and negative controls, or is explicitly rejected with evidence. Detailed PASS / PARTIAL / FAIL criteria are defined in the Gate 4 contract. Gate 4 failure does not authorize TTS, threshold extension, or a redefinition of Exact.

## 10. Human arbitration

Human review is a dispute resolver, not a bypass for technical QA. The operational policy is `docs/audio/HUMAN-ARBITRATION-v1.md` and the active queue is `docs/audio/HUMAN-ARBITRATION-QUEUE.json`.

The reviewer receives:
- expected text
- phonetic expectation when needed
- a short audio clip
- short context before/after
- exact disagreement location

First-pass review should hide ASR verdicts where practical to reduce anchoring bias.

Allowed outcomes:
- `EXPECTED_PRONUNCIATION_CONFIRMED`
- `ACTUAL_AUDIO_ERROR`
- `REPRESENTATION_EQUIVALENT`
- `INCONCLUSIVE`

Each decision is bound to:
- audio SHA
- timestamps
- validator version
- decision date

If the first decision is `INCONCLUSIVE`, a second independent Arabic-competent reviewer is required. If the two reviewers conflict, no override is allowed and the case remains unresolved.

Human arbitration cannot override a proven damaged/corrupt audio file or a failed Technical QA gate.

## 11. Gate 5 — synthesis decision

The binding entry/decision contract is
`docs/audio/GATE-5-DECISION-CRITERIA-v1.md`.

Gate 4 classification semantics are defined in
`docs/audio/GATE-4-CLASSIFICATIONS-v1.md`.

The remaining full-calibration run is prepared in
`docs/audio/GATE-4-CALIBRATION-PLAN-v1.md` but is **not authorized** by this policy.



Only after Gates 0–4:

| Proven result | Required action |
|---|---|
| Representation mismatch | Offline adjudication; no TTS |
| ASR context instability | Validator fix; no TTS |
| Splice effect | Repair algorithm fix; re-evaluate |
| True baseline lexical error | Controlled targeted TTS may be approved |
| True TTS regression | Controlled TTS or alternate engine may be approved |
| Engine-specific weakness | Isolated alternate-engine pilot |
| Mixed cause | Remove non-TTS causes first |
| Insufficient evidence | Evidence recovery / arbitration; no TTS |

The 30th successful synthesis request is not automatically spent. It is used only if Gate 5 documents why that request can answer a specific unresolved question.

## 12. Alternate engines and Generate-Select

Generate-Select remains on the roadmap but is not authorized against the current 29/30 Gemini strategy state.

It may be used after a separate budget/engine decision when:
- paid quota is explicitly bounded, or
- an independent quota exists, or
- a local engine has passed acoustic quality trials.

PR #37 remains **Draft / Frozen / No Merge**. Useful architecture may later be extracted in small, independently tested PRs.

## 13. GitHub Actions and cost

Gate 4 is capped at 0 TTS requests, $0 paid API budget, 4 research workflow runs, 45 minutes per run, and 180 aggregate runner minutes unless the owner explicitly approves a bounded amendment. Research artifacts retain for 30 days; rejected-trial diagnostics retain for at least 90 days.

Infrastructure optimization is not a prerequisite for Gate 2.

Before any paid-engine or multi-candidate strategy is adopted, document:
- cost per generated candidate
- expected candidates per new exact article
- artifact storage cost/limits
- Actions runtime/storage constraints
- whether heavy audio work should move to a dedicated worker

## 14. Non-negotiable safety constraints

- No mutation of existing seven exact audio files.
- No silent provider/model/voice switch.
- No automatic threshold extension.
- No automatic publication of a non-exact candidate.
- Rejected trials must preserve diagnostic evidence before rollback wherever technically possible.
- Existing fallback remains live until a replacement passes the approved gate.


## 15. Owner-approved bounded amendment — 2026-10-07

Owner instruction: `ارفع الحد إلى 33`. The strategic threshold is now **33**, with **30** successful requests already consumed and exactly **3** additional successful requests authorized in `TTS-THRESHOLD-AMENDMENT-33.json`.

The three named targets are the soft-power omitted question, intuition reference 11, and satellites قوى. Each target receives at most one successful request, after audio-bound micro-repair preflight. This amendment authorizes no automatic provider dispatch, no whole-part regeneration, no automatic retries, no further Gate 4 research, and no lowering of Exact/publication gates. The global TTS freeze remains active outside the scoped execution route. Existing nine Exact audio identities remain immutable. Historical Gate 5 passports authorization remains consumed.

The current completion goal includes all 15 articles as directed by the owner. Morning review may proceed as a separate preflight mini-campaign; no morning TTS request is included in this three-request allowance. New Exact publications do not replenish the three-request allowance. Any unverified or rejected successful generation still consumes its request.
