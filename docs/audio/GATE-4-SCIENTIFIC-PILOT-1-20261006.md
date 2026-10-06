# Gate 4 Scientific Pilot #1 — Result

**Date:** 2026-10-06  
**Run:** `37419623624`  
**Artifact:** `bareeq-gate4-approved-recovery-37419623624`  
**Artifact id:** `11392387341`  
**Scientific result:** `PILOT_PASS`  
**TTS calls:** 0  
**Paid API calls:** 0  
**Production mutation:** none  
**Campaign state:** unchanged at 7/15 Exact and 29/30 strategy.

## 1. Infrastructure smoke

The owner-approved infrastructure recovery succeeded.

- ffmpeg: `/usr/bin/ffmpeg`
- torch: `2.8.0+cpu`
- torchvision: `0.23.0+cpu`
- torchaudio: `2.8.0+cpu`
- WhisperX: `3.8.6`
- Arabic alignment model: `jonatasgrosman/wav2vec2-large-xlsr-53-arabic`
- Arabic model load: PASS
- retained MP3 decode: PASS
- decoded control audio: 141.504 seconds

The historical infrastructure blocker is therefore closed.

## 2. Pilot criteria

All approved pilot criteria passed:

- 2 Exact controls processed: PASS
- 2 one-error pending controls processed: PASS
- Exact alignment coverage >=95%: PASS (both 100%)
- lexical negative controls detected: PASS
- both pending mismatches localized: PASS
- `public/audio` unchanged: PASS

Overall:

`GATE4_WHISPERX_PILOT=PASS`

Positive-control 5th percentile alignment score:

`0.6114`

## 3. Exact controls

### «لا تبحث عن شغفك… ابنِه»
- coverage: 1.000
- mean alignment score: 0.8950
- negative control: `اقرأ -> مختلفة`
- original score: 0.995
- negative score: 0.684
- degradation: 0.311
- detected: yes

### «حين يصبح الذكاء الاصطناعي زميلًا لا أداة»
- coverage: 1.000
- mean alignment score: 0.9092
- negative control: `بجملة -> مختلفة`
- original score: 0.982
- negative score: 0.703
- degradation: 0.279
- detected: yes

These controls demonstrate that the Stage A alignment path can preserve known Exact
audio while responding to deliberately incorrect expected lexical text.

## 4. One-error pending results

### اللياقة بعد الأربعين — `أقسى -> أقصى`

- coverage: 1.000
- mean alignment score: 0.8923
- expected token: `أقسى`
- localized: yes
- target alignment score: **0.859**
- Exact-control p05: **0.6114**
- Gate 4 diagnostic: **`VALIDATOR_AMBIGUITY`**

Interpretation:
The forced aligner can localize and confidently align the expected written token.
This result does **not** corroborate a clear acoustic error. It also does not by
itself prove that the ASR substitution is representation-only. The case must be
resolved by Human Arbitration or additional independent evidence, not TTS.

### توقعات البحث — `بياناتي -> بيانات`

- coverage: 1.000
- mean alignment score: 0.5655
- expected token: `بياناتي`
- localized: yes
- target alignment score: **0.367**
- Exact-control p05: **0.6114**
- Gate 4 diagnostic: **`AUDIO_ERROR_CANDIDATE`**

Interpretation:
The expected token aligns materially below the calibrated Exact-control lower tail,
while both independent ASR reports already agree on `بيانات`. This is meaningful
corroborating evidence that the baseline audio may omit the possessive suffix.

However, the Gate 4 policy explicitly prohibits forced alignment alone from
authorizing synthesis or publication changes. This case must receive an independent
corroboration decision or Human Arbitration before Gate 5 can consider TTS.

## 5. Governance decision

- Infrastructure recovery budget: consumed **1/1**
- Scientific budget: consumed **1/4**
- Additional research run authorization: **0**
- TTS freeze: remains active
- request 30/30: remains unused
- Gate 5: not entered

Two localized cases have been placed in
`docs/audio/HUMAN-ARBITRATION-QUEUE.json`.

Current Gate 4 status:

`PILOT_PASS_CORROBORATION_REQUIRED`

No additional Gate 4 workflow may run automatically from this result.
