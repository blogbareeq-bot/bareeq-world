import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const audioCoreScript = await readFile('public/scripts/audio-core.js', 'utf8');
const articleScript = await readFile('public/scripts/article.js', 'utf8');
const failures = [];

const manifest = {
  version: 3,
  provider: 'Google Cloud Text-to-Speech',
  model: 'gemini-2.5-flash-tts',
  language: 'ar-EG',
  articleId: 'ui-contract',
  defaultVoice: 'sadaltager',
  voices: [{ id: 'sadaltager', label: 'سادالتاجر', providerVoice: 'Sadaltager', totalDurationSeconds: 200 }],
  parts: [
    { sync: [{ id: 'b0001', match: 'الفقرة الأولى للاختبار', start: 0, end: 1 }], audio: { sadaltager: { src: '/audio/part-1.mp3', durationSeconds: 100 } } },
    { sync: [{ id: 'b0002', match: 'الفقرة الثانية المقصودة', start: 0, end: 1 }], audio: { sadaltager: { src: '/audio/part-2.mp3', durationSeconds: 100 } } },
  ],
};

const html = `<!doctype html><html dir="rtl"><body>
  <article data-article-content>
    <p>الفقرة الأولى للاختبار.</p>
    <p>الفقرة الثانية المقصودة.</p>
  </article>
  <section data-reading-modes data-audio-manifest="/audio/manifest.json">
    <button data-reading-mode="read"></button>
    <button data-reading-mode="listen"></button>
    <button data-reading-mode="summary"></button>
    <div data-listen-panel hidden>
      <audio data-article-audio></audio>
      <button data-audio-play disabled><span data-audio-play-label></span></button>
      <button data-audio-stop disabled></button>
      <button data-audio-native-fallback hidden></button>
      <span data-audio-status></span>
      <label data-audio-voice-field><select data-audio-voice disabled></select></label>
      <select data-audio-rate><option value="1" selected>1×</option></select>
      <input data-audio-seek type="range" min="0" max="1000" value="0" disabled>
      <span data-listen-label></span>
      <span data-audio-time></span>
    </div>
    <div data-summary-panel hidden></div>
    <button data-summary-read></button>
  </section>
</body></html>`;

async function verify(width) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'https://bareeqworld.com/posts/ui-contract/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.requestAnimationFrame = (callback) => { callback(Date.now()); return 1; };
  window.cancelAnimationFrame = () => {};
  window.matchMedia = (query) => ({
    matches: query.includes('prefers-reduced-motion') ? true : query.includes('max-width') ? width <= Number(query.match(/(\d+)/)?.[1] || 0) : false,
    media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true; },
  });
  let fetchCount = 0;
  window.fetch = async () => {
    fetchCount += 1;
    return { ok: true, json: async () => structuredClone(manifest) };
  };
  const audio = window.document.querySelector('[data-article-audio]');
  Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
  Object.defineProperty(audio, 'currentTime', { value: 0, writable: true, configurable: true });

  const scrolled = [];
  for (const paragraph of window.document.querySelectorAll('[data-article-content] p')) {
    paragraph.getBoundingClientRect = () => ({ top: -500, bottom: -450, left: 0, right: width, width, height: 50, x: 0, y: -500, toJSON() {} });
    paragraph.scrollIntoView = (options) => scrolled.push({ paragraph, options });
  }

  window.eval(audioCoreScript);
  window.eval(articleScript);
  if (fetchCount !== 0) failures.push(`${width}px: manifest fetched before Listen was selected`);
  window.document.querySelector('[data-reading-mode="listen"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (fetchCount !== 1) failures.push(`${width}px: Listen selection did not fetch exactly one manifest`);

  const seek = window.document.querySelector('[data-audio-seek]');
  if (seek?.disabled) failures.push(`${width}px: seek remained disabled after manifest load`);
  seek.value = '750';
  seek.dispatchEvent(new window.Event('change', { bubbles: true }));
  const target = window.document.querySelectorAll('[data-article-content] p')[1];
  if (!target.classList.contains('is-audio-active') || target.getAttribute('data-audio-current') !== 'true') failures.push(`${width}px: seek did not activate the matching text`);
  if (!scrolled.some((entry) => entry.paragraph === target && entry.options?.block === 'center')) failures.push(`${width}px: seek did not scroll directly to the matching text`);
  if (!audio.src.endsWith('/audio/part-2.mp3')) failures.push(`${width}px: seek did not switch to the matching audio part`);
  dom.window.close();
}

await verify(390);
await verify(1440);

if (failures.length) {
  console.error(`V4.21 audio UI test found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('V4.21 audio UI passed at 390px and 1440px: lazy manifest load, seek-to-text highlight, direct scroll, and matching audio part selection.');
