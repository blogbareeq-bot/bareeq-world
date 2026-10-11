import {readFile,writeFile,mkdir,rename,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readTranche42,digest42,TRANCHE42_PATH} from './audio-tranche42-policy.mjs';
import {uploadAudioFile,transcribeFullAudio,extractTranscript} from './audio-asr-transcribe.mjs';
import {deleteUploadedFile} from './audio-files-api.mjs';
import {recoverRedirectedMicroReport,assertIndependentActualModels,DOCUMENTED_FLASH_REDIRECT} from './audio-asr-documented-redirect.mjs';
import {adjudicateDualAsr} from './audio-dual-asr-adjudicate.mjs';
import {loadSpokenArticle} from './audio-split.mjs';
import {validateCandidate} from './audio-validate.mjs';
const SOURCE_RUN='38121863055',out='tranche42-execution',j=async p=>JSON.parse(await readFile(p,'utf8')),w=async(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function persist(message){git('add',TRANCHE42_PATH);git('commit','-m',message);git('fetch','origin','main');git('rebase','origin/main');git('push','origin','HEAD:main');}
async function prepare(){
 const {amendment:a}=await readTranche42(),old=await j(path.join(out,'quality-result.json')),execution=await j(path.join(out,'execution-result.json')),splice=await j(path.join(out,'splice-result.json'));
 if(a.executionClaim?.runId!==SOURCE_RUN||a.authorizationStatus!=='CONSUMED'||a.executionStatus!=='EXECUTED'||execution.successfulRequestsConsumed!==2||execution.providerAttemptsConsumed!==2||old.microAsrTranscriptions!==4||old.fullAsrTranscriptions!==0)throw new Error('Consumed source execution/remaining QA binding');
 await copyFile(path.join(out,'quality-result.json'),path.join(out,'quality-before-recovery.json'));
 const result={...old,completed:false,qaRecoveryRunId:process.env.GITHUB_RUN_ID||'offline-prepare',additionalTtsCalls:0,additionalMicroAsrTranscriptions:0,documentedModelRedirect:DOCUMENTED_FLASH_REDIRECT,targets:[]};
 for(const t of a.targets){
  const row={...old.targets.find(x=>x.id===t.id)},sp=splice.targets.find(x=>x.id===t.id),dir=path.join('audio-candidates',t.articleId,t.fingerprint),article=await loadSpokenArticle(t.articleId);
  if(article.speechScriptHash!==t.speechScriptHash)throw new Error('Canonical script drift');
  const generated=execution.targets.find(x=>x.id===t.id),generatedBytes=await readFile(path.join(out,generated.generatedFile));if(digest42(generatedBytes)!==generated.generatedSha256||generated.generatedSha256!==row.generatedSha256)throw new Error('Generated identity drift');
  const rawReports=[];
  for(const model of a.asrModels){
   const reportPath=path.join(out,t.id+'-micro-asr','asr-'+model+'.json'),bytes=await readFile(reportPath),raw=JSON.parse(bytes);
   if(raw.fullSha256!==generated.generatedSha256||raw.requestedModel!==model||raw.httpStatus!==200)throw new Error('Saved micro report identity failed');
   let report=raw;
   if(!raw.transcript){report=recoverRedirectedMicroReport({report:raw,expectedText:t.generationText,audioSha256:generated.generatedSha256,extractTranscript,sourceReportSha256:digest42(bytes)});await w(path.join(out,t.id+'-micro-asr','asr-'+model+'-recovered.json'),report);}
   rawReports.push(report);
  }
  row.actualMicroModels=assertIndependentActualModels(rawReports);
  row.micro=adjudicateDualAsr({expectedText:t.generationText,reports:rawReports,articleId:t.articleId,fingerprint:t.fingerprint,fullSha256:generated.generatedSha256,speechScriptHash:t.speechScriptHash,models:a.asrModels});
  await w(path.join(out,t.id+'-micro-asr','asr-adjudication.json'),row.micro);
  if(!row.micro.passed)throw new Error('Micro speech still contains an unresolved substantive issue');
  const rawPath=path.join(dir,'parts',sp.partFile),newPart=await readFile(path.join(out,sp.candidatePartFile));
  if(digest42(await readFile(rawPath))!==t.sourcePartSha256||digest42(newPart)!==sp.candidatePartSha256||digest42(await readFile(path.join(dir,'full.mp3')))!==t.baselineFullSha256||!sp.outsidePcmIdentical||sp.prefixCorrelation<0.98||sp.suffixCorrelation<0.98)throw new Error('Source/splice binding drift');
  await copyFile(path.join(dir,'full.mp3'),path.join(out,t.id+'-baseline-full.mp3'));await copyFile(rawPath,path.join(out,t.id+'-baseline-part.mp3'));await writeFile(rawPath,newPart);
  const checkpoint=await j(path.join(dir,'checkpoint.json'));checkpoint.completedParts[String(t.partIndex)].sha256=sp.candidatePartSha256;checkpoint.completedParts[String(t.partIndex)].tranche42={targetId:t.id,baselinePartSha256:t.sourcePartSha256};await w(path.join(dir,'checkpoint.json'),checkpoint);
  await rename(path.join(dir,'reports'),path.join(dir,'baseline-reports-tranche42'));await mkdir(path.join(dir,'reports'));
  const deterministic=await validateCandidate({articleId:t.articleId,fingerprint:t.fingerprint,skipAsr:true});
  if(!deterministic.technical?.passed||!deterministic.sync?.passed||deterministic.liveUntouched!==true)throw new Error('Deterministic full gates failed');
  row.technicalPassed=true;row.synchronizationPassed=true;row.fullSha256=digest42(await readFile(path.join(dir,'full.mp3')));row.status='FULL_DETERMINISTIC_PASSED_ASR_PENDING';delete row.error;
  result.targets.push(row);await w(path.join(out,'quality-result.json'),result);console.log(`TRANCHE42_RECOVERY_PREPARED target=${t.id} micro=true technical=true sync=true tts=0`);
 }
 result.prepared=true;await w(path.join(out,'quality-result.json'),result);
}
async function full(){
 const {amendment:a}=await readTranche42(),result=await j(path.join(out,'quality-result.json')),env=process.env;
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1'||!env.GEMINI_API_KEY||a.qaRecovery?.claim||!result.prepared||result.microAsrTranscriptions!==4||result.fullAsrTranscriptions!==0||a.executionClaim.runId!==SOURCE_RUN||a.authorizationStatus!=='CONSUMED'||a.maximumFullAsrTranscriptions!==4)throw new Error('First QA-only remaining four calls required');
 a.qaRecovery={schema:'bareeq.audio-tranche42-qa-recovery.v1',sourceRunId:SOURCE_RUN,additionalTtsCalls:0,maximumAdditionalMicroCalls:0,maximumFullCalls:4,documentedModelRedirect:DOCUMENTED_FLASH_REDIRECT,claim:{runId:env.GITHUB_RUN_ID,runAttempt:1,claimedAt:new Date().toISOString()},attempts:[],status:'IN_PROGRESS'};
 await w(TRANCHE42_PATH,a);persist('audio: claim remaining four full ASR checks, no TTS');
 for(const t of a.targets){
  const row=result.targets.find(x=>x.id===t.id),article=await loadSpokenArticle(t.articleId),dir=path.join('audio-candidates',t.articleId,t.fingerprint),file=path.join(dir,'full.mp3'),reports=[];let upload;
  try{
   if(digest42(await readFile(file))!==row.fullSha256||!row.technicalPassed||!row.synchronizationPassed||!row.micro?.passed)throw new Error('Prepared full identity/gates');
   upload=await uploadAudioFile({apiKey:env.GEMINI_API_KEY,bytes:await readFile(file),displayName:t.id+'-full-repaired.mp3'});
   for(const model of a.asrModels){
    if(a.qaRecovery.attempts.length>=4||a.qaRecovery.attempts.some(x=>x.id===t.id&&x.model===model))throw new Error('Full ASR repeat/budget forbidden');
    const attempt={id:t.id,model,runId:env.GITHUB_RUN_ID,status:'RESERVED',reservedAt:new Date().toISOString()};a.qaRecovery.attempts.push(attempt);await w(TRANCHE42_PATH,a);persist('audio: reserve '+t.id+' full ASR '+model);
    const outputPath=path.join(dir,'reports','asr-'+model+'.json');let report;
    try{report=await transcribeFullAudio({model,audioPath:file,expectedText:article.spokenText,outputPath,fingerprint:t.fingerprint,fullSha256:row.fullSha256,file:upload,skipUpload:true,article,speechScriptHash:t.speechScriptHash,allowDocumentedRedirect:true});}
    catch(e){if(e.result?.httpStatus===200&&e.result?.transcript)report=e.result;else{attempt.status='FAILED_NO_RETRY';attempt.error=e.message;await w(TRANCHE42_PATH,a);persist('audio: retain failed full ASR without retry');throw e;}}
    reports.push(report);attempt.status='RESPONSE_RETAINED';attempt.actualResponseModel=report.actualResponseModel;attempt.reportSha256=digest42(await readFile(outputPath));await w(TRANCHE42_PATH,a);persist('audio: checkpoint full ASR '+t.id+' '+model);
   }
   row.actualFullModels=assertIndependentActualModels(reports);row.full=adjudicateDualAsr({expectedText:article.spokenText,reports,articleId:t.articleId,fingerprint:t.fingerprint,fullSha256:row.fullSha256,speechScriptHash:t.speechScriptHash,models:a.asrModels});
   await w(path.join(dir,'reports','asr-adjudication.json'),row.full);
   row.remainingFullAsrIssues=[...row.full.substantiveDifferences,...row.full.unresolved];row.status='GENERATED_FULL_QA_REQUIRES_OWNER_LISTENING';
  }catch(e){row.status='QA_INCOMPLETE_RETAINED';row.error=e.message;}
  finally{if(upload?.name)await w(path.join(dir,'reports','files-api-delete.json'),await deleteUploadedFile({apiKey:env.GEMINI_API_KEY,name:upload.name}).catch(e=>({deleted:false,error:e.message})));}
  result.fullAsrTranscriptions=a.qaRecovery.attempts.length;result.additionalMicroAsrTranscriptions=0;result.additionalTtsCalls=0;await w(path.join(out,'quality-result.json'),result);console.log(`TRANCHE42_RECOVERY target=${t.id} status=${row.status} issues=${row.remainingFullAsrIssues?.length??'unknown'} tts=0`);
 }
 result.completed=true;result.qaComplete=result.targets.every(x=>x.status==='GENERATED_FULL_QA_REQUIRES_OWNER_LISTENING');a.qaRecovery.status=result.qaComplete?'FULL_QA_COMPLETED_OWNER_LISTENING_PENDING':'QA_INCOMPLETE_NO_RETRY';a.qaRecovery.fullAsrTranscriptions=a.qaRecovery.attempts.length;a.qaRecovery.resultSha256=digest42(JSON.stringify(result,null,2)+'\n');await w(path.join(out,'quality-result.json'),result);await w(TRANCHE42_PATH,a);persist('audio: close QA-only recovery, preserve 42/42 TTS freeze');
 if(!result.qaComplete)process.exitCode=1;
}
if(process.argv.includes('--prepare'))await prepare();else if(process.argv.includes('--full'))await full();else throw new Error('--prepare or --full required; no synthesis operation exists');
