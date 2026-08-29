import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const CLOUD_TTS_MODEL = 'gemini-2.5-flash-tts';
export const CLOUD_TTS_LANGUAGE = 'ar-EG';
export const CLOUD_TTS_VOICE = 'Sadaltager';
export const CLOUD_TTS_AUDIO_ENCODING = 'MP3';
export const CLOUD_TTS_STYLE = 'اقرأ النص العربي بالفصحى الطبيعية بصوت معرفي ناضج ودافئ، وبإيقاع متوسط مريح. حافظ على وضوح النطق ووحدة شخصية الراوي بين المقاطع، وتجنب الهمس والمبالغة التمثيلية والنبرة الإعلانية. انطق النص فقط دون إضافة أو تعليق.';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const OFFICIAL_TOKEN_HOSTS = new Set(['oauth2.googleapis.com', 'accounts.google.com']);
const SUPPORTED_REGIONS = new Set(['global', 'us', 'eu', 'northamerica-northeast1']);
const encoder = new TextEncoder();
let cachedToken = null;

const byteLength = (value) => encoder.encode(String(value || '')).byteLength;
const base64Url = (value) => Buffer.from(value).toString('base64url');

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function validateLocalContractUrl(raw, label) {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} is restricted to local HTTP during an explicit contract test.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function cloudTtsEndpoint(env = process.env, contractTest = false) {
  const override = env.GOOGLE_CLOUD_TTS_ENDPOINT?.trim();
  if (override) {
    if (!contractTest) throw new Error('GOOGLE_CLOUD_TTS_ENDPOINT is restricted to the explicit local contract test.');
    return validateLocalContractUrl(override, 'GOOGLE_CLOUD_TTS_ENDPOINT');
  }
  const region = env.GOOGLE_CLOUD_TTS_REGION?.trim().toLowerCase() || 'global';
  if (!SUPPORTED_REGIONS.has(region)) {
    throw new Error(`GOOGLE_CLOUD_TTS_REGION must be one of: ${[...SUPPORTED_REGIONS].join(', ')}.`);
  }
  return region === 'global'
    ? 'https://texttospeech.googleapis.com'
    : `https://${region}-texttospeech.googleapis.com`;
}

export function assertCloudTtsActivation(env = process.env, contractTest = false) {
  if (!contractTest && env.BAREEQ_CLOUD_TTS_ACTIVATE !== '1') {
    throw new Error('Google Cloud TTS is prepared but not activated. Set BAREEQ_CLOUD_TTS_ACTIVATE=1 only after CNTXT billing is linked, the API is enabled, IAM is verified, and the paid smoke test is approved. No Cloud TTS request was sent.');
  }
}

export function hasCloudTtsCredentials(env = process.env) {
  return Boolean(
    env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim()
    || env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()
    || env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  );
}

async function readServiceAccount(env) {
  const inline = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!inline && !file) return null;
  let parsed;
  try {
    parsed = JSON.parse(inline || await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Google service-account credentials are not valid JSON: ${error.message}`);
  }
  const clientEmail = String(parsed?.client_email || '').trim();
  const privateKey = normalizePrivateKey(parsed?.private_key);
  const tokenUri = String(parsed?.token_uri || 'https://oauth2.googleapis.com/token').trim();
  if (!clientEmail || !privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('Google service-account credentials must include client_email and a PKCS#8 private_key.');
  }
  const tokenUrl = new URL(tokenUri);
  if (tokenUrl.protocol !== 'https:' || !OFFICIAL_TOKEN_HOSTS.has(tokenUrl.hostname)) {
    throw new Error('Google service-account token_uri must be an official HTTPS Google OAuth endpoint.');
  }
  return { clientEmail, privateKey, tokenUri: tokenUrl.toString() };
}

export function createServiceAccountAssertion(serviceAccount, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    sub: serviceAccount.clientEmail,
    aud: serviceAccount.tokenUri,
    scope: CLOUD_PLATFORM_SCOPE,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(serviceAccount.privateKey).toString('base64url')}`;
}

export async function getCloudTtsAccessToken(env = process.env, fetchImpl = fetch) {
  const direct = env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim();
  if (direct) return direct;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 120_000) return cachedToken.value;

  const serviceAccount = await readServiceAccount(env);
  if (!serviceAccount) {
    throw new Error('Google Cloud TTS authentication is missing. Provide GOOGLE_SERVICE_ACCOUNT_JSON (recommended for Cloudflare) or GOOGLE_APPLICATION_CREDENTIALS.');
  }
  const assertion = createServiceAccountAssertion(serviceAccount);
  const response = await fetchImpl(serviceAccount.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  let payload;
  try { payload = await response.json(); }
  catch { payload = null; }
  if (!response.ok || typeof payload?.access_token !== 'string') {
    const detail = String(payload?.error_description || payload?.error || `HTTP ${response.status}`).slice(0, 300);
    throw new Error(`Google OAuth token exchange failed: ${detail}`);
  }
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(300, Number(payload.expires_in || 3600)) * 1000,
  };
  return cachedToken.value;
}

export function buildCloudTtsRequest({
  env = process.env,
  contractTest = false,
  accessToken,
  projectId,
  text,
  prompt = CLOUD_TTS_STYLE,
  userAgent = 'Bareeq-Audio-Builder',
}) {
  const resolvedProject = String(projectId || '').trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(resolvedProject)) {
    throw new Error('GOOGLE_CLOUD_PROJECT must be a valid Google Cloud project ID.');
  }
  if (!String(accessToken || '').trim()) throw new Error('A Google Cloud OAuth access token is required.');
  const textBytes = byteLength(text);
  const promptBytes = byteLength(prompt);
  if (!textBytes || textBytes > 4000) throw new Error(`Cloud TTS text must be between 1 and 4000 UTF-8 bytes; received ${textBytes}.`);
  if (!promptBytes || promptBytes > 4000) throw new Error(`Cloud TTS prompt must be between 1 and 4000 UTF-8 bytes; received ${promptBytes}.`);
  if (textBytes + promptBytes > 8000) throw new Error(`Cloud TTS text + prompt exceed the 8000-byte limit (${textBytes + promptBytes}).`);

  return {
    url: `${cloudTtsEndpoint(env, contractTest)}/v1/text:synthesize`,
    options: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-goog-user-project': resolvedProject,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        'User-Agent': userAgent,
      },
      body: JSON.stringify({
        input: { prompt, text },
        voice: {
          languageCode: CLOUD_TTS_LANGUAGE,
          name: CLOUD_TTS_VOICE,
          modelName: CLOUD_TTS_MODEL,
        },
        audioConfig: {
          audioEncoding: CLOUD_TTS_AUDIO_ENCODING,
          sampleRateHertz: 24000,
        },
      }),
    },
  };
}

export function extractCloudTtsMp3(payload) {
  const encoded = typeof payload?.audioContent === 'string' ? payload.audioContent.replace(/\s+/g, '') : '';
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Google Cloud TTS response has no valid base64 audioContent.');
  }
  const audio = Buffer.from(encoded, 'base64');
  const mp3Header = audio.subarray(0, 3).toString('ascii') === 'ID3'
    || (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
  if (audio.length < 100 || !mp3Header) {
    throw new Error(`Google Cloud TTS returned invalid MP3 data (${audio.length} bytes).`);
  }
  return audio;
}
