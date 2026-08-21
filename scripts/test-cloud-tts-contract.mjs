import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import {
  CLOUD_TTS_LANGUAGE,
  CLOUD_TTS_MODEL,
  CLOUD_TTS_STYLE,
  CLOUD_TTS_VOICE,
  assertCloudTtsActivation,
  buildCloudTtsRequest,
  createServiceAccountAssertion,
  extractCloudTtsMp3,
} from './cloud-tts.mjs';

const failures = [];
const expectThrow = (label, fn, pattern) => {
  try { fn(); failures.push(`${label}: expected an error`); }
  catch (error) { if (!pattern.test(error.message)) failures.push(`${label}: unexpected error ${error.message}`); }
};

expectThrow('inactive live guard', () => assertCloudTtsActivation({}, false), /prepared but not activated/);
assertCloudTtsActivation({}, true);

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const assertion = createServiceAccountAssertion({
  clientEmail: 'bareeq-tts@example.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  tokenUri: 'https://oauth2.googleapis.com/token',
}, 1_800_000_000);
const jwtParts = assertion.split('.');
if (jwtParts.length !== 3) failures.push('service-account assertion is not a three-part JWT');
else {
  const claim = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8'));
  if (claim.aud !== 'https://oauth2.googleapis.com/token' || claim.scope !== 'https://www.googleapis.com/auth/cloud-platform' || claim.exp - claim.iat !== 3600) failures.push('service-account assertion claims are incorrect');
}

let captured = null;
const fixtureMp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(253, 7)]);
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  captured = {
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    project: request.headers['x-goog-user-project'],
    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
  };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ audioContent: fixtureMp3.toString('base64') }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  const env = { GOOGLE_CLOUD_TTS_ENDPOINT: `http://127.0.0.1:${address.port}` };
  const { url, options } = buildCloudTtsRequest({
    env,
    contractTest: true,
    accessToken: 'contract-token',
    projectId: 'bareeq-tts',
    text: 'هذا اختبار تعاقدي محلي لا يرسل أي طلب مدفوع.',
    prompt: CLOUD_TTS_STYLE,
    userAgent: 'Bareeq-Cloud-TTS-Contract/4.21.0',
  });
  const response = await fetch(url, options);
  const audio = extractCloudTtsMp3(await response.json());
  if (!audio.equals(fixtureMp3)) failures.push('Cloud TTS audioContent did not round-trip as MP3 bytes');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (captured?.method !== 'POST' || captured?.url !== '/v1/text:synthesize') failures.push('Cloud TTS request method/path is incorrect');
if (captured?.authorization !== 'Bearer contract-token' || captured?.project !== 'bareeq-tts') failures.push('Cloud TTS auth/quota-project headers are incorrect');
if (captured?.body?.voice?.modelName !== CLOUD_TTS_MODEL || captured?.body?.voice?.name !== CLOUD_TTS_VOICE || captured?.body?.voice?.languageCode !== CLOUD_TTS_LANGUAGE) failures.push('Cloud TTS model, voice, or Arabic locale is incorrect');
if (captured?.body?.audioConfig?.audioEncoding !== 'MP3' || captured?.body?.audioConfig?.sampleRateHertz !== 24000) failures.push('Cloud TTS MP3/24kHz output configuration is incorrect');
if (captured?.body?.input?.prompt !== CLOUD_TTS_STYLE || !captured?.body?.input?.text) failures.push('Cloud TTS prompt/text fields are incorrect');

expectThrow('text byte limit', () => buildCloudTtsRequest({
  env: { GOOGLE_CLOUD_TTS_ENDPOINT: 'http://127.0.0.1:9' },
  contractTest: true,
  accessToken: 'contract-token',
  projectId: 'bareeq-tts',
  text: 'ا'.repeat(2100),
}), /4000 UTF-8 bytes/);

if (failures.length) {
  console.error(`Google Cloud TTS contract test found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Google Cloud TTS offline contract passed: activation guard, service-account JWT, REST headers/schema, Gemini 2.5 Flash TTS + Sadaltager + ar-EG, direct MP3, and UTF-8 byte limits. Paid requests: 0.');
