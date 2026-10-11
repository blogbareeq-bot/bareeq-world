import {readFile,writeFile,mkdir,rename,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {readTranche42,digest42} from './audio-tranche42-policy.mjs';
import {transcribeFullAudio,uploadAudioFile} from './audio-asr-transcribe.mjs';
import {deleteUploadedFile} from './audio-files-api.mjs';
import {adjudicateDualAsr} from './audio-dual-asr-adjudicate.mjs';
import {loadSpokenArticle} from './audio-split.mjs';
import {validateCandidate} from './audio-validate.mjs';
const out='tranche42-execution',json=async p=>JSON.parse(await readFile(p,'utf8')),write=async(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n');
const {amendment:a}=await readTranche42();if(a.executionClaim?.runId!==process.env.GITHUB_RUN_ID||a.executionStatus!=='EXECUTED')throw new Error('same claimed execution required for QA');
let microCalls=0,fullCalls=0;
async function dual({t,file,expected,article,dir,kind}){
 await mkdir(dir,{recursive:true});const bytes=await readFile(file),sha=digest42(bytes),reports=[];let upload;
 try{
  upload=await uploadAudioFile({apiKey:process.env.GEMINI_API_KEY,bytes,displayName:t.id+'-'+kind+'.mp3'});
  for(const model of a.asrModels){
   if(kind==='micro'){if(++microCalls>4)throw new Error('micro ASR budget');}else if(++fullCalls>4)throw new Error('full ASR budget');
   try{reports.push(await transcribeFullAudio({model,audioPath:file,expectedText:expected,outputPath:path.join(dir,'asr-'+model+'.json'),fingerprint:t.fingerprint,fullSha256:sha,file:upload,skipUpload:true,article,speechScriptHash:t.speechScriptHash}));}
   catch(e){if(e.result?.httpStatus===200&&e.result?.transcript)reports.push(e.result);else throw e;}
  }
 }finally{if(upload?.name)await write(path.join(dir,'files-api-delete.json'),await deleteUploadedFile({apiKey:process.env.GEMINI_API_KEY,name:upload.name}).catch(e=>({deleted:false,error:e.message})));}
 const result=adjudicateDualAsr({expectedText:expected,reports,articleId:t.articleId,fingerprint:t.fingerprint,fullSha256:sha,speechScriptHash:t.speechScriptHash,models:a.asrModels});
 await write(path.join(dir,'asr-adjudication.json'),result);return result;
}
const generated=await json(path.join(out,'execution-result.json')),splice=await json(path.join(out,'splice-result.json')),result={schema:'bareeq.audio-tranche42-qa.v1',decisionId:a.decisionId,runId:process.env.GITHUB_RUN_ID,publicationPerformed:false,additionalTtsCalls:0,ownerListeningRequired:true,targets:[]};
for(const t of a.targets){
 const row={id:t.id,articleId:t.articleId,fingerprint:t.fingerprint,speechScriptHash:t.speechScriptHash,expectedToken:t.expectedToken,expectedIndex:t.expectedIndex,partNumber:t.partNumber};
 try{
  const gen=generated.targets.find(x=>x.id===t.id),sp=splice.targets.find(x=>x.id===t.id);if(gen?.status!=='GENERATED_REQUIRES_QA'||sp?.status!=='SPLICED_REQUIRES_FULL_QA')throw new Error('generated or splice gate incomplete');
  const article=await loadSpokenArticle(t.articleId),dir=path.join('audio-candidates',t.articleId,t.fingerprint),raw=path.join(dir,'parts',sp.partFile),replacement=path.join(out,sp.candidatePartFile);
  if(digest42(await readFile(raw))!==t.sourcePartSha256||digest42(await readFile(replacement))!==sp.candidatePartSha256)throw new Error('source/candidate raw part binding');
  row.generatedSha256=gen.generatedSha256;row.repairedContextFile=sp.repairedContextFile;row.repairedContextSha256=sp.repairedContextSha256;row.spliceProof=sp;
  if(digest42(await readFile(path.join(out,gen.generatedFile)))!==gen.generatedSha256)throw new Error('generated clip changed');
  row.micro=await dual({t,file:path.join(out,gen.generatedFile),expected:t.generationText,article,dir:path.join(out,t.id+'-micro-asr'),kind:'micro'});
  await copyFile(path.join(dir,'full.mp3'),path.join(out,t.id+'-baseline-full.mp3'));await copyFile(raw,path.join(out,t.id+'-baseline-part.mp3'));await copyFile(replacement,raw);
  const ck=await json(path.join(dir,'checkpoint.json'));ck.completedParts[String(t.partIndex)].sha256=sp.candidatePartSha256;ck.completedParts[String(t.partIndex)].tranche42={targetId:t.id,baselinePartSha256:t.sourcePartSha256};await write(path.join(dir,'checkpoint.json'),ck);
  await rename(path.join(dir,'reports'),path.join(dir,'baseline-reports-tranche42'));await mkdir(path.join(dir,'reports'));
  const deterministic=await validateCandidate({articleId:t.articleId,fingerprint:t.fingerprint,skipAsr:true});if(!deterministic.technical?.passed||!deterministic.sync?.passed||deterministic.liveUntouched!==true)throw new Error('full deterministic gates failed');
  row.technicalPassed=true;row.synchronizationPassed=true;row.fullSha256=digest42(await readFile(path.join(dir,'full.mp3')));
  row.full=await dual({t,file:path.join(dir,'full.mp3'),expected:article.spokenText,article,dir:path.join(dir,'reports'),kind:'full'});
  row.status='GENERATED_FULL_QA_REQUIRES_OWNER_LISTENING';row.remainingFullAsrIssues=[...row.full.substantiveDifferences,...row.full.unresolved];
 }catch(e){row.status='QA_INCOMPLETE_RETAINED';row.error=String(e.message).slice(0,1000);}
 result.targets.push(row);result.microAsrTranscriptions=microCalls;result.fullAsrTranscriptions=fullCalls;await write(path.join(out,'quality-result.json'),result);console.log(`TRANCHE42_QA target=${t.id} status=${row.status} technical=${row.technicalPassed||false} sync=${row.synchronizationPassed||false}`);
}
result.completed=true;result.microAsrTranscriptions=microCalls;result.fullAsrTranscriptions=fullCalls;await write(path.join(out,'quality-result.json'),result);
