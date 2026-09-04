import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const required = async (file, needles) => {
  const text = await readFile(file, 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) throw new Error(`${file} is missing: ${needle}`);
  }
  return text;
};

await required('src/components/ReadingModes.astro', [
  'اقرأ بالطريقة التي تناسبك', 'data-reading-mode="read"', 'data-reading-mode="listen"',
  'data-reading-mode="window"', 'سطور', 'صدى', 'نافذة', 'data-audio-play', 'data-audio-stop', 'data-audio-rate', 'data-audio-seek',
  'data-article-audio', 'data-audio-manifest={audioManifest}', 'tabindex="-1"'
]);
await required('src/pages/posts/[id].astro', [
  'import ReadingModes', 'import visualStories', '<ReadingModes', 'id="article-content"', 'data-article-content', 'audioManifest={audioManifest}', 'story={visualStory}'
]);
await required('src/components/VisualStory.astro', ['data-visual-story', 'data-visual-card', 'data-visual-share', 'data-visual-next', 'data-visual-prev']);
await required('public/scripts/visual-story.js', ['bareeq-visual-progress-v1', 'bareeq:visual-story', '#visual=', 'maxAge', "event.key === 'Escape'"]);
await required('public/scripts/article.js', [
  'prepareAudio', 'fetch(manifestUrl', 'audio.play()', "audio?.addEventListener('ended'", 'pagehide',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'stopAudio', 'is-audio-active'
]);
await required('src/content.config.ts', ['quickSummary:']);

const postDir = 'src/content/posts';
const posts = (await readdir(postDir)).filter((name) => name.endsWith('.md'));
if (!posts.length) throw new Error('No article files found.');
for (const name of posts) {
  const text = await readFile(path.join(postDir, name), 'utf8');
  const match = text.match(/^quickSummary:\s*["'](.+)["']\s*$/m);
  if (!match || match[1].trim().length < 50) throw new Error(`${name}: quickSummary is missing or too short.`);
}
await import('./check-visual-stories.mjs');
await import('./test-visual-story-runtime.mjs');
console.log(`Reading modes audit passed for ${posts.length} articles.`);
