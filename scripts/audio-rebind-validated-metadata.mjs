import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { candidateDir, sha256 } from './audio-constants.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function exactConsensusZero(consensus = {}) {
  return ['substitutions', 'deletions', 'insertions', 'unresolved'].every((key) => Number(consensus[key]) === 0);
}

function assertBoundReport(report, { articleId, fingerprint, fullSha256, name }) {
  if (!report || report.fingerprint !== fingerprint || report.candidateFingerprint !== fingerprint) {
    throw new Error(`${articleId}: ${name} fingerprint mismatch`);
  }
  if (report.fullSha256 !== fullSha256) {
    throw new Error(`${articleId}: ${name} fullSha256 mismatch`);
  }
  if (report.passed !== true && report.status !== 'validated') {
    throw new Error(`${articleId}: ${name} is not passed`);
  }
}

const state = await readJson(STATE_PATH);
let repaired = 0;

for (const [articleId, item] of Object.entries(state.articles || {})) {
  const fingerprint = item.generation?.fingerprint;
  const validation = item.validation || {};
  if (!fingerprint
    || validation.status !== 'validated'
    || validation.fingerprint !== fingerprint
    || !validation.fullSha256
    || !exactConsensusZero(validation.consensus)) {
    continue;
  }

  const dir = candidateDir(articleId, fingerprint, ROOT);
  const files = {
    full: path.join(dir, 'full.mp3'),
    generation: path.join(dir, 'generation-report.json'),
    candidateManifest: path.join(dir, 'manifest.candidate.json'),
    validate: path.join(dir, 'reports', 'validate.json'),
    technical: path.join(dir, 'reports', 'technical-qa.json'),
    sync: path.join(dir, 'reports', 'sync.json'),
    asr: path.join(dir, 'reports', 'asr-adjudication.json'),
  };
  for (const [name, file] of Object.entries(files)) {
    if (!await pathExists(file)) throw new Error(`${articleId}: missing ${name}`);
  }

  const fullSha256 = sha256(await readFile(files.full));
  if (fullSha256 !== validation.fullSha256) {
    throw new Error(`${articleId}: campaign validation does not bind the current full.mp3`);
  }

  const [validate, technical, sync, asr, generation, candidateManifest] = await Promise.all([
    readJson(files.validate),
    readJson(files.technical),
    readJson(files.sync),
    readJson(files.asr),
    readJson(files.generation),
    readJson(files.candidateManifest),
  ]);
  assertBoundReport(validate, { articleId, fingerprint, fullSha256, name: 'validate.json' });
  assertBoundReport(technical, { articleId, fingerprint, fullSha256, name: 'technical-qa.json' });
  assertBoundReport(sync, { articleId, fingerprint, fullSha256, name: 'sync.json' });
  assertBoundReport(asr, { articleId, fingerprint, fullSha256, name: 'asr-adjudication.json' });
  if (!exactConsensusZero(asr.consensus)) throw new Error(`${articleId}: ASR consensus is not exact`);

  for (const [name, report] of [['generation-report.json', generation], ['manifest.candidate.json', candidateManifest]]) {
    if (report.fingerprint !== fingerprint || report.candidateFingerprint !== fingerprint) {
      throw new Error(`${articleId}: ${name} fingerprint mismatch`);
    }
    report.fullSha256 = fullSha256;
    report.status = 'generated';
  }
  await writeJson(files.generation, generation);
  await writeJson(files.candidateManifest, candidateManifest);

  validate.reportDigests = {
    ...(validate.reportDigests || {}),
    'generation-report.json': sha256(await readFile(files.generation)),
    'manifest.candidate.json': sha256(await readFile(files.candidateManifest)),
  };
  await writeJson(files.validate, validate);
  repaired += 1;
  console.log(`VALIDATED_METADATA_REBOUND ${articleId} ${fullSha256}`);
}

if (repaired === 0) throw new Error('No exact validated candidate metadata was eligible for repair.');
console.log(`VALIDATED_METADATA_REBIND=PASS articles=${repaired}`);
