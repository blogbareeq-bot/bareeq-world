import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {readThresholdAmendment} from './audio-tts-threshold-amendment.mjs';
export const PREFLIGHT_PATH='docs/audio/TRANCHE33-PREFLIGHT.json';
export const digest=x=>createHash('sha256').update(x).digest('hex');
const fail=message=>{throw new Error(`TRANCHE33_DISPATCH_BLOCKED: ${message}`);};
export function validateTrancheDispatch({amendment:a,preflight:p,context:c,text,operation,env=process.env}){
 if(operation!=='gemini-generate-content-tts'||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1')fail('workflow scope');
 if(a.executionStatus!=='EXECUTING'||a.authorizationStatus!=='IN_PROGRESS'||a.executionClaim?.runId!==env.GITHUB_RUN_ID||a.executionClaim?.runAttempt!==1)fail('one-time execution claim');
 if(a.successfulRequestsConsumed>=3||p.passedTargets!==3||p.providerCalls!==0||p.ttsCalls!==0||p.decisionId!==a.decisionId||c?.decisionId!==a.decisionId)fail('budget or preflight');
 const t=a.targets.find(x=>x.articleId===c.articleId),r=p.targets.find(x=>x.articleId===c.articleId);
 if(!t||!r||t.successfulTtsConsumed!==0||t.dispatchAttempt?.status!=='RESERVED'||t.dispatchAttempt?.runId!==env.GITHUB_RUN_ID||t.dispatchAttempt?.attemptNumber!==1)fail('target reservation');
 if(!r.preflightPassed||r.fingerprint!==t.fingerprint||r.baselineFullSha256!==t.baselineFullSha256||r.repairText!==text||digest(text)!==c.repairTextSha256||!t.expectedSegmentText.includes(text))fail('exact authorized transcript binding');
 if(!Number.isFinite(r.cutStartSeconds)||!Number.isFinite(r.cutEndSeconds)||r.cutStartSeconds>r.cutEndSeconds||r.cutStartSeconds<0||r.cutEndSeconds-r.cutStartSeconds>65)fail('cut boundaries');
 for(const q of [r.quietStart,r.quietEnd])if(!q||q.rmsDb>-42||q.peakDb>-30)fail('quiet boundaries');
 if(r.partNumber!==t.targets[0].partNumber||t.targets.some(x=>x.partNumber!==r.partNumber||x.partLocalIndex<r.repairExpectedStart||x.partLocalIndex>r.repairExpectedEnd))fail('authorized token coverage');
 return t;
}
const used=new Set();
export async function tranche33OverrideAuthorized({operation,context,text,root=process.cwd(),env=process.env}){
 if(!context)return null;
 const {amendment}=await readThresholdAmendment(root),bytes=await readFile(path.join(root,PREFLIGHT_PATH));
 if(digest(bytes)!==amendment.preflight?.sha256)fail('preflight checksum');
 const t=validateTrancheDispatch({amendment,preflight:JSON.parse(bytes),context,text,operation,env});
 const key=`${env.GITHUB_RUN_ID}:${t.articleId}`;if(used.has(key))fail('duplicate dispatch');used.add(key);
 return {decisionId:amendment.decisionId,targetArticleId:t.articleId};
}
