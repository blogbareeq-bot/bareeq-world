import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { compareExactSpokenText, normalizeForVerbalComparison } from './audio-exact-match.mjs';
import {
  EXIT_CONFIG,
  EXIT_HARD,
  EXIT_QUOTA,
  EXIT_USAGE,
  GENERATOR_VERSION,
  PRODUCTION_TTS_MODEL,
  PRODUCTION_VOICE,
  sha256,
} from './audio-constants.mjs';
import { writeJson } from './audio-checkpoint.mjs';
import { boundIdentity } from './audio-report.mjs';

export const OPENROUTER_STT_ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions';
export const OPENROUTER_RECOVERY_ASR_MODEL = 'openai/gpt-4o-transcribe';
export const OPENROUTER_DUAL_ASR_MODELS = Object.freeze([
  'openai/gpt-transcribe',
  'microsoft/mai-transcribe-1.5',
]);
const SUPPORTED_OPENROUTER_ASR_MODELS = new Set([
  OPENROUTER_RECOVERY_ASR_MODEL,
  ...OPENROUTER_DUAL_ASR_MODELS,
]);

function reportIdentity({ article, fingerprint, fullSha256, model, status, extra = {} }) {
  return boundIdentity({
    article,
    fingerprint,
    fullSha256,
    model,
    status,
    schema: 'bareeq.audio-asr.v4',
    extra: {
      provider: `OpenRouter / ${String(model).split('/')[0] || 'unknown'}`,
      voice: PRODUCTION_VOICE,
      generatorVersion: GENERATOR_VERSION,
      ttsModel: PRODUCTION_TTS_MODEL,
      ...extra,
    },
  });
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) || response?.headers?.get?.(name.toLowerCase()) || null;
}

export async function transcribeOpenRouterParts({
  model = OPENROUTER_RECOVERY_ASR_MODEL,
  audioPath,
  parts,
  expectedText,
  article,
  fingerprint,
  fullSha256,
  outputPath,
  apiKey = process.env.OPENROUTER_API_KEY,
  fetchImpl = globalThis.fetch,
}) {
  if (!SUPPORTED_OPENROUTER_ASR_MODELS.has(model)) {
    throw Object.assign(new Error(`Unsupported OpenRouter recovery ASR model ${model}`), { exitCode: EXIT_USAGE });
  }
  if (!apiKey?.trim()) {
    throw Object.assign(new Error('OPENROUTER_API_KEY is absent. Independent recovery ASR did not start.'), { exitCode: EXIT_CONFIG });
  }
  if (!audioPath || !Array.isArray(parts) || !parts.length || expectedText == null) {
    throw Object.assign(new Error('OpenRouter recovery ASR requires full audio, non-empty parts, and expected text'), { exitCode: EXIT_USAGE });
  }

  const startedAt = new Date().toISOString();
  const fullBytes = await readFile(audioPath);
  const digest = sha256(fullBytes);
  if (fullSha256 && digest !== fullSha256) {
    throw Object.assign(new Error('OpenRouter ASR full audio SHA-256 does not match the candidate'), { exitCode: EXIT_HARD });
  }

  const transcripts = [];
  const partEvidence = [];
  let usageCost = 0;
  for (const [index, part] of parts.entries()) {
    const bytes = await readFile(part.audioPath);
    let response;
    let body = '';
    try {
      response = await fetchImpl(OPENROUTER_STT_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://bareeqworld.com',
          'X-OpenRouter-Title': 'Bareeq Dual-ASR Recovery',
        },
        body: JSON.stringify({
          model,
          input_audio: {
            data: bytes.toString('base64'),
            format: 'mp3',
          },
          language: 'ar',
          temperature: 0,
          response_format: 'json',
        }),
      });
      body = await response.text();
    } catch (error) {
      error.exitCode = EXIT_HARD;
      error.httpStatus = 0;
      throw error;
    }

    if (response.status === 429 || response.status === 402) {
      const error = new Error(`OpenRouter ASR quota exhausted for ${model} at part ${index + 1}`);
      error.exitCode = EXIT_QUOTA;
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`OpenRouter ASR ${model} failed at part ${index + 1} (${response.status}): ${body.slice(0, 700)}`);
      error.exitCode = EXIT_HARD;
      error.httpStatus = response.status;
      throw error;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw Object.assign(new Error(`OpenRouter ASR returned non-JSON at part ${index + 1}`), { exitCode: EXIT_HARD, httpStatus: response.status });
    }
    const transcript = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!transcript) {
      throw Object.assign(new Error(`OpenRouter ASR returned an empty transcript at part ${index + 1}`), { exitCode: EXIT_HARD, httpStatus: response.status });
    }
    if (payload?.model && payload.model !== model) {
      throw Object.assign(new Error(`OpenRouter silently substituted ${payload.model} for ${model}`), { exitCode: EXIT_HARD, httpStatus: response.status });
    }

    const partComparison = compareExactSpokenText(part.expectedText, transcript);
    const generationId = responseHeader(response, 'x-generation-id');
    const cost = Number(payload?.usage?.cost || 0);
    if (Number.isFinite(cost)) usageCost += cost;
    transcripts.push(transcript);
    partEvidence.push({
      partIndex: part.partIndex ?? index,
      file: path.basename(part.audioPath),
      sha256: sha256(bytes),
      bytes: bytes.length,
      generationId,
      requestedModel: model,
      actualResponseModel: payload?.model || null,
      actualResponseModelSource: payload?.model ? 'response.model' : 'exact-model request bound by x-generation-id',
      httpStatus: response.status,
      usage: payload?.usage || null,
      substitutions: partComparison.substitutions,
      deletions: partComparison.deletions,
      insertions: partComparison.insertions,
    });
  }

  const transcript = transcripts.join(' ').trim();
  const comparison = compareExactSpokenText(expectedText, transcript);
  const report = reportIdentity({
    article,
    fingerprint,
    fullSha256: digest,
    model,
    status: comparison.passed ? 'passed' : 'failed',
    extra: {
      startedAt,
      endedAt: new Date().toISOString(),
      requestedModel: model,
      actualResponseModel: model,
      actualResponseModelSource: 'OpenRouter exact model route; per-part x-generation-id evidence recorded',
      endpoint: OPENROUTER_STT_ENDPOINT,
      transport: {
        api: 'openrouter-audio-transcriptions',
        input: 'base64-mp3-parts',
        language: 'ar',
        verbatim: true,
      },
      audio: audioPath,
      httpStatus: 200,
      filesApiUploads: 0,
      asrInteractions: parts.length,
      transcriptionsRequests: parts.length,
      totalHttpRequests: parts.length,
      partCount: parts.length,
      parts: partEvidence,
      usageCost,
      transcript,
      rawTranscript: transcript,
      normalizedTranscript: normalizeForVerbalComparison(transcript),
      expectedNormalized: normalizeForVerbalComparison(expectedText),
      substitutions: comparison.substitutions,
      deletions: comparison.deletions,
      insertions: comparison.insertions,
      differences: comparison.differences,
    },
  });
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeJson(outputPath, report);
  }
  if (!comparison.passed) {
    const error = new Error(`OpenRouter ASR ${model} raw exact comparison: S=${comparison.substitutions} D=${comparison.deletions} I=${comparison.insertions}`);
    error.exitCode = EXIT_HARD;
    error.httpStatus = 200;
    error.result = report;
    throw error;
  }
  return report;
}
