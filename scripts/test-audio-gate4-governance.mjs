import assert from 'node:assert/strict';
import { validateGate4Governance } from './audio-gate4-governance.mjs';

function fixture() {
  return {
    budget:{
      schema:'bareeq.audio-gate4-budget.v2',ttsSuccessfulRequests:0,paidApiBudgetUsd:0,externalAsrProviderCalls:0,
      maxWallMinutesPerRun:45,gate4ArtifactRetentionDays:30,rejectedTrialRetentionDays:90,
      infrastructureRecovery:{maxAdditionalRuns:1,consumedRuns:1,status:'completed'},
      scientificBudget:{maxRuns:4,consumedRuns:3,executionPolicy:{manualOnly:true,additionalRunsAuthorized:0,pullRequestTriggerProhibited:true,pushTriggerProhibited:true}}
    },
    freeze:{schema:'bareeq.audio-tts-freeze.v1',active:true,reviewPolicy:{gate4Status:'PILOT_PASS_CORROBORATION_REQUIRED',additionalResearchRunsAuthorized:0,nextReviewAt:'2026-10-13T00:00:00Z'}},
    status:{exactCount:7,publishedCount:7,fallbackCount:8},
    strategy:{exactBaseline:7,successfulTtsSinceLastNewExact:29,threshold:30},
    queue:{schema:'bareeq.audio-human-arbitration-queue.v1',status:'active',items:[{},{}]},
    decisionText:'Verified Exact Equivalent Quality 14/15 exact + 1 intentionally excluded',
    gate4Text:'G2P intentionally deferred Scientific workflow trigger policy manual-only',
    humanText:'EXPECTED_PRONUNCIATION_CONFIRMED ACTUAL_AUDIO_ERROR INCONCLUSIVE',
  };
}

const ok=fixture();
const result=validateGate4Governance({...ok,now:new Date('2026-10-06T00:00:00Z')});
assert.equal(result.action,'PILOT_PASS_CORROBORATION_REQUIRED');
assert.equal(result.scientificConsumed,3);
assert.equal(result.scientificRemaining,1);

const auto=fixture(); auto.budget.scientificBudget.executionPolicy.manualOnly=false;
assert.throws(()=>validateGate4Governance(auto),/manual-only/);

const auth=fixture(); auth.budget.scientificBudget.executionPolicy.additionalRunsAuthorized=1;
assert.throws(()=>validateGate4Governance(auth),/No additional Gate 4 scientific run/);

const moved=fixture(); moved.strategy.successfulTtsSinceLastNewExact=30;
assert.throws(()=>validateGate4Governance(moved),/29\/30/);

console.log('Gate 4 post-pilot governance passed: TTS frozen, three scientific executions accounted, no automatic scientific triggers, arbitration required.');
