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
  'data-audio-manifest={audioManifest}', 'data-article-audio', 'preload="metadata"', 'data-audio-play', 'data-audio-stop', 'disabled',
  'Azure AI Speech', 'تتبّع الفقرة'
]);
requireAll('[id].astro', page, [
  "createHash('sha256')", "slice(0, 16)", 'audioManifest={audioManifest}'
]);
requireAll('article.js', client, [
  'fetch(manifestUrl', 'prepareAudio()', 'audio.src = manifest.parts[index].src', 'audio.load()',
  "playButton?.addEventListener('click'", 'void playCurrent()', "audio?.addEventListener('ended'", 'audio.playbackRate',
  'actual audio.play() call directly inside a user gesture on mobile Safari/Chrome', 'stopAudio', 'buildSyncTargets', 'syncTextToAudio',
  'smartScrollTo', 'userNavigatingUntil'
]);
if (client.includes('speechSynthesis') || client.includes('SpeechSynthesisUtterance')) {
  throw new Error('Browser speech synthesis must not be used as the primary/fallback reader in v4.8.0.');
}
requireAll('generate-audio.mjs', generator, [
  'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'AZURE_SPEECH_ENDPOINT', "LANGUAGE = 'ar-SA'", 'ar-SA-HamedNeural',
  'Ocp-Apim-Subscription-Key', "'X-Microsoft-OutputFormat': OUTPUT_FORMAT", 'audio-48khz-96kbitrate-mono-mp3',
  'MAX_REQUEST_BYTES = 6000', "AZURE_SPEECH_MIN_INTERVAL_MS || '3200'", 'MAX_FETCH_RETRIES', 'UND_ERR_SOCKET', 'requestBinary(',
  'speech-overrides.json', 'sync: audioPart.sync', "syncMethod: 'paragraph-weighted'"
]);
requireAll('global.css', styles, ['.audio-play{min-height:44px', '.audio-stop{min-height:44px', '.audio-speed select{min-height:44px']);
if (!pkg.scripts?.build?.includes('npm run generate:audio') || !pkg.scripts?.build?.includes('check-audio-sync.mjs')) {
  throw new Error('Build does not generate/validate synchronized Azure audio.');
}
console.log('Azure AI Speech + synchronized mobile HTMLAudio audit passed.');
