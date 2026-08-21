import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PENDING_CLOUD, RETAINED_GEMINI } from './cloud-tts-rollout.mjs';

const NODE = process.execPath;

const sha = (value) => createHash('sha256').update(value).digest('hex');
const audioKeyFor = (id) => sha(id).slice(0, 16);

function runStrict(script, args = [], env = {}) {
  const result = spawnSync(NODE, [script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status ?? 'unknown'}`);
}

async function hasCompleteVoice(articleId, { provider, model, language, voiceId }) {
  const dir = path.join('public', 'audio', 'articles', audioKeyFor(articleId));
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return false; }
  if (manifest?.articleId !== articleId || manifest?.provider !== provider || manifest?.model !== model || manifest?.language !== language || manifest?.defaultVoice !== voiceId) return false;
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) return false;
  for (const part of manifest.parts) {
    const asset = part?.audio?.[voiceId];
    if (!asset?.src || !asset.src.endsWith('.mp3') || !(asset.durationSeconds > 0)) return false;
    try { await access(path.join('public', asset.src.replace(/^\//, ''))); }
    catch { return false; }
  }
  return true;
}

if (process.env.BAREEQ_CLOUD_TTS_ACTIVATE !== '1') {
  console.log('V4.21.0 safe mode: Google Cloud TTS is prepared but inactive; preserving the V4.20 production audio policy with 0 Cloud TTS requests.');
  runStrict('scripts/run-v4200-audio.mjs');
  process.exit(0);
}

console.log('V4.21.0 activation mode: preparing the existing zero-cost audio baseline before any Google Cloud TTS synthesis.');
runStrict('scripts/import-bundled-azure-audio.mjs');
runStrict('scripts/import-studio-audio.mjs');

// Preserve the two already-published Sadaltager articles without regeneration.
runStrict('scripts/generate-audio.mjs', [], {
  BAREEQ_TTS_PROVIDER: 'gemini',
  BAREEQ_TTS_CACHE_ONLY: '1',
  BAREEQ_TTS_INCLUDE_IDS: RETAINED_GEMINI.join(','),
  BAREEQ_AUDIO_ALLOW_PARTIAL: '',
});

for (const articleId of RETAINED_GEMINI) {
  if (!await hasCompleteVoice(articleId, {
    provider: 'Google Gemini API',
    model: 'gemini-3.1-flash-tts-preview',
    language: 'ar',
    voiceId: 'sadaltager',
  })) throw new Error(`V4.21.0 safety stop: retained Gemini audio is incomplete for ${articleId}.`);
}

// The explicit activation flag, credentials, request/character caps, and cache-first
// behavior are all enforced again inside generate-audio.mjs before a paid request.
runStrict('scripts/generate-audio.mjs', [], {
  BAREEQ_TTS_PROVIDER: 'google-cloud',
  BAREEQ_TTS_INCLUDE_IDS: PENDING_CLOUD.join(','),
  BAREEQ_TTS_CACHE_ONLY: '',
  BAREEQ_AUDIO_ALLOW_PARTIAL: '',
});

for (const articleId of PENDING_CLOUD) {
  if (!await hasCompleteVoice(articleId, {
    provider: 'Google Cloud Text-to-Speech',
    model: 'gemini-2.5-flash-tts',
    language: 'ar-EG',
    voiceId: 'sadaltager',
  })) throw new Error(`V4.21.0 safety stop: Google Cloud TTS audio is incomplete for ${articleId}.`);
}

console.log(`V4.21.0 Cloud TTS activation complete: ${PENDING_CLOUD.length} pending article(s) generated/restored with Gemini 2.5 Flash TTS, while ${RETAINED_GEMINI.length} existing Sadaltager article(s) were retained from production cache.`);
