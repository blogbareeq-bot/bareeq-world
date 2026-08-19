# Bareeq V4.20.0 — Test Report

## Baseline
- Source baseline: commit `77306a99b8483f8c9656d2b4b9d409e94c26da30`.
- The user-provided Cloudflare log for that baseline completed build, audits, asset upload, and deployment successfully.

## V4.20.0 package tests executed locally
- `node --check` — PASS for all four V4.20.0 scripts.
- V4.20 preparation patch fixture — PASS.
  - article body lock verified.
  - speech-review registration verified.
  - Hamed-only manifest compatibility patch applied.
  - cache-only guard applied.
  - Azure Hamed-only request/cost accounting patch applied.
- Release-gate fixture with 13 live posts — PASS.
- Audio orchestrator mock, Gemini success path — PASS.
  - Gemini complete => Azure fallback not called.
- Audio orchestrator mock, Gemini unavailable/deferred path — PASS.
  - no complete Gemini manifest => Azure Hamed fallback called for coworker article only.
- Production voice audit mock — PASS.
- Coworker cover: 1600×900 WebP — verified.
- Thumbnail source matches the cover basename — verified.
- Coworker article contains no currently locked high-risk Arabic homographs requiring a new contextual pronunciation override.
- ZIP integrity — verified after packaging.

## Audio safety policy verified
Existing audio:
- Seven V4.19 changed articles: production-cache restore only.
- `ai-agents-future-now` Sadaltager: production-cache restore only.
- No old article is passed to a synthesis fallback in the V4.20 runner.

Coworker article:
1. Gemini provider checks production cache automatically.
2. If no matching cache exists, Gemini Sadaltager is attempted.
3. A complete Gemini manifest + MP3 set is required to count as success.
4. If Gemini does not complete atomically, Azure Hamed is attempted for the coworker article only.
5. Azure checks production cache before live synthesis.
6. If both providers fail to leave complete audio, the build fails closed.

Estimated article partition using the production splitting rules:
- Gemini (2400-byte request target): 10 parts / about 11.6k spoken source characters.
- Azure Hamed fallback (6000-byte target): 4 parts / about 11.6k spoken source characters.

## Not consumed during package testing
- No real Gemini request was sent.
- No real Azure synthesis request was sent.
- No Cloudflare deployment was triggered by package creation.

## Production acceptance
The final acceptance test is the first Cloudflare build after one Push. Do not manually queue duplicate deployments. Review the build log before any additional redeploy.
