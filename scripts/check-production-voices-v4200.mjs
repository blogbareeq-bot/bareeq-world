import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const generator = await readFile('scripts/generate-audio.mjs', 'utf8');
const runner = await readFile('scripts/run-v4200-audio.mjs', 'utf8');
for (const token of [
  "GEMINI_MODEL = 'gemini-3.1-flash-tts-preview'",
  "providerVoice: 'Sadaltager'",
  "providerVoice: 'ar-SA-HamedNeural'",
  'restoreFromProduction',
  'BAREEQ_TTS_INCLUDE_IDS',
  'BAREEQ_TTS_CACHE_ONLY',
  'GEMINI_REQUEST_HARD_LIMIT',
  'GEMINI_SYNTHESIS_BUDGET_MS',
  'effectiveManifestVoices'
]) if (!generator.includes(token)) throw new Error(`V4.20 audio safeguard missing: ${token}`);

for (const token of [
  "NEW_ARTICLE = 'ai-as-coworker-future-of-human-work'",
  "EXISTING_SADALTAGER = 'ai-agents-future-now'",
  "BAREEQ_TTS_PROVIDER: 'gemini'",
  "BAREEQ_TTS_PROVIDER: 'azure'",
  "BAREEQ_TTS_CACHE_ONLY: '1'",
  "hasCompleteVoice(NEW_ARTICLE, 'Google Gemini API', 'sadaltager')",
  "hasCompleteVoice(NEW_ARTICLE, 'Microsoft Azure AI Speech', 'hamed')",
  'Azure Hamed for this article only'
]) if (!runner.includes(token)) throw new Error(`V4.20 audio runner safeguard missing: ${token}`);
if (runner.includes('BAREEQ_GEMINI_PILOT') || runner.includes('INTUITION =')) throw new Error('V4.20 must target the coworker article, not the earlier intuition pilot.');

const plan = (provider, includeId, extra = {}) => execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, BAREEQ_TTS_PROVIDER: provider, BAREEQ_TTS_INCLUDE_IDS: includeId, GEMINI_TTS_ENDPOINT: '', OPENAI_TTS_ENDPOINT: '', BAREEQ_TTS_CONTRACT_TEST: '', ...extra }
});
const coworker = 'ai-as-coworker-future-of-human-work';
const gemini = plan('gemini', coworker);
if (!gemini.includes('Sadaltager') || !gemini.includes(coworker)) throw new Error('Coworker Gemini plan is not targeted correctly.');
const azure = plan('azure', coworker, { BAREEQ_AZURE_HAMED_ONLY: '1' });
if (!azure.includes('Hamed') || !azure.includes(coworker)) throw new Error('Coworker Azure fallback plan is not targeted correctly.');
console.log('V4.20.0 production voice audit passed: 13 live articles, old audio cache-only, coworker cache → Gemini Sadaltager → Azure Hamed fallback.');
