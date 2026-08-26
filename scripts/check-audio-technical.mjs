/**
 * Technical audio checks for a completed article candidate (stage 4a).
 *
 * For every MP3 part this decodes the file end-to-end with ffmpeg and checks:
 *   - non-empty, fully decodable, plausible duration (matches the manifest),
 *   - no clipping (full-scale sample ratio below threshold),
 *   - consistent loudness between parts (RMS spread within bounds),
 *   - natural edges and no abnormal internal silence.
 *
 * Usage: node scripts/check-audio-technical.mjs <articleId> [--json out.json]
 */
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { createHash } from 'node:crypto';

let ffmpegInstaller = null;
try { ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default; }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || ffmpegInstaller?.path || 'ffmpeg';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const articleId = process.argv[2];
if (!articleId) throw new Error('Usage: check-audio-technical.mjs <articleId> [--json out.json]');
const JSON_INDEX = process.argv.indexOf('--json');
const JSON_OUT = JSON_INDEX >= 0 ? process.argv[JSON_INDEX + 1] : '';
const ROOT = process.cwd();
const audioKey = sha(articleId).slice(0, 16);
const manifestFile = path.join(ROOT, 'public', 'audio', 'articles', audioKey, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
if (manifest.articleId !== articleId) throw new Error('Manifest article mismatch.');

function decodeToPcm(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map_metadata', '-1', '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; const stderr = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => stderr.push(c));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) { reject(new Error(`ffmpeg decode failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 400)}`)); return; }
      resolve(Buffer.concat(chunks));
    });
  });
}

function analyzePcm(pcm) {
  const samples = pcm.length >> 1;
  let peak = 0; let clipped = 0; let sumSquares = 0;
  const WINDOW = 2400; // 100 ms windows at 24 kHz
  const windows = Math.floor(samples / WINDOW);
  const windowRms = new Float64Array(windows);
  for (let w = 0; w < windows; w++) {
    let windowSum = 0;
    for (let i = 0; i < WINDOW; i++) {
      const sample = pcm.readInt16LE((w * WINDOW + i) * 2);
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= 32767) clipped += 1;
      windowSum += sample * sample;
      sumSquares += sample * sample;
    }
    windowRms[w] = Math.sqrt(windowSum / WINDOW);
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples));
  const silenceThreshold = Math.max(64, rms * 0.04);
  let leadingSilence = 0; let trailingSilence = 0;
  while (leadingSilence < windows && windowRms[leadingSilence] < silenceThreshold) leadingSilence++;
  while (trailingSilence < windows - leadingSilence && windowRms[windows - 1 - trailingSilence] < silenceThreshold) trailingSilence++;
  let maxInternalGapWindows = 0; let currentGap = 0;
  for (let w = leadingSilence; w < windows - trailingSilence; w++) {
    if (windowRms[w] < silenceThreshold) { currentGap++; if (currentGap > maxInternalGapWindows) maxInternalGapWindows = currentGap; }
    else currentGap = 0;
  }
  return {
    samples,
    pcmSeconds: Number((samples / 24000).toFixed(3)),
    peak,
    peakDbfs: Number((20 * Math.log10(Math.max(1, peak) / 32768)).toFixed(2)),
    clippedSamples: clipped,
    clippingRatio: Number((clipped / Math.max(1, samples)).toPrecision(4)),
    rms,
    rmsDbfs: Number((20 * Math.log10(Math.max(1, rms) / 32768)).toFixed(2)),
    leadingSilenceSeconds: Number((leadingSilence / 10).toFixed(1)),
    trailingSilenceSeconds: Number((trailingSilence / 10).toFixed(1)),
    maxInternalSilenceSeconds: Number((maxInternalGapWindows / 10).toFixed(1)),
  };
}

const results = [];
const problems = [];
for (const [index, part] of manifest.parts.entries()) {
  const asset = part?.audio?.[manifest.defaultVoice];
  if (!asset?.src) { problems.push(`part ${index + 1}: manifest has no audio asset`); continue; }
  const file = path.join(ROOT, 'public', asset.src.replace(/^\//, ''));
  try { await access(file); } catch { problems.push(`part ${index + 1}: missing file ${asset.src}`); continue; }
  const bytes = await readFile(file);
  if (asset.sha256 && sha(bytes) !== asset.sha256) problems.push(`part ${index + 1}: sha256 mismatch`);
  const declaredDuration = mp3DurationSeconds(bytes);
  const pcm = await decodeToPcm(file);
  const stats = analyzePcm(pcm);
  const durationDelta = Math.abs(stats.pcmSeconds - (asset.durationSeconds || declaredDuration));
  if (durationDelta > Math.max(0.5, (asset.durationSeconds || declaredDuration) * 0.02)) problems.push(`part ${index + 1}: decoded duration ${stats.pcmSeconds}s deviates from manifest ${asset.durationSeconds}s`);
  if (stats.clippingRatio > 0.0005) problems.push(`part ${index + 1}: clipping ratio ${stats.clippingRatio} exceeds 0.0005`);
  if (stats.peak > 32767) problems.push(`part ${index + 1}: over-full-scale peak`);
  if (stats.leadingSilenceSeconds > 3) problems.push(`part ${index + 1}: ${stats.leadingSilenceSeconds}s leading silence`);
  if (stats.trailingSilenceSeconds > 3) problems.push(`part ${index + 1}: ${stats.trailingSilenceSeconds}s trailing silence`);
  if (stats.maxInternalSilenceSeconds > 6) problems.push(`part ${index + 1}: internal silence gap ${stats.maxInternalSilenceSeconds}s`);
  results.push({ part: index + 1, src: asset.src, bytes: bytes.length, ...stats });
}
const loudnessValues = results.map((r) => r.rmsDbfs);
if (loudnessValues.length > 1) {
  const spread = Math.max(...loudnessValues) - Math.min(...loudnessValues);
  if (spread > 6) problems.push(`loudness spread across parts is ${spread.toFixed(2)} dB (> 6 dB)`);
  results.push({ part: 'spread', rmsDbfsSpread: Number(spread.toFixed(2)) });
}

const status = problems.length === 0 ? 'passed' : 'failed';
const report = { schema: 'bareeq.audio-technical-check.v1', articleId, status, checkedAt: new Date().toISOString(), manifestParts: manifest.parts.length, analyzedParts: results.filter((r) => typeof r.part === 'number').length, problems, results };
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status, problems }, null, 2));
for (const result of results) if (typeof result.part === 'number') console.log(`PART_${result.part} duration=${result.pcmSeconds}s peak=${result.peakDbfs}dBFS rms=${result.rmsDbfs}dBFS clip=${result.clippingRatio} lead=${result.leadingSilenceSeconds}s tail=${result.trailingSilenceSeconds}s gap=${result.maxInternalSilenceSeconds}s`);
if (status !== 'passed') process.exitCode = 2;
