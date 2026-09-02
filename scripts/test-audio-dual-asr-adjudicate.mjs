import assert from 'node:assert/strict';
import { adjudicateDualAsr, representationEquivalent } from './audio-dual-asr-adjudicate.mjs';
import { INDEPENDENT_ASR_MODELS } from './audio-constants.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';

assert.equal(representationEquivalent('سيئ', 'سيء'), true);
assert.equal(representationEquivalent('عشرة', '10'), true);
assert.equal(representationEquivalent('3', 'ثالثا'), true);
assert.equal(representationEquivalent('شاتًا', 'شات'), true);
assert.equal(representationEquivalent('كتابًا', 'كتاب'), false);
assert.equal(representationEquivalent('تصعد', 'تصاعد'), false);
assert.equal(representationEquivalent('يتأثر', 'يتاثر'), false);
assert.equal(representationEquivalent('لألف', 'ل1000'), false, 'lam-prefixed numeric equivalence must stay in recorded boundary adjudication, not generic token equivalence');
assert.deepEqual(tokenizeVerbal('على 5,172 موظف'), ['على', '5172', 'موظف'], 'thousands punctuation must not create a false deletion/substitution pair');
assert.deepEqual(tokenizeVerbal('بين 776 و777 مشاركا'), ['بين', '776', 'و777', 'مشاركا'], 'distinct numbers must remain distinct');

const expectedText = 'هذا سيئ ثم 3 فتظهر ضغوط تصعد بالأسعار ثم عشرة أجهزة مئة شخص النتيجة تعتمد على النص';
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

const numericExpected = 'لألف ريال';
const numericFirst = {
  model: INDEPENDENT_ASR_MODELS[0],
  requestedModel: INDEPENDENT_ASR_MODELS[0],
  substitutions: 1,
  deletions: 0,
  insertions: 0,
  status: 'failed',
  differences: [
    { type: 'substitution', expected: 'لألف', actual: 'ل1000', expectedIndex: 0, actualIndex: 0 },
  ],
};
const numericSecond = {
  model: INDEPENDENT_ASR_MODELS[1],
  requestedModel: INDEPENDENT_ASR_MODELS[1],
  substitutions: 1,
  deletions: 0,
  insertions: 1,
  status: 'failed',
  differences: [
    { type: 'insertion', expected: null, actual: 'ل', expectedIndex: 0, actualIndex: 0 },
    { type: 'substitution', expected: 'لألف', actual: '1000', expectedIndex: 0, actualIndex: 1 },
  ],
};
const numericTokenization = adjudicateDualAsr({ expectedText: numericExpected, reports: [numericFirst, numericSecond] });
assert.equal(numericTokenization.passed, true);
assert.deepEqual(numericTokenization.consensus, { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 });
assert.equal(numericTokenization.representationOnly.length, 1);
assert.equal(numericTokenization.representationOnly[0].expected, 'لألف');
assert.deepEqual(numericTokenization.representationOnly[0].secondBoundaryInsertions, ['ل']);
assert.equal(numericTokenization.modelDisagreements.length, 1, 'the one-model token split stays recorded as a raw ASR disagreement');

const tanweenReports = INDEPENDENT_ASR_MODELS.map((model) => ({
  model,
  requestedModel: model,
  substitutions: 1,
  deletions: 0,
  insertions: 0,
  status: 'failed',
  differences: [
    { type: 'substitution', expected: 'شاتا', actual: 'شات', expectedIndex: 1, actualIndex: 1 },
  ],
}));
const tanweenOrthography = adjudicateDualAsr({ expectedText: 'ليسوا شاتًا أقوى', reports: tanweenReports });
assert.equal(tanweenOrthography.passed, true);
assert.deepEqual(tanweenOrthography.consensus, { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 });
assert.equal(tanweenOrthography.representationOnly.length, 1);
assert.equal(tanweenOrthography.representationOnly[0].expected, 'شاتا');

console.log('Dual-ASR adjudication tests passed: shared lexical errors fail; one-model ASR errors are recorded; narrow numeric representation and approved tanween orthography stay representation-only; human listening stays mandatory.');
