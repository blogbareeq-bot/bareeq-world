import path from 'node:path';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import {
  EXIT_HARD,
  EXIT_OK,
  EXIT_QUOTA,
  EXIT_USAGE,
  GENERATOR_VERSION,
  liveAudioDir,
  PERFORMANCE_INSTRUCTIONS,
  QUOTA_SPLIT,
} from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle, partFingerprint, activeSplitSettings } from './audio-split.mjs';
import {
  appendRequestLog,
  initCheckpoint,
  loadCompletedPart,
  markQuotaPause,
  saveCompletedPart,
  writeJson,
} from './audio-checkpoint.mjs';
import { resolveProductionSynthesizer } from './audio-gemini-tts.mjs';

export class QuotaError extends Error {
  constructor(message = 'HTTP 429') {
    super(message);
    this.httpStatus = 429;
    this.code = 'BAREEQ_QUOTA';
  }
}

async function defaultLiveDuration(articleId, root) {
  try {
    const live = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json'), 'utf8'));
    return live.articles.find((item) => item.articleId === articleId)?.durationSeconds ?? null;
  } catch {
    return null;
  }
}

function unpackSynthesis(value) {
  if (Buffer.isBuffer(value)) return { audio: value, transport: 'developer-interactions', metadata: {} };
  if (Buffer.isBuffer(value?.audio)) {
    return {
      audio: value.audio,
      transport: value.transport || 'unknown',
      metadata: {
        endpoint: value.endpoint || null,
        projectId: value.projectId || null,
        model: value.model || null,
        voice: value.voice || null,
      },
    };
  }
  return { audio: null, transport: 'unknown', metadata: {} };
}

export async function generateCandidate({
  articleId,
  root = process.cwd(),
  storeRoot,
  synthesize,
  liveDurationSeconds = undefined,
  settings,
}) {
  if (!articleId) {
    const error = new Error('generate-candidate requires --article');
    error.exitCode = EXIT_USAGE;
    throw error;
  }
  if (typeof synthesize !== 'function') {
    const error = new Error('generate-candidate requires a synthesize function');
    error.exitCode = EXIT_USAGE;
    throw error;
  }

  const article = await loadSpokenArticle(articleId, root);
  const duration = liveDurationSeconds === undefined ? await defaultLiveDuration(articleId, root) : liveDurationSeconds;
  const splitPlan = splitSpokenArticle(article, { settings: activeSplitSettings(settings), liveDurationSeconds: duration });
  const { fingerprint, paths, checkpoint } = await initCheckpoint({ article, splitPlan, root: storeRoot || root });
  const liveDir = liveAudioDir(articleId, root);
  const transportsUsed = new Set();
  const resumedTransportDefault = process.env.BAREEQ_RESUMED_TTS_TRANSPORT?.trim() || 'checkpoint-unspecified';

  const result = {
    articleId,
    fingerprint,
    candidateDir: paths.dir,
    liveDir,
    ttsRequestsPlanned: splitPlan.parts.length,
    ttsRequestsSent: 0,
    ttsRequestsResumed: 0,
    providerAttempts: 0,
    successfulRequests: 0,
    quotaRejectedRequests: 0,
    failedRequests: 0,
    resumedParts: 0,
    completedParts: Object.keys(checkpoint.completedParts || {}).length,
    status: 'in-progress',
    liveUntouched: true,
  };

  for (const part of splitPlan.parts) {
    const existing = await loadCompletedPart(paths, article, splitPlan, part);
    if (existing) {
      const transport = existing.record?.transport || resumedTransportDefault;
      transportsUsed.add(transport);
      result.ttsRequestsResumed += 1;
      result.resumedParts += 1;
      await appendRequestLog(paths, {
        partIndex: part.partIndex,
        fingerprint: existing.fingerprint,
        action: 'resume-skip',
        providerCalls: 0,
        providerAttempts: 0,
        transport,
      });
      continue;
    }
    try {
      result.providerAttempts += 1;
      const synthesized = unpackSynthesis(await synthesize({
        article,
        part,
        splitPlan,
        fingerprint: partFingerprint(article, splitPlan, part),
        performanceInstructions: PERFORMANCE_INSTRUCTIONS,
        model: PRODUCTION_NARRATOR.model,
        voice: PRODUCTION_NARRATOR.providerVoice,
      }));
      const { audio, transport, metadata } = synthesized;
      if (!audio || audio.length < 100) throw new Error(`synthesized part ${part.partIndex} is too small`);
      transportsUsed.add(transport);
      result.ttsRequestsSent += 1;
      result.successfulRequests += 1;
      await saveCompletedPart(paths, article, splitPlan, part, audio, { resumed: false, transport });
      await appendRequestLog(paths, {
        partIndex: part.partIndex,
        fingerprint: partFingerprint(article, splitPlan, part),
        action: 'synthesize',
        providerCalls: 1,
        providerAttempts: 1,
        bytes: audio.length,
        transport,
        ...metadata,
      });
    } catch (error) {
      if (error?.httpStatus === 429 || error?.code === 'BAREEQ_QUOTA') {
        result.quotaRejectedRequests += 1;
        await markQuotaPause(paths, part.partIndex, error);
        await appendRequestLog(paths, {
          partIndex: part.partIndex,
          action: 'quota-pause',
          providerCalls: 1,
          providerAttempts: 1,
          httpStatus: 429,
          transport: process.env.BAREEQ_GEMINI_GENERATE_CONTENT === '1' ? 'developer-generate-content' : 'developer-interactions',
        });
        const quota = new QuotaError(error.message);
        quota.exitCode = EXIT_QUOTA;
        quota.result = { ...result, status: 'paused-quota', pausedAtPart: part.partIndex, exitCode: EXIT_QUOTA };
        throw quota;
      }
      result.failedRequests += 1;
      error.exitCode = error.exitCode || EXIT_HARD;
      throw error;
    }
  }

  result.status = 'generated';
  result.completedParts = splitPlan.parts.length;
  result.exitCode = EXIT_OK;
  result.transportsUsed = [...transportsUsed].sort();
  result.transportPolicy = process.env.BAREEQ_GEMINI_GENERATE_CONTENT === '1'
    ? 'generate-content-completion-with-resumed-checkpoint'
    : 'developer-interactions';
  await writeJson(path.join(paths.dir, 'generation-report.json'), {
    schema: 'bareeq.audio-generation.v2',
    articleId,
    candidateFingerprint: fingerprint,
    fingerprint,
    fullSha256: 'pending-merge',
    speechScriptHash: article.speechScriptHash,
    provider: PRODUCTION_NARRATOR.provider,
    model: PRODUCTION_NARRATOR.model,
    voice: PRODUCTION_NARRATOR.providerVoice,
    generatorVersion: GENERATOR_VERSION,
    toolVersion: GENERATOR_VERSION,
    status: 'generated',
    generatedAt: new Date().toISOString(),
    ...result,
    split: {
      version: splitPlan.settings.version,
      ttsRequests: splitPlan.ttsRequests,
      justification: splitPlan.justification,
      parts: splitPlan.parts.map((part) => ({
        partIndex: part.partIndex,
        chars: part.chars,
        bytes: part.bytes,
        estimatedSeconds: part.estimatedSeconds,
        estimatedTokens: part.estimatedTokens,
        syncIds: part.syncIds,
      })),
    },
  });
  return result;
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-generate-candidate.mjs';
if (isCli) {
  const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length);
  if (!articleId) {
    console.error('Usage: node scripts/audio-generate-candidate.mjs --article=<id>');
    process.exit(EXIT_USAGE);
  }
  try {
    const synthesize = await resolveProductionSynthesizer();
    const result = await generateCandidate({ articleId, synthesize });
    console.log(JSON.stringify({
      status: result.status,
      fingerprint: result.fingerprint,
      ttsRequestsSent: result.ttsRequestsSent,
      resumedParts: result.resumedParts,
      transportsUsed: result.transportsUsed,
    }, null, 2));
    process.exit(result.exitCode || EXIT_OK);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode || EXIT_HARD);
  }
}
