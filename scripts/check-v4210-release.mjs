import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { PENDING_CLOUD, RETAINED_GEMINI } from './cloud-tts-rollout.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (!['4.21.0', '4.21.1'].includes(pkg.version)) throw new Error(`Expected package 4.21.0 baseline or 4.21.1 patch successor, got ${pkg.version}`);

const [component, page, client, styles, generator, cloud, runner, envExample, guide, site] = await Promise.all([
  readFile('src/components/ReadingModes.astro', 'utf8'),
  readFile('src/pages/posts/[id].astro', 'utf8'),
  readFile('public/scripts/article.js', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
  readFile('scripts/generate-audio.mjs', 'utf8'),
  readFile('scripts/cloud-tts.mjs', 'utf8'),
  readFile('scripts/run-v4210-audio.mjs', 'utf8'),
  readFile('.env.example', 'utf8'),
  readFile('docs/دليل-الجاهزية-Cloud-TTS-v4.21.0.md', 'utf8'),
  readFile('src/config/site.ts', 'utf8'),
]);

const requireAll = (name, text, tokens) => {
  for (const token of tokens) if (!text.includes(token)) throw new Error(`${name} is missing V4.21 safeguard: ${token}`);
};

requireAll('ReadingModes.astro', component, ['hasAudio = false', 'data-audio-manifest={audioManifest}', 'data-audio-time']);
if (component.includes('data-audio-manifest-inline') || component.includes('data-audio-current-voice')) throw new Error('Initial article HTML still embeds audio manifest/provider/voice metadata.');
requireAll('[id].astro', page, ["import { access } from 'node:fs/promises'", 'await access(manifestPath)', 'hasAudio={hasAudio}']);
requireAll('article.js', client, ['forceScroll', 'ratioOverride', 'smartScrollTo(target, { force: true })', 'syncTextToAudio({ forceScroll: true, ratioOverride: localRatio })', 'The manifest is fetched only after the reader deliberately opens Listen']);
if (client.includes('readInlineManifest') || client.includes('data-audio-current-voice') || client.includes('يعمل — ${activeVoiceEntry')) throw new Error('Client still exposes eager provider/voice metadata.');
requireAll('global.css', styles, ['.audio-progress{justify-content:flex-end}', '@media(max-width:680px)', '@media (min-width:681px) and (max-width:1180px)']);

requireAll('cloud-tts.mjs', cloud, [
  "CLOUD_TTS_MODEL = 'gemini-2.5-flash-tts'", "CLOUD_TTS_LANGUAGE = 'ar-EG'", "CLOUD_TTS_VOICE = 'Sadaltager'",
  "CLOUD_TTS_AUDIO_ENCODING = 'MP3'", 'BAREEQ_CLOUD_TTS_ACTIVATE=1', 'x-goog-user-project', 'modelName', 'audioContent', '4000 UTF-8 bytes', '8000-byte limit',
]);
requireAll('generate-audio.mjs', generator, [
  "'google-cloud'", 'Google Cloud Text-to-Speech', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_TTS_MAX_REQUEST_BYTES',
  'BAREEQ_CLOUD_TTS_MAX_REQUESTS_PER_BUILD', 'BAREEQ_CLOUD_TTS_MAX_CHARS_PER_BUILD', 'assertCloudTtsActivation',
  'AZURE_SPEECH_MONTHLY_USED_CHARS', 'Azure monthly allowance warning',
]);
requireAll('run-v4210-audio.mjs', runner, [
  "process.env.BAREEQ_CLOUD_TTS_ACTIVATE !== '1'", "runStrict('scripts/run-v4200-audio.mjs')", "BAREEQ_TTS_PROVIDER: 'google-cloud'",
  "BAREEQ_TTS_CACHE_ONLY: '1'", 'V4.21.0 safety stop',
]);
if (PENDING_CLOUD.length !== 11 || RETAINED_GEMINI.length !== 2 || new Set([...PENDING_CLOUD, ...RETAINED_GEMINI]).size !== 13) throw new Error('Cloud TTS rollout boundary must be 11 pending + 2 retained Gemini articles.');

requireAll('.env.example', envExample, ['GOOGLE_CLOUD_PROJECT=bareeq-tts', 'BAREEQ_CLOUD_TTS_ACTIVATE=0', 'GOOGLE_SERVICE_ACCOUNT_JSON=', 'AZURE_SPEECH_MONTHLY_USED_CHARS=']);
requireAll('Cloud TTS guide', guide, ['CNTXT', 'لا تفعّل', 'roles/aiplatform.user', 'gemini-2.5-flash-tts', 'ar-EG', 'Sadaltager']);
if (!site.includes("email: 'blogbareeq@gmail.com'")) throw new Error('Unconfirmed domain email was inserted; keep the verified working address until the user confirms a replacement.');

const postFiles = (await readdir('src/content/posts')).filter((name) => name.endsWith('.md'));
let published = 0;
let sourceBundle = '';
for (const name of postFiles) {
  const source = await readFile(`src/content/posts/${name}`, 'utf8');
  if (!/^draft:\s*true\s*$/mi.test(source)) published += 1;
  sourceBundle += source;
}
if (published !== 13) throw new Error(`V4.21 expects 13 published articles, got ${published}.`);
const uiSource = [component, page, client, await readFile('src/pages/index.astro', 'utf8')].join('\n');
for (const paused of ['فكرة تبقى معك', 'بريق عملي', 'ميزان بريق', 'كيف استخدمنا المصادر؟']) if (uiSource.includes(paused)) throw new Error(`Paused experimental knowledge layer returned: ${paused}`);

const plan = execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  env: {
    ...process.env,
    BAREEQ_TTS_PROVIDER: 'google-cloud',
    BAREEQ_TTS_INCLUDE_IDS: PENDING_CLOUD.join(','),
    BAREEQ_CLOUD_TTS_ACTIVATE: '',
    GOOGLE_CLOUD_ACCESS_TOKEN: '',
    GOOGLE_SERVICE_ACCOUNT_JSON: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
  },
});
if (!plan.includes('pre-activation plan: 11 selected article(s)') || !plan.includes('Planning sends 0 API requests') || !plan.includes('gemini-2.5-flash-tts') || !plan.includes('Sadaltager') || !plan.includes('ar-EG')) throw new Error('Cloud TTS pre-activation plan is incomplete or not zero-request.');

const inactive = spawnSync(process.execPath, ['scripts/generate-audio.mjs'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    BAREEQ_TTS_PROVIDER: 'google-cloud',
    BAREEQ_TTS_INCLUDE_IDS: PENDING_CLOUD[0],
    BAREEQ_AUDIO_ALLOW_PARTIAL: '1',
    BAREEQ_CLOUD_TTS_ACTIVATE: '',
    GOOGLE_CLOUD_ACCESS_TOKEN: 'must-not-be-used',
  },
});
const inactiveOutput = `${inactive.stdout || ''}\n${inactive.stderr || ''}`;
if (inactive.status === 0 || !inactiveOutput.includes('prepared but not activated') || !inactiveOutput.includes('No Cloud TTS request was sent')) throw new Error('Cloud TTS inactive safety gate did not fail closed before synthesis.');

const build = pkg.scripts?.build || '';
for (const token of ['prepare-v4210.mjs', 'test-cloud-tts-contract.mjs', 'test-audio-ui-v4210.mjs', 'check-v4210-release.mjs', 'run-v4210-audio.mjs']) if (!build.includes(token)) throw new Error(`Build pipeline is missing ${token}`);

console.log('V4.21.0 release gate passed: 13 articles, lazy/private audio metadata, mobile+desktop seek-to-text, 11+2 Cloud rollout boundary, explicit inactive gate, Cloud REST/auth/cost guards, Azure monthly warning, and paused experiments kept out.');
