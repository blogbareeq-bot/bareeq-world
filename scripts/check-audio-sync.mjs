import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

const generator = await readFile('scripts/generate-audio.mjs', 'utf8');
const client = await readFile('public/scripts/article.js', 'utf8');
const component = await readFile('src/components/ReadingModes.astro', 'utf8');
const styles = await readFile('src/styles/global.css', 'utf8');
const overrides = JSON.parse(await readFile('scripts/speech-overrides.json', 'utf8'));

for (const needle of ['extractSpeechSegments', 'buildAudioParts', 'syncMethod: \'paragraph-weighted\'', 'speech-overrides.json', '<p>${body}', 'sync: audioPart.sync']) {
  if (!generator.includes(needle)) throw new Error(`Audio generator is missing synchronization safeguard: ${needle}`);
}
for (const needle of ['buildSyncTargets', 'Number.isInteger(entry.ordinal)', 'syncTextToAudio', 'is-audio-active', 'smartScrollTo', 'forceScroll', 'ratioOverride', 'data-audio-current', "audio?.addEventListener('timeupdate'", 'stopAudio', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'fetchManifestAttempt', 'nativeFallbackButton', 'PLAY_START_TIMEOUT_MS', 'switchVoice', 'saveProgress', "seekInput?.addEventListener('change',", "seekInput?.addEventListener('input',"]) {
  if (!client.includes(needle)) throw new Error(`Article client is missing synchronized-reading behavior: ${needle}`);
}
for (const needle of ['data-audio-stop', 'data-audio-voice', 'data-audio-seek', 'data-audio-time', 'تتبّع الفقرة', 'tabindex="-1"']) {
  if (!component.includes(needle)) throw new Error(`ReadingModes.astro is missing synchronized-reading UI: ${needle}`);
}
if (component.includes('data-audio-manifest-inline') || component.includes('data-audio-current-voice')) throw new Error('Audio provider/voice metadata must not be embedded in initial article HTML.');
for (const needle of ['[data-audio-sync-id].is-audio-active', '.audio-stop{min-height:44px', '.audio-voice select,.audio-speed select{min-height:44px']) {
  if (!styles.includes(needle)) throw new Error(`CSS is missing synchronized-reading/accessibility rule: ${needle}`);
}
if (!Array.isArray(overrides.global) || !overrides.global.length || typeof overrides.articles !== 'object') {
  throw new Error('speech-overrides.json must define global and per-article pronunciation corrections.');
}

const postFiles = (await readdir('src/content/posts')).filter((name) => name.endsWith('.md')).sort();
let expectedPublishedArticles = 0;
for (const name of postFiles) {
  const source = await readFile(`src/content/posts/${name}`, 'utf8');
  if (!/^draft:\s*true\s*$/mi.test(source)) expectedPublishedArticles += 1;
}
if (!expectedPublishedArticles) throw new Error('No published articles were found for synchronized-audio validation.');

const raw = execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--sync-plan'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
const plan = JSON.parse(raw);
if (!Array.isArray(plan) || plan.length !== expectedPublishedArticles) {
  throw new Error(`Expected ${expectedPublishedArticles} synchronized article plans from the published content set, received ${plan?.length ?? 'invalid'}.`);
}

let totalSegments = 0;
let totalParts = 0;
for (const post of plan) {
  if (!Array.isArray(post.segments) || !post.segments.length) throw new Error(`${post.id}: no synchronization segments.`);
  if (!Array.isArray(post.parts) || !post.parts.length) throw new Error(`${post.id}: no audio parts.`);
  const expected = new Set(post.segments.map((segment) => segment.id));
  const seen = new Set();
  for (const segment of post.segments) {
    if (!/^b\d{4}$/.test(segment.id) || !Number.isInteger(segment.matchLength) || segment.matchLength < 2) throw new Error(`${post.id}: invalid sync segment ${segment.id}.`);
  }
  for (const part of post.parts) {
    if (!Array.isArray(part.sync)) throw new Error(`${post.id}: an audio part has no sync array.`);
    let previousStart = -1;
    for (const entry of part.sync) {
      if (!expected.has(entry.id)) throw new Error(`${post.id}: sync entry references unknown ${entry.id}.`);
      if (!(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end)) throw new Error(`${post.id}: invalid sync ratio for ${entry.id}.`);
      if (entry.start < previousStart) throw new Error(`${post.id}: sync entries are not ordered.`);
      previousStart = entry.start;
      seen.add(entry.id);
    }
  }
  for (const id of expected) if (!seen.has(id)) throw new Error(`${post.id}: segment ${id} is never synchronized to audio.`);
  totalSegments += expected.size;
  totalParts += post.parts.length;
}
console.log(`Synchronized reading audit passed: ${plan.length} articles, ${totalParts} audio parts, ${totalSegments} tracked text blocks.`);
