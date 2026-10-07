import assert from 'node:assert/strict';
import { validateGate4Governance } from './audio-gate4-governance.mjs';

function fixture(exact=7){
  return {
    budget:{schema:'bareeq.audio-gate4-budget.v2',ttsSuccessfulRequests:0,paidApiBudgetUsd:0,externalAsrProviderCalls:0,
      infrastructureRecovery:{consumedRuns:1,status:'completed'},
      scientificBudget:{maxRuns:4,consumedRuns:3,executionPolicy:{manualOnly:true,additionalRunsAuthorized:0,pullRequestTriggerProhibited:true,pushTriggerProhibited:true}},
      pilotStatistic:{value:0.6114,status:'descriptive-only',productionThreshold:false,falsePositiveRateKnown:false,falseNegativeRateKnown:false},
      fullCalibration:{authorized:false,remainingScientificSlots:1}},
    freeze:{schema:'bareeq.audio-tts-freeze.v1',active:true,strategySnapshot:{exact,total:15,fallback:15-exact,successfulTtsSinceLastNewExact:29,threshold:30},reviewPolicy:{
      gate4Status:'PILOT_PASS_CORROBORATION_REQUIRED',additionalResearchRunsAuthorized:0,nextReviewAt:'2026-10-13T00:00:00Z',
      classificationSemantics:'docs/audio/GATE-4-CLASSIFICATIONS-v1.md',fullCalibrationPlan:'docs/audio/GATE-4-CALIBRATION-PLAN-v1.md',gate5Criteria:'docs/audio/GATE-5-DECISION-CRITERIA-v1.md'}},
    status:{exactCount:exact,publishedCount:exact,fallbackCount:15-exact},
    strategy:{exactBaseline:exact,successfulTtsSinceLastNewExact:29,threshold:30},
    queue:{schema:'bareeq.audio-human-arbitration-queue.v1',status:'active',items:[{},{}]},
    decisionText:'Verified Exact Equivalent Quality GATE-5-DECISION-CRITERIA-v1.md',
    gate4Text:'PILOT_PASS_CORROBORATION_REQUIRED descriptive small-sample statistic manual-only',
    humanText:'Classification-specific arbitration path AUDIO_ERROR_CANDIDATE INCONCLUSIVE',
    classificationText:'0.6114 is a descriptive pilot statistic only and is not a production threshold',
    calibrationText:'Status: prepared, NOT authorized to run 7/7 immutable Exact five previously untested',
    gate5Text:'Gate 5 is currently CLOSED ACTUAL_AUDIO_ERROR request 30/30',
    pr62Text:'PR #62 is closed and must not be merged',
  };
}
for(const n of [7,9]){
 const result=validateGate4Governance({...fixture(n),now:new Date('2026-10-07T00:00:00Z')});
 assert.equal(result.exact,n);
 assert.equal(result.fallback,15-n);
 assert.equal(result.strategy,'29/30');
}
const drift=fixture(9); drift.strategy.exactBaseline=7;
assert.throws(()=>validateGate4Governance(drift),/exact baseline/i);
console.log('Gate 4 governance accepts legitimate Exact promotions while preserving scientific budget, freeze, and 29/30.');
