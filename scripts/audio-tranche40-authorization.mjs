import {readFile} from 'node:fs/promises';
import {readThresholdAmendment} from './audio-tts-threshold-amendment.mjs';
import {DECISION40,TRANCHE40_PREFLIGHT,digest40} from './audio-tranche40-policy.mjs';
const used=new Set(),fail=s=>{throw new Error(`Tranche40 dispatch rejected: ${s}`);};
export function validateTranche40Dispatch({amendment:a,preflight:p,context:c,text,operation,env=process.env}) {
 if(operation!=='gemini-generate-content-tts'||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1')fail('first main Actions attempt only');
 if(a.decisionId!==DECISION40||c.decisionId!==DECISION40||a.authorizationStatus!=='IN_PROGRESS'||a.executionStatus!=='EXECUTING'||a.executionClaim?.runId!==env.GITHUB_RUN_ID||a.executionClaim.runAttempt!==1||a.successfulRequestsConsumed>=7)fail('claim/budget');
 if(p.schema!=='bareeq.audio-tranche40-preflight.v1'||p.decisionId!==DECISION40||p.providerCalls!==0||p.ttsCalls!==0||p.targets?.length!==7)fail('source preflight');
 const t=a.targets.find(x=>x.id===c.requestId),r=p.targets.find(x=>x.id===c.requestId);
 if(!t||!r||t.articleId!==c.articleId||t.successfulTtsConsumed!==0||t.dispatchAttempt?.status!=='RESERVED'||t.dispatchAttempt.runId!==env.GITHUB_RUN_ID||t.dispatchAttempt.attemptNumber!==1)fail('single reserved target');
 if(t.requestNumber>3&&(a.touchscreenQa?.completed!==true||a.touchscreenQa.runId!==env.GITHUB_RUN_ID))fail('touchscreen QA must finish before morning');
 if(!r.preflightPassed||r.repairText!==text||t.generationText!==text||digest40(text)!==c.repairTextSha256||c.repairTextSha256!==t.generationTextSha256)fail('approved text/preflight');
 for(const key of ['articleId','fingerprint','baselineFullSha256','sourcePartSha256','speechScriptHash','sourcePartNumber'])if(r[key]!==t[key])fail('source binding');
 if(r.partLocalIndices.some(x=>x<r.repairExpectedStart||x>r.repairExpectedEnd)||r.partLocalIndices.length!==t.expectedIndices.length)fail('repair coverage');
 if(!Number.isFinite(r.cutStartSeconds)||!Number.isFinite(r.cutEndSeconds)||r.cutStartSeconds<0||r.cutEndSeconds-r.cutStartSeconds<1||r.cutEndSeconds-r.cutStartSeconds>65)fail('source cut');
 for(const q of [r.quietStart,r.quietEnd])if(!Number.isFinite(q?.rmsDb)||!Number.isFinite(q?.peakDb)||q.rmsDb>-42||q.peakDb>-30||q.windowSamples!==1920)fail('source quiet boundary');
 return {decisionId:a.decisionId,targetArticleId:t.articleId,requestId:t.id};
}
export async function tranche40OverrideAuthorized({operation,context,text,env=process.env}) {
 if(!context)return null;
 const {amendment:a}=await readThresholdAmendment();
 const bytes=await readFile(TRANCHE40_PREFLIGHT);if(digest40(bytes)!==a.preflight?.sha256)fail('immutable preflight digest');
 const auth=validateTranche40Dispatch({amendment:a,preflight:JSON.parse(bytes),context,text,operation,env});
 const key=`${env.GITHUB_RUN_ID}:${auth.requestId}`;if(used.has(key))fail('in-process duplicate HTTP dispatch');used.add(key);return auth;
}
