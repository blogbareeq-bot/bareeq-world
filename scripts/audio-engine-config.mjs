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
    catch (error) { throw configError(profile.argsEnv + ' must be a JSON array: ' + error.message, USAGE_EXIT); }
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
  const runtime = engineRuntimeConfig(profile, env);
  if (runtime.kind === 'missing') {
    throw configError(profile.id + ' requires either ' + profile.endpointEnv + ' or ' + profile.binEnv + '. No TTS request was sent.');
  }
  return runtime;
}

export function engineFingerprintExtension(env = process.env) {
  const profile = selectedEngineProfile(env);
  if (profile.id === 'gemini') return null;
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
  };
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
