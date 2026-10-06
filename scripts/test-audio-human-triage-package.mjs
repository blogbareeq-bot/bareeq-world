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
assert.throws(()=>assertBlindManifest({cases:[{caseId:'T01',note:'VALIDATOR_AMBIGUITY'}]}),/hidden evidence/);

console.log('Human triage package tests passed: deterministic blind ordering and reviewer evidence redaction.');


assert.equal(assertBlindManifest({cases:[{caseId:'T02',articleOrdinal:1,caseOrdinalInArticle:1,expectedContext:'نص',clipFile:'clips/T02.mp3'}]}),true);
assert.throws(()=>assertBlindManifest({cases:[{caseId:'T02',articleOrdinal:1,caseOrdinalInArticle:1,expectedContext:'نص',clipFile:'clips/control-secret.mp3'}]}),/hidden evidence/);
