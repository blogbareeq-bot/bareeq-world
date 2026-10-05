# Adjudication v5 — Offline replay result

**Status:** Gate 3 complete  
**Run:** `37310949453`  
**Artifact:** `bareeq-adjudication-v5-37310949453`  
**Artifact id:** `11345374317`  
**Source evidence:** run `37284619084` / artifact `11334211844`  
**Provider calls:** 0  
**TTS freeze:** active

## Policy

Adjudication policy version: **5**

v5 is intentionally conservative:
- no new representation-equivalence rule was added;
- synthesis text is unchanged;
- fingerprints are unchanged;
- verification representation is comparison-only;
- all v4 narrow rules and negative controls remain;
- human-listening requirements are governed by the campaign publication policy, not hard-coded in the adjudicator.

## Scope

Seven active pending articles were replayed from immutable raw ASR evidence.  
`اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع` remained excluded/frozen.

## Results

| Article | Baseline | v5 | Exact | Representation-only | Model disagreements |
|---|---:|---:|---|---:|---:|
| كيف تعرف شاشة هاتفك أين وضعت إصبعك؟ | 5 | 5 | no | 0 | 34 |
| هل الحدس ذكاء خفي أم اختصار مضلل؟ متى نثق بشعورنا الأول؟ | 9 | 9 | no | 4 | 77 |
| حين تصبح اللغة نفوذًا: كيف تعبر القوة الناعمة الحدود؟ | 9 | 9 | no | 6 | 46 |
| لماذا تفتح بعض جوازات السفر أبواب العالم أكثر من غيرها؟ | 2 | 2 | no | 4 | 71 |
| اللياقة بعد الأربعين: قراءة عملية في كتاب دون نافا | 1 | 1 | no | 4 | 30 |
| كيف يتوقع محرك البحث ما ستكتبه قبل أن تكمله؟ | 1 | 1 | no | 1 | 10 |
| لماذا لا تسقط الأقمار الصناعية من السماء؟ | 2 | 2 | no | 0 | 34 |

## Gate 3 decision

`GATE_3=CLOSED newlyExactWithoutTts=0`

The currently approved representation-equivalence rules are exhausted against the retained raw ASR evidence.

No article may be promoted to Exact from this replay.

The next allowed work is Gate 4 validator research/calibration. TTS remains frozen at **29/30**.
