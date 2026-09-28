# OpenRouter Sadaltager pilot cost boundary

The live pilot is intentionally capped at exactly three short production-derived samples.

It uses OpenRouter's paid TTS route only when manually dispatched with `execute_live=true`. Pull-request CI and the automatic key probe perform no TTS inference.

The pilot does not purchase credits, enable auto top-up, or change account spending limits. If the account returns HTTP 402, the workflow stops and records the credit blocker instead of retrying paid inference.

Model under test: `google/gemini-3.1-flash-tts-preview` with `Sadaltager`.
