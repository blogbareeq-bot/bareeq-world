import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {sha256,audioKeyFor,INDEPENDENT_ASR_MODELS,PRODUCTION_TTS_MODEL,PRODUCTION_VOICE_ID} from './audio-constants.mjs';
import {loadSpokenArticle} from './audio-split.mjs';
import {uploadAudioFile,transcribeFullAudio} from './audio-asr-transcribe.mjs';
import {deleteUploadedFile} from './audio-files-api.mjs';
import {adjudicateCandidate} from './audio-dual-asr-adjudicate.mjs';
import {publishApprovedCandidate} from './audio-publish.mjs';
import {readAmbiguityRules,readTestClipPlan,validateSpeechScript} from './speech-script-core.mjs';
import {waitAndVerifyPublished} from './audio-publish-verify.mjs';

const AUTH='docs/audio/TRANCHE42-OWNER-FINALIZATION-AUTHORIZATION-20261012.json';
const QA='docs/audio/TRANCHE42-QA-STATUS-20261011.json';
const STATUS='docs/audio/PROGRESSIVE-STATUS.json';
const STRATEGY='docs/audio/ENGINE-STRATEGY-STATE.json';
const FREEZE='docs/audio/TTS-FREEZE.json';
const MARKER='docs/audio/PUBLISHED-SADALTAGER-PARTIAL-20260903.json';
const OUT='docs/audio/TRANCHE42-FINALIZATION-20261012.json';
const LIVE='docs/audio/TRANCHE42-LIVE-VERIFICATION-20261012.json';
const FIRST=INDEPENDENT_ASR_MODELS[0];
const SECOND=INDEPENDENT_ASR_MODELS[1];
const j=async p=>JSON.parse(await readFile(p,'utf8'));
const w=async(p,v)=>{await mkdir(path.dirname(p),{recursive:true});await writeFile(p,JSON.stringify(v,null,2)+'\n');};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=m=>{throw new Error(`TRANCHE42_FINALIZE_REFUSED: ${m}`);};

async function preflight(){
 const [a,q,s,e,f,m]=await Promise.all([j(AUTH),j(QA),j(STATUS),j(STRATEGY),j(FREEZE),j(MARKER)]);
 if(a.schema!=='bareeq.audio-tranche42-owner-finalization-authorization.v1')fail('authorization schema');
 if(a.sourceDecisionId!=='COMPLETION15-TWO-REPAIRS-20261011-v1'||a.ownerInstruction!=='كلها سليمة'||a.continuationInstruction!=='أكمل من المحادثة السابقة')fail('owner instruction binding');
 if(a.ownerListeningPerformed!==true||a.additionalTtsRequestsAuthorized!==0||a.additionalFullAsrRequestsAuthorized!==2||a.automaticRetry!==false||a.publicationAuthorizedOnlyIfAllGatesPass!==true)fail('authorization limits');
 if(a.retainedModel!==FIRST||a.secondModel!==SECOND||FIRST!=='gemini-3.5-flash-lite'||SECOND!=='gemini-3.5-transcribe')fail('current independent ASR pair drift');
 if(q.decisionId!==a.sourceDecisionId||q.packetId!==a.reviewedPacketId||q.packetSha256!==a.reviewedPacketSha256||q.publishedExact!==13||q.publicationPerformed!==false||q.technicalPassed!==true||q.synchronizationPassed!==true)fail('issued review state drift');
 if(q.fullAsr?.failedRequests!==2||q.fullAsr?.failureHttpStatus!==503||q.fullAsr?.transcriptionsSuccessful!==2)fail('missing full ASR evidence drift');
 if(s.exactCount!==13||s.publishedCount!==13||s.fallbackCount!==2||m.articles.length!==13||m.fallbacks.length!==2)fail('13/15 baseline drift');
 if(e.threshold!==42||e.successfulTtsSinceLastNewExact!==42||f.active!==true||f.strategySnapshot?.threshold!==42||f.strategySnapshot?.successfulTtsSinceLastNewExact!==42)fail('42/42 freeze drift');
 if(f.queuePolicy?.mode!=='new-content-before-renewal')fail('new-content priority drift');
 if(!Array.isArray(a.targets)||a.targets.length!==2)fail('exactly two owner-reviewed targets required');
 for(const t of a.targets){
  const issued=q.targets.find(x=>x.caseId===t.caseId);
  if(!issued||issued.articleId!==t.articleId||issued.fingerprint!==t.fingerprint||issued.fullSha256!==t.fullSha256||issued.clipSha256!==t.clipSha256||t.decision!=='EXPECTED_PRONUNCIATION_CONFIRMED')fail('target review binding '+t.caseId);
 }
 console.log(`TRANCHE42_OWNER_PREFLIGHT=PASS ownerListening=2/2 tts=0 asr=2 pair=${FIRST}+${SECOND} baseline=13/15 counter=42/42`);
 return {a,q,s,e,f,m};
}

async function execute(){
 const {a,s,e,f,m}=await preflight();
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_RUN_ATTEMPT!=='1'||!['pull_request','push'].includes(process.env.GITHUB_EVENT_NAME||''))fail('execute requires first-attempt GitHub Actions');
 const apiKey=process.env.GEMINI_API_KEY;if(!apiKey)fail('GEMINI_API_KEY missing');
 const published=[];let asrCalls=0;
 for(const t of a.targets){
  const article=await loadSpokenArticle(t.articleId);if(article.speechScriptHash!==t.speechScriptHash)fail('speech script drift '+t.articleId);
  const dir=path.join('audio-candidates',t.articleId,t.fingerprint),full=path.join(dir,'full.mp3'),reportsDir=path.join(dir,'reports');
  const bytes=await readFile(full);if(sha256(bytes)!==t.fullSha256)fail('full SHA drift '+t.articleId);
  const retained=await j(path.join(reportsDir,`asr-${FIRST}.json`));
  if(retained.httpStatus!==200||!retained.transcript||(retained.requestedModel||retained.model)!==FIRST||retained.fullSha256!==t.fullSha256)fail('retained first ASR invalid '+t.articleId);
  let upload;
  try{
   upload=await uploadAudioFile({apiKey,bytes,displayName:`${t.caseId}-final-full.mp3`});
   asrCalls+=1;if(asrCalls>a.additionalFullAsrRequestsAuthorized)fail('ASR budget exceeded');
   try{await transcribeFullAudio({model:SECOND,audioPath:full,expectedText:article.spokenText,apiKey,outputPath:path.join(reportsDir,`asr-${SECOND}.json`),fingerprint:t.fingerprint,fullSha256:t.fullSha256,file:upload,skipUpload:true,article,speechScriptHash:t.speechScriptHash});}catch(error){if(error?.result?.httpStatus!==200||typeof error?.result?.transcript!=='string')throw error;}
  }finally{if(upload?.name)await deleteUploadedFile({apiKey,name:upload.name}).catch(()=>null);}
  const adjudication=await adjudicateCandidate({articleId:t.articleId,fingerprint:t.fingerprint,models:[FIRST,SECOND]});
  if(!adjudication.passed||!['substitutions','deletions','insertions','unresolved'].every(k=>Number(adjudication.consensus?.[k])===0))fail('dual-ASR did not close '+t.articleId);
  const listening={status:'passed',reviewedBy:a.authorizedBy,reviewedAt:a.authorizedAt,evidence:{sha256:t.fullSha256,candidateFingerprint:t.fingerprint,reviewedClipSha256s:[t.clipSha256],sourcePacketId:a.reviewedPacketId,sourcePacketSha256:a.reviewedPacketSha256,reviewScope:'ENTIRE_REPAIRED_CONTEXT',fullFileListeningPerformed:false,policy:'docs/audio/PUBLICATION-POLICY-20260901.json',sampleListeningAccepted:true,fullFileListeningWaived:true,ownerInstruction:a.ownerInstruction}};
  const validation=validateSpeechScript(article.model,article.script,await readAmbiguityRules(),{requireReviews:true});
  const testClipPlan=await readTestClipPlan(t.articleId);if(!validation.valid||!validation.approved||testClipPlan.speechScriptHash!==article.speechScriptHash)fail('speech approval/test plan invalid '+t.articleId);
  const asrReports=[await j(path.join(reportsDir,`asr-${FIRST}.json`)),await j(path.join(reportsDir,`asr-${SECOND}.json`))];
  const record={generated:true,provider:'Google Gemini API',model:PRODUCTION_TTS_MODEL,voiceId:PRODUCTION_VOICE_ID,asrReports,asrAdjudication:adjudication,humanListening:listening,technicalStatus:'passed',syncStatus:'passed',speechScriptHash:t.speechScriptHash};
  const post={speechApproval:{validation,script:article.script,testClipPlan}};
  const pub=await publishApprovedCandidate({articleId:t.articleId,fingerprint:t.fingerprint,post,record,listening,persistGit:false});
  const manifest=await j(pub.manifestPath);
  published.push({caseId:t.caseId,articleId:t.articleId,audioKey:audioKeyFor(t.articleId),fingerprint:t.fingerprint,fullSha256:t.fullSha256,clipSha256:t.clipSha256,asrModels:[FIRST,SECOND],consensus:adjudication.consensus,parts:manifest.parts.length,defaultVoice:manifest.defaultVoice});
  const row=s.rows.find(x=>x.articleId===t.articleId);if(!row)fail('status row missing '+t.articleId);
  Object.assign(row,{generationStatus:'generated',validationStatus:'validated',substitutions:0,deletions:0,insertions:0,unresolved:0,exact:true,publishedExact:true,fullSha256:t.fullSha256,error:null,verificationMethod:'tranche42-owner-listening-plus-independent-full-asr'});
  if(!m.articles.some(x=>x.articleId===t.articleId))m.articles.push({articleId:t.articleId,fingerprint:t.fingerprint,fullSha256:t.fullSha256});
  m.fallbacks=m.fallbacks.filter(x=>x.articleId!==t.articleId);
 }
 if(asrCalls!==2||published.length!==2)fail('finalization did not use exactly two ASR calls and two publications');
 const now=new Date().toISOString();
 Object.assign(s,{generatedAt:now,sourceRunId:process.env.GITHUB_RUN_ID||null,sourceArtifact:`bareeq-tranche42-finalization-${process.env.GITHUB_RUN_ID||'local'}`,sourceEvent:process.env.GITHUB_EVENT_NAME||null,publishedCount:15,exactCount:15,fallbackCount:0,publicationComplete:true});
 Object.assign(m,{generatedAt:now,publicationStatus:'complete-exact',publishedCount:15,fallbackCount:0,publicationComplete:true});
 Object.assign(e,{exactBaseline:15,lastExactAt:now,lastRunId:process.env.GITHUB_RUN_ID||e.lastRunId,updatedAt:now,status:'paused',reason:'Legacy campaign reached 15/15 Exact with zero new TTS; two owner-reviewed retained repairs were closed by exactly two independent full ASR checks. New-content full candidate remains next.'});
 Object.assign(f.strategySnapshot,{exact:15,total:15,fallback:0,activePending:0,successfulTtsSinceLastNewExact:42,threshold:42});
 f.reason='Legacy campaign is 15/15 Exact. TTS remains frozen at 42/42; next work is zero-TTS adjudication and owner review of the already-generated screen-focus new-content candidate.';
 f.reviewPolicy.nextAction='Adjudicate the already-generated full screen-focus candidate against its bound SHA, issue final owner listening evidence, and publish only if ASR/human/technical gates pass. No additional TTS is authorized.';
 f.reviewPolicy.completion42Finalization={record:OUT,ownerInstruction:a.ownerInstruction,reviewedTargets:a.targets.map(x=>x.caseId),ttsCalls:0,newFullAsrCalls:2,asrModels:[FIRST,SECOND],publishedExact:'15/15',completedAt:now};
 const result={schema:'bareeq.audio-tranche42-finalization.v1',generatedAt:now,decisionId:a.decisionId,sourceDecisionId:a.sourceDecisionId,sourceQaRunId:a.sourceQaRunId,sourceQaArtifactId:a.sourceQaArtifactId,sourceQaArtifactSha256:a.sourceQaArtifactSha256,ownerInstruction:a.ownerInstruction,ownerListeningPerformed:true,reviewedPacketId:a.reviewedPacketId,reviewedPacketSha256:a.reviewedPacketSha256,ttsCalls:0,newFullAsrCalls:2,asrModels:[FIRST,SECOND],automaticRetry:false,publishedCount:15,fallbackCount:0,publicationComplete:true,published,counter:'42/42',newContentPriorityPreserved:true,nextAction:f.reviewPolicy.nextAction};
 await Promise.all([[STATUS,s],[MARKER,m],[STRATEGY,e],[FREEZE,f],[OUT,result]].map(([p,v])=>w(p,v)));
 console.log('TRANCHE42_FINALIZATION=PASS published=15/15 fallback=0 tts=0 asr=2 counter=42/42');
 return result;
}

async function verifyLive(){
 const r=await j(OUT),origin=process.env.BAREEQ_AUDIO_VERIFY_ORIGIN||'https://bareeqworld.com',checks=[];
 if(r.publishedCount!==15||r.published.length!==2)fail('finalization result missing');
 for(const p of r.published){
  const manifest=await j(`public/audio/articles/${p.audioKey}/manifest.json`);
  checks.push(await waitAndVerifyPublished({origin,articleId:p.articleId,fingerprint:p.fingerprint,fullSha256:p.fullSha256,parts:manifest.parts,defaultVoice:manifest.defaultVoice,timeoutMs:300000,intervalMs:5000}));
 }
 const live={schema:'bareeq.audio-tranche42-live-verification.v1',verifiedAt:new Date().toISOString(),origin,publishedCount:15,checks};await w(LIVE,live);console.log('TRANCHE42_LIVE=PASS 15/15');return live;
}

if(process.argv.includes('--preflight'))await preflight();
else if(process.argv.includes('--execute'))await execute();
else if(process.argv.includes('--verify-live'))await verifyLive();
else throw new Error('Use --preflight, --execute, or --verify-live');
