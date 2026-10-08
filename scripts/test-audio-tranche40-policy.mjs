import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateTranche40Policy} from './audio-tranche40-policy.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const fixture={amendment:await json('docs/audio/TTS-THRESHOLD-AMENDMENT-40.json'),strategy:await json('docs/audio/ENGINE-STRATEGY-STATE.json'),freeze:await json('docs/audio/TTS-FREEZE.json'),status:await json('docs/audio/PROGRESSIVE-STATUS.json')};
assert.equal(validateTranche40Policy(fixture).threshold,40);
for(const change of [
 x=>x.amendment.newThreshold=41,
 x=>x.amendment.targets.push(structuredClone(x.amendment.targets[0])),
 x=>x.amendment.targets[0].generationText+=' كلمة',
 x=>x.amendment.targets[0].maximumRequests=2,
 x=>x.amendment.targets[6].caseIds=['M14'],
 x=>x.amendment.automaticRetry=true,
 x=>x.freeze.active=false,
 x=>x.strategy.successfulTtsSinceLastNewExact++,
 x=>x.status.rows.find(r=>r.publishedExact).fullSha256='0'.repeat(64),
]){const x=structuredClone(fixture);change(x);assert.throws(()=>validateTranche40Policy(x));}
const complete=structuredClone(fixture);complete.amendment.successfulRequestsConsumed=7;complete.amendment.authorizationStatus='CONSUMED';complete.amendment.targets.forEach(t=>t.successfulTtsConsumed=1);complete.strategy.successfulTtsSinceLastNewExact=40;complete.freeze.strategySnapshot.successfulTtsSinceLastNewExact=40;assert.equal(validateTranche40Policy(complete).remaining,0);
console.log('TRANCHE40_POLICY_TESTS=PASS bounded=7 protected=10 closedRemaining=0');
