import {readFile,writeFile,mkdir,cp,rename,readdir} from 'node:fs/promises';
import path from 'node:path';
import {sha256,audioKeyFor} from './audio-constants.mjs';
import {loadSpokenArticle} from './audio-split.mjs';

const STATUS='docs/audio/PROGRESSIVE-STATUS.json';
const STRATEGY='docs/audio/ENGINE-STRATEGY-STATE.json';
const FREEZE='docs/audio/TTS-FREEZE.json';
const MARKER='docs/audio/PUBLISHED-SADALTAGER-PARTIAL-20260903.json';
const ISSUED='docs/audio/COMPLETION40-REVIEW-ISSUED-20261008.json';
const SOURCE_S='docs/audio/COMPLETION40-REVIEW-VALIDATION-S-20261011.json';
const SOURCE_C1='docs/audio/COMPLETION40-REVIEW-VALIDATION-C1-20261011.json';
const QA='docs/audio/TRANCHE42-QUALITY-RESULT-20261011.json';
const PACKET='docs/audio/TWO-REPAIRS-REVIEW-ISSUED-20261011.json';
const AUTH='docs/audio/TRANCHE42-OWNER-FINALIZATION-AUTHORIZATION-20261012.json';
const OUT='docs/audio/TRANCHE42-DERIVATIVE-FINALIZATION-20261012.json';
const FAILED_AUDIT={runId:38206767866,jobId:114671866612,newFullAsrCallsConsumed:1,usedForCertification:false};

const j=async p=>JSON.parse(await readFile(p,'utf8'));
const w=async(p,v)=>{await mkdir(path.dirname(p),{recursive:true});await writeFile(p,JSON.stringify(v,null,2)+'\n');};
const fail=m=>{throw new Error('TRANCHE42_DERIVATIVE_REFUSED: '+m);};
const zero=c=>['substitutions','deletions','insertions','unresolved'].every(k=>Number(c?.[k])===0);

async function allFiles(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await allFiles(p));else out.push(p);}return out;}

function sourceArticle(issued,id){const a=issued.articles.find(x=>x.articleId===id);if(!a)fail('missing completion40 issued article '+id);return a;}
function qaTarget(qa,id){const t=qa.targets.find(x=>x.id===id);if(!t)fail('missing tranche42 QA target '+id);return t;}
function packetCase(packet,id){const c=packet.cases.find(x=>x.caseId===id);if(!c)fail('missing listening packet case '+id);return c;}
function authTarget(auth,id){const t=auth.targets.find(x=>x.caseId===id);if(!t)fail('missing owner authorization target '+id);return t;}

async function verifyCandidate({id,repairId,expectedBlockerIndex,sourceValidation,issued,qa,packet,auth}){
  const target=qaTarget(qa,repairId), review=packetCase(packet,repairId), approved=authTarget(auth,repairId), source=sourceArticle(issued,id);
  if(sourceValidation.articleId!==id||sourceValidation.fingerprint!==target.fingerprint||sourceValidation.fullSha256!==source.fullSha256)fail(id+': source validation identity drift');
  if(sourceValidation.passed!==false||!Array.isArray(sourceValidation.humanConfirmedAudioErrors)||sourceValidation.humanConfirmedAudioErrors.length!==1)fail(id+': source must have exactly one owner-confirmed blocker');
  const blocker=sourceValidation.humanConfirmedAudioErrors[0];
  if(Number(blocker.expectedIndex)!==expectedBlockerIndex||blocker.articleId!==id)fail(id+': unexpected source blocker');
  if(target.status!=='QA_INCOMPLETE_RETAINED'||target.technicalPassed!==true||target.synchronizationPassed!==true||!target.micro?.passed||!zero(target.micro.consensus))fail(id+': repaired-region machine QA is not exact');
  if(target.spliceProof?.outsidePcmIdentical!==true||Math.min(Number(target.spliceProof?.prefixCorrelation||0),Number(target.spliceProof?.suffixCorrelation||0))<0.98)fail(id+': splice outside-region continuity is not proven');
  if(review.fullSha256!==target.fullSha256||review.fingerprint!==target.fingerprint||review.reviewScope!=='ENTIRE_REPAIRED_CONTEXT'||!review.coveredExpectedIndices.includes(expectedBlockerIndex))fail(id+': review packet does not cover the repaired blocker');
  if(approved.fullSha256!==target.fullSha256||approved.fingerprint!==target.fingerprint||approved.clipSha256!==review.clipSha256||approved.decision!=='EXPECTED_PRONUNCIATION_CONFIRMED')fail(id+': owner approval is not bound to repaired evidence');
  if(auth.ownerListeningPerformed!==true||auth.ownerInstruction!=='كلها سليمة')fail('owner final listening approval missing');

  const article=await loadSpokenArticle(id);
  if(article.speechScriptHash!==target.speechScriptHash||source.speechScriptHash!==target.speechScriptHash)fail(id+': speech script changed');
  const dir=path.join('audio-candidates',id,target.fingerprint);
  const full=await readFile(path.join(dir,'full.mp3'));
  if(sha256(full)!==target.fullSha256)fail(id+': repaired full SHA mismatch');
  const [checkpoint,manifest,technical,sync]=await Promise.all([
    j(path.join(dir,'checkpoint.json')),j(path.join(dir,'manifest.json')),j(path.join(dir,'reports','technical-qa.json')),j(path.join(dir,'reports','sync.json'))
  ]);
  if((manifest.candidateFingerprint||manifest.fingerprint)!==target.fingerprint||manifest.fullSha256!==target.fullSha256)fail(id+': candidate manifest identity drift');
  if(technical.passed!==true||sync.passed!==true)fail(id+': current full technical/sync reports are not passed');
  if(technical.fullSha256&&technical.fullSha256!==target.fullSha256)fail(id+': technical report SHA drift');
  if(sync.fullSha256&&sync.fullSha256!==target.fullSha256)fail(id+': sync report SHA drift');

  const currentParts=new Map();
  for(const [idx,v] of Object.entries(checkpoint.completedParts||{})){
    const partFile=path.join(dir,'parts',v.file);const digest=sha256(await readFile(partFile));
    if(digest!==v.sha256)fail(id+': checkpoint part SHA mismatch '+idx);currentParts.set(Number(idx),digest);
  }
  if(currentParts.size!==checkpoint.partCount)fail(id+': incomplete checkpoint');
  const repairedIndex=Number(target.spliceProof.partIndex);
  for(const p of source.parts||[]){
    const actual=currentParts.get(Number(p.partIndex));
    if(Number(p.partIndex)===repairedIndex){
      if(actual!==target.spliceProof.candidatePartSha256)fail(id+': repaired part SHA is not the reviewed splice candidate');
    }else if(actual!==p.sourcePartSha256){
      fail(id+': non-repaired raw part changed at index '+p.partIndex);
    }
  }
  // If a previously human-resolved issue lies inside the replaced context, the current owner review must cover it.
  const superseded=(sourceValidation.humanResolved||[]).filter(x=>review.coveredExpectedIndices.includes(Number(x.expectedIndex))).map(x=>x.caseId);
  const preserved=(sourceValidation.humanResolved||[]).filter(x=>!review.coveredExpectedIndices.includes(Number(x.expectedIndex))).map(x=>x.caseId);
  return {id,repairId,target,review,blocker,sourceValidation,source,article,dir,manifest,technical,sync,currentParts,superseded,preserved};
}

async function publish(v,reviewer,reviewedAt){
  const {id,target,dir,manifest}=v;const liveDir=path.join('public','audio','articles',audioKeyFor(id));await mkdir(liveDir,{recursive:true});
  const publishedAt=new Date().toISOString();
  const outManifest=structuredClone(manifest);
  Object.assign(outManifest,{schema:outManifest.schema||'bareeq.audio-production-manifest.v3',articleId:id,fingerprint:target.fingerprint,candidateFingerprint:target.fingerprint,publishedFromCandidate:target.fingerprint,fullSha256:target.fullSha256,speechScriptHash:target.speechScriptHash,status:'published',publishedAt,generatedAt:publishedAt});
  for(const part of outManifest.parts||[]){
    const asset=part.audio?.[outManifest.defaultVoice];if(!asset?.src||!asset.sha256)fail(id+': malformed production asset');
    const filename=path.basename(asset.src);const src=path.join(dir,'parts',filename);const bytes=await readFile(src);if(sha256(bytes)!==asset.sha256)fail(id+': part asset SHA drift '+filename);
    await cp(src,path.join(liveDir,filename));asset.src=`/audio/articles/${audioKeyFor(id)}/${filename}`;
  }
  const tmp=path.join(liveDir,`manifest.${target.fingerprint.slice(0,12)}.tmp.json`);await writeFile(tmp,JSON.stringify(outManifest,null,2)+'\n');await rename(tmp,path.join(liveDir,'manifest.json'));
  await w(path.join(dir,'reports','derivative-certification.json'),{
    schema:'bareeq.audio-tranche42-derivative-certification.v1',status:'passed',passed:true,articleId:id,fingerprint:target.fingerprint,fullSha256:target.fullSha256,speechScriptHash:target.speechScriptHash,
    method:'owner-bound-single-defect-replacement-with-identical-outside-pcm-and-local-dual-asr',sourceFullSha256:v.sourceValidation.fullSha256,sourceHumanAdjudicationStatus:v.sourceValidation.status,
    sourceOnlyConfirmedBlocker:v.blocker,repairContextSha256:v.review.clipSha256,repairMicroDualAsr:v.target.micro,technicalPassed:true,synchronizationPassed:true,
    humanListening:{status:'passed',reviewedBy:reviewer,reviewedAt,evidence:{sha256:target.fullSha256,candidateFingerprint:target.fingerprint,reviewedClipSha256:v.review.clipSha256,reviewScope:'ENTIRE_REPAIRED_CONTEXT',sampleListeningAccepted:true,fullFileListeningWaived:true}},
    preservedHumanResolvedCases:v.preserved,supersededInsideRepairedContext:v.superseded,ttsCalls:0,newAsrCalls:0,failedFullAuditCorroboration:FAILED_AUDIT
  });
  return {articleId:id,audioKey:audioKeyFor(id),fingerprint:target.fingerprint,fullSha256:target.fullSha256,parts:(outManifest.parts||[]).length,defaultVoice:outManifest.defaultVoice,publishedAt};
}

async function main(){
  if(!process.argv.includes('--execute'))fail('use --execute');
  const [status,strategy,freeze,marker,issued,sVal,cVal,qa,packet,auth]=await Promise.all([j(STATUS),j(STRATEGY),j(FREEZE),j(MARKER),j(ISSUED),j(SOURCE_S),j(SOURCE_C1),j(QA),j(PACKET),j(AUTH)]);
  if(status.exactCount!==13||status.publishedCount!==13||status.fallbackCount!==2||marker.articles.length!==13||marker.fallbacks.length!==2)fail('expected frozen 13/15 baseline');
  if(strategy.threshold!==42||strategy.successfulTtsSinceLastNewExact!==42||freeze.active!==true||freeze.strategySnapshot?.threshold!==42||freeze.strategySnapshot?.successfulTtsSinceLastNewExact!==42)fail('42/42 freeze drift');
  if(auth.additionalTtsRequestsAuthorized!==0||auth.automaticRetry!==false)fail('owner authorization permits no synthesis/retry');

  const protectedBefore=new Map();const targetKeys=new Set([audioKeyFor('how-touchscreens-work'),audioKeyFor('language-soft-power-politics')]);
  for(const f of await allFiles('public/audio')){const rel=f.replaceAll('\\','/');if([...targetKeys].some(k=>rel.includes(`/articles/${k}/`)))continue;protectedBefore.set(rel,sha256(await readFile(f)));}

  const s=await verifyCandidate({id:'how-touchscreens-work',repairId:'REPAIR2-S',expectedBlockerIndex:450,sourceValidation:sVal,issued,qa,packet,auth});
  const c=await verifyCandidate({id:'language-soft-power-politics',repairId:'REPAIR2-C1',expectedBlockerIndex:617,sourceValidation:cVal,issued,qa,packet,auth});
  const reviewer=auth.authorizedBy||'صاحب المشروع',reviewedAt=auth.authorizedAt||new Date().toISOString();
  const published=[await publish(s,reviewer,reviewedAt),await publish(c,reviewer,reviewedAt)];

  for(const v of [s,c]){const row=status.rows.find(x=>x.articleId===v.id);if(!row)fail('missing status row '+v.id);Object.assign(row,{generationStatus:'generated',validationStatus:'validated',substitutions:0,deletions:0,insertions:0,unresolved:0,exact:true,publishedExact:true,fullSha256:v.target.fullSha256,error:null,verificationMethod:'tranche42-owner-bound-derivative-v1'});}
  const now=new Date().toISOString();Object.assign(status,{generatedAt:now,sourceRunId:process.env.GITHUB_RUN_ID||null,sourceArtifact:`bareeq-tranche42-derivative-finalization-${process.env.GITHUB_RUN_ID||'local'}`,sourceEvent:process.env.GITHUB_EVENT_NAME||null,publishedCount:15,exactCount:15,fallbackCount:0,publicationComplete:true});
  for(const v of [s,c]){if(!marker.articles.some(x=>x.articleId===v.id))marker.articles.push({articleId:v.id,fingerprint:v.target.fingerprint,fullSha256:v.target.fullSha256});}
  marker.fallbacks=marker.fallbacks.filter(x=>!['how-touchscreens-work','language-soft-power-politics'].includes(x.articleId));Object.assign(marker,{generatedAt:now,publishedCount:15,fallbackCount:0,publicationComplete:true});
  Object.assign(strategy,{exactBaseline:15,lastExactAt:now,updatedAt:now,status:'paused',reason:'Legacy audio campaign reached 15/15 Exact through owner-bound derivative certification of the two final repairs; synthesis remains frozen at 42/42. Next: adjudicate the already-generated screen-focus new-content candidate.'});
  Object.assign(freeze.strategySnapshot,{exact:15,total:15,fallback:0,activePending:0,successfulTtsSinceLastNewExact:42,threshold:42});
  freeze.reason='Legacy campaign reached 15/15 Exact with zero additional TTS and zero additional provider calls in derivative finalization; synthesis remains frozen at 42/42 while the already-generated screen-focus candidate moves to adjudication/listening.';
  freeze.reviewPolicy.nextAction='Adjudicate the already-generated full screen-focus candidate against its bound SHA and issue final owner listening evidence. Do not synthesize again.';
  freeze.reviewPolicy.completion42Derivative={record:OUT,status:'PASS',publishedExact:'15/15',targets:['REPAIR2-S','REPAIR2-C1'],ttsCalls:0,newAsrCalls:0,priorFailedAuditFullAsrCallsConsumed:1,unusedAuthorizedFullAsrCalls:1,certificationMethod:'source full human adjudication + byte/PCM-preserving single-region repair + local dual-ASR 0/0/0 + owner listening'};

  const result={schema:'bareeq.audio-tranche42-derivative-finalization.v1',generatedAt:now,status:'PASS',publicationComplete:true,publishedCount:15,exactCount:15,fallbackCount:0,decisionId:auth.decisionId,ownerInstruction:auth.ownerInstruction,ownerListeningPerformed:true,sourceCompletion40:{howTouchscreens:{fullSha256:sVal.fullSha256,consensus:sVal.consensus,onlyConfirmedBlocker:s.blocker,humanResolved:sVal.humanResolved.map(x=>x.caseId)},languageSoftPower:{fullSha256:cVal.fullSha256,consensus:cVal.consensus,onlyConfirmedBlocker:c.blocker,humanResolved:cVal.humanResolved.map(x=>x.caseId)}},repairs:published.map((p,i)=>({ ...p,repairId:[s,c][i].repairId,repairContextSha256:[s,c][i].review.clipSha256,microConsensus:[s,c][i].target.micro.consensus,outsidePcmIdentical:[s,c][i].target.spliceProof.outsidePcmIdentical,prefixCorrelation:[s,c][i].target.spliceProof.prefixCorrelation,suffixCorrelation:[s,c][i].target.spliceProof.suffixCorrelation,preservedHumanResolvedCases:[s,c][i].preserved,supersededInsideRepairedContext:[s,c][i].superseded})),failedFullAuditCorroboration:{...FAILED_AUDIT,articleId:'how-touchscreens-work',substantiveDifferences:[{expectedIndex:249,expected:'ملاءمة',actual:'ملائمة',resolution:'prior-owner-bound-T07'},{expectedIndex:485,expected:'بالأرض',actual:'بالارض',resolution:'ASR-orthography-only-same-pronunciation; not needed for derivative certification'},{expectedIndex:608,expected:'النظام',actual:'نظام',resolution:'prior-owner-bound-S-02-608'},{expectedIndex:1456,expected:'يحتج',actual:'يحتاج',resolution:'prior-owner-bound-S-03-1456'}]},providerUsageThisFinalization:{ttsCalls:0,asrCalls:0,providerCalls:0},counter:'42/42',nextAction:freeze.reviewPolicy.nextAction};

  await Promise.all([[STATUS,status],[STRATEGY,strategy],[FREEZE,freeze],[MARKER,marker],[OUT,result]].map(([p,v])=>w(p,v)));
  const after=await allFiles('public/audio');const protectedAfter=after.map(x=>x.replaceAll('\\','/')).filter(rel=>![...targetKeys].some(k=>rel.includes(`/articles/${k}/`)));
  if(protectedAfter.length!==protectedBefore.size)fail('protected public/audio file set changed');for(const rel of protectedAfter){if(protectedBefore.get(rel)!==sha256(await readFile(rel)))fail('protected Exact audio changed '+rel);}
  console.log('TRANCHE42_DERIVATIVE_FINALIZATION=PASS exact=15/15 fallback=0 tts=0 asr=0 provider=0 counter=42/42');
}
await main();
