import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidProductionManifest } from './audio-manifest.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ROOT=process.cwd();
const AUTH_REL='docs/audio/NEW-CONTENT-PUBLICATION-AUTHORIZATION.json';
const RESULT_REL='docs/audio/NEW-CONTENT-FULL-SYNTHESIS-RESULT.json';
const SYNTH_AUTH_REL='docs/audio/NEW-CONTENT-FULL-SYNTHESIS-AUTHORIZATION.json';
const FREEZE_REL='docs/audio/TTS-FREEZE.json';
const PUBLICATION_REL='docs/audio/NEW-CONTENT-PUBLICATION-20261012.json';

function arg(name,fallback){
  const prefix=`--${name}=`;
  return process.argv.find(v=>v.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
const verifyOnly=process.argv.includes('--verify-only');
const sha256=(value)=>createHash('sha256').update(value).digest('hex');
const audioKeyFor=(articleId)=>sha256(Buffer.from(articleId,'utf8')).slice(0,16);
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }
async function writeJson(file,value){ await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,JSON.stringify(value,null,2)+'\n'); }
function fail(message){ throw new Error(message); }
function zeroConsensus(){ return {substitutions:0,deletions:0,insertions:0,unresolved:0}; }
function sameConsensus(a={},b={}){
  return ['substitutions','deletions','insertions','unresolved'].every(k=>Number(a[k])===Number(b[k]));
}

async function verifyCandidate({root=ROOT,artifactRoot}){
  const auth=await json(path.join(root,AUTH_REL));
  if(auth.schema!=='bareeq.audio-new-content-publication-authorization.v1') fail('unsupported publication authorization schema');
  if(auth.authorizationStatus!=='AUTHORIZED' && auth.authorizationStatus!=='EXECUTED') fail('publication authorization is not active/executed');
  if(auth.publicationAuthorized!==true || auth.publicationMethod!=='owner-full-file-listening-bound-v1') fail('publication scope is not owner-approved');
  if(auth.ownerInstruction!=='كلها سليمة') fail('owner listening instruction is not bound');
  if(Number(auth.ttsCallsAuthorized)!==0 || Number(auth.newAsrCallsAuthorized)!==0 || Number(auth.providerCallsAuthorized)!==0) fail('publication must authorize zero provider work');
  if(auth.automaticRetry!==false || auth.legacyRenewalAuthorized!==false || auth.freezeRemainsActive!==true) fail('publication authorization scope is too broad');

  const candidateDir=path.join(artifactRoot,'audio-candidates',auth.targetArticleId,auth.candidateFingerprint);
  const [fullBytes,manifest,technical,sync,baseAdj,artifactResult]=await Promise.all([
    readFile(path.join(candidateDir,'full.mp3')),
    json(path.join(candidateDir,'manifest.json')),
    json(path.join(candidateDir,'reports','technical-qa.json')),
    json(path.join(candidateDir,'reports','sync.json')),
    json(path.join(candidateDir,'reports','asr-adjudication.json')),
    json(path.join(artifactRoot,'docs','audio','NEW-CONTENT-FULL-SYNTHESIS-RESULT.json')),
  ]);
  const fullSha256=sha256(fullBytes);
  if(fullSha256!==auth.fullSha256) fail('full.mp3 SHA-256 does not match publication authorization');
  if((manifest.candidateFingerprint||manifest.fingerprint)!==auth.candidateFingerprint) fail('manifest candidate fingerprint mismatch');
  if(manifest.fullSha256!==auth.fullSha256) fail('manifest full SHA mismatch');
  if(manifest.speechScriptHash!==auth.speechScriptHash) fail('manifest speech-script hash mismatch');
  if(!isValidProductionManifest(manifest)) fail('candidate manifest is not player-compatible');
  if(!(technical.passed===true||technical.status==='passed')) fail('technical QA is not passed');
  if(!(sync.passed===true||sync.status==='passed')) fail('sync QA is not passed');
  for(const report of [technical,sync,baseAdj]){
    if((report.candidateFingerprint||report.fingerprint)!==auth.candidateFingerprint) fail('candidate identity mismatch in evidence');
    if(report.fullSha256!==auth.fullSha256) fail('full SHA mismatch in evidence');
  }
  if(baseAdj.schema!=='bareeq.audio-dual-asr-adjudication.v1') fail('unexpected base adjudication schema');
  if(!sameConsensus(baseAdj.consensus,auth.expectedBaseConsensus)) fail('base ASR consensus changed from authorized evidence');
  const flagged=[...(baseAdj.substantiveDifferences||[]),...(baseAdj.unresolved||[])];
  if(flagged.length!==Number(auth.expectedFlaggedIssues)) fail(`expected ${auth.expectedFlaggedIssues} flagged issues, found ${flagged.length}`);
  if(!Array.isArray(baseAdj.models)||baseAdj.models.length!==2||new Set(baseAdj.models).size!==2) fail('dual-ASR model pair is invalid');
  for(const model of baseAdj.models){
    const raw=await json(path.join(candidateDir,'reports',`asr-${model}.json`));
    if(Number(raw.httpStatus)!==200 || typeof raw.transcript!=='string' || !Array.isArray(raw.differences)) fail(`raw ASR evidence unusable for ${model}`);
    if((raw.candidateFingerprint||raw.fingerprint)!==auth.candidateFingerprint || raw.fullSha256!==auth.fullSha256) fail(`raw ASR identity mismatch for ${model}`);
  }
  const artifactResultSha=artifactResult.fullSha256||artifactResult.validation?.fullSha256||artifactResult.validation?.evidence?.fullSha256||null;
  if(artifactResult.candidateFingerprint!==auth.candidateFingerprint || artifactResultSha!==auth.fullSha256) fail('artifact synthesis result identity mismatch');
  if(artifactResult.technical?.status!=='passed' || artifactResult.sync?.status!=='passed') fail('artifact result technical/sync status is not passed');

  const checkedParts=[];
  for(const part of manifest.parts||[]){
    const asset=part.audio?.[manifest.defaultVoice];
    if(!asset?.src||!asset.sha256) fail('manifest part missing audio src/sha256');
    const filename=path.basename(asset.src);
    const file=path.join(candidateDir,'parts',filename);
    const bytes=await readFile(file);
    if(sha256(bytes)!==asset.sha256) fail(`part SHA mismatch: ${filename}`);
    if(asset.bytes && Number(asset.bytes)!==bytes.length) fail(`part byte-size mismatch: ${filename}`);
    if(asset.durationSeconds){
      const duration=mp3DurationSeconds(bytes);
      if(Math.abs(duration-Number(asset.durationSeconds))>0.35) fail(`part duration mismatch: ${filename}`);
    }
    checkedParts.push({filename,file,sha256:asset.sha256,bytes:bytes.length,durationSeconds:Number(asset.durationSeconds||0)});
  }
  if(checkedParts.length!==8) fail(`expected 8 published parts, found ${checkedParts.length}`);

  return {auth,candidateDir,manifest,technical,sync,baseAdj,flagged,checkedParts,fullSha256};
}

function ownerEvidence({auth,recordedAt}){
  return {
    schema:'bareeq.audio-owner-full-listening.v1',
    status:'passed',
    reviewedBy:'owner',
    reviewedAt:recordedAt,
    ownerInstruction:auth.ownerInstruction,
    scope:'full-generated-candidate-all-eight-parts',
    evidence:{
      candidateFingerprint:auth.candidateFingerprint,
      sha256:auth.fullSha256,
      speechScriptHash:auth.speechScriptHash,
      sourceRunId:auth.sourceRunId,
      sourceArtifactId:auth.sourceArtifactId,
    },
  };
}

function humanAdjudication({auth,baseAdj,flagged,human,recordedAt}){
  const resolved=flagged.map((issue,index)=>({
    caseId:`SCREEN-FOCUS-OWNER-${String(index+1).padStart(2,'0')}`,
    expectedIndex:Number(issue.expectedIndex),
    expected:issue.expected??null,
    automatedType:issue.type||'unresolved',
    automatedActual:issue.actual??issue.first?.actual??issue.second?.actual??null,
    resolution:'OWNER_FULL_LISTENING_CONFIRMED_NO_AUDIBLE_DEFECT',
    evidenceFingerprint:auth.candidateFingerprint,
    evidenceFullSha256:auth.fullSha256,
  }));
  return {
    schema:'bareeq.audio-owner-human-adjudication.v1',
    status:'validated',
    passed:true,
    articleId:auth.targetArticleId,
    fingerprint:auth.candidateFingerprint,
    candidateFingerprint:auth.candidateFingerprint,
    fullSha256:auth.fullSha256,
    speechScriptHash:auth.speechScriptHash,
    models:baseAdj.models,
    method:'independent-dual-asr-plus-owner-full-file-listening',
    baseConsensus:baseAdj.consensus,
    consensus:zeroConsensus(),
    baseAdjudicationSha256:null,
    humanResolved:resolved,
    humanConfirmedAudioErrors:[],
    humanListening:human,
    rawAsrReportsImmutable:true,
    baseAdjudicationImmutable:true,
    ttsCalls:0,
    newAsrCalls:0,
    providerCalls:0,
    generatedAt:recordedAt,
  };
}

async function publish({root=ROOT,artifactRoot}){
  const verified=await verifyCandidate({root,artifactRoot});
  const {auth,candidateDir,manifest,baseAdj,flagged,checkedParts}=verified;
  if(auth.authorizationStatus==='EXECUTED'){
    console.log('NEW_CONTENT_PUBLICATION=ALREADY_EXECUTED');
    return {alreadyExecuted:true,auth};
  }
  const recordedAt=new Date().toISOString();
  const human=ownerEvidence({auth,recordedAt});
  const humanAdj=humanAdjudication({auth,baseAdj,flagged,human,recordedAt});
  humanAdj.baseAdjudicationSha256=sha256(await readFile(path.join(candidateDir,'reports','asr-adjudication.json')));

  const audioKey=audioKeyFor(auth.targetArticleId);
  const liveDir=path.join(root,'public','audio','articles',audioKey);
  await rm(liveDir,{recursive:true,force:true});
  await mkdir(liveDir,{recursive:true});
  for(const part of checkedParts) await cp(part.file,path.join(liveDir,part.filename));

  const publishedManifest={
    ...manifest,
    schema:manifest.schema||'bareeq.audio-production-manifest.v3',
    status:'published',
    fingerprint:auth.candidateFingerprint,
    candidateFingerprint:auth.candidateFingerprint,
    fullSha256:auth.fullSha256,
    speechScriptHash:auth.speechScriptHash,
    publishedFromCandidate:auth.candidateFingerprint,
    publishedAt:recordedAt,
    generatedAt:recordedAt,
    verificationMethod:'owner-full-file-listening-bound-v1',
    humanListening:{
      status:'passed',
      reviewedBy:'owner',
      evidence:{candidateFingerprint:auth.candidateFingerprint,sha256:auth.fullSha256},
    },
    humanAdjudicationSha256:sha256(Buffer.from(JSON.stringify(humanAdj))),
  };
  await writeJson(path.join(liveDir,'manifest.json'),publishedManifest);

  const publicationRecord={
    schema:'bareeq.audio-new-content-publication.v1',
    decisionId:auth.decisionId,
    status:'PUBLISHED',
    articleId:auth.targetArticleId,
    audioKey,
    candidateFingerprint:auth.candidateFingerprint,
    fullSha256:auth.fullSha256,
    speechScriptHash:auth.speechScriptHash,
    sourceRunId:auth.sourceRunId,
    sourceArtifactId:auth.sourceArtifactId,
    sourceArtifactName:auth.sourceArtifactName,
    publicationMethod:'owner-full-file-listening-bound-v1',
    technicalQa:'passed',
    sync:'passed',
    baseAsrConsensus:baseAdj.consensus,
    humanFinalConsensus:zeroConsensus(),
    automatedFlaggedIssues:flagged.length,
    humanResolvedIssues:humanAdj.humanResolved,
    humanListening:human,
    rawAsrReportsImmutable:true,
    baseAdjudicationImmutable:true,
    baseAdjudicationSha256:humanAdj.baseAdjudicationSha256,
    publicManifestSha256:sha256(Buffer.from(JSON.stringify(publishedManifest,null,2)+'\n')),
    parts:checkedParts.map(({filename,sha256,bytes,durationSeconds})=>({filename,sha256,bytes,durationSeconds})),
    ttsCalls:0,
    newAsrCalls:0,
    providerCalls:0,
    publishedAt:recordedAt,
  };
  await writeJson(path.join(root,PUBLICATION_REL),publicationRecord);

  auth.authorizationStatus='EXECUTED';
  auth.executedAt=recordedAt;
  auth.publication={status:'PUBLISHED',audioKey,publishedAt:recordedAt,manifest:`public/audio/articles/${audioKey}/manifest.json`};
  await writeJson(path.join(root,AUTH_REL),auth);

  const synthResult=await json(path.join(root,RESULT_REL));
  synthResult.status='PUBLISHED_OWNER_VERIFIED';
  synthResult.publication={authorized:true,performed:true,method:'owner-full-file-listening-bound-v1',publishedAt:recordedAt,audioKey};
  synthResult.finalHumanListening=human;
  await writeJson(path.join(root,RESULT_REL),synthResult);

  const synthAuth=await json(path.join(root,SYNTH_AUTH_REL));
  synthAuth.publicationDecision={file:AUTH_REL,decisionId:auth.decisionId,status:'EXECUTED',publishedAt:recordedAt};
  await writeJson(path.join(root,SYNTH_AUTH_REL),synthAuth);

  const freeze=await json(path.join(root,FREEZE_REL));
  freeze.reviewPolicy=freeze.reviewPolicy||{};
  freeze.reviewPolicy.newContentPublication={
    decisionId:auth.decisionId,
    articleId:auth.targetArticleId,
    status:'PUBLISHED',
    candidateFingerprint:auth.candidateFingerprint,
    fullSha256:auth.fullSha256,
    method:'owner-full-file-listening-bound-v1',
    ttsCalls:0,
    newAsrCalls:0,
    providerCalls:0,
    publishedAt:recordedAt,
  };
  freeze.reviewPolicy.nextAction='Screen-focus new-content audio is published. Keep synthesis frozen and apply new-content-before-renewal to the next unpublished article.';
  await writeJson(path.join(root,FREEZE_REL),freeze);

  console.log(`NEW_CONTENT_PUBLICATION=PASS article=${auth.targetArticleId} audioKey=${audioKey} parts=${checkedParts.length} ownerResolved=${flagged.length} tts=0 asr=0 provider=0`);
  return publicationRecord;
}

async function cli(){
  const artifactRoot=path.resolve(arg('artifact-root','candidate-input'));
  if(verifyOnly){
    const r=await verifyCandidate({artifactRoot});
    console.log(`NEW_CONTENT_PUBLICATION_VERIFY=PASS article=${r.auth.targetArticleId} fingerprint=${r.auth.candidateFingerprint.slice(0,12)} parts=${r.checkedParts.length} flagged=${r.flagged.length} tts=0 asr=0 provider=0`);
    return;
  }
  await publish({artifactRoot});
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
