import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ADJUDICATION_POLICY_VERSION,
  adjudicateDualAsr,
  representationEquivalent,
} from './audio-dual-asr-adjudicate.mjs';
import { INDEPENDENT_ASR_MODELS } from './audio-constants.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';

assert.equal(representationEquivalent('سيئ', 'سيء'), true);
assert.equal(representationEquivalent('عشرة', '10'), true);
assert.equal(representationEquivalent('3', 'ثالثا'), true);
assert.equal(representationEquivalent('عشرين', '20'), true);
assert.equal(representationEquivalent('تسعين', '90'), true);
assert.equal(representationEquivalent('شاتًا', 'شات'), true);
assert.equal(representationEquivalent('لإنهائه', 'لانهائه'), true);
assert.equal(representationEquivalent('دال', 'د'), true);
assert.equal(representationEquivalent('ذال', 'ذ'), false, 'letter-name equivalence must not become generic');
assert.equal(representationEquivalent('أنثروبك', 'أنثروبيك'), true);
assert.equal(representationEquivalent('أنثروبك', 'Anthropic'), true);
assert.equal(representationEquivalent('كلود', 'cloud'), true);
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
assert.equal(passed.policy.version, ADJUDICATION_POLICY_VERSION);
assert.equal(ADJUDICATION_POLICY_VERSION, 6);
assert.equal(passed.policy.verificationRepresentation.synthesisFingerprintMutation, false);
assert.equal(passed.policy.verificationRepresentation.newEquivalenceRulesInV6, false);
assert.match(passed.policy.humanListeningPolicy, /campaign publication policy governs/);

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

const namedEntityReports = INDEPENDENT_ASR_MODELS.map((model, index) => ({
  model,
  requestedModel: model,
  substitutions: 1,
  deletions: 0,
  insertions: 0,
  status: 'failed',
  differences: [
    { type: 'substitution', expected: 'أنثروبك', actual: index === 0 ? 'Anthropic' : 'أنثروبيك', expectedIndex: 0, actualIndex: 0 },
  ],
}));
const namedEntityOrthography = adjudicateDualAsr({ expectedText: 'أنثروبك', reports: namedEntityReports });
assert.equal(namedEntityOrthography.passed, true);
assert.deepEqual(namedEntityOrthography.consensus, { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 });
assert.equal(namedEntityOrthography.representationOnly.length, 1);

const claudeEntityReports = INDEPENDENT_ASR_MODELS.map((model, index) => ({
  model,
  requestedModel: model,
  substitutions: 1,
  deletions: 0,
  insertions: 0,
  status: 'failed',
  differences: [
    { type: 'substitution', expected: 'كلود', actual: index === 0 ? 'Claude' : 'cloud', expectedIndex: 0, actualIndex: 0 },
  ],
}));
const claudeEntityOrthography = adjudicateDualAsr({ expectedText: 'كلود', reports: claudeEntityReports });
assert.equal(claudeEntityOrthography.passed, true);
assert.deepEqual(claudeEntityOrthography.consensus, { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 });

const arrowReports = INDEPENDENT_ASR_MODELS.map((model) => ({
  model,
  requestedModel: model,
  substitutions: 0,
  deletions: 1,
  insertions: 0,
  status: 'failed',
  differences: [
    { type: 'deletion', expected: '→', actual: null, expectedIndex: 1, actualIndex: 1 },
  ],
}));
const silentArrow = adjudicateDualAsr({ expectedText: 'مدخل → تحليل', reports: arrowReports });
assert.equal(silentArrow.passed, true);
assert.deepEqual(silentArrow.consensus, { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 });
assert.equal(silentArrow.representationOnly[0].type, 'representation-only-silent-visual-marker');

const baSplitReports = INDEPENDENT_ASR_MODELS.map((model) => ({
  model,
  requestedModel: model,
  substitutions: 1,
  deletions: 0,
  insertions: 1,
  status: 'failed',
  differences: [
    { type: 'insertion', expected: null, actual: 'ب', expectedIndex: 0, actualIndex: 0 },
    { type: 'substitution', expected: 'بما', actual: 'ما', expectedIndex: 0, actualIndex: 1 },
  ],
}));
const baTokenization = adjudicateDualAsr({ expectedText: 'بما يحدث', reports: baSplitReports });
assert.equal(baTokenization.passed, true);
assert.deepEqual(baTokenization.consensus, { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 });
assert.equal(baTokenization.representationOnly.length, 1);
assert.deepEqual(baTokenization.representationOnly[0].firstBoundaryInsertions, ['ب']);

const missingBaReports = INDEPENDENT_ASR_MODELS.map((model) => ({
  model,
  requestedModel: model,
  substitutions: 1,
  deletions: 0,
  insertions: 0,
  status: 'failed',
  differences: [
    { type: 'substitution', expected: 'بما', actual: 'ما', expectedIndex: 0, actualIndex: 0 },
  ],
}));
const missingBa = adjudicateDualAsr({ expectedText: 'بما يحدث', reports: missingBaReports });
assert.equal(missingBa.passed, false);
assert.equal(missingBa.consensus.substitutions, 1);

const consensusSource = await readFile(new URL('./audio-validate-consensus.mjs', import.meta.url), 'utf8');
const offlinePassMarker = consensusSource.indexOf('ASR_OFFLINE_REUSE_PASS');
const offlineMismatchMarker = consensusSource.indexOf('ASR_OFFLINE_REUSE_MISMATCH');
const apiKeyGate = consensusSource.indexOf("if (!apiKey?.trim())");
const providerUpload = consensusSource.indexOf('uploaded = await uploadAudioFile');
assert.ok(offlinePassMarker >= 0 && offlinePassMarker < apiKeyGate,
  'stored raw ASR must be re-adjudicated before an API key is required');
assert.ok(offlineMismatchMarker >= 0 && offlineMismatchMarker < providerUpload,
  'a bound stored exact mismatch must return before any provider upload');
assert.ok(apiKeyGate < providerUpload,
  'provider validation must remain credential-gated after offline reuse is unavailable');


// An approved numeral spelling is still a matched independent transcription.
for(const expected of ['3','1','2']){
 const actual={'3':'ثلاثة','1':'واحد','2':'اثنان'}[expected];
 const rs=INDEPENDENT_ASR_MODELS.map((model,i)=>({model,requestedModel:model,differences:[i===0?{type:'substitution',expected,actual,expectedIndex:0}:{type:'deletion',expected,actual:null,expectedIndex:0}]}));
 const result=adjudicateDualAsr({expectedText:expected,reports:rs});assert.equal(result.passed,true);assert.equal(result.modelDisagreements.length,1);assert.equal(result.policy.verificationRepresentation.newEquivalenceRulesInV6,false);
}
const changedNumber=INDEPENDENT_ASR_MODELS.map((model,i)=>({model,requestedModel:model,differences:[i===0?{type:'substitution',expected:'3',actual:'أربعة',expectedIndex:0}:{type:'deletion',expected:'3',actual:null,expectedIndex:0}]}));
assert.equal(adjudicateDualAsr({expectedText:'3',reports:changedNumber}).passed,false);
assert.equal(representationEquivalent('24','12'),false);

console.log('Dual-ASR adjudication tests passed: shared lexical errors fail; one-model ASR errors are recorded; narrow numeric representation, explicit Arabic ب tokenization, silent visual arrows, approved orthography, and offline raw-ASR reuse stay guarded; human-listening requirements remain governed by the campaign publication policy.');
