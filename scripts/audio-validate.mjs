import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_CONFIG,
  EXIT_HARD,
  EXIT_OK,
  EXIT_USAGE,
  INDEPENDENT_ASR_MODELS,
  QUOTA_SPLIT,
  candidateDir,
  sha256,
} from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle, partFingerprint } from './audio-split.mjs';
import { expectedSyncIds, validateSyncMap } from './audio-sync.mjs';
import { checkpointPaths, pathExists, writeJson, writePlayerCompatibleCandidateManifest } from './audio-checkpoint.mjs';
import { mergeCandidateParts } from './audio-merge.mjs';
import { runTechnicalQa, inspectLiveSnapshot } from './audio-technical-qa.mjs';
import { transcribeFullAudio } from './audio-asr-transcribe.mjs';
import { publicPartSrc } from './audio-manifest.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { partFileName } from './audio-checkpoint.mjs';

export async function resolveLatestCandidateDir(articleId, root) {
  const { readdir } = await import('node:fs/promises');
  const parent = path.join(root, 'audio-candidates', articleId);
  if (!await pathExists(parent)) return null;
  const names = (await readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (!names.length) return null;
  names.sort();
  return path.join(parent, names[names.length - 1]);
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
  const article = await loadSpokenArticle(articleId, root);
  const splitPlan = splitSpokenArticle(article, { settings, liveDurationSeconds });
  const resolvedFingerprint = fingerprint || (await import('./audio-split.mjs')).candidateFingerprint(article, splitPlan);
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
  });
  const full = await readFile(paths.fullFile);
  const fullSha256 = sha256(full);

  const playerManifest = await writePlayerCompatibleCandidateManifest({
    article,
    splitPlan,
    paths,
    partAssets,
    fingerprint: resolvedFingerprint,
  });
  playerManifest.fullSha256 = fullSha256;
  await writeJson(paths.playerManifestFile, playerManifest);

  const sync = validateSyncMap(article, splitPlan.parts);
  const syncReport = {
    schema: 'bareeq.audio-sync.v1',
    articleId,
    fingerprint: resolvedFingerprint,
    fullSha256,
    ...sync,
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
    });
  } catch (error) {
    if (error.report) await writeJson(path.join(paths.reportsDir, 'technical-qa.json'), { ...error.report, fullSha256, fingerprint: resolvedFingerprint });
    throw error;
  }
  technical.fullSha256 = fullSha256;
  technical.fingerprint = resolvedFingerprint;
  await writeJson(path.join(paths.reportsDir, 'technical-qa.json'), technical);

  const asrReports = [];
  let filesApiUploads = 0;
  let asrInteractions = 0;
  if (!skipAsr) {
    if (!apiKey?.trim() && !fetchImpl) {
      throw Object.assign(new Error('GEMINI_API_KEY is absent. Dual ASR did not start. No transcription request was sent.'), { exitCode: EXIT_CONFIG });
    }
    for (const model of INDEPENDENT_ASR_MODELS) {
      const report = await transcribeFullAudio({
        model,
        audioPath: paths.fullFile,
        expectedText: article.spokenText,
        apiKey: apiKey || 'test-key',
        fetchImpl,
        outputPath: path.join(paths.reportsDir, `asr-${model}.json`),
        fingerprint: resolvedFingerprint,
        fullSha256,
      });
      filesApiUploads += Number(report.filesApiUploads || 1);
      asrInteractions += Number(report.asrInteractions || 1);
      asrReports.push(report);
    }
  }

  const listeningPack = [
    `# Human listening pack — ${article.title}`,
    '',
    `- Article: \`${articleId}\``,
    `- Candidate fingerprint: \`${resolvedFingerprint}\``,
    `- full.mp3 SHA-256: \`${fullSha256}\``,
    '- Status: **not performed**. This worksheet is not a passed review.',
    '- Bind `humanListening.evidence.sha256` to this exact full.mp3 digest before publish-approved.',
    '',
  ].join('\n');
  await mkdir(path.join(root, 'docs', 'audio', 'listening-packs'), { recursive: true }).catch(() => {});
  await writeFile(path.join(paths.reportsDir, 'listening-pack.md'), listeningPack);

  const report = {
    schema: 'bareeq.audio-validate.v1',
    articleId,
    fingerprint: resolvedFingerprint,
    fullSha256,
    merge,
    technical,
    sync: syncReport,
    asrReports,
    filesApiUploads,
    asrInteractions,
    asrProviderCalls: filesApiUploads + asrInteractions,
    liveUntouched: technical.liveUntouched,
    playerManifestValid: true,
    status: 'validated',
    exitCode: EXIT_OK,
  };
  await writeJson(path.join(paths.reportsDir, 'validate.json'), report);
  return report;
}
