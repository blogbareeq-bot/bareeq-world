import {readFile,writeFile,readdir,cp,mkdir,copyFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {sha256,audioKeyFor} from './audio-constants.mjs';
import {validateWithConsensus} from './audio-validate-consensus.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8')),write=async(p,j)=>writeFile(p,JSON.stringify(j,null,2)+'\n');
const out='round1-output';
const preflight=await json('docs/audio/TRANCHE33-PREFLIGHT.json'),r=preflight.targets.find(x=>x.id==='R3');
const submission=await readFile('docs/audio/REVIEW-ROUND1-SUBMISSION.json'),bound=await json('docs/audio/BOUND-REVIEW-ROUND1.json'),d=bound.decisions.find(x=>x.caseId==='R3');
if(sha256(submission)!==bound.sourceSubmissionSha256||d.submissionSha256!==bound.sourceSubmissionSha256||!d.bindingVerified||!d.humanReviewPerformed||d.decision!=='EXPECTED_PRONUNCIATION_CONFIRMED'||d.fullSha256!==null||d.generatedMicroSha256!==d.clipSha256||d.articleId!==r.articleId||d.fingerprint!==r.fingerprint||d.baselineFullSha256!==r.baselineFullSha256||d.expectedText!==r.repairText)throw new Error('Round1 micro review is not bound to issued source');
const strategy=await json('docs/audio/ENGINE-STRATEGY-STATE.json'),amendment=await json('docs/audio/TTS-THRESHOLD-AMENDMENT-33.json');
if(strategy.threshold!==33||strategy.successfulTtsSinceLastNewExact!==33||amendment.successfulRequestsConsumed!==3||amendment.authorizationStatus!=='CONSUMED')throw new Error('Preserve exhausted strategy accounting');
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
async function protect(){for(const p of amendment.protectedExact){const m=await json(path.join('public/audio/articles',audioKeyFor(p.articleId),'manifest.json'));if((m.candidateFingerprint||m.fingerprint)!==p.fingerprint||m.fullSha256!==p.fullSha256)throw new Error('Protected published Exact identity changed');}}
await protect();
const dir=path.join('audio-candidates',r.articleId,r.fingerprint);
if(!process.argv.includes('--qa')){
 await mkdir(out);const full=await find('saved-evidence',`audio-candidates/${r.articleId}/${r.fingerprint}/full.mp3`),micro=await find('saved-evidence','tranche33-execution/R3-generated.mp3');
 if(full.length!==1||micro.length!==1||sha256(await readFile(full[0]))!==r.baselineFullSha256||sha256(await readFile(micro[0]))!==d.clipSha256)throw new Error('Saved source SHA drift or ambiguity');
 await cp(path.dirname(full[0]),dir,{recursive:true});const part=path.join(dir,'parts',r.sourceCheckpointRecord.file);
 if(sha256(await readFile(part))!==r.sourcePartSha256)throw new Error('Saved raw part identity drift');
 await copyFile(part,path.join(out,'baseline-part.mp3'));await copyFile(micro[0],path.join(out,'approved-micro.mp3'));
 await write(path.join(out,'review-input.json'),{...bound,candidateFullSha256:null});console.log('ROUND1_INPUT=VERIFIED tts=0 publication=0');
}else{
 const s=await json(path.join(out,'splice-result.json')),newPart=path.join(out,'candidate-part.mp3'),raw=path.join(dir,'parts',s.partFile),reports=path.join(dir,'reports');
 if(!s.outsidePcmIdentical||s.generatedMicroSha256!==d.clipSha256||s.sourceSubmissionSha256!==bound.sourceSubmissionSha256||sha256(await readFile(newPart))!==s.candidatePartSha256||sha256(await readFile(raw))!==s.baselinePartSha256)throw new Error('Splice proof identity mismatch');
 await rename(reports,path.join(dir,'baseline-reports-round1'));await mkdir(reports);await copyFile(newPart,raw);
 const ck=await json(path.join(dir,'checkpoint.json'));ck.completedParts[String(s.partIndex)].sha256=s.candidatePartSha256;ck.completedParts[String(s.partIndex)].boundReviewRound1=s;await write(path.join(dir,'checkpoint.json'),ck);
 let result;
 try{const qa=await validateWithConsensus({articleId:r.articleId,fingerprint:r.fingerprint,retryDelaysMs:[]});result={status:'FULL_CONSENSUS_PASSED',fullSha256:qa.fullSha256,models:qa.models,consensus:qa.consensus};}
 catch(e){const adj=await json(path.join(reports,'asr-adjudication.json')).catch(()=>null);result={status:'FULL_QA_OR_ASR_FAILED_RETAINED',fullSha256:sha256(await readFile(path.join(dir,'full.mp3'))),error:e.message,models:adj?.models||null,consensus:adj?.consensus||null};}
 result={schema:'bareeq.audio-round1-satellite-result.v1',articleId:r.articleId,fingerprint:r.fingerprint,...result,reviewedMicro:d,splice:s,ttsCalls:0,publicationPerformed:false};
 await write(path.join(out,'result.json'),result);await copyFile(path.join(dir,'full.mp3'),path.join(out,'full-candidate.mp3'));
 for(const name of ['technical-qa.json','sync.json','asr-adjudication.json','asr-retry-log.json']){const bytes=await readFile(path.join(reports,name)).catch(()=>null);if(bytes)await writeFile(path.join(out,name),bytes);}
 console.log(`ROUND1_QA=${result.status} fullSha=${result.fullSha256} tts=0 publication=0`);await protect();
}
