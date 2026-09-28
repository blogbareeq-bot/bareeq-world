# Bareeq OpenRouter Sadaltager pilot decision

Status: **PENDING LIVE PILOT — NO PRODUCTION ACTIVATION AUTHORIZED**

Engine under test:

- provider: OpenRouter
- model: `google/gemini-3.1-flash-tts-preview`
- voice: `Sadaltager`

Required evidence before any production integration:

1. Zero-cost key probe succeeds.
2. Three locked samples are generated only by manual live dispatch.
3. Technical QA passes on all three samples.
4. Independent Dual-ASR evaluation completes on all three samples.
5. The encoded delta decision rule passes.
6. The resulting artifact is reviewed before a separate production-integration PR is opened.

Decision fields after live pilot:

- Key probe status: **PENDING**
- Live generation status: **PENDING**
- Technical QA: **PENDING**
- Dual-ASR: **PENDING**
- Total delta: **PENDING**
- Production integration decision: **NOT AUTHORIZED**

A passing pilot does not modify the seven exact articles and does not itself authorize publishing or changing the production synthesizer.
