import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareExactSpokenText } from './audio-exact-match.mjs';
import {
  FORBIDDEN_ASR_MODELS,
  INDEPENDENT_ASR_MODELS,
  ASR_MODEL_TRANSPORT,
  EXIT_CONFIG,
  EXIT_HARD,
  EXIT_QUOTA,
  EXIT_USAGE,
} from './audio-constants.mjs';

export const GEMINI_INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const GEMINI_FILES_UPLOAD = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_API_REVISION = '2026-05-20';

const VERBATIM_PROMPT = 'Transcribe this Arabic audio verbatim. Return only the spoken words. Do not add commentary, timestamps, speaker labels, or formatting beyond the words themselves.';

export function assertAsrModel(model) {
  if (FORBIDDEN_ASR_MODELS.includes(model)) {
    throw Object.assign(new Error(`${model} is not a valid independent ASR model id and must not be used.`), { exitCode: EXIT_USAGE });
  }
  if (!INDEPENDENT_ASR_MODELS.includes(model)) {
    throw Object.assign(new Error(`ASR model must be one of ${INDEPENDENT_ASR_MODELS.join(', ')}.`), { exitCode: EXIT_USAGE });
  }
  return ASR_MODEL_TRANSPORT[model];
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

function headers(apiKey) {
  return {
    'x-goog-api-key': apiKey,
    'Api-Revision': GEMINI_API_REVISION,
    Accept: 'application/json',
  };
}

export async function uploadAudioFile({ apiKey, bytes, mimeType = 'audio/mpeg', displayName = 'bareeq-full.mp3', fetchImpl = fetch }) {
  const response = await fetchImpl(GEMINI_FILES_UPLOAD, {
    method: 'POST',
    headers: {
      ...headers(apiKey),
      'Content-Type': mimeType,
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: bytes,
  });
  const body = await response.text();
  if (response.status === 429) {
    throw Object.assign(new Error('Files API HTTP 429'), { httpStatus: 429, exitCode: EXIT_QUOTA });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Files API upload failed (${response.status}): ${body.slice(0, 400)}`), { httpStatus: response.status, exitCode: EXIT_HARD });
  }
  const payload = JSON.parse(body);
  const file = payload.file || payload;
  if (!file?.uri) throw Object.assign(new Error('Files API response is missing uri'), { exitCode: EXIT_HARD });
  return { uri: file.uri, mimeType: file.mimeType || file.mime_type || mimeType, name: file.name || displayName, raw: payload };
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
}) {
  assertAsrModel(model);
  const report = {
    schema: 'bareeq.audio-asr.v2',
    generatedAt: new Date().toISOString(),
    model,
    audio: audioPath || null,
    transport: ASR_MODEL_TRANSPORT[model],
    independentModels: INDEPENDENT_ASR_MODELS,
    forbiddenModels: FORBIDDEN_ASR_MODELS,
  };
  if (dryRun) {
    report.status = 'not-run';
    report.note = 'Dry-run only. No audio bytes were uploaded and no transcription API was called.';
    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  }
  if (!apiKey?.trim()) {
    throw Object.assign(new Error('GEMINI_API_KEY is absent. No transcription request was sent.'), { exitCode: EXIT_CONFIG });
  }
  if (!audioPath || expectedText == null) {
    throw Object.assign(new Error('--audio and --expected are required'), { exitCode: EXIT_USAGE });
  }

  const bytes = await readFile(audioPath);
  const file = await uploadAudioFile({ apiKey, bytes, fetchImpl });
  const response = await fetchImpl(GEMINI_INTERACTIONS, {
    method: 'POST',
    headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(buildInteractionBody(model, file)),
  });
  const body = await response.text();
  if (response.status === 404) {
    throw Object.assign(new Error(`ASR model ${model} is not available (HTTP 404). Status remains pending-independent-asr; no substitute model was used.`), {
      httpStatus: 404,
      asrStatus: 'pending-independent-asr',
      exitCode: EXIT_HARD,
    });
  }
  if (response.status === 429) {
    throw Object.assign(new Error(`ASR quota exhausted for ${model}`), { httpStatus: 429, exitCode: EXIT_QUOTA });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`ASR ${model} failed (${response.status}): ${body.slice(0, 700)}`), { httpStatus: response.status, exitCode: EXIT_HARD });
  }
  let payload;
  try { payload = JSON.parse(body); } catch {
    throw Object.assign(new Error('ASR response is not JSON'), { exitCode: EXIT_HARD });
  }
  const responseModel = extractResponseModel(payload);
  if (responseModel && !String(responseModel).includes(model)) {
    throw Object.assign(new Error(`ASR response model ${responseModel} does not match requested ${model}. Silent substitution is forbidden.`), { exitCode: EXIT_HARD });
  }
  const transcript = extractTranscript(payload);
  if (!transcript) {
    throw Object.assign(new Error(`ASR ${model} returned an empty transcript`), { exitCode: EXIT_HARD, emptyTranscript: true });
  }
  const comparison = compareExactSpokenText(expectedText, transcript);
  const result = {
    ...report,
    status: comparison.passed ? 'passed' : 'failed',
    httpStatus: 200,
    responseModel: responseModel || model,
    fileUri: file.uri,
    substitutions: comparison.substitutions,
    deletions: comparison.deletions,
    insertions: comparison.insertions,
    transcript,
    rawTranscript: transcript,
    differences: comparison.differences,
  };
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (!comparison.passed) {
    const error = new Error(`ASR ${model} failed exact match: S=${comparison.substitutions} D=${comparison.deletions} I=${comparison.insertions}`);
    error.exitCode = EXIT_HARD;
    error.result = result;
    throw error;
  }
  return result;
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
