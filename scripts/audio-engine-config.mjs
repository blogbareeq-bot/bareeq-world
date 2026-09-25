import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_EXIT = 78;
const USAGE_EXIT = 2;

export const ARABIC_NORMALIZER_VERSION = 1;
export const DEFAULT_PRONUNCIATION_LEXICON_VERSION = 1;

const PROFILES = {
  gemini: {
    id: 'gemini',
    provider: 'Google Gemini API',
    model: 'gemini-3.1-flash-tts-preview',
    voice: 'Sadaltager',
    voiceId: 'sadaltager',
    sampleRateHz: 24000,
    outputSampleRateHz: 48000,
    transport: 'developer-interactions',
    local: false,
    commercialAllowed: true,
    license: 'provider-terms',
    supportsVoiceDesign: false,
  },
  voxcpm2: {
    id: 'voxcpm2',
    provider: 'OpenBMB VoxCPM2',
    model: 'openbmb/VoxCPM2',
    voice: 'bareeq-designed',
    voiceId: 'bareeq-designed',
    sampleRateHz: 48000,
    outputSampleRateHz: 48000,
    transport: 'local-worker',
    local: true,
    commercialAllowed: true,
    license: 'Apache-2.0',
    supportsVoiceDesign: true,
    endpointEnv: 'BAREEQ_VOXCPM2_ENDPOINT',
    tokenEnv: 'BAREEQ_VOXCPM2_TOKEN',
    binEnv: 'BAREEQ_VOXCPM2_BIN',
    argsEnv: 'BAREEQ_VOXCPM2_ARGS_JSON',
  },
  'moss-v15': {
    id: 'moss-v15',
    provider: 'OpenMOSS MOSS-TTS',
    model: 'OpenMOSS-Team/MOSS-TTS-v1.5',
    voice: 'bareeq-reference-or-default',
    voiceId: 'bareeq-reference-or-default',
    sampleRateHz: 24000,
    outputSampleRateHz: 48000,
    transport: 'local-worker',
    local: true,
    commercialAllowed: true,
    license: 'Apache-2.0',
    supportsVoiceDesign: false,
    endpointEnv: 'BAREEQ_MOSS_V15_ENDPOINT',
    tokenEnv: 'BAREEQ_MOSS_V15_TOKEN',
    binEnv: 'BAREEQ_MOSS_V15_BIN',
    argsEnv: 'BAREEQ_MOSS_V15_ARGS_JSON',
  },
  'moss-nano': {
    id: 'moss-nano',
    provider: 'OpenMOSS MOSS-TTS-Nano',
    model: 'OpenMOSS-Team/MOSS-TTS-Nano-100M',
    voice: 'bareeq-fallback',
    voiceId: 'bareeq-fallback',
    sampleRateHz: 48000,
    outputSampleRateHz: 48000,
    transport: 'local-worker',
    local: true,
    commercialAllowed: true,
    license: 'Apache-2.0',
    supportsVoiceDesign: false,
    endpointEnv: 'BAREEQ_MOSS_NANO_ENDPOINT',
    tokenEnv: 'BAREEQ_MOSS_NANO_TOKEN',
    binEnv: 'BAREEQ_MOSS_NANO_BIN',
    argsEnv: 'BAREEQ_MOSS_NANO_ARGS_JSON',
  },
};

export const AUDIO_ENGINE_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(PROFILES).map(([key, value]) => [key, Object.freeze({ ...value })]),
));

const ALIASES = Object.freeze({
  sadaltager: 'gemini',
  'gemini-sadaltager': 'gemini',
  vox: 'voxcpm2',
  moss: 'moss-v15',
  'moss-tts-v15': 'moss-v15',
  nano: 'moss-nano',
  'moss-tts-nano': 'moss-nano',
});

function configError(message, exitCode = CONFIG_EXIT) {
  return Object.assign(new Error(message), { exitCode });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function referenceAudioDigest(env) {
  const reference = String(env.BAREEQ_TTS_REFERENCE_AUDIO || '').trim();
  if (!reference) return null;
  const declared = String(env.BAREEQ_TTS_REFERENCE_AUDIO_SHA256 || '').trim().toLowerCase();
  if (declared && !/^[a-f0-9]{64}$/.test(declared)) throw configError('BAREEQ_TTS_REFERENCE_AUDIO_SHA256 must be a SHA-256 digest.');
  const absolute = path.resolve(reference);
  if (existsSync(absolute)) {
    const actual = digest(readFileSync(absolute));
    if (declared && declared !== actual) throw configError('Reference audio SHA-256 does not match its bytes.');
    return actual;
  }
  if (!declared) throw configError('Worker-side reference audio requires BAREEQ_TTS_REFERENCE_AUDIO_SHA256.');
  return declared;
}

function lexiconDigest(env) {
  const file = env.BAREEQ_PRONUNCIATION_LEXICON
    ? path.resolve(env.BAREEQ_PRONUNCIATION_LEXICON)
    : fileURLToPath(new URL('./audio-pronunciation-lexicon.json', import.meta.url));
  return digest(readFileSync(file));
}

export function selectedEngineId(env = process.env) {
  const requested = String(env.BAREEQ_TTS_ENGINE || 'gemini').trim().toLowerCase();
  return ALIASES[requested] || requested;
}

export function selectedEngineProfile(env = process.env) {
  const id = selectedEngineId(env);
  const profile = AUDIO_ENGINE_PROFILES[id];
  if (!profile) {
    throw configError('Unknown BAREEQ_TTS_ENGINE=' + id + '. Supported engines: ' + Object.keys(AUDIO_ENGINE_PROFILES).join(', ') + '.', USAGE_EXIT);
  }
  return profile;
}

export function engineRuntimeConfig(profile = selectedEngineProfile(), env = process.env) {
  if (!profile.local) return { kind: 'gemini', endpoint: null, bin: null, args: [], token: null };
  const endpoint = String(env[profile.endpointEnv] || '').trim();
  const bin = String(env[profile.binEnv] || '').trim();
  const token = String(env[profile.tokenEnv] || '').trim() || null;
  let args = [];
  const rawArgs = String(env[profile.argsEnv] || '').trim();
  if (rawArgs) {
    try { args = JSON.parse(rawArgs); }
    catch { throw configError(profile.argsEnv + ' must be a JSON array.', USAGE_EXIT); }
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      throw configError(profile.argsEnv + ' must be a JSON array of strings.', USAGE_EXIT);
    }
  }
  return { kind: endpoint ? 'http' : bin ? 'command' : 'missing', endpoint, bin, args, token };
}

export function assertEngineConfiguration(profile = selectedEngineProfile(), env = process.env) {
  if (!profile.commercialAllowed && env.BAREEQ_ALLOW_NONCOMMERCIAL_ENGINE !== '1') {
    throw configError(profile.id + ' is not approved for Bareeq commercial production.');
  }
  if (!profile.local) return engineRuntimeConfig(profile, env);
  if (env.BAREEQ_LOCAL_TTS_ENABLE !== '1') {
    throw configError(profile.id + ' is local/worker TTS and is disabled. Set BAREEQ_LOCAL_TTS_ENABLE=1 only on an approved worker.');
  }
  if (!String(env.BAREEQ_TTS_MODEL_REVISION || '').trim() || !String(env.BAREEQ_TTS_WORKER_REVISION || '').trim()) {
    throw configError('Local TTS requires pinned BAREEQ_TTS_MODEL_REVISION and BAREEQ_TTS_WORKER_REVISION.');
  }
  const runtime = engineRuntimeConfig(profile, env);
  if (runtime.kind === 'missing') {
    throw configError(profile.id + ' requires either ' + profile.endpointEnv + ' or ' + profile.binEnv + '. No TTS request was sent.');
  }
  if (runtime.kind === 'http') {
    let url;
    try { url = new URL(runtime.endpoint); } catch { throw configError('Local TTS endpoint must be a valid URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw configError('Local TTS endpoint must use HTTPS, or HTTP on loopback.');
    }
    if (url.username || url.password) throw configError('Credentials in local TTS endpoint URLs are forbidden.');
    if ([...url.searchParams.keys()].some((key) => /^(token|key|api_key|access_token)$/i.test(key))) {
      throw configError('Local TTS endpoint secrets must use its Authorization header.');
    }
    if (!loopback) {
      const allowlist = String(env.BAREEQ_LOCAL_TTS_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim());
      if (!allowlist.includes(url.origin)) throw configError('Remote TTS worker origin is not explicitly allow-listed.');
      runtime.approvedOrigin = url.origin;
    }
  }
  return runtime;
}

export function engineFingerprintExtension(env = process.env) {
  const profile = selectedEngineProfile(env);
  if (profile.id === 'gemini') return null;
  const runtime = engineRuntimeConfig(profile, env);
  const correctionHints = String(env.BAREEQ_TTS_CORRECTION_HINTS_JSON || '').trim();
  let parsedHints = {};
  try { parsedHints = correctionHints ? JSON.parse(correctionHints) : {}; }
  catch { throw configError('BAREEQ_TTS_CORRECTION_HINTS_JSON must be valid JSON.'); }
  return {
    engineId: profile.id,
    provider: profile.provider,
    model: profile.model,
    voice: profile.voice,
    license: profile.license,
    normalizerVersion: ARABIC_NORMALIZER_VERSION,
    pronunciationLexiconVersion: Number(env.BAREEQ_PRONUNCIATION_LEXICON_VERSION || DEFAULT_PRONUNCIATION_LEXICON_VERSION),
    voiceDesignPrompt: profile.supportsVoiceDesign ? String(env.BAREEQ_VOICE_DESIGN_PROMPT || '').trim() : '',
    synthesisProfile: String(env.BAREEQ_TTS_SYNTHESIS_PROFILE || 'bareeq-ar-v1').trim(),
    lexiconSha256: lexiconDigest(env),
    referenceAudioSha256: referenceAudioDigest(env),
    modelRevision: String(env.BAREEQ_TTS_MODEL_REVISION || '').trim(),
    workerRevision: String(env.BAREEQ_TTS_WORKER_REVISION || '').trim(),
    workerContractSha256: digest(JSON.stringify({ kind: runtime.kind, endpoint: runtime.endpoint, bin: runtime.bin, args: runtime.args })),
    correctionHintsSha256: digest(JSON.stringify(parsedHints)),
    output: { format: 'mp3', sampleRateHz: profile.outputSampleRateHz || 48000, channels: 1, bitrateKbps: 96 },
  };
}

export function synthesisContractSha256(env = process.env) {
  const contract = engineFingerprintExtension(env);
  return contract ? digest(JSON.stringify(contract)) : null;
}

export function publicEngineIdentity(env = process.env) {
  const profile = selectedEngineProfile(env);
  return {
    engineId: profile.id,
    provider: profile.provider,
    model: profile.model,
    voice: profile.voice,
    voiceId: profile.voiceId,
    license: profile.license,
    commercialAllowed: profile.commercialAllowed,
    local: profile.local,
    sampleRateHz: profile.sampleRateHz,
    outputSampleRateHz: profile.outputSampleRateHz,
    supportsVoiceDesign: profile.supportsVoiceDesign,
  };
}
