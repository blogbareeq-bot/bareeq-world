import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ROOT = process.cwd();
const LAB_ROOT = path.join(ROOT, '.voice-lab');
const INPUT_ROOT = path.join(LAB_ROOT, 'input');
const SITE_DIR = path.join(LAB_ROOT, 'site');
const TEMP_SITE_DIR = path.join(LAB_ROOT, `.site-${process.pid}`);
const CASES_FILE = path.join(ROOT, 'scripts', 'voice-lab', 'cases.json');
const TEMPLATE_FILE = path.join(ROOT, 'scripts', 'voice-lab', 'template.html');
const GENERATOR = path.join(ROOT, 'scripts', 'generate-audio.mjs');
const SPEECH_PLAN_FILE = path.join(os.tmpdir(), `bareeq-voice-lab-build-${process.pid}.json`);
const ANSWER_KEY_FILE = path.join(LAB_ROOT, 'answer-key.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (target) => { try { await access(target); return true; } catch { return false; } };
const codeLetters = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ي'];

function anonymousOrder(candidates, seed, caseId) {
  return [...candidates].sort((a, b) => {
    const aRank = sha256(`${seed}:${caseId}:${a.id}`);
    const bRank = sha256(`${seed}:${caseId}:${b.id}`);
    return aRank.localeCompare(bRank);
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks = [];
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= 2 * 1024 * 1024) return;
      const remaining = 2 * 1024 * 1024 - stderrBytes;
      stderrChunks.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.byteLength, remaining);
    });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish(reject, new Error(`ffmpeg exited with ${code ?? `signal ${signal}`}${stderr ? `: ${stderr}` : ''}`));
    });
  });
}

async function normalizeAudio(source, destination) {
  const temporary = `${destination}.partial-${process.pid}-${randomBytes(6).toString('hex')}.mp3`;
  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-map_metadata', '-1', '-vn',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-ac', '1', '-ar', '48000', '-b:a', '96k',
      temporary,
    ]);
    const normalized = await readFile(temporary);
    if (normalized.byteLength < 2000) throw new Error(`Normalized audio is unexpectedly small: ${destination}`);
    const audioHash = sha256(normalized);
    await rename(temporary, destination);
    const committed = await readFile(destination);
    if (committed.byteLength !== normalized.byteLength || sha256(committed) !== audioHash) {
      throw new Error(`Normalized audio changed while it was committed: ${destination}`);
    }
    return { bytes: committed.byteLength, sha256: audioHash };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function verifyPublicAudio(root, publicCases) {
  for (const testCase of publicCases) {
    for (const voice of testCase.voices) {
      const audio = await readFile(path.join(root, ...voice.src.split('/')));
      if (audio.byteLength !== voice.bytes || sha256(audio) !== voice.sha256) {
        throw new Error(`Voice Lab audio integrity check failed: ${testCase.id}/${voice.src}`);
      }
    }
  }
}

async function loadCandidates(config, speechByArticle) {
  if (!await exists(INPUT_ROOT)) throw new Error('Voice Lab input is missing. Run npm run voice:lab:baseline first.');
  const entries = (await readdir(INPUT_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const candidates = [];
  for (const entry of entries) {
    const dir = path.join(INPUT_ROOT, entry.name);
    const metadataFile = path.join(dir, 'candidate.json');
    if (!await exists(metadataFile)) continue;
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
    if (metadata.schemaVersion !== 1 || metadata.id !== entry.name) throw new Error(`${entry.name}: invalid candidate identity.`);
    for (const field of ['provider', 'model', 'voice', 'language']) {
      if (typeof metadata[field] !== 'string' || !metadata[field].trim()) throw new Error(`${entry.name}: missing ${field}.`);
    }
    const cases = new Map((metadata.cases || []).map((item) => [item.id, item]));
    for (const testCase of config.cases) {
      const canonical = speechByArticle.get(testCase.articleId)?.segments.find((segment) => segment.id === testCase.segmentId);
      if (!canonical) throw new Error(`${testCase.id}: canonical speech segment is missing.`);
      const item = cases.get(testCase.id);
      if (!item) throw new Error(`${entry.name}: missing case metadata for ${testCase.id}.`);
      const textHash = sha256(canonical.spokenText);
      if (item.spokenText !== canonical.spokenText && item.textSha256 !== textHash) {
        throw new Error(`${entry.name}/${testCase.id}: audio was not declared against the canonical spoken text.`);
      }
      const source = path.join(dir, item.file || `${testCase.id}.mp3`);
      if (!await exists(source)) throw new Error(`${entry.name}: missing MP3 for ${testCase.id}.`);
    }
    candidates.push({ id: entry.name, dir, metadata, cases });
  }
  if (!candidates.length) throw new Error('Voice Lab has no complete candidates.');
  return candidates;
}

const config = JSON.parse(await readFile(CASES_FILE, 'utf8'));
if (!Array.isArray(config.criteria) || config.criteria.length !== 5) throw new Error('Voice Lab must define five evaluation criteria.');
if (!Array.isArray(config.cases) || config.cases.length < 3) throw new Error('Voice Lab must define at least three cases.');

await mkdir(LAB_ROOT, { recursive: true });
await rm(TEMP_SITE_DIR, { recursive: true, force: true });
await mkdir(path.join(TEMP_SITE_DIR, 'audio'), { recursive: true });

try {
  await execFile(process.execPath, [GENERATOR, `--speech-qa-output=${SPEECH_PLAN_FILE}`], {
    cwd: ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });
  const speechPlan = JSON.parse(await readFile(SPEECH_PLAN_FILE, 'utf8'));
  const speechByArticle = new Map(speechPlan.map((article) => [article.id, article]));
  const candidates = await loadCandidates(config, speechByArticle);
  const seed = process.env.BAREEQ_VOICE_LAB_SEED?.trim() || randomBytes(18).toString('hex');
  const labId = sha256(JSON.stringify({
    seed,
    candidates: candidates.map((candidate) => candidate.id).sort(),
    cases: config.cases.map((item) => `${item.id}:${item.articleId}:${item.segmentId}`),
  })).slice(0, 20);
  const publicCases = [];
  const answerCases = [];

  for (const testCase of config.cases) {
    const canonical = speechByArticle.get(testCase.articleId)?.segments.find((segment) => segment.id === testCase.segmentId);
    if (!canonical) throw new Error(`${testCase.id}: canonical speech segment is missing during build.`);
    const ordered = anonymousOrder(candidates, seed, testCase.id);
    const caseAudioDir = path.join(TEMP_SITE_DIR, 'audio', testCase.id);
    await mkdir(caseAudioDir, { recursive: true });
    const voices = [];
    const answers = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const candidate = ordered[index];
      const metadataCase = candidate.cases.get(testCase.id);
      const source = path.join(candidate.dir, metadataCase.file || `${testCase.id}.mp3`);
      const shortCode = codeLetters[index] || String(index + 1);
      const code = `الصوت ${shortCode}`;
      const anonymousFile = `clip-${sha256(`${seed}:${testCase.id}:${candidate.id}:audio`).slice(0, 14)}.mp3`;
      const destination = path.join(caseAudioDir, anonymousFile);
      const normalized = await normalizeAudio(source, destination);
      voices.push({ code, shortCode, src: `audio/${testCase.id}/${anonymousFile}`, ...normalized });
      answers.push({
        code,
        shortCode,
        candidateId: candidate.id,
        provider: candidate.metadata.provider,
        model: candidate.metadata.model,
        voice: candidate.metadata.voice,
        language: candidate.metadata.language,
        role: candidate.metadata.role || '',
        sourceSha256: metadataCase.sha256 || '',
        normalizedSha256: normalized.sha256,
      });
    }
    publicCases.push({
      id: testCase.id,
      label: testCase.label,
      focus: testCase.focus,
      spokenText: canonical.spokenText,
      textSha256: sha256(canonical.spokenText),
      voices,
    });
    answerCases.push({ id: testCase.id, label: testCase.label, answers });
  }

  const publicData = {
    schemaVersion: 1,
    labId,
    title: 'Bareeq Voice Lab',
    createdAt: new Date().toISOString(),
    candidateCount: candidates.length,
    criteria: config.criteria,
    cases: publicCases,
  };
  const answerKey = {
    schemaVersion: 1,
    labId,
    createdAt: publicData.createdAt,
    seed,
    warning: 'Keep this file outside the served site until blind scoring is complete.',
    normalization: 'All clips normalized to -16 LUFS, mono 48 kHz, MP3 96 kbps, with metadata removed.',
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      provider: candidate.metadata.provider,
      model: candidate.metadata.model,
      voice: candidate.metadata.voice,
      language: candidate.metadata.language,
      role: candidate.metadata.role || '',
    })),
    cases: answerCases,
  };

  const template = await readFile(TEMPLATE_FILE, 'utf8');
  const embedded = JSON.stringify(publicData).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (!template.includes('__LAB_DATA_JSON__')) throw new Error('Voice Lab template placeholder is missing.');
  await writeFile(path.join(TEMP_SITE_DIR, 'index.html'), template.replace('__LAB_DATA_JSON__', embedded));
  await writeFile(path.join(TEMP_SITE_DIR, 'lab.json'), JSON.stringify(publicData, null, 2) + '\n');
  await writeFile(path.join(TEMP_SITE_DIR, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  await verifyPublicAudio(TEMP_SITE_DIR, publicCases);
  await rm(SITE_DIR, { recursive: true, force: true });
  await rename(TEMP_SITE_DIR, SITE_DIR);
  await verifyPublicAudio(SITE_DIR, publicCases);
  await writeFile(ANSWER_KEY_FILE, JSON.stringify(answerKey, null, 2) + '\n');
  await writeFile(path.join(LAB_ROOT, 'README.txt'), [
    'Bareeq Voice Lab',
    '',
    'Serve only the site/ directory. The answer-key.json file intentionally lives outside it.',
    `Lab ID: ${labId}`,
    `Candidates: ${candidates.length}`,
    `Cases: ${config.cases.length}`,
    '',
  ].join('\n'));
  console.log(`Bareeq Voice Lab built: ${config.cases.length} case(s), ${candidates.length} blind candidate(s), lab ${labId}.`);
} finally {
  await rm(SPEECH_PLAN_FILE, { force: true }).catch(() => {});
  await rm(TEMP_SITE_DIR, { recursive: true, force: true }).catch(() => {});
}
