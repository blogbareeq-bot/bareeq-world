import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ROOT = process.cwd();
const LAB_ROOT = path.join(ROOT, '.voice-lab');
const SITE_ROOT = path.join(LAB_ROOT, 'site');
const exists = async (target) => { try { await access(target); return true; } catch { return false; } };

for (const file of ['index.html', 'lab.json', 'robots.txt']) {
  if (!await exists(path.join(SITE_ROOT, file))) throw new Error(`Voice Lab site is missing ${file}.`);
}
if (!await exists(path.join(LAB_ROOT, 'answer-key.json'))) throw new Error('Voice Lab answer key is missing.');
if (await exists(path.join(SITE_ROOT, 'answer-key.json'))) throw new Error('Voice Lab answer key leaked into the served site.');

const lab = JSON.parse(await readFile(path.join(SITE_ROOT, 'lab.json'), 'utf8'));
const answerKey = JSON.parse(await readFile(path.join(LAB_ROOT, 'answer-key.json'), 'utf8'));
if (lab.schemaVersion !== 1 || answerKey.schemaVersion !== 1 || lab.labId !== answerKey.labId) throw new Error('Voice Lab public data and answer key do not match.');
if (!Array.isArray(lab.criteria) || lab.criteria.length !== 5) throw new Error('Voice Lab must expose five scoring criteria.');
if (!Array.isArray(lab.cases) || lab.cases.length < 3) throw new Error('Voice Lab has too few test cases.');
if (!Number.isInteger(lab.candidateCount) || lab.candidateCount < 1) throw new Error('Voice Lab candidate count is invalid.');

const html = await readFile(path.join(SITE_ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html);
const document = dom.window.document;
if (document.documentElement.lang !== 'ar' || document.documentElement.dir !== 'rtl') throw new Error('Voice Lab document must be Arabic RTL.');
if (!document.querySelector('meta[name="robots"]')?.content.includes('noindex')) throw new Error('Voice Lab HTML is not marked noindex.');
for (const selector of ['#case-nav', '#case-root', '#progress', '#reset', '#export']) {
  if (!document.querySelector(selector)) throw new Error(`Voice Lab UI is missing ${selector}.`);
}
if (!html.includes('localStorage') || !html.includes('تصدير النتائج') || !html.includes('data-score')) throw new Error('Voice Lab persistence/export/scoring behavior is incomplete.');

const servedText = `${html}\n${await readFile(path.join(SITE_ROOT, 'lab.json'), 'utf8')}`;
for (const candidate of answerKey.candidates || []) {
  for (const secret of [candidate.id, candidate.provider, candidate.model, candidate.voice]) {
    if (secret && servedText.includes(secret)) throw new Error(`Blind identity leaked into served files: ${secret}`);
  }
}

let audioCount = 0;
for (const testCase of lab.cases) {
  if (!testCase.id || !testCase.spokenText || !testCase.textSha256) throw new Error('Voice Lab case metadata is incomplete.');
  if (!Array.isArray(testCase.voices) || testCase.voices.length !== lab.candidateCount) throw new Error(`${testCase.id}: blind voice count mismatch.`);
  const answer = answerKey.cases?.find((item) => item.id === testCase.id);
  if (!answer || answer.answers?.length !== testCase.voices.length) throw new Error(`${testCase.id}: answer-key mapping mismatch.`);
  for (const voice of testCase.voices) {
    if (!/^الصوت /.test(voice.code) || typeof voice.src !== 'string' || !voice.src.endsWith('.mp3')) throw new Error(`${testCase.id}: invalid anonymous voice entry.`);
    const file = path.resolve(SITE_ROOT, voice.src);
    if (!file.startsWith(`${SITE_ROOT}${path.sep}`)) throw new Error(`${testCase.id}: unsafe audio path.`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size < 2000) throw new Error(`${testCase.id}: missing or empty audio clip.`);
    const { stdout } = await execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,channels,sample_rate:format=duration',
      '-of', 'json',
      file,
    ]);
    const probe = JSON.parse(stdout);
    const stream = probe.streams?.[0];
    const duration = Number(probe.format?.duration);
    if (stream?.codec_name !== 'mp3' || Number(stream.channels) !== 1 || Number(stream.sample_rate) !== 48000) throw new Error(`${testCase.id}: clip format is not normalized mono 48 kHz MP3.`);
    if (!Number.isFinite(duration) || duration < 2 || duration > 90) throw new Error(`${testCase.id}: clip duration ${duration} is outside the safe evaluation range.`);
    audioCount += 1;
  }
}

const robots = await readFile(path.join(SITE_ROOT, 'robots.txt'), 'utf8');
if (!/Disallow:\s*\//.test(robots)) throw new Error('Voice Lab robots.txt does not disallow crawling.');
const gitignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8');
if (!/^\.voice-lab\/$/m.test(gitignore)) throw new Error('.voice-lab/ must remain excluded from commits and production publishing.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
for (const command of ['voice:lab:baseline', 'voice:lab:build', 'voice:lab:check', 'voice:lab:serve']) {
  if (!pkg.scripts?.[command]) throw new Error(`package.json is missing ${command}.`);
}
if (await exists(path.join(ROOT, 'dist'))) {
  async function findLeaks(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (/voice[-_.]?lab/i.test(entry.name)) throw new Error(`Voice Lab artifact leaked into dist: ${path.relative(ROOT, path.join(dir, entry.name))}`);
      if (entry.isDirectory()) await findLeaks(path.join(dir, entry.name));
    }
  }
  await findLeaks(path.join(ROOT, 'dist'));
}

console.log(`Bareeq Voice Lab audit passed: ${lab.cases.length} case(s), ${lab.candidateCount} blind candidate(s), ${audioCount} normalized MP3 clip(s), no identity or production leak.`);
