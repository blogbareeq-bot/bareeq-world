import assert from 'node:assert/strict';
import { parseEnv, resolveCandidate } from './env.mjs';
import { estimateCandidateCost, listProviderVoices, providerReadiness, synthesizeCandidate } from './providers.mjs';

function response(body, init = {}) {
  return new Response(body, { status: 200, headers: init.headers || {} });
}

const parsed = parseEnv('A=one\nB="two words"\n# comment\nexport C=three # note\n');
assert.deepEqual(parsed, { A: 'one', B: 'two words', C: 'three' });
assert.equal(resolveCandidate({ voiceEnv: 'VOICE', voiceDefault: 'fallback' }, { VOICE: 'chosen' }).voice, 'chosen');

const openAiCalls = [];
const openAiResult = await synthesizeCandidate({
  candidate: { provider: 'openai', model: 'gpt-4o-mini-tts-2025-12-15', voice: 'cedar', options: { speed: 1 } },
  text: 'نص عربي للاختبار',
  style: 'نبرة هادئة',
  env: { OPENAI_API_KEY: 'test-openai-key' },
  fetchImpl: async (url, options) => { openAiCalls.push({ url, options }); return response('RIFF-fake-wav', { headers: { 'content-type': 'audio/wav' } }); },
});
assert.equal(openAiCalls[0].url, 'https://api.openai.com/v1/audio/speech');
assert.equal(openAiCalls[0].options.headers.Authorization, 'Bearer test-openai-key');
assert.deepEqual(JSON.parse(openAiCalls[0].options.body), {
  model: 'gpt-4o-mini-tts-2025-12-15', voice: 'cedar', input: 'نص عربي للاختبار', instructions: 'نبرة هادئة', response_format: 'wav', speed: 1,
});
assert.equal(openAiResult.extension, 'wav');

const elevenCalls = [];
await synthesizeCandidate({
  candidate: { provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice: 'voice/id', options: {} },
  text: 'نص عربي للاختبار',
  env: { ELEVENLABS_API_KEY: 'test-eleven-key' },
  fetchImpl: async (url, options) => { elevenCalls.push({ url, options }); return response('ID3-fake-mp3', { headers: { 'content-type': 'audio/mpeg' } }); },
});
assert.match(elevenCalls[0].url, /voice%2Fid\?output_format=mp3_44100_128$/);
assert.equal(elevenCalls[0].options.headers['xi-api-key'], 'test-eleven-key');
assert.equal(JSON.parse(elevenCalls[0].options.body).model_id, 'eleven_multilingual_v2');
assert.equal(JSON.parse(elevenCalls[0].options.body).language_code, undefined);

const googleCalls = [];
await synthesizeCandidate({
  candidate: { provider: 'google', model: 'gemini-2.5-flash-tts', voice: 'Charon', language: 'ar-001', options: { region: 'global' } },
  text: 'نص عربي للاختبار',
  style: 'نبرة هادئة',
  env: { GOOGLE_CLOUD_ACCESS_TOKEN: 'test-google-token', GOOGLE_CLOUD_PROJECT: 'bareeq-test' },
  fetchImpl: async (url, options) => {
    googleCalls.push({ url, options });
    return response(JSON.stringify({ audioContent: Buffer.from('RIFF-google').toString('base64') }), { headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(googleCalls[0].url, 'https://texttospeech.googleapis.com/v1/text:synthesize');
assert.equal(googleCalls[0].options.headers['x-goog-user-project'], 'bareeq-test');
const googleBody = JSON.parse(googleCalls[0].options.body);
assert.equal(googleBody.voice.languageCode, 'ar-001');
assert.equal(googleBody.voice.modelName, 'gemini-2.5-flash-tts');
assert.equal(googleBody.audioConfig.audioEncoding, 'LINEAR16');

const munsitCalls = [];
await synthesizeCandidate({
  candidate: { provider: 'munsit', model: 'faseeh-v1-preview', voice: 'ar-najdi-male-2', options: { dialect: 'fusha' } },
  text: 'نص عربي للاختبار',
  env: { MUNSIT_API_KEY: 'test-munsit-key' },
  fetchImpl: async (url, options) => { munsitCalls.push({ url, options }); return response('RIFF-munsit', { headers: { 'content-type': 'audio/wav' } }); },
});
assert.equal(munsitCalls[0].options.headers['x-api-key'], 'test-munsit-key');
const munsitBody = JSON.parse(munsitCalls[0].options.body);
assert.equal(munsitBody.streaming, false);
assert.equal(munsitBody.sample_rate, 48000);
assert.equal(munsitBody.dialect, 'fusha');

assert.equal(providerReadiness({ provider: 'openai' }, {}).ready, false);
assert.equal(providerReadiness({ provider: 'openai' }, { OPENAI_API_KEY: 'x' }).ready, true);
assert.equal(providerReadiness({ provider: 'munsit', voice: 'x' }, { MUNSIT_API_KEY: 'x' }).ready, false);
assert.equal(providerReadiness({ provider: 'munsit', voice: 'x' }, { MUNSIT_API_KEY: 'x', MUNSIT_COST_PER_1000_CHARS_USD: '0.05' }).ready, true);
assert.equal(estimateCandidateCost({ provider: 'elevenlabs' }, 1000).usd, 0.1);
assert.ok(estimateCandidateCost({ provider: 'google' }, 1000).usd > 0);
assert.equal(estimateCandidateCost({ provider: 'munsit' }, 1000, {}, {}).usd, null);

assert.ok((await listProviderVoices({ provider: 'openai' })).some((voice) => voice.voiceId === 'cedar'));
assert.ok((await listProviderVoices({ provider: 'google' })).some((voice) => voice.voiceId === 'Charon'));
const listedMunsit = await listProviderVoices({
  provider: 'munsit',
  env: { MUNSIT_API_KEY: 'test-munsit-key' },
  fetchImpl: async () => response(JSON.stringify([{ voice_id: 'ar-fusha-1', name: 'Fusha', languages: ['ar'], dialect: ['fusha'] }]), { headers: { 'content-type': 'application/json' } }),
});
assert.equal(listedMunsit[0].voiceId, 'ar-fusha-1');

const serialized = JSON.stringify({ openAiCalls, elevenCalls, googleCalls, munsitCalls });
for (const secret of ['test-openai-key', 'test-eleven-key', 'test-google-token', 'test-munsit-key']) {
  assert.ok(serialized.includes(secret), 'The mock must prove a secret reached only the intended request header.');
}

console.log('Voice provider contract audit passed: OpenAI, ElevenLabs, Google Gemini-TTS, Munsit, environment parsing, readiness, and cost guards.');
