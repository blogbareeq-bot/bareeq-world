import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_HARD,
  EXIT_OK,
  QUOTA_SPLIT,
  candidateDir,
  sha256,
} from './audio-constants.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { validateCandidate } from './audio-validate.mjs';
import { adjudicateCandidate } from './audio-dual-asr-adjudicate.mjs';
import { activeSplitSettings, loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';
import {
  OPENROUTER_DUAL_ASR_MODELS,
  transcribeOpenRouterParts,
} from './audio-openrouter-asr.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const ARTICLE_ID = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length)
  || 'ai-as-coworker-future-of-human-work';
const REUSE_EXISTING_REPORTS = process.argv.includes('--reuse-existing-reports');
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const RECOVERY_MODELS = OPENROUTER_DUAL_ASR_MODELS;

function consensusZero(value = {}) {
  return Number(value.substitutions) === 0
    && Number(value.deletions) === 0
    && Number(value.insertions) === 0
    && Number(value.unresolved) === 0;
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

  for (const model of RECOVERY_MODELS) {
    const outputPath = path.join(reportsDir, `asr-${model}.json`);
    let report;
    if (REUSE_EXISTING_REPORTS) {
      if (!await pathExists(outputPath)) {
        throw Object.assign(new Error(`cannot reuse missing raw ASR report ${model}`), { exitCode: EXIT_HARD });
      }
      report = JSON.parse(await readFile(outputPath, 'utf8'));
    } else {
      try {
        report = await transcribeOpenRouterParts({
          model,
          audioPath: fullPath,
          parts,
          expectedText: article.spokenText,
          article,
          fingerprint,
          fullSha256,
          outputPath,
        });
      } catch (error) {
        if (error?.httpStatus === 200 && error?.result?.transcript && Array.isArray(error.result.differences)) {
          report = error.result;
        } else {
          throw error;
        }
      }
    }
    console.log(`OPENROUTER_ASR_EVIDENCE model=${model} source=${REUSE_EXISTING_REPORTS ? 'immutable-checkpoint' : 'provider'} raw=S${report.substitutions}/D${report.deletions}/I${report.insertions} requests=${report.transcriptionsRequests || parts.length} cost=${report.usageCost || 0}`);
  }

  let adjudication;
  try {
    adjudication = await adjudicateCandidate({
      articleId: ARTICLE_ID,
      fingerprint,
      root: ROOT,
      models: RECOVERY_MODELS,
    });
  } catch (error) {
    const a = error?.result;
    if (a?.consensus) {
      console.error(`OPENROUTER_DUAL_ASR_FAIL S=${a.consensus.substitutions} D=${a.consensus.deletions} I=${a.consensus.insertions} U=${a.consensus.unresolved}`);
      console.error(`OPENROUTER_DUAL_ASR_SUBSTANTIVE=${JSON.stringify(a.substantiveDifferences || [])}`);
      console.error(`OPENROUTER_DUAL_ASR_UNRESOLVED=${JSON.stringify(a.unresolved || [])}`);
    }
    throw error;
  }
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
      models: [...RECOVERY_MODELS],
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
    const pending = entries.filter(([, item]) => !(
      item.generation?.status === 'generated'
      && item.validation?.status === 'validated'
      && item.validation?.fingerprint === item.generation?.fingerprint
      && consensusZero(item.validation?.consensus)
    )).map(([id]) => id);
    throw Object.assign(new Error(`campaign checkpoint did not close at validated 15/15; pending=${pending.join(',')}`), { exitCode: EXIT_HARD });
  }

  console.log(`RECOVERY_DUAL_ASR=PASS article=${ARTICLE_ID} models=${RECOVERY_MODELS.join(',')} consensus=0/0/0/0`);
  console.log('CAMPAIGN_VALIDATION=PASS articles=15');
}

try {
  await main();
  process.exit(EXIT_OK);
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode || EXIT_HARD);
}
