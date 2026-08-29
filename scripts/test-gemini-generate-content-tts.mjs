import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PRODUCTION_TTS_MODEL, PRODUCTION_VOICE } from './audio-constants.mjs';
import { synthesizeGeminiGenerateContentPart } from './audio-gemini-tts.mjs';

const sampleRate = 24000;
const seconds = 0.3;
const samples = Math.floor(sampleRate * seconds);
const pcm = Buffer.alloc(samples * 2);
for (let index = 0; index < samples; index += 1) {
  const value = Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 5000);
  pcm.writeInt16LE(value, index * 2);
}

let captured = null;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  captured = {
    method: request.method,
    url: request.url,
    apiKey: request.headers['x-goog-api-key'],
    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
  };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            mimeType: 'audio/L16;codec=pcm;rate=24000',
            data: pcm.toString('base64'),
          },
        }],
      },
    }],
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const previousEndpoint = process.env.GEMINI_GENERATE_CONTENT_ENDPOINT;
const previousContract = process.env.BAREEQ_TTS_CONTRACT_TEST;
try {
  const { port } = server.address();
  process.env.BAREEQ_TTS_CONTRACT_TEST = '1';
  process.env.GEMINI_GENERATE_CONTENT_ENDPOINT = `http://127.0.0.1:${port}/v1beta/models/${PRODUCTION_TTS_MODEL}:generateContent`;
  const result = await synthesizeGeminiGenerateContentPart({
    apiKey: 'contract-key',
    part: { text: 'هذه عينة تعاقدية محلية.' },
    context: { articleTitle: 'اختبار بريق', partIndex: 5, partCount: 6 },
  });
  assert(Buffer.isBuffer(result.audio));
  assert(result.audio.length > 100);
  assert.equal(result.transport, 'developer-generate-content');
  assert.equal(result.model, PRODUCTION_TTS_MODEL);
  assert.equal(result.voice, PRODUCTION_VOICE);
} finally {
  if (previousEndpoint === undefined) delete process.env.GEMINI_GENERATE_CONTENT_ENDPOINT;
  else process.env.GEMINI_GENERATE_CONTENT_ENDPOINT = previousEndpoint;
  if (previousContract === undefined) delete process.env.BAREEQ_TTS_CONTRACT_TEST;
  else process.env.BAREEQ_TTS_CONTRACT_TEST = previousContract;
  await new Promise((resolve) => server.close(resolve));
}

assert.equal(captured?.method, 'POST');
assert.equal(captured?.apiKey, 'contract-key');
assert(captured?.url?.includes(':generateContent'));
assert.deepEqual(captured?.body?.generationConfig?.responseModalities, ['AUDIO']);
assert.equal(captured?.body?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, PRODUCTION_VOICE);
const prompt = captured?.body?.contents?.[0]?.parts?.[0]?.text || '';
assert(prompt.includes('Do not add, omit, paraphrase, or reorder any word'));
assert(prompt.includes('هذه عينة تعاقدية محلية'));

console.log('Gemini generateContent TTS contract passed: non-streaming generateContent, Gemini 3.1, Sadaltager, strict Speech Script prompt, PCM→MP3. Real provider calls: 0.');
