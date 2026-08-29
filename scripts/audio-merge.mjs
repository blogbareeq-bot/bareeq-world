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

function spliceClickScore(left, right) {
  const window = Math.min(480, Math.floor(left.length / 2), Math.floor(right.length / 2));
  if (window < 8) return 0;
  const a = left.readInt16LE(left.length - 2);
  const b = right.readInt16LE(0);
  return Math.abs(a - b) / 32768;
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
  for (let index = 1; index < pcmParts.length; index += 1) {
    const score = spliceClickScore(pcmParts[index - 1], pcmParts[index]);
    if (score > 0.95) clicks.push({ afterPart: index - 1, score });
  }
  if (clicks.length) throw new Error(`merge click/discontinuity detected at ${clicks.map((item) => item.afterPart).join(', ')}`);

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
