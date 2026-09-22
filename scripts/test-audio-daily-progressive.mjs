import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseGeminiQuotaDetail } from './audio-gemini-tts.mjs';
import {
  chooseRepairPart,
  compareRepairCandidates,
  consensusErrorTotal,
  createBudgetedSynthesizer,
  shouldRetryCurrentArticle,
} from './audio-progressive-repair.mjs';

const dailyBody = JSON.stringify({
  error: {
    message: 'You exceeded your current quota',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          quotaValue: '10',
        }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '9h12m' },
    ],
  },
});
const parsedDaily = parseGeminiQuotaDetail(dailyBody);
assert.equal(parsedDaily.daily, true);
assert.equal(parsedDaily.quota[0].value, '10');
assert.equal(consensusErrorTotal({ substitutions: 3, deletions: 1, insertions: 2, unresolved: 1 }), 7);
assert.equal(consensusErrorTotal({ substitutions: 2, deletions: 0, insertions: 0, unresolved: 0 }), 2);
const partAttempts = new Map();
assert.equal(chooseRepairPart([3], partAttempts, 3), 3);
partAttempts.set(3, 1);
assert.equal(chooseRepairPart([3], partAttempts, 3), 3, 'the same failed part may be retried');
partAttempts.set(3, 3);
assert.equal(chooseRepairPart([3], partAttempts, 3), undefined, 'the per-part trial cap is enforced');
const prioritized = [
  { errorScore: 4, repairPriority: 0, partCount: 1, tokenCount: 4, order: 0 },
  { errorScore: 1, repairPriority: 1, partCount: 2, tokenCount: 1, order: 1 },
].sort(compareRepairCandidates);
assert.equal(prioritized[0].errorScore, 1, 'fewest consensus errors must be repaired first');
assert.equal(shouldRetryCurrentArticle('repair-failed'), true,
  'a restored candidate must keep article focus after a transient synthesis failure');
assert.equal(shouldRetryCurrentArticle('paused-quota'), false,
  'a daily quota stop must still end the run');
const repairSource = await readFile(new URL('./audio-progressive-repair.mjs', import.meta.url), 'utf8');
assert.ok(repairSource.indexOf('PROGRESSIVE_PRECLASSIFY') < repairSource.indexOf('const candidates = []'),
  'all pending candidates must be ASR-classified before TTS candidate ordering');

const workflow = await readFile(new URL('../.github/workflows/audio-partial-publish.yml', import.meta.url), 'utf8');
const excludedId = 'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع';
assert.match(workflow, new RegExp(`BAREEQ_PROGRESSIVE_SKIP_ARTICLES: '${excludedId}'`));
assert.match(workflow, /audio-progressive-repair\.mjs --max-articles=10 "--skip=\$\{BAREEQ_PROGRESSIVE_SKIP_ARTICLES\}"/);
const previewRoot = await mkdtemp(path.join(os.tmpdir(), 'bareeq-progressive-skip-'));
try {
  const snapshot = JSON.parse(await readFile(new URL('../docs/audio/AUDIO-TRUTH-SNAPSHOT.json', import.meta.url), 'utf8'));
  assert.equal(snapshot.articles.length, 15);
  const ids = snapshot.articles.map((item) => item.articleId);
  assert.ok(ids.includes(excludedId));
  const campaignId = 'sadaltager-openrouter-20260901-v1';
  const stateFile = path.join(previewRoot, 'audio-candidates', '_campaigns', campaignId, 'state.json');
  const snapshotFile = path.join(previewRoot, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
  await mkdir(path.dirname(stateFile), { recursive: true });
  await mkdir(path.dirname(snapshotFile), { recursive: true });
  const state = { generationComplete: true, articles: Object.fromEntries(ids.map((id) => [id, {
    generation: { status: 'generated', fingerprint: 'a'.repeat(64) },
    validation: id === ids[0] ? { status: 'validated', fingerprint: 'a'.repeat(64),
      consensus: { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 } } : { status: 'failed' },
  }])) };
  const unchangedState = JSON.stringify(state);
  await writeFile(stateFile, unchangedState);
  await writeFile(snapshotFile, JSON.stringify(snapshot));
  const preview = spawnSync(process.execPath, [new URL('./audio-progressive-repair.mjs', import.meta.url).pathname,
    '--plan-only', `--skip=${excludedId}`], { cwd: previewRoot, encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: '' } });
  assert.equal(preview.status, 0, preview.stderr);
  const selection = JSON.parse(preview.stdout);
  assert.equal(selection.status, 'plan-only');
  assert.deepEqual(selection.skippedArticleIds, [excludedId]);
  assert.equal(selection.selectedArticleIds.length, 14);
  assert.equal(selection.pendingArticleIds.length, 13);
  assert.ok(selection.pendingArticleIds.includes(ids[1]));
  assert.ok(!selection.selectedArticleIds.includes(excludedId));
  assert.equal(selection.providerCalls, 0);
  assert.equal(await readFile(stateFile, 'utf8'), unchangedState, 'planning cannot mutate the checkpoint');
} finally {
  await rm(previewRoot, { recursive: true, force: true });
}

const args = {
  article: { title: 'اختبار' },
  part: { partIndex: 0, text: 'نص' },
  splitPlan: { parts: [{}] },
  correctionHint: '',
};

const previous = {
  max: process.env.BAREEQ_REPAIR_MAX_REQUESTS,
  retries: process.env.BAREEQ_REPAIR_MAX_429_RETRIES,
  interval: process.env.BAREEQ_REPAIR_MIN_INTERVAL_MS,
};
try {
  process.env.BAREEQ_REPAIR_MAX_REQUESTS = '2';
  process.env.BAREEQ_REPAIR_MAX_429_RETRIES = '1';
  process.env.BAREEQ_REPAIR_MIN_INTERVAL_MS = '0';
  let successCalls = 0;
  const successful = createBudgetedSynthesizer({
    apiKey: 'test',
    sleepImpl: async () => {},
    transportEntries: [['mock', async () => {
      successCalls += 1;
      return { audio: Buffer.alloc(120), transport: 'mock' };
    }]],
  });
  await successful(args);
  await successful(args);
  await assert.rejects(() => successful(args), /request cap 2/);
  assert.equal(successCalls, 2);
  assert.deepEqual(successful.stats(), {
    sent: 2,
    successful: 2,
    quotaRejected: 0,
    maxRequests: 2,
    dailyQuotaExhausted: false,
    budgetExhausted: true,
  });

  process.env.BAREEQ_REPAIR_MAX_REQUESTS = '10';
  process.env.BAREEQ_REPAIR_MAX_429_RETRIES = '2';
  const shortWaits = [];
  let shortRetryCalls = 0;
  const shortDailyReset = createBudgetedSynthesizer({
    apiKey: 'test',
    sleepImpl: async (ms) => { shortWaits.push(ms); },
    transportEntries: [['first', async () => {
      shortRetryCalls += 1;
      if (shortRetryCalls === 1) {
        throw Object.assign(new Error('RPD resetting shortly'), { httpStatus: 429, dailyQuota: true, retryDelayMs: 36000 });
      }
      return { audio: Buffer.alloc(120) };
    }]],
  });
  await shortDailyReset(args);
  assert.equal(shortRetryCalls, 2, 'a short explicit provider reset must be retried in the same run');
  assert.deepEqual(shortWaits, [36000]);
  assert.equal(shortDailyReset.stats().dailyQuotaExhausted, false);

  process.env.BAREEQ_REPAIR_MAX_429_RETRIES = '1';
  let secondTransportCalls = 0;
  const dailyStop = createBudgetedSynthesizer({
    apiKey: 'test',
    sleepImpl: async () => { throw new Error('daily quota must not sleep/retry'); },
    transportEntries: [
      ['first', async () => { throw Object.assign(new Error('RPD'), { httpStatus: 429, dailyQuota: true }); }],
      ['second', async () => { secondTransportCalls += 1; return { audio: Buffer.alloc(120) }; }],
    ],
  });
  await assert.rejects(() => dailyStop(args), /RPD/);
  assert.equal(secondTransportCalls, 0);
  assert.equal(dailyStop.stats().sent, 1);
  assert.equal(dailyStop.stats().dailyQuotaExhausted, true);
} finally {
  if (previous.max === undefined) delete process.env.BAREEQ_REPAIR_MAX_REQUESTS;
  else process.env.BAREEQ_REPAIR_MAX_REQUESTS = previous.max;
  if (previous.retries === undefined) delete process.env.BAREEQ_REPAIR_MAX_429_RETRIES;
  else process.env.BAREEQ_REPAIR_MAX_429_RETRIES = previous.retries;
  if (previous.interval === undefined) delete process.env.BAREEQ_REPAIR_MIN_INTERVAL_MS;
  else process.env.BAREEQ_REPAIR_MIN_INTERVAL_MS = previous.interval;
}

console.log('Daily progressive audio tests passed: closest-first retries, RPD detection, shared request budget, and immediate daily-quota stop.');
