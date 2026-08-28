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
} from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';

const ROOT = process.cwd();
const MODE = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length)
  || (process.argv.includes('--dry-run') ? 'dry-run' : process.argv.includes('--execute') ? 'generate-candidate' : 'dry-run');
const ARTICLE = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length) || '';
const OUT = path.join(ROOT, 'docs', 'audio', 'DRY-RUN.json');

const MODES = ['dry-run', 'generate-candidate', 'validate-candidate', 'publish-approved'];

export async function buildDryRun(root = ROOT) {
  const snapshot = JSON.parse(await readFile(path.join(root, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json'), 'utf8'));
  const live = JSON.parse(await readFile(path.join(root, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json'), 'utf8'));
  const liveDuration = Object.fromEntries(live.articles.map((item) => [item.articleId, item.durationSeconds]));
  const reusable = snapshot.articles.filter((item) => item.reusePrimary);
  const replace = snapshot.articles.filter((item) => !item.reusePrimary);
  const plans = [];
  for (const item of snapshot.articles) {
    if (item.reusePrimary) {
      plans.push({
        articleId: item.articleId,
        action: 'reuse-live-sadaltager',
        ttsRequestsBefore: 0,
        ttsRequestsAfter: 0,
        asrRequests: INDEPENDENT_ASR_MODELS.length,
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
      maxPartBytes: after.maxPartBytes,
      maxPartEstimatedSeconds: after.maxPartEstimatedSeconds,
      officialTextLimitBytes: QUOTA_SPLIT.officialTextLimitBytes,
      officialOutputSeconds: QUOTA_SPLIT.officialOutputSeconds,
      justification: after.justification,
      parts: after.parts.map((part) => ({
        partIndex: part.partIndex,
        chars: part.chars,
        bytes: part.bytes,
        estimatedSeconds: part.estimatedSeconds,
        promptBytes: part.promptBytes,
      })),
    });
  }
  const report = {
    schema: 'bareeq.audio-production-dry-run.v2',
    generatedAt: new Date().toISOString(),
    mode: 'dry-run',
    narrator: PRODUCTION_NARRATOR,
    fallback: FALLBACK_NARRATOR,
    asr: {
      models: INDEPENDENT_ASR_MODELS,
      forbidden: FORBIDDEN_ASR_MODELS,
      file: 'full merged MP3 only',
    },
    candidatePath: 'audio-candidates/<articleId>/<fingerprint>/',
    livePath: 'public/audio/articles/<key>/',
    chunking: {
      before: { settings: LEGACY_SPLIT, ttsRequests: plans.reduce((sum, item) => sum + (item.ttsRequestsBefore || 0), 0) },
      after: { settings: QUOTA_SPLIT, ttsRequests: plans.reduce((sum, item) => sum + (item.ttsRequestsAfter || 0), 0) },
    },
    reusableSadaltager: reusable.map((item) => item.articleId),
    replaceWithSadaltager: replace.map((item) => item.articleId),
    plans,
    expected: {
      ttsRequestsBefore: plans.reduce((sum, item) => sum + (item.ttsRequestsBefore || 0), 0),
      ttsRequestsAfter: plans.reduce((sum, item) => sum + (item.ttsRequestsAfter || 0), 0),
      asrRequests: plans.reduce((sum, item) => sum + (item.asrRequests || 0), 0),
      asrModels: INDEPENDENT_ASR_MODELS,
    },
    resume: {
      storage: 'audio-candidates/<articleId>/<fingerprint>/parts with per-part fingerprint',
      quotaExitCode: EXIT_QUOTA,
      github: 'actions/cache + always() upload-artifact of audio-candidates/',
    },
  };
  return report;
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-production.mjs';
if (isCli) {
  if (!MODES.includes(MODE)) {
    console.error(`Unknown mode ${MODE}. Use ${MODES.join(' | ')}`);
    process.exit(EXIT_USAGE);
  }
  if (MODE === 'dry-run') {
    const report = await buildDryRun(ROOT);
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Audio production dry-run: reuse ${report.reusableSadaltager.length}; replace ${report.replaceWithSadaltager.length}.`);
    console.log(`TTS requests before (2400-byte cap): ${report.expected.ttsRequestsBefore}. After duration/sentence pack: ${report.expected.ttsRequestsAfter}.`);
    console.log(`ASR requests: ${report.expected.asrRequests} on merged files via ${INDEPENDENT_ASR_MODELS.join(' + ')}.`);
    for (const item of report.plans) {
      if (item.action === 'reuse-live-sadaltager') {
        console.log(`- ${item.articleId}: reuse; TTS 0; ASR ${item.asrRequests}`);
      } else {
        console.log(`- ${item.articleId}: candidate TTS ${item.ttsRequestsBefore} → ${item.ttsRequestsAfter}; ASR ${item.asrRequests}${item.justification ? ` (${item.justification})` : ''}`);
      }
    }
    console.log(`Dry-run written to ${path.relative(ROOT, OUT)}. Zero provider requests were sent.`);
    process.exit(EXIT_OK);
  }
  if (!ARTICLE) {
    console.error(`${MODE} requires --article`);
    process.exit(EXIT_USAGE);
  }
  if (MODE === 'generate-candidate') {
    console.error('generate-candidate writes only to audio-candidates/ and requires BAREEQ_AUDIO_PRODUCTION_LOCK=1 plus an injected/workflow synthesizer. Live audio is not modified.');
    if (!process.env.GEMINI_API_KEY?.trim()) {
      console.error('GEMINI_API_KEY is absent. No TTS request was sent.');
      process.exit(EXIT_CONFIG);
    }
    if (process.env.BAREEQ_AUDIO_PRODUCTION_LOCK !== '1') {
      console.error('Lock is not set. No TTS request was sent.');
      process.exit(EXIT_CONFIG);
    }
    process.exit(EXIT_CONFIG);
  }
  if (MODE === 'validate-candidate') {
    console.error('validate-candidate merges, runs technical QA, dual ASR, and writes a listening pack. It never publishes.');
    process.exit(EXIT_CONFIG);
  }
  if (MODE === 'publish-approved') {
    console.error('publish-approved refuses to run without human listening tied to the candidate file fingerprint.');
    process.exit(EXIT_HARD);
  }
}
