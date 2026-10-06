# Gate 4 Scientific Pilot #1 — Result

**Date:** 2026-10-06  
**Primary authorized run:** `37419623624`  
**Primary artifact:** `bareeq-gate4-approved-recovery-37419623624`  
**Primary artifact id:** `11392387341`  
**Scientific result:** `PILOT_PASS`  
**TTS calls:** 0  
**Paid API calls:** 0  
**External ASR provider calls:** 0  
**Production audio mutation:** none  
**Campaign state:** unchanged at 7/15 Exact, 8 fallback, strategy 29/30.

## 1. Infrastructure smoke

The owner-approved infrastructure recovery passed before any scientific comparison:

- ffmpeg: `/usr/bin/ffmpeg`
- torch: `2.8.0+cpu`
- torchvision: `0.23.0+cpu`
- torchaudio: `2.8.0+cpu`
- WhisperX: `3.8.6`
- Arabic alignment model: `jonatasgrosman/wav2vec2-large-xlsr-53-arabic`
- Arabic model load: PASS
- retained MP3 decode: PASS
- decoded control audio: 141.504 seconds

The historical infrastructure blocker is closed.

## 2. Scientific pilot criteria

All approved pilot criteria passed:

- 2 Exact controls processed: PASS
- 2 one-error pending controls processed: PASS
- Exact alignment coverage >=95%: PASS (both 100%)
- deliberate lexical negative controls detected: PASS
- both pending mismatches localized: PASS
- `public/audio` unchanged: PASS

Overall:

`GATE4_WHISPERX_PILOT=PASS`

Calibrated positive-control 5th percentile alignment score:

`0.6114`

## 3. Exact controls

### «لا تبحث عن شغفك… ابنِه»
- coverage: 1.000
- mean alignment score: 0.8950
- negative control: `اقرأ -> مختلفة`
- original token score: 0.995
- negative token score: 0.684
- degradation: 0.311
- detected: yes

### «حين يصبح الذكاء الاصطناعي زميلًا لا أداة»
- coverage: 1.000
- mean alignment score: 0.9092
- negative control: `بجملة -> مختلفة`
- original token score: 0.982
- negative token score: 0.703
- degradation: 0.279
- detected: yes

These controls show that Stage A alignment preserves known Exact audio while
responding to deliberately incorrect expected lexical text.

## 4. One-error pending results

### اللياقة بعد الأربعين — `أقسى -> أقصى`

- coverage: 1.000
- mean alignment score: 0.8923
- expected token: `أقسى`
- localized: yes
- target alignment score: **0.859**
- Exact-control p05: **0.6114**
- diagnostic: **`VALIDATOR_AMBIGUITY`**

Interpretation:
The forced aligner localized and confidently aligned the expected written token.
This does not corroborate a clear acoustic error, and it also does not by itself
prove the ASR substitution is representation-only. The case routes to Human
Arbitration or additional independent evidence. No TTS is justified.

### توقعات البحث — `بياناتي -> بيانات`

- coverage: 1.000
- mean alignment score: 0.5655
- expected token: `بياناتي`
- localized: yes
- target alignment score: **0.367**
- Exact-control p05: **0.6114**
- diagnostic: **`AUDIO_ERROR_CANDIDATE`**

Interpretation:
The expected token aligns materially below the calibrated Exact-control lower tail,
while both independent ASR reports already agree on `بيانات`. This is meaningful
corroborating evidence that the baseline audio may omit the possessive suffix.

Forced alignment alone does not authorize synthesis. The case requires independent
corroboration or Human Arbitration before Gate 5 can consider a TTS action.

## 5. Trigger incident discovered after the authorized run

After the successful primary run, documentation commits were added to the same
PR. Because GitHub re-evaluates `pull_request.paths` against the full PR diff,
the scientific workflow retriggered even though the later commits were only
documentation/governance changes.

Observed follow-up runs:

- `37420013411`: governance blocked before the scientific step; does not count as a scientific run.
- `37420002259`: scientific duplicate completed successfully.
- `37420022897`: scientific duplicate completed successfully.

Both successful duplicates reproduced the primary result exactly:

- `p05 = 0.6114`
- fitness = `VALIDATOR_AMBIGUITY`
- predictive-search = `AUDIO_ERROR_CANDIDATE`
- `public/audio` unchanged
- TTS calls = 0
- paid API calls = 0

The duplicate scientific runs are retained as reproducibility evidence only.
They do not broaden the approved decision scope.

Containment:
- PR #65 was closed without merge.
- future scientific Gate 4 workflows are manual-only;
- `push` and `pull_request` scientific triggers are prohibited;
- documentation commits must never retrigger scientific compute.

## 6. Budget accounting

The governance accounting is intentionally conservative:

- infrastructure recovery: **1/1 consumed**
- scientific runs reaching alignment comparison: **3/4 consumed**
  - 1 authorized primary
  - 2 unauthorized duplicate retriggers, counted because they reached the scientific step
- additional scientific runs currently authorized: **0**
- remaining scientific capacity: **1**, unavailable without a new explicit owner decision

## 7. Human Arbitration queue

Two localized disputes are queued in
`docs/audio/HUMAN-ARBITRATION-QUEUE.json`:

1. `أقسى / أقصى` — `VALIDATOR_AMBIGUITY`
2. `بياناتي / بيانات` — `AUDIO_ERROR_CANDIDATE`

Neither case authorizes TTS at this stage.

## 8. Final Gate 4 state

`GATE_4=PILOT_PASS_CORROBORATION_REQUIRED`

- TTS freeze remains active.
- request 30/30 remains unused.
- Gate 5 is not entered.
- no article is promoted to Exact by forced alignment alone.
- no additional scientific workflow is authorized automatically.
