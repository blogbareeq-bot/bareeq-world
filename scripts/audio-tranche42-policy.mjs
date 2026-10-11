import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
export const TRANCHE42_PATH='docs/audio/TTS-THRESHOLD-AMENDMENT-42.json';
export const DECISION42='COMPLETION15-TWO-REPAIRS-20261011-v1';
export const PROPOSAL42='docs/audio/TWO-DEFECT-REPAIR-PROPOSAL-20261011.json';
export const digest42=x=>createHash('sha256').update(x).digest('hex');
const approved=[['REPAIR2-S','how-touchscreens-work','73ccd2c28781b8e8c65b7a12833eb08a5e8d7f0a4d6cad3ac58cf9911b56fc09'],['REPAIR2-C1','language-soft-power-politics','5a0d93042dd7018af2d9caa53e8d71d4ebff02cb92357ce00bc817abbbe7b50b']];
const fail=s=>{throw new Error('Tranche42 rejected: '+s);};
export function validateTranche42Policy({amendment:a,strategy,freeze,status}){
 if(a?.schema!=='bareeq.audio-tts-threshold-amendment.v3'||a.decisionId!==DECISION42||a.authorizedBy!=='project-owner'||a.authorizationText!=='اعتمد'||!Number.isFinite(Date.parse(a.authorizedAt)))fail('owner decision');
 if(!['AUTHORIZED','IN_PROGRESS','CONSUMED','BLOCKED'].includes(a.authorizationStatus))fail('authorization status');
 if(a.previousThreshold!==40||a.newThreshold!==42||a.successfulRequestBaseline!==40||a.additionalSuccessfulRequestsAuthorized!==2||a.maximumProviderAttempts!==2)fail('two-request budget');
 for(const k of ['automaticExpansion','automaticRetry','automaticProviderDispatch'])if(a[k]!==false)fail(k);
 if(a.qualityPolicyUnchanged!==true||a.existingExactAudioImmutable!==true||a.priorityException?.ownerApproved!==true||a.priorityException.scope!=='these-two-legacy-repairs-before-new-content')fail('scope/priority');
 if(freeze?.active!==true||freeze.queuePolicy?.mode!=='new-content-before-renewal'||strategy?.threshold!==42||freeze.strategySnapshot?.threshold!==42||status?.exactCount!==13||strategy.exactBaseline!==13)fail('freeze/13 protected/current policy');
 if(!Number.isInteger(a.successfulRequestsConsumed)||a.successfulRequestsConsumed<0||a.successfulRequestsConsumed>2||strategy.successfulTtsSinceLastNewExact!==40+a.successfulRequestsConsumed||freeze.strategySnapshot.successfulTtsSinceLastNewExact!==strategy.successfulTtsSinceLastNewExact)fail('counter');
 if(a.targets?.length!==2||a.protectedExact?.length!==13||new Set(a.protectedExact.map(x=>x.articleId)).size!==13)fail('targets/protected set');
 for(const p of a.protectedExact){const r=status.rows.find(x=>x.articleId===p.articleId);if(!r?.publishedExact||r.fingerprint!==p.fingerprint||r.fullSha256!==p.fullSha256)fail('published identity');}
 let consumed=0,attempts=0;
 for(const [i,t] of a.targets.entries()){
  if(t.id!==approved[i][0]||t.articleId!==approved[i][1]||t.generationTextSha256!==approved[i][2]||digest42(t.generationText)!==approved[i][2]||t.maximumRequests!==1||t.maximumProviderAttempts!==1||t.automaticRetry!==false||!t.preflightPassed)fail('target text');
  const r=status.rows.find(x=>x.articleId===t.articleId);if(!r||r.publishedExact||r.fingerprint!==t.fingerprint)fail('pending target');
  if(!Number.isInteger(t.successfulTtsConsumed)||t.successfulTtsConsumed<0||t.successfulTtsConsumed>1||!Number.isInteger(t.providerAttemptsConsumed)||t.providerAttemptsConsumed<0||t.providerAttemptsConsumed>1||t.successfulTtsConsumed>t.providerAttemptsConsumed)fail('target budget');
  for(const k of ['baselineFullSha256','sourcePartSha256','speechScriptHash'])if(!/^[a-f0-9]{64}$/.test(t[k]))fail('source binding');
  for(const q of [t.quietStart,t.quietEnd])if(q.windowSamples!==1920||!Number.isFinite(q.rmsDb)||!Number.isFinite(q.peakDb)||q.rmsDb> -42||q.peakDb> -30)fail('quiet cut');
  consumed+=t.successfulTtsConsumed;attempts+=t.providerAttemptsConsumed;
 }
 if(consumed!==a.successfulRequestsConsumed||attempts!==a.providerAttemptsConsumed||attempts>2||(a.authorizationStatus==='CONSUMED'&&consumed!==2))fail('ledger totals');
 return {threshold:42,consumed,remaining:2-consumed,providerExecutionReady:a.executionStatus==='PREFLIGHT_PASSED'};
}
export async function readTranche42(root=process.cwd()){
 const j=async p=>JSON.parse(await readFile(path.join(root,p),'utf8'));
 const [amendment,strategy,freeze,status]=await Promise.all([j(TRANCHE42_PATH),j('docs/audio/ENGINE-STRATEGY-STATE.json'),j('docs/audio/TTS-FREEZE.json'),j('docs/audio/PROGRESSIVE-STATUS.json')]);
 const bytes=await readFile(path.join(root,PROPOSAL42));if(amendment.approvedProposal!==PROPOSAL42||digest42(bytes)!==amendment.approvedProposalSha256)fail('immutable approved proposal');
 const proposal=JSON.parse(bytes);if(proposal.targets.length!==2)fail('proposal target count');
 for(const [i,t] of proposal.targets.entries())for(const k of Object.keys(t))if(JSON.stringify(amendment.targets[i][k])!==JSON.stringify(t[k]))fail('approved source/text drift: '+k);
 return {...validateTranche42Policy({amendment,strategy,freeze,status}),amendment,strategy,freeze,status,proposal};
}
export function validateTranche42Dispatch({amendment:a,context:c,text,operation,env=process.env}){
 if(operation!=='gemini-generate-content-tts'||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1')fail('first main run only');
 if(a.decisionId!==DECISION42||c.decisionId!==DECISION42||a.authorizationStatus!=='IN_PROGRESS'||a.executionStatus!=='EXECUTING'||a.executionClaim?.runId!==env.GITHUB_RUN_ID||a.executionClaim.runAttempt!==1||a.successfulRequestsConsumed>=2)fail('execution claim');
 const t=a.targets.find(x=>x.id===c.requestId);
 if(!t||t.articleId!==c.articleId||t.successfulTtsConsumed!==0||t.providerAttemptsConsumed!==1||t.dispatchAttempt?.status!=='RESERVED'||t.dispatchAttempt.attemptNumber!==1||t.dispatchAttempt.runId!==env.GITHUB_RUN_ID||t.generationText!==text||digest42(text)!==c.generationTextSha256||c.generationTextSha256!==t.generationTextSha256)fail('single reserved exact text');
 return {decisionId:a.decisionId,requestId:t.id};
}
const used=new Set();
export async function tranche42OverrideAuthorized({operation,context,text,env=process.env}){
 if(!context)return null;const {amendment}=await readTranche42();const preflight=await readFile('tranche42-execution/preflight.json');if(digest42(preflight)!==amendment.executionClaim?.preflightSha256)fail('sealed preflight drift');const result=validateTranche42Dispatch({amendment,context,text,operation,env});const k=env.GITHUB_RUN_ID+':'+result.requestId;if(used.has(k))fail('duplicate dispatch');used.add(k);return result;
}
