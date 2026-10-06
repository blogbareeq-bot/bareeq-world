# Full Human Triage — Ingested Result

**Package:** `triage-37284619084-83e2e3a7db`  
**Reviewer-result SHA-256:** `b9c228e77d3960c3d3b343062590b50eb59a3ec505dc73b6e8ecf5e90dffc2d2`  
**Result:** strong diagnostic signal, but not an automatic Exact/publication override.

## 1. Reviewer-control quality

All **7/7 blind Exact controls** were classified:

`EXPECTED_PRONUNCIATION_CONFIRMED`

No Exact control was called `ACTUAL_AUDIO_ERROR`.

This is a strong internal consistency check for this review pass.

## 2. Pending mismatch totals

Of the **29 active pending mismatches**:

- **16** were classified `EXPECTED_PRONUNCIATION_CONFIRMED`.
- **13** were selected as `ACTUAL_AUDIO_ERROR`.
- **0** were `REPRESENTATION_EQUIVALENT`.
- **0** were `INCONCLUSIVE`.

However, two of the 13 audio-error selections do **not** explicitly adjudicate the
target token:

### T06 — target `إذن`, automated `إذا`
Reviewer note:

`إحدى عشر تم قراءتها (إثنا عشر)`

That note describes the adjacent numeric defect already represented by T22, not
the T06 target. T06 therefore remains `TARGET_REVIEW_REQUIRED`.

### T31 — target `أقسى`, automated `أقصى`
Reviewer note:

`كلمة (برنامج) لم يتم نقطها جيدا بالتنوين`

That note identifies an incidental pronunciation-quality concern, but does not
explicitly decide `أقسى / أقصى`. T31 therefore remains
`TARGET_REVIEW_REQUIRED`. The `برنامج` note is retained as an incidental QA
finding and is not silently discarded.

After target-binding validation:

- **16** automated mismatches are human-confirmed false-positive/adjudication candidates.
- **11** target mismatches are human-confirmed audio errors.
- **2** targets require a short second-pass review.

## 3. Important article-level consequences

### Predictive-search article

The only remaining automated mismatch was T34:

`بياناتي -> بيانات`

The blind reviewer heard the expected `بياناتي` and chose
`EXPECTED_PRONUNCIATION_CONFIRMED`.

This directly contradicts the earlier Gate 4 `AUDIO_ERROR_CANDIDATE` signal and
shows why `0.6114` was correctly prohibited as a production threshold.

**Action:** offline adjudication candidate, **0 TTS**. It is not promoted to Exact
until the ordinary production gate is rerun with the approved human evidence.

### Soft-power article

Five token-level deletions (T15/T23/T25/T28/T36) all refer to one omitted phrase:

`ما علاقة اللغة بالقوة الناعمة`

They are one localized audio-defect cluster, not five independent synthesis
problems.

### Intuition article

Seven of nine mismatches were human-confirmed as expected pronunciation.
T22 confirms one real numeric defect: `11` was spoken as `12`.
T06 still needs target-specific review for `إذن / إذا`.

### Fitness article

The sole automated mismatch `أقسى / أقصى` was not explicitly adjudicated by the
review note. The reviewer instead flagged nearby `برنامج` pronunciation/tanween.
Both facts are preserved; no synthesis decision is made yet.

## 4. Confirmed localized audio-defect clusters

Current target-valid human evidence yields **7 distinct localized defect clusters**:

1. Passports — missing `لا`.
2. Intuition — `11` spoken as `12`.
3. Satellites — `قوى` spoken as `قوة`.
4. Touchscreen — `الشاشة` spoken as `الشاشات`.
5. Touchscreen — `به` spoken as `بها`.
6. Touchscreen — `إنه` spoken as `أنه`.
7. Soft power — omitted phrase `ما علاقة اللغة بالقوة الناعمة`.

This count is a diagnosis, not a TTS authorization.

## 5. Next action

1. Re-review only T06 and T31 with tighter target-centered clips.
2. Keep TTS frozen at 29/30.
3. Do not spend the last request.
4. After the two target reviews, apply binding human evidence offline and rerun the
   production Exact gate.
5. Only then evaluate Gate 5 for any remaining `ACTUAL_AUDIO_ERROR`.

Current state remains:

`7/15 Exact — 29/30 — Gate 5 CLOSED`
