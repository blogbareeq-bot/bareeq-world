import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateTranche40Dispatch} from './audio-tranche40-authorization.mjs';
import {digest40} from './audio-tranche40-policy.mjs';
import {assertTtsUnfrozen} from './audio-tts-freeze-guard.mjs';
import {synthesizeGeminiGenerateContentPart} from './audio-gemini-tts.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const a=await json('docs/audio/TTS-THRESHOLD-AMENDMENT-40.json'),p=await json('docs/audio/TRANCHE40-PREFLIGHT.json');
const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'test-owner40',GITHUB_RUN_ATTEMPT:'1'};
a.authorizationStatus='IN_PROGRESS';a.executionStatus='EXECUTING';a.executionClaim={runId:env.GITHUB_RUN_ID,runAttempt:1};a.successfulRequestsConsumed=0;a.touchscreenQa={completed:true,runId:env.GITHUB_RUN_ID};
for(const t of a.targets){t.successfulTtsConsumed=0;t.dispatchAttempt={runId:env.GITHUB_RUN_ID,attemptNumber:1,status:'RESERVED'};}
for(const r of p.targets){const f={amendment:a,preflight:p,context:{decisionId:a.decisionId,requestId:r.id,articleId:r.articleId,repairTextSha256:digest40(r.repairText)},text:r.repairText,operation:'gemini-generate-content-tts',env};assert.equal(validateTranche40Dispatch(f).requestId,r.id);
 for(const edit of [x=>x.env.GITHUB_RUN_ATTEMPT='2',x=>x.env.GITHUB_REF='refs/pull/104/merge',x=>x.context.requestId='R40-08',x=>x.text+=' كلمة',x=>x.amendment.successfulRequestsConsumed=7,x=>x.amendment.targets.find(t=>t.id===r.id).successfulTtsConsumed=1,x=>x.amendment.targets.find(t=>t.id===r.id).dispatchAttempt.status='FAILED_NO_RETRY',x=>x.preflight.targets.find(t=>t.id===r.id).quietStart.rmsDb=-10,x=>x.preflight.targets.find(t=>t.id===r.id).sourcePartSha256='0'.repeat(64)]){const bad=structuredClone(f);edit(bad);assert.throws(()=>validateTranche40Dispatch(bad));}
 if(r.requestNumber>3){const bad=structuredClone(f);delete bad.amendment.touchscreenQa;assert.throws(()=>validateTranche40Dispatch(bad));}
}
await assert.rejects(()=>assertTtsUnfrozen({operation:'gemini-generate-content-tts'}),e=>e.code==='BAREEQ_TTS_FROZEN');
let calls=0;await assert.rejects(()=>synthesizeGeminiGenerateContentPart({apiKey:'test-not-a-credential',part:{text:'test'},voice:'other',tranche40Context:{},fetchImpl:async()=>{calls++;}}),/immutable/);assert.equal(calls,0);
console.log('TRANCHE40_AUTHORIZATION_TESTS=PASS replay=blocked repeatedTarget=blocked sourceDrift=blocked generalFreeze=active voice=immutable');
