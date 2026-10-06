import assert from 'node:assert/strict';
import { validateGate4Governance } from './audio-gate4-governance.mjs';

function fixture() {
  return {
    budget: {
      schema:'bareeq.audio-gate4-budget.v1',
      ttsSuccessfulRequests:0, paidApiBudgetUsd:0, externalAsrProviderCalls:0,
      maxResearchWorkflowRuns:4, maxWallMinutesPerRun:45, maxAggregateRunnerMinutes:180,
      gate4ArtifactRetentionDays:30, rejectedTrialRetentionDays:90,
      status:'active', researchRunsConsumed:0,
    },
    freeze: {
      schema:'bareeq.audio-tts-freeze.v1', active:true,
      reviewPolicy:{
        nextReviewAt:'2026-10-13T00:00:00Z', missedReviewAction:'remain-frozen',
        gate4Contract:'docs/audio/GATE-4-VALIDATOR-RESEARCH-v1.md',
        gate4Budget:'docs/audio/GATE-4-BUDGET.json',
      },
    },
    status:{exactCount:7,publishedCount:7,fallbackCount:8},
    strategy:{exactBaseline:7,successfulTtsSinceLastNewExact:29,threshold:30},
    queue:{schema:'bareeq.audio-human-arbitration-queue.v1',status:'active',items:[]},
    decisionText:'15/15 Verified Exact/Equivalent Quality 14/15 exact + 1 intentionally excluded no technical conclusion or synthesis decision may be invented without evidence',
    gate4Text:'AUDIO_ERROR_CANDIDATE VALIDATOR_AMBIGUITY Gate 4 failure does not authorize',
    humanText:'EXPECTED_PRONUNCIATION_CONFIRMED ACTUAL_AUDIO_ERROR INCONCLUSIVE',
  };
}

const ok=fixture();
assert.equal(validateGate4Governance({...ok,now:new Date('2026-10-06T00:00:00Z')}).overdue,false);
assert.equal(validateGate4Governance({...ok,now:new Date('2026-10-14T00:00:00Z')}).action,'OWNER_REVIEW_REQUIRED_FREEZE_REMAINS_ACTIVE');

const badBudget=fixture(); badBudget.budget.ttsSuccessfulRequests=1;
assert.throws(()=>validateGate4Governance(badBudget),/TTS budget must be zero/);

const badState=fixture(); badState.strategy.successfulTtsSinceLastNewExact=30;
assert.throws(()=>validateGate4Governance(badState),/Strategic TTS state moved/);

const badFreeze=fixture(); badFreeze.freeze.active=false;
assert.throws(()=>validateGate4Governance(badFreeze),/TTS freeze must remain active/);

console.log('Gate 4 governance tests passed: budget, freeze, state, review cadence, and arbitration policy are fail-closed.');


const exhausted=fixture();
exhausted.budget.status='exhausted';
exhausted.budget.researchRunsConsumed=4;
exhausted.budget.pilotOutcome={nextActionRequiresOwnerApproval:true};
exhausted.freeze.reviewPolicy.gate4Status='INFRASTRUCTURE_BUDGET_EXHAUSTED';
exhausted.freeze.reviewPolicy.additionalResearchRunsAuthorized=0;
assert.equal(
  validateGate4Governance({...exhausted,now:new Date('2026-10-06T00:00:00Z')}).action,
  'OWNER_DECISION_REQUIRED_RESEARCH_BUDGET_EXHAUSTED'
);

const over=fixture();
over.budget.researchRunsConsumed=5;
assert.throws(()=>validateGate4Governance(over),/research run budget exceeded/);
