import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import {
  EXIT_HARD,
  EXIT_OK,
  EXIT_QUOTA,
  EXIT_USAGE,
  liveAudioDir,
  PERFORMANCE_INSTRUCTIONS,
} from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle, QUOTA_SPLIT, partFingerprint } from './audio-split.mjs';
import {
  appendRequestLog,
  initCheckpoint,
  loadCompletedPart,
  markQuotaPause,
  saveCompletedPart,
  writeJson,
} from './audio-checkpoint.mjs';

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

export async function generateCandidate({
  articleId,
  root = process.cwd(),
  storeRoot,
  synthesize,
  liveDurationSeconds = undefined,
  settings = QUOTA_SPLIT,
}) {
  if (!articleId) {
    const error = new Error('generate-candidate requires --article');
    error.exitCode = EXIT_USAGE;
    throw error;
  }
  if (typeof synthesize !== 'function') {
    const error = new Error('generate-candidate requires an injected synthesize function in this environment');
    error.exitCode = EXIT_USAGE;
    throw error;
  }

  const article = await loadSpokenArticle(articleId, root);
  const duration = liveDurationSeconds === undefined ? await defaultLiveDuration(articleId, root) : liveDurationSeconds;
  const splitPlan = splitSpokenArticle(article, { settings, liveDurationSeconds: duration });
  const { fingerprint, paths, checkpoint } = await initCheckpoint({ article, splitPlan, root: storeRoot || root });
  const liveDir = liveAudioDir(articleId, root);

  const result = {
    articleId,
    fingerprint,
    candidateDir: paths.dir,
    liveDir,
    ttsRequestsPlanned: splitPlan.parts.length,
    ttsRequestsSent: 0,
    ttsRequestsResumed: 0,
    completedParts: Object.keys(checkpoint.completedParts || {}).length,
    status: 'in-progress',
    liveUntouched: true,
  };

  for (const part of splitPlan.parts) {
    const existing = await loadCompletedPart(paths, article, splitPlan, part);
    if (existing) {
      result.ttsRequestsResumed += 1;
      await appendRequestLog(paths, {
        partIndex: part.partIndex,
        fingerprint: existing.fingerprint,
        action: 'resume-skip',
        providerCalls: 0,
      });
      continue;
    }
    try {
      const audio = await synthesize({
        article,
        part,
        splitPlan,
        fingerprint: partFingerprint(article, splitPlan, part),
        performanceInstructions: PERFORMANCE_INSTRUCTIONS,
        model: PRODUCTION_NARRATOR.model,
        voice: PRODUCTION_NARRATOR.providerVoice,
      });
      if (!audio || audio.length < 100) throw new Error(`synthesized part ${part.partIndex} is too small`);
      result.ttsRequestsSent += 1;
      await saveCompletedPart(paths, article, splitPlan, part, audio, { resumed: false });
      await appendRequestLog(paths, {
        partIndex: part.partIndex,
        fingerprint: partFingerprint(article, splitPlan, part),
        action: 'synthesize',
        providerCalls: 1,
        bytes: audio.length,
      });
    } catch (error) {
      if (error?.httpStatus === 429 || error?.code === 'BAREEQ_QUOTA') {
        await markQuotaPause(paths, part.partIndex, error);
        await appendRequestLog(paths, {
          partIndex: part.partIndex,
          action: 'quota-pause',
          providerCalls: 1,
          httpStatus: 429,
        });
        const quota = new QuotaError(error.message);
        quota.exitCode = EXIT_QUOTA;
        quota.result = { ...result, status: 'paused-quota', pausedAtPart: part.partIndex, exitCode: EXIT_QUOTA };
        throw quota;
      }
      error.exitCode = error.exitCode || EXIT_HARD;
      throw error;
    }
  }

  result.status = 'generated';
  result.completedParts = splitPlan.parts.length;
  result.exitCode = EXIT_OK;
  await writeJson(path.join(paths.dir, 'generation-report.json'), {
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
  if (!process.env.GEMINI_API_KEY?.trim() && process.env.BAREEQ_TTS_CONTRACT_TEST !== '1') {
    console.error('GEMINI_API_KEY is absent. Candidate generation did not start. No TTS request was sent.');
    process.exit(78);
  }
  console.error('CLI candidate generation without an injected synthesizer is reserved for the locked production workflow.');
  process.exit(78);
}
