import assert from 'node:assert/strict';
import {validateTrancheDispatch,digest} from './audio-tranche33-authorization.mjs';
const text='قد يحسن الحكم في ظروف معينة بدل أن يفسده. [11]';
const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123'};
const target={articleId:'test',fingerprint:'f',baselineFullSha256:'s',successfulTtsConsumed:0,dispatchAttempt:{status:'RESERVED',runId:'123',attemptNumber:1},expectedSegmentText:'مقدمة '+text,targets:[{partNumber:3,partLocalIndex:174}]};
const base={operation:'gemini-generate-content-tts',text,env,context:{decisionId:'d',articleId:'test',repairTextSha256:digest(text)},amendment:{decisionId:'d',executionStatus:'EXECUTING',authorizationStatus:'IN_PROGRESS',executionClaim:{runId:'123',runAttempt:1},successfulRequestsConsumed:0,targets:[target]},preflight:{decisionId:'d',passedTargets:3,providerCalls:0,ttsCalls:0,targets:[{...target,preflightPassed:true,repairText:text,cutStartSeconds:89,cutEndSeconds:94,partNumber:3,repairExpectedStart:165,repairExpectedEnd:174,quietStart:{rmsDb:-50,peakDb:-35},quietEnd:{rmsDb:-50,peakDb:-35}}]}};
assert.equal(validateTrancheDispatch(base).articleId,'test');
const changes=[x=>x.env.GITHUB_RUN_ATTEMPT='2',x=>x.env.GITHUB_REF='refs/pull/84/merge',x=>x.amendment.executionClaim.runId='other',x=>x.amendment.successfulRequestsConsumed=3,x=>x.amendment.targets[0].successfulTtsConsumed=1,x=>x.amendment.targets[0].dispatchAttempt.status='SUCCESSFUL_RESPONSE',x=>x.text+=' زائدة',x=>x.context.articleId='unauthorized',x=>x.preflight.passedTargets=2,x=>x.preflight.targets[0].quietStart.peakDb=-20,x=>x.preflight.targets[0].baselineFullSha256='drift',x=>x.preflight.targets[0].repairExpectedEnd=173,x=>x.operation='gemini-interactions-tts'];
for(const change of changes){const x=structuredClone(base);change(x);assert.throws(()=>validateTrancheDispatch(x),/TRANCHE33_DISPATCH_BLOCKED/);}
console.log('TRANCHE33_AUTHORIZATION_TESTS=PASS providerCalls=0');
