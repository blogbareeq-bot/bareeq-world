import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareExactSpokenText, normalizeForVerbalComparison } from './audio-exact-match.mjs';
import {
  FORBIDDEN_ASR_MODELS,
  INDEPENDENT_ASR_MODELS,
  ASR_MODEL_TRANSPORT,
  EXIT_CONFIG,
  EXIT_HARD,
  EXIT_QUOTA,
  EXIT_USAGE,
  sha256,
  PRODUCTION_TTS_MODEL,
  PRODUCTION_VOICE,
  GENERATOR_VERSION,
} from './audio-constants.mjs';
import { deleteUploadedFile, uploadResumableFile, addHttp, emptyHttp } from './audio-files-api.mjs';
import { boundIdentity } from './audio-report.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';

export function geminiInteractionsUrl() {
  const override = process.env.GEMINI_INTERACTIONS_ENDPOINT?.trim() || process.env.GEMINI_TTS_ENDPOINT?.trim();
  if (override) {
    if (process.env.BAREEQ_TTS_CONTRACT_TEST !== '1') {
      throw Object.assign(new Error('Gemini endpoint overrides are restricted to BAREEQ_TTS_CONTRACT_TEST=1'), { exitCode: EXIT_HARD });
    }
    return override.replace(/\/$/, '');
  }
  return 'https://generativelanguage.googleapis.com/v1beta/interactions';
}

export const GEMINI_INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const GEMINI_FILES_UPLOAD = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_API_REVISION = '2026-05-20';

const VERBATIM_PROMPT = 'Transcribe this Arabic audio verbatim. Return only the spoken words. Do not add commentary, timestamps, speaker labels, or formatting beyond the words themselves.';

export function assertAsrModel(model) {
  if (FORBIDDEN_ASR_MODELS.includes(model)) {
    throw Object.assign(new Error(`${model} is not a valid independent ASR model id and must not be used.`), { exitCode: EXIT_USAGE });
  }
  const transport = ASR_MODEL_TRANSPORT[model];
  if (!transport) {
    throw Object.assign(new Error(`Unsupported ASR model ${model}. Production pair is ${INDEPENDENT_ASR_MODELS.join(', ')}.`), { exitCode: EXIT_USAGE });
  }
  return transport;
}

export function extractTranscript(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const stepText = Array.isArray(payload?.steps)
    ? payload.steps.flatMap((step) => Array.isArray(step?.content) ? step.content : [])
      .map((block) => block?.text || block?.output_text)
      .filter(Boolean)
      .join('\n')
    : '';
  if (stepText.trim()) return stepText.trim();
  const outputText = Array.isArray(payload?.outputs)
    ? payload.outputs.flatMap((output) => Array.isArray(output?.content) ? output.content : [output])
      .map((block) => block?.text)
      .filter(Boolean)
      .join('\n')
    : '';
  return outputText.trim();
}

export function extractResponseModel(payload) {
  return payload?.model || payload?.model_version || payload?.response_model || null;
}

export function extractResponseId(payload) {
  return payload?.id || payload?.response_id || payload?.responseId || null;
}

function headers(apiKey) {
  return {
    'x-goog-api-key': apiKey,
    'Api-Revision': GEMINI_API_REVISION,
    Accept: 'application/json',
  };
}

async function persistReport(outputPath, result) {
  if (!outputPath) return;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

function asrIdentity({ article, fingerprint, fullSha256, model, status, extra }) {
  return boundIdentity({
    article: article || { articleId: extra?.articleId, speechScriptHash: extra?.speechScriptHash },
    fingerprint,
    fullSha256,
    status,
    schema: 'bareeq.audio-asr.v4',
    model,
    extra: {
      provider: PRODUCTION_NARRATOR.provider,
      voice: PRODUCTION_VOICE,
      generatorVersion: GENERATOR_VERSION,
      ttsModel: PRODUCTION_TTS_MODEL,
      ...extra,
    },
  });
}

export async function uploadAudioFile({ apiKey, bytes, mimeType = 'audio/mpeg', displayName = 'bareeq-full.mp3', fetchImpl = fetch }) {
  try {
    return await uploadResumableFile({ apiKey, bytes, mimeType, displayName, fetchImpl });
  } catch (error) {
    if (error?.httpStatus === 429) {
      throw Object.assign(error, { exitCode: EXIT_QUOTA });
    }
    error.exitCode = error.exitCode || EXIT_HARD;
    throw error;
  }
}

export function buildInteractionBody(model, file) {
  const transport = assertAsrModel(model);
  if (transport.input === 'audio-uri') {
    return {
      model,
      input: [{ type: 'audio', uri: file.uri, mime_type: file.mimeType }],
      generation_config: {
        transcription_config: {
          language_codes: ['ar'],
          mode: { type: 'verbatim' },
        },
      },
    };
  }
  return {
    model,
    input: [
      { type: 'text', text: VERBATIM_PROMPT },
      { type: 'audio', uri: file.uri, mime_type: file.mimeType },
    ],
  };
}

export async function transcribeFullAudio({
  model,
  audioPath,
  expectedText,
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = fetch,
  outputPath,
  dryRun = false,
  fingerprint = null,
  fullSha256 = null,
  file = null,
  skipUpload = false,
  article = null,
  speechScriptHash = null,
}) {
  assertAsrModel(model);
  const startedAt = new Date().toISOString();
  const endpoint = geminiInteractionsUrl();
  const base = {
    schema: 'bareeq.audio-asr.v4',
    generatedAt: startedAt,
    startedAt,
    model,
    requestedModel: model,
    audio: audioPath || null,
    candidateFingerprint: fingerprint,
    fingerprint,
    fullSha256,
    speechScriptHash: speechScriptHash ?? article?.speechScriptHash ?? null,
    articleId: article?.articleId || null,
    transport: ASR_MODEL_TRANSPORT[model],
    independentModels: INDEPENDENT_ASR_MODELS,
    forbiddenModels: FORBIDDEN_ASR_MODELS,
    apiRevision: GEMINI_API_REVISION,
    endpoint,
    provider: PRODUCTION_NARRATOR.provider,
    voice: PRODUCTION_VOICE,
    generatorVersion: GENERATOR_VERSION,
    toolVersion: 9,
    filesApiUploads: 0,
    asrInteractions: 0,
    logicalUploads: 0,
    filesApiStartRequests: 0,
    filesApiFinalizeRequests: 0,
    filesApiMetadataRequests: 0,
    filesApiDeleteRequests: 0,
    interactionsRequests: 0,
    totalHttpRequests: 0,
  };
  if (dryRun) {
    const report = { ...base, status: 'not-run', note: 'Dry-run only. No audio bytes were uploaded and no transcription API was called.', endedAt: new Date().toISOString() };
    await persistReport(outputPath, report);
    return report;
  }
  if (!apiKey?.trim()) {
    throw Object.assign(new Error('GEMINI_API_KEY is absent. No transcription request was sent.'), { exitCode: EXIT_CONFIG });
  }
  if (!audioPath || expectedText == null) {
    throw Object.assign(new Error('--audio and --expected are required'), { exitCode: EXIT_USAGE });
  }

  const bytes = await readFile(audioPath);
  const digest = sha256(bytes);
  if (fullSha256 && digest !== fullSha256) {
    throw Object.assign(new Error('ASR audio SHA-256 does not match the candidate fingerprint full.mp3'), { exitCode: EXIT_HARD });
  }
  let http = emptyHttp();
  let uploaded = file || null;
  if (!uploaded && !skipUpload) {
    uploaded = await uploadAudioFile({ apiKey, bytes, fetchImpl });
    http = { ...http, ...uploaded.http };
  }
  if (!uploaded?.uri) {
    const failed = asrIdentity({
      article,
      fingerprint,
      fullSha256: digest,
      model,
      status: 'failed',
      extra: { ...base, fullSha256: digest, endedAt: new Date().toISOString(), error: 'ASR requires a Files API URI' },
    });
    await persistReport(outputPath, failed);
    throw Object.assign(new Error('ASR requires a Files API URI'), { exitCode: EXIT_HARD, result: failed });
  }

  let response;
  let body = '';
  try {
    http = addHttp(http, 'interactionsRequests');
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(buildInteractionBody(model, uploaded)),
    });
    body = await response.text();
  } catch (error) {
    const failed = {
      ...asrIdentity({
        article,
        fingerprint,
        fullSha256: digest,
        model,
        status: 'failed',
        extra: { ...base, fullSha256: digest, httpStatus: 0, endedAt: new Date().toISOString(), error: error.message, ...http },
      }),
    };
    await persistReport(outputPath, failed);
    throw Object.assign(error, { exitCode: EXIT_HARD, result: failed });
  }

  const fail = async (message, extra = {}) => {
    const failed = asrIdentity({
      article,
      fingerprint,
      fullSha256: digest,
      model,
      status: extra.status || 'failed',
      extra: {
        ...base,
        fullSha256: digest,
        httpStatus: response.status,
        rawTranscript: body.slice(0, 4000),
        endedAt: new Date().toISOString(),
        error: message,
        actualResponseModel: extra.actualResponseModel ?? null,
        actualResponseModelSource: extra.actualResponseModel ? 'response.model' : 'not-returned-by-api',
        responseId: extra.responseId ?? null,
        filesApiUploads: skipUpload || file ? 0 : 1,
        asrInteractions: 1,
        ...http,
        ...extra,
      },
    });
    await persistReport(outputPath, failed);
    const error = new Error(message);
    error.exitCode = extra.exitCode || EXIT_HARD;
    error.httpStatus = response.status;
    error.result = failed;
    if (extra.emptyTranscript) error.emptyTranscript = true;
    throw error;
  };

  if (response.status === 404) {
    await fail(`ASR model ${model} is not available (HTTP 404). Status remains pending-independent-asr; no substitute model was used.`, {
      status: 'pending-independent-asr',
      asrStatus: 'pending-independent-asr',
    });
  }
  if (response.status === 429) {
    await fail(`ASR quota exhausted for ${model}`, { exitCode: EXIT_QUOTA, status: 'quota' });
  }
  if (!response.ok) {
    await fail(`ASR ${model} failed (${response.status}): ${body.slice(0, 700)}`);
  }
  let payload;
  try { payload = JSON.parse(body); } catch {
    await fail('ASR response is not JSON');
  }
  const responseModel = extractResponseModel(payload);
  const responseId = extractResponseId(payload);
  if (responseModel && !String(responseModel).includes(model)) {
    await fail(`ASR response model ${responseModel} does not match requested ${model}. Silent substitution is forbidden.`, {
      actualResponseModel: responseModel,
      responseId,
    });
  }
  const transcript = extractTranscript(payload);
  if (!transcript) {
    await fail(`ASR ${model} returned an empty transcript`, { emptyTranscript: true, actualResponseModel: responseModel, responseId });
  }
  const comparison = compareExactSpokenText(expectedText, transcript);
  const result = asrIdentity({
    article,
    fingerprint,
    fullSha256: digest,
    model,
    status: comparison.passed ? 'passed' : 'failed',
    extra: {
      ...base,
      fullSha256: digest,
      httpStatus: 200,
      requestedModel: model,
      actualResponseModel: responseModel || null,
      actualResponseModelSource: responseModel ? 'response.model' : 'not-returned-by-api',
      responseId,
      fileUri: uploaded.uri,
      asrInteractions: 1,
      filesApiUploads: skipUpload || file ? 0 : 1,
      substitutions: comparison.substitutions,
      deletions: comparison.deletions,
      insertions: comparison.insertions,
      transcript,
      rawTranscript: transcript,
      normalizedTranscript: normalizeForVerbalComparison(transcript),
      expectedNormalized: normalizeForVerbalComparison(expectedText),
      differences: comparison.differences,
      endedAt: new Date().toISOString(),
      ...http,
    },
  });
  await persistReport(outputPath, result);
  if (!comparison.passed) {
    const error = new Error(`ASR ${model} failed exact match: S=${comparison.substitutions} D=${comparison.deletions} I=${comparison.insertions}`);
    error.exitCode = EXIT_HARD;
    error.result = result;
    throw error;
  }
  return result;
}

export async function transcribeDualAsr({
  audioPath,
  expectedText,
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = fetch,
  reportsDir,
  fingerprint = null,
  fullSha256 = null,
  article = null,
}) {
  const bytes = await readFile(audioPath);
  const digest = sha256(bytes);
  if (fullSha256 && digest !== fullSha256) {
    throw Object.assign(new Error('ASR audio SHA-256 does not match the candidate fingerprint full.mp3'), { exitCode: EXIT_HARD });
  }
  let uploaded = null;
  try {
    uploaded = await uploadAudioFile({ apiKey, bytes, fetchImpl });
  } catch (error) {
    const failedUpload = {
      schema: 'bareeq.audio-files-api.v1',
      status: 'failed',
      stage: error.stage || 'upload',
      error: error.message,
      httpStatus: error.httpStatus || null,
      http: error.http || emptyHttp(),
      fingerprint,
      fullSha256: digest,
      generatedAt: new Date().toISOString(),
    };
    if (reportsDir) await persistReport(path.join(reportsDir, 'files-api.json'), failedUpload);
    const asrReports = [];
    for (const model of INDEPENDENT_ASR_MODELS) {
      const failed = asrIdentity({
        article,
        fingerprint,
        fullSha256: digest,
        model,
        status: 'failed',
        extra: {
          error: `files-api-${error.stage || 'upload'}-failed`,
          httpStatus: error.httpStatus || null,
          ...emptyHttp(),
          ...(error.http || {}),
        },
      });
      if (reportsDir) await persistReport(path.join(reportsDir, `asr-${model}.json`), failed);
      asrReports.push(failed);
    }
    throw Object.assign(error, { dual: { asrReports, filesApi: failedUpload, totalHttpRequests: error.http?.totalHttpRequests || 0 } });
  }
  const asrReports = [];
  const failures = [];
  let http = { ...emptyHttp(), ...uploaded.http };
  if (reportsDir) {
    await persistReport(path.join(reportsDir, 'files-api.json'), {
      schema: 'bareeq.audio-files-api.v1',
      status: 'uploaded',
      uri: uploaded.uri,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
      name: uploaded.name,
      http: uploaded.http,
      fingerprint,
      fullSha256: digest,
      generatedAt: new Date().toISOString(),
    });
  }
  try {
    for (const model of INDEPENDENT_ASR_MODELS) {
      try {
        const report = await transcribeFullAudio({
          model,
          audioPath,
          expectedText,
          apiKey,
          fetchImpl,
          outputPath: reportsDir ? path.join(reportsDir, `asr-${model}.json`) : undefined,
          fingerprint,
          fullSha256: digest,
          file: uploaded,
          skipUpload: true,
          article,
          speechScriptHash: article?.speechScriptHash,
        });
        asrReports.push(report);
        http = addHttp(http, 'interactionsRequests');
      } catch (error) {
        if (error.result) asrReports.push(error.result);
        else {
          const failed = asrIdentity({
            article,
            fingerprint,
            fullSha256: digest,
            model,
            status: 'failed',
            extra: { error: error.message, httpStatus: error.httpStatus || null },
          });
          if (reportsDir) await persistReport(path.join(reportsDir, `asr-${model}.json`), failed);
          asrReports.push(failed);
        }
        failures.push(error);
        http = addHttp(http, 'interactionsRequests');
      }
    }
  } finally {
    const deletion = await deleteUploadedFile({ apiKey, name: uploaded.name, fetchImpl }).catch((error) => ({
      deleted: false,
      error: error.message,
      http: emptyHttp(),
      stage: 'delete',
    }));
    const deleteCount = deletion.http?.filesApiDeleteRequests || 0;
    if (deleteCount) {
      http = {
        ...http,
        filesApiDeleteRequests: (http.filesApiDeleteRequests || 0) + deleteCount,
        totalHttpRequests: (http.totalHttpRequests || 0) + (deletion.http.totalHttpRequests || 0),
      };
    } else {
      http = addHttp(http, 'filesApiDeleteRequests');
    }
    http.deleteResult = deletion;
    if (!deletion.deleted) {
      if (reportsDir) {
        await persistReport(path.join(reportsDir, 'files-api-delete.json'), {
          schema: 'bareeq.audio-files-api.v1',
          status: 'failed',
          stage: 'delete',
          error: deletion.error || `HTTP ${deletion.httpStatus}`,
          httpStatus: deletion.httpStatus || null,
          http: deletion.http || emptyHttp(),
          fingerprint,
          fullSha256: digest,
          generatedAt: new Date().toISOString(),
        });
      }
      failures.push(Object.assign(new Error(`Files API delete failed HTTP ${deletion.httpStatus || 0}`), {
        stage: 'delete',
        httpStatus: deletion.httpStatus,
      }));
    }
    for (const report of asrReports) {
      report.filesApiDeleteRequests = http.filesApiDeleteRequests;
      report.deleteResult = deletion;
      if (reportsDir) {
        await persistReport(path.join(reportsDir, `asr-${report.requestedModel || report.model}.json`), report);
      }
    }
  }
  const dual = {
    asrReports,
    filesApiUploads: 1,
    asrInteractions: asrReports.length,
    asrProviderCalls: http.totalHttpRequests,
    fullSha256: digest,
    fingerprint,
    candidateFingerprint: fingerprint,
    fileUri: uploaded.uri,
    deleteResult: http.deleteResult,
    logicalUploads: http.logicalUploads || 1,
    filesApiStartRequests: http.filesApiStartRequests || 1,
    filesApiFinalizeRequests: http.filesApiFinalizeRequests || 1,
    filesApiMetadataRequests: http.filesApiMetadataRequests || 0,
    filesApiDeleteRequests: http.filesApiDeleteRequests || 1,
    interactionsRequests: asrReports.length,
    totalHttpRequests: http.totalHttpRequests,
  };
  if (failures.length) {
    const error = failures[0];
    error.dual = dual;
    throw error;
  }
  return dual;
}


const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-asr-transcribe.mjs';
if (isCli) {
  const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--execute');
  const model = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
  const audio = process.argv.find((arg) => arg.startsWith('--audio='))?.slice('--audio='.length);
  const expectedPath = process.argv.find((arg) => arg.startsWith('--expected='))?.slice('--expected='.length);
  const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'docs/audio/asr-last.json';
  try {
    const expectedText = expectedPath ? await readFile(expectedPath, 'utf8') : '';
    const result = await transcribeFullAudio({
      model,
      audioPath: audio,
      expectedText,
      dryRun,
      outputPath: output,
    });
    console.log(dryRun
      ? `ASR dry-run for ${model}: 1 expected Interactions request after Files API upload, 0 sent.`
      : `ASR ${model} exact match 0/0/0.`);
    if (!dryRun && result.status !== 'passed') process.exit(EXIT_HARD);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode || EXIT_HARD);
  }
}
