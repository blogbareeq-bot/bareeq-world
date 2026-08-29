import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_HARD, INDEPENDENT_ASR_MODELS, FORBIDDEN_ASR_MODELS, sha256 } from './audio-constants.mjs';
import { pathExists } from './audio-checkpoint.mjs';
import { assertBoundReport, missingBoundFields } from './audio-report.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

export async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export const ORIGINAL_REPORTS = [
  { file: 'generation-report.json', label: 'generation' },
  { file: 'manifest.candidate.json', label: 'candidate-manifest' },
  { file: 'manifest.json', label: 'player-manifest' },
  { file: 'reports/merge.json', label: 'merge' },
  { file: 'reports/technical-qa.json', label: 'technical-qa' },
  { file: 'reports/sync.json', label: 'sync' },
  { file: `reports/asr-${INDEPENDENT_ASR_MODELS[0]}.json`, label: 'asr-first' },
  { file: `reports/asr-${INDEPENDENT_ASR_MODELS[1]}.json`, label: 'asr-second' },
  { file: 'reports/validate.json', label: 'validate' },
];

export async function loadListeningEvidence(file) {
  const payload = await readJsonIfPresent(file);
  if (!payload) {
    throw Object.assign(new Error(`human listening file is missing or invalid: ${file}`), { exitCode: EXIT_HARD });
  }
  return payload;
}

export function listeningMatchesFingerprint(review, fullSha256, candidateFingerprint) {
  const evidence = review?.evidence || {};
  return review?.status === 'passed'
    && Boolean(review.reviewedBy)
    && Boolean(review.reviewedAt)
    && evidence.sha256 === fullSha256
    && evidence.candidateFingerprint === candidateFingerprint;
}

export async function loadBoundEvidence({
  dir,
  fingerprint,
  fullSha256,
  articleId,
  speechScriptHash,
  listening,
  record,
}) {
  const failures = [];
  const reports = {};
  if (!fingerprint || !fullSha256 || !articleId) {
    failures.push('publish evidence requires articleId, candidateFingerprint and fullSha256');
  }
  const expected = { articleId, fingerprint, fullSha256, speechScriptHash };

  for (const item of ORIGINAL_REPORTS) {
    const absolute = path.join(dir, item.file);
    if (!await pathExists(absolute)) {
      failures.push(`missing ${item.file}`);
      continue;
    }
    const payload = await readJsonIfPresent(absolute);
    if (!payload) {
      failures.push(`${item.file} is not valid JSON`);
      continue;
    }
    reports[item.label] = payload;
    failures.push(...missingBoundFields(payload).map((reason) => `${item.label}: ${reason}`));
    failures.push(...assertBoundReport(payload, expected, item.label));
  }

  const asrFirst = reports['asr-first'];
  const asrSecond = reports['asr-second'];
  const asrReports = [asrFirst, asrSecond].filter(Boolean);
  if (asrReports.length < 2) failures.push('original dual ASR reports missing');
  const models = asrReports.map((item) => item.requestedModel || item.model);
  if (models[0] !== INDEPENDENT_ASR_MODELS[0]) failures.push(`first ASR model must be ${INDEPENDENT_ASR_MODELS[0]}`);
  if (models[1] !== INDEPENDENT_ASR_MODELS[1]) failures.push(`second ASR model must be ${INDEPENDENT_ASR_MODELS[1]}`);
  if (models[0] && models[0] === models[1]) failures.push('the same ASR model was used twice');
  for (const model of models) {
    if (FORBIDDEN_ASR_MODELS.includes(model)) failures.push(`forbidden ASR model ${model}`);
  }
  for (const report of asrReports) {
    if (!(report.substitutions === 0 && report.deletions === 0 && report.insertions === 0)) {
      failures.push(`ASR ${report.requestedModel || report.model} is not 0/0/0`);
    }
    if (report.status !== 'passed') failures.push(`ASR ${report.requestedModel || report.model} status is not passed`);
  }

  const validate = reports.validate;
  if (validate && validate.status !== 'validated' && validate.passed !== true) failures.push('validate report is not passed');
  if (!validate?.reportDigests) {
    failures.push('validate report missing reportDigests');
  } else {
    for (const item of ORIGINAL_REPORTS) {
      if (item.label === 'validate') continue;
      const absolute = path.join(dir, item.file);
      if (!await pathExists(absolute)) continue;
      const actual = sha256(await readFile(absolute));
      if (validate.reportDigests[item.file] !== actual) {
        failures.push(`${item.file} SHA-256 does not match validate.reportDigests`);
      }
    }
  }
  if (reports.sync && reports.sync.passed === false) failures.push('sync report is not passed');
  if (reports['technical-qa'] && reports['technical-qa'].passed === false) failures.push('technical QA report is not passed');

  const human = listening || record?.humanListening;
  if (!human) failures.push('human listening evidence is missing');
  else if (!listeningMatchesFingerprint(human, fullSha256, fingerprint)) {
    failures.push('human listening is missing candidateFingerprint or is not bound to this file');
  }
  if (human) {
    reports.listening = human;
    if (!human.evidence?.candidateFingerprint) failures.push('listening evidence missing candidateFingerprint');
    if (!human.evidence?.sha256) failures.push('listening evidence missing sha256');
  }

  const player = reports['player-manifest'];
  const fullFile = path.join(dir, 'full.mp3');
  if (await pathExists(fullFile)) {
    const actual = sha256(await readFile(fullFile));
    if (actual !== fullSha256) failures.push('full.mp3 SHA-256 does not match bound digest');
  } else {
    failures.push('full.mp3 is missing');
  }
  if (player?.parts) {
    for (const part of player.parts) {
      const asset = part.audio?.[player.defaultVoice];
      if (!asset?.src || !asset.sha256) {
        failures.push('player manifest part is missing src/sha256');
        continue;
      }
      const filename = path.basename(asset.src);
      const partFile = path.join(dir, 'parts', filename);
      if (!await pathExists(partFile)) {
        failures.push(`missing part file ${filename}`);
        continue;
      }
      const bytes = await readFile(partFile);
      if (sha256(bytes) !== asset.sha256) failures.push(`part ${filename} SHA-256 does not match manifest`);
      if (asset.bytes && asset.bytes !== bytes.length) failures.push(`part ${filename} byte length does not match manifest`);
      if (asset.durationSeconds) {
        const duration = mp3DurationSeconds(bytes);
        if (Math.abs(duration - Number(asset.durationSeconds)) > 0.35) {
          failures.push(`part ${filename} duration does not match manifest`);
        }
      }
    }
  }

  if (record) reports.publishRecord = record;

  if (failures.length) {
    throw Object.assign(new Error(`publish-approved refused bound evidence:\n${failures.map((item) => `- ${item}`).join('\n')}`), {
      exitCode: EXIT_HARD,
      failures,
      reports,
    });
  }
  return reports;
}
