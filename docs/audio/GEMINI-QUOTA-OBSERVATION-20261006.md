# Gemini API quota observation — 2026-10-06

**Source:** owner-provided Google AI Studio / Gemini API Rate Limit dashboard screenshot  
**Project shown:** Bareeq TTS  
**Tier shown:** Free tier  
**Dashboard range:** 28 days

This document is an **observational planning snapshot**, not runtime configuration.
The dashboard states that the values are peak usage per model compared with the
limit over the selected 28-day range; they are not interpreted as the exact
remaining allowance at this moment.

## Observed dashboard values

| Model | RPM shown | TPM shown | RPD shown |
|---|---:|---:|---:|
| Gemini 3.5 Transcribe | 4 / 3 | 27.7K / 10K | 30 / 25 |
| Gemini 3.1 Flash TTS | 2 / 3 | 1.77K / 10K | 24 / 10 |
| Gemini 3.5 Flash Lite | 4 / 15 | 27.31K / 250K | 51 / 500 |

## Project interpretation

1. TTS's scarce free-tier dimension is request count per day, not observed token throughput.
2. Gemini 3.5 Transcribe is the most constrained ASR resource in the snapshot.
3. Gemini 3.5 Flash Lite has substantially more observed headroom.
4. The repository already uses `gemini-3.5-flash-lite` together with
   `gemini-3.5-transcribe` as the production independent-ASR pair, so no model
   switch is justified from this dashboard alone.
5. Human Triage must reuse retained raw ASR/adjudication evidence and make **0 new
   ASR calls**.
6. Repository strategy `29/30` is an internal kill-switch and is independent of
   provider Free-tier RPD.

No quota number in this file may be treated as a permanent API contract. Re-check
the provider dashboard/documentation before any later provider-budget decision.
