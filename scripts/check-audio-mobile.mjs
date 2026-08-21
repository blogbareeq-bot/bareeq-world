import { readFile } from 'node:fs/promises';

const component = await readFile('src/components/ReadingModes.astro', 'utf8');
const page = await readFile('src/pages/posts/[id].astro', 'utf8');
const client = await readFile('public/scripts/article.js', 'utf8');
const generator = await readFile('scripts/generate-audio.mjs', 'utf8');
const styles = await readFile('src/styles/global.css', 'utf8');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

const requireAll = (name, text, needles) => {
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${name} is missing mobile-audio safeguard: ${needle}`);
};

requireAll('ReadingModes.astro', component, [
  'data-audio-manifest={audioManifest}', 'data-article-audio', 'preload="none"', 'playsinline', 'data-audio-play', 'data-audio-stop', 'data-audio-native-fallback', 'data-audio-voice', 'data-audio-seek', 'disabled',
  'الصوت مولّد بالذكاء الاصطناعي', 'تتبّع الفقرة', 'حفظ موضعك'
]);
requireAll('[id].astro', page, [
  "createHash('sha256')", "slice(0, 16)", "import { access } from 'node:fs/promises'", 'hasAudio={hasAudio}', 'audioManifest={audioManifest}', '/scripts/audio-core.js'
]);
requireAll('article.js', client, [
  'fetch(manifestUrl', 'prepareAudio()', 'applyManifest', 'audio.src = asset.src', 'partAsset',
  "playButton?.addEventListener('click'", "audio?.addEventListener('ended'", 'audio.playbackRate',
  'This call is intentionally synchronous inside the click handler on first play.', 'requestPlay', 'stopAudio', 'buildSyncTargets', 'syncTextToAudio',
  'smartScrollTo', 'forceScroll', 'ratioOverride', 'userNavigatingUntil', 'switchVoice', 'bareeq-audio-voice-v1', 'bareeq-audio-progress-v1', 'saveProgress', "seekInput?.addEventListener('change'"
]);
if (component.includes('data-audio-manifest-inline') || component.includes('data-audio-current-voice') || client.includes('readInlineManifest')) throw new Error('Initial article HTML still exposes eager audio provider/voice metadata.');
if (client.includes('speechSynthesis') || client.includes('SpeechSynthesisUtterance')) {
  throw new Error('Browser speech synthesis must not be used as the primary/fallback reader in v4.9.0.');
}
requireAll('generate-audio.mjs', generator, [
  'GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/interactions', 'gemini-3.1-flash-tts-preview', 'google-cloud', 'Google Cloud Text-to-Speech',
  "providerVoice: 'Sadaltager'", "'x-goog-api-key': apiKey", "response_format: { type: 'audio' }", 'GEMINI_STYLE', 'encodeGeminiPcmToMp3',
  'BAREEQ_TTS_PROVIDER', 'OPENAI_API_KEY', 'https://api.openai.com/v1/audio/speech', 'gpt-4o-mini-tts-2025-12-15',
  "providerVoice: 'cedar'", "providerVoice: 'marin'", 'Authorization: `Bearer ${apiKey}`', "response_format: 'mp3'", 'OPENAI_STYLE', 'studio-audio-map.json', 'studio-block-timestamps',
  'AZURE_SPEECH_KEY', 'ar-SA-HamedNeural', 'ar-SA-ZariyahNeural', 'Ocp-Apim-Subscription-Key',
  'MAX_REQUEST_BYTES = PROVIDER', 'MAX_FETCH_RETRIES', 'UND_ERR_SOCKET', 'requestBinary(', 'mp3DurationSeconds',
  'speech-overrides.json', 'sync: audioPart.sync', "syncMethod: 'paragraph-weighted'", "version: 3"
]);
requireAll('global.css', styles, ['.audio-play{min-height:44px', '.audio-stop{min-height:44px', '.audio-voice select,.audio-speed select{min-height:44px']);

const build = pkg.scripts?.build || '';
const syncValidationPresent = build.includes('node scripts/check-audio-sync.mjs');
const legacyAudioPipeline =
  build.includes('node scripts/import-studio-audio.mjs') &&
  build.includes('node scripts/generate-audio.mjs');
const v4200OrchestratedPipeline = build.includes('node scripts/run-v4200-audio.mjs');
const v4210OrchestratedPipeline = build.includes('node scripts/run-v4210-audio.mjs');

if (!syncValidationPresent || (!legacyAudioPipeline && !v4200OrchestratedPipeline && !v4210OrchestratedPipeline)) {
  throw new Error('Build does not import/generate/validate synchronized production audio.');
}

if (v4200OrchestratedPipeline) {
  const orchestrator = await readFile('scripts/run-v4200-audio.mjs', 'utf8');
  requireAll('run-v4200-audio.mjs', orchestrator, [
    "const OLD_CHANGED = [",
    "const NEW_ARTICLE = 'ai-as-coworker-future-of-human-work'",
    "const EXISTING_SADALTAGER = 'ai-agents-future-now'",
    "runStrict('scripts/import-bundled-azure-audio.mjs'",
    "runStrict('scripts/import-studio-audio.mjs'",
    "runStrict('scripts/generate-audio.mjs'",
    "BAREEQ_TTS_CACHE_ONLY: '1'",
    "BAREEQ_TTS_PROVIDER: 'gemini'",
    "BAREEQ_TTS_PROVIDER: 'azure'",
    "BAREEQ_AZURE_HAMED_ONLY: '1'",
    'hasCompleteVoice(NEW_ARTICLE',
    'Coworker article audio ready with Gemini Sadaltager; Azure fallback was not called.',
    'Falling back to Azure Hamed for this article only.',
    'old audio is cache-only; coworker uses cache → Gemini Sadaltager → Azure Hamed fallback.'
  ]);
}

if (v4210OrchestratedPipeline) {
  const orchestrator = await readFile('scripts/run-v4210-audio.mjs', 'utf8');
  requireAll('run-v4210-audio.mjs', orchestrator, [
    "process.env.BAREEQ_CLOUD_TTS_ACTIVATE !== '1'",
    "runStrict('scripts/run-v4200-audio.mjs')",
    "BAREEQ_TTS_CACHE_ONLY: '1'",
    "BAREEQ_TTS_PROVIDER: 'gemini'",
    "BAREEQ_TTS_PROVIDER: 'google-cloud'",
    'PENDING_CLOUD.join',
    'V4.21.0 safety stop',
  ]);
}

console.log(v4210OrchestratedPipeline
  ? 'V4.21 synchronized mobile/tablet HTMLAudio audit passed: lazy manifest, direct seek-to-text, inactive Cloud TTS gate, 11 pending + 2 retained boundary recognized.'
  : v4200OrchestratedPipeline
    ? 'V4.20 synchronized mobile/tablet HTMLAudio audit passed: orchestrated cache-only old audio + coworker Gemini→Azure fallback recognized.'
    : 'Gemini Sadaltager + Studio Cedar/Hamed rollback + optional OpenAI/Azure + synchronized mobile/tablet HTMLAudio audit passed.');
