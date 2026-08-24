import { readFile, writeFile, rm } from 'node:fs/promises';

const ARTICLE_ID = 'why-some-passports-are-stronger';
const ARTICLE_FILE = `src/content/posts/${ARTICLE_ID}.md`;
const ARTICLE_BODY_HASH = '2b2999dba95bff5e6bfb8ff16d2848fa3b677ffe8f595a5b6166ca15ebf7d4c1';

async function read(path) { return readFile(path, 'utf8'); }
async function write(path, text) { await writeFile(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8'); }
function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}.`);
  return source.replace(from, to);
}
function replaceOptional(source, from, to) {
  return source.includes(from) ? source.replace(from, to) : source;
}

// 1) Package identity + safe production build: normal Cloudflare builds restore/cache audio only.
const pkg = JSON.parse(await read('package.json'));
pkg.version = '4.21.5';
pkg.scripts.prebuild = 'node scripts/prepare-v4215.mjs && node --check scripts/check-v4215-release.mjs';
pkg.scripts.postbuild = 'node scripts/check-v4215-release.mjs';
pkg.scripts.build = pkg.scripts.build
  .replace('node scripts/prepare-v4190.mjs', 'node scripts/prepare-v4215.mjs && node scripts/prepare-v4190.mjs')
  .replace('node scripts/run-v4211-audio.mjs && ASTRO_TELEMETRY_DISABLED=1 astro build', 'BAREEQ_GEMINI_FREE_ROLLOUT=0 BAREEQ_CLOUD_TTS_ACTIVATE=0 node scripts/run-v4211-audio.mjs && ASTRO_TELEMETRY_DISABLED=1 astro build')
  .replace('node scripts/check-mobile-ticker-motion.mjs', 'node scripts/check-mobile-ticker-motion.mjs && node scripts/check-v4215-release.mjs');
pkg.scripts['audit:v4215'] = 'node scripts/prepare-v4215.mjs && node scripts/check-v4215-release.mjs';
pkg.scripts['audio:gemini:resume:prepare'] = 'node scripts/prepare-v4215-gemini-resume.mjs';
await write('package.json', JSON.stringify(pkg, null, 2));

const lock = JSON.parse(await read('package-lock.json'));
lock.version = '4.21.5';
if (!lock.packages?.['']) throw new Error('package-lock root package is missing.');
lock.packages[''].version = '4.21.5';
await write('package-lock.json', JSON.stringify(lock, null, 2));

// 2) Rollout boundary becomes draft-aware: 13 live now, 14 automatically after publication.
await write('scripts/cloud-tts-rollout.mjs', `import { readFile } from 'node:fs/promises';

export const RETAINED_GEMINI = [
  'ai-agents-future-now',
  'ai-as-coworker-future-of-human-work',
];

const BASE_PENDING_CLOUD = [
  'altadakhom-explained-simply',
  'intuition-first-impression-decisions-signature',
  'language-soft-power-politics',
  'اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا',
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع',
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء',
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون',
  'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء',
];

export const RELEASE_CANDIDATE_ARTICLE = '${ARTICLE_ID}';
const candidateSource = await readFile('src/content/posts/' + RELEASE_CANDIDATE_ARTICLE + '.md', 'utf8');
export const RELEASE_CANDIDATE_PUBLISHED = !/^draft:\\s*true\\s*$/mi.test(candidateSource);

export const PENDING_CLOUD = [
  ...BASE_PENDING_CLOUD,
  ...(RELEASE_CANDIDATE_PUBLISHED ? [RELEASE_CANDIDATE_ARTICLE] : []),
];

export const EXPECTED_PUBLISHED_ARTICLES = RETAINED_GEMINI.length + PENDING_CLOUD.length;
export const EXPECTED_PENDING_CLOUD = PENDING_CLOUD.length;

const unique = new Set([...RETAINED_GEMINI, ...PENDING_CLOUD]);
if (unique.size !== EXPECTED_PUBLISHED_ARTICLES) {
  throw new Error('Cloud TTS rollout IDs must stay unique.');
}
if (![13, 14].includes(EXPECTED_PUBLISHED_ARTICLES)) {
  throw new Error('V4.21.5 expects 13 live articles during RC or 14 after the passport article is published.');
}
`);

// 3) Speech review is committed directly; no publish-day patch is required anymore.
const review = JSON.parse(await read('scripts/speech-review.json'));
review.articles ||= {};
review.articles[ARTICLE_ID] = {
  bodyHash: ARTICLE_BODY_HASH,
  checks: [
    { from: 'ETA', to: 'إِي تِي إِيه' },
    { from: 'e-Visa', to: 'إِي فِيزَا' },
    { from: 'Arton Capital', to: 'أَرْتُون كَابِيتَال' },
    { from: 'Passport Index', to: 'بَاسْبُورْت إِنْدِكْس' },
    { from: 'C-181/23', to: 'سِي 181 شَرْطَة 23' },
    { from: 'وقعت الدولتان اتفاقية', to: 'وَقَّعَتِ الدولتان اتفاقية' },
    { from: 'عد الآن إلى مشهد المطار', to: 'عُدِ الآن إلى مشهد المطار' },
    { from: 'يخل بالتزاماتها', to: 'يُخِلُّ بالتزاماتها' },
  ],
};
await write('scripts/speech-review.json', JSON.stringify(review, null, 2));

// 4) Make historical release gates accept V4.21.5 and either 13 (RC) or 14 (published).
const files = {
  'scripts/check-v4200-release.mjs': async (s) => {
    s = replaceOnce(s, "'4.21.4'].includes(pkg.version)", "'4.21.4', '4.21.5'].includes(pkg.version)", 'v4200 version');
    s = replaceOnce(s, "if (live !== 13) throw new Error(`V4.20.0 expects 13 live articles, got ${live}.`);", "if (![13, 14].includes(live)) throw new Error(`V4.21.5 compatibility expects 13 or 14 live articles, got ${live}.`);", 'v4200 count');
    return s;
  },
  'scripts/check-v4210-release.mjs': async (s) => {
    s = replaceOnce(s, "'4.21.4'].includes(pkg.version)", "'4.21.4', '4.21.5'].includes(pkg.version)", 'v4210 version');
    s = replaceOnce(s, "if (PENDING_CLOUD.length !== 11 || RETAINED_GEMINI.length !== 2 || new Set([...PENDING_CLOUD, ...RETAINED_GEMINI]).size !== 13) throw new Error('Cloud TTS rollout boundary must be 11 pending + 2 retained Gemini articles.');", "if (![11, 12].includes(PENDING_CLOUD.length) || RETAINED_GEMINI.length !== 2 || new Set([...PENDING_CLOUD, ...RETAINED_GEMINI]).size !== PENDING_CLOUD.length + RETAINED_GEMINI.length) throw new Error('Cloud TTS rollout boundary must be 11/12 pending + 2 retained Gemini articles.');", 'v4210 boundary');
    s = replaceOnce(s, "if (published !== 13) throw new Error(`V4.21 expects 13 published articles, got ${published}.`);", "if (![13, 14].includes(published)) throw new Error(`V4.21.5 expects 13 RC or 14 published articles, got ${published}.`);", 'v4210 published');
    return s;
  },
  'scripts/check-v4211-release.mjs': async (s) => {
    s = replaceOnce(s, "'4.21.4'].includes(pkg.version)", "'4.21.4', '4.21.5'].includes(pkg.version)", 'v4211 version');
    s = replaceOnce(s, "if (PENDING_CLOUD.length !== 11 || RETAINED_GEMINI.length !== 2 || new Set([...PENDING_CLOUD, ...RETAINED_GEMINI]).size !== 13) throw new Error('V4.21.1 must keep the exact 11 pending + 2 retained article boundary.');", "if (![11, 12].includes(PENDING_CLOUD.length) || RETAINED_GEMINI.length !== 2 || new Set([...PENDING_CLOUD, ...RETAINED_GEMINI]).size !== PENDING_CLOUD.length + RETAINED_GEMINI.length) throw new Error('V4.21.5 must keep the 11/12 pending + 2 retained boundary.');", 'v4211 boundary');
    s = replaceOnce(s, "if (published !== 13) throw new Error(`V4.21.1 expected 13 published articles, found ${published}.`);", "if (![13, 14].includes(published)) throw new Error(`V4.21.5 expected 13 RC or 14 published articles, found ${published}.`);", 'v4211 published');
    return s;
  },
  'scripts/check-v4212-release.mjs': async (s) => {
    s = replaceOnce(s, "'4.21.4'].includes(pkg.version)", "'4.21.4', '4.21.5'].includes(pkg.version)", 'v4212 version');
    s = replaceOnce(s, "if (published !== 13) throw new Error(`Expected 13 published articles, found ${published}.`);", "if (![13, 14].includes(published)) throw new Error(`V4.21.5 expects 13 RC or 14 published articles, found ${published}.`);", 'v4212 published');
    return s;
  },
  'scripts/check-v4213-release.mjs': async (s) => {
    s = replaceOnce(s, "['4.21.3', '4.21.4'].includes(pkg.version)", "['4.21.3', '4.21.4', '4.21.5'].includes(pkg.version)", 'v4213 version');
    return s;
  },
  'scripts/check-audio-dist.mjs': async (s) => {
    s = replaceOnce(s, "'4.21.4'].includes(pkg.version)", "'4.21.4', '4.21.5'].includes(pkg.version)", 'audio-dist version');
    s = replaceOnce(s, "['4.21.1', '4.21.2', '4.21.3', '4.21.4'].includes(pkg.version)", "['4.21.1', '4.21.2', '4.21.3', '4.21.4', '4.21.5'].includes(pkg.version)", 'audio-dist free rollout');
    s = replaceOnce(s, "if (published.length !== 13) throw new Error(`V4.20 audio-dist audit expected 13 published articles, found ${published.length}.`);", "if (![13, 14].includes(published.length)) throw new Error(`V4.21.5 audio-dist audit expected 13 RC or 14 published articles, found ${published.length}.`);", 'audio-dist published');
    s = replaceOnce(s, "if (checkedArticles !== 13) throw new Error(`V4.20 audio-dist audit expected 13 complete audio articles, checked ${checkedArticles}.`);", "if (checkedArticles !== published.length) throw new Error(`Audio-dist audit expected ${published.length} complete audio articles, checked ${checkedArticles}.`);", 'audio-dist checked');
    s = replaceOnce(s, "if (cloudActivated && (providerCounts.get('Cloud TTS Sadaltager') !== 11 || providerCounts.get('Gemini Sadaltager') !== 2)) throw new Error('Activated rollout must publish exactly 11 Cloud TTS + 2 retained Gemini articles.');", "if (cloudActivated && (providerCounts.get('Cloud TTS Sadaltager') !== PENDING_CLOUD.length || providerCounts.get('Gemini Sadaltager') !== RETAINED_GEMINI.length)) throw new Error(`Activated rollout must publish exactly ${PENDING_CLOUD.length} Cloud TTS + ${RETAINED_GEMINI.length} retained Gemini articles.`);", 'audio-dist provider counts');
    return s;
  },
};
for (const [path, transform] of Object.entries(files)) {
  await write(path, await transform(await read(path)));
}

// 5) Cleanup misleading hard-coded log text and historical publish patches.
for (const path of ['scripts/check-audio-mobile.mjs', 'scripts/check-production-voices-v4200.mjs', 'scripts/run-v4211-audio.mjs']) {
  let s = await read(path);
  s = replaceOptional(s, '11 pending + 2 retained boundary recognized', 'dynamic pending + 2 retained boundary recognized');
  s = replaceOptional(s, '13 live articles', 'dynamic live-article boundary');
  s = replaceOptional(s, 'the eleven articles completed on earlier free-tier deployments', 'the pending articles completed on earlier free-tier deployments');
  await write(path, s);
}

for (const path of [
  'docs/editorial/publish-day-why-some-passports-are-stronger.patch',
  'docs/editorial/publish-day-why-some-passports-final-fixes.patch',
  'docs/editorial/generate-passport-audio.workflow.yml',
]) await rm(path, { force: true });

console.log('V4.21.5 assembly completed: package identity, draft-aware 13→14 boundary, committed speech review, safe build-time audio policy, and legacy gate compatibility are staged.');
