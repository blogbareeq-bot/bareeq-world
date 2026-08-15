import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ROOT = process.cwd();
const LAB_ROOT = path.join(ROOT, '.voice-lab');
const INPUT_ROOT = path.join(LAB_ROOT, 'input');
const FINAL_DIR = path.join(INPUT_ROOT, 'azure-hamed-production');
const TEMP_DIR = path.join(LAB_ROOT, `.azure-hamed-production-${process.pid}`);
const CASES_FILE = path.join(ROOT, 'scripts', 'voice-lab', 'cases.json');
const GENERATOR = path.join(ROOT, 'scripts', 'generate-audio.mjs');
const SPEECH_PLAN_FILE = path.join(os.tmpdir(), `bareeq-voice-lab-plan-${process.pid}.json`);
const exists = async (target) => { try { await access(target); return true; } catch { return false; } };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const audioKeyFor = (articleId) => sha256(articleId).slice(0, 16);

async function probeDuration(file) {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine duration for ${file}.`);
  return duration;
}

async function extractClip(source, destination, start, duration) {
  await execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-ss', start.toFixed(3),
    '-t', duration.toFixed(3),
    '-map_metadata', '-1',
    '-vn', '-ac', '1', '-ar', '48000', '-b:a', '96k',
    destination,
  ], { maxBuffer: 2 * 1024 * 1024 });
  const bytes = (await readFile(destination)).byteLength;
  if (bytes < 2000) throw new Error(`Extracted clip is unexpectedly small: ${destination}`);
  return bytes;
}

const config = JSON.parse(await readFile(CASES_FILE, 'utf8'));
if (!Array.isArray(config.cases) || !config.cases.length) throw new Error('Voice Lab cases are missing.');
if (!await exists(path.join(ROOT, 'public', 'audio', 'articles'))) {
  throw new Error('Production audio cache is missing. Run npm run generate:audio before extracting the baseline.');
}

await rm(TEMP_DIR, { recursive: true, force: true });
await mkdir(TEMP_DIR, { recursive: true });

try {
  await execFile(process.execPath, [GENERATOR, `--speech-qa-output=${SPEECH_PLAN_FILE}`], {
    cwd: ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });
  const speechPlan = JSON.parse(await readFile(SPEECH_PLAN_FILE, 'utf8'));
  const speechByArticle = new Map(speechPlan.map((article) => [article.id, article]));
  const extracted = [];
  let provider = '';
  let model = '';
  let voice = '';
  let language = '';

  for (const item of config.cases) {
    const article = speechByArticle.get(item.articleId);
    if (!article) throw new Error(`${item.id}: speech plan article is missing: ${item.articleId}`);
    const segment = article.segments.find((entry) => entry.id === item.segmentId);
    if (!segment) throw new Error(`${item.id}: segment ${item.segmentId} is missing from ${item.articleId}.`);

    const audioKey = audioKeyFor(item.articleId);
    const manifestPath = path.join(ROOT, 'public', 'audio', 'articles', audioKey, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    provider ||= manifest.provider || '';
    model ||= manifest.model || '';
    voice ||= manifest.voice || '';
    language ||= manifest.language || '';
    if (provider !== manifest.provider || model !== manifest.model || voice !== manifest.voice || language !== manifest.language) {
      throw new Error(`${item.id}: production baseline metadata is inconsistent across articles.`);
    }

    let located = null;
    for (const part of manifest.parts || []) {
      const sync = part.sync?.find((entry) => entry.id === item.segmentId);
      if (sync) { located = { part, sync }; break; }
    }
    if (!located) throw new Error(`${item.id}: synchronized segment ${item.segmentId} is missing from the production manifest.`);

    const source = path.join(ROOT, 'public', located.part.src.replace(/^\//, ''));
    const partDuration = await probeDuration(source);
    const paddingBefore = 0.55;
    const paddingAfter = 0.75;
    const start = Math.max(0, Number(located.sync.start) * partDuration - paddingBefore);
    const end = Math.min(partDuration, Number(located.sync.end) * partDuration + paddingAfter);
    if (!(end > start + 1)) throw new Error(`${item.id}: synchronized clip window is invalid.`);

    const destination = path.join(TEMP_DIR, `${item.id}.mp3`);
    const bytes = await extractClip(source, destination, start, end - start);
    const clipDuration = await probeDuration(destination);
    extracted.push({
      id: item.id,
      file: `${item.id}.mp3`,
      articleId: item.articleId,
      segmentId: item.segmentId,
      visibleText: segment.visibleText,
      spokenText: segment.spokenText,
      durationSeconds: Number(clipDuration.toFixed(3)),
      bytes,
      sha256: sha256(await readFile(destination)),
    });
  }

  const candidate = {
    schemaVersion: 1,
    id: 'azure-hamed-production',
    provider,
    model,
    voice,
    language,
    role: 'Current Bareeq production baseline',
    generatedAt: new Date().toISOString(),
    normalization: 'Source segment extracted from production MP3; metadata removed; mono 48 kHz / 96 kbps.',
    cases: extracted,
  };
  await writeFile(path.join(TEMP_DIR, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
  await rm(FINAL_DIR, { recursive: true, force: true });
  await mkdir(INPUT_ROOT, { recursive: true });
  await rename(TEMP_DIR, FINAL_DIR);
  console.log(`Voice Lab baseline extracted: ${extracted.length} case(s) from ${voice}.`);
} finally {
  await rm(SPEECH_PLAN_FILE, { force: true }).catch(() => {});
  await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
}
