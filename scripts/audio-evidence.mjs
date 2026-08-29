import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_HARD } from './audio-constants.mjs';
import { pathExists } from './audio-checkpoint.mjs';

const REQUIRED_REPORTS = [
  { file: 'generation-report.json', keys: { fingerprint: 'fingerprint' } },
  { file: 'reports/merge.json', keys: { fingerprint: 'fingerprint', fullSha256: 'sha256' } },
  { file: 'reports/sync.json', keys: { fingerprint: 'fingerprint', fullSha256: 'fullSha256' } },
  { file: 'reports/technical-qa.json', keys: { fingerprint: 'fingerprint', fullSha256: 'fullSha256' } },
  { file: 'reports/validate.json', keys: { fingerprint: 'fingerprint', fullSha256: 'fullSha256' } },
];

export async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function loadBoundEvidence({ dir, fingerprint, fullSha256 }) {
  const failures = [];
  const reports = {};
  if (!fingerprint || !fullSha256) {
    failures.push('publish evidence requires candidateFingerprint and fullSha256');
  }
  for (const item of REQUIRED_REPORTS) {
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
    reports[item.file] = payload;
    if (item.keys.fingerprint && payload[item.keys.fingerprint] && payload[item.keys.fingerprint] !== fingerprint) {
      failures.push(`${item.file} fingerprint mismatch`);
    }
    if (item.keys.fullSha256 && payload[item.keys.fullSha256] && payload[item.keys.fullSha256] !== fullSha256) {
      failures.push(`${item.file} fullSha256 mismatch`);
    }
  }

  const validate = reports['reports/validate.json'];
  if (validate) {
    if (validate.status !== 'validated' && validate.passed !== true) failures.push('validate report is not passed');
    if (validate.sync && validate.sync.passed === false) failures.push('sync report is not passed');
    if (validate.technical && validate.technical.passed === false) failures.push('technical QA report is not passed');
    const asrReports = Array.isArray(validate.asrReports) ? validate.asrReports : [];
    if (asrReports.length < 2) failures.push('dual ASR reports missing from validate.json');
    for (const report of asrReports) {
      if (report.fingerprint && report.fingerprint !== fingerprint) failures.push(`ASR ${report.model} fingerprint mismatch`);
      if (report.fullSha256 && report.fullSha256 !== fullSha256) failures.push(`ASR ${report.model} fullSha256 mismatch`);
      if (!(report.substitutions === 0 && report.deletions === 0 && report.insertions === 0)) {
        failures.push(`ASR ${report.model} is not 0/0/0`);
      }
    }
  }

  if (failures.length) {
    throw Object.assign(new Error(`publish-approved refused bound evidence:\n${failures.map((item) => `- ${item}`).join('\n')}`), {
      exitCode: EXIT_HARD,
      failures,
      reports,
    });
  }
  return reports;
}
