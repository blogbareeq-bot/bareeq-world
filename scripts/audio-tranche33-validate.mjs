import {readFile,writeFile,mkdir,copyFile,rename,cp,readdir} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './audio-tranche33-authorization.mjs';
import {validateWithConsensus} from './audio-validate-consensus.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const out='tranche33-execution',splice=await json(path.join(out,'splice-result.json')),work=[];
for(const r of splice.targets.filter(x=>x.status==='SPLICED_REQUIRES_FULL_QA'))work.push({...r,newPart:path.join(out,r.candidatePartFile)});
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
const rows=[];
// The owner approved both repaired words in this retained, zero-TTS passports splice.
try{
 const articleId='why-some-passports-are-stronger',fingerprint='2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b',baselineFull='597168624f702c027ede0c2a719de337149f853822ef634a715c840873703dd8';
 const hits=await find('retained-evidence',`audio-candidates/${articleId}/${fingerprint}/full.mp3`),donors=await find('passports-splice','candidate-part4.mp3');
 if(hits.length!==1||donors.length!==1||digest(await readFile(hits[0]))!==baselineFull||digest(await readFile(donors[0]))!=='a137263eac72086e47c9c60c270cfcc9e2209dab912b596bdad95c5967623a8e')throw new Error('Passports retained identity mismatch');
 const dir=path.join('audio-candidates',articleId,fingerprint);await cp(path.dirname(hits[0]),dir,{recursive:true});const record=(await json(path.join(dir,'checkpoint.json'))).completedParts['3'];
 work.push({id:'P0',articleId,fingerprint,partIndex:3,partFile:record.file,baselinePartSha256:'09b0253960eb4d5c2da1c8af50ed0e87f373b7ca030d14c09d99533ad8e68ae4',candidatePartSha256:'a137263eac72086e47c9c60c270cfcc9e2209dab912b596bdad95c5967623a8e',newPart:donors[0]});
}catch(e){rows.push({id:'P0',status:'PREPARATION_FAILED',error:e.message});}
for(const r of work){
 const dir=path.join('audio-candidates',r.articleId,r.fingerprint),raw=path.join(dir,'parts',r.partFile),reportDir=path.join(dir,'reports');
 try{
  if(digest(await readFile(raw))!==r.baselinePartSha256||digest(await readFile(r.newPart))!==r.candidatePartSha256)throw new Error('Repair input SHA mismatch');
  await copyFile(raw,path.join(out,r.id+'-retained-baseline-part.mp3'));await rename(reportDir,path.join(dir,'baseline-reports-tranche33'));await mkdir(reportDir);
  const checkpoint=await json(path.join(dir,'checkpoint.json'));await copyFile(r.newPart,raw);checkpoint.completedParts[String(r.partIndex)].sha256=r.candidatePartSha256;checkpoint.completedParts[String(r.partIndex)].tranche33={decisionId:'COMPLETION15-TRANCHE33-v1',targetId:r.id,baselinePartSha256:r.baselinePartSha256};await writeFile(path.join(dir,'checkpoint.json'),JSON.stringify(checkpoint,null,2)+'\n');
  const result=await validateWithConsensus({articleId:r.articleId,fingerprint:r.fingerprint,retryDelaysMs:[]});
  rows.push({...r,status:'FULL_CONSENSUS_PASSED_REQUIRES_BOUND_REVIEW',fullSha256:result.fullSha256,models:result.models,consensus:result.consensus});
 }catch(e){
  const fullSha256=await readFile(path.join(dir,'full.mp3')).then(digest).catch(()=>null);
  rows.push({...r,status:'FULL_QA_OR_ASR_FAILED_RETAINED',fullSha256,error:String(e.message).slice(0,600),consensus:e.result?.consensus||null});
 }
 await writeFile(path.join(out,'validation-result.json'),JSON.stringify({schema:'bareeq.audio-tranche33-validation.v1',targets:rows,publicationPerformed:false,ttsCalls:0},null,2)+'\n');
 console.log(`TRANCHE33_FULL_QA target=${r.id} status=${rows.at(-1).status}`);
}
