import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateThresholdAmendment} from './audio-tts-threshold-amendment.mjs';
import {assertTtsUnfrozen} from './audio-tts-freeze-guard.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const f={amendment:await json('docs/audio/TTS-THRESHOLD-AMENDMENT-33.json'),strategy:await json('docs/audio/ENGINE-STRATEGY-STATE.json'),freeze:await json('docs/audio/TTS-FREEZE.json'),status:await json('docs/audio/PROGRESSIVE-STATUS.json')};
assert.equal(validateThresholdAmendment(f).remaining,3-f.amendment.successfulRequestsConsumed);
await assert.rejects(()=>assertTtsUnfrozen({operation:'gemini-generate-content-tts'}),e=>e.code==='BAREEQ_TTS_FROZEN');
for(const edit of [
 x=>x.amendment.additionalSuccessfulRequestsAuthorized=4,
 x=>x.amendment.newThreshold=34,
 x=>x.amendment.successfulRequestsConsumed=4,
 x=>x.amendment.automaticProviderDispatch=true,
 x=>x.freeze.active=false,
 x=>x.strategy.threshold=34,
 x=>x.strategy.successfulTtsSinceLastNewExact+=1,
 x=>x.amendment.targets[0].successfulTtsMaximum=2,
 x=>x.amendment.targets[0].fingerprint='0'.repeat(64),
 x=>x.amendment.protectedExact[0].fullSha256='0'.repeat(64),
 x=>x.amendment.authorizedBy='automation',
 x=>{x.amendment.authorizationStatus='CONSUMED';x.amendment.successfulRequestsConsumed=0;for(const t of x.amendment.targets)t.successfulTtsConsumed=0;x.strategy.successfulTtsSinceLastNewExact=30;x.freeze.strategySnapshot.successfulTtsSinceLastNewExact=30;},
]){const bad=structuredClone(f);edit(bad);assert.throws(()=>validateThresholdAmendment(bad));}
const closed=structuredClone(f);closed.amendment.authorizationStatus='CONSUMED';closed.amendment.successfulRequestsConsumed=3;for(const t of closed.amendment.targets)t.successfulTtsConsumed=1;closed.strategy.successfulTtsSinceLastNewExact=33;closed.freeze.strategySnapshot.successfulTtsSinceLastNewExact=33;
assert.equal(validateThresholdAmendment(closed).remaining,0);
assert.equal(f.status.publishedCount,f.status.exactCount);
assert.ok(f.status.publishedCount>=9&&f.status.publishedCount<=15);
console.log('Threshold amendment tests passed: 3-request cap, per-target limits, immutable Exact identities, counter binding, no replenishment and global provider freeze.');
