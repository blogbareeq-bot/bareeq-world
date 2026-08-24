import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ARTICLE_IDS = [
  'ai-agents-future-now',
  'ai-as-coworker-future-of-human-work',
];
const RELEASE_ID = process.env.BAREEQ_GEMINI_BASELINE_RELEASE_ID?.trim() || 'gemini-sadaltager-live-20260824';
const ORIGIN = (process.env.BAREEQ_GEMINI_BASELINE_ORIGIN?.trim() || 'https://bareeqworld.com').replace(/\/$/, '');
const OUTPUT_ROOT = path.join(ROOT, 'audio-releases', RELEASE_ID, 'articles');
const LOCK_FILE = path.join(ROOT, 'scripts', 'bundled-gemini-audio-map.json');
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const HEX_256 = /^[a-f0-9]{64}$/;

const sha = (value) => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const keyFor = (id) => sha(id).slice(0, 16);

assert(SAFE_ID.test(RELEASE_ID), 'Gemini baseline release id is unsafe.');
const origin = new URL(ORIGIN);
assert(origin.protocol === 'https:' && origin.hostname === 'bareeqworld.com', 'Gemini baseline capture accepts only the official HTTPS origin.');

async function fetchBytes(url, label) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Bareeq-Audio-Baseline-Capture/4.21.5' } });
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100) throw new Error(`${label} is unexpectedly small.`);
  return bytes;
}

async function fetchJson(url, label) {
  const bytes = await fetchBytes(url, label);
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}

const targetRoot = path.dirname(OUTPUT_ROOT);
const tempRoot = `${targetRoot}.tmp-${process.pid}`;
await rm(tempRoot, { recursive: true, force: true });
await mkdir(path.join(tempRoot, 'articles'), { recursive: true });

const articles = [];
let fileCount = 0;
let totalBytes = 0;
try {
  for (const articleId of ARTICLE_IDS) {
    const audioKey = keyFor(articleId);
    const manifestUrl = `${ORIGIN}/audio/articles/${audioKey}/manifest.json`;
    const { bytes: manifestBytes, value: manifest } = await fetchJson(manifestUrl, `${articleId}: production manifest`);
    assert(manifest?.version === 3 && manifest.generatorVersion === 8, `${articleId}: unsupported production manifest version.`);
    assert(manifest.articleId === articleId, `${articleId}: production manifest article id mismatch.`);
    assert(manifest.provider === 'Google Gemini API' && manifest.model === 'gemini-3.1-flash-tts-preview', `${articleId}: source is not approved Gemini Sadaltager audio.`);
    assert(manifest.language === 'ar' && manifest.outputFormat === 'audio-48khz-96kbitrate-mono-mp3', `${articleId}: source audio format changed.`);
    assert(manifest.defaultVoice === 'sadaltager' && Array.isArray(manifest.voices) && manifest.voices.length === 1 && manifest.voices[0]?.providerVoice === 'Sadaltager', `${articleId}: source voice changed.`);
    assert(typeof manifest.sourceHash === 'string' && HEX_256.test(manifest.sourceHash), `${articleId}: source fingerprint is invalid.`);
    assert(Array.isArray(manifest.parts) && manifest.parts.length, `${articleId}: source audio parts are missing.`);

    const destination = path.join(tempRoot, 'articles', audioKey);
    await mkdir(destination, { recursive: true });
    const parts = [];
    for (const [index, part] of manifest.parts.entries()) {
      assert(Array.isArray(part?.sync) && part.sync.length, `${articleId}: source sync data is missing at part ${index + 1}.`);
      const asset = part.audio?.sadaltager;
      const prefix = `/audio/articles/${audioKey}/`;
      assert(typeof asset?.src === 'string' && asset.src.startsWith(prefix), `${articleId}: unsafe source asset path at part ${index + 1}.`);
      const file = path.basename(asset.src);
      assert(SAFE_ID.test(file) && file.endsWith('.mp3') && file === asset.src.slice(prefix.length), `${articleId}: unsafe MP3 filename at part ${index + 1}.`);
      assert(Number.isInteger(asset.bytes) && asset.bytes >= 100 && HEX_256.test(asset.sha256 || '') && Number(asset.durationSeconds) > 0, `${articleId}: source asset metadata is incomplete at part ${index + 1}.`);
      const bytes = await fetchBytes(`${ORIGIN}${asset.src}`, `${articleId}: MP3 ${index + 1}`);
      assert(bytes.length === asset.bytes && sha(bytes) === asset.sha256, `${articleId}: production MP3 integrity check failed at part ${index + 1}.`);
      await writeFile(path.join(destination, file), bytes);
      parts.push({ file, bytes: asset.bytes, durationSeconds: asset.durationSeconds, sha256: asset.sha256 });
      fileCount += 1;
      totalBytes += bytes.length;
    }
    await writeFile(path.join(destination, 'source-manifest.json'), manifestBytes);
    articles.push({
      articleId,
      audioKey,
      sourceHash: manifest.sourceHash,
      sourceManifestSha256: sha(manifestBytes),
      parts,
    });
  }

  const lock = {
    version: 1,
    schema: 'bareeq.bundled-gemini.lock.v1',
    releaseId: RELEASE_ID,
    capturedAt: new Date().toISOString(),
    sourceOrigin: ORIGIN,
    bundleRoot: path.relative(ROOT, path.join(targetRoot, 'articles')).replace(/\\/g, '/'),
    articles,
  };
  const pendingLock = `${LOCK_FILE}.tmp-${process.pid}`;
  await writeFile(pendingLock, `${JSON.stringify(lock, null, 2)}\n`);
  await rm(targetRoot, { recursive: true, force: true });
  await rename(tempRoot, targetRoot);
  await rename(pendingLock, LOCK_FILE);
} catch (error) {
  await rm(tempRoot, { recursive: true, force: true });
  throw error;
}

console.log(`Captured approved Gemini Sadaltager baseline: ${articles.length} article(s), ${fileCount} MP3 file(s), ${totalBytes.toLocaleString('en-US')} verified byte(s), 0 synthesis requests.`);
