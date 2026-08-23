import { readFile, writeFile } from 'node:fs/promises';

const generatorPath = 'scripts/generate-audio.mjs';
const generatorBefore = await readFile(generatorPath, 'utf8');
const generatorAfter = generatorBefore.replace(
  /const USER_AGENT = 'Bareeq-Audio-Builder\/4\.[0-9.]+';/,
  "const USER_AGENT = 'Bareeq-Audio-Builder/4.21.1';",
);
if (!generatorAfter.includes("const USER_AGENT = 'Bareeq-Audio-Builder/4.21.1';")) throw new Error('V4.21.1: audio builder version anchor is missing.');
if (generatorAfter !== generatorBefore) await writeFile(generatorPath, generatorAfter);

const readinessPath = 'scripts/check-launch-readiness.mjs';
const readinessBefore = await readFile(readinessPath, 'utf8');
const readinessAfter = readinessBefore
  .replace("if (pkg.version !== '4.21.0') failures.push(`Expected package version 4.21.0, got ${pkg.version}`);", "if (pkg.version !== '4.21.1') failures.push(`Expected package version 4.21.1, got ${pkg.version}`);")
  .replace('Launch-readiness source audit passed: V4.21.0 package identity', 'Launch-readiness source audit passed: V4.21.1 package identity');
if (
  !readinessAfter.includes("if (pkg.version !== '4.21.1') failures.push(`Expected package version 4.21.1, got ${pkg.version}`);")
  && !readinessAfter.includes("if (!['4.21.1', '4.21.2'].includes(pkg.version)) failures.push(`Expected package version 4.21.1 or 4.21.2, got ${pkg.version}`);")
  && !readinessAfter.includes("if (!['4.21.1', '4.21.2', '4.21.3', '4.21.4'].includes(pkg.version)) failures.push(`Expected supported package version 4.21.1–4.21.4, got ${pkg.version}`);")
) throw new Error('V4.21.1: launch-readiness version gate is missing.');
if (readinessAfter !== readinessBefore) await writeFile(readinessPath, readinessAfter);

const [runner, generator, footer, about, contact, privacy, site] = await Promise.all([
  readFile('scripts/run-v4211-audio.mjs', 'utf8'),
  readFile('scripts/generate-audio.mjs', 'utf8'),
  readFile('src/components/Footer.astro', 'utf8'),
  readFile('src/pages/about.astro', 'utf8'),
  readFile('src/pages/contact.astro', 'utf8'),
  readFile('src/content/pages/privacy.md', 'utf8'),
  readFile('src/config/site.ts', 'utf8'),
]);

for (const token of [
  'BAREEQ_GEMINI_FREE_ROLLOUT',
  'BAREEQ_GEMINI_FREE_ARTICLES_PER_BUILD',
  "BAREEQ_TTS_CACHE_ALLOW_MISSING: '1'",
  'BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD',
  'PENDING_CLOUD.join',
  'exactly one unresolved article atomically',
  "process.env.BAREEQ_CLOUD_TTS_ACTIVATE !== '1'",
]) if (!runner.includes(token)) throw new Error(`V4.21.1: free-tier runner safeguard missing: ${token}`);

for (const token of ['CACHE_ALLOW_MISSING', 'MAX_MISSING_ARTICLES_PER_BUILD', 'Progressive article priority:', 'Progressive article cap:', 'Gemini free-tier step complete:']) {
  if (!generator.includes(token)) throw new Error(`V4.21.1: generator safeguard missing: ${token}`);
}

for (const [name, source] of [['Footer.astro', footer], ['about.astro', about], ['contact.astro', contact]]) {
  if (!source.includes('<!--email_off-->') || !source.includes('<!--/email_off-->')) throw new Error(`V4.21.1: Cloudflare email-protection boundary missing in ${name}.`);
}
for (const token of ['محفوظات القراءة', 'موضع الاستماع', '30 يومًا', 'لا يرسلها الموقع']) {
  if (!privacy.includes(token)) throw new Error(`V4.21.1: privacy disclosure missing: ${token}`);
}
if (!site.includes("email: 'info@bareeqworld.com'")) throw new Error('V4.21.1: the confirmed domain mailbox info@bareeqworld.com must stay in site config.');

console.log('V4.21.1 preparation passed: one-article Gemini free-tier progression, atomic fallback preservation, paid Cloud lock, Cloudflare email-link protection, and local-storage privacy disclosure are present.');
