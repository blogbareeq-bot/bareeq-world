import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_CONFIG,
  EXIT_HARD,
  EXIT_OK,
  EXIT_USAGE,
  QUOTA_SPLIT,
  candidateDir,
  sha256,
  GENERATOR_VERSION,
} from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle, partFingerprint, activeSplitSettings } from './audio-split.mjs';
import { expectedSyncIds, validateSyncMap } from './audio-sync.mjs';
import { checkpointPaths, pathExists, writeJson, writePlayerCompatibleCandidateManifest } from './audio-checkpoint.mjs';
import { mergeCandidateParts } from './audio-merge.mjs';
import { runTechnicalQa, inspectLiveSnapshot } from './audio-technical-qa.mjs';
import { transcribeDualAsr } from './audio-asr-transcribe.mjs';
import { publicPartSrc } from './audio-manifest.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { partFileName } from './audio-checkpoint.mjs';
import { boundIdentity } from './audio-report.mjs';
import { ORIGINAL_REPORTS } from './audio-evidence.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';

export async function resolveLatestCandidateDir(articleId, root) {
  throw Object.assign(new Error('validate-candidate will not pick the latest candidate'), { exitCode: EXIT_USAGE });
}

function stamp(article, fingerprint, fullSha256, status, schema, extra = {}) {
  return boundIdentity({ article, fingerprint, fullSha256, status, schema, extra });
}

export async function validateCandidate({
  articleId,
  fingerprint,
  root = process.cwd(),
  storeRoot,
  settings = QUOTA_SPLIT,
  liveDurationSeconds = null,
  fetchImpl,
  apiKey = process.env.GEMINI_API_KEY,
  skipAsr = false,
}) {
  if (!articleId) {
    throw Object.assign(new Error('validate-candidate requires --article'), { exitCode: EXIT_USAGE });
  }
  if (!fingerprint) {
    throw Object.assign(new Error('validate-candidate requires --fingerprint; it will not pick the latest candidate'), { exitCode: EXIT_USAGE });
  }
  const article = await loadSpokenArticle(articleId, root);
  const splitPlan = splitSpokenArticle(article, { settings: activeSplitSettings(settings), liveDurationSeconds });
  const resolvedFingerprint = fingerprint;
  const dir = candidateDir(articleId, resolvedFingerprint, storeRoot || root);
  const paths = checkpointPaths(articleId, resolvedFingerprint, storeRoot || root);
  if (!await pathExists(dir)) {
    throw Object.assign(new Error(`validate-candidate refused: candidate missing at ${dir}`), { exitCode: EXIT_HARD });
  }

  const partFiles = [];
  const partAssets = [];
  for (const part of splitPlan.parts) {
    const digest = partFingerprint(article, splitPlan, part);
    const file = path.join(paths.partsDir, partFileName(part.partIndex, digest));
    if (!await pathExists(file)) {
      throw Object.assign(new Error(`validate-candidate refused: missing ${path.basename(file)}`), { exitCode: EXIT_HARD });
    }
    const bytes = await readFile(file);
    partFiles.push(file);
    partAssets.push({
      src: publicPartSrc(articleId, path.basename(file)),
      bytes: bytes.length,
      durationSeconds: mp3DurationSeconds(bytes),
      sha256: sha256(bytes),
      file: path.basename(file),
    });
  }

  const merge = await mergeCandidateParts({
    articleId,
    fingerprint: resolvedFingerprint,
    root: storeRoot || root,
    partFiles,
    speechScriptHash: article.speechScriptHash,
  });
  const full = await readFile(paths.fullFile);
  const fullSha256 = sha256(full);
  Object.assign(merge, stamp(article, resolvedFingerprint, fullSha256, 'merged', 'bareeq.audio-merge.v1'));
  merge.fullSha256 = fullSha256;
  merge.sha256 = merge.sha256 || fullSha256;
  merge.speechScriptHash = article.speechScriptHash;
  await writeJson(path.join(paths.reportsDir, 'merge.json'), merge);

  const playerManifest = await writePlayerCompatibleCandidateManifest({
    article,
    splitPlan,
    paths,
    partAssets,
    fingerprint: resolvedFingerprint,
  });
  Object.assign(playerManifest, stamp(article, resolvedFingerprint, fullSha256, 'validated', 'bareeq.audio-production-manifest.v3', {
    generatedAt: new Date().toISOString(),
  }));
  playerManifest.fullSha256 = fullSha256;
  playerManifest.parts = playerManifest.parts;
  await writeJson(paths.playerManifestFile, playerManifest);

  const candidateManifest = {
    ...(await pathExists(paths.manifestFile) ? JSON.parse(await readFile(paths.manifestFile, 'utf8')) : {}),
    ...stamp(article, resolvedFingerprint, fullSha256, 'validated', 'bareeq.audio-candidate.v3'),
    title: article.title,
    parts: splitPlan.parts.map((part, index) => ({
      partIndex: part.partIndex,
      fingerprint: partFingerprint(article, splitPlan, part),
      chars: part.chars,
      bytes: part.bytes,
      estimatedSeconds: part.estimatedSeconds,
      estimatedTokens: part.estimatedTokens,
      sync: part.sync || [],
      syncIds: part.syncIds || [],
      file: partAssets[index].file,
      sha256: partAssets[index].sha256,
    })),
  };
  await writeJson(paths.manifestFile, candidateManifest);

  const sync = validateSyncMap(article, splitPlan.parts);
  const syncReport = {
    ...stamp(article, resolvedFingerprint, fullSha256, sync.passed ? 'passed' : 'failed', 'bareeq.audio-sync.v2'),
    ...sync,
    status: sync.passed ? 'passed' : 'failed',
  };
  await writeJson(path.join(paths.reportsDir, 'sync.json'), syncReport);
  if (!sync.passed) {
    throw Object.assign(new Error(`sync is mandatory: ${sync.failures.join('; ')}`), { exitCode: EXIT_HARD, report: syncReport });
  }

  const liveBefore = await inspectLiveSnapshot(articleId, root);
  let technical;
  try {
    technical = await runTechnicalQa({
      articleId,
      fingerprint: resolvedFingerprint,
      root: storeRoot || root,
      expectedSyncIds: expectedSyncIds(article),
      liveBefore,
      fullSha256,
      article,
    });
  } catch (error) {
    if (error.report) {
      await writeJson(path.join(paths.reportsDir, 'technical-qa.json'), {
        ...stamp(article, resolvedFingerprint, fullSha256, 'failed', 'bareeq.audio-technical-qa.v4'),
        ...error.report,
        fullSha256,
        candidateFingerprint: resolvedFingerprint,
        status: 'failed',
      });
    }
    throw error;
  }
  technical = {
    ...stamp(article, resolvedFingerprint, fullSha256, 'passed', 'bareeq.audio-technical-qa.v4'),
    ...technical,
    fullSha256,
    candidateFingerprint: resolvedFingerprint,
    status: 'passed',
  };
  await writeJson(path.join(paths.reportsDir, 'technical-qa.json'), technical);

  const asrReports = [];
  let filesApiUploads = 0;
  let asrInteractions = 0;
  let httpCounts = {};
  if (!skipAsr) {
    if (!apiKey?.trim() && !fetchImpl) {
      throw Object.assign(new Error('GEMINI_API_KEY is absent. Dual ASR did not start. No transcription request was sent.'), { exitCode: EXIT_CONFIG });
    }
    try {
      const dual = await transcribeDualAsr({
        audioPath: paths.fullFile,
        expectedText: article.spokenText,
        apiKey: apiKey || 'test-key',
        fetchImpl,
        reportsDir: paths.reportsDir,
        fingerprint: resolvedFingerprint,
        fullSha256,
        article,
      });
      filesApiUploads = dual.filesApiUploads;
      asrInteractions = dual.asrInteractions;
      asrReports.push(...dual.asrReports);
      httpCounts = dual;
    } catch (error) {
      if (error.dual?.asrReports) asrReports.push(...error.dual.asrReports);
      throw error;
    }
  }

  const listeningPack = [
    `# Human listening pack — ${article.title}`,
    '',
    `- Article: \`${articleId}\``,
    `- Candidate fingerprint: \`${resolvedFingerprint}\``,
    `- full.mp3 SHA-256: \`${fullSha256}\``,
    `- speechScriptHash: \`${article.speechScriptHash}\``,
    '- Status: **not performed**. This worksheet is not a passed review.',
    '- Bind `humanListening.evidence.sha256` and `evidence.candidateFingerprint` before publish-approved.',
    '',
  ].join('\n');
  await mkdir(path.join(root, 'docs', 'audio', 'listening-packs'), { recursive: true }).catch(() => {});
  await writeFile(path.join(paths.reportsDir, 'listening-pack.md'), listeningPack);

  await writeJson(path.join(paths.dir, 'generation-report.json'), {
    ...stamp(article, resolvedFingerprint, fullSha256, 'generated', 'bareeq.audio-generation.v2'),
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
        splitReason: part.splitReason,
      })),
    },
  });

  const reportDigests = {};
  for (const item of ORIGINAL_REPORTS) {
    if (item.label === 'validate') continue;
    const file = path.join(paths.dir, item.file);
    if (await pathExists(file)) reportDigests[item.file] = sha256(await readFile(file));
  }

  const report = {
    ...stamp(article, resolvedFingerprint, fullSha256, 'validated', 'bareeq.audio-validate.v2'),
    reportDigests,
    merge,
    technical,
    sync: syncReport,
    asrReports,
    filesApiUploads,
    asrInteractions,
    asrProviderCalls: httpCounts.totalHttpRequests || (filesApiUploads + asrInteractions),
    logicalUploads: httpCounts.logicalUploads || filesApiUploads,
    filesApiStartRequests: httpCounts.filesApiStartRequests,
    filesApiFinalizeRequests: httpCounts.filesApiFinalizeRequests,
    filesApiMetadataRequests: httpCounts.filesApiMetadataRequests,
    filesApiDeleteRequests: httpCounts.filesApiDeleteRequests,
    interactionsRequests: httpCounts.interactionsRequests,
    totalHttpRequests: httpCounts.totalHttpRequests,
    liveUntouched: technical.liveUntouched,
    playerManifestValid: true,
    narrator: PRODUCTION_NARRATOR,
    generatorVersion: GENERATOR_VERSION,
    exitCode: EXIT_OK,
  };
  await writeJson(path.join(paths.reportsDir, 'validate.json'), report);
  return report;
}
