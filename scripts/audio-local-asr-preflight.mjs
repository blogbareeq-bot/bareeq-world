import { readFile } from 'node:fs/promises';
import { runCommand } from './audio-ffmpeg.mjs';
import { compareExactSpokenText, normalizeForVerbalComparison } from './audio-exact-match.mjs';
import { atomicWriteJson } from './audio-io.mjs';
import { sha256 } from './audio-constants.mjs';

const EXIT_CONFIG = 78;

function configError(message) {
  return Object.assign(new Error(message), { exitCode: EXIT_CONFIG });
}

function parseArgs(env, audioPath) {
  const raw = String(env.BAREEQ_LOCAL_ASR_ARGS_JSON || '').trim();
  let args;
  try { args = raw ? JSON.parse(raw) : ['--audio', '{audio}', '--language', 'ar']; }
  catch { throw configError('BAREEQ_LOCAL_ASR_ARGS_JSON must be valid JSON.'); }
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw configError('BAREEQ_LOCAL_ASR_ARGS_JSON must be a JSON array of strings.');
  return args.map((item) => item.replaceAll('{audio}', audioPath).replaceAll('{language}', 'ar'));
}

function parseTranscript(stdout, env) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8').trim() : String(stdout || '').trim();
  if (!text) return '';
  if (env.BAREEQ_LOCAL_ASR_OUTPUT === 'json') {
    const payload = JSON.parse(text);
    return String(payload.transcript || payload.text || payload.output_text || '').trim();
  }
  return text;
}

async function persist(outputPath, report) {
  if (!outputPath) return;
  await atomicWriteJson(outputPath, report);
}

export async function runLocalAsrPreflight({
  audioPath,
  expectedText,
  outputPath,
  env = process.env,
  transcribeImpl,
} = {}) {
  if (env.BAREEQ_LOCAL_ASR_PREFLIGHT !== '1') {
    const skipped = { schema: 'bareeq.audio-local-asr-preflight.v1', status: 'skipped', enabled: false, providerCalls: 0 };
    await persist(outputPath, skipped);
    return skipped;
  }
  let transcript = '';
  let providerCalls = 0;
  const audioSha256 = await readFile(audioPath).then(sha256).catch(() => null);
  try {
  if (typeof transcribeImpl === 'function') {
    transcript = String(await transcribeImpl({ audioPath, language: 'ar' }) || '').trim();
    providerCalls = 1;
  } else {
    const bin = String(env.BAREEQ_LOCAL_ASR_BIN || '').trim();
    if (!bin) throw configError('BAREEQ_LOCAL_ASR_PREFLIGHT=1 requires BAREEQ_LOCAL_ASR_BIN. Dual ASR was not started.');
    let args;
    try { args = parseArgs(env, audioPath); }
    catch (error) {
      if (error.exitCode) throw error;
      throw configError('Invalid local ASR arguments.');
    }
    const result = await runCommand(bin, args, { timeoutMs: Number(env.BAREEQ_LOCAL_ASR_TIMEOUT_MS || 900000) });
    providerCalls = 1;
    if (result.code !== 0) throw Object.assign(new Error('Local ASR preflight process failed (' + result.code + ').'), { exitCode: 1 });
    transcript = parseTranscript(result.stdout, env);
  }
  } catch (error) {
    await persist(outputPath, {
      schema: 'bareeq.audio-local-asr-preflight.v1', status: 'error', enabled: true,
      audioSha256, providerCalls, generatedAt: new Date().toISOString(),
      errorCode: error.exitCode === EXIT_CONFIG ? 'config' : 'worker-error',
    });
    throw Object.assign(new Error(error.exitCode === EXIT_CONFIG
      ? 'Local ASR preflight is not configured.' : 'Local ASR preflight worker failed.'),
    { exitCode: error.exitCode || 1 });
  }
  if (!transcript) {
    await persist(outputPath, { schema: 'bareeq.audio-local-asr-preflight.v1', status: 'error',
      enabled: true, audioSha256, providerCalls, errorCode: 'empty-transcript', generatedAt: new Date().toISOString() });
    throw Object.assign(new Error('Local ASR preflight returned an empty transcript. Dual ASR was not started.'), { exitCode: 1 });
  }
  const comparison = compareExactSpokenText(expectedText, transcript);
  const report = {
    schema: 'bareeq.audio-local-asr-preflight.v1',
    status: comparison.passed ? 'passed' : 'failed',
    enabled: true,
    audioSha256,
    engine: String(env.BAREEQ_LOCAL_ASR_ENGINE || 'faster-whisper'),
    substitutions: comparison.substitutions,
    deletions: comparison.deletions,
    insertions: comparison.insertions,
    transcript,
    normalizedTranscript: normalizeForVerbalComparison(transcript),
    expectedNormalized: normalizeForVerbalComparison(expectedText),
    differences: comparison.differences,
    providerCalls,
    remoteProviderCallsAvoidedOnFailure: !comparison.passed ? 2 : 0,
    generatedAt: new Date().toISOString(),
  };
  await persist(outputPath, report);
  return report;
}
