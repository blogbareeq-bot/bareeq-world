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
  'import ReadingModes', 'import { findVisualStoryBySlug }', '<ReadingModes', 'id="article-content"', 'data-article-content', 'audioManifest={audioManifest}', 'story={visualStory}'
]);

// VisualStory.astro is now a guarded dispatcher. Keep both renderers audited
// explicitly so this check becomes stricter rather than accepting a wrapper
// that happens to mention production data attributes.
await required('src/components/VisualStory.astro', [
  "import VisualStoryV3 from './visual-story/VisualStoryV3.astro'",
  "import VisualStoryLegacy from './VisualStoryLegacy.astro'",
  "story.slug === 'how-touchscreens-work'",
  '<VisualStoryV3 story={story} />',
  '<VisualStoryLegacy story={story} />'
]);
await required('src/components/VisualStoryLegacy.astro', [
  'data-visual-story', 'data-visual-card', 'data-visual-share', 'data-visual-next', 'data-visual-prev'
]);
await required('src/components/visual-story/VisualStoryV3.astro', [
  'data-window-v3-root', 'data-visual-card', 'data-visual-share', 'data-visual-dialog',
  'data-v3-scroller', 'data-v3-progress-bar', 'data-v3-probe', 'bareeq-window-mark.svg', 'bareeq-window-signature.svg'
]);
await required('public/scripts/visual-story.js', ['bareeq-visual-progress-v1', 'bareeq:visual-story', '#visual=', 'maxAge', "event.key === 'Escape'"]);
await required('public/scripts/visual-story-v3.js', ['bareeq-window-v3-progress-v1', 'bareeq:visual-story-v3', '#visual=', 'maxAge', "event.key === 'Escape'"]);
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
console.log(`Reading modes audit passed for ${posts.length} articles, including guarded Window V3 pilot.`);
