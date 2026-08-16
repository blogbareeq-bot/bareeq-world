import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const [generator, studioImporter, bundledImporter, studioMapping, bundledMapping, component, client, styles, envExample] = await Promise.all([
  readFile('scripts/generate-audio.mjs', 'utf8'),
  readFile('scripts/import-studio-audio.mjs', 'utf8'),
  readFile('scripts/import-bundled-azure-audio.mjs', 'utf8'),
  readFile('scripts/studio-audio-map.json', 'utf8'),
  readFile('scripts/bundled-azure-audio-map.json', 'utf8'),
  readFile('src/components/ReadingModes.astro', 'utf8'),
  readFile('public/scripts/article.js', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
  readFile('.env.example', 'utf8'),
]);

const requireAll = (name, text, needles) => {
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${name} is missing production voice safeguard: ${needle}`);
};

requireAll('generate-audio.mjs', generator, [
  "|| 'bundled'", "['bundled', 'gemini', 'openai', 'azure']", 'https://generativelanguage.googleapis.com/v1beta/interactions',
  "GEMINI_MODEL = 'gemini-3.1-flash-tts-preview'", "providerVoice: 'Sadaltager'", 'GEMINI_STYLE',
  "response_format: { type: 'audio' }", "speech_config: [{ voice: voice.providerVoice }]", 'encodeGeminiPcmToMp3',
  "'-f', 's16le'", "'-ar', '24000'", "'-b:a', '96k'", 'Gemini TTS free-tier plan',
  'https://api.openai.com/v1/audio/speech',
  "OPENAI_MODEL = 'gpt-4o-mini-tts-2025-12-15'", "providerVoice: 'cedar'", "providerVoice: 'marin'",
  "providerVoice: 'ar-SA-HamedNeural'", "providerVoice: 'ar-SA-ZariyahNeural'", 'OPENAI_STYLE',
  "response_format: 'mp3'", 'OpenAI TTS cost guard', 'OpenAI TTS safety stop', 'manifestAssets',
  'restoreFromProduction', 'mp3DurationSeconds', 'contractTest: true', 'version: 3',
  'importedManifestAssets', 'bundledManifestAssets', 'studio-audio-map.json', 'bundled-azure-audio-map.json',
  'studio-block-timestamps', 'paragraph-weighted-legacy', '0 synthesis requests and no API key required',
]);
requireAll('import-studio-audio.mjs', studioImporter, [
  "TARGET_VERSION = 'V4.16.0'", 'bareeq.audio.current.v1', 'bareeq.audio.v1', 'verifyMp3',
  'syncSourceSha256', 'studio-block-timestamps', 'ordinal:', 'copyFile', 'manifestSha256', 'textSha256',
  'previousReleases', 'await rename(finalDir, backupDir)', 'await rename(tempDir, finalDir)', 'no API calls',
]);
requireAll('import-bundled-azure-audio.mjs', bundledImporter, [
  'bareeq.bundled-azure.lock.v1', 'bareeq.bundled-azure.v1', 'sourceSnapshotSha256',
  'sourceManifestSha256', 'ar-SA-HamedNeural', 'paragraph-weighted-legacy', 'mp3DurationSeconds',
  'await rename(finalDir, backupDir)', 'await rename(tempDir, finalDir)', 'no network or synthesis API calls',
]);
for (const token of ['cultural-habits-world', 'b0001', 'b0021', 'syncSourceSha256']) if (!studioMapping.includes(token)) throw new Error(`studio-audio-map.json is missing ${token}`);
const bundled = JSON.parse(bundledMapping);
if (bundled.version !== 1 || bundled.schema !== 'bareeq.bundled-azure.lock.v1' || bundled.releaseId !== 'azure-hamed-live-20260815' || bundled.articles?.length !== 10) throw new Error('Bundled Azure lock must contain the ten approved Hamed recordings.');
if (bundled.articles.reduce((sum, article) => sum + article.parts.length, 0) !== 29) throw new Error('Bundled Azure lock must contain exactly 29 timed MP3 assets.');
for (const article of bundled.articles) {
  if (!/^[a-f0-9]{16}$/.test(article.audioKey || '') || !/^[a-f0-9]{64}$/.test(article.sourceSnapshotSha256 || '') || !/^[a-f0-9]{64}$/.test(article.sourceManifestSha256 || '')) throw new Error(`Invalid bundled lock metadata for ${article.articleId}.`);
  for (const part of article.parts) if (!/^[a-f0-9]{64}$/.test(part.sha256 || '') || !(part.bytes >= 100) || !(part.durationSeconds > 0)) throw new Error(`Invalid bundled MP3 lock for ${article.articleId}.`);
}
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
  'BAREEQ_TTS_PROVIDER=gemini', 'GEMINI_API_KEY=', 'GEMINI_TTS_MIN_INTERVAL_MS=6500', 'GEMINI_TTS_MAX_REQUEST_BYTES=2400',
  'BAREEQ_TTS_PROVIDER=bundled', 'OPENAI_API_KEY=', 'OPENAI_TTS_BUILD_WARNING_USD=8', 'OPENAI_TTS_BUILD_HARD_LIMIT_USD=12',
  'AZURE_SPEECH_KEY=', 'Hamed + Zariyah',
]);
if (client.includes('audio.load()')) throw new Error('Voice switching must preserve the tablet-safe no-audio.load() rule.');
if (component.includes('data-audio-part') || component.includes('المقطع 1 من')) throw new Error('The simplified player must not expose internal audio-part numbering.');
if (component.includes('صوتان للاختيار') || component.includes('صوتان مع')) throw new Error('The player must not promise two voices when production articles have one approved voice each.');

const plan = (provider) => execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, BAREEQ_TTS_PROVIDER: provider, GEMINI_TTS_ENDPOINT: '', OPENAI_TTS_ENDPOINT: '', BAREEQ_TTS_CONTRACT_TEST: '' },
});
const bundledPlan = plan('bundled');
for (const token of ['Bundled mixed audio plan: 11 articles', '0 synthesis request(s)', '0 billable character(s)', 'approved Bareeq Voice Studio release (Cedar)', 'approved bundled Azure Hamed release']) if (!bundledPlan.includes(token)) throw new Error(`Bundled production plan is missing ${token}`);
const geminiPlan = plan('gemini');
for (const token of ['Google Gemini API audio plan: 11 articles', '70 synthesis request(s)', 'Sadaltager', 'سادالتاجر']) if (!geminiPlan.includes(token)) throw new Error(`Gemini production plan is missing ${token}`);
const openAiPlan = plan('openai');
for (const token of ['OpenAI audio plan: 11 articles', '72 synthesis request(s)', 'approved Bareeq Voice Studio release (Cedar)', 'Cedar', 'Marin']) if (!openAiPlan.includes(token)) throw new Error(`OpenAI optional-upgrade plan is missing ${token}`);
const azurePlan = plan('azure');
for (const token of ['Microsoft Azure AI Speech audio plan: 11 articles', '60 synthesis request(s)', 'حامد', 'زارية']) if (!azurePlan.includes(token)) throw new Error(`Azure regeneration plan is missing ${token}`);

console.log('Production voice source audit passed: Gemini 3.1 Flash TTS + Sadaltager is configured for the V4.17 deployment, the locked Cedar/Hamed rollback remains intact, and seek + exact 30-day progress safeguards remain unchanged.');
