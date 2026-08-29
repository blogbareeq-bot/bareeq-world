import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  extractArticleSpeechModel,
  readAmbiguityRules,
  readSpeechScript,
  readTestClipPlan,
  validateSpeechScript,
} from './speech-script-core.mjs';
import { EXIT_HARD, EXIT_USAGE } from './audio-constants.mjs';
import { pathExists } from './audio-checkpoint.mjs';
import { loadListeningEvidence } from './audio-evidence.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';

export async function loadPublicationPost(articleId, root = process.cwd()) {
  const filename = `${articleId}.md`;
  const sourcePath = path.join(root, 'src', 'content', 'posts', filename);
  if (!await pathExists(sourcePath)) {
    throw Object.assign(new Error(`publish-approved refused: article markdown missing at ${sourcePath}`), { exitCode: EXIT_USAGE });
  }
  const source = await readFile(sourcePath, 'utf8');
  const model = extractArticleSpeechModel({ articleId, source, filename });
  let rules = [];
  try {
    rules = await readAmbiguityRules(root);
  } catch {
    try {
      rules = await readAmbiguityRules(process.cwd());
    } catch {
      rules = [];
    }
  }
  const script = await readSpeechScript(articleId, root);
  const plan = await readTestClipPlan(articleId, root);
  const validation = validateSpeechScript(model, script, rules, { requireReviews: false });
  return {
    id: articleId,
    speechApproval: {
      validation,
      script,
      testClipPlan: plan,
    },
  };
}

export async function loadPublishRecord({
  candidateDir,
  listeningPath,
  recordPath,
  fingerprint,
  fullSha256,
  article,
}) {
  let record = {};
  if (recordPath) {
    if (!await pathExists(recordPath)) {
      throw Object.assign(new Error(`publish record missing: ${recordPath}`), { exitCode: EXIT_HARD });
    }
    record = JSON.parse(await readFile(recordPath, 'utf8'));
  } else {
    const fallback = path.join(candidateDir, 'reports', 'publish-record.json');
    if (await pathExists(fallback)) {
      record = JSON.parse(await readFile(fallback, 'utf8'));
    }
  }
  if (listeningPath) {
    record.humanListening = await loadListeningEvidence(listeningPath);
  }
  const validate = await pathExists(path.join(candidateDir, 'reports', 'validate.json'))
    ? JSON.parse(await readFile(path.join(candidateDir, 'reports', 'validate.json'), 'utf8'))
    : null;
  const asrReports = [];
  for (const model of ['gemini-3.5-transcribe', 'gemini-3.6-flash']) {
    const file = path.join(candidateDir, 'reports', `asr-${model}.json`);
    if (await pathExists(file)) asrReports.push(JSON.parse(await readFile(file, 'utf8')));
  }
  const technical = await pathExists(path.join(candidateDir, 'reports', 'technical-qa.json'))
    ? JSON.parse(await readFile(path.join(candidateDir, 'reports', 'technical-qa.json'), 'utf8'))
    : null;
  const sync = await pathExists(path.join(candidateDir, 'reports', 'sync.json'))
    ? JSON.parse(await readFile(path.join(candidateDir, 'reports', 'sync.json'), 'utf8'))
    : null;
  return {
    generated: true,
    provider: PRODUCTION_NARRATOR.provider,
    model: PRODUCTION_NARRATOR.model,
    voiceId: PRODUCTION_NARRATOR.voiceId,
    asrReports: asrReports.length ? asrReports : (validate?.asrReports || []),
    humanListening: record.humanListening || null,
    technicalStatus: technical?.passed ? 'passed' : record.technicalStatus,
    syncStatus: sync?.passed ? 'passed' : record.syncStatus,
    speechScriptHash: article?.speechScriptHash,
    fingerprint,
    candidateFingerprint: fingerprint,
    fullSha256,
    ...record,
    humanListening: record.humanListening || null,
  };
}
