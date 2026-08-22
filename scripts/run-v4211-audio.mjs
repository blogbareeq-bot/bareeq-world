import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PENDING_CLOUD, RETAINED_GEMINI } from './cloud-tts-rollout.mjs';

const NODE = process.execPath;
const LEGACY_HAMED_CACHE = [
  'intuition-first-impression-decisions-signature',
  'اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا',
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار',
  'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون',
];
const COWORKER = 'ai-as-coworker-future-of-human-work';
const SKIP_STALE_FALLBACKS = [...LEGACY_HAMED_CACHE, COWORKER].join(',');
const ALL_ARTICLES = [...RETAINED_GEMINI, ...PENDING_CLOUD];

const sha = (value) => createHash('sha256').update(value).digest('hex');
const audioKeyFor = (id) => sha(id).slice(0, 16);

function cleanTemporaryAudioRestores() {
  const articleRoot = path.resolve('public', 'audio', 'articles');
  let entries = [];
  try { entries = readdirSync(articleRoot, { withFileTypes: true }); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/\.restore-\d+$/.test(entry.name)) continue;
    const directory = path.join(articleRoot, entry.name);
    if (path.dirname(directory) !== articleRoot) throw new Error(`Refusing to clean an unexpected audio path: ${directory}`);
    rmSync(directory, { recursive: true, force: true });
  }
}

// A failed or interrupted cache restore must never be copied into the static
// site. The exit hook is synchronous, so it also covers deliberate early exits
// (for example when the Gemini key is intentionally absent).
process.on('exit', cleanTemporaryAudioRestores);

function runStrict(script, args = [], env = {}) {
  const result = spawnSync(NODE, [script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status ?? 'unknown'}`);
  cleanTemporaryAudioRestores();
}

async function readCompleteManifest(articleId) {
  const dir = path.join('public', 'audio', 'articles', audioKeyFor(articleId));
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return null; }
  if (manifest?.articleId !== articleId || !Array.isArray(manifest.parts) || !manifest.parts.length) return null;
  if (!manifest.defaultVoice || !Array.isArray(manifest.voices) || !manifest.voices.some((voice) => voice?.id === manifest.defaultVoice)) return null;
  for (const part of manifest.parts) {
    const asset = part?.audio?.[manifest.defaultVoice];
    if (!asset?.src || !asset.src.endsWith('.mp3') || !(asset.durationSeconds > 0)) return null;
    try { await access(path.join('public', asset.src.replace(/^\//, ''))); }
    catch { return null; }
  }
  return manifest;
}

async function hasCompleteVoice(articleId, { provider, model, language, voiceId }) {
  const manifest = await readCompleteManifest(articleId);
  return Boolean(manifest
    && manifest.provider === provider
    && manifest.model === model
    && manifest.language === language
    && manifest.defaultVoice === voiceId);
}

async function assertCompleteBaseline(label) {
  const missing = [];
  for (const articleId of ALL_ARTICLES) if (!await readCompleteManifest(articleId)) missing.push(articleId);
  if (missing.length) throw new Error(`V4.21.1 ${label} safety stop: incomplete production audio for ${missing.join(', ')}.`);
}

async function countGeminiCoverage() {
  let count = 0;
  for (const articleId of ALL_ARTICLES) {
    const manifest = await readCompleteManifest(articleId);
    if (manifest?.provider === 'Google Gemini API' && manifest?.defaultVoice === 'sadaltager') count += 1;
  }
  return count;
}

const freeRolloutRaw = process.env.BAREEQ_GEMINI_FREE_ROLLOUT?.trim() || '1';
if (!['0', '1'].includes(freeRolloutRaw)) throw new Error('BAREEQ_GEMINI_FREE_ROLLOUT must be 0 or 1.');
const freeRolloutEnabled = freeRolloutRaw === '1';
const freeArticleLimitRaw = process.env.BAREEQ_GEMINI_FREE_ARTICLES_PER_BUILD?.trim() || '1';
if (freeArticleLimitRaw !== '1') throw new Error('BAREEQ_GEMINI_FREE_ARTICLES_PER_BUILD must remain 1 for atomic free-tier rollout safety.');

if (process.env.BAREEQ_CLOUD_TTS_ACTIVATE !== '1') {
  console.log('V4.21.1 free-tier mode: paid Google Cloud TTS remains inactive; rebuilding the approved mixed-audio baseline before any Gemini free-quota attempt.');

  runStrict('scripts/import-bundled-azure-audio.mjs', [], { BAREEQ_BUNDLED_SKIP_IDS: SKIP_STALE_FALLBACKS });
  runStrict('scripts/import-studio-audio.mjs', [], { BAREEQ_STUDIO_SKIP_IDS: SKIP_STALE_FALLBACKS });

  // The two already-published Sadaltager articles are mandatory and cache-only.
  runStrict('scripts/generate-audio.mjs', [], {
    BAREEQ_TTS_PROVIDER: 'gemini',
    BAREEQ_TTS_CACHE_ONLY: '1',
    BAREEQ_TTS_CACHE_ALLOW_MISSING: '',
    BAREEQ_TTS_INCLUDE_IDS: RETAINED_GEMINI.join(','),
    BAREEQ_AUDIO_ALLOW_PARTIAL: '',
  });

  // Restore any of the eleven articles completed on earlier free-tier deployments.
  // Missing Gemini recordings are expected here and never trigger synthesis.
  runStrict('scripts/generate-audio.mjs', [], {
    BAREEQ_TTS_PROVIDER: 'gemini',
    BAREEQ_TTS_CACHE_ONLY: '1',
    BAREEQ_TTS_CACHE_ALLOW_MISSING: '1',
    BAREEQ_TTS_INCLUDE_IDS: PENDING_CLOUD.join(','),
    BAREEQ_AUDIO_ALLOW_PARTIAL: '',
  });

  // Only unresolved V4.19 articles need their current-source Hamed cache restored.
  const unresolvedHamed = [];
  for (const articleId of LEGACY_HAMED_CACHE) {
    if (!await hasCompleteVoice(articleId, {
      provider: 'Google Gemini API',
      model: 'gemini-3.1-flash-tts-preview',
      language: 'ar',
      voiceId: 'sadaltager',
    })) unresolvedHamed.push(articleId);
  }
  if (unresolvedHamed.length) {
    runStrict('scripts/generate-audio.mjs', [], {
      BAREEQ_TTS_PROVIDER: 'azure',
      BAREEQ_AZURE_HAMED_ONLY: '1',
      BAREEQ_TTS_CACHE_ONLY: '1',
      BAREEQ_TTS_CACHE_ALLOW_MISSING: '',
      BAREEQ_TTS_INCLUDE_IDS: unresolvedHamed.join(','),
      BAREEQ_AUDIO_ALLOW_PARTIAL: '',
    });
  }

  await assertCompleteBaseline('fallback baseline');

  if (!freeRolloutEnabled) {
    console.log('V4.21.1 Gemini free-tier rollout is paused by BAREEQ_GEMINI_FREE_ROLLOUT=0; 0 synthesis requests were sent.');
    process.exit(0);
  }
  if (!process.env.GEMINI_API_KEY?.trim()) {
    console.log('V4.21.1 Gemini free-tier rollout is ready but GEMINI_API_KEY is absent; approved fallback audio is published with 0 synthesis requests.');
    process.exit(0);
  }

  console.log('V4.21.1 Gemini free-tier rollout: restoring completed Sadaltager cache, then attempting exactly one unresolved article atomically in this deployment.');
  runStrict('scripts/generate-audio.mjs', [], {
    BAREEQ_TTS_PROVIDER: 'gemini',
    BAREEQ_TTS_INCLUDE_IDS: PENDING_CLOUD.join(','),
    BAREEQ_TTS_CACHE_ONLY: '',
    BAREEQ_TTS_CACHE_ALLOW_MISSING: '',
    BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD: freeArticleLimitRaw,
    BAREEQ_AUDIO_ALLOW_PARTIAL: '',
  });

  await assertCompleteBaseline('post-Gemini rollout');
  const geminiCoverage = await countGeminiCoverage();
  console.log(`V4.21.1 free-tier deployment ready: ${geminiCoverage}/13 article(s) currently use Gemini Sadaltager; remaining articles keep approved Hamed/Cedar audio until a later daily deployment.`);
  process.exit(0);
}

console.log('V4.21.1 paid activation mode: preparing the approved baseline before deliberate Google Cloud TTS synthesis.');
runStrict('scripts/import-bundled-azure-audio.mjs', [], { BAREEQ_BUNDLED_SKIP_IDS: SKIP_STALE_FALLBACKS });
runStrict('scripts/import-studio-audio.mjs', [], { BAREEQ_STUDIO_SKIP_IDS: SKIP_STALE_FALLBACKS });

runStrict('scripts/generate-audio.mjs', [], {
  BAREEQ_TTS_PROVIDER: 'gemini',
  BAREEQ_TTS_CACHE_ONLY: '1',
  BAREEQ_TTS_CACHE_ALLOW_MISSING: '',
  BAREEQ_TTS_INCLUDE_IDS: RETAINED_GEMINI.join(','),
  BAREEQ_AUDIO_ALLOW_PARTIAL: '',
});

for (const articleId of RETAINED_GEMINI) {
  if (!await hasCompleteVoice(articleId, {
    provider: 'Google Gemini API',
    model: 'gemini-3.1-flash-tts-preview',
    language: 'ar',
    voiceId: 'sadaltager',
  })) throw new Error(`V4.21.1 safety stop: retained Gemini audio is incomplete for ${articleId}.`);
}

runStrict('scripts/generate-audio.mjs', [], {
  BAREEQ_TTS_PROVIDER: 'google-cloud',
  BAREEQ_TTS_INCLUDE_IDS: PENDING_CLOUD.join(','),
  BAREEQ_TTS_CACHE_ONLY: '',
  BAREEQ_TTS_CACHE_ALLOW_MISSING: '',
  BAREEQ_AUDIO_ALLOW_PARTIAL: '',
});

for (const articleId of PENDING_CLOUD) {
  if (!await hasCompleteVoice(articleId, {
    provider: 'Google Cloud Text-to-Speech',
    model: 'gemini-2.5-flash-tts',
    language: 'ar-EG',
    voiceId: 'sadaltager',
  })) throw new Error(`V4.21.1 safety stop: Google Cloud TTS audio is incomplete for ${articleId}.`);
}

console.log(`V4.21.1 Cloud TTS activation complete: ${PENDING_CLOUD.length} pending article(s) generated/restored with Gemini 2.5 Flash TTS, while ${RETAINED_GEMINI.length} existing Sadaltager article(s) were retained from production cache.`);
