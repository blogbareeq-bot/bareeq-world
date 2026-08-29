import assert from 'node:assert/strict';
import { adjudicateDualAsr, representationEquivalent } from './audio-dual-asr-adjudicate.mjs';
import { INDEPENDENT_ASR_MODELS } from './audio-constants.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';

assert.equal(representationEquivalent('سيئ', 'سيء'), true);
assert.equal(representationEquivalent('عشرة', '10'), true);
assert.equal(representationEquivalent('3', 'ثالثا'), true);
assert.equal(representationEquivalent('تصعد', 'تصاعد'), false);
assert.equal(representationEquivalent('يتأثر', 'يتاثر'), false);

const expectedText = 'هذا سيئ ثم 3 فتظهر ضغوط تصعد بالأسعار ثم عشرة أجهزة ومئة شخص والنتيجة تعتمد على النص';
const tokens = tokenizeVerbal(expectedText);
const idx = (word) => {
  const value = tokens.indexOf(word);
  assert.notEqual(value, -1, `missing token ${word}`);
  return value;
};
const sub = (expected, actual) => ({ type: 'substitution', expected, actual, expectedIndex: idx(expected), actualIndex: idx(expected) });

const first = {
  model: INDEPENDENT_ASR_MODELS[0],
  requestedModel: INDEPENDENT_ASR_MODELS[0],
  substitutions: 6,
  deletions: 0,
  insertions: 0,
  status: 'failed',
  differences: [
    sub('سيئ', 'سيء'),
    sub('3', 'ثالثا'),
    sub('تصعد', 'تصاعد'),
    sub('عشرة', '10'),
    sub('مئة', '100'),
    sub('النص', 'النصص'),
  ],
};
const second = {
  model: INDEPENDENT_ASR_MODELS[1],
  requestedModel: INDEPENDENT_ASR_MODELS[1],
  substitutions: 5,
  deletions: 1,
  insertions: 0,
  status: 'failed',
  differences: [
    sub('سيئ', 'سيء'),
    sub('3', 'ثالثا'),
    sub('تصعد', 'تصاعد'),
    sub('عشرة', '10'),
    sub('مئة', '100'),
    { type: 'deletion', expected: 'تعتمد', actual: null, expectedIndex: idx('تعتمد'), actualIndex: idx('تعتمد') },
  ],
};

const failed = adjudicateDualAsr({ expectedText, reports: [first, second] });
assert.equal(failed.passed, false);
assert.equal(failed.consensus.substitutions, 1);
assert.equal(failed.consensus.deletions, 0);
assert.equal(failed.consensus.insertions, 0);
assert.equal(failed.substantiveDifferences[0].expected, 'تصعد');
assert.equal(failed.substantiveDifferences[0].actual, 'تصاعد');
assert.equal(failed.representationOnly.length, 4);
assert.equal(failed.modelDisagreements.length, 2);

const fixedFirst = structuredClone(first);
fixedFirst.differences = fixedFirst.differences.filter((item) => item.expected !== 'تصعد');
fixedFirst.substitutions -= 1;
const fixedSecond = structuredClone(second);
fixedSecond.differences = fixedSecond.differences.filter((item) => item.expected !== 'تصعد');
fixedSecond.substitutions -= 1;
const passed = adjudicateDualAsr({ expectedText, reports: [fixedFirst, fixedSecond] });
assert.equal(passed.passed, true);
assert.deepEqual(passed.consensus, { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 });
assert.equal(passed.representationOnly.length, 4);
assert.equal(passed.modelDisagreements.length, 2);
assert.equal(passed.policy.humanListeningStillRequired, true);

const deleteA = structuredClone(fixedFirst);
deleteA.differences.push({ type: 'deletion', expected: 'النتيجة', actual: null, expectedIndex: idx('النتيجة'), actualIndex: idx('النتيجة') });
deleteA.deletions = 1;
const deleteB = structuredClone(fixedSecond);
deleteB.differences.push({ type: 'deletion', expected: 'النتيجة', actual: null, expectedIndex: idx('النتيجة'), actualIndex: idx('النتيجة') });
deleteB.deletions = 2;
const sharedDeletion = adjudicateDualAsr({ expectedText, reports: [deleteA, deleteB] });
assert.equal(sharedDeletion.passed, false);
assert.equal(sharedDeletion.consensus.deletions, 1);

console.log('Dual-ASR adjudication tests passed: shared lexical errors fail; one-model ASR errors are recorded; representation-only forms do not become audio errors; human listening stays mandatory.');
