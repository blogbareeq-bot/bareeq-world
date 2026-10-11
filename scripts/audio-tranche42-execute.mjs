import {readFile,writeFile,mkdir,cp,readdir,copyFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {readTranche42,TRANCHE42_PATH,DECISION42,digest42} from './audio-tranche42-policy.mjs';
import {synthesizeGeminiGenerateContentPart} from './audio-gemini-tts.mjs';
import {loadSpokenArticle,splitSpokenArticle,activeSplitSettings} from './audio-split.mjs';
import {QUOTA_SPLIT} from './audio-constants.mjs';
import {tokenizeVerbal} from './audio-exact-match.mjs';
const out='tranche42-execution',env=process.env;
const json=async p=>JSON.parse(await readFile(p,'utf8')),write=async(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n');
const ledger=[TRANCHE42_PATH,'docs/audio/ENGINE-STRATEGY-STATE.json','docs/audio/TTS-FREEZE.json'];
const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function persist(message){git('add',...ledger);git('commit','-m',message);git('fetch','origin','main');git('rebase','origin/main');git('push','origin','HEAD:main');}
async function find(dir,suffix){const hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.endsWith(suffix))hits.push(p);}return hits;}
async function prepare(){
 const {amendment:a}=await readTranche42();if(a.executionClaim||a.providerAttemptsConsumed!==0||a.successfulRequestsConsumed!==0)throw new Error('execution already claimed');
 await mkdir(out,{recursive:true});const rows=[];
 for(const t of a.targets){
  const hits=await find(t.id==='REPAIR2-S'?'retained-evidence/touchscreen':'retained-evidence/soft-power',`audio-candidates/${t.articleId}/${t.fingerprint}/full.mp3`);if(hits.length!==1||digest42(await readFile(hits[0]))!==t.baselineFullSha256)throw new Error('baseline full mismatch');
  const source=path.dirname(hits[0]),ck=await json(path.join(source,'checkpoint.json')),rec=ck.completedParts[String(t.partIndex)];if(digest42(await readFile(path.join(source,'parts',rec.file)))!==t.sourcePartSha256)throw new Error('baseline raw part mismatch');
  const article=await loadSpokenArticle(t.articleId);if(article.speechScriptHash!==t.speechScriptHash)throw new Error('canonical script drift');
  const observed=await json('docs/audio/LIVE-AUDIO-OBSERVED-20260828.json');const plan=splitSpokenArticle(article,{settings:activeSplitSettings(QUOTA_SPLIT),liveDurationSeconds:observed.articles.find(x=>x.articleId===t.articleId)?.durationSeconds??null});
  const expected=tokenizeVerbal(plan.parts[t.partIndex].text),region=expected.slice(t.repairExpectedStart,t.repairExpectedEnd+1);
  if(JSON.stringify(region)!==JSON.stringify(tokenizeVerbal(t.generationText)))throw new Error('approved complete sentence does not match canonical part region');
  const offset=plan.parts.slice(0,t.partIndex).reduce((n,p)=>n+tokenizeVerbal(p.text).length,0);if(t.expectedIndex<offset+t.repairExpectedStart||t.expectedIndex>offset+t.repairExpectedEnd||tokenizeVerbal(t.expectedToken)[0]!==expected[t.expectedIndex-offset])throw new Error('defect outside approved repair region');
  await cp(source,path.join('audio-candidates',t.articleId,t.fingerprint),{recursive:true});rows.push({...t,sourceCheckpointRecord:rec,partExpectedOffset:offset});
 }
 await write(path.join(out,'preflight.json'),{schema:'bareeq.audio-tranche42-preflight.v1',decisionId:DECISION42,providerCalls:0,ttsCalls:0,targets:rows});
 execFileSync('python',['scripts/audio-tranche42-preflight.py'],{stdio:'inherit'});
 console.log('TRANCHE42_PREFLIGHT=PASS two original source hashes, canonical whole contexts and quiet cuts');
}
async function execute(){
 const {amendment:a,strategy,freeze}=await readTranche42();const p=await json(path.join(out,'preflight.json'));
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1'||!env.GEMINI_API_KEY?.trim()||a.authorizationStatus!=='AUTHORIZED'||a.executionStatus!=='PREFLIGHT_PASSED'||a.executionClaim||!p.passed)throw new Error('first main authorized attempt required');
 a.executionClaim={runId:env.GITHUB_RUN_ID,runAttempt:1,headSha:env.GITHUB_SHA,claimedAt:new Date().toISOString()};a.authorizationStatus='IN_PROGRESS';a.executionStatus='EXECUTING';freeze.reviewPolicy.boundedTranche42.executionStatus='EXECUTING';await write(ledger[0],a);await write(ledger[2],freeze);persist('audio: claim two approved repairs once before TTS');
 const result={schema:'bareeq.audio-tranche42-execution.v1',decisionId:DECISION42,runId:env.GITHUB_RUN_ID,publicationPerformed:false,targets:[]};
 for(const t of a.targets){
  if(t.providerAttemptsConsumed||t.dispatchAttempt)throw new Error('repeated target');
  t.providerAttemptsConsumed=1;a.providerAttemptsConsumed++;t.dispatchAttempt={runId:env.GITHUB_RUN_ID,attemptNumber:1,status:'RESERVED',reservedAt:new Date().toISOString()};await write(ledger[0],a);persist(`audio: reserve ${t.id} single provider attempt`);
  const row={id:t.id,articleId:t.articleId,httpAttempts:1,successfulTts:0};let acknowledged=false;
  try{
   const hint=t.id==='REPAIR2-S'?'Read عِنْدَمَا لَا exactly. عِنْدَمَا is one complete word including مَا; never omit مَا or say عند لا. Read بِعِنَايَة and ثُمَّ exactly.':'Read وَيَعْرِضُ (wa yaʿriḍu), with the letter ع and the vowel يَ. Never substitute غ or pronounce ويُغرض. Preserve the entire sentence and spoken citation.';
   const response=await synthesizeGeminiGenerateContentPart({apiKey:env.GEMINI_API_KEY,part:{text:t.generationText},context:{articleTitle:t.articleId,correctionHint:hint},tranche42Context:{decisionId:DECISION42,requestId:t.id,articleId:t.articleId,generationTextSha256:t.generationTextSha256},onSuccessfulAudio:async audio=>{
    const f=t.id+'-provider-audio.json';await write(path.join(out,f),audio);t.successfulTtsConsumed=1;t.dispatchAttempt.status='SUCCESSFUL_RESPONSE';t.providerReceiptSha256=digest42(await readFile(path.join(out,f)));a.successfulRequestsConsumed++;strategy.successfulTtsSinceLastNewExact=40+a.successfulRequestsConsumed;strategy.lastRunId=env.GITHUB_RUN_ID;strategy.updatedAt=new Date().toISOString();freeze.strategySnapshot.successfulTtsSinceLastNewExact=strategy.successfulTtsSinceLastNewExact;freeze.reviewPolicy.boundedTranche42.successfulRequestsConsumed=a.successfulRequestsConsumed;
    await write(ledger[0],a);await write(ledger[1],strategy);await write(ledger[2],freeze);persist(`audio: count ${t.id} successful response (${strategy.successfulTtsSinceLastNewExact}/42)`);acknowledged=true;row.successfulTts=1;row.providerReceiptFile=f;row.providerReceiptSha256=t.providerReceiptSha256;
   }});
   row.generatedFile=t.id+'-generated.mp3';await writeFile(path.join(out,row.generatedFile),response.audio);row.generatedSha256=digest42(response.audio);row.status='GENERATED_REQUIRES_QA';t.executionOutcome=row.status;
  }catch(e){row.status=t.successfulTtsConsumed?'SUCCESSFUL_RESPONSE_PROCESSING_FAILED':'FAILED_NO_RETRY';row.error=String(e.message).slice(0,800);t.executionOutcome=row.status;t.dispatchAttempt.status=row.status;}
  result.targets.push(row);result.successfulRequestsConsumed=a.successfulRequestsConsumed;result.providerAttemptsConsumed=a.providerAttemptsConsumed;await write(path.join(out,'execution-result.json'),result);await write(ledger[0],a);persist(`audio: checkpoint ${t.id}, no automatic retry`);
  if(t.successfulTtsConsumed&&!acknowledged)throw new Error('successful response accounting push unacknowledged; halt dispatch');
 }
 a.executionStatus='EXECUTED';a.authorizationStatus=a.successfulRequestsConsumed===2?'CONSUMED':'BLOCKED';strategy.status='paused';strategy.reason='Two fixed repair attempts closed; retain audio for independent QA and owner listening; no further TTS or retries authorized.';freeze.reviewPolicy.boundedTranche42.executionStatus='EXECUTED';freeze.reviewPolicy.nextAction='Complete both repaired-context QA and obtain owner listening before publication. Preserve global freeze and new-content-first policy outside the consumed exception.';await write(ledger[0],a);await write(ledger[1],strategy);await write(ledger[2],freeze);persist('audio: close bounded two-repair execution at '+strategy.successfulTtsSinceLastNewExact+'/42');
 console.log(`TRANCHE42_EXECUTION=COMPLETE successful=${a.successfulRequestsConsumed}/2 attempts=${a.providerAttemptsConsumed}/2 publication=false`);
}
if(process.argv.includes('--prepare'))await prepare();else if(process.argv.includes('--execute'))await execute();else throw new Error('choose prepare or execute');
