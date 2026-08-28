import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertNoAutomaticRegeneration, evaluateTranscriptionQa } from './audio-transcription-qa-core.mjs';

const config = JSON.parse(await readFile(new URL('./audio-transcription-equivalences.json', import.meta.url), 'utf8'));

const exact = evaluateTranscriptionQa({
  expected: 'لا تبحث عن شغفك ابنِه',
  pass1: 'لا تبحث عن شغفك ابنه',
  equivalenceConfig: config,
});
assert.equal(exact.status, 'PASS_EXACT');
assert.equal(exact.publicationAllowed, true);
assertNoAutomaticRegeneration(exact);

const google = evaluateTranscriptionQa({
  expected: 'تستخدم Google اقتراحات البحث وتتعلم Google من الأنماط',
  pass1: 'تستخدم جوجل اقتراحات البحث وتتعلم جوجل من الأنماط',
  equivalenceConfig: config,
});
assert.equal(google.status, 'PASS_EQUIVALENT');
assert.equal(google.final.editDistance, 0);
assert.equal(google.publicationAllowed, true);
assertNoAutomaticRegeneration(google);

const atyaafFirst = evaluateTranscriptionQa({
  expected: 'إذن قد يجتمع الاثنان، لكنهما ليسا الشيء نفسه',
  pass1: 'إذا قد يجتمع الاثنان لكنها ليسا الشيء نفسه',
  equivalenceConfig: config,
});
assert.equal(atyaafFirst.status, 'NEEDS_TARGETED_VERIFICATION');
assert.deepEqual(atyaafFirst.verificationVocabulary, ['إذن', 'لكنهما']);
assert.equal(atyaafFirst.publicationAllowed, false);
assertNoAutomaticRegeneration(atyaafFirst);

const atyaafVerified = evaluateTranscriptionQa({
  expected: 'إذن قد يجتمع الاثنان، لكنهما ليسا الشيء نفسه',
  pass1: 'إذا قد يجتمع الاثنان لكنها ليسا الشيء نفسه',
  pass2: 'إذن قد يجتمع الاثنان لكنها ليسا الشيء نفسه',
  equivalenceConfig: config,
});
assert.equal(atyaafVerified.status, 'REVIEW_HUMAN');
assert.equal(atyaafVerified.humanReviewRequired, true);
assert.equal(atyaafVerified.publicationAllowed, false);
assert.equal(atyaafVerified.automaticRegenerationAllowed, false);
assert.equal(atyaafVerified.persistentDifferences.length, 1);
assert.deepEqual(
  { expected: atyaafVerified.persistentDifferences[0].expected, actual: atyaafVerified.persistentDifferences[0].actual },
  { expected: 'لكنهما', actual: 'لكنها' },
);

const asrVariance = evaluateTranscriptionQa({
  expected: 'إذن قد يجتمع الاثنان، لكنهما ليسا الشيء نفسه',
  pass1: 'إذا قد يجتمع الاثنان لكنها ليسا الشيء نفسه',
  pass2: 'إذن قد يجتمع الاثنان، لكنهما ليسا الشيء نفسه',
  equivalenceConfig: config,
});
assert.equal(asrVariance.status, 'PASS_ASR_VARIANCE');
assert.equal(asrVariance.publicationAllowed, true);
assertNoAutomaticRegeneration(asrVariance);

const unknownForeign = evaluateTranscriptionQa({
  expected: 'خدمة ExampleCloud تعمل اليوم',
  pass1: 'خدمة اكزامبل كلاود تعمل اليوم',
  equivalenceConfig: config,
});
assert.equal(unknownForeign.status, 'REVIEW_HUMAN');
assert.equal(unknownForeign.publicationAllowed, false);
assertNoAutomaticRegeneration(unknownForeign);

console.log('✓ audio transcription QA core: 6 scenarios passed');
console.log('✓ exact match, controlled equivalence, targeted verification, persistent human review, ASR variance, unknown foreign term');
console.log('✓ safety invariant: automatic TTS regeneration remains disabled in every verdict');
