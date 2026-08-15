import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const ELEVENLABS_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';
const MUNSIT_ENDPOINT = 'https://api.munsit.com/api/v1/text-to-speech';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_TTS_ENDPOINTS = {
  global: 'https://texttospeech.googleapis.com/v1/text:synthesize',
  us: 'https://us-texttospeech.googleapis.com/v1/text:synthesize',
  eu: 'https://eu-texttospeech.googleapis.com/v1/text:synthesize',
};

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function errorDetails(response) {
  const type = response.headers?.get?.('content-type') || '';
  try {
    if (type.includes('json')) {
      const data = await response.json();
      return JSON.stringify(data).slice(0, 800);
    }
    return (await response.text()).slice(0, 800);
  } catch {
    return 'No response details were available.';
  }
}

async function checkedFetch(fetchImpl, url, options, provider) {
  const response = await fetchImpl(url, { ...options, signal: options.signal || AbortSignal.timeout(120000) });
  if (!response.ok) {
    const detail = await errorDetails(response);
    throw new Error(`${provider} request failed with HTTP ${response.status}: ${detail}`);
  }
  return response;
}

function responseBytes(response) {
  return response.arrayBuffer().then((value) => Buffer.from(value));
}

async function googleServiceAccountToken(credentialsPath, fetchImpl, now = () => Date.now()) {
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const clientEmail = required(credentials.client_email, 'Google service-account client_email');
  const privateKey = required(credentials.private_key, 'Google service-account private_key');
  const tokenUri = credentials.token_uri?.trim() || GOOGLE_TOKEN_ENDPOINT;
  const issuedAt = Math.floor(now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(privateKey, 'base64url')}`;
  const response = await checkedFetch(fetchImpl, tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  }, 'Google OAuth');
  const data = await response.json();
  return {
    accessToken: required(data.access_token, 'Google OAuth access_token'),
    projectId: credentials.project_id?.trim() || '',
  };
}

async function googleAuth(env, fetchImpl) {
  const direct = env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim();
  if (direct) return { accessToken: direct, projectId: env.GOOGLE_CLOUD_PROJECT?.trim() || '' };
  const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!credentialsPath) {
    throw new Error('Google authentication requires GOOGLE_CLOUD_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS.');
  }
  const auth = await googleServiceAccountToken(credentialsPath, fetchImpl);
  return { ...auth, projectId: env.GOOGLE_CLOUD_PROJECT?.trim() || auth.projectId };
}

export function providerReadiness(candidate, env) {
  const missing = [];
  if (candidate.provider === 'openai' && !env.OPENAI_API_KEY?.trim()) missing.push('OPENAI_API_KEY');
  if (candidate.provider === 'elevenlabs') {
    if (!env.ELEVENLABS_API_KEY?.trim()) missing.push('ELEVENLABS_API_KEY');
    if (!(candidate.voice || env.ELEVENLABS_VOICE_ID)?.trim()) missing.push('ELEVENLABS_VOICE_ID');
  }
  if (candidate.provider === 'google') {
    if (!env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim() && !env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
      missing.push('GOOGLE_CLOUD_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS');
    }
    if (!env.GOOGLE_CLOUD_PROJECT?.trim() && !env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) missing.push('GOOGLE_CLOUD_PROJECT');
  }
  if (candidate.provider === 'munsit') {
    if (!env.MUNSIT_API_KEY?.trim()) missing.push('MUNSIT_API_KEY');
    if (!(candidate.voice || env.MUNSIT_VOICE_ID)?.trim()) missing.push('MUNSIT_VOICE_ID');
    const configuredRate = finiteNumber(env.MUNSIT_COST_PER_1000_CHARS_USD, NaN);
    if (!(configuredRate >= 0)) missing.push('MUNSIT_COST_PER_1000_CHARS_USD');
  }
  return { ready: missing.length === 0, missing };
}

export function estimateCandidateCost(candidate, characters, assumptions = {}, env = process.env) {
  const count = Math.max(0, Number(characters) || 0);
  const charsPerSecond = Math.max(1, finiteNumber(assumptions.arabicCharactersPerSecond, 11));
  const estimatedSeconds = count / charsPerSecond;
  if (candidate.provider === 'elevenlabs') {
    return { usd: count * 0.0001, method: 'published character rate', estimatedSeconds };
  }
  if (candidate.provider === 'google') {
    const textTokens = Math.ceil(count / Math.max(1, finiteNumber(assumptions.arabicCharactersPerTextToken, 2)));
    const audioTokens = Math.ceil(estimatedSeconds * 25);
    return { usd: textTokens * 0.5 / 1_000_000 + audioTokens * 10 / 1_000_000, method: 'token estimate', estimatedSeconds };
  }
  if (candidate.provider === 'openai') {
    const textTokens = Math.ceil(count / Math.max(1, finiteNumber(assumptions.arabicCharactersPerTextToken, 2)));
    const audioTokensPerSecond = Math.max(1, finiteNumber(assumptions.openAiAudioTokensPerSecond, 50));
    const audioTokens = Math.ceil(estimatedSeconds * audioTokensPerSecond);
    return { usd: textTokens * 0.6 / 1_000_000 + audioTokens * 12 / 1_000_000, method: 'conservative token estimate', estimatedSeconds };
  }
  if (candidate.provider === 'munsit') {
    const rate = finiteNumber(env.MUNSIT_COST_PER_1000_CHARS_USD, NaN);
    return { usd: rate >= 0 ? count / 1000 * rate : null, method: rate >= 0 ? 'dashboard rate supplied by operator' : 'unknown', estimatedSeconds };
  }
  return { usd: null, method: 'unknown', estimatedSeconds };
}

export async function synthesizeCandidate({ candidate, text, style, env = process.env, fetchImpl = fetch }) {
  const provider = required(candidate.provider, 'candidate provider');
  if (provider === 'openai') {
    const key = required(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
    const response = await checkedFetch(fetchImpl, OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: required(candidate.model, 'OpenAI model'),
        voice: required(candidate.voice, 'OpenAI voice'),
        input: required(text, 'speech text'),
        instructions: style || 'اقرأ بالعربية الفصحى الطبيعية، بنبرة معرفية هادئة وإيقاع مريح، من دون مبالغة تمثيلية.',
        response_format: 'wav',
        speed: finiteNumber(candidate.options?.speed, 1),
      }),
    }, 'OpenAI');
    return { bytes: await responseBytes(response), extension: 'wav', contentType: response.headers.get('content-type') || 'audio/wav' };
  }

  if (provider === 'elevenlabs') {
    const key = required(env.ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY');
    const voice = required(candidate.voice || env.ELEVENLABS_VOICE_ID, 'ELEVENLABS_VOICE_ID');
    const url = `${ELEVENLABS_ENDPOINT}/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
    const body = {
      text: required(text, 'speech text'),
      model_id: required(candidate.model, 'ElevenLabs model'),
      voice_settings: {
        stability: finiteNumber(candidate.options?.stability, 0.5),
        similarity_boost: finiteNumber(candidate.options?.similarityBoost, 0.75),
        style: finiteNumber(candidate.options?.style, 0.1),
        use_speaker_boost: candidate.options?.speakerBoost !== false,
        speed: finiteNumber(candidate.options?.speed, 1),
      },
      apply_text_normalization: 'auto',
      seed: Number.isInteger(candidate.options?.seed) ? candidate.options.seed : 41827,
    };
    if (candidate.model !== 'eleven_multilingual_v2') body.language_code = 'ar';
    const response = await checkedFetch(fetchImpl, url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    }, 'ElevenLabs');
    return { bytes: await responseBytes(response), extension: 'mp3', contentType: response.headers.get('content-type') || 'audio/mpeg' };
  }

  if (provider === 'google') {
    const auth = await googleAuth(env, fetchImpl);
    const region = candidate.options?.region || 'global';
    const endpoint = GOOGLE_TTS_ENDPOINTS[region];
    if (!endpoint) throw new Error(`Unsupported Google TTS region: ${region}`);
    const headers = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' };
    if (auth.projectId) headers['x-goog-user-project'] = auth.projectId;
    const response = await checkedFetch(fetchImpl, endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: { text: required(text, 'speech text'), prompt: style || 'Narrate in calm, natural Modern Standard Arabic for a premium knowledge article.' },
        voice: {
          languageCode: candidate.language || 'ar-001',
          name: required(candidate.voice, 'Google voice'),
          modelName: required(candidate.model, 'Google model'),
        },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 48000 },
      }),
    }, 'Google TTS');
    const data = await response.json();
    const content = required(data.audioContent, 'Google TTS audioContent');
    return { bytes: Buffer.from(content, 'base64'), extension: 'wav', contentType: 'audio/wav' };
  }

  if (provider === 'munsit') {
    const key = required(env.MUNSIT_API_KEY, 'MUNSIT_API_KEY');
    const voice = required(candidate.voice || env.MUNSIT_VOICE_ID, 'MUNSIT_VOICE_ID');
    const model = required(candidate.model, 'Munsit model');
    const response = await checkedFetch(fetchImpl, `${MUNSIT_ENDPOINT}/${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({
        voice_id: voice,
        text: required(text, 'speech text'),
        stability: finiteNumber(candidate.options?.stability, 0.55),
        speed: finiteNumber(candidate.options?.speed, 1),
        streaming: false,
        sample_rate: 48000,
        dialect: candidate.options?.dialect || 'fusha',
      }),
    }, 'Munsit');
    return { bytes: await responseBytes(response), extension: 'wav', contentType: response.headers.get('content-type') || 'audio/wav' };
  }

  throw new Error(`Unsupported voice provider: ${provider}`);
}

export async function listProviderVoices({ provider, env = process.env, fetchImpl = fetch }) {
  if (provider === 'openai') {
    return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
      .map((voice) => ({ voiceId: voice, name: voice, languages: ['ar'], note: ['marin', 'cedar'].includes(voice) ? 'Recommended by OpenAI for best overall quality' : '' }));
  }
  if (provider === 'google') {
    return ['Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede', 'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome', 'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus', 'Pulcherrima', 'Puck', 'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi']
      .map((voice) => ({ voiceId: voice, name: voice, languages: ['ar-001', 'ar-EG'], note: 'Gemini-TTS prebuilt voice' }));
  }
  if (provider === 'elevenlabs') {
    const key = required(env.ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY');
    const response = await checkedFetch(fetchImpl, 'https://api.elevenlabs.io/v2/voices', {
      method: 'GET',
      headers: { 'xi-api-key': key, Accept: 'application/json' },
    }, 'ElevenLabs voices');
    const data = await response.json();
    return (data.voices || []).map((voice) => ({
      voiceId: voice.voice_id,
      name: voice.name || voice.voice_id,
      languages: voice.languages || [],
      note: [voice.labels?.accent, voice.labels?.description, voice.category].filter(Boolean).join(' · '),
    }));
  }
  if (provider === 'munsit') {
    const key = required(env.MUNSIT_API_KEY, 'MUNSIT_API_KEY');
    const response = await checkedFetch(fetchImpl, 'https://api.munsit.com/api/v1/voices', {
      method: 'GET',
      headers: { 'x-api-key': key, Accept: 'application/json' },
    }, 'Munsit voices');
    const data = await response.json();
    const voices = Array.isArray(data) ? data : data.data || data.voices || [];
    return voices.map((voice) => ({
      voiceId: voice.voice_id,
      name: voice.name || voice.voice_id,
      languages: voice.languages || [],
      dialects: voice.dialect || [],
      gender: voice.gender || '',
      note: voice.description || '',
    }));
  }
  throw new Error(`Unsupported voice provider: ${provider}`);
}

export const providerEndpoints = Object.freeze({
  openai: OPENAI_ENDPOINT,
  elevenlabs: ELEVENLABS_ENDPOINT,
  google: GOOGLE_TTS_ENDPOINTS.global,
  munsit: MUNSIT_ENDPOINT,
});
