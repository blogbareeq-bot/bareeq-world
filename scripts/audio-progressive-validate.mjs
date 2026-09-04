import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_QUOTA } from './audio-constants.mjs';
import { writeJson } from './audio-checkpoint.mjs';
import { validateWithConsensus } from './audio-validate-consensus.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');

function csvArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || '';
  return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
}

function exactConsensusZero(consensus = {}) {
  return ['substitutions', 'deletions', 'insertions', 'unresolved']
    .every((key) => Number(consensus[key]) === 0);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeJson(STATE_PATH, state);
}

const skip = csvArg('skip');
const only = csvArg('only');
const state = await readJson(STATE_PATH);
const snapshot = await readJson(SNAPSHOT_PATH);
if (!state?.generationComplete || !Array.isArray(snapshot?.articles) || snapshot.articles.length !== 15) {
  throw new Error('progressive validation requires a generation-complete 15/15 checkpoint and the 15-article truth snapshot');
}

const attempted = [];
const failures = [];
let quotaStop = null;

for (const item of snapshot.articles) {
  const articleId = item.articleId;
  if (skip.has(articleId) || (only.size > 0 && !only.has(articleId))) {
    console.log(`PROGRESSIVE_VALIDATION_FILTER_SKIP ${articleId}`);
    continue;
  }

  const previous = state.articles?.[articleId] || {};
  const fingerprint = previous.generation?.fingerprint;
  if (!fingerprint || previous.generation?.status !== 'generated') {
    failures.push({ articleId, kind: 'generation-not-ready' });
    console.log(`PROGRESSIVE_VALIDATION_NOT_READY ${articleId}`);
    continue;
  }

  if (
    previous.validation?.status === 'validated'
    && previous.validation?.fingerprint === fingerprint
    && exactConsensusZero(previous.validation?.consensus)
  ) {
    console.log(`PROGRESSIVE_VALIDATION_RESUME_SKIP ${articleId} ${fingerprint}`);
    continue;
  }

  attempted.push(articleId);
  console.log(`PROGRESSIVE_VALIDATION_START ${articleId} ${fingerprint}`);
  try {
    const result = await validateWithConsensus({ articleId, fingerprint, root: ROOT });
    state.articles[articleId] = {
      ...previous,
      validation: {
        status: result.status,
        fingerprint,
        fullSha256: result.fullSha256,
        consensus: result.consensus,
        representationOnly: result.representationOnly,
        modelDisagreements: result.modelDisagreements,
        completedAt: new Date().toISOString(),
      },
    };
    await saveState(state);
    console.log(`PROGRESSIVE_VALIDATION_DONE ${articleId} consensus=${JSON.stringify(result.consensus)}`);
  } catch (error) {
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    state.articles[articleId] = {
      ...previous,
      validation: {
        status: quota ? 'paused-quota' : 'failed',
        fingerprint,
        error: String(error?.message || error || '').slice(0, 700),
        updatedAt: new Date().toISOString(),
      },
    };
    failures.push({ articleId, kind: quota ? 'quota' : 'quality', message: String(error?.message || error || '').slice(0, 300) });
    await saveState(state);
    console.log(`PROGRESSIVE_VALIDATION_${quota ? 'QUOTA' : 'QUALITY'}_FAIL ${articleId} ${String(error?.message || error || '').slice(0, 300)}`);
    if (quota) {
      quotaStop = articleId;
      break;
    }
  }
}

const articles = snapshot.articles.map((item) => item.articleId);
const validatedArticles = articles.filter((articleId) => {
  const record = state.articles?.[articleId];
  return record?.validation?.status === 'validated'
    && record.validation.fingerprint === record.generation?.fingerprint
    && exactConsensusZero(record.validation.consensus);
});
const remainingArticles = articles.filter((articleId) => !validatedArticles.includes(articleId));

state.validationComplete = validatedArticles.length === articles.length;
state.progressiveValidation = {
  status: state.validationComplete ? 'complete' : (quotaStop ? 'paused-quota' : 'partial'),
  validatedCount: validatedArticles.length,
  remainingCount: remainingArticles.length,
  validatedArticles,
  remainingArticles,
  attempted,
  failures,
  skipped: [...skip],
  only: [...only],
  quotaStop,
  updatedAt: new Date().toISOString(),
};
await saveState(state);

console.log(`PROGRESSIVE_VALIDATION_SUMMARY validated=${validatedArticles.length}/15 remaining=${remainingArticles.length} attempted=${attempted.length} failures=${failures.length} quotaStop=${quotaStop || 'none'}`);
