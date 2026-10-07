import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateThresholdAmendment, AMENDMENT_PATH } from './audio-tts-threshold-amendment.mjs';

const ROOT=process.cwd();
async function json(rel){ return JSON.parse(await readFile(path.join(ROOT,rel),'utf8')); }
async function text(rel){ return readFile(path.join(ROOT,rel),'utf8'); }
function fail(message){ const error=new Error(message); error.code='BAREEQ_GATE4_GOVERNANCE_INVALID'; throw error; }

export function validateGate4Governance({
  budget,freeze,status,strategy,queue,decisionText,gate4Text,humanText,
  classificationText,calibrationText,gate5Text,pr62Text,thresholdAmendment=null,now=new Date()
}){
  if(budget?.schema!=='bareeq.audio-gate4-budget.v2') fail('unsupported Gate 4 budget schema');
  if(Number(budget.ttsSuccessfulRequests)!==0) fail('Gate 4 TTS budget must be zero');
  if(Number(budget.paidApiBudgetUsd)!==0) fail('Gate 4 paid API budget must be zero');
  if(Number(budget.externalAsrProviderCalls)!==0) fail('Gate 4 external ASR provider calls must be zero');

  const infra=budget.infrastructureRecovery||{};
  const scientific=budget.scientificBudget||{};
  if(Number(infra.consumedRuns)!==1 || infra.status!=='completed') fail('infrastructure recovery accounting is not closed');
  if(Number(scientific.maxRuns)!==4 || Number(scientific.consumedRuns)!==3) fail('Gate 4 scientific accounting must remain 3/4');
  if(scientific?.executionPolicy?.manualOnly!==true) fail('Future Gate 4 scientific execution must be manual-only');
  if(Number(scientific?.executionPolicy?.additionalRunsAuthorized)!==0) fail('No additional Gate 4 scientific run is currently authorized');
  if(scientific?.executionPolicy?.pullRequestTriggerProhibited!==true || scientific?.executionPolicy?.pushTriggerProhibited!==true) fail('Push/PR scientific triggers must be prohibited');

  if(budget?.pilotStatistic?.value!==0.6114 || budget?.pilotStatistic?.status!=='descriptive-only' || budget?.pilotStatistic?.productionThreshold!==false) fail('0.6114 must remain descriptive-only, never a production threshold');
  if(budget?.pilotStatistic?.falsePositiveRateKnown!==false || budget?.pilotStatistic?.falseNegativeRateKnown!==false) fail('Pilot error rates must remain explicitly unknown');
  if(budget?.fullCalibration?.authorized!==false || Number(budget?.fullCalibration?.remainingScientificSlots)!==1) fail('Full calibration must remain prepared but unauthorized with one slot remaining');

  if(freeze?.schema!=='bareeq.audio-tts-freeze.v1' || freeze.active!==true) fail('TTS freeze must remain active before Gate 5');
  if(freeze?.reviewPolicy?.gate4Status!=='PILOT_PASS_CORROBORATION_REQUIRED') fail('Gate 4 must remain corroboration-required');
  if(Number(freeze?.reviewPolicy?.additionalResearchRunsAuthorized)!==0) fail('No further Gate 4 run may be implicitly authorized');
  if(freeze?.reviewPolicy?.classificationSemantics!=='docs/audio/GATE-4-CLASSIFICATIONS-v1.md') fail('classification semantics are not bound');
  if(freeze?.reviewPolicy?.fullCalibrationPlan!=='docs/audio/GATE-4-CALIBRATION-PLAN-v1.md') fail('calibration plan is not bound');
  if(freeze?.reviewPolicy?.gate5Criteria!=='docs/audio/GATE-5-DECISION-CRITERIA-v1.md') fail('Gate 5 criteria are not bound');

  const exact=Number(status?.exactCount);
  const published=Number(status?.publishedCount);
  const fallback=Number(status?.fallbackCount);
  if(!Number.isInteger(exact) || exact<7 || exact>14) fail('Canonical campaign Exact count must remain within the governed 7..14 range');
  if(published!==exact) fail('All governed Exact articles must be publishedExact');
  if(fallback!==15-exact) fail('Fallback count must equal 15 - Exact');
  if(Number(strategy?.exactBaseline)!==exact) fail('strategy exact baseline must match current Exact count');
  if(thresholdAmendment){
    validateThresholdAmendment({amendment:thresholdAmendment,strategy,freeze,status});
  } else if(Number(strategy?.successfulTtsSinceLastNewExact)!==29 || Number(strategy?.threshold)!==30) {
    fail('Strategic TTS budget must remain 29/30 without a recorded owner-approved amendment');
  }
  const snap=freeze?.strategySnapshot||{};
  if(snap.exact!=null && Number(snap.exact)!==exact) fail('freeze Exact snapshot drift');
  if(snap.fallback!=null && Number(snap.fallback)!==fallback) fail('freeze fallback snapshot drift');

  if(queue?.schema!=='bareeq.audio-human-arbitration-queue.v1' || queue.status!=='active' || !Array.isArray(queue.items) || queue.items.length<2) fail('localized disputes must remain queued');

  for(const needle of ['Verified Exact','Equivalent Quality','GATE-5-DECISION-CRITERIA-v1.md']) if(!decisionText.includes(needle)) fail(`Recovery decision missing: ${needle}`);
  for(const needle of ['PILOT_PASS_CORROBORATION_REQUIRED','descriptive small-sample statistic','manual-only']) if(!gate4Text.includes(needle)) fail(`Gate 4 contract missing: ${needle}`);
  for(const needle of ['Classification-specific arbitration path','AUDIO_ERROR_CANDIDATE','INCONCLUSIVE']) if(!humanText.includes(needle)) fail(`Human Arbitration missing: ${needle}`);
  for(const needle of ['descriptive pilot statistic only','not','production threshold']) if(!classificationText.includes(needle)) fail(`Classification semantics missing: ${needle}`);
  for(const needle of ['NOT authorized to run','7/7 immutable Exact','five previously untested']) if(!calibrationText.includes(needle)) fail(`Calibration plan missing: ${needle}`);
  for(const needle of ['Gate 5 is currently CLOSED','ACTUAL_AUDIO_ERROR','request 30/30']) if(!gate5Text.includes(needle)) fail(`Gate 5 contract missing: ${needle}`);
  for(const needle of ['PR #62','closed','must not be merged']) if(!pr62Text.includes(needle)) fail(`PR62 archive missing: ${needle}`);

  const due=Date.parse(freeze.reviewPolicy.nextReviewAt||'');
  const overdue=Number.isFinite(due)&&now.getTime()>due;
  return {
    exact,fallback,strategy:`${strategy.successfulTtsSinceLastNewExact}/${strategy.threshold}`,overdue,
    scientificConsumed:3,scientificRemaining:1,
    fullCalibrationAuthorized:false,
    gate5:'CLOSED',
    action:overdue?'OWNER_REVIEW_REQUIRED_FREEZE_REMAINS_ACTIVE':'CORROBORATION_REQUIRED_NO_TTS'
  };
}

async function cli(){
  const result=validateGate4Governance({
    budget:await json('docs/audio/GATE-4-BUDGET.json'),
    freeze:await json('docs/audio/TTS-FREEZE.json'),
    status:await json('docs/audio/PROGRESSIVE-STATUS.json'),
    strategy:await json('docs/audio/ENGINE-STRATEGY-STATE.json'),
    queue:await json('docs/audio/HUMAN-ARBITRATION-QUEUE.json'),
    decisionText:await text('docs/audio/BAREEQ-AUDIO-RECOVERY-DECISION-v1.md'),
    gate4Text:await text('docs/audio/GATE-4-VALIDATOR-RESEARCH-v1.md'),
    humanText:await text('docs/audio/HUMAN-ARBITRATION-v1.md'),
    classificationText:await text('docs/audio/GATE-4-CLASSIFICATIONS-v1.md'),
    calibrationText:await text('docs/audio/GATE-4-CALIBRATION-PLAN-v1.md'),
    gate5Text:await text('docs/audio/GATE-5-DECISION-CRITERIA-v1.md'),
    pr62Text:await text('docs/audio/PR-62-ARCHIVE.md'),
    thresholdAmendment:await json(AMENDMENT_PATH).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),
  });
  console.log(`GATE4_GOVERNANCE=PASS exact=${result.exact}/15 strategy=${result.strategy} scientific=${result.scientificConsumed}/4 remaining=${result.scientificRemaining} calibrationAuthorized=${result.fullCalibrationAuthorized} gate5=${result.gate5} action=${result.action}`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
