import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();

async function json(rel) {
  return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
}
async function text(rel) {
  return readFile(path.join(ROOT, rel), 'utf8');
}
function fail(message) {
  const error = new Error(message);
  error.code = 'BAREEQ_GATE4_GOVERNANCE_INVALID';
  throw error;
}

export function validateGate4Governance({ budget, freeze, status, strategy, queue, decisionText, gate4Text, humanText, now = new Date() }) {
  if (budget?.schema !== 'bareeq.audio-gate4-budget.v1') fail('unsupported Gate 4 budget schema');
  if (Number(budget.ttsSuccessfulRequests) !== 0) fail('Gate 4 TTS budget must be zero');
  if (Number(budget.paidApiBudgetUsd) !== 0) fail('Gate 4 paid API budget must be zero');
  if (Number(budget.externalAsrProviderCalls) !== 0) fail('Gate 4 external ASR provider calls must be zero');
  if (Number(budget.maxResearchWorkflowRuns) < 1 || Number(budget.maxResearchWorkflowRuns) > 4) fail('Gate 4 research run cap must be 1..4');
  if (Number(budget.maxWallMinutesPerRun) > 45) fail('Gate 4 run wall-time cap exceeds 45 minutes');
  if (Number(budget.maxAggregateRunnerMinutes) > 180) fail('Gate 4 aggregate runner cap exceeds 180 minutes');
  if (Number(budget.gate4ArtifactRetentionDays) > 30) fail('Gate 4 research retention exceeds approved 30 days');
  if (Number(budget.rejectedTrialRetentionDays) < 90) fail('Rejected-trial evidence retention below 90 days');

  if (freeze?.schema !== 'bareeq.audio-tts-freeze.v1' || freeze.active !== true) fail('TTS freeze must remain active before Gate 5');
  if (freeze?.reviewPolicy?.missedReviewAction !== 'remain-frozen') fail('Freeze review must fail closed');
  if (freeze?.reviewPolicy?.gate4Contract !== 'docs/audio/GATE-4-VALIDATOR-RESEARCH-v1.md') fail('Freeze does not bind Gate 4 contract');
  if (freeze?.reviewPolicy?.gate4Budget !== 'docs/audio/GATE-4-BUDGET.json') fail('Freeze does not bind Gate 4 budget');

  if (Number(status?.exactCount) !== 7 || Number(status?.publishedCount) !== 7 || Number(status?.fallbackCount) !== 8) {
    fail('Canonical campaign state moved from 7 exact / 8 fallback without governance review');
  }
  if (Number(strategy?.exactBaseline) !== 7 || Number(strategy?.successfulTtsSinceLastNewExact) !== 29 || Number(strategy?.threshold) !== 30) {
    fail('Strategic TTS state moved from 29/30 or exact baseline 7 without governance review');
  }

  if (queue?.schema !== 'bareeq.audio-human-arbitration-queue.v1' || queue.status !== 'active' || !Array.isArray(queue.items)) {
    fail('Human arbitration queue is not active');
  }

  for (const needle of [
    '15/15 Verified Exact/Equivalent Quality',
    '14/15 exact + 1 intentionally excluded',
    'no technical conclusion or synthesis decision may be invented without evidence',
  ]) {
    if (!decisionText.includes(needle)) fail(`Recovery decision missing required policy: ${needle}`);
  }
  for (const needle of ['AUDIO_ERROR_CANDIDATE','VALIDATOR_AMBIGUITY','Gate 4 failure does not authorize']) {
    if (!gate4Text.includes(needle)) fail(`Gate 4 contract missing required control: ${needle}`);
  }
  for (const needle of ['EXPECTED_PRONUNCIATION_CONFIRMED','ACTUAL_AUDIO_ERROR','INCONCLUSIVE']) {
    if (!humanText.includes(needle)) fail(`Human arbitration policy missing decision: ${needle}`);
  }

  const due = Date.parse(freeze.reviewPolicy.nextReviewAt || '');
  const overdue = Number.isFinite(due) && now.getTime() > due;
  return {
    exact: 7,
    fallback: 8,
    strategy: '29/30',
    overdue,
    nextReviewAt: freeze.reviewPolicy.nextReviewAt,
    action: overdue ? 'OWNER_REVIEW_REQUIRED_FREEZE_REMAINS_ACTIVE' : 'GOVERNANCE_CURRENT',
  };
}

async function cli() {
  const result = validateGate4Governance({
    budget: await json('docs/audio/GATE-4-BUDGET.json'),
    freeze: await json('docs/audio/TTS-FREEZE.json'),
    status: await json('docs/audio/PROGRESSIVE-STATUS.json'),
    strategy: await json('docs/audio/ENGINE-STRATEGY-STATE.json'),
    queue: await json('docs/audio/HUMAN-ARBITRATION-QUEUE.json'),
    decisionText: await text('docs/audio/BAREEQ-AUDIO-RECOVERY-DECISION-v1.md'),
    gate4Text: await text('docs/audio/GATE-4-VALIDATOR-RESEARCH-v1.md'),
    humanText: await text('docs/audio/HUMAN-ARBITRATION-v1.md'),
  });
  console.log(`GATE4_GOVERNANCE=PASS exact=${result.exact}/15 fallback=${result.fallback} strategy=${result.strategy} review=${result.action} next=${result.nextReviewAt}`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await cli();
