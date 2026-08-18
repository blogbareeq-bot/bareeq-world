# V4.19.0 Replacement Package Validation

- Package mode: direct copy + replace over V4.18.2.
- Baseline commit: `f2693d8a8097a30a52d8178dbcb8300c7703abd8`.
- Local Node.js: **not required** for the user workflow.
- Cloudflare build preparation: automatic via `scripts/prepare-v4190.mjs`.
- Changed/new live articles: **7**.
- Intuition cover + thumbnail source: **1600×900**.
- Stale bundled Azure/Studio fallbacks for changed article IDs: explicitly skipped before regeneration.
- Hamed regeneration: targeted to changed IDs only.
- Gemini: progressive full-library Sadaltager upgrade with production cache reuse.
- Fail-closed: Azure/Hamed generation failure stops deployment before Astro publish.
- `prepare-v4190.mjs`: Node syntax check **PASS**.
- `reading-list.js`: Node syntax check **PASS**.
- Installer compatibility fixture: all expected V4.18.2 patch anchors applied successfully **PASS**.
- ZIP integrity: **PASS** (`unzip -t`, no errors).
- Static package validation errors: **0**.

## Important production gate

A complete production build cannot be executed in this environment because the encrypted Azure/Gemini secrets and the full binary/audio repository are only present in the actual deployment environment. The build is intentionally fail-closed: Cloudflare must complete the Azure Hamed generation for all changed/new articles before it can publish V4.19.0.
