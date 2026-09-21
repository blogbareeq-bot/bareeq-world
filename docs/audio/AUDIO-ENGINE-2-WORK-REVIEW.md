# Bareeq Audio Engine 2.0 — Work-mode review gate

Status: **review candidate only — do not merge or publish local-engine audio yet**.

## Objective

Remove TTS vendor lock-in without weakening Bareeq's existing publication gate. The existing dual-ASR, technical QA, sync QA, SHA-256 binding and publish-approved controls remain authoritative.

## What this branch adds

1. TTS engine registry/router with Gemini as the unchanged default and opt-in profiles for VoxCPM2, MOSS-TTS v1.5, and MOSS-TTS-Nano.
2. Commercial-license allow-list for the new local profiles. No OmniVoice non-commercial weights are registered.
3. Isolated worker contract instead of copying VoiceStudio/AGPL backend code into Bareeq.
4. Arabic synthesis normalizer that keeps canonical ASR text unchanged. The first versioned pronunciation entry protects: ببساطة → بِبَساطَة.
5. Content-addressed segment cache with engine + synthesis fingerprints, SHA-256 verification, cross-candidate reuse, and opt-in worker-call avoidance.
6. Optional local-ASR preflight that can reject a bad candidate before Gemini dual-ASR requests are spent.
7. Engine-bound evidence in candidate, merge and ASR reports.
8. Hard review lock: local-engine candidates cannot pass publish-approved unless BAREEQ_AUDIO_ENGINE_V2_PUBLISH=1 is explicitly set after review.
9. Gemini cache compatibility test: default Gemini candidate fingerprints must remain byte-for-byte identical to the pre-change formula.

## Intentionally not copied from VoiceStudio

Electron UI, dubbing, dictation, microphone handling, desktop packaging, VoiceStudio server code, and OmniVoice default non-commercial weights.

This branch borrows architecture concepts, not AGPL implementation code.

## Worker contract

A local/remote worker receives JSON schema bareeq.tts-worker.v1.

Required request fields include engine/model/language, canonical text, synthesis text, article/part identity, voice configuration and output settings.

The worker may return application/json with audioBase64 and mimeType, or raw audio bytes over HTTP.

Non-MP3 audio is normalized by Bareeq through ffmpeg to mono 48 kHz / 96 kbps MP3 before the existing validation pipeline.

## Activation variables

- BAREEQ_TTS_ENGINE=gemini|voxcpm2|moss-v15|moss-nano
- BAREEQ_LOCAL_TTS_ENABLE=1 for any non-Gemini engine
- per-engine endpoint or executable variables defined in audio-engine-config.mjs
- BAREEQ_VOICE_DESIGN_PROMPT for VoxCPM2 voice-design experiments
- BAREEQ_SEGMENT_CACHE_ENABLE=1 to enable local-engine segment reuse (off by default during review)
- BAREEQ_LOCAL_ASR_PREFLIGHT=1
- BAREEQ_LOCAL_ASR_BIN and optional BAREEQ_LOCAL_ASR_ARGS_JSON
- BAREEQ_AUDIO_ENGINE_V2_PUBLISH=1 only after owner review

## Work-mode review checklist

Ask Work mode to inspect the entire PR, not only this document.

It should verify:

- no change to successful live audio or public/audio/;
- Gemini fingerprint backward compatibility;
- no provider call in dry-run/offline tests;
- no local engine can publish while the review lock is off;
- local candidate engine must match validation engine;
- credentials cannot leak through worker error messages;
- path traversal and command injection risks;
- Arabic normalizer changes pronunciation only, not canonical ASR truth;
- segment cache validates hashes, cannot collide across engines, survives candidate fingerprint changes, and avoids repeat worker calls for unchanged segments;
- local-ASR failure occurs before dual-ASR network calls;
- existing 0/0/0 + unresolved=0 policy remains intact;
- AGPL VoiceStudio source was not copied;
- commercial engine allow-list is explicit;
- all existing audio safety regression tests stay green.

## Not yet certified

This branch does not claim acoustic quality for VoxCPM2/MOSS on Bareeq Arabic. Hardware/model synthesis trials and listening samples are a separate acceptance gate after code review.
