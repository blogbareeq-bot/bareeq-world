import assert from 'node:assert/strict';
import { applyHumanEvidence } from './audio-human-evidence-adjudication.mjs';

const base={
  schema:'bareeq.audio-dual-asr-adjudication.v1',
  consensus:{substitutions:2,deletions:1,insertions:0,unresolved:1},
  substantiveDifferences:[
    {type:'substitution',expectedIndex:2,expected:'أ',actual:'ب'},
    {type:'substitution',expectedIndex:4,expected:'ج',actual:'د'},
    {type:'deletion',expectedIndex:6,expected:'هـ',actual:null},
  ],
  unresolved:[{expectedIndex:8,expected:'و',reason:'different'}],
};
const mappings={
 T01:{kind:'pending',articleId:'a',fingerprint:'f',fullSha256:'s',expectedIndex:2,expectedToken:'أ',issueType:'substitution',hidden:{}},
 T02:{kind:'pending',articleId:'a',fingerprint:'f',fullSha256:'s',expectedIndex:4,expectedToken:'ج',issueType:'substitution',hidden:{}},
 T03:{kind:'pending',articleId:'a',fingerprint:'f',fullSha256:'s',expectedIndex:6,expectedToken:'هـ',issueType:'deletion',hidden:{}},
 T04:{kind:'pending',articleId:'a',fingerprint:'f',fullSha256:'s',expectedIndex:8,expectedToken:'و',issueType:'unresolved',hidden:{}},
};
const r=applyHumanEvidence({
 baseResult:base,mappings,
 resolvedCases:new Set(['T01','T04']),
 ambiguityCases:new Set(['T02']),
 actualCases:new Set(['T03']),
});
assert.deepEqual(r.consensus,{substitutions:0,deletions:1,insertions:0,unresolved:0});
assert.equal(r.passed,false);
assert.equal(r.humanResolved.length,3);
assert.equal(r.humanConfirmedAudioErrors.length,1);
assert.equal(r.substantiveDifferences[0].expectedIndex,6);

assert.throws(()=>applyHumanEvidence({
 baseResult:base,mappings,
 resolvedCases:new Set(['MISSING']),ambiguityCases:new Set(),actualCases:new Set()
}),/MISSING|mapping/);

console.log('Human evidence adjudication tests passed: only case-bound false positives/ambiguities are removed; confirmed audio errors remain.');
