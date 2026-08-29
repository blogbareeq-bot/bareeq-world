import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { sha256 } from './audio-constants.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { candidateDir } from './audio-constants.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';

export async function decodePcm(file) {
  const { ffmpeg } = await assertFfmpeg();
  const result = await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '48000',
    'pipe:1',
  ]);
  if (result.code !== 0) throw new Error(`ffmpeg could not decode ${file}: ${result.stderr.slice(0, 400)}`);
  if (result.stdout.length < 100) throw new Error(`decoded PCM is too small for ${file}`);
  return result.stdout;
}

function rmsBuffer(pcm) {
  if (pcm.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples) / 32768;
}

export function spliceWindowMetrics(left, right, sampleRate = 48000, windowMs = 10) {
  const n = Math.min(Math.floor(sampleRate * windowMs / 1000), Math.floor(left.length / 2), Math.floor(right.length / 2));
  if (n < 8) return { windowSamples: n, step: 0, leftRms: 0, rightRms: 0, gap: false, click: false, overlap: false };
  const leftTail = left.subarray(left.length - n * 2);
  const rightHead = right.subarray(0, n * 2);
  const leftRms = rmsBuffer(leftTail);
  const rightRms = rmsBuffer(rightHead);
  let maxStep = 0;
  for (let i = 2; i < leftTail.length; i += 2) {
    maxStep = Math.max(maxStep, Math.abs(leftTail.readInt16LE(i) - leftTail.readInt16LE(i - 2)) / 32768);
  }
  for (let i = 2; i < rightHead.length; i += 2) {
    maxStep = Math.max(maxStep, Math.abs(rightHead.readInt16LE(i) - rightHead.readInt16LE(i - 2)) / 32768);
  }
  const boundaryStep = Math.abs(left.readInt16LE(left.length - 2) - right.readInt16LE(0)) / 32768;
  const interior = Math.max(maxStep, 0.02);
  const gapMs = 80;
  const gapN = Math.min(Math.floor(sampleRate * gapMs / 1000), Math.floor(left.length / 2), Math.floor(right.length / 2));
  const leftGap = rmsBuffer(left.subarray(left.length - gapN * 2));
  const rightGap = rmsBuffer(right.subarray(0, gapN * 2));
  const gap = gapN >= Math.floor(sampleRate * 0.06) && leftGap < 0.008 && rightGap < 0.008;
  const click = boundaryStep > interior * 8 && boundaryStep > 0.85;
  const overlap = leftRms > 0.2 && rightRms > 0.2 && boundaryStep > 0.85;
  return {
    windowSamples: n,
    windowMs,
    step: boundaryStep,
    leftRms,
    rightRms,
    gap,
    click,
    overlap,
    gapMs,
    leftGapRms: leftGap,
    rightGapRms: rightGap,
  };
}

function spliceClickScore(left, right) {
  return spliceWindowMetrics(left, right).step;
}

export async function mergeCandidateParts({ articleId, fingerprint, root = process.cwd(), partFiles, speechScriptHash = null }) {
  if (!Array.isArray(partFiles) || partFiles.length < 1) throw new Error('merge requires ordered part files');
  const seen = new Set();
  const durations = [];
  const pcmParts = [];
  for (const file of partFiles) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) throw new Error(`duplicate part in merge: ${file}`);
    seen.add(resolved);
    if (!await pathExists(resolved)) throw new Error(`missing part: ${file}`);
    const bytes = await readFile(resolved);
    durations.push(mp3DurationSeconds(bytes));
    pcmParts.push(await decodePcm(resolved));
  }

  const { ffmpeg } = await assertFfmpeg();
  const dir = fingerprint ? candidateDir(articleId, fingerprint, root) : path.dirname(partFiles[0]);
  await mkdir(dir, { recursive: true });
  const listFile = path.join(dir, 'concat.txt');
  await writeFile(listFile, partFiles.map((file) => `file '${path.resolve(file).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const fullFile = path.join(dir, 'full.mp3');
  const encoded = await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-ac', '1', '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '96k',
    '-y', fullFile,
  ]);
  if (encoded.code !== 0) throw new Error(`ffmpeg concat failed: ${encoded.stderr.slice(0, 700)}`);

  const merged = await readFile(fullFile);
  const duration = mp3DurationSeconds(merged);
  const expected = durations.reduce((sum, value) => sum + value, 0);
  const durationSlack = Math.max(0.35, 0.08 * partFiles.length);
  if (Math.abs(duration - expected) > durationSlack) {
    throw new Error(`merged duration ${duration}s does not match part sum ${expected.toFixed(3)}s (slack ${durationSlack.toFixed(3)}s)`);
  }
  const fullPcm = await decodePcm(fullFile);
  const expectedPcmBytes = pcmParts.reduce((sum, part) => sum + part.length, 0);
  if (Math.abs(fullPcm.length - expectedPcmBytes) > 48000 * 2 * 0.35) {
    throw new Error('merged PCM length does not match concatenated parts');
  }
  const clicks = [];
  const gaps = [];
  for (let index = 1; index < pcmParts.length; index += 1) {
    const metrics = spliceWindowMetrics(pcmParts[index - 1], pcmParts[index]);
    if (metrics.step > 0.95) clicks.push({ afterPart: index - 1, ...metrics });
    if (metrics.gap) gaps.push({ afterPart: index - 1, ...metrics });
  }
  if (clicks.length) throw new Error(`merge click/discontinuity detected at ${clicks.map((item) => item.afterPart).join(', ')}`);
  if (gaps.length) throw new Error(`merge gap/silence at splice ${gaps.map((item) => item.afterPart).join(', ')}`);

  const digest = sha256(merged);
  const report = {
    schema: 'bareeq.audio-merge.v2',
    articleId,
    fingerprint,
    candidateFingerprint: fingerprint,
    fullSha256: digest,
    speechScriptHash: speechScriptHash,
    provider: 'Google Gemini API',
    model: 'gemini-3.1-flash-tts-preview',
    voice: 'Sadaltager',
    generatorVersion: 9,
    toolVersion: 9,
    status: 'merged',
    generatedAt: new Date().toISOString(),
    files: partFiles.map((file, index) => ({ file, durationSeconds: durations[index], order: index })),
    partCount: partFiles.length,
    durationSeconds: duration,
    expectedDurationSeconds: Number(expected.toFixed(3)),
    sha256: digest,
    bytes: merged.length,
    fullFile,
  };
  await writeJson(path.join(dir, 'reports', 'merge.json'), report);
  return report;
}
