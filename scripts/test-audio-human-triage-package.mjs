import assert from 'node:assert/strict';
import { assertBlindManifest, blindSortKey } from './audio-human-triage-package.mjs';

const manifest={
  cases:[
    {caseId:'T01',title:'مقال',articleOrdinal:1,caseOrdinalInArticle:1,expectedContext:'هذا ⟦اختبار⟧ بسيط',clipFile:'clips/a.mp3'}
  ]
};
assert.equal(assertBlindManifest(manifest),true);
assert.equal(blindSortKey('x'),blindSortKey('x'));
assert.notEqual(blindSortKey('x'),blindSortKey('y'));

assert.throws(()=>assertBlindManifest({cases:[{caseId:'T01',classification:'AUDIO_ERROR_CANDIDATE'}]}),/leaks hidden evidence/);
assert.throws(()=>assertBlindManifest({cases:[{caseId:'T01',note:'VALIDATOR_AMBIGUITY'}]}),/automated verdict/);

console.log('Human triage package tests passed: deterministic blind ordering and reviewer evidence redaction.');
