import { joinSpeechPieces, utf8Bytes } from './audio-constants.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';
import { spliceWindowMetrics } from './audio-merge.mjs';
import {
  TRANSITION_NORMALIZATION,
  trimTransitionSilence,
} from './audio-normalize-parts.mjs';

const DEFAULT_BOUNDARY_SETTINGS = Object.freeze({
  sampleRate: TRANSITION_NORMALIZATION.sampleRate,
  thresholdRms: TRANSITION_NORMALIZATION.thresholdRms,
  windowMs: TRANSITION_NORMALIZATION.windowMs,
  minSilenceMs: 80,
  maxDistanceSeconds: 6,
  boundaryMinSilenceMs: 500,
  timingDistanceWeight: 0.15,
  silenceDurationBonus: 0.05,
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

export function detectSilenceRuns(pcm, settings = DEFAULT_BOUNDARY_SETTINGS) {
  const sampleRate = Number(settings.sampleRate) || 48000;
  const windowMs = Number(settings.windowMs) || 10;
  const thresholdRms = Number(settings.thresholdRms) || 0.008;
  const minSilenceMs = Number(settings.minSilenceMs) || 80;
  const totalSamples = Math.floor(pcm.length / 2);
  const windowSamples = Math.max(1, Math.floor(sampleRate * windowMs / 1000));
  const minimumWindows = Math.max(1, Math.ceil(minSilenceMs / windowMs));
  const silent = [];
  for (let start = 0; start < totalSamples; start += windowSamples) {
    const end = Math.min(totalSamples, start + windowSamples);
    silent.push(rmsPcm16(pcm.subarray(start * 2, end * 2)) < thresholdRms);
  }
  const runs = [];
  for (let index = 0; index < silent.length;) {
    if (!silent[index]) {
      index += 1;
      continue;
    }
    const first = index;
    while (index < silent.length && silent[index]) index += 1;
    if (index - first < minimumWindows) continue;
    const startSample = first * windowSamples;
    const endSample = Math.min(totalSamples, index * windowSamples);
    runs.push({
      startSample,
      endSample,
      startSeconds: startSample / sampleRate,
      endSeconds: endSample / sampleRate,
      centerSeconds: (startSample + endSample) / (2 * sampleRate),
      durationSeconds: (endSample - startSample) / sampleRate,
    });
  }
  return runs;
}

export function chooseSilenceBoundary(runs, targetSeconds, {
  sampleRate = DEFAULT_BOUNDARY_SETTINGS.sampleRate,
  maxDistanceSeconds = DEFAULT_BOUNDARY_SETTINGS.maxDistanceSeconds,
} = {}) {
  const eligible = (runs || [])
    .map((run) => ({ ...run, distanceSeconds: Math.abs(run.centerSeconds - targetSeconds) }))
    .filter((run) => run.distanceSeconds <= maxDistanceSeconds)
    .sort((a, b) => a.distanceSeconds - b.distanceSeconds || b.durationSeconds - a.durationSeconds);
  const best = eligible[0];
  if (!best) return null;
  const sample = Math.round((best.startSample + best.endSample) / 2);
  return {
    ...best,
    sample,
    seconds: sample / sampleRate,
  };
}

function boundaryFromRun(run, sampleRate) {
  const sample = Math.round((run.startSample + run.endSample) / 2);
  return { ...run, sample, seconds: sample / sampleRate };
}

export function chooseSilenceBoundaryPair(runs, targetStartSeconds, targetEndSeconds, {
  sampleRate = DEFAULT_BOUNDARY_SETTINGS.sampleRate,
  maxDistanceSeconds = DEFAULT_BOUNDARY_SETTINGS.maxDistanceSeconds,
  boundaryMinSilenceMs = DEFAULT_BOUNDARY_SETTINGS.boundaryMinSilenceMs,
  timingDistanceWeight = DEFAULT_BOUNDARY_SETTINGS.timingDistanceWeight,
  silenceDurationBonus = DEFAULT_BOUNDARY_SETTINGS.silenceDurationBonus,
} = {}) {
  const minimumSeconds = boundaryMinSilenceMs / 1000;
  const candidates = (runs || []).filter((run) => run.durationSeconds >= minimumSeconds);
  const starts = candidates.filter((run) => Math.abs(run.centerSeconds - targetStartSeconds) <= maxDistanceSeconds);
  const ends = candidates.filter((run) => Math.abs(run.centerSeconds - targetEndSeconds) <= maxDistanceSeconds);
  const predictedSpan = targetEndSeconds - targetStartSeconds;
  const pairs = [];
  for (const start of starts) {
    for (const end of ends) {
      if (end.centerSeconds <= start.centerSeconds) continue;
      const span = end.centerSeconds - start.centerSeconds;
      const spanErrorSeconds = Math.abs(span - predictedSpan);
      const distanceSeconds = Math.abs(start.centerSeconds - targetStartSeconds)
        + Math.abs(end.centerSeconds - targetEndSeconds);
      const score = spanErrorSeconds
        + timingDistanceWeight * distanceSeconds
        - silenceDurationBonus * (start.durationSeconds + end.durationSeconds);
      pairs.push({ start, end, span, spanErrorSeconds, distanceSeconds, score });
    }
  }
  pairs.sort((a, b) => a.score - b.score
    || a.spanErrorSeconds - b.spanErrorSeconds
    || b.start.durationSeconds + b.end.durationSeconds - a.start.durationSeconds - a.end.durationSeconds);
  const best = pairs[0];
  if (!best) return null;
  return {
    start: boundaryFromRun(best.start, sampleRate),
    end: boundaryFromRun(best.end, sampleRate),
    spanSeconds: best.span,
    spanErrorSeconds: best.spanErrorSeconds,
    distanceSeconds: best.distanceSeconds,
    score: best.score,
  };
}

function itemId(item) {
  return item?.runtimeId || item?.segmentId || null;
}

export function locateSegmentRepair(splitPlan, failedIndices) {
  const wanted = [...new Set((failedIndices || []).filter(Number.isInteger))].sort((a, b) => a - b);
  if (!wanted.length) return null;
  const locations = [];
  let globalOffset = 0;
  for (const part of splitPlan?.parts || []) {
    for (const item of part.items || []) {
      const length = tokenizeVerbal(item.text).length;
      const start = globalOffset;
      const end = globalOffset + length - 1;
      for (const index of wanted) {
        if (index >= start && index <= end) locations.push({ index, part, item, start, end });
      }
      globalOffset += length;
    }
  }
  if (locations.length !== wanted.length) return null;
  const part = locations[0].part;
  const id = itemId(locations[0].item);
  if (!id || locations.some((entry) => entry.part.partIndex !== part.partIndex || itemId(entry.item) !== id)) return null;
  const sync = (part.sync || []).find((entry) => entry.id === id);
  if (!sync || !(sync.start >= 0 && sync.end <= 1 && sync.start < sync.end)) return null;
  const items = (part.items || []).filter((item) => itemId(item) === id);
  if (!items.length) return null;
  return {
    part,
    partIndex: part.partIndex,
    segmentId: id,
    items,
    text: joinSpeechPieces(items),
    sync,
    failedIndices: wanted,
    tokenStart: Math.min(...locations.map((entry) => entry.start)),
    tokenEnd: Math.max(...locations.map((entry) => entry.end)),
  };
}

export function planSegmentSplice(originalPcm, repair, settings = DEFAULT_BOUNDARY_SETTINGS) {
  if (!originalPcm?.length || !repair?.sync) throw new Error('segment splice requires original PCM and a synchronized repair segment');
  const sampleRate = Number(settings.sampleRate) || 48000;
  const totalSamples = Math.floor(originalPcm.length / 2);
  const durationSeconds = totalSamples / sampleRate;
  const runs = detectSilenceRuns(originalPcm, settings);
  // Paragraph sync ratios are estimates, and a nearby sentence pause can be
  // several seconds earlier than the real paragraph boundary. Select the two
  // boundaries jointly: both must be long paragraph-grade pauses and their
  // interval must remain close to the predicted paragraph duration.
  const boundaries = chooseSilenceBoundaryPair(
    runs,
    repair.sync.start * durationSeconds,
    repair.sync.end * durationSeconds,
    settings,
  );
  if (!boundaries) throw new Error(`safe paragraph-grade silence boundaries not found for synchronized segment ${repair.segmentId}`);
  const { start, end } = boundaries;
  if (end.sample <= start.sample) throw new Error(`invalid silence boundary order for synchronized segment ${repair.segmentId}`);
  const removedSeconds = (end.sample - start.sample) / sampleRate;
  const predictedSeconds = (repair.sync.end - repair.sync.start) * durationSeconds;
  const ratio = removedSeconds / Math.max(0.001, predictedSeconds);
  if (ratio < 0.55 || ratio > 1.65) {
    throw new Error(`unsafe synchronized segment duration for ${repair.segmentId}: predicted=${predictedSeconds.toFixed(3)}s removed=${removedSeconds.toFixed(3)}s`);
  }
  return {
    sampleRate,
    totalSamples,
    durationSeconds,
    start,
    end,
    removedSeconds,
    predictedSeconds,
    boundarySelection: {
      spanErrorSeconds: boundaries.spanErrorSeconds,
      distanceSeconds: boundaries.distanceSeconds,
      score: boundaries.score,
    },
    silenceRunCount: runs.length,
  };
}

export function spliceSegmentPcm(originalPcm, replacementPcm, splicePlan, {
  transitionSettings = TRANSITION_NORMALIZATION,
} = {}) {
  if (!originalPcm?.length || !replacementPcm?.length) throw new Error('segment splice requires non-empty PCM buffers');
  const trimmed = trimTransitionSilence(replacementPcm, {
    isFirst: false,
    isLast: false,
    settings: transitionSettings,
  });
  if (!trimmed.detected || trimmed.pcm.length < 100) throw new Error('replacement segment has no stable active audio');
  const left = originalPcm.subarray(0, splicePlan.start.sample * 2);
  const right = originalPcm.subarray(splicePlan.end.sample * 2);
  if (!left.length || !right.length) throw new Error('segment splice cannot replace an outer audio boundary');
  const startMetrics = spliceWindowMetrics(left, trimmed.pcm, splicePlan.sampleRate);
  const endMetrics = spliceWindowMetrics(trimmed.pcm, right, splicePlan.sampleRate);
  if (startMetrics.click || startMetrics.overlap || endMetrics.click || endMetrics.overlap) {
    throw new Error('replacement segment would introduce a click or overlapping speech at a splice boundary');
  }
  const pcm = Buffer.concat([left, trimmed.pcm, right]);
  return {
    pcm,
    trim: {
      originalSamples: trimmed.originalSamples,
      outputSamples: trimmed.outputSamples,
      trimStartSamples: trimmed.trimStartSamples,
      trimEndSamples: trimmed.trimEndSamples,
    },
    startMetrics,
    endMetrics,
    replacementSeconds: trimmed.outputSamples / splicePlan.sampleRate,
    outputSeconds: Math.floor(pcm.length / 2) / splicePlan.sampleRate,
  };
}

export function buildMicroPart(repair, sourcePart) {
  return {
    ...sourcePart,
    items: repair.items,
    text: repair.text,
    chars: [...repair.text].length,
    bytes: utf8Bytes(repair.text),
    sync: [{ ...repair.sync, start: 0, end: 1 }],
    syncIds: [repair.segmentId],
  };
}
