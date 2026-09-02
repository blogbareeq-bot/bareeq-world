import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_HARD,
  EXIT_OK,
  INDEPENDENT_ASR_MODELS,
  QUOTA_SPLIT,
  candidateDir,
  sha256,
} from './audio-constants.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { validateCandidate } from './audio-validate.mjs';
import { adjudicateCandidate } from './audio-dual-asr-adjudicate.mjs';
import { activeSplitSettings, loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';
import {
  OPENROUTER_RECOVERY_ASR_MODEL,
  transcribeOpenRouterParts,
} from './audio-openrouter-asr.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const ARTICLE_ID = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length)
  || 'ai-as-coworker-future-of-human-work';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const FIRST_MODEL = INDEPENDENT_ASR_MODELS[0];
const RECOVERY_MODELS = Object.freeze([FIRST_MODEL, OPENROUTER_RECOVERY_ASR_MODEL]);

function exactZero(value = {}) {
  return Number(value.substitutions) === 0
    && Number(value.deletions) === 0
    && Number(value.insertions) === 0;
}

function consensusZero(value = {}) {
  return exactZero(value) && Number(value.unresolved) === 0;
}

async function main() {
  if (!await pathExists(STATE_PATH)) throw Object.assign(new Error('campaign checkpoint state is missing'), { exitCode: EXIT_HARD });
  const state = JSON.parse(await readFile(STATE_PATH, 'utf8'));
  const entry = state.articles?.[ARTICLE_ID];
  const fingerprint = entry?.generation?.fingerprint;
  if (entry?.generation?.status !== 'generated' || !fingerprint) {
    throw Object.assign(new Error(`${ARTICLE_ID} is not generation-complete in the checkpoint`), { exitCode: EXIT_HARD });
  }

  const deterministic = await validateCandidate({
    articleId: ARTICLE_ID,
    fingerprint,
    root: ROOT,
    skipAsr: true,
  });
  if (!deterministic.technical?.passed || !deterministic.sync?.passed || deterministic.liveUntouched !== true) {
    throw Object.assign(new Error('deterministic technical/sync gates failed before recovery ASR'), { exitCode: EXIT_HARD });
  }

  const article = await loadSpokenArticle(ARTICLE_ID, ROOT);
  const dir = candidateDir(ARTICLE_ID, fingerprint, ROOT);
  const reportsDir = path.join(dir, 'reports');
  const fullPath = path.join(dir, 'full.mp3');
  const fullSha256 = sha256(await readFile(fullPath));
  const firstPath = path.join(reportsDir, `asr-${FIRST_MODEL}.json`);
  if (!await pathExists(firstPath)) {
    throw Object.assign(new Error(`checkpoint is missing the successful first ASR report ${FIRST_MODEL}`), { exitCode: EXIT_HARD });
  }
  const first = JSON.parse(await readFile(firstPath, 'utf8'));
  if ((first.requestedModel || first.model) !== FIRST_MODEL
    || first.httpStatus !== 200
    || first.candidateFingerprint !== fingerprint
    || first.fullSha256 !== fullSha256
    || first.status !== 'passed'
    || !exactZero(first)
    || typeof first.transcript !== 'string'
    || !Array.isArray(first.differences)) {
    throw Object.assign(new Error('cached first ASR report is not exact 0/0/0 or is not bound to the corrected candidate'), { exitCode: EXIT_HARD });
  }

  const generation = JSON.parse(await readFile(path.join(dir, 'generation-report.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.candidate.json'), 'utf8'));
  const splitPlan = splitSpokenArticle(article, {
    settings: activeSplitSettings(QUOTA_SPLIT),
    liveDurationSeconds: generation.liveDurationSeconds ?? null,
  });
  if (!Array.isArray(manifest.parts) || manifest.parts.length !== splitPlan.parts.length) {
    throw Object.assign(new Error('candidate part manifest does not match the bound Speech Script split'), { exitCode: EXIT_HARD });
  }
  const parts = manifest.parts.map((part, index) => {
    if (part.partIndex !== splitPlan.parts[index].partIndex || !part.file) {
      throw Object.assign(new Error(`candidate part ${index + 1} is not bound to the split plan`), { exitCode: EXIT_HARD });
    }
    return {
      partIndex: part.partIndex,
      audioPath: path.join(dir, 'parts', path.basename(part.file)),
      expectedText: splitPlan.parts[index].text,
    };
  });

  const secondPath = path.join(reportsDir, `asr-${OPENROUTER_RECOVERY_ASR_MODEL}.json`);
  let second;
  try {
    second = await transcribeOpenRouterParts({
      model: OPENROUTER_RECOVERY_ASR_MODEL,
      audioPath: fullPath,
      parts,
      expectedText: article.spokenText,
      article,
      fingerprint,
      fullSha256,
      outputPath: secondPath,
    });
  } catch (error) {
    if (error?.httpStatus === 200 && error?.result?.transcript && Array.isArray(error.result.differences)) {
      second = error.result;
      console.log(`OPENROUTER_RAW_ASR_DISAGREEMENTS S=${second.substitutions} D=${second.deletions} I=${second.insertions}`);
    } else {
      throw error;
    }
  }

  const adjudication = await adjudicateCandidate({
    articleId: ARTICLE_ID,
    fingerprint,
    root: ROOT,
    models: RECOVERY_MODELS,
  });
  if (!adjudication.passed || !consensusZero(adjudication.consensus)) {
    throw Object.assign(new Error('recovery dual-ASR did not reach exact consensus 0/0/0/0'), { exitCode: EXIT_HARD });
  }

  state.articles[ARTICLE_ID] = {
    ...entry,
    validation: {
      status: 'validated',
      fingerprint,
      fullSha256,
      consensus: adjudication.consensus,
      representationOnly: adjudication.representationOnly.length,
      modelDisagreements: adjudication.modelDisagreements.length,
      models: RECOVERY_MODELS,
      completedAt: new Date().toISOString(),
    },
  };
  const entries = Object.entries(state.articles || {});
  state.validationComplete = entries.length === 15 && entries.every(([, item]) => (
    item.generation?.status === 'generated'
    && item.validation?.status === 'validated'
    && item.validation?.fingerprint === item.generation?.fingerprint
    && consensusZero(item.validation?.consensus)
  ));
  state.updatedAt = new Date().toISOString();
  await writeJson(STATE_PATH, state);
  if (!state.validationComplete) {
    throw Object.assign(new Error('campaign checkpoint did not close at validated 15/15'), { exitCode: EXIT_HARD });
  }

  console.log(`RECOVERY_DUAL_ASR=PASS article=${ARTICLE_ID} models=${RECOVERY_MODELS.join(',')} consensus=0/0/0/0`);
  console.log('CAMPAIGN_VALIDATION=PASS articles=15');
  return { second, adjudication };
}

try {
  await main();
  process.exit(EXIT_OK);
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode || EXIT_HARD);
}
