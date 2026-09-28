# Chirp 3 HD / Sadaltager pilot readiness

Generated for the isolated Bareeq audio-engine experiment. This is not a production activation record.

## Completed in repository

- [x] Current production state re-read before pilot preparation: 7/15 exact published, 8 fallback.
- [x] Current Arabic Dual-ASR adjudication policy retained; no gate weakened.
- [x] Gemini-only kill switch retained at 20 successful TTS requests without a new exact publication.
- [x] Three representative production samples locked to current speech-script segment IDs and approved spoken text.
- [x] Chirp engine identity locked to Google Cloud Text-to-Speech / Chirp 3 HD / `ar-XA-Chirp3-HD-Sadaltager`.
- [x] Pilot fingerprint includes engine identity and sample identity.
- [x] Default pilot mode makes zero provider calls.
- [x] Live generation requires an explicit activation flag plus Google Cloud project and credentials.
- [x] Pilot files are written only to `chirp-pilot-artifacts/`; `public/audio` publication is forbidden.
- [x] Independent Gemini Dual-ASR evaluation uses the existing two production ASR model identifiers.
- [x] Technical QA checks decoding, duration, loudness, true peak, edge silence and internal silence.
- [x] Automated decision thresholds are encoded and regression-tested.
- [x] Engine switch remains blocked behind `MOTOR-DECISION.md` human review.

## External account gate — not executable from repository code

The live provider call remains blocked until the account owner completes/validates:

- [ ] Google Cloud Billing is active for the chosen project.
- [ ] Cloud Text-to-Speech API is enabled.
- [ ] A least-privilege service account is available.
- [ ] GitHub Actions secret `GOOGLE_CLOUD_PROJECT` is set.
- [ ] GitHub Actions secret `GOOGLE_SERVICE_ACCOUNT_JSON` is set.

`GEMINI_API_KEY` is already required by the production audio workflow and is used here only to verify the three generated samples with independent Dual-ASR.

## Live execution contract

After the external account gate is complete, manually run **Bareeq Chirp 3 Sadaltager pilot** with `execute_live=true`.

The workflow will:

1. Re-run the offline contract tests.
2. Generate exactly three isolated Chirp samples.
3. Run technical QA on each sample.
4. Run both independent ASR models and apply the current Bareeq adjudication policy.
5. Calculate `delta = baselineErrors - chirpErrors` and apply the locked decision rule.
6. Upload all evidence as a GitHub Actions artifact.
7. Stop at the human A/B splice-review gate even if the technical pilot passes.

It will **not** commit or publish audio, edit `public/audio`, replace a live manifest, regenerate any exact article, or activate Chirp in the production campaign.
