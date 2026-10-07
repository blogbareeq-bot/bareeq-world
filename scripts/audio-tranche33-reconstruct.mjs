import {readFile,writeFile,readdir,cp,copyFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './audio-tranche33-authorization.mjs';
import {readThresholdAmendment} from './audio-tts-threshold-amendment.mjs';
import {validateWithConsensus} from './audio-validate-consensus.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8')),write=async(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n');
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
const {remaining}=await readThresholdAmendment();if(remaining!==0)throw new Error('Only already consumed saved audio may be reconstructed');
const out='tranche33-execution';
if(!process.argv.includes('--validate')){
 const review=await json('source-review/review-manifest.json'),saved=await find('qa-evidence','tranche33-execution/execution-result.json');if(saved.length!==1)throw new Error('Ambiguous saved execution');await cp(path.dirname(saved[0]),out,{recursive:true});
 for(const r of review.targets){const hits=await find('qa-evidence',`audio-candidates/${r.articleId}/${r.fingerprint}/full.mp3`);if(hits.length!==1||digest(await readFile(hits[0]))!==r.fullSha256)throw new Error('Saved QA full SHA drift');await cp(path.dirname(hits[0]),path.join('audio-candidates',r.articleId,r.fingerprint),{recursive:true});}
 console.log('TRANCHE33_RECONSTRUCTION_INPUT=PASS tts=0');
}else{
 const splice=await json(path.join(out,'splice-result.json')),validation=await json(path.join(out,'validation-result.json'));
 for(const r of splice.targets.filter(x=>['R1','R3'].includes(x.id)&&x.status==='SPLICED_REQUIRES_FULL_QA')){
  const dir=path.join('audio-candidates',r.articleId,r.fingerprint),raw=path.join(dir,'parts',r.partFile),reports=path.join(dir,'reports');let row={...r,newPart:path.join(out,r.candidatePartFile)};
  try{
   if(digest(await readFile(raw))!==r.baselinePartSha256||digest(await readFile(row.newPart))!==r.candidatePartSha256)throw new Error('Reconstructed raw part identity drift');
   await rename(reports,path.join(dir,'baseline-reports-reconstruction33'));await mkdir(reports);await copyFile(row.newPart,raw);const checkpoint=await json(path.join(dir,'checkpoint.json'));checkpoint.completedParts[String(r.partIndex)].sha256=r.candidatePartSha256;await write(path.join(dir,'checkpoint.json'),checkpoint);
   const result=await validateWithConsensus({articleId:r.articleId,fingerprint:r.fingerprint,retryDelaysMs:[]});Object.assign(row,{status:'FULL_CONSENSUS_PASSED_REQUIRES_BOUND_REVIEW',fullSha256:result.fullSha256,models:result.models,consensus:result.consensus});
  }catch(e){const report=await json(path.join(reports,'asr-adjudication.json')).catch(()=>null);Object.assign(row,{status:'FULL_QA_OR_ASR_FAILED_RETAINED',fullSha256:await readFile(path.join(dir,'full.mp3')).then(digest),models:report?.models||null,error:e.message,consensus:e.result?.consensus||null});}
  validation.targets=validation.targets.filter(x=>x.id!==r.id);validation.targets.push(row);await write(path.join(out,'validation-result.json'),validation);console.log(`TRANCHE33_RECONSTRUCTED_QA target=${r.id} status=${row.status}`);
 }
}
