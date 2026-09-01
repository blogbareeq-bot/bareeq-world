import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import { EXIT_HARD, EXIT_OK, EXIT_QUOTA, candidateDir } from './audio-constants.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { runProductionMode } from './audio-production.mjs';
import { validateWithConsensus } from './audio-validate-consensus.mjs';
import { synthesizeOpenRouterPart } from './audio-openrouter-tts.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const MODE = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) || 'generate';
const CAMPAIGN_DIR = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID);
const STATE_PATH = path.join(CAMPAIGN_DIR, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function inventory() {
  const snapshot = await readJson(SNAPSHOT_PATH);
  if (!snapshot || !Array.isArray(snapshot.articles) || snapshot.articles.length !== 15) {
    throw Object.assign(new Error('OpenRouter campaign requires the 15-article audio truth snapshot.'), { exitCode: EXIT_HARD });
  }
  const blocked = snapshot.articles.filter((item) => item.textReady !== true || item.generationAuthorized !== true);
  if (blocked.length) {
    throw Object.assign(new Error(`Generation refused: ${blocked.map((item) => item.articleId).join(', ')} is not authorized.`), { exitCode: EXIT_HARD });
  }
  return snapshot.articles;
}

async function loadState() {
  const existing = await readJson(STATE_PATH);
  if (existing) return existing;
  return {
    schema: 'bareeq.audio-openrouter-campaign.v1',
    campaignId: CAMPAIGN_ID,
    narrator: PRODUCTION_NARRATOR,
    gateway: {
      provider: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1/audio/speech',
      model: `google/${PRODUCTION_NARRATOR.model}`,
      voice: PRODUCTION_NARRATOR.providerVoice,
    },
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

async function evidenceExists(articleId, fingerprint) {
  if (!fingerprint) return false;
  return pathExists(path.join(candidateDir(articleId, fingerprint, ROOT), 'generation-report.json'));
}

async function generateAll() {
  const items = await inventory();
  const state = await loadState();
  for (const item of items) {
    const previous = state.articles[item.articleId] || {};
    if (previous.generation?.status === 'generated' && await evidenceExists(item.articleId, previous.generation.fingerprint)) {
      console.log(`OPENROUTER_GENERATION_RESUME_SKIP ${item.articleId} ${previous.generation.fingerprint}`);
      continue;
    }
    console.log(`OPENROUTER_GENERATION_START ${item.articleId}`);
    try {
      const result = await runProductionMode({
        mode: 'generate-candidate',
        articleId: item.articleId,
        root: ROOT,
        synthesize: ({ part, voice }) => synthesizeOpenRouterPart({ part, voice }),
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
      console.log(`OPENROUTER_GENERATION_DONE ${item.articleId} ${result.fingerprint} sent=${result.ttsRequestsSent} resumed=${result.ttsRequestsResumed}`);
    } catch (error) {
      const partial = error?.result || {};
      const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || [402, 429].includes(error?.httpStatus);
      state.articles[item.articleId] = {
        ...previous,
        generation: {
          status: quota ? 'paused-quota' : 'failed',
          fingerprint: partial.fingerprint || previous.generation?.fingerprint || null,
          ttsRequestsPlanned: partial.ttsRequestsPlanned ?? previous.generation?.ttsRequestsPlanned ?? null,
          ttsRequestsSent: partial.ttsRequestsSent ?? 0,
          ttsRequestsResumed: partial.ttsRequestsResumed ?? 0,
          completedParts: partial.completedParts ?? 0,
          pausedAtPart: partial.pausedAtPart ?? null,
          error: String(error.message || '').slice(0, 700),
          updatedAt: new Date().toISOString(),
        },
      };
      await saveState(state);
      throw error;
    }
  }
  state.generationComplete = true;
  await saveState(state);
  console.log(`OPENROUTER_GENERATION_ALL_DONE articles=${items.length}`);
  return state;
}

async function validateAll() {
  const items = await inventory();
  const state = await loadState();
  if (!state.generationComplete) {
    throw Object.assign(new Error('Validation refused: OpenRouter generation is incomplete.'), { exitCode: EXIT_HARD });
  }
  for (const item of items) {
    const previous = state.articles[item.articleId] || {};
    const fingerprint = previous.generation?.fingerprint;
    if (!fingerprint || previous.generation?.status !== 'generated') {
      throw Object.assign(new Error(`Validation refused: ${item.articleId} is not fully generated.`), { exitCode: EXIT_HARD });
    }
    if (previous.validation?.status === 'validated' && previous.validation?.fingerprint === fingerprint) {
      console.log(`OPENROUTER_VALIDATION_RESUME_SKIP ${item.articleId} ${fingerprint}`);
      continue;
    }
    console.log(`OPENROUTER_VALIDATION_START ${item.articleId} ${fingerprint}`);
    try {
      const result = await validateWithConsensus({ articleId: item.articleId, fingerprint, root: ROOT });
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
      console.log(`OPENROUTER_VALIDATION_DONE ${item.articleId} consensus=${JSON.stringify(result.consensus)}`);
    } catch (error) {
      const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
      state.articles[item.articleId] = {
        ...previous,
        validation: {
          status: quota ? 'paused-quota' : 'failed',
          fingerprint,
          error: String(error.message || '').slice(0, 700),
          updatedAt: new Date().toISOString(),
        },
      };
      await saveState(state);
      throw error;
    }
  }
  state.validationComplete = true;
  await saveState(state);
  console.log(`OPENROUTER_VALIDATION_ALL_DONE articles=${items.length}`);
  return state;
}

try {
  if (MODE === 'generate') await generateAll();
  else if (MODE === 'validate') await validateAll();
  else throw Object.assign(new Error(`Unknown mode ${MODE}; use generate | validate.`), { exitCode: 2 });
  process.exit(EXIT_OK);
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode || EXIT_HARD);
}
