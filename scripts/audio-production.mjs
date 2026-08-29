import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FALLBACK_NARRATOR, PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import {
  EXIT_CONFIG,
  EXIT_HARD,
  EXIT_OK,
  EXIT_QUOTA,
  EXIT_USAGE,
  INDEPENDENT_ASR_MODELS,
  FORBIDDEN_ASR_MODELS,
  LEGACY_SPLIT,
  QUOTA_SPLIT,
  GEMINI_TTS_CONTRACT,
  CLOUD_TTS_CONTRACT,
  candidateDir,
} from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';
import { generateCandidate } from './audio-generate-candidate.mjs';
import { validateCandidate } from './audio-validate.mjs';
import { publishApprovedCandidate } from './audio-publish.mjs';
import { resolveProductionSynthesizer } from './audio-gemini-tts.mjs';
import { pathExists } from './audio-checkpoint.mjs';
import { loadPublicationPost, loadPublishRecord } from './audio-approval.mjs';
import { assertSafeArticleId, assertSha256Fingerprint } from './audio-report.mjs';
import { snapshotLiveSadaltager } from './audio-verify-live.mjs';
import { sha256 } from './audio-constants.mjs';
import { assertSafeEvidencePath } from './audio-paths.mjs';

const ROOT = process.cwd();
const MODE = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length)
  || (process.argv.includes('--dry-run') ? 'dry-run' : process.argv.includes('--execute') ? 'generate-candidate' : 'dry-run');
const ARTICLE = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length) || process.env.BAREEQ_AUDIO_ARTICLE || '';
const FINGERPRINT = process.argv.find((arg) => arg.startsWith('--fingerprint='))?.slice('--fingerprint='.length) || process.env.BAREEQ_AUDIO_FINGERPRINT || '';
const LISTENING = process.argv.find((arg) => arg.startsWith('--listening='))?.slice('--listening='.length) || process.env.BAREEQ_AUDIO_LISTENING || '';
const RECORD = process.argv.find((arg) => arg.startsWith('--record='))?.slice('--record='.length) || process.env.BAREEQ_AUDIO_RECORD || '';
const OUT = path.join(ROOT, 'docs', 'audio', 'DRY-RUN.json');

export const MODES = ['dry-run', 'generate-candidate', 'validate-candidate', 'publish-approved', 'verify-live'];

const HTTP_PER_ARTICLE = {
  logicalUploads: 1,
  filesApiStartRequests: 1,
  filesApiFinalizeRequests: 1,
  filesApiMetadataRequests: 0,
  filesApiDeleteRequests: 1,
  interactionsRequests: INDEPENDENT_ASR_MODELS.length,
  totalHttpRequests: 1 + 1 + INDEPENDENT_ASR_MODELS.length + 1,
};

export async function buildDryRun(root = ROOT) {
  const snapshot = JSON.parse(await readFile(path.join(root, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json'), 'utf8'));
  const live = JSON.parse(await readFile(path.join(root, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json'), 'utf8'));
  const liveDuration = Object.fromEntries(live.articles.map((item) => [item.articleId, item.durationSeconds]));
  const reusable = snapshot.articles.filter((item) => item.reusePrimary);
  const replace = snapshot.articles.filter((item) => !item.reusePrimary);
  const plans = [];
  for (const item of snapshot.articles) {
    const http = { ...HTTP_PER_ARTICLE };
    if (item.reusePrimary) {
      plans.push({
        articleId: item.articleId,
        action: 'reuse-live-sadaltager',
        ttsRequestsBefore: 0,
        ttsRequestsAfter: 0,
        asrRequests: INDEPENDENT_ASR_MODELS.length,
        filesApiUploads: http.logicalUploads,
        ...http,
        asrProviderCalls: http.totalHttpRequests,
        reason: 'Live Gemini/Sadaltager already exists; do not regenerate.',
      });
      continue;
    }
    const article = await loadSpokenArticle(item.articleId, root);
    const duration = liveDuration[item.articleId] ?? null;
    const before = splitSpokenArticle(article, { settings: LEGACY_SPLIT, liveDurationSeconds: duration });
    const after = splitSpokenArticle(article, { settings: QUOTA_SPLIT, liveDurationSeconds: duration });
    plans.push({
      articleId: item.articleId,
      action: 'generate-sadaltager-candidate',
      liveDurationSeconds: duration,
      spokenChars: article.spokenChars,
      charsPerSecond: after.charsPerSecond,
      ttsRequestsBefore: before.ttsRequests,
      ttsRequestsAfter: after.ttsRequests,
      asrRequests: INDEPENDENT_ASR_MODELS.length,
      filesApiUploads: http.logicalUploads,
      ...http,
      asrProviderCalls: http.totalHttpRequests,
      maxPartBytes: after.maxPartBytes,
      maxPartEstimatedSeconds: after.maxPartEstimatedSeconds,
      maxPartEstimatedTokens: after.maxPartEstimatedTokens,
      geminiInputTokenLimit: GEMINI_TTS_CONTRACT.inputTokenLimit,
      geminiQualityCapSeconds: GEMINI_TTS_CONTRACT.qualityCapSeconds,
      justification: after.justification,
      parts: after.parts.map((part) => ({
        partIndex: part.partIndex,
        chars: part.chars,
        bytes: part.bytes,
        estimatedSeconds: part.estimatedSeconds,
        estimatedTokens: part.estimatedTokens,
        promptBytes: part.promptBytes,
        syncIds: part.syncIds,
        splitReason: part.splitReason,
        unavoidableReason: part.unavoidableReason || null,
      })),
    });
  }
  const sum = (key) => plans.reduce((total, item) => total + (item[key] || 0), 0);
  const report = {
    schema: 'bareeq.audio-production-dry-run.v4',
    generatedAt: new Date().toISOString(),
    mode: 'dry-run',
    narrator: PRODUCTION_NARRATOR,
    fallback: FALLBACK_NARRATOR,
    geminiTtsContract: GEMINI_TTS_CONTRACT,
    cloudTtsContract: CLOUD_TTS_CONTRACT,
    asr: {
      models: INDEPENDENT_ASR_MODELS,
      forbidden: FORBIDDEN_ASR_MODELS,
      file: 'full merged MP3 only',
      filesApi: 'resumable start → X-Goog-Upload-URL → upload, finalize → optional metadata GET → delete',
    },
    candidatePath: 'audio-candidates/<articleId>/<fingerprint>/',
    livePath: 'public/audio/articles/<key>/',
    chunking: {
      before: { settings: LEGACY_SPLIT, ttsRequests: sum('ttsRequestsBefore') },
      after: { settings: QUOTA_SPLIT, ttsRequests: sum('ttsRequestsAfter') },
    },
    reusableSadaltager: reusable.map((item) => item.articleId),
    replaceWithSadaltager: replace.map((item) => item.articleId),
    plans,
    expected: {
      ttsRequestsBefore: sum('ttsRequestsBefore'),
      ttsRequestsAfter: sum('ttsRequestsAfter'),
      asrRequests: sum('asrRequests'),
      filesApiUploads: sum('filesApiUploads'),
      logicalUploads: sum('logicalUploads'),
      filesApiStartRequests: sum('filesApiStartRequests'),
      filesApiFinalizeRequests: sum('filesApiFinalizeRequests'),
      filesApiMetadataRequests: sum('filesApiMetadataRequests'),
      filesApiDeleteRequests: sum('filesApiDeleteRequests'),
      interactionsRequests: sum('interactionsRequests'),
      totalHttpRequests: sum('totalHttpRequests'),
      asrProviderCalls: sum('totalHttpRequests'),
      asrModels: INDEPENDENT_ASR_MODELS,
    },
    resume: {
      storage: 'audio-candidates/<articleId>/<fingerprint>/parts with per-part fingerprint; atomic write + orphan MP3 recovery',
      quotaExitCode: EXIT_QUOTA,
      github: 'actions/cache + always() upload-artifact of audio-candidates/',
    },
  };
  return report;
}

export async function runProductionMode({
  mode,
  articleId,
  fingerprint,
  listeningPath,
  recordPath,
  root = ROOT,
  storeRoot,
  synthesize,
  fetchImpl,
  post,
  record,
  persistGit,
  liveDurationSeconds,
  settings = QUOTA_SPLIT,
  snapshotOnly = true,
  withAsr = false,
}) {
  if (!MODES.includes(mode)) {
    throw Object.assign(new Error(`Unknown mode ${mode}. Use ${MODES.join(' | ')}`), { exitCode: EXIT_USAGE });
  }
  if (mode === 'dry-run') {
    const report = await buildDryRun(root);
    const out = path.join(root, 'docs', 'audio', 'DRY-RUN.json');
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    return { ...report, exitCode: EXIT_OK };
  }
  if (!articleId) {
    throw Object.assign(new Error(`${mode} requires --article`), { exitCode: EXIT_USAGE });
  }
  if (!assertSafeArticleId(articleId)) {
    throw Object.assign(new Error('article id contains forbidden path characters'), { exitCode: EXIT_USAGE });
  }
  if (mode === 'generate-candidate') {
    const injected = typeof synthesize === 'function';
    if (!injected && process.env.BAREEQ_AUDIO_PRODUCTION_LOCK !== '1' && process.env.BAREEQ_TTS_CONTRACT_TEST !== '1') {
      throw Object.assign(new Error('generate-candidate requires BAREEQ_AUDIO_PRODUCTION_LOCK=1. No TTS request was sent.'), { exitCode: EXIT_CONFIG });
    }
    const synth = synthesize || await resolveProductionSynthesizer({ fetchImpl });
    return generateCandidate({
      articleId,
      root,
      storeRoot,
      synthesize: synth,
      liveDurationSeconds,
      settings,
    });
  }
  if (mode === 'validate-candidate') {
    if (!fingerprint) {
      throw Object.assign(new Error('validate-candidate requires --fingerprint; it will not pick the latest candidate'), { exitCode: EXIT_USAGE });
    }
    if (process.env.BAREEQ_TTS_CONTRACT_TEST !== '1' && !assertSha256Fingerprint(fingerprint)) {
      throw Object.assign(new Error('fingerprint must be a 64-character SHA-256 hex digest'), { exitCode: EXIT_USAGE });
    }
    return validateCandidate({
      articleId,
      fingerprint,
      root,
      storeRoot,
      settings,
      liveDurationSeconds,
      fetchImpl,
    });
  }
  if (mode === 'verify-live') {
    return snapshotLiveSadaltager({
      articleId,
      root: storeRoot || root,
      fetchImpl,
      skipAsr: !withAsr,
      withAsr: Boolean(withAsr),
    });
  }
  if (mode === 'publish-approved') {
    if (!fingerprint) {
      throw Object.assign(new Error('publish-approved requires --fingerprint; it will not pick the latest candidate'), { exitCode: EXIT_USAGE });
    }
    if (process.env.BAREEQ_TTS_CONTRACT_TEST !== '1' && !assertSha256Fingerprint(fingerprint)) {
      throw Object.assign(new Error('fingerprint must be a 64-character SHA-256 hex digest'), { exitCode: EXIT_USAGE });
    }
    const resolvedFingerprint = fingerprint;
    const candidatePath = candidateDir(articleId, resolvedFingerprint, storeRoot || root);
    if (!await pathExists(candidatePath)) {
      throw Object.assign(new Error('publish-approved refused: candidate files are missing'), { exitCode: EXIT_HARD });
    }
    if (!listeningPath && !recordPath && !record) {
      throw Object.assign(new Error('publish-approved requires --listening=<file> or --record=<file>; generic listening is refused'), { exitCode: EXIT_USAGE });
    }
    const publicationPost = post || await loadPublicationPost(articleId, root);
    const article = await loadSpokenArticle(articleId, root);
    let fullSha256 = null;
    try {
      const { readFile: read } = await import('node:fs/promises');
      fullSha256 = sha256(await read(path.join(candidatePath, 'full.mp3')));
    } catch {
      fullSha256 = null;
    }
    const publicationRecord = record || await loadPublishRecord({
      candidateDir: candidatePath,
      listeningPath,
      recordPath,
      fingerprint: resolvedFingerprint,
      fullSha256,
      article,
    });
    return publishApprovedCandidate({
      articleId,
      fingerprint: resolvedFingerprint,
      root: storeRoot || root,
      post: publicationPost,
      record: publicationRecord,
      listening: publicationRecord.humanListening,
      persistGit,
    });
  }
  throw Object.assign(new Error(`unhandled mode ${mode}`), { exitCode: EXIT_USAGE });
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-production.mjs';
if (isCli) {
  try {
    if (!MODES.includes(MODE)) {
      console.error(`Unknown mode ${MODE}. Use ${MODES.join(' | ')}`);
      process.exit(EXIT_USAGE);
    }
    const withAsr = process.argv.includes('--with-asr');
    const snapshotOnly = process.argv.includes('--snapshot-only') || !withAsr;
    if (withAsr && process.argv.includes('--snapshot-only')) {
      console.error('verify-live cannot combine --snapshot-only and --with-asr');
      process.exit(EXIT_USAGE);
    }
    const result = await runProductionMode({
      mode: MODE,
      articleId: ARTICLE,
      fingerprint: FINGERPRINT,
      listeningPath: LISTENING,
      recordPath: RECORD,
      root: ROOT,
      snapshotOnly,
      withAsr,
    });
    if (MODE === 'dry-run') {
      console.log(`Audio production dry-run: reuse ${result.reusableSadaltager.length}; replace ${result.replaceWithSadaltager.length}.`);
      console.log(`TTS requests before (2400-byte cap): ${result.expected.ttsRequestsBefore}. After Gemini 8192-token / 180s pack: ${result.expected.ttsRequestsAfter}.`);
      console.log(`ASR interactions: ${result.expected.asrRequests}. Files start/finalize/delete: ${result.expected.filesApiStartRequests}/${result.expected.filesApiFinalizeRequests}/${result.expected.filesApiDeleteRequests}. Total HTTP: ${result.expected.totalHttpRequests}.`);
      for (const item of result.plans) {
        if (item.action === 'reuse-live-sadaltager') {
          console.log(`- ${item.articleId}: reuse; TTS 0; ASR ${item.asrRequests}; HTTP ${item.totalHttpRequests}`);
        } else {
          const short = item.parts?.filter((part) => part.estimatedSeconds < QUOTA_SPLIT.minSeconds) || [];
          console.log(`- ${item.articleId}: candidate TTS ${item.ttsRequestsBefore} → ${item.ttsRequestsAfter}; ASR ${item.asrRequests}; HTTP ${item.totalHttpRequests}${item.justification ? ` (${item.justification})` : ''}${short.length ? ` short-parts=${short.map((part) => part.estimatedSeconds).join(',')}` : ''}`);
        }
      }
      console.log(`Dry-run written to ${path.relative(ROOT, OUT)}. Zero provider requests were sent.`);
    } else {
      console.log(JSON.stringify({
        mode: MODE,
        status: result.status || 'ok',
        articleId: ARTICLE,
        fingerprint: result.fingerprint,
        fullSha256: result.fullSha256,
        liveDir: result.liveDir,
      }, null, 2));
    }
    process.exit(result.exitCode || EXIT_OK);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode || EXIT_HARD);
  }
}
