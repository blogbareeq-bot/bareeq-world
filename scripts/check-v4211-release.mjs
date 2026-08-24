import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { PENDING_CLOUD, RETAINED_GEMINI } from './cloud-tts-rollout.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (!['4.21.1', '4.21.2', '4.21.3', '4.21.4', '4.21.5'].includes(pkg.version)) throw new Error(`Expected package 4.21.1 through 4.21.5, got ${pkg.version}.`);
if (![11, 12].includes(PENDING_CLOUD.length) || RETAINED_GEMINI.length !== 2 || new Set([...PENDING_CLOUD, ...RETAINED_GEMINI]).size !== PENDING_CLOUD.length + RETAINED_GEMINI.length) throw new Error('V4.21.5 must keep the 11/12 pending + 2 retained article boundary.');

const [runner, generator, envExample, privacy, footer, about, contact, site, mobileAudit, distAudit] = await Promise.all([
  readFile('scripts/run-v4211-audio.mjs', 'utf8'),
  readFile('scripts/generate-audio.mjs', 'utf8'),
  readFile('.env.example', 'utf8'),
  readFile('src/content/pages/privacy.md', 'utf8'),
  readFile('src/components/Footer.astro', 'utf8'),
  readFile('src/pages/about.astro', 'utf8'),
  readFile('src/pages/contact.astro', 'utf8'),
  readFile('src/config/site.ts', 'utf8'),
  readFile('scripts/check-audio-mobile.mjs', 'utf8'),
  readFile('scripts/check-audio-dist.mjs', 'utf8'),
]);

const requireAll = (label, source, tokens) => {
  for (const token of tokens) if (!source.includes(token)) throw new Error(`${label} is missing V4.21.1 safeguard: ${token}`);
};

requireAll('run-v4211-audio.mjs', runner, [
  "process.env.BAREEQ_CLOUD_TTS_ACTIVATE !== '1'",
  "process.env.BAREEQ_GEMINI_FREE_ROLLOUT?.trim() || '1'",
  "process.env.BAREEQ_GEMINI_FREE_ARTICLES_PER_BUILD?.trim() || '1'",
  "BAREEQ_TTS_CACHE_ALLOW_MISSING: '1'",
  'BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD',
  'PENDING_CLOUD.join',
  'approved fallback audio is published with 0 synthesis requests',
  "BAREEQ_TTS_PROVIDER: 'google-cloud'",
]);
requireAll('generate-audio.mjs', generator, [
  "const USER_AGENT = 'Bareeq-Audio-Builder/4.21.1'",
  'CACHE_ALLOW_MISSING',
  'MAX_MISSING_ARTICLES_PER_BUILD',
  'Progressive article priority:',
  'Progressive article cap:',
  'Gemini free-tier step complete:',
  'error?.httpStatus === 429',
]);
requireAll('.env.example', envExample, [
  'BAREEQ_GEMINI_FREE_ROLLOUT=1',
  'BAREEQ_GEMINI_FREE_ARTICLES_PER_BUILD=1',
  'BAREEQ_CLOUD_TTS_ACTIVATE=0',
]);
requireAll('privacy.md', privacy, ['محفوظات القراءة', 'موضع الاستماع', '30 يومًا', 'لا يرسلها الموقع']);
for (const [label, source] of [['Footer.astro', footer], ['about.astro', about], ['contact.astro', contact]]) {
  requireAll(label, source, ['<!--email_off-->', '<!--/email_off-->']);
}
if (!site.includes("email: 'info@bareeqworld.com'")) throw new Error('The confirmed domain mailbox info@bareeqworld.com must stay in site config for V4.21.1.');
requireAll('check-audio-mobile.mjs', mobileAudit, ['v4211OrchestratedPipeline', 'one-article Gemini free-tier progression']);
requireAll('check-audio-dist.mjs', distAudit, ['freeGeminiRollout', "providerKind === 'Gemini Sadaltager'"]);

const postFiles = (await readdir('src/content/posts')).filter((name) => name.endsWith('.md'));
let published = 0;
for (const file of postFiles) {
  const source = await readFile(`src/content/posts/${file}`, 'utf8');
  if (!/^draft:\s*true\s*$/mi.test(source)) published += 1;
}
if (![13, 14].includes(published)) throw new Error(`V4.21.5 expected 13 RC or 14 published articles, found ${published}.`);

const plan = spawnSync(process.execPath, ['scripts/plan-v4211-gemini-free-rollout.mjs'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (plan.error) throw plan.error;
if (plan.status !== 0) throw new Error(`Pending Gemini plan failed:\n${plan.stdout || ''}${plan.stderr || ''}`);
if (!plan.stdout.includes(`${PENDING_CLOUD.length} selected article(s)`) || !plan.stdout.includes('0 API requests')) throw new Error(`Pending Gemini plan did not prove ${PENDING_CLOUD.length} selected articles and zero planning requests.`);

const build = pkg.scripts?.build || '';
for (const token of ['prepare-v4211.mjs', 'test-gemini-free-rollout-v4211.mjs', 'check-header-design-v4211.mjs', 'check-v4211-release.mjs', 'run-v4211-audio.mjs']) {
  if (!build.includes(token)) throw new Error(`Build pipeline is missing ${token}.`);
}
if (!build.includes('node scripts/run-v4211-audio.mjs && ASTRO_TELEMETRY_DISABLED=1 astro build')) throw new Error('V4.21.1 runner is not the production audio step immediately before Astro build.');
if (pkg.version === '4.21.5' && !build.includes('BAREEQ_GEMINI_FREE_ROLLOUT=0 BAREEQ_CLOUD_TTS_ACTIVATE=0 node scripts/run-v4211-audio.mjs')) {
  throw new Error('V4.21.5 normal build must disable synthesis and use the separate resumable workflow.');
}

console.log(`V4.21.1 compatibility gate passed inside V4.21.5: ${published} articles, ${PENDING_CLOUD.length}+${RETAINED_GEMINI.length} boundary, private/lazy audio metadata, protected email links, local-storage privacy disclosure, and synthesis disabled in the normal production build.`);
