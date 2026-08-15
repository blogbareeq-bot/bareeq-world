import { readFile } from 'node:fs/promises';

const component = await readFile('src/components/ReadingModes.astro', 'utf8');
const page = await readFile('src/pages/posts/[id].astro', 'utf8');
const client = await readFile('public/scripts/article.js', 'utf8');
const styles = await readFile('src/styles/global.css', 'utf8');
const home = await readFile('src/pages/index.astro', 'utf8');
const headers = await readFile('public/_headers', 'utf8');

const requireAll = (name, text, needles) => {
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${name} is missing tablet safeguard: ${needle}`);
};

requireAll('ReadingModes.astro', component, [
  'data-audio-manifest-inline', 'preload="none"', 'playsinline', 'data-audio-native-fallback', 'data-audio-seek'
]);
requireAll('[id].astro', page, [
  "readFile(manifestPath, 'utf8')", 'audioManifestData={audioManifestData}'
]);
requireAll('article.js', client, [
  'MANIFEST_TIMEOUT_MS = 9000', 'PLAY_START_TIMEOUT_MS = 18000', 'readInlineManifest', 'fetchManifestAttempt',
  'AbortController', 'awaitingPlaybackStart', 'requestPlay({ automatic: false })', 'nativeFallbackButton', "audio.controls = true",
  "audio.preload = 'metadata'", 'Do not call load() here', "audio?.addEventListener('playing'"
]);
if (client.includes('audio.load()')) throw new Error('Tablet path must not call audio.load() before first user-initiated play.');
requireAll('global.css', styles, [
  '@media (min-width:681px) and (max-width:1180px)', '.audio-status{grid-column:1/-1;grid-row:2',
  '.reading-modes.use-native-audio .reading-modes__panel audio', '.ticker-toggle{min-width:44px;min-height:44px',
  '13%,var(--surface))'
]);
requireAll('home page', home, [
  'const featured = posts[0];', 'جديد بريق'
]);
if (home.includes('posts.find((post) => post.data.featured)')) throw new Error('Home hero still prefers a pinned/featured post instead of the newest article.');
requireAll('_headers', headers, ['https://static.cloudflareinsights.com', 'https://cloudflareinsights.com']);

console.log('Tablet audio/home freshness audit passed: inline manifest, gesture-safe HTMLAudio, native fallback, tablet layout, strong tracking highlight, latest-article hero, and Cloudflare beacon CSP.');
