import assert from 'node:assert/strict';
import { validateGate4Governance } from './audio-gate4-governance.mjs';

function fixture(){
  return {
    budget:{
      schema:'bareeq.audio-gate4-budget.v2',ttsSuccessfulRequests:0,paidApiBudgetUsd:0,externalAsrProviderCalls:0,
      infrastructureRecovery:{consumedRuns:1,status:'completed'},
      scientificBudget:{maxRuns:4,consumedRuns:3,executionPolicy:{manualOnly:true,additionalRunsAuthorized:0,pullRequestTriggerProhibited:true,pushTriggerProhibited:true}},
      pilotStatistic:{value:0.6114,status:'descriptive-only',productionThreshold:false,falsePositiveRateKnown:false,falseNegativeRateKnown:false},
      fullCalibration:{authorized:false,remainingScientificSlots:1}
    },
    freeze:{schema:'bareeq.audio-tts-freeze.v1',active:true,reviewPolicy:{
      gate4Status:'PILOT_PASS_CORROBORATION_REQUIRED',additionalResearchRunsAuthorized:0,nextReviewAt:'2026-10-13T00:00:00Z',
      classificationSemantics:'docs/audio/GATE-4-CLASSIFICATIONS-v1.md',
      fullCalibrationPlan:'docs/audio/GATE-4-CALIBRATION-PLAN-v1.md',
      gate5Criteria:'docs/audio/GATE-5-DECISION-CRITERIA-v1.md'
    }},
    status:{exactCount:7,publishedCount:7,fallbackCount:8},
    strategy:{exactBaseline:7,successfulTtsSinceLastNewExact:29,threshold:30},
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
const ok=fixture();
const result=validateGate4Governance({...ok,now:new Date('2026-10-06T00:00:00Z')});
assert.equal(result.action,'CORROBORATION_REQUIRED_NO_TTS');
assert.equal(result.scientificRemaining,1);
assert.equal(result.fullCalibrationAuthorized,false);
assert.equal(result.gate5,'CLOSED');

const threshold=fixture(); threshold.budget.pilotStatistic.productionThreshold=true;
assert.throws(()=>validateGate4Governance(threshold),/descriptive-only/);

const calibration=fixture(); calibration.budget.fullCalibration.authorized=true;
assert.throws(()=>validateGate4Governance(calibration),/prepared but unauthorized/);

const tts=fixture(); tts.strategy.successfulTtsSinceLastNewExact=30;
assert.throws(()=>validateGate4Governance(tts),/29\/30/);

console.log('Gate 4 hardening governance passed: pilot threshold is descriptive-only, calibration is not authorized, Gate 5 is closed, and TTS remains 29/30.');
