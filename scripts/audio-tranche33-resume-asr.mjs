import {readFile,writeFile,readdir,cp,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './audio-tranche33-authorization.mjs';
import {readThresholdAmendment} from './audio-tts-threshold-amendment.mjs';
import {validateCandidate} from './audio-validate.mjs';
import {isFallbackEligibleAsrFailure,ASR_FALLBACK_MODELS} from './audio-validate-consensus.mjs';
import {transcribeFullAudio,uploadAudioFile} from './audio-asr-transcribe.mjs';
import {deleteUploadedFile} from './audio-files-api.mjs';
import {adjudicateCandidate} from './audio-dual-asr-adjudicate.mjs';
import {loadSpokenArticle} from './audio-split.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const write=async(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n');
const primary='gemini-3.5-flash-lite',out='tranche33-execution';
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
const {remaining,amendment:a}=await readThresholdAmendment();if(remaining!==0||a.authorizationStatus!=='CONSUMED')throw new Error('Resume requires an exhausted immutable TTS tranche');
const review=await json('source-review/review-manifest.json'),saved=await find('qa-evidence','tranche33-execution/execution-result.json');if(saved.length!==1)throw new Error('Ambiguous saved execution');await cp(path.dirname(saved[0]),out,{recursive:true});
for(const r of review.targets){const hits=await find('qa-evidence',`audio-candidates/${r.articleId}/${r.fingerprint}/full.mp3`);if(hits.length!==1||digest(await readFile(hits[0]))!==r.fullSha256)throw new Error('Saved QA full SHA drift');await cp(path.dirname(hits[0]),path.join('audio-candidates',r.articleId,r.fingerprint),{recursive:true});}
function usable(r){return r?.httpStatus===200&&typeof r.transcript==='string'&&r.transcript.trim()&&Array.isArray(r.differences);}
async function request({model,audioPath,expectedText,article,fingerprint,reportsDir,uploaded}){
 try{return await transcribeFullAudio({model,audioPath,expectedText,article,fingerprint,fullSha256:digest(await readFile(audioPath)),outputPath:path.join(reportsDir,`asr-${model}.json`),file:uploaded,skipUpload:true});}
 catch(e){if(usable(e.result))return e.result;throw e;}
}
const validation=await json(path.join(out,'validation-result.json'));
for(const r of review.targets.filter(x=>['R2','P0'].includes(x.id))){
 const dir=path.join('audio-candidates',r.articleId,r.fingerprint),reportsDir=path.join(dir,'reports'),audioPath=path.join(dir,'full.mp3'),row=validation.targets.find(x=>x.id===r.id);let uploaded=null;
 try{
  const article=await loadSpokenArticle(r.articleId),cached=await json(path.join(reportsDir,`asr-${primary}.json`)),failed=await json(path.join(reportsDir,'asr-gemini-3.5-transcribe.json'));
  if(!usable(cached)||cached.fullSha256!==r.fullSha256||cached.candidateFingerprint!==r.fingerprint||cached.articleId!==r.articleId||cached.speechScriptHash!==article.speechScriptHash||cached.requestedModel!==primary)throw new Error('Existing first ASR is not fresh and bound to this exact file');
  if(!isFallbackEligibleAsrFailure({httpStatus:failed.httpStatus,result:failed})||failed.fullSha256!==r.fullSha256)throw new Error('Saved second-model failure is not the known eligible backend error');
  await validateCandidate({articleId:r.articleId,fingerprint:r.fingerprint,skipAsr:true});if(digest(await readFile(audioPath))!==r.fullSha256)throw new Error('Deterministic rebuild changed the file; refuse stale ASR reuse');
  uploaded=await uploadAudioFile({apiKey:process.env.GEMINI_API_KEY,bytes:await readFile(audioPath),displayName:r.id+'-resume-independent-asr.mp3'});const attempts=[];let second=null;
  for(const model of ASR_FALLBACK_MODELS){try{second=await request({model,audioPath,expectedText:article.spokenText,article,fingerprint:r.fingerprint,reportsDir,uploaded});attempts.push({model,outcome:'http-200',httpStatus:200});break;}catch(e){attempts.push({model,outcome:'transport-error',httpStatus:e.httpStatus||0,error:e.message});if(!isFallbackEligibleAsrFailure(e))throw e;}}
  const deletion=await deleteUploadedFile({apiKey:process.env.GEMINI_API_KEY,name:uploaded.name});uploaded=null;if(!deletion.deleted)throw new Error('Files API cleanup failed');
  await write(path.join(reportsDir,'asr-retry-log.json'),{schema:'bareeq.audio-asr-retry.v2',status:second?'completed':'failed',fingerprint:r.fingerprint,fullSha256:r.fullSha256,selectedModels:second?[primary,second.requestedModel]:[primary],firstModelReused:true,backendFailureRetained:true,attempts,deleteResult:deletion});
  if(!second)throw new Error('All supported bounded second models unavailable');
  const result=await adjudicateCandidate({articleId:r.articleId,fingerprint:r.fingerprint,models:[primary,second.requestedModel]});Object.assign(row,{status:'FULL_CONSENSUS_PASSED_REQUIRES_BOUND_REVIEW',fullSha256:result.fullSha256,models:[primary,second.requestedModel],consensus:result.consensus,error:null});
 }catch(e){Object.assign(row,{status:'FULL_QA_OR_ASR_FAILED_RETAINED',error:e.message,consensus:e.result?.consensus||null});}
 finally{if(uploaded?.name)await deleteUploadedFile({apiKey:process.env.GEMINI_API_KEY,name:uploaded.name}).catch(()=>{});}
 await write(path.join(out,'validation-result.json'),validation);console.log(`TRANCHE33_ASR_RESUME target=${r.id} status=${row.status} consensus=${JSON.stringify(row.consensus)}`);
}
// Two-model diagnostics for the local-ASR disputes; they do not approve or splice clips.
const preflight=await json('docs/audio/TRANCHE33-PREFLIGHT.json');const micros=[];
for(const r of preflight.targets.filter(x=>['R1','R3'].includes(x.id))){
 const gen=path.join(out,r.id+'-generated.mp3'),receipt=(await json(path.join(out,'execution-result.json'))).targets.find(x=>x.id===r.id);if(digest(await readFile(gen))!==receipt.generatedSha256)throw new Error('Micro receipt mismatch');
 let uploaded=null;const reports=[];await mkdir(path.join(out,r.id+'-micro-independent'),{recursive:true});
 try{
  uploaded=await uploadAudioFile({apiKey:process.env.GEMINI_API_KEY,bytes:await readFile(gen),displayName:r.id+'-generated-review.mp3'});
  for(const model of [primary,ASR_FALLBACK_MODELS[0]]){
   try{const report=await request({model,audioPath:gen,expectedText:r.repairText,article:{articleId:r.articleId,speechScriptHash:r.speechScriptHash},fingerprint:r.fingerprint,reportsDir:path.join(out,r.id+'-micro-independent'),uploaded});reports.push({model,transcript:report.transcript,passed:report.status==='passed',differences:report.differences});}
   catch(e){reports.push({model,passed:false,error:e.message});}
  }
 }finally{if(uploaded?.name)await deleteUploadedFile({apiKey:process.env.GEMINI_API_KEY,name:uploaded.name});}
 micros.push({id:r.id,generatedSha256:receipt.generatedSha256,scope:'generated-micro-only',humanReviewPerformed:false,ttsCalls:0,reports});
}
await write(path.join(out,'micro-independent-review.json'),{schema:'bareeq.audio-tranche33-micro-independent-review.v1',targets:micros,publicationPerformed:false,ttsCalls:0});
console.log('TRANCHE33_ASR_RESUME_COMPLETE tts=0 publication=false');
