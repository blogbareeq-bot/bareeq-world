import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ROOT = process.cwd();
const LOCK_FILE = path.join(ROOT, 'scripts', 'bundled-gemini-audio-map.json');
const AUDIO_ROOT = path.join(ROOT, 'public', 'audio', 'articles');
const EXPECTED_ARTICLES = new Set([
  'ai-agents-future-now',
  'ai-as-coworker-future-of-human-work',
]);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const HEX_256 = /^[a-f0-9]{64}$/;
const DISCLOSURE = 'الصوت مولّد بالذكاء الاصطناعي وليس صوتًا بشريًا.';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const keyFor = (id) => sha(id).slice(0, 16);
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const normalizeMatchText = (text) => text
  .normalize('NFKD')
  .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
const resolveInside = (root, relative, label) => {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.includes('\0'), `${label} must be a safe relative path.`);
  const resolved = path.resolve(root, relative);
  assert(resolved.startsWith(`${path.resolve(root)}${path.sep}`), `${label} escapes the approved Gemini bundle.`);
  return resolved;
};

let lock;
try { lock = JSON.parse(await readFile(LOCK_FILE, 'utf8')); }
catch (error) { throw new Error(`Bundled Gemini audio lock is missing or invalid: ${error.message}`); }
assert(lock.version === 1 && lock.schema === 'bareeq.bundled-gemini.lock.v1', 'Bundled Gemini audio lock schema is unsupported.');
assert(SAFE_ID.test(lock.releaseId || ''), 'Bundled Gemini release id is unsafe.');
assert(typeof lock.bundleRoot === 'string' && lock.bundleRoot, 'Bundled Gemini bundle root is missing.');
assert(Array.isArray(lock.articles) && lock.articles.length === EXPECTED_ARTICLES.size, 'Exactly the two retained Gemini articles must be bundled.');
const bundleRoot = resolveInside(ROOT, lock.bundleRoot, 'Bundled Gemini bundle root');

const speechPlan = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-audio.mjs'), '--speech-qa-json'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
}));
const speechById = new Map(speechPlan.map((article) => [article.id, article]));
const seenArticleIds = new Set();
const seenAudioKeys = new Set();
await mkdir(AUDIO_ROOT, { recursive: true });

let importedParts = 0;
let importedBytes = 0;
for (const config of lock.articles) {
  assert(typeof config?.articleId === 'string' && EXPECTED_ARTICLES.has(config.articleId) && !seenArticleIds.has(config.articleId), 'Bundled Gemini article ids must be exactly the retained pair.');
  assert(SAFE_ID.test(config.audioKey || '') && !seenAudioKeys.has(config.audioKey), `${config.articleId}: audio key is unsafe or repeated.`);
  assert(config.audioKey === keyFor(config.articleId), `${config.articleId}: audio key does not match the article id.`);
  assert(HEX_256.test(config.sourceHash || '') && HEX_256.test(config.sourceManifestSha256 || ''), `${config.articleId}: source hashes are invalid.`);
  assert(Array.isArray(config.parts) && config.parts.length, `${config.articleId}: locked MP3 parts are missing.`);
  seenArticleIds.add(config.articleId);
  seenAudioKeys.add(config.audioKey);

  const sourceRoot = resolveInside(bundleRoot, config.audioKey, `${config.articleId}: source directory`);
  const sourceManifestFile = path.join(sourceRoot, 'source-manifest.json');
  const sourceManifestRaw = await readFile(sourceManifestFile, 'utf8');
  let manifest;
  try { manifest = JSON.parse(sourceManifestRaw); }
  catch (error) { throw new Error(`${config.articleId}: source manifest is invalid JSON: ${error.message}`); }
  assert(sha(sourceManifestRaw) === config.sourceManifestSha256, `${config.articleId}: source manifest SHA-256 changed.`);
  assert(manifest.version === 3 && manifest.generatorVersion === 8 && manifest.syncVersion === 1, `${config.articleId}: source manifest version changed.`);
  assert(manifest.articleId === config.articleId && manifest.sourceHash === config.sourceHash, `${config.articleId}: source identity changed.`);
  assert(manifest.provider === 'Google Gemini API' && manifest.model === 'gemini-3.1-flash-tts-preview', `${config.articleId}: source is not approved Gemini audio.`);
  assert(manifest.language === 'ar' && manifest.outputFormat === 'audio-48khz-96kbitrate-mono-mp3' && manifest.defaultVoice === 'sadaltager', `${config.articleId}: source audio format changed.`);
  assert(manifest.syncMethod === 'paragraph-weighted' && manifest.disclosure === DISCLOSURE, `${config.articleId}: source synchronization/disclosure changed.`);
  assert(Array.isArray(manifest.voices) && manifest.voices.length === 1 && manifest.voices[0]?.id === 'sadaltager' && manifest.voices[0]?.providerVoice === 'Sadaltager', `${config.articleId}: source voice changed.`);
  assert(Array.isArray(manifest.parts) && manifest.parts.length === config.parts.length, `${config.articleId}: source part count changed.`);

  const article = speechById.get(config.articleId);
  assert(article, `${config.articleId}: current article source is missing or draft.`);
  assert(article.title === manifest.title, `${config.articleId}: current article title differs from the approved Gemini recording.`);
  const synchronized = manifest.parts.flatMap((part) => part?.sync || []);
  assert(synchronized.length === article.segments.length, `${config.articleId}: synchronization block count differs from the current article.`);
  synchronized.forEach((entry, index) => {
    const segment = article.segments[index];
    assert(entry?.id === segment.id && entry.type === segment.type, `${config.articleId}: synchronization identity changed at block ${index + 1}.`);
    assert(entry.match === normalizeMatchText(segment.visibleText).slice(0, 120), `${config.articleId}: synchronized text changed at ${entry.id}.`);
    assert(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end, `${config.articleId}: invalid synchronization timing at ${entry.id}.`);
  });

  const finalDir = path.join(AUDIO_ROOT, config.audioKey);
  const tempDir = `${finalDir}.gemini-bundled-next`;
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  for (const [index, part] of manifest.parts.entries()) {
    const expected = config.parts[index];
    const asset = part?.audio?.sadaltager;
    const prefix = `/audio/articles/${config.audioKey}/`;
    assert(SAFE_ID.test(expected?.file || '') && expected.file.endsWith('.mp3'), `${config.articleId}: unsafe MP3 filename at part ${index + 1}.`);
    assert(asset?.src === `${prefix}${expected.file}`, `${config.articleId}: source MP3 filename changed at part ${index + 1}.`);
    assert(Number(asset?.bytes) === Number(expected.bytes) && asset?.sha256 === expected.sha256 && Number(asset?.durationSeconds) === Number(expected.durationSeconds), `${config.articleId}: source MP3 metadata changed at part ${index + 1}.`);
    assert(HEX_256.test(expected.sha256 || '') && Number(expected.durationSeconds) > 0 && Number.isInteger(Number(expected.bytes)), `${config.articleId}: locked MP3 metadata is incomplete at part ${index + 1}.`);
    const sourceFile = resolveInside(sourceRoot, expected.file, `${config.articleId}: part ${index + 1}`);
    const bytes = await readFile(sourceFile);
    assert(bytes.length === Number(expected.bytes) && sha(bytes) === expected.sha256, `${config.articleId}: MP3 integrity check failed at part ${index + 1}.`);
    const durationSeconds = mp3DurationSeconds(bytes);
    assert(Math.abs(durationSeconds - Number(expected.durationSeconds)) <= 0.1, `${config.articleId}: MP3 duration changed at part ${index + 1}.`);
    await copyFile(sourceFile, path.join(tempDir, expected.file));
    importedParts += 1;
    importedBytes += bytes.length;
  }
  await writeFile(path.join(tempDir, 'manifest.json'), sourceManifestRaw);
  await rm(finalDir, { recursive: true, force: true });
  await rename(tempDir, finalDir);
}

assert(seenArticleIds.size === EXPECTED_ARTICLES.size, 'Bundled Gemini article set is incomplete.');
console.log(`Bundled Gemini Sadaltager audio imported offline: ${seenArticleIds.size} article(s), ${importedParts} MP3 file(s), ${importedBytes.toLocaleString('en-US')} verified byte(s), 0 synthesis requests.`);
