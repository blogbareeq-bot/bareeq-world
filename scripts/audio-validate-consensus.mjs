import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_HARD,
  EXIT_OK,
  EXIT_QUOTA,
  EXIT_USAGE,
  INDEPENDENT_ASR_MODELS,
  candidateDir,
  sha256,
} from './audio-constants.mjs';
import { validateCandidate } from './audio-validate.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { uploadAudioFile, transcribeFullAudio } from './audio-asr-transcribe.mjs';
import { deleteUploadedFile, emptyHttp } from './audio-files-api.mjs';
import { adjudicateCandidate } from './audio-dual-asr-adjudicate.mjs';
import { writeJson } from './audio-checkpoint.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSIENT_HTTP = new Set([500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5000, 15000];

export function isTransientAsrFailure(error) {
  const status = Number(error?.httpStatus || error?.result?.httpStatus || 0);
  return TRANSIENT_HTTP.has(status);
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

    for (const model of INDEPENDENT_ASR_MODELS) {
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
          terminalError = null;
          break;
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
            terminalError = null;
            break;
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
      if (!usableRawReport(finalReport)) {
        await writeJson(path.join(reportsDir, 'asr-retry-log.json'), {
          schema: 'bareeq.audio-asr-retry.v1',
          status: 'failed',
          fingerprint,
          candidateFingerprint: fingerprint,
          fullSha256,
          attempts: retryLog,
          generatedAt: new Date().toISOString(),
        });
        if (terminalError?.exitCode === EXIT_QUOTA || terminalError?.httpStatus === 429) throw terminalError;
        throw Object.assign(new Error(`independent ASR ${model} unavailable after bounded transient retries`), {
          exitCode: EXIT_HARD,
          cause: terminalError,
        });
      }
      finalReports.push(finalReport);
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

  await writeJson(path.join(reportsDir, 'asr-retry-log.json'), {
    schema: 'bareeq.audio-asr-retry.v1',
    status: 'completed',
    fingerprint,
    candidateFingerprint: fingerprint,
    fullSha256,
    attempts: retryLog,
    generatedAt: new Date().toISOString(),
  });
  if (!deletion?.deleted) {
    throw Object.assign(new Error('Files API cleanup failed; validation evidence is not closed'), { exitCode: EXIT_HARD });
  }

  const adjudication = await adjudicateCandidate({ articleId, fingerprint, root, storeRoot });
  return {
    status: 'validated',
    articleId,
    fingerprint,
    fullSha256,
    consensus: adjudication.consensus,
    representationOnly: adjudication.representationOnly.length,
    modelDisagreements: adjudication.modelDisagreements.length,
    retryAttempts: retryLog,
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
