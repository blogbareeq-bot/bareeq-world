# Gate 4 Pilot Outcome — 2026-10-06

**Status:** `INFRASTRUCTURE_BUDGET_EXHAUSTED`  
**Scientific verdict:** `NOT_REACHED`  
**TTS calls:** 0  
**Paid API calls:** 0  
**Production audio mutation:** none  
**Canonical campaign state:** 7/15 Exact, 8 fallback, 7 active pending, 1 excluded  
**Strategy state:** 29/30  
**Pilot PR:** #62

## 1. Purpose

The approved Gate 4 pilot attempted to add a read-only Arabic forced-alignment
evidence stream for two immutable Exact controls and the two current one-error
pending candidates. It was explicitly forbidden from synthesizing audio or
mutating publication state.

The pilot was capped at four research workflow runs.

## 2. Run ledger

### Run 1 — `37417696932`
Result: `INTEGRATION_FAILURE`

- freeze/governance: PASS
- source artifact download: PASS
- 2 Exact + 2 pending segment preparation: PASS
- CPU alignment dependency installation: PASS
- alignment execution: NOT REACHED

Cause:
PyTorch was installed from the CPU index, while WhisperX later installed a
non-CPU-matched torchvision wheel from PyPI. Importing Wav2Vec2 failed at
`torchvision::nms`.

Remediation:
pin `torch==2.8.0`, `torchvision==0.23.0`, and `torchaudio==2.8.0` from the
same PyTorch CPU index.

### Run 2 — `37417896711`
Result: `INTEGRATION_FAILURE`

- matching CPU torch stack: PASS
- Wav2Vec2 / WhisperX import: PASS
- Arabic alignment model load: PASS
- alignment on campaign audio: NOT REACHED

Cause:
WhisperX's audio loader attempted to execute `ffmpeg`, but the runner did not
provide the command to the subprocess.

### Run 3 — `37418147860`
Result: `PREFLIGHT_FAILURE`

A fail-safe decoder was introduced, but the preflight assumed
`/usr/bin/ffmpeg`. The runner did not contain that executable.

The production-audio diff gate ran with `always()` and passed.

### Run 4 — `37418230047`
Result: `PREFLIGHT_FAILURE`

The preflight was changed to discover ffmpeg dynamically via
`command -v ffmpeg`. It returned empty, proving that ffmpeg is not available
in PATH on the active runner image.

The production-audio diff gate ran and passed.

## 3. Research interpretation

This is **not** evidence that Arabic forced alignment is inaccurate.

The pilot never reached the alignment comparison after the approved run budget
was consumed. Therefore none of the following may be claimed:

- that the two one-error baselines contain confirmed acoustic errors;
- that their ASR mismatches are validator instability;
- that WhisperX passes or fails the approved Exact/negative-control criteria.

The correct result is:

`SCIENTIFIC_VERDICT=NOT_REACHED`

## 4. Budget decision

The approved Gate 4 budget was 4 research workflow runs. All 4 are consumed.

Therefore:

- no fifth research run is authorized;
- PR #62 must not be merged as a validated Gate 4 implementation;
- TTS remains frozen;
- request 30/30 remains unused;
- Gate 5 is **not** entered.

## 5. Known bounded remediation

The next technical change is straightforward but is **not authorized under the
exhausted budget**:

1. explicitly install ffmpeg from the runner OS package repository;
2. retain the matching CPU torch / torchvision / torchaudio pin;
3. run the same unchanged 2 Exact + 2 pending pilot;
4. keep all original acceptance criteria.

If the project owner approves an amendment, the recommended amendment is exactly
**one additional Gate 4 research run**, not an open-ended extension.

## 6. Safety evidence

Across all four runs:

- provider TTS calls: **0**
- paid ASR/API calls: **0**
- `public/audio` mutation: **0**
- Exact audio/fingerprints/SHA: unchanged
- production status: unchanged
- strategy counter: unchanged at **29/30**

## 7. Decision

`GATE_4=BLOCKED_RESEARCH_BUDGET_EXHAUSTED`

The freeze remains active. The next step requires an explicit project-owner
decision: either authorize the one-run infrastructure amendment above, select a
different bounded local validation path, or close the current Gate 4 attempt
without a scientific verdict.
