import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ROOT = process.cwd();
const SKIP_IDS = new Set((process.env.BAREEQ_BUNDLED_SKIP_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const LOCK_FILE = path.join(ROOT, 'scripts', 'bundled-azure-audio-map.json');
const AUDIO_ROOT = path.join(ROOT, 'public', 'audio', 'articles');
const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const DISCLOSURE = 'الصوت مولّد بالذكاء الاصطناعي وليس صوتًا بشريًا.';
const AUDIT_MODE = process.argv.includes('--audit');
const AUDIT_JSON = process.argv.includes('--audit-json');
if (AUDIT_JSON && !AUDIT_MODE) throw new Error('--audit-json requires --audit.');
const unexpectedArg = process.argv.slice(2).find((arg) => !['--audit', '--audit-json'].includes(arg));
if (unexpectedArg) throw new Error(`Unsupported importer argument: ${unexpectedArg}. Supported flags: --audit, --audit-json.`);

const sha = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const audioKeyFor = (id) => sha(id).slice(0, 16);
const normalizeMatchText = (text) => text
  .normalize('NFKD')
  .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
const readJson = async (file, label) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is missing or invalid JSON: ${error.message}`); }
};
const resolveInside = (root, relative, label) => {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.includes('\0'), `${label} must be a safe relative path.`);
  const resolved = path.resolve(root, relative);
  assert(resolved.startsWith(`${path.resolve(root)}${path.sep}`), `${label} escapes the approved bundle.`);
  return resolved;
};
const log = (message) => { if (!AUDIT_JSON) console.log(message); };

// --- Hermetic legacy-validation environment ---------------------------------
// The locked Hamed snapshot is a Legacy contract: it must be computed from the
// immutable published article text through the bundled provider path, exactly
// like the original recording pipeline. Production builds run with
// BAREEQ_TTS_PROVIDER=gemini (or azure/google-cloud) plus TTS state such as
// cache flags, include id lists, contract-test endpoints, budget limits and
// API keys. Inheriting any of that into the --speech-qa-json child switches
// the segment plan to the reviewed Speech Script path (for example 79 segments
// for altadakhom-explained-simply instead of the locked 84 legacy segments)
// and changes the source snapshot hash, producing a false
// "article text/order changed" failure. The child therefore receives a
// minimal runtime base environment with the legacy provider forced; no
// TTS-related variable is inherited, so the legacy snapshot is completely
// independent of the parent build environment.
const LEGACY_CHILD_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_OPTIONS', 'UV_THREADPOOL_SIZE',
]);
const TTS_ENV_PREFIXES = ['BAREEQ_', 'GEMINI_', 'OPENAI_', 'AZURE_', 'GOOGLE_'];

function buildLegacyValidationEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (LEGACY_CHILD_ENV_ALLOWLIST.has(key)) env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (TTS_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new Error(`Refusing to inherit TTS state into the legacy snapshot child: ${key}`);
    }
  }
  env.BAREEQ_TTS_PROVIDER = 'bundled';
  return env;
}

const lock = await readJson(LOCK_FILE, 'Bundled Azure audio lock');
assert(lock.version === 1 && lock.schema === 'bareeq.bundled-azure.lock.v1', 'Bundled Azure audio lock schema is unsupported.');
assert(SAFE_ID.test(lock.releaseId || ''), 'Bundled Azure release id is unsafe.');
assert(Array.isArray(lock.articles) && lock.articles.length === 10, 'Exactly ten approved Azure Hamed articles are required.');
const bundleRoot = path.join(ROOT, lock.bundleRoot);

const speechPlan = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-audio.mjs'), '--speech-qa-json'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
  env: buildLegacyValidationEnv(),
}));
const speechById = new Map(speechPlan.map((article) => [article.id, article]));
const seenArticleIds = new Set();
const seenAudioKeys = new Set();
if (!AUDIT_MODE) await mkdir(AUDIO_ROOT, { recursive: true });

let importedParts = 0;
let importedBytes = 0;
const auditArticles = [];
const snapshotHashFor = (article) => article
  ? sha(JSON.stringify(article.segments.map(({ id, type, visibleText }) => ({ id, type, visibleText }))))
  : null;

for (const config of lock.articles) {
  if (SKIP_IDS.has(config.articleId)) {
    log(`↷ ${config.articleId}: skipped stale bundled Hamed; V4.19 will regenerate matching Hamed.`);
    const planArticle = speechById.get(config.articleId);
    const planSnapshot = snapshotHashFor(planArticle);
    auditArticles.push({
      articleId: config.articleId,
      audioKey: config.audioKey,
      skipped: true,
      verified: false,
      segmentCount: planArticle?.segments?.length ?? 0,
      segmentIds: (planArticle?.segments ?? []).map(({ id }) => id),
      snapshotSha256: planSnapshot,
      lockedSnapshotSha256: config.sourceSnapshotSha256,
      lockMatch: planSnapshot === config.sourceSnapshotSha256,
      partCount: config.parts?.length ?? 0,
      totalBytes: 0,
      totalDurationSeconds: 0,
    });
    continue;
  }

  assert(typeof config.articleId === 'string' && config.articleId && !seenArticleIds.has(config.articleId), 'Bundled Azure article ids must be present and unique.');
  assert(SAFE_ID.test(config.audioKey || '') && !seenAudioKeys.has(config.audioKey), `${config.articleId}: audio key is unsafe or repeated.`);
  assert(config.audioKey === audioKeyFor(config.articleId), `${config.articleId}: audio key does not match the article id.`);
  assert(HEX_256.test(config.sourceSnapshotSha256 || '') && HEX_256.test(config.sourceManifestSha256 || ''), `${config.articleId}: source hashes are invalid.`);
  assert(Array.isArray(config.parts) && config.parts.length, `${config.articleId}: locked MP3 parts are missing.`);
  seenArticleIds.add(config.articleId);
  seenAudioKeys.add(config.audioKey);

  const sourceRoot = path.join(bundleRoot, config.audioKey);
  const sourceManifestFile = path.join(sourceRoot, 'source-manifest.json');
  const sourceManifestRaw = await readFile(sourceManifestFile, 'utf8');
  const source = JSON.parse(sourceManifestRaw);
  assert(sha(sourceManifestRaw) === config.sourceManifestSha256, `${config.articleId}: source manifest SHA-256 changed.`);
  assert(source.version === 2 && source.provider === 'Microsoft Azure AI Speech' && source.model === 'Neural TTS', `${config.articleId}: source is not the approved Azure Neural TTS manifest.`);
  assert(source.language === 'ar-SA' && source.outputFormat === 'audio-48khz-96kbitrate-mono-mp3', `${config.articleId}: source audio format changed.`);
  assert(source.articleId === config.articleId && source.voice === 'ar-SA-HamedNeural', `${config.articleId}: article or voice identity changed.`);
  assert(source.sourceHash === config.legacySourceHash, `${config.articleId}: legacy source hash changed.`);
  assert(Array.isArray(source.parts) && source.parts.length === config.parts.length, `${config.articleId}: source part count changed.`);

  const article = speechById.get(config.articleId);
  assert(article, `${config.articleId}: current article source is missing.`);
  assert(article.title === source.title, `${config.articleId}: current article title differs from the approved recording.`);
  const sourceSnapshot = article.segments.map(({ id, type, visibleText }) => ({ id, type, visibleText }));
  assert(sha(JSON.stringify(sourceSnapshot)) === config.sourceSnapshotSha256, `${config.articleId}: article text/order changed after the approved Hamed recording.`);
  const synchronized = source.parts.flatMap((part) => part.sync || []);
  assert(synchronized.length === article.segments.length, `${config.articleId}: synchronization block count differs from the current article.`);
  synchronized.forEach((entry, index) => {
    const segment = article.segments[index];
    assert(entry.id === segment.id && entry.type === segment.type, `${config.articleId}: synchronization identity changed at block ${index + 1}.`);
    assert(entry.match === normalizeMatchText(segment.visibleText).slice(0, 120), `${config.articleId}: synchronized text changed at ${entry.id}.`);
    assert(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end, `${config.articleId}: invalid synchronization timing at ${entry.id}.`);
  });

  const finalDir = path.join(AUDIO_ROOT, config.audioKey);
  const tempDir = `${finalDir}.bundled-next`;
  const backupDir = `${finalDir}.bundled-previous`;
  if (!AUDIT_MODE) {
    if (!(await exists(finalDir)) && await exists(backupDir)) await rename(backupDir, finalDir);
    else await rm(backupDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
  const immutableDir = path.join(tempDir, 'releases', lock.releaseId);
  if (!AUDIT_MODE) {
    const previousReleases = path.join(finalDir, 'releases');
    if (await exists(previousReleases)) await cp(previousReleases, path.join(tempDir, 'releases'), { recursive: true });
    await mkdir(immutableDir, { recursive: true });
  }

  let totalDurationSeconds = 0;
  const parts = [];
  for (let index = 0; index < source.parts.length; index += 1) {
    const sourcePart = source.parts[index];
    const expected = config.parts[index];
    assert(SAFE_ID.test(expected.file || '') && expected.file.endsWith('.mp3'), `${config.articleId}: unsafe MP3 filename at part ${index + 1}.`);
    assert(path.basename(sourcePart.src || '') === expected.file, `${config.articleId}: source MP3 filename changed at part ${index + 1}.`);
    assert(Number(sourcePart.bytes) === Number(expected.bytes), `${config.articleId}: source MP3 size metadata changed at part ${index + 1}.`);
    assert(HEX_256.test(expected.sha256 || '') && Number(expected.durationSeconds) > 0, `${config.articleId}: locked MP3 metadata is incomplete at part ${index + 1}.`);
    const sourceFile = resolveInside(sourceRoot, expected.file, `${config.articleId}: part ${index + 1}`);
    const bytes = await readFile(sourceFile);
    assert(bytes.length === Number(expected.bytes) && sha(bytes) === expected.sha256, `${config.articleId}: MP3 integrity check failed at part ${index + 1}.`);
    const durationSeconds = mp3DurationSeconds(bytes);
    assert(Math.abs(durationSeconds - Number(expected.durationSeconds)) <= 0.1, `${config.articleId}: MP3 duration changed at part ${index + 1}.`);
    if (!AUDIT_MODE) await copyFile(sourceFile, path.join(immutableDir, expected.file));
    const publicSrc = `/audio/articles/${config.audioKey}/releases/${lock.releaseId}/${expected.file}`;
    parts.push({
      characters: Number(sourcePart.characters || 0),
      sync: sourcePart.sync,
      audio: {
        hamed: {
          src: publicSrc,
          bytes: bytes.length,
          durationSeconds: Number(durationSeconds.toFixed(3)),
          sha256: expected.sha256,
        },
      },
    });
    totalDurationSeconds += durationSeconds;
    importedParts += 1;
    importedBytes += bytes.length;
  }
  auditArticles.push({
    articleId: config.articleId,
    audioKey: config.audioKey,
    skipped: false,
    verified: true,
    segmentCount: article.segments.length,
    segmentIds: article.segments.map(({ id }) => id),
    snapshotSha256: snapshotHashFor(article),
    lockedSnapshotSha256: config.sourceSnapshotSha256,
    lockMatch: snapshotHashFor(article) === config.sourceSnapshotSha256,
    partCount: source.parts.length,
    totalBytes: parts.reduce((sum, part) => sum + part.audio.hamed.bytes, 0),
    totalDurationSeconds: Number(totalDurationSeconds.toFixed(3)),
  });
  if (AUDIT_MODE) continue;

  const siteManifest = {
    version: 5,
    importerVersion: 1,
    syncVersion: 1,
    provider: 'Microsoft Azure AI Speech',
    model: 'Neural TTS',
    language: 'ar-SA',
    outputFormat: 'audio-48khz-96kbitrate-mono-mp3',
    articleId: config.articleId,
    title: article.title,
    sourceHash: config.sourceSnapshotSha256,
    defaultVoice: 'hamed',
    voices: [{
      id: 'hamed',
      label: 'حامد',
      description: 'صوت سعودي رجالي',
      providerVoice: 'ar-SA-HamedNeural',
      totalDurationSeconds: Number(totalDurationSeconds.toFixed(3)),
    }],
    syncMethod: 'paragraph-weighted-legacy',
    disclosure: DISCLOSURE,
    bundledRelease: {
      schema: 'bareeq.bundled-azure.v1',
      releaseId: lock.releaseId,
      capturedAt: lock.capturedAt,
      sourceOrigin: lock.sourceOrigin,
      sourceManifestSha256: config.sourceManifestSha256,
      legacySourceHash: config.legacySourceHash,
    },
    parts,
  };
  const siteCurrent = {
    schema: 'bareeq.site-audio.current.v1',
    articleId: config.articleId,
    releaseId: lock.releaseId,
    manifest: 'manifest.json',
    updatedAt: lock.capturedAt,
  };
  await writeFile(path.join(tempDir, 'manifest.json'), `${JSON.stringify(siteManifest, null, 2)}\n`);
  await writeFile(path.join(tempDir, 'current.json'), `${JSON.stringify(siteCurrent, null, 2)}\n`);

  let previousMoved = false;
  try {
    if (await exists(finalDir)) {
      await rename(finalDir, backupDir);
      previousMoved = true;
    }
    await rename(tempDir, finalDir);
    await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (!(await exists(finalDir)) && previousMoved && await exists(backupDir)) await rename(backupDir, finalDir);
    throw error;
  }
}

// This importer intentionally performs no network or synthesis API calls.
if (AUDIT_JSON) {
  process.stdout.write(`${JSON.stringify({
    schema: 'bareeq.bundled-azure.audit.v1',
    mode: 'audit',
    releaseId: lock.releaseId,
    forcedProvider: 'bundled',
    inheritedProvider: process.env.BAREEQ_TTS_PROVIDER?.trim() || 'unset',
    articles: auditArticles,
  }, null, 2)}\n`);
} else {
  log(AUDIT_MODE
    ? `Bundled Azure Hamed audit passed offline (read-only): ${seenArticleIds.size} locked article(s) verified against the hermetic legacy snapshot (parent provider: ${process.env.BAREEQ_TTS_PROVIDER?.trim() || 'unset'} → forced bundled), ${importedParts} MP3 file(s), ${importedBytes.toLocaleString('en-US')} verified byte(s), 0 files written, 0 synthesis requests.`
    : `Bundled Azure Hamed audio imported offline: ${seenArticleIds.size} article(s), ${importedParts} MP3 file(s), ${importedBytes.toLocaleString('en-US')} verified byte(s), 0 synthesis requests.`);
}
