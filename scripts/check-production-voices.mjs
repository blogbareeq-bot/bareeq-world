import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const [generator, importer, mapping, component, client, styles, envExample] = await Promise.all([
  readFile('scripts/generate-audio.mjs', 'utf8'),
  readFile('scripts/import-studio-audio.mjs', 'utf8'),
  readFile('scripts/studio-audio-map.json', 'utf8'),
  readFile('src/components/ReadingModes.astro', 'utf8'),
  readFile('public/scripts/article.js', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
  readFile('.env.example', 'utf8'),
]);

const requireAll = (name, text, needles) => {
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${name} is missing production voice safeguard: ${needle}`);
};

requireAll('generate-audio.mjs', generator, [
  "PROVIDER = process.env.BAREEQ_TTS_PROVIDER", "|| 'openai'", 'https://api.openai.com/v1/audio/speech',
  "OPENAI_MODEL = 'gpt-4o-mini-tts-2025-12-15'", "providerVoice: 'cedar'", "providerVoice: 'marin'",
  "providerVoice: 'ar-SA-HamedNeural'", "providerVoice: 'ar-SA-ZariyahNeural'", 'OPENAI_STYLE',
  "response_format: 'mp3'", 'OpenAI TTS cost guard', 'OpenAI TTS safety stop', 'manifestAssets',
  'restoreFromProduction', 'mp3DurationSeconds', 'contractTest: true', "version: 3",
  'importedManifestAssets', 'studio-audio-map.json', 'studio-block-timestamps', 'BAREEQ_AUDIO_ALLOW_PARTIAL',
]);
requireAll('import-studio-audio.mjs', importer, [
  "TARGET_VERSION = 'V4.16.0'", 'bareeq.audio.current.v1', 'bareeq.audio.v1', 'verifyMp3',
  'syncSourceSha256', 'studio-block-timestamps', 'ordinal:', 'copyFile', 'manifestSha256', 'textSha256',
  'previousReleases', 'await rename(finalDir, backupDir)', 'await rename(tempDir, finalDir)', 'no API calls',
]);
for (const token of ['cultural-habits-world', 'b0001', 'b0021', 'syncSourceSha256']) if (!mapping.includes(token)) throw new Error(`studio-audio-map.json is missing ${token}`);
requireAll('ReadingModes.astro', component, [
  'data-audio-voice', 'data-audio-current-voice', 'data-audio-seek', 'استماع متزامن', 'الصوت مولّد بالذكاء الاصطناعي', 'موضع الاستماع',
]);
requireAll('article.js', client, [
  'setupVoicePicker', 'switchVoice', 'bareeq-audio-voice-v1', 'bareeq-audio-progress-v1', 'readSavedProgress',
  'saveProgress', 'totalVoiceDuration', 'elapsedArticleSeconds', 'audio.src = asset.src', 'Number.isInteger(entry.ordinal)',
  "seekInput?.addEventListener('change'", 'voiceField.hidden = voices.length < 2',
]);
requireAll('global.css', styles, ['.audio-voice', '.audio-seek', '.audio-voice select,.audio-speed select{min-height:44px', '@media(max-width:680px)']);
requireAll('.env.example', envExample, [
  'BAREEQ_TTS_PROVIDER=openai', 'OPENAI_API_KEY=', 'OPENAI_TTS_BUILD_WARNING_USD=8', 'OPENAI_TTS_BUILD_HARD_LIMIT_USD=12',
  'AZURE_SPEECH_KEY=', 'Hamed + Zariyah',
]);
if (client.includes('audio.load()')) throw new Error('Voice switching must preserve the tablet-safe no-audio.load() rule.');
if (component.includes('data-audio-part') || component.includes('المقطع 1 من')) throw new Error('The simplified player must not expose internal audio-part numbering.');
if (component.includes('صوتان للاختيار') || component.includes('صوتان مع')) throw new Error('The player must not promise two voices when an approved article has only Cedar.');

const plan = (provider) => execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
  env: { ...process.env, BAREEQ_TTS_PROVIDER: provider, OPENAI_TTS_ENDPOINT: '', BAREEQ_TTS_CONTRACT_TEST: '' },
});
const openAiPlan = plan('openai');
for (const token of ['OpenAI audio plan: 11 articles', '72 synthesis request(s)', 'approved Bareeq Voice Studio release (Cedar)', 'Cedar', 'Marin']) if (!openAiPlan.includes(token)) throw new Error(`OpenAI production plan is missing ${token}`);
const azurePlan = plan('azure');
for (const token of ['Microsoft Azure AI Speech audio plan: 11 articles', '60 synthesis request(s)', 'حامد', 'زارية']) if (!azurePlan.includes(token)) throw new Error(`Azure rollback plan is missing ${token}`);

console.log('Production voice source audit passed: verified Studio Cedar pilot, optional OpenAI Cedar/Marin generation, Azure Hamed/Zariyah rollback, seek, 30-day progress, exact duration metadata, disclosure, cache, and cost guards.');
