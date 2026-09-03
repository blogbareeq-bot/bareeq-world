import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import { EXIT_HARD, EXIT_OK, EXIT_QUOTA, candidateDir, sha256 } from './audio-constants.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { runProductionMode } from './audio-production.mjs';
import { validateWithConsensus } from './audio-validate-consensus.mjs';
import { synthesizeOpenRouterPart } from './audio-openrouter-tts.mjs';
import { loadPublicationPost, loadPublishRecord } from './audio-approval.mjs';
import { publishApprovedCandidate } from './audio-publish.mjs';
import { loadSpokenArticle } from './audio-split.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const MODE = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) || 'generate';
const CAMPAIGN_DIR = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID);
const STATE_PATH = path.join(CAMPAIGN_DIR, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const POLICY_PATH = path.join(ROOT, 'docs', 'audio', 'PUBLICATION-POLICY-20260901.json');
const PUBLISHED_MARKER_PATH = path.join(ROOT, 'docs', 'audio', 'PUBLISHED-SADALTAGER-OPENROUTER-20260901.json');
const PARTIAL_PUBLISHED_MARKER_PATH = path.join(ROOT, 'docs', 'audio', 'PUBLISHED-SADALTAGER-PARTIAL-20260903.json');

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

async function publicationPolicy() {
  const policy = await readJson(POLICY_PATH);
  if (!policy) throw Object.assign(new Error('Publication policy is missing.'), { exitCode: EXIT_HARD });
  if (policy.scope?.campaignId !== CAMPAIGN_ID) {
    throw Object.assign(new Error(`Publication policy targets ${policy.scope?.campaignId || 'unknown'}, expected ${CAMPAIGN_ID}.`), { exitCode: EXIT_HARD });
  }
  if (policy.scope?.model !== PRODUCTION_NARRATOR.model || policy.scope?.voice !== PRODUCTION_NARRATOR.providerVoice) {
    throw Object.assign(new Error('Publication policy narrator does not match the production narrator.'), { exitCode: EXIT_HARD });
  }
  if (policy.decision?.ownerWaiverForFullFileListening !== true || policy.decision?.sampleListeningAccepted !== true) {
    throw Object.assign(new Error('Publication policy does not authorize the sample-listening waiver.'), { exitCode: EXIT_HARD });
  }
  const gates = policy.mandatoryAutomatedGates || {};
  if (!gates.reviewedSpeechScript || !gates.independentDualAsr || !gates.technicalQa || !gates.syncQa || !gates.fingerprintBoundEvidence || !gates.manifestAndPartSha256) {
    throw Object.assign(new Error('Publication policy is missing one or more mandatory automated gates.'), { exitCode: EXIT_HARD });
  }
  const consensus = gates.asrConsensus || {};
  for (const key of ['substitutions', 'deletions', 'insertions', 'unresolved']) {
    if (Number(consensus[key]) !== 0) throw Object.assign(new Error(`Publication policy requires ${key}=0.`), { exitCode: EXIT_HARD });
  }
  return policy;
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
    publicationComplete: false,
    liveUntouched: true,
    articles: {},
  };
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
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
  if (state.publicationComplete) {
    console.log(`OPENROUTER_GENERATION_ALREADY_PUBLISHED articles=${items.length}`);
    return state;
  }
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
  if (state.publicationComplete) {
    console.log(`OPENROUTER_VALIDATION_ALREADY_PUBLISHED articles=${items.length}`);
    return state;
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

function exactConsensusZero(consensus = {}) {
  return ['substitutions', 'deletions', 'insertions', 'unresolved'].every((key) => Number(consensus[key]) === 0);
}

async function publishAll({ allowPartial = false } = {}) {
  const items = await inventory();
  const policy = await publicationPolicy();
  const state = await loadState();
  if (!allowPartial && !state.validationComplete) {
    throw Object.assign(new Error('Publication refused: OpenRouter validation is incomplete.'), { exitCode: EXIT_HARD });
  }
  const publishedArticles = [];
  const fallbackArticles = [];
  for (const item of items) {
    const previous = state.articles[item.articleId] || {};
    const fingerprint = previous.generation?.fingerprint;
    const validation = previous.validation || {};
    const publishable = Boolean(
      fingerprint
      && validation.status === 'validated'
      && validation.fingerprint === fingerprint
      && validation.fullSha256
      && exactConsensusZero(validation.consensus),
    );
    if (!publishable) {
      if (allowPartial) {
        fallbackArticles.push(item.articleId);
        console.log(`OPENROUTER_PARTIAL_PUBLICATION_FALLBACK ${item.articleId}`);
        continue;
      }
      throw Object.assign(new Error(`Publication refused: ${item.articleId} has no matching exact 0/0/0/0 candidate.`), { exitCode: EXIT_HARD });
    }
    publishedArticles.push(item.articleId);
    if (previous.publication?.status === 'published' && previous.publication?.fingerprint === fingerprint) {
      console.log(`OPENROUTER_PUBLICATION_RESUME_SKIP ${item.articleId} ${fingerprint}`);
      continue;
    }

    const dir = candidateDir(item.articleId, fingerprint, ROOT);
    const fullFile = path.join(dir, 'full.mp3');
    if (!await pathExists(fullFile)) {
      throw Object.assign(new Error(`Publication refused: ${item.articleId} full.mp3 is missing.`), { exitCode: EXIT_HARD });
    }
    const actualFullSha = sha256(await readFile(fullFile));
    if (actualFullSha !== validation.fullSha256) {
      throw Object.assign(new Error(`Publication refused: ${item.articleId} full-file SHA-256 changed after validation.`), { exitCode: EXIT_HARD });
    }

    const article = await loadSpokenArticle(item.articleId, ROOT);
    const post = await loadPublicationPost(item.articleId, ROOT);
    const record = await loadPublishRecord({
      candidateDir: dir,
      fingerprint,
      fullSha256: actualFullSha,
      article,
    });
    record.humanListening = {
      status: 'passed',
      reviewedBy: 'project-owner-sample-approval',
      reviewedAt: policy.effectiveAt,
      evidence: {
        sha256: actualFullSha,
        candidateFingerprint: fingerprint,
      },
      scope: 'sample-listening-plus-strict-automated-verification',
      fullFileListening: false,
      fullFileListeningWaived: true,
      policyFile: 'docs/audio/PUBLICATION-POLICY-20260901.json',
      note: 'Full-length per-article listening was explicitly waived by the project owner; accepted Sadaltager samples plus exact dual-ASR, technical QA, sync QA and fingerprint-bound evidence are required.',
    };

    console.log(`OPENROUTER_PUBLICATION_START ${item.articleId} ${fingerprint}`);
    const result = await publishApprovedCandidate({
      articleId: item.articleId,
      fingerprint,
      root: ROOT,
      post,
      record,
      listening: record.humanListening,
      persistGit: false,
    });
    state.articles[item.articleId] = {
      ...previous,
      publication: {
        status: result.status,
        fingerprint,
        fullSha256: result.fullSha256,
        liveDir: result.liveDir,
        completedAt: new Date().toISOString(),
        policy: 'docs/audio/PUBLICATION-POLICY-20260901.json',
      },
    };
    state.liveUntouched = false;
    await saveState(state);
    console.log(`OPENROUTER_PUBLICATION_DONE ${item.articleId} ${fingerprint}`);
  }

  if (allowPartial) {
    if (publishedArticles.length === 0 || fallbackArticles.length === 0) {
      throw Object.assign(new Error(`Partial publication requires both validated and fallback articles; validated=${publishedArticles.length} fallback=${fallbackArticles.length}.`), { exitCode: EXIT_HARD });
    }
    state.publicationComplete = false;
    state.liveUntouched = false;
    state.partialPublication = {
      status: 'published-with-fallback',
      publishedCount: publishedArticles.length,
      fallbackCount: fallbackArticles.length,
      publishedArticles,
      fallbackArticles,
      completedAt: new Date().toISOString(),
    };
    await saveState(state);
    const marker = {
      schema: 'bareeq.audio-openrouter-partial-published-tree.v1',
      campaignId: CAMPAIGN_ID,
      model: PRODUCTION_NARRATOR.model,
      voice: PRODUCTION_NARRATOR.providerVoice,
      publicationStatus: 'partial-with-existing-live-fallback',
      publicationComplete: false,
      publishedCount: publishedArticles.length,
      fallbackCount: fallbackArticles.length,
      publicationPolicy: 'docs/audio/PUBLICATION-POLICY-20260901.json',
      generatedAt: new Date().toISOString(),
      articles: publishedArticles.map((articleId) => ({
        articleId,
        fingerprint: state.articles[articleId]?.publication?.fingerprint,
        fullSha256: state.articles[articleId]?.publication?.fullSha256,
      })),
      fallbacks: fallbackArticles.map((articleId) => ({
        articleId,
        reason: 'awaiting-exact-dual-asr-campaign-completion',
      })),
    };
    await writeJson(PARTIAL_PUBLISHED_MARKER_PATH, marker);
    console.log(`OPENROUTER_PARTIAL_PUBLICATION_DONE published=${publishedArticles.length} fallback=${fallbackArticles.length}`);
    return state;
  }

  state.publicationComplete = true;
  state.liveUntouched = false;
  await saveState(state);
  const marker = {
    schema: 'bareeq.audio-openrouter-published-tree.v1',
    campaignId: CAMPAIGN_ID,
    model: PRODUCTION_NARRATOR.model,
    voice: PRODUCTION_NARRATOR.providerVoice,
    gateway: 'OpenRouter',
    articleCount: items.length,
    publicationPolicy: 'docs/audio/PUBLICATION-POLICY-20260901.json',
    generatedAt: new Date().toISOString(),
    articles: items.map((item) => ({
      articleId: item.articleId,
      fingerprint: state.articles[item.articleId]?.publication?.fingerprint,
      fullSha256: state.articles[item.articleId]?.publication?.fullSha256,
    })),
  };
  await writeJson(PUBLISHED_MARKER_PATH, marker);
  console.log(`OPENROUTER_PUBLICATION_ALL_DONE articles=${items.length}`);
  return state;
}

try {
  if (MODE === 'generate') await generateAll();
  else if (MODE === 'validate') await validateAll();
  else if (MODE === 'publish') await publishAll();
  else if (MODE === 'publish-current') await publishAll({ allowPartial: true });
  else throw Object.assign(new Error(`Unknown mode ${MODE}; use generate | validate | publish | publish-current.`), { exitCode: 2 });
  process.exit(EXIT_OK);
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode || EXIT_HARD);
}
