import {readFile,writeFile,mkdir,copyFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {TRANCHE40_PATH,digest40} from './audio-tranche40-policy.mjs';
import {validateWithConsensus} from './audio-validate-consensus.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8')),write=async(p,j)=>writeFile(p,JSON.stringify(j,null,2)+'\n');
const out='tranche40-execution',group=process.argv[2];if(!['touchscreen','morning'].includes(group))throw new Error('invalid validation group');
const splice=await json(path.join(out,group+'-splice-result.json')),rows=splice.targets,articleId=rows[0].articleId,fingerprint=rows[0].fingerprint,dir=path.join('audio-candidates',articleId,fingerprint),reportDir=path.join(dir,'reports');
const work=rows.filter(x=>x.status==='SPLICED_REQUIRES_FULL_QA');let result={group,articleId,fingerprint,repairTargets:rows,publicationPerformed:false,ttsCalls:0,completed:false};
try{
 if(!work.length){result.status='NO_GENERATED_SENTENCE_PASSED_SPLICE';}
 else{
  const checkpoint=await json(path.join(dir,'checkpoint.json'));
  for(const r of work){const raw=path.join(dir,'parts',r.partFile),newPart=path.join(out,r.candidatePartFile);if(digest40(await readFile(raw))!==r.baselinePartSha256||digest40(await readFile(newPart))!==r.candidatePartSha256)throw new Error('repair part identity drift');await copyFile(raw,path.join(out,r.id+'-retained-baseline-part.mp3'));await copyFile(newPart,raw);checkpoint.completedParts[String(r.partIndex)].sha256=r.candidatePartSha256;checkpoint.completedParts[String(r.partIndex)].tranche40={targetId:r.id,baselinePartSha256:r.baselinePartSha256};}
  await write(path.join(dir,'checkpoint.json'),checkpoint);await rename(reportDir,path.join(dir,'baseline-reports-tranche40'));await mkdir(reportDir);
  // Do not reuse baseline ASR on a changed full file. Retain every fresh raw report.
  const qa=await validateWithConsensus({articleId,fingerprint,retryDelaysMs:[]});result={...result,status:'FULL_CONSENSUS_PASSED_REQUIRES_PUBLICATION_EVIDENCE',fullSha256:qa.fullSha256,models:qa.models,consensus:qa.consensus};
 }
}catch(e){result={...result,status:'FULL_QA_OR_ASR_FAILED_RETAINED',fullSha256:await readFile(path.join(dir,'full.mp3')).then(digest40).catch(()=>null),error:String(e.message).slice(0,800),consensus:e.result?.consensus||null};}
result.completed=true;result.runId=process.env.GITHUB_RUN_ID;await write(path.join(out,group+'-validation-result.json'),result);
const a=await json(TRANCHE40_PATH);if(a.executionClaim?.runId!==process.env.GITHUB_RUN_ID)throw new Error('QA is not from claimed run');a[group==='touchscreen'?'touchscreenQa':'morningQa']={completed:true,runId:process.env.GITHUB_RUN_ID,status:result.status,fullSha256:result.fullSha256||null,resultSha256:digest40(await readFile(path.join(out,group+'-validation-result.json')))};await write(TRANCHE40_PATH,a);
execFileSync('git',['add',TRANCHE40_PATH]);execFileSync('git',['commit','-m',`audio: checkpoint ${group} full-file QA before continuing`]);execFileSync('git',['push','origin','HEAD:main']);
console.log(`TRANCHE40_FULL_QA group=${group} status=${result.status}`);
