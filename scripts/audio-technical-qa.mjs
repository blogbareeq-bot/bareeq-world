import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import { EXIT_HARD, EXIT_USAGE, sha256, liveAudioDir, candidateDir } from './audio-constants.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { decodePcm } from './audio-merge.mjs';
import { pathExists } from './audio-checkpoint.mjs';

function rms(pcm) {
  if (pcm.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples) / 32768;
}

function peak(pcm) {
  let max = 0;
  for (let i = 0; i < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  return max / 32768;
}

function edgeEnergy(pcm, ms, sampleRate = 48000) {
  const samples = Math.min(Math.floor(pcm.length / 2), Math.floor((ms / 1000) * sampleRate));
  if (samples < 8) return 0;
  const head = pcm.subarray(0, samples * 2);
  const tail = pcm.subarray(pcm.length - samples * 2);
  return { start: rms(head), end: rms(tail) };
}

export const PRODUCTION_LOUDNESS = Object.freeze({
  maxTruePeakDbTP: 1.0,
  integratedMinLufs: -32,
  integratedMaxLufs: -6,
  maxInternalSilenceSeconds: 3,
  edgeSilenceIgnoreMs: 250,
  silentStartFailMs: 1000,
});

function longestInternalSilenceSeconds(pcm, sampleRate = 48000, threshold = 0.008) {
  const samples = Math.floor(pcm.length / 2);
  if (samples < 16) return 0;
  let first = 0;
  let last = samples - 1;
  while (first < samples && Math.abs(pcm.readInt16LE(first * 2)) / 32768 < threshold) first += 1;
  while (last > first && Math.abs(pcm.readInt16LE(last * 2)) / 32768 < threshold) last -= 1;
  const ignore = Math.floor((PRODUCTION_LOUDNESS.edgeSilenceIgnoreMs / 1000) * sampleRate);
  const start = Math.min(last, first + ignore);
  const end = Math.max(start, last - ignore);
  let longest = 0;
  let run = 0;
  for (let i = start; i <= end; i += 1) {
    const sample = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
    if (sample < threshold) {
      run += 1;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return longest / sampleRate;
}

function edgeSilenceMs(pcm, sampleRate = 48000, threshold = 0.008) {
  const samples = Math.floor(pcm.length / 2);
  let head = 0;
  let tail = 0;
  while (head < samples && Math.abs(pcm.readInt16LE(head * 2)) / 32768 < threshold) head += 1;
  while (tail < samples && Math.abs(pcm.readInt16LE((samples - 1 - tail) * 2)) / 32768 < threshold) tail += 1;
  return { startMs: (head / sampleRate) * 1000, endMs: (tail / sampleRate) * 1000 };
}

export async function measureLoudness(file) {
  const { ffmpeg } = await assertFfmpeg();
  const result = await runCommand(ffmpeg, [
    '-hide_banner', '-nostats',
    '-i', file,
    '-af', 'ebur128=peak=true',
    '-f', 'null', '-',
  ]);
  const text = `${result.stderr}\n${result.stdout.toString('utf8')}`;
  const integrated = text.match(/I:\s+([+-]?\d+(?:\.\d+)?)\s+LUFS/);
  const truePeak = text.match(/True peak:\s+([+-]?\d+(?:\.\d+)?)\s+dBTP/i)
    || text.match(/Peak:\s+([+-]?\d+(?:\.\d+)?)\s+dBFS/i);
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    truePeakDbTP: truePeak ? Number(truePeak[1]) : null,
    raw: text.slice(-800),
  };
}

export async function probeAudio(file) {
  const { ffmpeg } = await assertFfmpeg();
  const result = await runCommand(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-']);
  const text = `${result.stderr}\n${result.stdout.toString('utf8')}`;
  const stream = text.match(/Audio: ([^,]+), (\d+) Hz, ([^,]+), ([^,]+)/);
  if (!stream) throw new Error(`ffprobe/ffmpeg could not describe ${file}`);
  return {
    codec: stream[1].trim(),
    sampleRate: Number(stream[2]),
    channelsLabel: stream[3].trim(),
    sampleFmt: stream[4].trim(),
    decoded: result.code === 0 || /Output #0/.test(text) || /Audio:/.test(text),
  };
}

export async function inspectLiveSnapshot(articleId, root) {
  const dir = liveAudioDir(articleId, root);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!await pathExists(manifestPath)) return { exists: false, dir, fingerprint: null };
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const files = [];
  const missing = [];
  for (const part of manifest.parts || []) {
    const asset = part.audio?.[manifest.defaultVoice];
    if (!asset?.src) {
      missing.push('manifest part missing src');
      continue;
    }
    const file = path.join(root, 'public', asset.src.replace(/^\//, ''));
    if (!await pathExists(file)) {
      missing.push(asset.src);
      continue;
    }
    const bytes = await readFile(file);
    let durationSeconds = null;
    try { durationSeconds = mp3DurationSeconds(bytes); } catch { durationSeconds = null; }
    files.push({ file, sha256: sha256(bytes), bytes: bytes.length, durationSeconds });
  }
  return {
    exists: true,
    dir,
    provider: manifest.provider,
    voiceId: manifest.defaultVoice,
    fingerprint: sha256(JSON.stringify(files)),
    files,
    missing,
    manifest,
  };
}

export async function runTechnicalQa({
  articleId,
  fingerprint,
  root = process.cwd(),
  candidatePath,
  expectedSyncIds,
  liveBefore = null,
  fullSha256 = null,
}) {
  const failures = [];
  if (!articleId) {
    failures.push('article id is required');
    return fail(failures);
  }
  const dir = candidatePath || (fingerprint ? candidateDir(articleId, fingerprint, root) : null);
  if (!dir) return fail(['candidate path/fingerprint is required']);
  const manifestPath = path.join(dir, 'manifest.candidate.json');
  const fullFile = path.join(dir, 'full.mp3');
  if (!await pathExists(manifestPath)) return fail([`candidate manifest missing at ${path.relative(root, manifestPath)}`]);
  if (!await pathExists(fullFile)) return fail([`merged full.mp3 missing at ${path.relative(root, fullFile)}`]);

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.articleId !== articleId) failures.push(`articleId ${manifest.articleId}`);
  const full = await readFile(fullFile);
  let duration;
  try { duration = mp3DurationSeconds(full); } catch (error) { failures.push(error.message); }
  let probe;
  try { probe = await probeAudio(fullFile); } catch (error) { failures.push(error.message); }
  if (probe) {
    if (!/mp3|mp3float/i.test(probe.codec) && !/lame/i.test(probe.codec)) failures.push(`codec ${probe.codec}`);
    if (probe.sampleRate !== 48000) failures.push(`sampleRate ${probe.sampleRate}`);
    if (!/mono/i.test(probe.channelsLabel)) failures.push(`channels ${probe.channelsLabel}`);
  }
  let pcm;
  try { pcm = await decodePcm(fullFile); } catch (error) { failures.push(error.message); }
  if (pcm) {
    if (peak(pcm) >= 0.99) failures.push('clipping detected (peak ≥ 0.99)');
    const silence = longestInternalSilenceSeconds(pcm);
    if (silence > PRODUCTION_LOUDNESS.maxInternalSilenceSeconds) failures.push(`internal silence ${silence.toFixed(2)}s`);
    const edges = edgeSilenceMs(pcm);
    const head = edgeEnergy(pcm, 400);
    const tail80 = edgeEnergy(pcm, 80);
    const tail20 = edgeEnergy(pcm, 20);
    const lastSample = Math.abs(pcm.readInt16LE(pcm.length - 2)) / 32768;
    if (edges.startMs > PRODUCTION_LOUDNESS.silentStartFailMs && head.start < 0.0003) {
      failures.push(`silent start lasting ${edges.startMs.toFixed(0)}ms (likely truncated or missing audio)`);
    }
    if (tail80.end < 0.0005) {
      /* short trailing silence is a fade, not truncation */
    } else if (lastSample >= 0.99 && tail20.end > 0.25) {
      failures.push('high energy across the last 20ms (possible mid-word truncation)');
    }
  }

  const partsDir = path.join(dir, 'parts');
  const partFiles = (manifest.parts || []).map((part) => path.join(partsDir, `part-${String(part.partIndex + 1).padStart(3, '0')}-${part.fingerprint.slice(0, 12)}.mp3`));
  const levels = [];
  for (const file of partFiles) {
    if (!await pathExists(file)) {
      failures.push(`missing part file ${path.basename(file)}`);
      continue;
    }
    try {
      const partPcm = await decodePcm(file);
      levels.push(rms(partPcm));
    } catch (error) {
      failures.push(`${path.basename(file)}: ${error.message}`);
    }
  }
  if (levels.length >= 2) {
    const max = Math.max(...levels);
    const min = Math.min(...levels.filter((value) => value > 0));
    if (min > 0 && 20 * Math.log10(max / min) > 12) failures.push('inconsistent loudness across parts (>12 dB)');
  }

  const ids = new Set((manifest.parts || []).flatMap((part) => part.syncIds || (part.sync || []).map((entry) => entry.id)));
  if (!expectedSyncIds || !expectedSyncIds.length) {
    failures.push('sync is mandatory; expectedSyncIds were not provided');
  } else {
    if (!ids.size) failures.push('sync is mandatory; candidate parts have no syncIds');
    for (const id of expectedSyncIds) if (!ids.has(id)) failures.push(`sync missing ${id}`);
  }

  const liveNow = await inspectLiveSnapshot(articleId, root);
  if (liveBefore?.exists) {
    if (liveNow.fingerprint !== liveBefore.fingerprint) failures.push('live audio changed while a candidate was being validated');
    if (liveBefore.voiceId === 'hamed' && liveNow.voiceId !== 'hamed') failures.push('live Hamed voice was replaced before publish-approved');
  }

  let loudness = null;
  try { loudness = await measureLoudness(fullFile); } catch { loudness = null; }
  if (loudness?.truePeakDbTP != null && loudness.truePeakDbTP > 1.0) {
    failures.push(`true peak ${loudness.truePeakDbTP} dBTP exceeds +1.0 (clipping)`);
  }
  const digest = sha256(full);
  if (fullSha256 && digest !== fullSha256) failures.push('technical QA full.mp3 SHA-256 does not match bound fingerprint');
  const report = {
    schema: 'bareeq.audio-technical-qa.v3',
    articleId,
    fingerprint: fingerprint || manifest.fingerprint,
    fullSha256: digest,
    durationSeconds: duration || null,
    probe,
    loudness,
    narrator: PRODUCTION_NARRATOR,
    liveUntouched: !liveBefore || liveNow.fingerprint === liveBefore.fingerprint,
    failures,
    passed: failures.length === 0,
  };
  if (failures.length) return fail(failures, report);
  console.log(`Technical QA passed for ${articleId}: full ${duration?.toFixed(3)}s, ${partFiles.length} part(s).`);
  return report;
}

function fail(failures, report = null) {
  console.error('Technical QA failed:');
  failures.forEach((item) => console.error(`- ${item}`));
  const error = new Error(`Technical QA failed (${failures.length})`);
  error.exitCode = EXIT_HARD;
  error.failures = failures;
  error.report = report;
  throw error;
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-technical-qa.mjs';
if (isCli) {
  const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length);
  const fingerprint = process.argv.find((arg) => arg.startsWith('--fingerprint='))?.slice('--fingerprint='.length);
  const candidatePath = process.argv.find((arg) => arg.startsWith('--candidate='))?.slice('--candidate='.length);
  if (!articleId) {
    console.error('Technical QA: --article is required. Missing candidate is a failure.');
    process.exit(EXIT_USAGE);
  }
  try {
    await runTechnicalQa({ articleId, fingerprint, candidatePath });
  } catch (error) {
    if (!error.failures) console.error(error.message);
    process.exit(error.exitCode || EXIT_HARD);
  }
}
