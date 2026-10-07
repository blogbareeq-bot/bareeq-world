import {readFile,writeFile,mkdir,copyFile,cp,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {readThresholdAmendment,AMENDMENT_PATH} from './audio-tts-threshold-amendment.mjs';
import {PREFLIGHT_PATH,digest} from './audio-tranche33-authorization.mjs';
import {synthesizeGeminiGenerateContentPart} from './audio-gemini-tts.mjs';
const out='tranche33-execution',env=process.env;
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const write=async(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n');
const files=[AMENDMENT_PATH,'docs/audio/ENGINE-STRATEGY-STATE.json','docs/audio/TTS-FREEZE.json'];
function git(...args){return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function persist(message){git('add',...files);git('commit','-m',message);git('push','origin','HEAD:main');}
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
const {amendment:a}=await readThresholdAmendment();
if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1'||!env.GEMINI_API_KEY?.trim())throw new Error('Execution requires the first main workflow attempt and credential');
if(a.executionStatus!=='PREFLIGHT_PASSED'||a.authorizationStatus!=='AUTHORIZED'||a.executionClaim||a.successfulRequestsConsumed!==0)throw new Error('Tranche already claimed, consumed, or not ready');
const bytes=await readFile(PREFLIGHT_PATH),p=JSON.parse(bytes);
if(digest(bytes)!==a.preflight.sha256||p.passedTargets!==3||p.targets.length!==3)throw new Error('Preflight is not the approved complete evidence');
await mkdir(out,{recursive:false});
// Restore and verify all three original raw parts before reserving any attempt.
for(const r of p.targets){
 const hits=await find('retained-evidence',`audio-candidates/${r.articleId}/${r.fingerprint}/full.mp3`);
 if(hits.length!==1||digest(await readFile(hits[0]))!==r.baselineFullSha256)throw new Error('Retained baseline drift');
 const sourceDir=path.dirname(hits[0]),checkpoint=await json(path.join(sourceDir,'checkpoint.json'));
 const record=checkpoint.completedParts[String(r.partIndex)];
 if(record.file!==r.sourceCheckpointRecord.file||digest(await readFile(path.join(sourceDir,'parts',record.file)))!==r.sourcePartSha256)throw new Error('Retained source part drift');
 await cp(sourceDir,path.join('audio-candidates',r.articleId,r.fingerprint),{recursive:true});
}
const strategy=await json(files[1]),freeze=await json(files[2]);
a.executionClaim={runId:env.GITHUB_RUN_ID,runAttempt:1,headSha:env.GITHUB_SHA,claimedAt:new Date().toISOString()};
a.authorizationStatus='IN_PROGRESS';a.executionStatus='EXECUTING';
for(const t of a.targets)t.dispatchAttempt={runId:env.GITHUB_RUN_ID,attemptNumber:1,status:'RESERVED'};
freeze.reviewPolicy.boundedTranche.executionStatus='EXECUTING';
await write(files[0],a);await write(files[2],freeze);
// A failed competing push stops here, before any provider request. Never retry a claim.
persist('audio: reserve the three owner-authorized micro TTS attempts');
const result={schema:'bareeq.audio-tranche33-execution.v1',runId:env.GITHUB_RUN_ID,decisionId:a.decisionId,publicationPerformed:false,targets:[]};
for(const r of p.targets){
 const t=a.targets.find(x=>x.articleId===r.articleId),row={id:r.id,articleId:r.articleId,httpAttempts:1,successfulTts:0};
 try{
  const context={articleTitle:r.articleTitle,correctionHint:r.id==='R2'?'The final reference [11] must be spoken as أحد عشر, never اثني عشر.':'Preserve the exact approved word قوى in the plural; do not say قوة. Keep only the approved transcript.'};
  if(r.id==='R1')context.correctionHint='Read every word of the short question once, with a natural curious question intonation.';
  const response=await synthesizeGeminiGenerateContentPart({apiKey:env.GEMINI_API_KEY,part:{text:r.repairText},context,tranche33Context:{decisionId:a.decisionId,articleId:r.articleId,repairTextSha256:digest(r.repairText)},onSuccessfulAudio:async audio=>{
   await write(path.join(out,r.id+'-provider-audio.json'),audio);
   t.successfulTtsConsumed=1;t.dispatchAttempt.status='SUCCESSFUL_RESPONSE';t.dispatchAttempt.responseAt=new Date().toISOString();
   a.successfulRequestsConsumed++;if(a.successfulRequestsConsumed===3)a.authorizationStatus='CONSUMED';
   strategy.successfulTtsSinceLastNewExact=30+a.successfulRequestsConsumed;strategy.lastRunId=env.GITHUB_RUN_ID;strategy.updatedAt=new Date().toISOString();
   if(a.successfulRequestsConsumed===3){strategy.status='paused';strategy.reason='Owner-approved three-request tranche exhausted; additional TTS requires a new owner decision.';}
   freeze.strategySnapshot.successfulTtsSinceLastNewExact=strategy.successfulTtsSinceLastNewExact;freeze.reviewPolicy.boundedTranche.successfulRequestsConsumed=a.successfulRequestsConsumed;
   await write(files[0],a);await write(files[1],strategy);await write(files[2],freeze);
   persist(`audio: account tranche33 ${r.id} successful response (${strategy.successfulTtsSinceLastNewExact}/33)`);
   row.successfulTts=1;
  }});
  const f=path.join(out,r.id+'-generated.mp3');await writeFile(f,response.audio);row.generatedFile=path.basename(f);row.generatedSha256=digest(response.audio);row.status='GENERATED_REQUIRES_QA';
 }catch(e){row.status='FAILED_NO_RETRY';row.error=String(e.message).slice(0,500);t.dispatchAttempt.status=t.successfulTtsConsumed?'SUCCESSFUL_RESPONSE_PROCESSING_FAILED':'FAILED_OR_UNKNOWN_RESPONSE';}
 result.targets.push(row);await write(path.join(out,'execution-result.json'),result);
 // If accounting could not be pushed after success, keep the run blocked and do not send the next request.
 if(row.successfulTts===0&&t.successfulTtsConsumed===1)throw new Error('Successful response accounting not durably acknowledged; halt all remaining dispatch');
}
a.executionStatus='EXECUTED';if(a.successfulRequestsConsumed<3)a.authorizationStatus='BLOCKED';
freeze.reviewPolicy.boundedTranche.executionStatus='EXECUTED';
await write(files[0],a);await write(files[2],freeze);persist('audio: close tranche33 execution; retain results without automatic retries');
await write(path.join(out,'execution-result.json'),{...result,successfulRequestsConsumed:a.successfulRequestsConsumed,strategy:`${strategy.successfulTtsSinceLastNewExact}/33`});
console.log(`TRANCHE33_EXECUTION successful=${a.successfulRequestsConsumed}/3 publication=false`);
