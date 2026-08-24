import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { PENDING_CLOUD, RETAINED_GEMINI } from './cloud-tts-rollout.mjs';


/*
V4.19 Hotfix-5 compatibility markers for the V4.20 mixed-provider audit.

prepare-v4190.mjs still runs first to establish the V4.19 baseline. Its final
legacy audio-audit patch detects these exact source markers before attempting
to rewrite check-audio-dist.mjs. They are intentionally inert comments: the
real executable validation below is V4.20 mixed-provider aware.

let generatedAzureFallbackArticles = 0;
const generatedAzureFallback = provider === 'gemini'
const progressiveCoverage = generatedArticles + generatedAzureFallbackArticles + importedArticles + bundledArticles;
*/

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const POSTS = path.join(ROOT, 'src', 'content', 'posts');
const NEW_ARTICLE = 'ai-as-coworker-future-of-human-work';
const EXISTING_SADALTAGER = 'ai-agents-future-now';
const OLD_HAMED_CACHE_ONLY = new Set([
  'intuition-first-impression-decisions-signature',
  'اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا',
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار',
  'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون'
]);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex256 = /^[a-f0-9]{64}$/;
const allowedSync = new Set(['paragraph-weighted', 'paragraph-weighted-legacy', 'studio-block-timestamps']);
const cloudActivated = process.env.BAREEQ_CLOUD_TTS_ACTIVATE === '1';

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (!['4.20.0', '4.21.0', '4.21.1', '4.21.2', '4.21.3', '4.21.4', '4.21.5', '4.21.6'].includes(pkg.version)) throw new Error(`Audio-dist audit expected package 4.20.0 baseline or supported 4.21.x successor, got ${pkg.version}.`);
const freeGeminiRollout = ['4.21.1', '4.21.2', '4.21.3', '4.21.4', '4.21.5', '4.21.6'].includes(pkg.version);
const audioArticleRoot = path.join(DIST, 'audio', 'articles');
const temporaryAudioDirectories = (await readdir(audioArticleRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /\.restore-\d+$/.test(entry.name))
  .map((entry) => entry.name);
if (temporaryAudioDirectories.length) throw new Error(`Temporary audio restore directories leaked into dist: ${temporaryAudioDirectories.join(', ')}`);

const postFiles = (await readdir(POSTS)).filter((name) => name.endsWith('.md')).sort();
const published = [];
for (const name of postFiles) {
  const source = await readFile(path.join(POSTS, name), 'utf8');
  if (!/^draft:\s*true\s*$/mi.test(source)) published.push(name.replace(/\.md$/, ''));
}
if (![13, 14, 15].includes(published.length)) throw new Error(`V4.21.6 audio-dist audit expected 13–15 published articles across supported release states, found ${published.length}.`);
if (!published.includes(NEW_ARTICLE)) throw new Error('V4.20 coworker article is missing from the published set.');

let checkedArticles = 0;
let totalParts = 0;
let totalFiles = 0;
const providerCounts = new Map();

function validateProvider(manifest, id) {
  if (manifest.version === 4) {
    if (manifest.provider !== 'OpenAI' || manifest.model !== 'gpt-4o-mini-tts-2025-12-15' ||
        manifest.language !== 'ar' || manifest.outputFormat !== 'mp3' ||
        manifest.syncMethod !== 'studio-block-timestamps' ||
        manifest.defaultVoice !== 'cedar' || manifest.voices?.length !== 1 ||
        manifest.voices?.[0]?.id !== 'cedar' || manifest.voices?.[0]?.providerVoice !== 'cedar') {
      throw new Error(`${id}: invalid approved Studio Cedar manifest.`);
    }
    return 'Studio Cedar';
  }

  if (manifest.version === 5) {
    if (manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' ||
        manifest.language !== 'ar-SA' || manifest.outputFormat !== 'audio-48khz-96kbitrate-mono-mp3' ||
        manifest.syncMethod !== 'paragraph-weighted-legacy' ||
        manifest.defaultVoice !== 'hamed' || manifest.voices?.length !== 1 ||
        manifest.voices?.[0]?.id !== 'hamed' || manifest.voices?.[0]?.providerVoice !== 'ar-SA-HamedNeural') {
      throw new Error(`${id}: invalid bundled Azure Hamed manifest.`);
    }
    return 'Bundled Hamed';
  }

  if (manifest.version !== 3 || manifest.generatorVersion !== 8 || manifest.syncMethod !== 'paragraph-weighted') {
    throw new Error(`${id}: unsupported generated audio manifest version/configuration.`);
  }

  if (manifest.provider === 'Google Gemini API') {
    if (manifest.model !== 'gemini-3.1-flash-tts-preview' || manifest.language !== 'ar' ||
        manifest.outputFormat !== 'audio-48khz-96kbitrate-mono-mp3' ||
        manifest.defaultVoice !== 'sadaltager' || manifest.voices?.length !== 1 ||
        manifest.voices?.[0]?.id !== 'sadaltager' || manifest.voices?.[0]?.providerVoice !== 'Sadaltager') {
      throw new Error(`${id}: invalid Gemini Sadaltager manifest.`);
    }
    return 'Gemini Sadaltager';
  }

  if (manifest.provider === 'Google Cloud Text-to-Speech') {
    if (manifest.model !== 'gemini-2.5-flash-tts' || manifest.language !== 'ar-EG' ||
        manifest.outputFormat !== 'mp3' || manifest.directAudioEncoding !== 'MP3' ||
        manifest.defaultVoice !== 'sadaltager' || manifest.voices?.length !== 1 ||
        manifest.voices?.[0]?.id !== 'sadaltager' || manifest.voices?.[0]?.providerVoice !== 'Sadaltager') {
      throw new Error(`${id}: invalid Google Cloud TTS Sadaltager manifest.`);
    }
    return 'Cloud TTS Sadaltager';
  }

  if (manifest.provider === 'Microsoft Azure AI Speech') {
    if (manifest.model !== 'Neural TTS' || manifest.language !== 'ar-SA' ||
        manifest.outputFormat !== 'audio-48khz-96kbitrate-mono-mp3' ||
        manifest.defaultVoice !== 'hamed' || manifest.voices?.length !== 1 ||
        manifest.voices?.[0]?.id !== 'hamed' || manifest.voices?.[0]?.providerVoice !== 'ar-SA-HamedNeural') {
      throw new Error(`${id}: V4.20 generated Azure fallback must contain Hamed only.`);
    }
    return 'Generated Hamed';
  }

  throw new Error(`${id}: unsupported generated provider ${manifest.provider || 'unknown'}.`);
}

for (const id of published) {
  const key = sha(id).slice(0, 16);
  const manifestFile = path.join(DIST, 'audio', 'articles', key, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); }
  catch { throw new Error(`${id}: production audio manifest is missing or invalid.`); }

  if (manifest.articleId !== id) throw new Error(`${id}: manifest articleId mismatch.`);
  if (manifest.disclosure !== 'الصوت مولّد بالذكاء الاصطناعي وليس صوتًا بشريًا.') throw new Error(`${id}: AI disclosure is missing.`);
  if (!Array.isArray(manifest.voices) || !manifest.voices.length) throw new Error(`${id}: no audio voices.`);
  if (!manifest.voices.some((voice) => voice?.id === manifest.defaultVoice)) throw new Error(`${id}: default voice is not present.`);
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) throw new Error(`${id}: no synchronized audio parts.`);
  if (!allowedSync.has(manifest.syncMethod)) throw new Error(`${id}: unsupported sync method ${manifest.syncMethod}.`);

  const providerKind = validateProvider(manifest, id);
  providerCounts.set(providerKind, (providerCounts.get(providerKind) || 0) + 1);

  if (id === EXISTING_SADALTAGER && providerKind !== 'Gemini Sadaltager') {
    throw new Error(`${id}: existing Sadaltager production cache was not preserved.`);
  }
  if (!cloudActivated && OLD_HAMED_CACHE_ONLY.has(id) && providerKind !== 'Generated Hamed' && !(freeGeminiRollout && providerKind === 'Gemini Sadaltager')) {
    throw new Error(`${id}: protected V4.19 article is no longer the Hamed-only production cache.`);
  }
  if (id === NEW_ARTICLE && !['Gemini Sadaltager', 'Generated Hamed'].includes(providerKind)) {
    throw new Error(`${id}: coworker must finish with Gemini Sadaltager or Azure Hamed fallback.`);
  }
  if (cloudActivated && PENDING_CLOUD.includes(id) && providerKind !== 'Cloud TTS Sadaltager') throw new Error(`${id}: activated Cloud TTS rollout did not produce the required provider.`);
  if (cloudActivated && RETAINED_GEMINI.includes(id) && providerKind !== 'Gemini Sadaltager') throw new Error(`${id}: activated Cloud TTS rollout regenerated an already-compatible Gemini article.`);

  const voiceIds = manifest.voices.map((voice) => voice.id);
  const assetPaths = new Set();
  const syncIds = new Set();

  for (const part of manifest.parts) {
    if (!Array.isArray(part?.sync) || !part.audio || typeof part.audio !== 'object') {
      throw new Error(`${id}: an audio part is missing sync/audio metadata.`);
    }
    let previousStart = -1;
    for (const entry of part.sync) {
      if (!entry || typeof entry.id !== 'string' || syncIds.has(entry.id)) throw new Error(`${id}: invalid/repeated sync id.`);
      if (!(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end) || entry.start < previousStart) {
        throw new Error(`${id}: invalid sync timing for ${entry.id}.`);
      }
      if (manifest.version === 4) {
        if (!Number.isInteger(entry.ordinal) || entry.ordinal < 0) throw new Error(`${id}: Studio sync ordinal is invalid.`);
      } else if (typeof entry.match !== 'string' || entry.match.length < 2) {
        throw new Error(`${id}: generated/bundled sync match hint is missing.`);
      }
      previousStart = entry.start;
      syncIds.add(entry.id);
    }

    for (const voiceId of voiceIds) {
      const asset = part.audio[voiceId];
      const prefix = `/audio/articles/${key}/`;
      if (typeof asset?.src !== 'string' || !asset.src.startsWith(prefix) ||
          asset.src.includes('..') || !asset.src.endsWith('.mp3') || assetPaths.has(asset.src)) {
        throw new Error(`${id}: unsafe or duplicate ${voiceId} audio path.`);
      }
      assetPaths.add(asset.src);
      const local = path.join(DIST, asset.src.replace(/^\//, ''));
      const info = await stat(local).catch(() => null);
      if (!info?.isFile() || info.size < 100 || info.size !== asset.bytes) {
        throw new Error(`${id}: missing/size-mismatched MP3 ${asset.src}.`);
      }
      const bytes = await readFile(local);
      if (asset.sha256 && (!hex256.test(asset.sha256) || sha(bytes) !== asset.sha256)) {
        throw new Error(`${id}: SHA-256 mismatch ${asset.src}.`);
      }
      const duration = mp3DurationSeconds(bytes);
      if (!(asset.durationSeconds > 0) || Math.abs(duration - asset.durationSeconds) > 0.1) {
        throw new Error(`${id}: duration mismatch ${asset.src}.`);
      }
      totalFiles += 1;
    }
    totalParts += 1;
  }

  if (!syncIds.size) throw new Error(`${id}: no synchronized article blocks.`);
  if (assetPaths.size !== manifest.parts.length * voiceIds.length) throw new Error(`${id}: incomplete voice assets.`);

  const html = await readFile(path.join(DIST, 'posts', id, 'index.html'), 'utf8');
  for (const token of ['data-audio-seek', 'الصوت مولّد بالذكاء الاصطناعي', `/audio/articles/${key}/manifest.json`]) {
    if (!html.includes(token)) throw new Error(`${id}: article HTML missing audio token ${token}.`);
  }
  if (html.includes('data-audio-manifest-inline') || html.includes('data-audio-current-voice') || html.includes(manifest.provider) || html.includes(manifest.model)) throw new Error(`${id}: provider/voice manifest data leaked into initial article HTML.`);
  if (html.includes('المقطع 1 من') || html.includes('data-audio-part')) {
    throw new Error(`${id}: internal part details leaked to the reader UI.`);
  }
  checkedArticles += 1;
}

if (checkedArticles !== published.length) throw new Error(`V4.21.6 audio-dist audit expected ${published.length} complete audio articles, checked ${checkedArticles}.`);
if (cloudActivated && (providerCounts.get('Cloud TTS Sadaltager') !== PENDING_CLOUD.length || providerCounts.get('Gemini Sadaltager') !== RETAINED_GEMINI.length)) throw new Error(`Activated rollout must publish exactly ${PENDING_CLOUD.length} Cloud TTS + ${RETAINED_GEMINI.length} retained Gemini articles.`);

const textFiles = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (/\.(?:html|js|json|xml|txt)$/i.test(entry.name)) textFiles.push(full);
  }
}
await collect(DIST);

for (const relative of ['about/index.html', 'contact/index.html', 'terms/index.html']) {
  const html = await readFile(path.join(DIST, relative), 'utf8');
  if (!html.includes('<!--email_off-->') || !html.includes('<!--/email_off-->') || !html.includes('mailto:info@bareeqworld.com')) {
    throw new Error(`${relative}: Cloudflare email-obfuscation exclusion or confirmed mailto link is missing from built HTML.`);
  }
}
for (const file of textFiles) {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (text.includes('/cdn-cgi/l/email-protection')) throw new Error(`Cloudflare email-protection 404 path leaked into ${path.relative(DIST, file)}.`);
}

const secretNames = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AZURE_SPEECH_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CLOUD_ACCESS_TOKEN'];
const secrets = [process.env.GEMINI_API_KEY?.trim(), process.env.OPENAI_API_KEY?.trim(), process.env.AZURE_SPEECH_KEY?.trim(), process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim(), process.env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim()]
  .filter((value) => value?.length >= 12);
for (const file of textFiles) {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const name of secretNames) if (text.includes(name)) throw new Error(`Secret variable name leaked into ${path.relative(DIST, file)}.`);
  for (const secret of secrets) if (text.includes(secret)) throw new Error(`Speech API key leaked into ${path.relative(DIST, file)}.`);
}

const summary = [...providerCounts.entries()].map(([name, count]) => `${name}=${count}`).join(', ');
console.log(`V4.21.6 mixed production audio audit passed: ${checkedArticles}/${published.length} articles, ${totalParts} synchronized parts, ${totalFiles} verified MP3 files; ${summary}; lazy provider metadata and no secret leakage.`);
