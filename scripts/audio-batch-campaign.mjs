import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import {
  EXIT_HARD,
  EXIT_OK,
  EXIT_QUOTA,
  QUOTA_SPLIT,
  candidateDir,
} from './audio-constants.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { runProductionMode } from './audio-production.mjs';
import { loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';
import { validateWithConsensus } from './audio-validate-consensus.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-all-20260831-v1';
const MODE = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) || 'plan';
const CAMPAIGN_DIR = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID);
const STATE_PATH = path.join(CAMPAIGN_DIR, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const LIVE_PATH = path.join(ROOT, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json');

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function loadInventory() {
  const snapshot = await readJson(SNAPSHOT_PATH);
  if (!snapshot || !Array.isArray(snapshot.articles)) {
    throw new Error('Audio truth snapshot is missing or invalid.');
  }
  if (snapshot.articles.length !== 15) {
    throw new Error(`All-article campaign requires exactly 15 inventoried articles; found ${snapshot.articles.length}.`);
  }
  const blocked = snapshot.articles.filter((item) => item.textReady !== true || item.generationAuthorized !== true);
  if (blocked.length) {
    throw new Error(`All-article campaign refused: ${blocked.map((item) => item.articleId).join(', ')} is not generation-authorized.`);
  }
  const ids = snapshot.articles.map((item) => item.articleId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('All-article campaign refused: duplicate article ids in truth snapshot.');
  }
  return snapshot.articles;
}

async function loadState() {
  const existing = await readJson(STATE_PATH, null);
  if (existing) {
    if (existing.campaignId !== CAMPAIGN_ID) {
      throw new Error(`Campaign state belongs to ${existing.campaignId}, expected ${CAMPAIGN_ID}.`);
    }
    if (existing.narrator?.model !== PRODUCTION_NARRATOR.model || existing.narrator?.voiceId !== PRODUCTION_NARRATOR.voiceId) {
      throw new Error('Campaign state narrator does not match the active production narrator.');
    }
    return existing;
  }
  return {
    schema: 'bareeq.audio-all-article-campaign.v1',
    campaignId: CAMPAIGN_ID,
    purpose: 'Fresh isolated regeneration of all 15 articles; candidates only; no publication.',
    narrator: PRODUCTION_NARRATOR,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    generationComplete: false,
    validationComplete: false,
    liveUntouched: true,
    articles: {},
  };
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  state.liveUntouched = true;
  await mkdir(CAMPAIGN_DIR, { recursive: true });
  await writeJson(STATE_PATH, state);
}

async function candidateEvidenceExists(articleId, fingerprint) {
  if (!fingerprint) return false;
  const dir = candidateDir(articleId, fingerprint, ROOT);
  return pathExists(path.join(dir, 'generation-report.json'));
}

async function planAll() {
  const inventory = await loadInventory();
  const live = await readJson(LIVE_PATH, { articles: [] });
  const durations = Object.fromEntries((live.articles || []).map((item) => [item.articleId, item.durationSeconds]));
  const articles = [];
  let totalTtsRequests = 0;
  for (const item of inventory) {
    const article = await loadSpokenArticle(item.articleId, ROOT);
    const split = splitSpokenArticle(article, {
      settings: QUOTA_SPLIT,
      liveDurationSeconds: durations[item.articleId] ?? null,
    });
    totalTtsRequests += split.ttsRequests;
    articles.push({
      articleId: item.articleId,
      title: item.title,
      spokenChars: article.spokenChars,
      ttsRequests: split.ttsRequests,
      maxPartEstimatedSeconds: split.maxPartEstimatedSeconds,
      maxPartEstimatedTokens: split.maxPartEstimatedTokens,
    });
  }
  return {
    schema: 'bareeq.audio-all-article-plan.v1',
    campaignId: CAMPAIGN_ID,
    narrator: PRODUCTION_NARRATOR,
    articleCount: articles.length,
    totalTtsRequests,
    expectedAsrInteractions: articles.length * 2,
    publish: false,
    liveUntouched: true,
    articles,
  };
}

async function generateAll() {
  const inventory = await loadInventory();
  const state = await loadState();
  for (const item of inventory) {
    const previous = state.articles[item.articleId] || {};
    if (previous.generation?.status === 'generated'
      && await candidateEvidenceExists(item.articleId, previous.generation.fingerprint)) {
      console.log(`GENERATION_RESUME_SKIP ${item.articleId} ${previous.generation.fingerprint}`);
      continue;
    }
    console.log(`GENERATION_START ${item.articleId}`);
    try {
      const result = await runProductionMode({
        mode: 'generate-candidate',
        articleId: item.articleId,
        root: ROOT,
      });
      state.articles[item.articleId] = {
        ...previous,
        generation: {
          status: result.status,
          fingerprint: result.fingerprint,
          ttsRequestsPlanned: result.ttsRequestsPlanned,
          ttsRequestsSent: result.ttsRequestsSent,
          ttsRequestsResumed: result.ttsRequestsResumed,
          providerAttempts: result.providerAttempts,
          completedParts: result.completedParts,
          transportsUsed: result.transportsUsed || [],
          completedAt: new Date().toISOString(),
        },
      };
      await saveState(state);
      console.log(`GENERATION_DONE ${item.articleId} ${result.fingerprint} sent=${result.ttsRequestsSent} resumed=${result.ttsRequestsResumed}`);
    } catch (error) {
      const partial = error?.result || {};
      const quota = error?.exitCode === EXIT_QUOTA || error?.httpStatus === 429 || error?.code === 'BAREEQ_QUOTA';
      state.articles[item.articleId] = {
        ...previous,
        generation: {
          status: quota ? 'paused-quota' : 'failed',
          fingerprint: partial.fingerprint || previous.generation?.fingerprint || null,
          ttsRequestsPlanned: partial.ttsRequestsPlanned ?? previous.generation?.ttsRequestsPlanned ?? null,
          ttsRequestsSent: partial.ttsRequestsSent ?? 0,
          ttsRequestsResumed: partial.ttsRequestsResumed ?? 0,
          providerAttempts: partial.providerAttempts ?? 0,
          completedParts: partial.completedParts ?? 0,
          pausedAtPart: partial.pausedAtPart ?? null,
          error: String(error.message || '').slice(0, 500),
          updatedAt: new Date().toISOString(),
        },
      };
      await saveState(state);
      throw error;
    }
  }
  state.generationComplete = true;
  await saveState(state);
  return state;
}

async function validateAll() {
  const inventory = await loadInventory();
  const state = await loadState();
  if (!state.generationComplete) {
    throw Object.assign(new Error('Validation refused: all-article generation is not complete.'), { exitCode: EXIT_HARD });
  }
  for (const item of inventory) {
    const previous = state.articles[item.articleId] || {};
    const fingerprint = previous.generation?.fingerprint;
    if (!fingerprint || previous.generation?.status !== 'generated') {
      throw Object.assign(new Error(`Validation refused: ${item.articleId} has no completed generated candidate.`), { exitCode: EXIT_HARD });
    }
    if (previous.validation?.status === 'validated' && previous.validation?.fingerprint === fingerprint) {
      console.log(`VALIDATION_RESUME_SKIP ${item.articleId} ${fingerprint}`);
      continue;
    }
    console.log(`VALIDATION_START ${item.articleId} ${fingerprint}`);
    try {
      const result = await validateWithConsensus({
        articleId: item.articleId,
        fingerprint,
        root: ROOT,
      });
      state.articles[item.articleId] = {
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
      console.log(`VALIDATION_DONE ${item.articleId} ${fingerprint} consensus=${JSON.stringify(result.consensus)}`);
    } catch (error) {
      const quota = error?.exitCode === EXIT_QUOTA || error?.httpStatus === 429 || error?.code === 'BAREEQ_QUOTA';
      state.articles[item.articleId] = {
        ...previous,
        validation: {
          status: quota ? 'paused-quota' : 'failed',
          fingerprint,
          error: String(error.message || '').slice(0, 500),
          updatedAt: new Date().toISOString(),
        },
      };
      await saveState(state);
      throw error;
    }
  }
  state.validationComplete = true;
  await saveState(state);
  return state;
}

async function main() {
  if (MODE === 'plan') {
    console.log(JSON.stringify(await planAll(), null, 2));
    return EXIT_OK;
  }
  if (MODE === 'generate') {
    const state = await generateAll();
    console.log(JSON.stringify({
      status: 'generated-all',
      campaignId: CAMPAIGN_ID,
      articleCount: Object.keys(state.articles).length,
      generationComplete: state.generationComplete,
      liveUntouched: state.liveUntouched,
    }, null, 2));
    return EXIT_OK;
  }
  if (MODE === 'validate') {
    const state = await validateAll();
    console.log(JSON.stringify({
      status: 'validated-all',
      campaignId: CAMPAIGN_ID,
      articleCount: Object.keys(state.articles).length,
      validationComplete: state.validationComplete,
      liveUntouched: state.liveUntouched,
    }, null, 2));
    return EXIT_OK;
  }
  throw Object.assign(new Error(`Unknown campaign mode ${MODE}; use plan | generate | validate.`), { exitCode: 2 });
}

try {
  const exitCode = await main();
  process.exit(exitCode);
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode || EXIT_HARD);
}
