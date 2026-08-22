import { access, readFile, readdir } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (!['4.20.0', '4.21.0', '4.21.1', '4.21.2', '4.21.3'].includes(pkg.version)) throw new Error(`Expected package 4.20.0 baseline or supported patch successor, got ${pkg.version}`);

for (const p of [
  'src/content/posts/ai-as-coworker-future-of-human-work.md',
  'public/images/posts/ai-as-coworker-future-of-human-work.webp',
  'assets/thumbnails-source/ai-as-coworker-future-of-human-work.webp',
  'scripts/prepare-v4200.mjs',
  'scripts/run-v4200-audio.mjs',
  'scripts/check-production-voices-v4200.mjs',
  'scripts/check-v4200-release.mjs'
]) await access(p);

const article = await readFile('src/content/posts/ai-as-coworker-future-of-human-work.md', 'utf8');
if (!/^draft:\s*false$/m.test(article)) throw new Error('Coworker article must be published in V4.20.0.');
if (!article.includes('/posts/ai-agents-future-now/')) throw new Error('Coworker article is missing the agents internal link.');

const files = (await readdir('src/content/posts')).filter((name) => name.endsWith('.md'));
let live = 0;
for (const name of files) {
  const source = await readFile(`src/content/posts/${name}`, 'utf8');
  if (!/^draft:\s*true$/mi.test(source)) live += 1;
}
if (live !== 13) throw new Error(`V4.20.0 expects 13 live articles, got ${live}.`);

const redirects = await readFile('public/_redirects', 'utf8');
for (const target of ['altadakhom-explained-simply', 'language-soft-power-politics']) if (!redirects.includes(target)) throw new Error(`Missing canonical redirect target ${target}`);

const site = await readFile('src/config/site.ts', 'utf8');
if (!site.includes("analyticsMeasurementId: 'G-N3NQMF7RHN'")) throw new Error('Google Analytics measurement ID changed or missing.');
const consent = await readFile('public/scripts/analytics-consent.js', 'utf8');
if (!consent.includes('bareeq-analytics-consent-v1') || !consent.includes('googletagmanager.com/gtag/js')) throw new Error('Consent-aware Analytics implementation missing.');

const runner = await readFile('scripts/run-v4200-audio.mjs', 'utf8');
const order = [
  "BAREEQ_TTS_CACHE_ONLY: '1'",
  "BAREEQ_TTS_PROVIDER: 'gemini'",
  "hasCompleteVoice(NEW_ARTICLE, 'Google Gemini API', 'sadaltager')",
  "BAREEQ_TTS_PROVIDER: 'azure'",
  "hasCompleteVoice(NEW_ARTICLE, 'Microsoft Azure AI Speech', 'hamed')"
];
let cursor = -1;
for (const token of order) {
  const next = runner.indexOf(token, cursor + 1);
  if (next < 0) throw new Error(`V4.20 audio fallback chain token missing: ${token}`);
  cursor = next;
}
if (runner.includes('BAREEQ_GEMINI_PILOT')) throw new Error('Legacy opt-in Gemini pilot remains in V4.20 runner.');

const build = pkg.scripts?.build || '';
for (const token of ['prepare-v4200.mjs', 'check-v4200-release.mjs', 'check-production-voices-v4200.mjs', 'run-v4200-audio.mjs']) if (!build.includes(token)) throw new Error(`V4.20 build missing ${token}`);

console.log('V4.20.0 release gate passed: 13 articles, coworker assets, SEO redirects, consent-aware Analytics, protected old audio, coworker cache → Gemini → Azure fallback.');
