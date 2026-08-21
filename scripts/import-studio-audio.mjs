import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ROOT = process.cwd();
const SKIP_IDS = new Set((process.env.BAREEQ_STUDIO_SKIP_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const RELEASES_ROOT = path.join(ROOT, 'audio-releases');
const AUDIO_ROOT = path.join(ROOT, 'public', 'audio', 'articles');
const MAP_FILE = path.join(ROOT, 'scripts', 'studio-audio-map.json');
const IMPORTER_VERSION = 1;
const TARGET_VERSION = 'V4.16.0';
const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;

const sha = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const readJson = async (file, label) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is missing or invalid JSON: ${error.message}`); }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const resolveInside = (root, relative, label) => {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.includes('\0'), `${label} must be a safe relative path.`);
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  assert(resolved.startsWith(prefix), `${label} escapes its release directory.`);
  return resolved;
};
const audioKeyFor = (id) => sha(id).slice(0, 16);

async function verifyMp3(file, expected, label) {
  assert(HEX_256.test(expected.sha256 || ''), `${label} has an invalid SHA-256.`);
  const bytes = await readFile(file);
  assert(bytes.length >= 100, `${label} is unexpectedly small.`);
  assert(sha(bytes) === expected.sha256, `${label} SHA-256 does not match the studio manifest.`);
  const durationSeconds = mp3DurationSeconds(bytes);
  assert(Math.abs(durationSeconds - Number(expected.duration_seconds)) <= 0.1, `${label} duration does not match the studio manifest.`);
  return {
    bytes: bytes.length,
    durationSeconds: Number(Number(expected.duration_seconds).toFixed(3)),
    measuredDurationSeconds: Number(durationSeconds.toFixed(3)),
    sha256: expected.sha256,
  };
}

const mapping = await readJson(MAP_FILE, 'Studio audio mapping');
assert(mapping.version === 1 && mapping.imports && typeof mapping.imports === 'object', 'Studio audio mapping schema is unsupported.');

const speechPlan = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-audio.mjs'), '--speech-qa-json'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
}));
const speechById = new Map(speechPlan.map((article) => [article.id, article]));

await mkdir(AUDIO_ROOT, { recursive: true });
let importedCount = 0;

for (const [studioPathId, config] of Object.entries(mapping.imports)) {
  if (SKIP_IDS.has(config.articleId)) { console.log(`↷ ${config.articleId}: skipped stale Studio fallback; V4.19 will regenerate matching Hamed.`); continue; }
  assert(SAFE_ID.test(studioPathId), `Unsafe Studio path id: ${studioPathId}`);
  assert(typeof config.articleId === 'string' && config.articleId, `${studioPathId}: articleId is missing.`);
  assert(Array.isArray(config.segmentIds) && config.segmentIds.length, `${studioPathId}: segmentIds are missing.`);
  assert(HEX_256.test(config.syncSourceSha256 || ''), `${studioPathId}: syncSourceSha256 is invalid.`);

  const sourceRoot = path.join(RELEASES_ROOT, studioPathId);
  const current = await readJson(path.join(sourceRoot, 'current.json'), `${studioPathId}/current.json`);
  assert(current.schema === 'bareeq.audio.current.v1', `${studioPathId}: unsupported current pointer schema.`);
  assert(current.article_id === studioPathId && current.path_id === studioPathId, `${studioPathId}: current pointer article/path id mismatch.`);
  assert(SAFE_ID.test(current.release_id || ''), `${studioPathId}: unsafe release id.`);
  const manifestFile = resolveInside(sourceRoot, current.manifest, `${studioPathId}: manifest path`);
  const manifestRaw = await readFile(manifestFile, 'utf8');
  const studio = JSON.parse(manifestRaw);
  const releaseRoot = path.dirname(manifestFile);

  assert(studio.schema === 'bareeq.audio.v1' && studio.version === '3.0.0', `${studioPathId}: unsupported Bareeq Voice Studio manifest.`);
  assert(studio.target_bareeq_version === TARGET_VERSION, `${studioPathId}: audio targets ${studio.target_bareeq_version}, expected ${TARGET_VERSION}.`);
  assert(studio.release_id === current.release_id, `${studioPathId}: release pointer and manifest disagree.`);
  assert(studio.article?.id === studioPathId && studio.article?.path_id === studioPathId, `${studioPathId}: studio article identity mismatch.`);
  assert(Number(studio.article?.block_count) === config.segmentIds.length, `${studioPathId}: studio block count does not match the approved synchronization map.`);
  assert(HEX_256.test(studio.article?.text_sha256 || ''), `${studioPathId}: article text SHA-256 is invalid.`);
  assert(studio.provider === 'openai' && studio.model === 'gpt-4o-mini-tts-2025-12-15', `${studioPathId}: unexpected production provider/model.`);
  assert(studio.default_voice && studio.voices?.[studio.default_voice], `${studioPathId}: default voice is missing.`);

  const article = speechById.get(config.articleId);
  assert(article, `${studioPathId}: mapped article ${config.articleId} does not exist.`);
  assert(article.title === studio.article.title, `${studioPathId}: article title differs from the approved Studio release.`);
  const segmentById = new Map(article.segments.map((segment, ordinal) => [segment.id, { ...segment, ordinal }]));
  const selected = config.segmentIds.map((id) => {
    const segment = segmentById.get(id);
    assert(segment, `${studioPathId}: synchronized segment ${id} no longer exists.`);
    return segment;
  });
  const sourceSnapshot = selected.map(({ id, type, visibleText }) => ({ id, type, visibleText }));
  assert(sha(JSON.stringify(sourceSnapshot)) === config.syncSourceSha256, `${studioPathId}: article text/order changed after the approved recording; review and regenerate the mapping before publishing.`);

  const voiceIds = Object.keys(studio.voices);
  assert(voiceIds.length === 1, `${studioPathId}: importer v${IMPORTER_VERSION} requires one Studio voice per atomic release.`);
  const voiceId = voiceIds[0];
  const voice = studio.voices[voiceId];
  assert(SAFE_ID.test(voiceId), `${studioPathId}: unsafe voice id.`);
  assert(voice.codec === 'mp3' && Number(voice.sample_rate_hz) === 48000 && Number(voice.channels) === 1, `${studioPathId}/${voiceId}: expected 48 kHz mono MP3.`);
  assert(Array.isArray(voice.blocks) && voice.blocks.length === selected.length, `${studioPathId}/${voiceId}: block timeline length mismatch.`);
  assert(Array.isArray(voice.parts) && voice.parts.length === selected.length, `${studioPathId}/${voiceId}: part list length mismatch.`);

  let partsDuration = 0;
  for (let index = 0; index < voice.parts.length; index += 1) {
    const part = voice.parts[index];
    const expectedBlockId = `block-${String(index + 1).padStart(3, '0')}`;
    assert(part.block_id === expectedBlockId && voice.blocks[index]?.id === expectedBlockId, `${studioPathId}/${voiceId}: block order mismatch at ${index + 1}.`);
    assert(HEX_256.test(part.text_sha256 || ''), `${studioPathId}/${voiceId}: invalid text hash for ${expectedBlockId}.`);
    const partFile = resolveInside(releaseRoot, part.url, `${studioPathId}/${voiceId}/${expectedBlockId}`);
    await verifyMp3(partFile, part, `${studioPathId}/${voiceId}/${expectedBlockId}`);
    partsDuration += Number(part.duration_seconds);
  }
  assert(Math.abs(partsDuration - Number(voice.duration_seconds)) <= 0.1, `${studioPathId}/${voiceId}: part durations do not add up to the article duration.`);

  const fullAudioFile = resolveInside(releaseRoot, voice.audio, `${studioPathId}/${voiceId}: full article audio`);
  const fullAudio = await verifyMp3(fullAudioFile, voice, `${studioPathId}/${voiceId}: full article audio`);
  const totalDuration = Number(voice.duration_seconds);
  assert(totalDuration > 0, `${studioPathId}/${voiceId}: invalid total duration.`);

  const key = audioKeyFor(config.articleId);
  const finalDir = path.join(AUDIO_ROOT, key);
  const tempDir = `${finalDir}.studio-next`;
  const backupDir = `${finalDir}.studio-previous`;
  if (!(await exists(finalDir)) && await exists(backupDir)) await rename(backupDir, finalDir);
  else await rm(backupDir, { recursive: true, force: true });
  const immutableDir = path.join(tempDir, 'releases', studio.release_id);
  await rm(tempDir, { recursive: true, force: true });
  const previousReleases = path.join(finalDir, 'releases');
  if (await exists(previousReleases)) await cp(previousReleases, path.join(tempDir, 'releases'), { recursive: true });
  await mkdir(immutableDir, { recursive: true });
  const publicFilename = `${voiceId}-article-${voice.sha256.slice(0, 12)}.mp3`;
  await copyFile(fullAudioFile, path.join(immutableDir, publicFilename));
  const publicSrc = `/audio/articles/${key}/releases/${studio.release_id}/${publicFilename}`;

  const sync = voice.blocks.map((block, index) => {
    const expectedBlockId = `block-${String(index + 1).padStart(3, '0')}`;
    assert(block.id === expectedBlockId, `${studioPathId}/${voiceId}: non-sequential block timeline.`);
    const start = Number(block.start_seconds);
    const end = Number(block.end_seconds);
    assert(start >= 0 && end > start && end <= totalDuration + 0.1, `${studioPathId}/${voiceId}: invalid timing for ${block.id}.`);
    return {
      id: selected[index].id,
      type: selected[index].type,
      ordinal: selected[index].ordinal,
      start: Number((start / totalDuration).toFixed(9)),
      end: index === voice.blocks.length - 1 ? 1 : Number((end / totalDuration).toFixed(9)),
    };
  });

  const siteManifest = {
    version: 4,
    importerVersion: IMPORTER_VERSION,
    syncVersion: 1,
    provider: 'OpenAI',
    model: studio.model,
    language: 'ar',
    outputFormat: 'mp3',
    articleId: config.articleId,
    title: article.title,
    sourceHash: config.syncSourceSha256,
    defaultVoice: studio.default_voice,
    voices: [{
      id: voiceId,
      label: voice.label === 'Cedar' ? 'سيدر (Cedar)' : voice.label,
      description: 'الصوت الأساسي المعتمد',
      providerVoice: voiceId,
      totalDurationSeconds: fullAudio.durationSeconds,
    }],
    syncMethod: 'studio-block-timestamps',
    disclosure: 'الصوت مولّد بالذكاء الاصطناعي وليس صوتًا بشريًا.',
    importedRelease: {
      schema: studio.schema,
      studioVersion: studio.version,
      studioArticleId: studioPathId,
      releaseId: studio.release_id,
      previousReleaseId: studio.previous_release_id || '',
      generatedAt: studio.generated_at,
      targetBareeqVersion: studio.target_bareeq_version,
      textSha256: studio.article.text_sha256,
      manifestSha256: sha(manifestRaw),
    },
    rollback: studio.rollback || null,
    parts: [{
      sync,
      audio: {
        [voiceId]: {
          src: publicSrc,
          bytes: fullAudio.bytes,
          durationSeconds: fullAudio.durationSeconds,
          sha256: fullAudio.sha256,
        },
      },
    }],
  };
  const siteCurrent = {
    schema: 'bareeq.site-audio.current.v1',
    articleId: config.articleId,
    studioArticleId: studioPathId,
    releaseId: studio.release_id,
    previousReleaseId: studio.previous_release_id || '',
    manifest: 'manifest.json',
    immutableAudio: publicSrc,
    updatedAt: studio.generated_at,
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
  } catch (error) {
    if (!(await exists(finalDir)) && previousMoved && await exists(backupDir)) await rename(backupDir, finalDir);
    throw error;
  }
  await rm(backupDir, { recursive: true, force: true });

  const copiedInfo = await stat(path.join(finalDir, 'releases', studio.release_id, publicFilename));
  assert(copiedInfo.isFile() && copiedInfo.size === fullAudio.bytes, `${studioPathId}: atomic audio copy failed.`);
  importedCount += 1;
  console.log(`✓ ${studioPathId}: imported ${voice.label} release ${studio.release_id}, ${selected.length} synchronized blocks, ${fullAudio.durationSeconds.toFixed(3)} seconds`);
}

assert(importedCount > 0 || SKIP_IDS.size > 0 || !(await exists(RELEASES_ROOT)), 'No approved Studio audio release was imported.');
console.log(`Bareeq Voice Studio import passed: ${importedCount} atomic production release(s), no API calls.`);
