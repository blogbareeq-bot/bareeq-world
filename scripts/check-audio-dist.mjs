import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const root = process.cwd();
const postDir = path.join(root, 'src', 'content', 'posts');
const auditPublicAudio = process.env.BAREEQ_AUDIO_AUDIT_PUBLIC === '1';
const dist = path.join(root, auditPublicAudio ? 'public' : 'dist');
const provider = process.env.BAREEQ_TTS_PROVIDER?.trim().toLowerCase() || 'bundled';
if (!['bundled', 'gemini', 'openai', 'azure'].includes(provider)) throw new Error('BAREEQ_TTS_PROVIDER must be bundled, gemini, openai, or azure.');
const allowPartial = process.env.BAREEQ_AUDIO_ALLOW_PARTIAL === '1';
const expected = provider === 'azure'
  ? { name: 'Microsoft Azure AI Speech', model: 'Neural TTS', language: 'ar-SA', format: 'audio-48khz-96kbitrate-mono-mp3', voices: [['hamed', 'ar-SA-HamedNeural'], ['zariyah', 'ar-SA-ZariyahNeural']] }
  : provider === 'gemini'
    ? { name: 'Google Gemini API', model: 'gemini-3.1-flash-tts-preview', language: 'ar', format: 'audio-48khz-96kbitrate-mono-mp3', voices: [['sadaltager', 'Sadaltager']] }
    : provider === 'openai' ? { name: 'OpenAI', model: 'gpt-4o-mini-tts-2025-12-15', language: 'ar', format: 'mp3', voices: [['cedar', 'cedar'], ['marin', 'marin']] } : null;
const studioMap = JSON.parse(await readFile(path.join(root, 'scripts', 'studio-audio-map.json'), 'utf8'));
const requiredStudioArticles = new Set(['bundled', 'openai'].includes(provider) ? Object.values(studioMap.imports || {}).map((item) => item.articleId) : []);
const bundledMap = JSON.parse(await readFile(path.join(root, 'scripts', 'bundled-azure-audio-map.json'), 'utf8'));
const bundledByArticle = new Map((bundledMap.articles || []).map((item) => [item.articleId, item]));
const requiredBundledArticles = new Set(provider === 'bundled' ? bundledByArticle.keys() : []);
const posts = (await readdir(postDir)).filter((name) => name.endsWith('.md')).sort();
let totalParts = 0;
let totalFiles = 0;
let checkedArticles = 0;
let importedArticles = 0;
let bundledArticles = 0;

const hex256 = /^[a-f0-9]{64}$/;
const sha = (value) => createHash('sha256').update(value).digest('hex');

for (const name of posts) {
  const source = await readFile(path.join(postDir, name), 'utf8');
  if (/^draft:\s*true\s*$/mi.test(source)) continue;
  const id = name.replace(/\.md$/, '');
  const key = sha(id).slice(0, 16);
  const manifestFile = path.join(dist, 'audio', 'articles', key, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); }
  catch {
    if (allowPartial && !requiredStudioArticles.has(id)) continue;
    throw new Error(`${id}: production audio manifest is missing or invalid.`);
  }

  const imported = manifest.version === 4 && manifest.importerVersion === 1;
  const bundled = manifest.version === 5 && manifest.importerVersion === 1;
  if (imported) {
    if (!['bundled', 'openai'].includes(provider) || manifest.provider !== 'OpenAI' || manifest.model !== 'gpt-4o-mini-tts-2025-12-15' || manifest.language !== 'ar' || manifest.outputFormat !== 'mp3' || manifest.syncVersion !== 1 || manifest.syncMethod !== 'studio-block-timestamps') throw new Error(`${id}: imported Studio metadata is invalid.`);
    if (manifest.contractTest || manifest.importedRelease?.targetBareeqVersion !== 'V4.16.0' || !manifest.importedRelease?.releaseId || !hex256.test(manifest.importedRelease?.manifestSha256 || '') || !hex256.test(manifest.importedRelease?.textSha256 || '')) throw new Error(`${id}: imported release provenance is incomplete.`);
    if (manifest.defaultVoice !== 'cedar' || !Array.isArray(manifest.voices) || manifest.voices.length !== 1 || manifest.voices[0]?.id !== 'cedar' || manifest.voices[0]?.providerVoice !== 'cedar' || !(manifest.voices[0]?.totalDurationSeconds > 0)) throw new Error(`${id}: approved Studio pilot must contain the single Cedar voice.`);
    if (!requiredStudioArticles.has(id)) throw new Error(`${id}: unapproved Studio import appeared in production output.`);
    importedArticles += 1;
  } else if (bundled) {
    const config = bundledByArticle.get(id);
    if (provider !== 'bundled' || !config || manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.language !== 'ar-SA' || manifest.outputFormat !== 'audio-48khz-96kbitrate-mono-mp3' || manifest.syncVersion !== 1 || manifest.syncMethod !== 'paragraph-weighted-legacy') throw new Error(`${id}: bundled Azure metadata is invalid.`);
    if (manifest.contractTest || manifest.sourceHash !== config.sourceSnapshotSha256 || manifest.bundledRelease?.schema !== 'bareeq.bundled-azure.v1' || manifest.bundledRelease?.releaseId !== bundledMap.releaseId || manifest.bundledRelease?.sourceManifestSha256 !== config.sourceManifestSha256 || manifest.bundledRelease?.legacySourceHash !== config.legacySourceHash) throw new Error(`${id}: bundled Azure provenance is incomplete or changed.`);
    if (manifest.defaultVoice !== 'hamed' || !Array.isArray(manifest.voices) || manifest.voices.length !== 1 || manifest.voices[0]?.id !== 'hamed' || manifest.voices[0]?.providerVoice !== 'ar-SA-HamedNeural' || !(manifest.voices[0]?.totalDurationSeconds > 0)) throw new Error(`${id}: bundled Azure article must contain exactly the approved Hamed voice.`);
    if (!requiredBundledArticles.has(id) || !Array.isArray(manifest.parts) || manifest.parts.length !== config.parts.length) throw new Error(`${id}: unapproved or incomplete bundled Azure article appeared in production output.`);
    bundledArticles += 1;
  } else {
    if (!expected) throw new Error(`${id}: zero-cost bundled mode may not contain generated audio.`);
    if (manifest.version !== 3 || manifest.generatorVersion !== 7 || manifest.provider !== expected.name || manifest.model !== expected.model || manifest.language !== expected.language || manifest.outputFormat !== expected.format || manifest.syncVersion !== 1 || manifest.syncMethod !== 'paragraph-weighted') throw new Error(`${id}: generated audio metadata does not match ${expected.name}.`);
    if (Boolean(manifest.contractTest) !== (process.env.BAREEQ_TTS_CONTRACT_TEST === '1')) throw new Error(`${id}: contract-test audio escaped its explicit test boundary.`);
    if (manifest.defaultVoice !== expected.voices[0][0] || !Array.isArray(manifest.voices) || manifest.voices.length !== expected.voices.length) throw new Error(`${id}: generated audio requires exactly ${expected.voices.length} ordered listening choice(s).`);
    expected.voices.forEach(([voiceId, providerVoice], index) => {
      const voice = manifest.voices[index];
      if (voice?.id !== voiceId || voice?.providerVoice !== providerVoice || typeof voice?.label !== 'string' || !(voice.totalDurationSeconds > 0)) throw new Error(`${id}: invalid generated voice metadata for ${voiceId}.`);
    });
  }

  if (manifest.disclosure !== 'الصوت مولّد بالذكاء الاصطناعي وليس صوتًا بشريًا.') throw new Error(`${id}: AI-voice disclosure is missing.`);
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) throw new Error(`${id}: audio manifest has no synchronized parts.`);

  const syncIds = new Set();
  const assetPaths = new Set();
  const voices = manifest.voices.map((voice) => voice.id);
  for (const part of manifest.parts) {
    if (!Array.isArray(part.sync) || !part.audio || typeof part.audio !== 'object') throw new Error(`${id}: audio part has no synchronization/audio map.`);
    let previousStart = -1;
    for (const entry of part.sync) {
      if (typeof entry?.id !== 'string' || syncIds.has(entry.id)) throw new Error(`${id}: invalid or repeated synchronized block id.`);
      if (!(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end) || entry.start < previousStart) throw new Error(`${id}: invalid synchronized timing ratios.`);
      if (imported) {
        if (!Number.isInteger(entry.ordinal) || entry.ordinal < 0 || 'match' in entry || 'visibleText' in entry || 'spokenText' in entry) throw new Error(`${id}: Studio synchronization must use text-free DOM ordinals.`);
      } else if (typeof entry.match !== 'string' || entry.match.length < 2) {
        throw new Error(`${id}: generated synchronization requires a matching text hint.`);
      }
      previousStart = entry.start;
      syncIds.add(entry.id);
    }
    for (const voiceId of voices) {
      const asset = part.audio[voiceId];
      const importedPrefix = `/audio/articles/${key}/releases/${manifest.importedRelease?.releaseId}/`;
      const bundledPrefix = `/audio/articles/${key}/releases/${manifest.bundledRelease?.releaseId}/`;
      const generatedPrefix = `/audio/articles/${key}/${voiceId}-part-`;
      const safePrefix = imported ? importedPrefix : bundled ? bundledPrefix : generatedPrefix;
      if (typeof asset?.src !== 'string' || !asset.src.startsWith(safePrefix) || asset.src.includes('..') || !asset.src.endsWith('.mp3') || assetPaths.has(asset.src) || !(asset.durationSeconds > 0)) throw new Error(`${id}: unsafe or invalid ${voiceId} MP3 metadata.`);
      assetPaths.add(asset.src);
      const file = path.join(dist, asset.src.replace(/^\//, ''));
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || info.size < 100 || info.size !== asset.bytes) throw new Error(`${id}: missing, empty, or size-mismatched MP3: ${asset.src}`);
      const bytes = await readFile(file);
      if (asset.sha256 && (!hex256.test(asset.sha256) || sha(bytes) !== asset.sha256)) throw new Error(`${id}: MP3 SHA-256 mismatch in ${asset.src}`);
      const duration = mp3DurationSeconds(bytes);
      if (Math.abs(duration - asset.durationSeconds) > 0.1) throw new Error(`${id}: duration mismatch in ${asset.src}`);
      totalFiles += 1;
    }
    totalParts += 1;
  }
  if (!syncIds.size) throw new Error(`${id}: production manifest has no synchronized article blocks.`);
  if (assetPaths.size !== manifest.parts.length * voices.length) throw new Error(`${id}: a synchronized part is missing a voice asset.`);

  if (!auditPublicAudio) {
    const html = await readFile(path.join(dist, 'posts', id, 'index.html'), 'utf8');
    for (const token of ['data-audio-seek', 'الصوت مولّد بالذكاء الاصطناعي', manifest.defaultVoice]) if (!html.includes(token)) throw new Error(`${id}: article HTML is missing audio UI/metadata token ${token}.`);
    if (html.includes('المقطع 1 من') || html.includes('data-audio-part')) throw new Error(`${id}: internal audio-part details leaked into the reader UI.`);
  }
  checkedArticles += 1;
}

if (['bundled', 'openai'].includes(provider) && importedArticles !== requiredStudioArticles.size) throw new Error(`Expected ${requiredStudioArticles.size} approved Studio import(s), found ${importedArticles}.`);
if (provider === 'bundled' && bundledArticles !== requiredBundledArticles.size) throw new Error(`Expected ${requiredBundledArticles.size} approved bundled Azure article(s), found ${bundledArticles}.`);
if (!checkedArticles) throw new Error('No production audio article was audited.');
if (!allowPartial && checkedArticles !== posts.length) throw new Error(`Expected audio for all ${posts.length} articles, audited ${checkedArticles}.`);

const textFiles = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (/\.(?:html|js|json|xml|txt)$/i.test(entry.name)) textFiles.push(full);
  }
}
await collect(dist);
const secretNames = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AZURE_SPEECH_KEY'];
const secrets = [process.env.GEMINI_API_KEY?.trim(), process.env.OPENAI_API_KEY?.trim(), process.env.AZURE_SPEECH_KEY?.trim()].filter((value) => value?.length >= 12);
for (const file of textFiles) {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const name of secretNames) if (text.includes(name)) throw new Error(`Secret variable name leaked into production output: ${path.relative(dist, file)}`);
  for (const secret of secrets) if (text.includes(secret)) throw new Error(`Speech API key leaked into production output: ${path.relative(dist, file)}`);
}

console.log(`Production audio audit passed${auditPublicAudio ? ' at the pre-build public stage' : ''}: ${checkedArticles} article(s), ${importedArticles} approved Studio import(s), ${bundledArticles} bundled Azure Hamed article(s), ${totalParts} synchronized track(s), ${totalFiles} timed MP3 file(s), no text/key leakage.`);
