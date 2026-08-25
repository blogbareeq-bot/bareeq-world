import assert from 'node:assert/strict';
import { ARABIC_TRANSCRIPT_COMPARISON_PROFILE, compareArabicTranscripts, normalizeArabicTranscript } from './arabic-transcript-match.mjs';

assert.equal(ARABIC_TRANSCRIPT_COMPARISON_PROFILE, 'arabic-lexical-exact-v1');
assert.equal(normalizeArabicTranscript('بِبَسَاطَةٍ، تَعْمَلُ!'), 'ببساطة تعمل');
assert.equal(normalizeArabicTranscript('OLED وLCD ثم X وY'), 'اوليد و ال سي دي ثم اكس و واي');
assert.equal(normalizeArabicTranscript('٢٠٢٦ و ۲۰۲۵'), '2026 و 2025');

const exact = compareArabicTranscripts('بِبَسَاطَةٍ تَعْمَلُ الشَّاشَةُ.', 'ببساطة تعمل الشاشة');
assert.equal(exact.exact, true);
assert.equal(exact.wordErrorCount, 0);

const truncated = compareArabicTranscripts('بِبَسَاطَةٍ تَعْمَلُ الشَّاشَةُ.', 'ببساط تعمل الشاشة');
assert.equal(truncated.exact, false);
assert.equal(truncated.substitutions, 1);
assert.deepEqual(truncated.operations[0], {
  type: 'substitution', expected: 'ببساطة', actual: 'ببساط', expectedIndex: 0, actualIndex: 0,
});

const omitted = compareArabicTranscripts('تعمل الشاشة بسرعة', 'تعمل بسرعة');
assert.equal(omitted.exact, false);
assert.equal(omitted.deletions, 1);

const added = compareArabicTranscripts('تعمل الشاشة', 'تعمل هذه الشاشة');
assert.equal(added.exact, false);
assert.equal(added.insertions, 1);

assert.notEqual(normalizeArabicTranscript('ببساطة'), normalizeArabicTranscript('ببساط'), 'Taa marbuta must never be normalized away.');
console.log('Arabic transcript matcher passed: exact lexical comparison preserves ة and rejects every tested add/omit/substitute case.');
