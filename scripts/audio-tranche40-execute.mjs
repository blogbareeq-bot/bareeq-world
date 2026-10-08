import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {readThresholdAmendment} from './audio-tts-threshold-amendment.mjs';
import {TRANCHE40_PATH,TRANCHE40_PREFLIGHT,digest40,DECISION40} from './audio-tranche40-policy.mjs';
import {synthesizeGeminiGenerateContentPart} from './audio-gemini-tts.mjs';
const out='tranche40-execution',env=process.env,group=process.argv[2];
if(!['touchscreen','morning'].includes(group))throw new Error('expected touchscreen or morning group');
const json=async p=>JSON.parse(await readFile(p,'utf8')),write=async(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n');
const files=[TRANCHE40_PATH,'docs/audio/ENGINE-STRATEGY-STATE.json','docs/audio/TTS-FREEZE.json'];
function git(...args){return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function persist(message){git('add',...files);git('commit','-m',message);git('push','origin','HEAD:main');}
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
const {amendment:a}=await readThresholdAmendment();
if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1'||!env.GEMINI_API_KEY?.trim()||a.decisionId!==DECISION40)throw new Error('first main attempt with credential and bounded owner decision required');
const bytes=await readFile(TRANCHE40_PREFLIGHT),p=JSON.parse(bytes);if(digest40(bytes)!==a.preflight?.sha256||p.targets?.length!==7)throw new Error('approved preflight digest');
const strategy=await json(files[1]),freeze=await json(files[2]);
let result;
if(group==='touchscreen'){
 if(a.authorizationStatus!=='AUTHORIZED'||a.executionStatus!=='PREFLIGHT_PASSED'||a.executionClaim||a.successfulRequestsConsumed!==0)throw new Error('already claimed or not ready');
 await mkdir(out,{recursive:false});
 for(const articleId of [...new Set(p.targets.map(x=>x.articleId))]){
  const r=p.targets.find(x=>x.articleId===articleId),hits=await find('retained-evidence',`audio-candidates/${articleId}/${r.fingerprint}/full.mp3`);
  if(hits.length!==1||digest40(await readFile(hits[0]))!==r.baselineFullSha256)throw new Error('retained baseline full drift');
  const dir=path.dirname(hits[0]),checkpoint=await json(path.join(dir,'checkpoint.json'));
  for(const t of p.targets.filter(x=>x.articleId===articleId)){const record=checkpoint.completedParts[String(t.partIndex)];if(record.file!==t.sourceCheckpointRecord.file||digest40(await readFile(path.join(dir,'parts',record.file)))!==t.sourcePartSha256)throw new Error('source raw part drift');}
  await cp(dir,path.join('audio-candidates',articleId,r.fingerprint),{recursive:true});
 }
 a.executionClaim={runId:env.GITHUB_RUN_ID,runAttempt:1,headSha:env.GITHUB_SHA,claimedAt:new Date().toISOString()};a.authorizationStatus='IN_PROGRESS';a.executionStatus='EXECUTING';
 freeze.reviewPolicy.boundedTranche40.executionStatus='EXECUTING';
 await write(files[0],a);await write(files[2],freeze);persist('audio: claim owner-approved tranche40 once before any TTS');
 result={schema:'bareeq.audio-tranche40-execution.v1',runId:env.GITHUB_RUN_ID,decisionId:a.decisionId,publicationPerformed:false,targets:[]};
}else{
 if(a.executionClaim?.runId!==env.GITHUB_RUN_ID||a.executionStatus!=='EXECUTING'||a.touchscreenQa?.completed!==true||a.touchscreenQa.runId!==env.GITHUB_RUN_ID)throw new Error('same claimed run after touchscreen full QA required');
 result=await json(path.join(out,'execution-result.json'));
}
const targets=p.targets.filter(r=>group==='touchscreen'?r.requestNumber<=3:r.requestNumber>3);
for(const r of targets){
 const t=a.targets.find(x=>x.id===r.id),row={id:r.id,articleId:r.articleId,httpAttempts:0,successfulTts:0};
 if(t.dispatchAttempt||result.targets.some(x=>x.id===r.id))throw new Error('refuse repeated target attempt');
 if(!r.preflightPassed){t.status='BLOCKED_UNSAFE_SOURCE_CUT';row.status=t.status;row.error=r.reason;result.targets.push(row);continue;}
 t.dispatchAttempt={runId:env.GITHUB_RUN_ID,attemptNumber:1,status:'RESERVED',reservedAt:new Date().toISOString()};
 await write(files[0],a);persist(`audio: reserve ${r.id} single TTS attempt before dispatch`);
 let receiptAcknowledged=false;
 try{
  const hints={S1:'Say الشَّاشة in the singular, never الشاشات; read وَتَتَكَوَّنُ exactly.',S2:'Say إِنَّهُ, never أَنَّهُ.',S3:'Say بِهِ, never بها.',M3:'Read نصف أجره as نِصْفَ أَجْرِهِ, from wages; never أزره.',M8:'Say إنه, never إنها.',M11:'The numeral 24 means أربعًا وعشرين ساعة, never اثني عشر or 12.',M13:'Preserve the entire clause وما يحتاج إلى مساعدة, وما يستحق أن تراه من جديد. Say يستحق, never يستطيع or تستطيع.'};
  row.httpAttempts=1;
  const response=await synthesizeGeminiGenerateContentPart({apiKey:env.GEMINI_API_KEY,part:{text:r.repairText},context:{articleTitle:r.articleTitle,correctionHint:hints[r.caseIds[0]]},tranche40Context:{decisionId:a.decisionId,requestId:r.id,articleId:r.articleId,repairTextSha256:r.repairTextSha256},onSuccessfulAudio:async audio=>{
   const receiptFile=r.id+'-provider-audio.json';await write(path.join(out,receiptFile),audio);
   t.successfulTtsConsumed=1;t.dispatchAttempt.status='SUCCESSFUL_RESPONSE';t.dispatchAttempt.responseAt=new Date().toISOString();t.providerReceiptSha256=digest40(await readFile(path.join(out,receiptFile)));
   a.successfulRequestsConsumed++;strategy.successfulTtsSinceLastNewExact=33+a.successfulRequestsConsumed;strategy.lastRunId=env.GITHUB_RUN_ID;strategy.updatedAt=new Date().toISOString();freeze.strategySnapshot.successfulTtsSinceLastNewExact=strategy.successfulTtsSinceLastNewExact;freeze.reviewPolicy.boundedTranche40.successfulRequestsConsumed=a.successfulRequestsConsumed;
   await write(files[0],a);await write(files[1],strategy);await write(files[2],freeze);persist(`audio: count ${r.id} successful response (${strategy.successfulTtsSinceLastNewExact}/40)`);receiptAcknowledged=true;row.successfulTts=1;row.providerReceiptFile=receiptFile;row.providerReceiptSha256=t.providerReceiptSha256;
  }});
  const file=r.id+'-generated.mp3';await writeFile(path.join(out,file),response.audio);row.generatedFile=file;row.generatedSha256=digest40(response.audio);row.status='GENERATED_REQUIRES_QA';t.status=row.status;
 }catch(e){row.status=t.successfulTtsConsumed?'SUCCESSFUL_RESPONSE_PROCESSING_FAILED':'FAILED_NO_RETRY';row.error=String(e.message).slice(0,500);t.status=row.status;t.dispatchAttempt.status=row.status;}
 result.targets.push(row);result.successfulRequestsConsumed=a.successfulRequestsConsumed;result.strategy=`${strategy.successfulTtsSinceLastNewExact}/40`;await write(path.join(out,'execution-result.json'),result);await write(files[0],a);persist(`audio: checkpoint ${r.id}; automatic retries forbidden`);
 if(t.successfulTtsConsumed&&!receiptAcknowledged)throw new Error('Successful response ledger push unacknowledged; halt all remaining dispatch');
}
await write(path.join(out,'execution-result.json'),result);
if(group==='morning'){
 a.executionStatus='EXECUTED';a.authorizationStatus=a.successfulRequestsConsumed===7?'CONSUMED':'BLOCKED';freeze.reviewPolicy.boundedTranche40.executionStatus='EXECUTED';strategy.reason='Bounded tranche40 attempts closed; unused budget cannot be retried automatically.';await write(files[0],a);await write(files[1],strategy);await write(files[2],freeze);persist('audio: close seven-target tranche40 execution without retries');
}
console.log(`TRANCHE40_EXECUTION group=${group} successful=${a.successfulRequestsConsumed}/7 publication=false`);
