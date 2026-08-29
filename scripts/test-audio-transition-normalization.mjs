import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { decodePcm, spliceWindowMetrics } from './audio-merge.mjs';
import {
  TRANSITION_NORMALIZATION,
  detectActiveBounds,
  normalizeCandidatePart,
  normalizedPartFileName,
  trimTransitionSilence,
} from './audio-normalize-parts.mjs';
import { sha256 } from './audio-constants.mjs';

const sampleRate = TRANSITION_NORMALIZATION.sampleRate;

function silence(ms) {
  return Buffer.alloc(Math.floor(sampleRate * ms / 1000) * 2);
}

function sine(ms, frequency = 240, amplitude = 9000) {
  const samples = Math.floor(sampleRate * ms / 1000);
  const out = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.floor(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude);
    out.writeInt16LE(value, index * 2);
  }
  return out;
}

async function encodeMp3(file, pcm) {
  const { ffmpeg } = await assertFfmpeg();
  const result = await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
    '-map_metadata', '-1', '-ac', '1', '-ar', String(sampleRate),
    '-c:a', 'libmp3lame', '-b:a', '96k', '-y', file,
  ], { input: pcm });
  assert.equal(result.code, 0, result.stderr);
}

const synthetic = Buffer.concat([silence(520), sine(900), silence(430)]);
const detected = detectActiveBounds(synthetic);
assert.equal(detected.detected, true);
assert.ok(detected.leadingSilentSamples / sampleRate * 1000 >= 500);
assert.ok(detected.trailingSilentSamples / sampleRate * 1000 >= 400);

const trimmedMiddle = trimTransitionSilence(synthetic, { isFirst: false, isLast: false });
assert.equal(trimmedMiddle.changed, true);
assert.ok(trimmedMiddle.trimStartSamples > 0);
assert.ok(trimmedMiddle.trimEndSamples > 0);
assert.ok(trimmedMiddle.outputSamples < trimmedMiddle.originalSamples);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-transition-normalization-'));
try {
  const rawA = path.join(tmp, 'part-001-aaaaaaaaaaaa.mp3');
  const rawB = path.join(tmp, 'part-002-bbbbbbbbbbbb.mp3');
  await encodeMp3(rawA, Buffer.concat([silence(300), sine(1100, 220), silence(420)]));
  await encodeMp3(rawB, Buffer.concat([silence(680), sine(1000, 260), silence(340)]));
  const rawASha = sha256(await readFile(rawA));
  const rawBSha = sha256(await readFile(rawB));

  const cleanA = path.join(tmp, normalizedPartFileName(rawA));
  const cleanB = path.join(tmp, normalizedPartFileName(rawB));
  assert.match(path.basename(cleanA), /\.clean\.mp3$/);
  assert.match(path.basename(cleanB), /\.clean\.mp3$/);

  const normalizedA = await normalizeCandidatePart({ inputFile: rawA, outputFile: cleanA, isFirst: true, isLast: false });
  const normalizedB = await normalizeCandidatePart({ inputFile: rawB, outputFile: cleanB, isFirst: false, isLast: true });

  assert.equal(sha256(await readFile(rawA)), rawASha, 'normalization must never mutate the raw checkpoint part');
  assert.equal(sha256(await readFile(rawB)), rawBSha, 'normalization must never mutate the raw checkpoint part');
  assert.ok(normalizedA.durationSeconds < normalizedA.rawDurationSeconds);
  assert.ok(normalizedB.durationSeconds < normalizedB.rawDurationSeconds);
  assert.ok(normalizedB.normalizedLeadingSilenceMs < 80, `normalized internal lead ${normalizedB.normalizedLeadingSilenceMs}ms must be below merge-gap window`);

  const pcmA = await decodePcm(cleanA);
  const pcmB = await decodePcm(cleanB);
  const boundary = spliceWindowMetrics(pcmA, pcmB);
  assert.equal(boundary.gap, false, `clean boundary must not contain doubled silence: ${JSON.stringify(boundary)}`);
  assert.equal(boundary.click, false, `clean boundary must not click: ${JSON.stringify(boundary)}`);
  assert.equal(boundary.overlap, false, `clean boundary must not overlap: ${JSON.stringify(boundary)}`);

  await writeFile(path.join(tmp, 'proof.json'), `${JSON.stringify({ normalizedA, normalizedB, boundary }, null, 2)}\n`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log('Audio transition normalization tests passed: raw checkpoint parts preserved, normalized playback parts trim doubled edge silence, splice is gap/click/overlap-free.');
