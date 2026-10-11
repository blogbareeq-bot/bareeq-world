# Bareeq Audio Priority Policy v1 — New Content Before Renewal

**Status:** Owner-approved operating policy  
**Effective:** 2026-10-08  
**Owner instruction:** `اجعل صوت المقالات الجديدة أولا في مسار الصوت (الجديد قبل التجديد)`

## Decision

Any published article that has **no live audio manifest** has synthesis priority over renewal, repair, replacement, or quality-upgrade synthesis for an article that already has live audio.

The rule is:

> **First audio for new content → then legacy renewal.**

## Definitions

- **New-content audio:** a published, non-draft article with no live manifest at `public/audio/articles/<audioKey>/manifest.json`.
- **Legacy renewal:** any TTS synthesis for an article that already has live audio, including fallback replacement, voice refresh, exactness repair, or quality upgrade.
- **Zero-TTS work:** offline adjudication, ASR analysis of existing evidence, technical QA, human review, validation, and publication of an already-generated approved candidate.

## Enforcement

1. If one or more new published articles have no live audio, **legacy TTS generation is blocked**.
2. New articles are ordered FIFO by `publishedAt`; the oldest waiting new article is the next synthesis target.
3. Zero-TTS work on legacy articles may continue because it does not consume synthesis quota.
4. Already-exact published audio remains immutable unless a separate owner-approved policy changes that rule.
5. This priority rule does **not** authorize new TTS quota, unfreeze synthesis, extend thresholds, or bypass speech-script/listening/ASR/technical gates.
6. When synthesis is next explicitly authorized, the first authorized requests must go to the new-content queue before legacy renewal.

## Current application

The article `هل-سرقت-الشاشه-تركيزنا-لماذا-لم-نعد-نحتمل-الدقائق-الفارغه` is the first new-content candidate while it remains published without live audio. Its speech script must pass the normal linguistic/pronunciation review before generation.

## Machine enforcement

- `scripts/audio-priority-guard.mjs --target=<articleId>` blocks legacy `generate-candidate` while new content waits.
- `scripts/audio-priority-guard.mjs --allow-legacy` blocks the scheduled legacy progressive-repair lane while new content waits.
- Validation/publication of already-generated legacy candidates is not blocked by this policy.

## Bounded owner exception — 2026-10-11

The owner approved `TTS-THRESHOLD-AMENDMENT-42.json`: exactly two fixed whole-context repairs, `REPAIR2-S` and `REPAIR2-C1`, may precede the new-content queue. This exception is enforced by `audio-tranche42-policy.mjs`; it does not authorize retries, full new-article synthesis, general legacy renewal, or alteration of the thirteen published Exact recordings. The ordinary priority guard and global freeze remain active outside these two one-shot dispatches. Owner listening of the new repaired contexts is required before final publication.

