import assert from 'node:assert/strict';
import { validateGate4Governance } from './audio-gate4-governance.mjs';

function fixture() {
  return {
    budget: {
      schema:'bareeq.audio-gate4-budget.v2',
      ttsSuccessfulRequests:0, paidApiBudgetUsd:0, externalAsrProviderCalls:0,
      maxWallMinutesPerRun:45, gate4ArtifactRetentionDays:30, rejectedTrialRetentionDays:90,
      infrastructureRecovery:{maxAdditionalRuns:1,consumedRuns:0,automaticExtension:false},
      scientificBudget:{maxRuns:4,consumedRuns:0,accountingRule:'A scientific run is consumed only if the workflow reaches the forced-alignment comparison step after the smoke test passes.'},
    },
    freeze: {
      schema:'bareeq.audio-tts-freeze.v1', active:true,
      reviewPolicy:{
        nextReviewAt:'2026-10-13T00:00:00Z', missedReviewAction:'remain-frozen',
        gate4Contract:'docs/audio/GATE-4-VALIDATOR-RESEARCH-v1.md',
        gate4Budget:'docs/audio/GATE-4-BUDGET.json',
        additionalResearchRunsAuthorized:1,
        gate4Status:'OWNER_APPROVED_SINGLE_INFRASTRUCTURE_RECOVERY',
      },
    },
    status:{exactCount:7,publishedCount:7,fallbackCount:8},
    strategy:{exactBaseline:7,successfulTtsSinceLastNewExact:29,threshold:30},
    queue:{schema:'bareeq.audio-human-arbitration-queue.v1',status:'active',items:[]},
    decisionText:'15/15 Verified Exact/Equivalent Quality 14/15 exact + 1 intentionally excluded no technical conclusion or synthesis decision may be invented without evidence',
    gate4Text:'AUDIO_ERROR_CANDIDATE VALIDATOR_AMBIGUITY Mandatory infrastructure smoke test G2P intentionally deferred',
    humanText:'EXPECTED_PRONUNCIATION_CONFIRMED ACTUAL_AUDIO_ERROR INCONCLUSIVE',
  };
}

const ok=fixture();
const result=validateGate4Governance({...ok,now:new Date('2026-10-06T00:00:00Z')});
assert.equal(result.action,'SINGLE_INFRASTRUCTURE_RECOVERY_AUTHORIZED');
assert.equal(result.infrastructureRemaining,1);
assert.equal(result.scientificRemaining,4);

const badInfra=fixture(); badInfra.budget.infrastructureRecovery.maxAdditionalRuns=2;
assert.throws(()=>validateGate4Governance(badInfra),/exactly one run/);

const overInfra=fixture(); overInfra.budget.infrastructureRecovery.consumedRuns=2;
assert.throws(()=>validateGate4Governance(overInfra),/infrastructure recovery budget exceeded/);

const overScientific=fixture(); overScientific.budget.scientificBudget.consumedRuns=5;
assert.throws(()=>validateGate4Governance(overScientific),/scientific budget exceeded/);

const badTts=fixture(); badTts.budget.ttsSuccessfulRequests=1;
assert.throws(()=>validateGate4Governance(badTts),/TTS budget must be zero/);

const badState=fixture(); badState.strategy.successfulTtsSinceLastNewExact=30;
assert.throws(()=>validateGate4Governance(badState),/Strategic TTS state moved/);

console.log('Gate 4 governance v2 passed: infrastructure and scientific budgets are separated, one owner-approved recovery run is bounded, and TTS remains frozen.');
