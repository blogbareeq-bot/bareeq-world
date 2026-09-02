import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { decodePcm } from './audio-merge.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { atomicWriteFile } from './audio-io.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { sha256 } from './audio-constants.mjs';

export const TRANSITION_NORMALIZATION = Object.freeze({
  sampleRate: 48000,
  thresholdRms: 0.008,
  windowMs: 10,
  consecutiveActiveWindows: 2,
  internalLeadPaddingMs: 10,
  internalTrailPaddingMs: 10,
  outerLeadPaddingMs: 180,
  outerTrailPaddingMs: 180,
  minimumAudioMs: 120,
});

function rmsPcm16(pcm) {
  if (!pcm || pcm.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    sum += value * value;
  }
  return Math.sqrt(sum / samples) / 32768;
}

function windowFlags(pcm, settings = TRANSITION_NORMALIZATION) {
  const totalSamples = Math.floor(pcm.length / 2);
  const windowSamples = Math.max(1, Math.floor(settings.sampleRate * settings.windowMs / 1000));
  const flags = [];
  for (let start = 0; start < totalSamples; start += windowSamples) {
    const end = Math.min(totalSamples, start + windowSamples);
    const slice = pcm.subarray(start * 2, end * 2);
    flags.push(rmsPcm16(slice) >= settings.thresholdRms);
  }
  return { flags, windowSamples, totalSamples };
}

export function detectActiveBounds(pcm, settings = TRANSITION_NORMALIZATION) {
  const { flags, windowSamples, totalSamples } = windowFlags(pcm, settings);
  const needed = Math.max(1, settings.consecutiveActiveWindows);
  let first = -1;
  for (let index = 0; index <= flags.length - needed; index += 1) {
    let active = true;
    for (let offset = 0; offset < needed; offset += 1) active &&= flags[index + offset];
    if (active) {
      first = index;
      break;
    }
  }
  let last = -1;
  for (let index = flags.length - 1; index >= needed - 1; index -= 1) {
    let active = true;
    for (let offset = 0; offset < needed; offset += 1) active &&= flags[index - offset];
    if (active) {
      last = index;
      break;
    }
  }
  if (first < 0 || last < first) {
    return {
      detected: false,
      activeStartSample: 0,
      activeEndSample: totalSamples,
      leadingSilentSamples: 0,
      trailingSilentSamples: 0,
      windowSamples,
    };
  }
  const activeStartSample = first * windowSamples;
  const activeEndSample = Math.min(totalSamples, (last + 1) * windowSamples);
  return {
    detected: true,
    activeStartSample,
    activeEndSample,
    leadingSilentSamples: activeStartSample,
    trailingSilentSamples: Math.max(0, totalSamples - activeEndSample),
    windowSamples,
  };
}

export function trimTransitionSilence(pcm, {
  isFirst = false,
  isLast = false,
  settings = TRANSITION_NORMALIZATION,
} = {}) {
  const totalSamples = Math.floor(pcm.length / 2);
  const bounds = detectActiveBounds(pcm, settings);
  if (!bounds.detected) {
    return {
      pcm,
      changed: false,
      reason: 'no-stable-active-audio-detected',
      ...bounds,
      originalSamples: totalSamples,
      outputSamples: totalSamples,
      trimStartSamples: 0,
      trimEndSamples: 0,
    };
  }
  const msToSamples = (ms) => Math.floor(settings.sampleRate * ms / 1000);
  const leadPadding = msToSamples(isFirst ? settings.outerLeadPaddingMs : settings.internalLeadPaddingMs);
  const trailPadding = msToSamples(isLast ? settings.outerTrailPaddingMs : settings.internalTrailPaddingMs);
  let startSample = Math.max(0, bounds.activeStartSample - leadPadding);
  let endSample = Math.min(totalSamples, bounds.activeEndSample + trailPadding);
  const minimumSamples = msToSamples(settings.minimumAudioMs);
  if (endSample - startSample < minimumSamples) {
    const center = Math.floor((startSample + endSample) / 2);
    startSample = Math.max(0, center - Math.floor(minimumSamples / 2));
    endSample = Math.min(totalSamples, startSample + minimumSamples);
    startSample = Math.max(0, endSample - minimumSamples);
  }
  const trimmed = pcm.subarray(startSample * 2, endSample * 2);
  return {
    pcm: trimmed,
    changed: startSample > 0 || endSample < totalSamples,
    reason: 'trim-excess-transition-silence',
    ...bounds,
    originalSamples: totalSamples,
    outputSamples: Math.floor(trimmed.length / 2),
    trimStartSamples: startSample,
    trimEndSamples: Math.max(0, totalSamples - endSample),
  };
}

export function normalizedPartFileName(inputFile) {
  const base = path.basename(inputFile);
  return base.endsWith('.mp3') ? `${base.slice(0, -4)}.clean.mp3` : `${base}.clean.mp3`;
}

async function encodePcm48kToMp3(pcm) {
  const { ffmpeg } = await assertFfmpeg();
  const encoded = await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
    '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
    '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
  ], { input: pcm });
  if (encoded.code !== 0) {
    throw new Error(`ffmpeg could not encode normalized part: ${encoded.stderr.slice(0, 700)}`);
  }
  if (encoded.stdout.length < 100) {
    throw new Error(`normalized MP3 is unexpectedly small (${encoded.stdout.length} bytes)`);
  }
  return encoded.stdout;
}

export async function normalizeCandidatePart({
  inputFile,
  outputFile,
  isFirst = false,
  isLast = false,
  settings = TRANSITION_NORMALIZATION,
}) {
  const rawBytes = await readFile(inputFile);
  const pcm = await decodePcm(inputFile);
  const trim = trimTransitionSilence(pcm, { isFirst, isLast, settings });
  const normalizedBytes = await encodePcm48kToMp3(trim.pcm);
  await atomicWriteFile(outputFile, normalizedBytes);
  const outputPcm = await decodePcm(outputFile);
  const outputBounds = detectActiveBounds(outputPcm, settings);
  const samplesToMs = (samples) => Number((samples / settings.sampleRate * 1000).toFixed(3));
  return {
    inputFile: path.basename(inputFile),
    outputFile: path.basename(outputFile),
    rawSha256: sha256(rawBytes),
    sha256: sha256(normalizedBytes),
    bytes: normalizedBytes.length,
    durationSeconds: mp3DurationSeconds(normalizedBytes),
    rawDurationSeconds: mp3DurationSeconds(rawBytes),
    changed: trim.changed,
    detected: trim.detected,
    trimStartMs: samplesToMs(trim.trimStartSamples),
    trimEndMs: samplesToMs(trim.trimEndSamples),
    rawLeadingSilenceMs: samplesToMs(trim.leadingSilentSamples),
    rawTrailingSilenceMs: samplesToMs(trim.trailingSilentSamples),
    normalizedLeadingSilenceMs: samplesToMs(outputBounds.leadingSilentSamples),
    normalizedTrailingSilenceMs: samplesToMs(outputBounds.trailingSilentSamples),
    settings,
  };
}
