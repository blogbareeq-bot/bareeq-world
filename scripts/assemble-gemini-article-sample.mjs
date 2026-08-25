import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';

let ffmpegInstaller = null;
try { ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default; }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const ROOT = process.cwd();
const ARTICLE_ID = process.argv.find((argument) => argument.startsWith('--article='))?.slice('--article='.length)?.trim();
const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || ffmpegInstaller?.path || 'ffmpeg';
if (!ARTICLE_ID) throw new Error('Pass --article=<article-id>.');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const audioKey = sha256(ARTICLE_ID).slice(0, 16);
const manifestFile = path.join(ROOT, 'public', 'audio', 'articles', audioKey, 'manifest.json');
const manifestBytes = await readFile(manifestFile);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest.articleId !== ARTICLE_ID || manifest.provider !== 'Google Gemini API' || manifest.model !== 'gemini-3.1-flash-tts-preview' || manifest.defaultVoice !== 'sadaltager') throw new Error('Gemini article manifest identity mismatch.');
const review = manifest.automatedTranscriptReview;
if (review?.status !== 'passed' || review.transcriptionPassesPerPart !== 2 || review.wordErrorCountAcrossAllPasses !== 0 || review.substitutions !== 0 || review.deletions !== 0 || review.insertions !== 0) throw new Error('The full article has not passed the locked zero-error automated transcript gate.');
const reportBytes = await readFile(path.join(ROOT, review.reportFile));
if (sha256(reportBytes) !== review.reportSha256) throw new Error('Full-article transcript report hash mismatch.');

const inputFiles = [];
let expectedDurationSeconds = 0;
for (const [index, part] of (manifest.parts || []).entries()) {
  const asset = part.audio?.sadaltager;
  if (!asset?.src || !(asset.durationSeconds > 0)) throw new Error(`Missing Sadaltager audio in part ${index + 1}.`);
  const file = path.join(ROOT, 'public', asset.src.replace(/^\//u, ''));
  const bytes = await readFile(file);
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Gemini part integrity mismatch: ${asset.src}`);
  inputFiles.push(file);
  expectedDurationSeconds += asset.durationSeconds;
}
if (!inputFiles.length) throw new Error('Gemini article manifest has no audio parts.');

const basename = `${ARTICLE_ID}-gemini-full-v1`;
const outputDirectory = path.join(ROOT, 'scripts', 'speech-test-evidence');
const outputFile = path.join(outputDirectory, `${basename}.mp3`);
const metadataFile = path.join(outputDirectory, `${basename}.json`);
const listFile = path.join(outputDirectory, `.${basename}.concat-${process.pid}.txt`);
const temporaryOutput = `${outputFile}.tmp-${process.pid}`;
await mkdir(outputDirectory, { recursive: true });
await rm(listFile, { force: true });
await rm(temporaryOutput, { force: true });
const escapeConcatPath = (value) => value.replace(/'/gu, `'\\''`);
await writeFile(listFile, inputFiles.map((file) => `file '${escapeConcatPath(file)}'`).join('\n') + '\n', 'utf8');

await new Promise((resolve, reject) => {
  const child = spawn(FFMPEG_PATH, [
    '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map_metadata', '-1', '-c', 'copy', '-f', 'mp3', temporaryOutput,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg concat failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 800)}`)));
});
await rm(listFile, { force: true });
const output = await readFile(temporaryOutput);
const durationSeconds = mp3DurationSeconds(output);
if (output.length < 10000 || Math.abs(durationSeconds - expectedDurationSeconds) > Math.max(2, inputFiles.length * 0.15)) {
  await rm(temporaryOutput, { force: true });
  throw new Error(`Assembled Gemini sample duration/integrity mismatch: measured ${durationSeconds.toFixed(3)}s vs ${expectedDurationSeconds.toFixed(3)}s.`);
}
await rename(temporaryOutput, outputFile);
await writeFile(metadataFile, `${JSON.stringify({
  schema: 'bareeq.gemini-full-article-sample.v1',
  articleId: ARTICLE_ID,
  provider: manifest.provider,
  model: manifest.model,
  voice: manifest.voices[0].providerVoice,
  language: manifest.language,
  sourceManifestFile: path.posix.join('public', 'audio', 'articles', audioKey, 'manifest.json'),
  sourceManifestSha256: sha256(manifestBytes),
  transcriptReportFile: review.reportFile,
  transcriptReportSha256: review.reportSha256,
  automatedTranscriptStatus: 'passed',
  transcriptionPassesPerPart: 2,
  wordErrorCount: 0,
  partCount: inputFiles.length,
  outputFormat: 'audio-48khz-96kbitrate-mono-mp3',
  bytes: output.length,
  durationSeconds: Number(durationSeconds.toFixed(3)),
  sha256: sha256(output),
  assembledAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');
console.log(`Full Gemini article sample assembled after zero-error transcript verification: ${inputFiles.length} parts, ${durationSeconds.toFixed(2)}s, ${output.length.toLocaleString('en-US')} bytes.`);
