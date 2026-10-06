import assert from 'node:assert/strict';
import { auditWorkflow, triggersFromWorkflow } from './audio-workflow-trigger-audit.mjs';

const manual=`name: Gate 4 scientific
on:
  workflow_dispatch:
jobs:
  pilot:
    steps:
      - run: echo GATE4_SCIENTIFIC_RUN=1
`;
assert.deepEqual(triggersFromWorkflow(manual),['workflow_dispatch']);
assert.equal(auditWorkflow('audio-gate4-calibration.yml',manual).errors.length,0);

const badPr=`name: Gate 4 scientific
on:
  pull_request:
  workflow_dispatch:
jobs:
  pilot:
    steps:
      - run: python scripts/audio-gate4-whisperx-pilot.py
`;
assert.match(auditWorkflow('audio-gate4-bad.yml',badPr).errors.join(' '),/pull_request/);

const badPush=`name: Gate 4 scientific
on: [push, workflow_dispatch]
jobs:
  pilot:
    steps:
      - run: echo GATE4_SCIENTIFIC_RUN=1
`;
assert.match(auditWorkflow('audio-gate4-inline.yml',badPush).errors.join(' '),/push/);

const ordinary=`name: governance
on:
  pull_request:
jobs:
  check:
    steps:
      - run: node scripts/audio-gate4-governance.mjs
`;
assert.equal(auditWorkflow('audio-recovery-governance.yml',ordinary).scientific,false);
assert.equal(auditWorkflow('audio-recovery-governance.yml',ordinary).errors.length,0);

console.log('Audio workflow trigger audit tests passed: scientific Gate 4 is workflow_dispatch-only.');


const dryPlan=`name: offline speech plan
on:
  pull_request:
jobs:
  verify:
    steps:
      - run: BAREEQ_TTS_PROVIDER=azure node scripts/generate-audio.mjs --sync-plan
`;
assert.equal(auditWorkflow('verify-offline.yml',dryPlan).providerCapable,false);

const realProvider=`name: provider
on:
  schedule:
    - cron: '0 0 * * *'
jobs:
  run:
    env:
      GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
    steps:
      - run: node scripts/audio-gemini.mjs
`;
const realRow=auditWorkflow('provider.yml',realProvider);
assert.equal(realRow.providerCapable,true);
assert.equal(realRow.warnings.length,1);
