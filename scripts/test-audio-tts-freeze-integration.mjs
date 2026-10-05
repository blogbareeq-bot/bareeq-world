import assert from 'node:assert/strict';
import { synthesizeGeminiGenerateContentPart, synthesizeGeminiPart } from './audio-gemini-tts.mjs';
import { synthesizeOpenRouterPart } from './audio-openrouter-tts.mjs';
import { runPilot as runChirpPilot } from './audio-chirp3-pilot.mjs';

const part = { partIndex: 0, text: 'اختبار يمنع أي اتصال حقيقي بالمزوّد' };
const context = { articleTitle: 'Freeze integration test', partIndex: 0, partCount: 1 };

async function frozen(label, fn) {
  await assert.rejects(fn, (error) => {
    assert.equal(error?.code, 'BAREEQ_TTS_FROZEN', `${label}: expected BAREEQ_TTS_FROZEN`);
    return true;
  });
}

await frozen('Gemini Interactions', () => synthesizeGeminiPart({
  apiKey: 'must-never-be-sent',
  part,
  context,
}));

await frozen('Gemini generateContent', () => synthesizeGeminiGenerateContentPart({
  apiKey: 'must-never-be-sent',
  part,
  context,
}));

await frozen('OpenRouter speech', () => synthesizeOpenRouterPart({
  apiKey: 'must-never-be-sent',
  part,
}));

await frozen('Chirp live pilot', () => runChirpPilot({
  live: true,
  env: {
    BAREEQ_CHIRP_PILOT_ACTIVATE: '1',
    GOOGLE_CLOUD_PROJECT: 'must-never-be-used',
    GOOGLE_CLOUD_ACCESS_TOKEN: 'must-never-be-sent',
  },
}));

console.log('TTS freeze integration passed: Gemini Interactions, Gemini generateContent, OpenRouter speech, and Chirp live synthesis all fail closed before a provider request.');
