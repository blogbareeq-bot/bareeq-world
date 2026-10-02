import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ASR_MODEL_TRANSPORT,
  EXIT_HARD,
  EXIT_OK,
  EXIT_QUOTA,
  EXIT_USAGE,
  FORBIDDEN_ASR_MODELS,
  INDEPENDENT_ASR_MODELS,
  candidateDir,
  sha256,
} from './audio-constants.mjs';
import { validateCandidate } from './audio-validate.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { uploadAudioFile, transcribeFullAudio } from './audio-asr-transcribe.mjs';
import { deleteUploadedFile, emptyHttp } from './audio-files-api.mjs';
import { adjudicateCandidate } from './audio-dual-asr-adjudicate.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSIENT_HTTP = new Set([500, 502, 503, 504]);
const FALLBACK_HTTP = new Set([404, 429, 500, 502, 503, 504]);
// These remain diagnostics/resume transports until a primary ASR model is
// genuinely unavailable. They are still independent model identifiers and
// must pass the same exact 0/0/0/0 dual-model adjudication gate.
export const ASR_FALLBACK_MODELS = Object.freeze([
  'gemini-3.5-flash',
  'gemini-3.6-flash',
]);
// Gemini transcription can return temporary 500 high-demand responses. Keep
// retries bounded, but span several minutes so a healthy campaign is not
// discarded during a short provider spike.
const RETRY_DELAYS_MS = [15000, 45000, 90000, 180000];

export function isTransientAsrFailure(error) {
  const status = Number(error?.httpStatus || error?.result?.httpStatus || 0);
  return TRANSIENT_HTTP.has(status);
}

export function isFallbackEligibleAsrFailure(error) {
  const status = Number(error?.httpStatus || error?.result?.httpStatus || 0);
  return FALLBACK_HTTP.has(status) || error?.exitCode === EXIT_QUOTA;
}

function supportedIndependentModel(model) {
  return Boolean(model
    && ASR_MODEL_TRANSPORT[model]
    && !FORBIDDEN_ASR_MODELS.includes(model));
}

export function asrModelCandidates(primaryModel, alreadySelected = []) {
  const selected = new Set(alreadySelected);
  return [primaryModel, ...ASR_FALLBACK_MODELS]
    .filter((model, index, values) => values.indexOf(model) === index)
    .filter((model) => supportedIndependentModel(model) && !selected.has(model));
}

function storedAdjudicationModels(value) {
  const models = Array.isArray(value?.models) ? value.models.filter(supportedIndependentModel) : [];
  if (models.length !== 2 || new Set(models).size !== 2) return null;
  return models;
}

function usableRawReport(report) {
  return report?.httpStatus === 200
    && typeof report?.transcript === 'string'
    && report.transcript.trim().length > 0
    && Array.isArray(report?.differences)
    && Number.isFinite(Number(report?.substitutions))
    && Number.isFinite(Number(report?.deletions))
    && Number.isFinite(Number(report?.insertions));
}

async function offlineReuseModels({ articleId, fingerprint, root, storeRoot }) {
  const dir = candidateDir(articleId, fingerprint, storeRoot || root);
  const adjudicationPath = path.join(dir, 'reports', 'asr-adjudication.json');
  if (!await pathExists(adjudicationPath)) return INDEPENDENT_ASR_MODELS;
  try {
    const stored = JSON.parse(await readFile(adjudicationPath, 'utf8'));
    return storedAdjudicationModels(stored) || INDEPENDENT_ASR_MODELS;
  } catch {
    return INDEPENDENT_ASR_MODELS;
  }
}

async function transcribeWithBoundedRetries({
  model,
  article,
  audioPath,
  apiKey,
  fetchImpl,
  reportsDir,
  fingerprint,
  fullSha256,
  uploaded,
  retryDelaysMs,
  retryLog,
}) {
  let finalReport = null;
  let terminalError = null;
  const maxAttempts = retryDelaysMs.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      finalReport = await transcribeFullAudio({
        model,
        audioPath,
        expectedText: article.spokenText,
        apiKey,
        fetchImpl,
        outputPath: path.join(reportsDir, `asr-${model}.json`),
        fingerprint,
        fullSha256,
        file: uploaded,
        skipUpload: true,
        article,
        speechScriptHash: article.speechScriptHash,
      });
      retryLog.push({ model, attempt, outcome: 'http-200', exactMatch: finalReport.status === 'passed' });
      return { report: finalReport, error: null };
    } catch (error) {
      const report = error.result || null;
      if (usableRawReport(report)) {
        // Exact mismatch is evidence for consensus, not a transport failure.
        finalReport = report;
        retryLog.push({
          model,
          attempt,
          outcome: 'http-200-exact-mismatch',
          substitutions: report.substitutions,
          deletions: report.deletions,
          insertions: report.insertions,
        });
        return { report: finalReport, error: null };
      }
      const status = Number(error?.httpStatus || report?.httpStatus || 0);
      const transient = isTransientAsrFailure(error);
      retryLog.push({
        model,
        attempt,
        outcome: transient ? 'transient-error' : 'terminal-error',
        httpStatus: status || null,
        message: String(error.message || '').slice(0, 300),
      });
      if (transient && attempt < maxAttempts) {
        await sleep(retryDelaysMs[attempt - 1]);
        continue;
      }
      terminalError = error;
      finalReport = report;
      break;
    }
  }
  return { report: finalReport, error: terminalError };
}

export async function validateWithConsensus({
  articleId,
  fingerprint,
  root = process.cwd(),
  storeRoot,
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = globalThis.fetch,
  retryDelaysMs = RETRY_DELAYS_MS,
}) {
  if (!articleId || !fingerprint) {
    throw Object.assign(new Error('validate-consensus requires --article and --fingerprint'), { exitCode: EXIT_USAGE });
  }

  // Re-adjudicate already-bound raw reports before any network/provider call.
  // If a previous quota fallback produced the bound evidence, reuse that exact
  // recorded model pair instead of forcing the default pair and spending ASR.
  try {
    const models = await offlineReuseModels({ articleId, fingerprint, root, storeRoot });
    const stored = await adjudicateCandidate({ articleId, fingerprint, root, storeRoot, models });
    console.log(`ASR_OFFLINE_REUSE_PASS article=${articleId} fingerprint=${fingerprint} models=${models.join(',')}`);
    return {
      status: 'validated',
      articleId,
      fingerprint,
      fullSha256: stored.fullSha256,
      consensus: stored.consensus,
      representationOnly: stored.representationOnly.length,
      modelDisagreements: stored.modelDisagreements.length,
      models,
      retryAttempts: [],
      reusedRawAsr: true,
      exitCode: EXIT_OK,
    };
  } catch (error) {
    if (error?.result?.consensus) {
      console.log(`ASR_OFFLINE_REUSE_MISMATCH article=${articleId} fingerprint=${fingerprint} consensus=${JSON.stringify(error.result.consensus)}`);
      throw error;
    }
    console.log(`ASR_OFFLINE_REUSE_UNAVAILABLE article=${articleId} fingerprint=${fingerprint} reason=${JSON.stringify(String(error?.message || error).slice(0, 240))}`);
  }

  if (!apiKey?.trim()) {
    throw Object.assign(new Error('GEMINI_API_KEY is absent. Consensus validation did not start ASR.'), { exitCode: 78 });
  }

  // First close all deterministic gates and create the exact merged file without ASR.
  const deterministic = await validateCandidate({
    articleId,
    fingerprint,
    root,
    storeRoot,
    apiKey,
    fetchImpl,
    skipAsr: true,
  });
  if (!deterministic.technical?.passed || !deterministic.sync?.passed || deterministic.liveUntouched !== true) {
    throw Object.assign(new Error('deterministic candidate gates did not pass before ASR'), { exitCode: EXIT_HARD });
  }

  const article = await loadSpokenArticle(articleId, root);
  const dir = candidateDir(articleId, fingerprint, storeRoot || root);
  const reportsDir = path.join(dir, 'reports');
  const audioPath = path.join(dir, 'full.mp3');
  const bytes = await readFile(audioPath);
  const fullSha256 = sha256(bytes);
  await mkdir(reportsDir, { recursive: true });

  let uploaded = null;
  const retryLog = [];
  const finalReports = [];
  const selectedModels = [];
  let deletion = null;
  try {
    uploaded = await uploadAudioFile({ apiKey, bytes, displayName: `bareeq-${articleId}-${fingerprint.slice(0, 12)}.mp3`, fetchImpl });
    await writeJson(path.join(reportsDir, 'files-api.json'), {
      schema: 'bareeq.audio-files-api.v1',
      status: 'uploaded',
      uri: uploaded.uri,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
      name: uploaded.name,
      http: uploaded.http,
      fingerprint,
      candidateFingerprint: fingerprint,
      fullSha256,
      generatedAt: new Date().toISOString(),
    });

    for (const primaryModel of INDEPENDENT_ASR_MODELS) {
      let acceptedReport = null;
      let lastError = null;
      const candidates = asrModelCandidates(primaryModel, selectedModels);
      for (const model of candidates) {
        const { report, error } = await transcribeWithBoundedRetries({
          model,
          article,
          audioPath,
          apiKey,
          fetchImpl,
          reportsDir,
          fingerprint,
          fullSha256,
          uploaded,
          retryDelaysMs,
          retryLog,
        });
        if (usableRawReport(report)) {
          acceptedReport = report;
          selectedModels.push(model);
          if (model !== primaryModel) {
            retryLog.push({
              model,
              primaryModel,
              outcome: 'quota-fallback-selected',
              selectedPair: [...selectedModels],
            });
            console.log(`ASR_MODEL_FALLBACK primary=${primaryModel} selected=${model} article=${articleId}`);
          }
          break;
        }
        lastError = error;
        if (!isFallbackEligibleAsrFailure(error)) break;
        retryLog.push({
          model,
          primaryModel,
          outcome: 'fallback-next-model',
          httpStatus: Number(error?.httpStatus || error?.result?.httpStatus || 0) || null,
          message: String(error?.message || '').slice(0, 300),
        });
      }

      if (!usableRawReport(acceptedReport)) {
        await writeJson(path.join(reportsDir, 'asr-retry-log.json'), {
          schema: 'bareeq.audio-asr-retry.v2',
          status: 'failed',
          fingerprint,
          candidateFingerprint: fingerprint,
          fullSha256,
          selectedModels,
          attempts: retryLog,
          generatedAt: new Date().toISOString(),
        });
        if (lastError?.exitCode === EXIT_QUOTA || lastError?.httpStatus === 429) throw lastError;
        throw Object.assign(new Error(`independent ASR ${primaryModel} and bounded fallback models unavailable`), {
          exitCode: EXIT_HARD,
          cause: lastError,
        });
      }
      finalReports.push(acceptedReport);
    }
  } finally {
    if (uploaded?.name) {
      deletion = await deleteUploadedFile({ apiKey, name: uploaded.name, fetchImpl }).catch((error) => ({
        deleted: false,
        error: error.message,
        http: emptyHttp(),
      }));
      await writeJson(path.join(reportsDir, 'files-api-delete.json'), {
        schema: 'bareeq.audio-files-api.v1',
        status: deletion.deleted ? 'deleted' : 'failed',
        name: uploaded.name,
        fingerprint,
        candidateFingerprint: fingerprint,
        fullSha256,
        deleteResult: deletion,
        generatedAt: new Date().toISOString(),
      });
      for (const report of finalReports) {
        report.filesApiDeleteRequests = deletion.http?.filesApiDeleteRequests || 1;
        report.deleteResult = deletion;
        await writeJson(path.join(reportsDir, `asr-${report.requestedModel || report.model}.json`), report);
      }
    }
  }

  if (selectedModels.length !== 2 || new Set(selectedModels).size !== 2) {
    throw Object.assign(new Error(`dual-ASR requires two distinct successful models; selected=${selectedModels.join(',') || 'none'}`), { exitCode: EXIT_HARD });
  }
  await writeJson(path.join(reportsDir, 'asr-retry-log.json'), {
    schema: 'bareeq.audio-asr-retry.v2',
    status: 'completed',
    fingerprint,
    candidateFingerprint: fingerprint,
    fullSha256,
    selectedModels,
    attempts: retryLog,
    generatedAt: new Date().toISOString(),
  });
  if (!deletion?.deleted) {
    throw Object.assign(new Error('Files API cleanup failed; validation evidence is not closed'), { exitCode: EXIT_HARD });
  }

  const adjudication = await adjudicateCandidate({ articleId, fingerprint, root, storeRoot, models: selectedModels });
  return {
    status: 'validated',
    articleId,
    fingerprint,
    fullSha256,
    consensus: adjudication.consensus,
    representationOnly: adjudication.representationOnly.length,
    modelDisagreements: adjudication.modelDisagreements.length,
    models: selectedModels,
    retryAttempts: retryLog,
    reusedRawAsr: false,
    exitCode: EXIT_OK,
  };
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-validate-consensus.mjs';
if (isCli) {
  const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length);
  const fingerprint = process.argv.find((arg) => arg.startsWith('--fingerprint='))?.slice('--fingerprint='.length);
  try {
    const result = await validateWithConsensus({ articleId, fingerprint });
    console.log(JSON.stringify(result, null, 2));
    process.exit(EXIT_OK);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode || EXIT_HARD);
  }
}
