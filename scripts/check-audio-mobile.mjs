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
  'data-audio-manifest={audioManifest}', 'data-audio-manifest-inline', 'data-article-audio', 'preload="none"', 'playsinline', 'data-audio-play', 'data-audio-stop', 'data-audio-native-fallback', 'data-audio-voice', 'data-audio-seek', 'disabled',
  'الصوت مولّد بالذكاء الاصطناعي', 'تتبّع الفقرة', 'حفظ موضعك'
]);
requireAll('[id].astro', page, [
  "createHash('sha256')", "slice(0, 16)", 'audioManifest={audioManifest}', '/scripts/audio-core.js'
]);
requireAll('article.js', client, [
  'fetch(manifestUrl', 'prepareAudio()', 'readInlineManifest', 'applyManifest', 'audio.src = asset.src', 'partAsset',
  "playButton?.addEventListener('click'", "audio?.addEventListener('ended'", 'audio.playbackRate',
  'This call is intentionally synchronous inside the click handler on first play.', 'requestPlay', 'stopAudio', 'buildSyncTargets', 'syncTextToAudio',
  'smartScrollTo', 'userNavigatingUntil', 'switchVoice', 'bareeq-audio-voice-v1', 'bareeq-audio-progress-v1', 'saveProgress', "seekInput?.addEventListener('change'"
]);
if (client.includes('speechSynthesis') || client.includes('SpeechSynthesisUtterance')) {
  throw new Error('Browser speech synthesis must not be used as the primary/fallback reader in v4.9.0.');
}
requireAll('generate-audio.mjs', generator, [
  'BAREEQ_TTS_PROVIDER', 'OPENAI_API_KEY', 'https://api.openai.com/v1/audio/speech', 'gpt-4o-mini-tts-2025-12-15',
  "providerVoice: 'cedar'", "providerVoice: 'marin'", 'Authorization: `Bearer ${apiKey}`', "response_format: 'mp3'", 'OPENAI_STYLE', 'studio-audio-map.json', 'studio-block-timestamps',
  'AZURE_SPEECH_KEY', 'ar-SA-HamedNeural', 'ar-SA-ZariyahNeural', 'Ocp-Apim-Subscription-Key',
  'MAX_REQUEST_BYTES = PROVIDER', 'MAX_FETCH_RETRIES', 'UND_ERR_SOCKET', 'requestBinary(', 'mp3DurationSeconds',
  'speech-overrides.json', 'sync: audioPart.sync', "syncMethod: 'paragraph-weighted'", "version: 3"
]);
requireAll('global.css', styles, ['.audio-play{min-height:44px', '.audio-stop{min-height:44px', '.audio-voice select,.audio-speed select{min-height:44px']);
if (!pkg.scripts?.build?.includes('node scripts/import-studio-audio.mjs') || !pkg.scripts?.build?.includes('node scripts/generate-audio.mjs') || !pkg.scripts?.build?.includes('check-audio-sync.mjs')) {
  throw new Error('Build does not import/generate/validate synchronized production audio.');
}
console.log('Studio Cedar + optional OpenAI Cedar/Marin + Azure rollback + synchronized mobile/tablet HTMLAudio audit passed.');
