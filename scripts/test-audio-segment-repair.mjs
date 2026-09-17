import assert from 'node:assert/strict';
import {
  buildMicroPart,
  chooseSilenceBoundary,
  detectSilenceRuns,
  locateSegmentRepair,
  planSegmentSplice,
  spliceSegmentPcm,
} from './audio-segment-repair.mjs';

const sampleRate = 1000;
const samples = (seconds, value = 0) => {
  const pcm = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(value, offset);
  return pcm;
};
const original = Buffer.concat([
  samples(1, 6000),
  samples(0.2),
  samples(1.6, 7000),
  samples(0.2),
  samples(1, 6000),
]);
const boundarySettings = {
  sampleRate,
  thresholdRms: 0.008,
  windowMs: 10,
  minSilenceMs: 80,
  maxDistanceSeconds: 0.35,
};
const runs = detectSilenceRuns(original, boundarySettings);
assert.equal(runs.length, 2);
assert.equal(chooseSilenceBoundary(runs, 1.1, boundarySettings).seconds, 1.1);

const splitPlan = {
  parts: [{
    partIndex: 0,
    partCount: 1,
    text: 'مقدمة قصيرة. هذه فقرة فيها أقسى تمرين. خاتمة قصيرة',
    items: [
      { segmentId: 'b1', runtimeId: 'b1', type: 'paragraph', text: 'مقدمة قصيرة' },
      { segmentId: 'b2', runtimeId: 'b2', type: 'paragraph', text: 'هذه فقرة فيها أقسى تمرين' },
      { segmentId: 'b3', runtimeId: 'b3', type: 'paragraph', text: 'خاتمة قصيرة' },
    ],
    sync: [
      { id: 'b1', start: 0, end: 0.275 },
      { id: 'b2', start: 0.275, end: 0.725 },
      { id: 'b3', start: 0.725, end: 1 },
    ],
  }],
};
const repair = locateSegmentRepair(splitPlan, [5]);
assert.equal(repair.segmentId, 'b2');
assert.equal(repair.text, 'هذه فقرة فيها أقسى تمرين');
assert.equal(locateSegmentRepair(splitPlan, [1, 5]), null, 'one micro repair cannot span two synchronized paragraphs');

const splicePlan = planSegmentSplice(original, repair, boundarySettings);
assert.equal(splicePlan.start.seconds, 1.1);
assert.equal(splicePlan.end.seconds, 2.9);
const replacement = Buffer.concat([samples(0.3), samples(1, 8000), samples(0.3)]);
const spliced = spliceSegmentPcm(original, replacement, splicePlan, {
  transitionSettings: {
    sampleRate,
    thresholdRms: 0.008,
    windowMs: 10,
    consecutiveActiveWindows: 2,
    internalLeadPaddingMs: 10,
    internalTrailPaddingMs: 10,
    outerLeadPaddingMs: 180,
    outerTrailPaddingMs: 180,
    minimumAudioMs: 120,
  },
});
assert.equal(spliced.replacementSeconds, 1.02);
assert.equal(spliced.outputSeconds, 3.22);
assert.equal(spliced.startMetrics.click, false);
assert.equal(spliced.endMetrics.click, false);
const micro = buildMicroPart(repair, splitPlan.parts[0]);
assert.equal(micro.partIndex, 0);
assert.equal(micro.text, repair.text);
assert.deepEqual(micro.syncIds, ['b2']);

console.log('Segment audio repair tests passed: one synchronized paragraph is located, silence-bounded, trimmed, and spliced without clicks.');
