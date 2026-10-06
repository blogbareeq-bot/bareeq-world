import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
async function json(rel) { return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8')); }
async function text(rel) { return readFile(path.join(ROOT, rel), 'utf8'); }
function fail(message) { const error=new Error(message); error.code='BAREEQ_GATE4_GOVERNANCE_INVALID'; throw error; }

export function validateGate4Governance({ budget, freeze, status, strategy, queue, decisionText, gate4Text, humanText, now = new Date() }) {
  if (budget?.schema !== 'bareeq.audio-gate4-budget.v2') fail('unsupported Gate 4 budget schema');
  if (Number(budget.ttsSuccessfulRequests) !== 0) fail('Gate 4 TTS budget must be zero');
  if (Number(budget.paidApiBudgetUsd) !== 0) fail('Gate 4 paid API budget must be zero');
  if (Number(budget.externalAsrProviderCalls) !== 0) fail('Gate 4 external ASR provider calls must be zero');

  const infra=budget.infrastructureRecovery||{};
  const scientific=budget.scientificBudget||{};
  if (Number(infra.maxAdditionalRuns)!==1) fail('Gate 4 infrastructure extension must remain exactly one run');
  if (Number(infra.consumedRuns)!==1 || infra.status!=='completed') fail('Owner-approved infrastructure recovery must be recorded as consumed and completed');
  if (Number(scientific.maxRuns)!==4) fail('Gate 4 scientific budget must remain four runs');
  if (Number(scientific.consumedRuns)<1 || Number(scientific.consumedRuns)>4) fail('Gate 4 scientific consumed-run count is invalid');
  if (scientific?.executionPolicy?.manualOnly!==true) fail('Future Gate 4 scientific execution must be manual-only');
  if (Number(scientific?.executionPolicy?.additionalRunsAuthorized)!==0) fail('No additional Gate 4 scientific run is currently authorized');
  if (scientific?.executionPolicy?.pullRequestTriggerProhibited!==true || scientific?.executionPolicy?.pushTriggerProhibited!==true) {
    fail('Push/PR scientific triggers must be prohibited');
  }

  if (Number(budget.maxWallMinutesPerRun)>45) fail('Gate 4 run wall-time cap exceeds 45 minutes');
  if (Number(budget.gate4ArtifactRetentionDays)>30) fail('Gate 4 research retention exceeds approved 30 days');
  if (Number(budget.rejectedTrialRetentionDays)<90) fail('Rejected-trial evidence retention below 90 days');

  if (freeze?.schema!=='bareeq.audio-tts-freeze.v1' || freeze.active!==true) fail('TTS freeze must remain active before Gate 5');
  if (freeze?.reviewPolicy?.gate4Status!=='PILOT_PASS_CORROBORATION_REQUIRED') fail('Gate 4 must remain in corroboration-required state');
  if (Number(freeze?.reviewPolicy?.additionalResearchRunsAuthorized)!==0) fail('No further Gate 4 run may be implicitly authorized');
  if (Number(status?.exactCount)!==7 || Number(status?.publishedCount)!==7 || Number(status?.fallbackCount)!==8) fail('Canonical campaign state moved from 7 exact / 8 fallback');
  if (Number(strategy?.exactBaseline)!==7 || Number(strategy?.successfulTtsSinceLastNewExact)!==29 || Number(strategy?.threshold)!==30) fail('Strategic TTS state moved from 29/30');

  if (queue?.schema!=='bareeq.audio-human-arbitration-queue.v1' || queue.status!=='active' || !Array.isArray(queue.items)) fail('Human arbitration queue is not active');
  if (queue.items.length<2) fail('Gate 4 localized disputes must be queued for arbitration');

  for (const needle of ['Verified Exact','Equivalent Quality','14/15 exact + 1 intentionally excluded']) {
    if (!decisionText.includes(needle)) fail(`Recovery decision missing success-definition control: ${needle}`);
  }
  for (const needle of ['G2P intentionally deferred','Scientific workflow trigger policy','manual-only']) {
    if (!gate4Text.includes(needle)) fail(`Gate 4 contract missing required control: ${needle}`);
  }
  for (const needle of ['EXPECTED_PRONUNCIATION_CONFIRMED','ACTUAL_AUDIO_ERROR','INCONCLUSIVE']) {
    if (!humanText.includes(needle)) fail(`Human arbitration policy missing decision: ${needle}`);
  }

  const due=Date.parse(freeze.reviewPolicy.nextReviewAt||'');
  const overdue=Number.isFinite(due)&&now.getTime()>due;
  return {
    exact:7,
    fallback:8,
    strategy:'29/30',
    overdue,
    scientificConsumed:Number(scientific.consumedRuns),
    scientificRemaining:4-Number(scientific.consumedRuns),
    action:overdue?'OWNER_REVIEW_REQUIRED_FREEZE_REMAINS_ACTIVE':'PILOT_PASS_CORROBORATION_REQUIRED',
  };
}

async function cli() {
  const result=validateGate4Governance({
    budget:await json('docs/audio/GATE-4-BUDGET.json'),
    freeze:await json('docs/audio/TTS-FREEZE.json'),
    status:await json('docs/audio/PROGRESSIVE-STATUS.json'),
    strategy:await json('docs/audio/ENGINE-STRATEGY-STATE.json'),
    queue:await json('docs/audio/HUMAN-ARBITRATION-QUEUE.json'),
    decisionText:await text('docs/audio/BAREEQ-AUDIO-RECOVERY-DECISION-v1.md'),
    gate4Text:await text('docs/audio/GATE-4-VALIDATOR-RESEARCH-v1.md'),
    humanText:await text('docs/audio/HUMAN-ARBITRATION-v1.md'),
  });
  console.log(`GATE4_GOVERNANCE=PASS exact=${result.exact}/15 strategy=${result.strategy} scientific=${result.scientificConsumed}/4 remaining=${result.scientificRemaining} action=${result.action}`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
