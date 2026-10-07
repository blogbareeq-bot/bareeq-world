import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './audio-constants.mjs';

const ARTICLE='why-some-passports-are-stronger';
const FALSE_POSITIVE='T02';
const TARGET='T03';

function arg(name,fallback){ const p=`--${name}=`; return process.argv.find(x=>x.startsWith(p))?.slice(p.length)||fallback; }
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }
function recompute(report){
  const substantive=report.substantiveDifferences||[];
  const unresolved=report.unresolved||[];
  report.consensus={
    substitutions:substantive.filter(x=>x.type==='substitution').length,
    deletions:substantive.filter(x=>x.type==='deletion').length,
    insertions:substantive.filter(x=>x.type==='insertion').length,
    unresolved:unresolved.length,
  };
  report.passed=Object.values(report.consensus).every(v=>Number(v)===0);
  report.status=report.passed?'passed':'failed';
  return report;
}
function removeExactIssue(report,mapping,caseId){
  const candidates=[];
  for(const [name,arr] of [['substantiveDifferences',report.substantiveDifferences||[]],['unresolved',report.unresolved||[]]]){
    arr.forEach((item,index)=>{
      if(Number(item.expectedIndex)===Number(mapping.expectedIndex)) candidates.push({name,arr,index,item});
    });
  }
  if(candidates.length!==1) throw new Error(`${caseId}: expected one mapped issue, found ${candidates.length}`);
  const hit=candidates[0];
  hit.arr.splice(hit.index,1);
  return hit.item;
}
export async function prepareGate5Passports({root=process.cwd(),triageRoot}){
  const auth=await json(path.join(root,'docs','audio','GATE-5-AUTHORIZATION.json'));
  if(auth.authorizationStatus!=='AUTHORIZED'||Number(auth.successfulTtsRequestsAuthorized)!==1||auth.decisionId!=='GATE5-PASSPORTS-v1') throw new Error('Gate 5 authorization is not exactly one authorized passports request');
  const status=await json(path.join(root,'docs','audio','PROGRESSIVE-STATUS.json'));
  if(status.exactCount!==9||status.publishedCount!==9||status.fallbackCount!==6) throw new Error('canonical state must be 9/15 before Gate 5');
  const row=status.rows.find(x=>x.articleId===ARTICLE);
  if(!row||row.exact) throw new Error('passports row is missing or already Exact');
  const triage=await json(path.join(root,'docs','audio','HUMAN-TRIAGE-FULL-RESULT-20261006.json'));
  if(!(triage.confirmedFalsePositiveCandidates||[]).includes(FALSE_POSITIVE)) throw new Error('T02 is not a confirmed human false positive');
  if(!(triage.confirmedTargetAudioErrors||[]).includes(TARGET)) throw new Error('T03 is not a confirmed audio error');
  const internal=await json(path.join(triageRoot,'internal-evidence.json'));
  const fp=internal.mapping?.[FALSE_POSITIVE], target=internal.mapping?.[TARGET];
  if(!fp||!target||fp.articleId!==ARTICLE||target.articleId!==ARTICLE) throw new Error('T02/T03 mappings are not bound to passports');
  if(fp.fingerprint!==row.fingerprint||target.fingerprint!==row.fingerprint||fp.fullSha256!==row.fullSha256||target.fullSha256!==row.fullSha256) throw new Error('human evidence identity mismatch');
  if(Number(fp.partIndex)===Number(target.partIndex)||fp.segmentId===target.segmentId) throw new Error('false-positive evidence overlaps the repair surface');
  if(Number(fp.partIndex)!==5||fp.segmentId!=='b0046') throw new Error('unexpected T02 location');
  if(Number(target.partIndex)!==3||target.segmentId!=='b0030'||target.expectedToken!=='لا') throw new Error('unexpected T03 location');

  const dir=path.join(root,'audio-candidates',ARTICLE,row.fingerprint);
  const adjudicationPath=path.join(dir,'reports','asr-adjudication.json');
  const backupPath=path.join(dir,'reports','asr-adjudication.pre-gate5.json');
  const report=await json(adjudicationPath);
  if((report.fingerprint||report.candidateFingerprint)!==row.fingerprint||report.fullSha256!==row.fullSha256) throw new Error('baseline adjudication identity mismatch');
  await copyFile(adjudicationPath,backupPath);
  const removed=removeExactIssue(report,fp,FALSE_POSITIVE);
  recompute(report);
  const total=Object.values(report.consensus).reduce((a,b)=>a+Number(b||0),0);
  if(total!==1) throw new Error(`Gate 5 temporary adjudication must contain exactly one target issue; got ${total}`);
  const all=[...(report.substantiveDifferences||[]),...(report.unresolved||[])];
  if(all.length!==1||Number(all[0].expectedIndex)!==Number(target.expectedIndex)) throw new Error('remaining issue is not T03');
  report.schema='bareeq.audio-dual-asr-adjudication.v1';
  report.gate5HumanOverlay={
    decisionId:auth.decisionId,
    removedFalsePositiveCase:FALSE_POSITIVE,
    removedExpectedIndex:Number(fp.expectedIndex),
    removedIssue:removed,
    preservedTargetCase:TARGET,
    preservedExpectedIndex:Number(target.expectedIndex),
    overlap:false,
    rawBaselineBackup:path.basename(backupPath),
  };
  await writeFile(adjudicationPath,JSON.stringify(report,null,2)+'\n');

  const checkpoint=await json(path.join(dir,'checkpoint.json'));
  const targetRecord=checkpoint.completedParts?.['3'];
  const fpRecord=checkpoint.completedParts?.['5'];
  if(!targetRecord?.file||!fpRecord?.file) throw new Error('checkpoint part records missing');
  const targetBytes=await readFile(path.join(dir,'parts',targetRecord.file));
  const fpBytes=await readFile(path.join(dir,'parts',fpRecord.file));
  if(targetRecord.sha256&&sha256(targetBytes)!==targetRecord.sha256) throw new Error('target part SHA mismatch');
  if(fpRecord.sha256&&sha256(fpBytes)!==fpRecord.sha256) throw new Error('false-positive part SHA mismatch');

  const context={
    schema:'bareeq.audio-gate5-passports-execution-context.v1',
    decisionId:auth.decisionId,
    articleId:ARTICLE,
    fingerprint:row.fingerprint,
    baselineFullSha256:row.fullSha256,
    target:{caseId:TARGET,partIndex:3,partNumber:4,segmentId:'b0030',expectedIndex:Number(target.expectedIndex),expectedToken:'لا',baselinePartFile:targetRecord.file,baselinePartSha256:sha256(targetBytes)},
    carriedHumanEvidence:{caseId:FALSE_POSITIVE,partIndex:5,partNumber:6,segmentId:'b0046',expectedIndex:Number(fp.expectedIndex),expectedToken:fp.expectedToken,baselinePartFile:fpRecord.file,baselinePartSha256:sha256(fpBytes)},
    temporaryConsensus:report.consensus,
    successfulTtsRequestsAuthorized:1,
  };
  await writeFile(path.join(dir,'gate5-execution-context.json'),JSON.stringify(context,null,2)+'\n');
  return context;
}
async function cli(){
 const root=path.resolve(arg('root',process.cwd()));
 const triageRoot=path.resolve(arg('triage-root','triage-input'));
 const r=await prepareGate5Passports({root,triageRoot});
 console.log(`GATE5_EXECUTION_PREP=PASS target=${r.target.caseId} part=${r.target.partNumber} segment=${r.target.segmentId} carry=${r.carriedHumanEvidence.caseId}@part${r.carriedHumanEvidence.partNumber} authorized=1`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
