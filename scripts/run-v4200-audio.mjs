import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NODE = process.execPath;
const OLD_CHANGED = [
  'intuition-first-impression-decisions-signature',
  'اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا',
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار',
  'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون'
];
const NEW_ARTICLE = 'ai-as-coworker-future-of-human-work';
const EXISTING_SADALTAGER = 'ai-agents-future-now';
const skipIds = [...OLD_CHANGED, NEW_ARTICLE].join(',');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const audioKeyFor = (id) => sha(id).slice(0, 16);

function runStrict(script, env = {}) {
  const result = spawnSync(NODE, [script], { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status ?? 'unknown'}`);
}

function runAttempt(script, env = {}) {
  const result = spawnSync(NODE, [script], { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) {
    console.warn(`⚠ ${script} could not start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.warn(`⚠ ${script} exited with status ${result.status}; fallback evaluation will continue.`);
    return false;
  }
  return true;
}

async function hasCompleteVoice(articleId, provider, voiceId) {
  const dir = path.join('public', 'audio', 'articles', audioKeyFor(articleId));
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return false; }
  if (manifest?.articleId !== articleId || manifest?.provider !== provider || manifest?.defaultVoice !== voiceId) return false;
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) return false;
  for (const part of manifest.parts) {
    const asset = part?.audio?.[voiceId];
    if (!asset?.src || !asset.src.endsWith('.mp3')) return false;
    const local = path.join('public', asset.src.replace(/^\//, ''));
    try { await access(local); } catch { return false; }
  }
  return true;
}

// Keep all existing production audio out of synthesis APIs.
runStrict('scripts/import-bundled-azure-audio.mjs', { BAREEQ_BUNDLED_SKIP_IDS: skipIds });
runStrict('scripts/import-studio-audio.mjs', { BAREEQ_STUDIO_SKIP_IDS: skipIds });

// The seven V4.19 changed articles must be restored from production only.
// If cache restore fails, the build stops before any Azure synthesis for those articles.
runStrict('scripts/generate-audio.mjs', {
  BAREEQ_TTS_PROVIDER: 'azure',
  BAREEQ_AZURE_HAMED_ONLY: '1',
  BAREEQ_TTS_CACHE_ONLY: '1',
  BAREEQ_TTS_INCLUDE_IDS: OLD_CHANGED.join(',')
});

// Preserve the already-published Sadaltager article from production cache only.
runStrict('scripts/generate-audio.mjs', {
  BAREEQ_TTS_PROVIDER: 'gemini',
  BAREEQ_TTS_CACHE_ONLY: '1',
  BAREEQ_TTS_INCLUDE_IDS: EXISTING_SADALTAGER
});

// New article policy:
// 1) Gemini automatically checks production cache first.
// 2) If no matching cache exists, attempt Sadaltager synthesis.
// 3) If Gemini does not leave a complete atomic article (429, quota, missing key,
//    malformed response, timeout, or build budget), fall back to Azure Hamed ONLY
//    for this one article. Azure also checks production cache before synthesis.
console.log(`V4.20.0 coworker audio: trying production Gemini cache / Sadaltager first for ${NEW_ARTICLE}.`);
runAttempt('scripts/generate-audio.mjs', {
  BAREEQ_TTS_PROVIDER: 'gemini',
  BAREEQ_TTS_INCLUDE_IDS: NEW_ARTICLE
});

if (await hasCompleteVoice(NEW_ARTICLE, 'Google Gemini API', 'sadaltager')) {
  console.log('✓ Coworker article audio ready with Gemini Sadaltager; Azure fallback was not called.');
} else {
  console.warn('⚠ Coworker Sadaltager is not complete. Falling back to Azure Hamed for this article only.');
  runAttempt('scripts/generate-audio.mjs', {
    BAREEQ_TTS_PROVIDER: 'azure',
    BAREEQ_AZURE_HAMED_ONLY: '1',
    BAREEQ_TTS_INCLUDE_IDS: NEW_ARTICLE
  });
  if (!await hasCompleteVoice(NEW_ARTICLE, 'Microsoft Azure AI Speech', 'hamed')) {
    throw new Error('V4.20.0 audio safety stop: coworker article has neither complete Sadaltager nor complete Hamed audio. No publish allowed.');
  }
  console.log('✓ Coworker article audio ready with Azure Hamed fallback.');
}

console.log('V4.20.0 audio orchestration complete: old audio is cache-only; coworker uses cache → Gemini Sadaltager → Azure Hamed fallback.');
