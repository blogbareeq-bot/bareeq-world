# Gate 5 Experiment Plan — Passports v1

**Status:** PREPARED / NOT AUTHORIZED  
**Canonical state:** 9/15 Exact, 6 fallback  
**TTS strategy:** 29/30  
**Successful TTS requests authorized:** 0  
**Successful TTS requests required for this experiment:** 1

## Target

- Article: **لماذا تفتح بعض جوازات السفر أبواب العالم أكثر من غيرها؟**
- Article ID: `why-some-passports-are-stronger`
- Human Triage case: `T03`
- Confirmed defect: expected token **«لا»** is missing.
- Part: **4**
- Synchronized segment: `b0030`
- Baseline fingerprint: `2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b`
- Baseline full SHA-256: `597168624f702c027ede0c2a719de337149f853822ef634a715c840873703dd8`
- Baseline part SHA-256: `09b0253960eb4d5c2da1c8af50ed0e87f373b7ca030d14c09d99533ad8e68ae4`

The exact synchronized source text is:

> لا. السياسة حاضرة بقوة، لكنها خيط واحد في نسيج أوسع يشمل الاقتصاد والأمن والهجرة والسياحة والتجارة، وحتى العلاقات التاريخية واللغوية بين الشعوب.

## Why this target is first

The completed Human Triage leaves five active defective articles. Passports has the smallest confirmed repair surface:
- one defect cluster;
- one synchronized segment;
- one generated part;
- one confirmed missing lexical token;
- a binary success criterion: **«لا» is present or it is not**.

The next closest candidates have higher repair risk: numeric normalization for 11→12, close phonetic morphology for قوى→قوة, a five-token omission, or three separate segments/parts.

## Experiment

If and only if the project owner explicitly authorizes **1 successful TTS request**:

1. Restore the immutable candidate from retained evidence.
2. Prove the baseline fingerprint, full SHA, part SHA, Technical QA and sync binding.
3. Isolate part 4 / segment `b0030`; do not regenerate the whole article.
4. Use one targeted Sadaltager synthesis with this correction instruction:

> Read only the approved transcript. Clearly pronounce and preserve the word «لا». Do not omit it, paraphrase it, or change surrounding words.

5. Preserve the generated replacement and trial candidate outside `public/audio`.
6. Run fresh production Dual-ASR on the changed candidate plus Technical QA, sync QA and identity checks.
7. Publish only if the resulting candidate is exactly:
   - substitutions = 0
   - deletions = 0
   - insertions = 0
   - unresolved = 0
8. If any gate fails, retain the rejection evidence and restore/keep the immutable baseline and current live fallback.

## What the request learns even if it fails

A rejected synthesis still answers a bounded engineering question: whether Sadaltager can preserve the confirmed missing negation **«لا»** in this exact localized context under a single targeted regeneration. That result is retained and prevents blind retrying.

## Budget and accounting

- Maximum successful TTS requests: **1**
- Current authorization: **0**
- A successful provider synthesis counts as request **30/30 whether accepted or rejected**.
- A 429 or transport failure does not count as a successful TTS request.
- No second synthesis is permitted by this plan.
- Fresh validation ASR is required for a changed candidate because the old ASR evidence is bound to the old full-file SHA.

## Publication / rollback

The existing 9 Exact publications and the current fallback remain untouched until the trial is independently certified. A failed or inconclusive trial cannot mutate `public/audio`.

This plan does not authorize TTS by itself. Authorization is represented separately in `docs/audio/GATE-5-AUTHORIZATION.json`.
