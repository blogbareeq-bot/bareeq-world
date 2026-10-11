import {readFile,writeFile,readdir,cp,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {sha256,audioKeyFor} from './audio-constants.mjs';
import {loadSpokenArticle} from './audio-split.mjs';
import {tokenizeVerbal} from './audio-exact-match.mjs';
import {adjudicateDualAsr} from './audio-dual-asr-adjudicate.mjs';
import {applyHumanEvidence} from './audio-human-evidence-adjudication.mjs';
import {boundIdentity} from './audio-report.mjs';
import {publishApprovedCandidate} from './audio-publish.mjs';
import {readAmbiguityRules,readTestClipPlan,validateSpeechScript} from './speech-script-core.mjs';
import {bindCompletion40,MANIFEST_SHA,SUBMISSION_SHA,stable} from './audio-completion40-review-binding.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const write=async(p,j)=>{await mkdir(path.dirname(p),{recursive:true});await writeFile(p,JSON.stringify(j,null,2)+'\n');};
const same=(a,b)=>stable(a)===stable(b);
const targets=new Set(['اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع','intuition-first-impression-decisions-signature','why-some-passports-are-stronger']);
const prefixes=['S','M','C1','C2','C3'];
async function files(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await files(p));else out.push(p);}return out;}
async function one(dir,suffix){const hits=(await files(dir)).filter(p=>p.replaceAll('\\','/').endsWith(suffix));if(hits.length!==1)throw new Error('Ambiguous saved evidence '+suffix);return hits[0];}
function matchIdentity(r,a){if(r.articleId!==a.articleId||(r.candidateFingerprint||r.fingerprint)!==a.fingerprint||r.fullSha256!==a.fullSha256||r.speechScriptHash!==a.speechScriptHash)throw new Error('Evidence identity drift '+a.articleId);}
function compareAdjudication(a,b){for(const k of ['consensus','substantiveDifferences','unresolved','representationOnly','modelDisagreements'])if(!same(a[k],b[k]))throw new Error('Recomputed adjudication differs from issued immutable review: '+k);}
export async function certifyCompletion40({two='completion40-two',others='completion40-others',review='completion40-review'}={}){
 const status=await json('docs/audio/PROGRESSIVE-STATUS.json'),strategy=await json('docs/audio/ENGINE-STRATEGY-STATE.json'),freeze=await json('docs/audio/TTS-FREEZE.json'),marker=await json('docs/audio/PUBLISHED-SADALTAGER-PARTIAL-20260903.json');
 if(status.exactCount!==10||status.publishedCount!==10||status.fallbackCount!==5||marker.articles.length!==10||strategy.exactBaseline!==10||strategy.threshold!==40||strategy.successfulTtsSinceLastNewExact!==40||freeze.active!==true||freeze.queuePolicy?.mode!=='new-content-before-renewal')throw new Error('Refuse replay or changed campaign/authorization/queue policy');
 const issued=await json('docs/audio/COMPLETION40-REVIEW-ISSUED-20261008.json'),submissionBytes=await readFile('docs/audio/REVIEW-COMPLETION40-SUBMISSION-20261011.json'),supplement=await json('docs/audio/REVIEW-COMPLETION40-SUPPLEMENT-20261011.json');
 const bound=bindCompletion40({issued,submissionBytes,supplement});
 const manifestBytes=await readFile(path.join(review,'review-manifest.json'));if(sha256(manifestBytes)!==MANIFEST_SHA)throw new Error('Immutable review artifact manifest SHA mismatch');
 const manifest=JSON.parse(manifestBytes);
 const protectedBefore=new Map(),allowed=[...targets].map(x=>path.join('public/audio/articles',audioKeyFor(x))+'/');
 for(const f of await files('public/audio'))if(!allowed.some(p=>f.startsWith(p)))protectedBefore.set(f,sha256(await readFile(f)));
 const results=[],published=[],liveIdentity=[];
 for(const [n,a] of manifest.articles.entries()){
  const issuedArticle=issued.articles.find(x=>x.articleId===a.articleId);if(!issuedArticle)throw new Error('Unissued article');for(const [k,v] of Object.entries(issuedArticle))if(!same(v,a[k]))throw new Error('Issued article binding mismatch '+k);
  const source=await one(n<2?two:others,`audio-candidates/${a.articleId}/${a.fingerprint}/full.mp3`);
  if(sha256(await readFile(source))!==a.fullSha256)throw new Error('Saved full SHA mismatch');
  const dir=path.join('audio-candidates',a.articleId,a.fingerprint);await mkdir(path.dirname(dir),{recursive:true});await cp(path.dirname(source),dir,{recursive:true,errorOnExist:true,force:false});
  const article=await loadSpokenArticle(a.articleId);if(article.speechScriptHash!==a.speechScriptHash)throw new Error('Canonical reviewed script changed');
  const expectedTokens=tokenizeVerbal(article.spokenText),ck=await json(path.join(dir,'checkpoint.json')),rawParts=new Map();
  if(ck.articleId!==a.articleId||ck.fingerprint!==a.fingerprint||Object.keys(ck.completedParts).length!==ck.partCount)throw new Error('Incomplete raw checkpoint');
  for(const [idx,p] of Object.entries(ck.completedParts)){const sha=sha256(await readFile(path.join(dir,'parts',p.file)));if(sha!==p.sha256)throw new Error('Raw checkpoint part SHA mismatch');rawParts.set(Number(idx),sha);}
  for(const p of a.parts){if(rawParts.get(p.partIndex)!==p.sourcePartSha256||sha256(await readFile(path.join(review,p.sourceFile)))!==p.sourcePartSha256)throw new Error('Reviewed source part mismatch');}
  for(const c of manifest.cases.filter(x=>x.articleId===a.articleId)){if(rawParts.get(c.partIndex)!==c.sourcePartSha256||sha256(await readFile(path.join(review,c.clipFile)))!==c.clipSha256)throw new Error('Reviewed clip SHA mismatch');}
  const reportsDir=path.join(dir,'reports'),saved=await json(path.join(reportsDir,'asr-adjudication.json')),raw=[];
  matchIdentity(saved,a);if(saved.models.length!==2||new Set(saved.models).size!==2)throw new Error('Independent ASR pair missing');
  for(const model of saved.models){const f=path.join(reportsDir,`asr-${model}.json`),r=await json(f),binding=a.rawReportBindings.find(x=>x.model===model);matchIdentity(r,a);if(sha256(await readFile(f))!==binding?.sha256||r.httpStatus!==200||!r.transcript||!Array.isArray(r.differences)||(r.requestedModel||r.model)!==model||!same(tokenizeVerbal(r.expectedNormalized),expectedTokens))throw new Error('Immutable canonical raw ASR binding mismatch');raw.push(r);}
  const base=adjudicateDualAsr({expectedText:article.spokenText,reports:raw,articleId:a.articleId,fingerprint:a.fingerprint,fullSha256:a.fullSha256,speechScriptHash:a.speechScriptHash,models:saved.models});
  compareAdjudication(base,await json(path.join(review,prefixes[n]+'-base-v6.json')));
  const carryMappings={};
  for(const c of a.carriedHumanCases){const issue=[...base.substantiveDifferences,...base.unresolved].find(x=>x.expectedIndex===c.expectedIndex&&x.expected===c.expectedToken);if(!issue||c.fullSha256!==a.fullSha256||c.originalFullSha256!==a.originalBaselineFullSha256||expectedTokens[c.expectedIndex]!==c.expectedToken||![...rawParts.values()].includes(c.candidatePartSha256))throw new Error('Carried human evidence does not bind current raw parts');
   if(c.method==='byte-identical-unchanged-raw-part'){if(c.sourcePartSha256!==c.candidatePartSha256)throw new Error('Retained raw part is not byte-identical');}
   else if(c.method==='saved-splice-with-identical-outside-PCM-and-independently-correlated-encoded-review-region'){const p=c.savedSpliceProof;if(sha256(JSON.stringify(p))!==c.savedSpliceProofSha256||p.baselinePartSha256!==c.sourcePartSha256||p.candidatePartSha256!==c.candidatePartSha256||p.outsidePcmIdentical!==true||Math.min(p.prefixCorrelation,p.suffixCorrelation,c.independentReviewedRegionCorrelation)<.98)throw new Error('Sealed derivative proof failed');}
   else throw new Error('Unrecognized derivative proof');
   carryMappings[c.caseId]={kind:'pending',articleId:a.articleId,fingerprint:a.fingerprint,fullSha256:a.fullSha256,expectedIndex:c.expectedIndex,expectedToken:c.expectedToken,issueType:issue.type||'unresolved'};
  }
  const prior=applyHumanEvidence({baseResult:base,mappings:carryMappings,resolvedCases:new Set(Object.keys(carryMappings)),ambiguityCases:new Set(),actualCases:new Set()});
  compareAdjudication(prior,await json(path.join(review,prefixes[n]+'-human-bound.json')));
  const decisions=[...bound.confirmed,...bound.actual].filter(x=>x.articleId===a.articleId),mappings={},resolved=new Set(),actual=new Set();
  for(const d of decisions){const idx=d.expectedIndices[0],issue=[...prior.substantiveDifferences,...prior.unresolved].find(x=>x.expectedIndex===idx);if(d.expectedIndices.length!==1||!issue||issue.expected!==d.targetText||expectedTokens[idx]!==d.targetText||rawParts.get(d.partNumber-1)!==d.sourcePartSha256)throw new Error('Human decision issue/part binding failed');mappings[d.caseId]={kind:'pending',articleId:a.articleId,fingerprint:a.fingerprint,fullSha256:a.fullSha256,expectedIndex:idx,expectedToken:d.targetText,issueType:d.issueType};(d.decision==='ACTUAL_AUDIO_ERROR'?actual:resolved).add(d.caseId);}
  const human=applyHumanEvidence({baseResult:prior,mappings,resolvedCases:resolved,ambiguityCases:new Set(),actualCases:actual});
  if(a.articleId===supplement.articleId){if(expectedTokens[supplement.expectedIndex]!==supplement.expectedToken||rawParts.get(supplement.partNumber-1)!==supplement.sourcePartSha256)throw new Error('Supplement canonical token/part drift');human.humanConfirmedAudioErrors.push({...supplement,fullSha256:a.fullSha256});human.substantiveDifferences.push({type:'substitution',expectedIndex:supplement.expectedIndex,expected:supplement.expectedToken,actual:supplement.heard,confirmedBy:['owner-listening'],caseId:supplement.caseId});human.consensus.substitutions++;human.passed=false;human.status='failed';}
  const mustPublish=targets.has(a.articleId);if(human.passed!==mustPublish||human.humanConfirmedAudioErrors.length!==(mustPublish?0:1)||!mustPublish&&human.consensus.substitutions!==1)throw new Error('Final review outcome is not the approved 3 eligible / 2 defects');
  const technical=await json(path.join(reportsDir,'technical-qa.json')),sync=await json(path.join(reportsDir,'sync.json'));for(const r of [technical,sync]){matchIdentity(r,a);if(r.passed!==true)throw new Error('Technical or sync QA failed');}
  const proof={schema:'bareeq.audio-completion40-review-derivative.v1',articleId:a.articleId,fingerprint:a.fingerprint,fullSha256:a.fullSha256,speechScriptHash:a.speechScriptHash,sourceReviewRunId:'37781294858',sourceReviewManifestSha256:MANIFEST_SHA,sourceSubmissionSha256:SUBMISSION_SHA,decisions,carriedHumanCases:a.carriedHumanCases,supplement:a.articleId===supplement.articleId?supplement:null,rawReportBindings:a.rawReportBindings,rawAsrImmutable:true,baseAdjudicationImmutable:true,ttsCalls:0,newAsrCalls:0};
  await write(path.join(reportsDir,'review-derivative.json'),proof);
  const humanAdj=boundIdentity({article,fingerprint:a.fingerprint,fullSha256:a.fullSha256,status:human.status,schema:human.schema,extra:{...human,baseAdjudicationSha256:sha256(await readFile(path.join(reportsDir,'asr-adjudication.json'))),derivativeProofSha256:sha256(await readFile(path.join(reportsDir,'review-derivative.json'))),ttsCalls:0,newAsrCalls:0}});await write(path.join(reportsDir,'human-adjudication.json'),humanAdj);
  const row={articleId:a.articleId,fingerprint:a.fingerprint,fullSha256:a.fullSha256,consensus:human.consensus,humanResolvedCount:human.humanResolved.length,humanConfirmedAudioErrors:human.humanConfirmedAudioErrors,technicalPassed:true,syncPassed:true,published:mustPublish};results.push(row);
  await write(`docs/audio/COMPLETION40-REVIEW-VALIDATION-${prefixes[n]}-20261011.json`,humanAdj);
  if(!mustPublish)continue;
  const digestFiles=['generation-report.json','manifest.candidate.json','manifest.json','reports/merge.json','reports/technical-qa.json','reports/sync.json',...saved.models.map(x=>`reports/asr-${x}.json`),'reports/asr-adjudication.json','reports/human-adjudication.json','reports/review-derivative.json'],reportDigests={};for(const f of digestFiles)reportDigests[f]=sha256(await readFile(path.join(dir,f)));
  const validation=boundIdentity({article,fingerprint:a.fingerprint,fullSha256:a.fullSha256,status:'validated',schema:'bareeq.audio-validate.v3',extra:{passed:true,reportDigests,technical,sync,asrReports:raw,asrAdjudication:humanAdj,rawAsrAdjudication:saved,verificationMethod:'immutable-full-dual-asr-plus-owner-sha-bound-review',playerManifestValid:true}});await write(path.join(reportsDir,'validate.json'),validation);
  const policy=await json('docs/audio/PUBLICATION-POLICY-20260901.json');if(!policy.decision.sampleListeningAccepted||!policy.decision.ownerWaiverForFullFileListening||policy.decision.fullFileHumanListeningRequired!==false)throw new Error('Approved sample-listening policy unavailable');
  const listening={status:'passed',reviewedBy:bound.reviewer,reviewedAt:bound.submittedAt,evidence:{sha256:a.fullSha256,candidateFingerprint:a.fingerprint,reviewedClipSha256s:decisions.map(x=>x.clipSha256),sourceSubmissionSha256:SUBMISSION_SHA,derivativeProofSha256:reportDigests['reports/review-derivative.json'],fullFileListeningPerformed:false,policy:'docs/audio/PUBLICATION-POLICY-20260901.json',sampleListeningAccepted:true,fullFileListeningWaived:true}};
  const textValidation=validateSpeechScript(article.model,article.script,await readAmbiguityRules(),{requireReviews:true}),testClipPlan=await readTestClipPlan(a.articleId);if(!textValidation.valid||!textValidation.approved)throw new Error('Reviewed speech script invalid');
  const post={speechApproval:{validation:textValidation,script:article.script,testClipPlan}},record={generated:true,provider:validation.provider,model:validation.ttsModel,voiceId:'sadaltager',asrReports:raw,asrAdjudication:humanAdj,humanListening:listening,technicalStatus:'passed',syncStatus:'passed',speechScriptHash:a.speechScriptHash};
  const pub=await publishApprovedCandidate({articleId:a.articleId,fingerprint:a.fingerprint,post,record,listening,persistGit:false});const player=await json(pub.manifestPath);
  published.push({articleId:a.articleId,fingerprint:a.fingerprint,fullSha256:a.fullSha256,audioKey:audioKeyFor(a.articleId),parts:player.parts.map(x=>x.audio[player.defaultVoice])});
  Object.assign(status.rows.find(x=>x.articleId===a.articleId),{generationStatus:'generated',validationStatus:'validated',substitutions:0,deletions:0,insertions:0,unresolved:0,exact:true,publishedExact:true,fullSha256:a.fullSha256,error:null,verificationMethod:'bound-owner-review-completion40'});
  marker.articles.push({articleId:a.articleId,fingerprint:a.fingerprint,fullSha256:a.fullSha256});marker.fallbacks=marker.fallbacks.filter(x=>x.articleId!==a.articleId);
 }
 if(published.length!==3||results.length!==5)throw new Error('Incomplete fixed promotion');
 const afterFiles=(await files('public/audio')).filter(f=>!allowed.some(p=>f.startsWith(p)));if(afterFiles.length!==protectedBefore.size)throw new Error('Protected file set changed');for(const f of afterFiles)if(protectedBefore.get(f)!==sha256(await readFile(f)))throw new Error('Existing ten Exact or blocked fallback audio changed '+f);
 const now=new Date().toISOString();Object.assign(status,{generatedAt:now,sourceRunId:process.env.GITHUB_RUN_ID||null,sourceArtifact:`bareeq-completion40-promotion-${process.env.GITHUB_RUN_ID||'local'}`,sourceEvent:process.env.GITHUB_EVENT_NAME||null,publishedCount:13,exactCount:13,fallbackCount:2,publicationComplete:false});
 Object.assign(marker,{generatedAt:now,publishedCount:13,fallbackCount:2,publicationComplete:false});Object.assign(strategy,{exactBaseline:13,lastExactAt:now,updatedAt:now,status:'paused',reason:'Three saved candidates promoted with zero provider calls after owner-bound review; consumed 40/40 remains unchanged; two owner-confirmed defects are withheld.'});
 Object.assign(freeze.strategySnapshot,{exact:13,fallback:2,activePending:2,excluded:0,successfulTtsSinceLastNewExact:40,threshold:40});freeze.reason='Three saved candidates promoted with 0 TTS; two owner-confirmed audio defects remain blocked; synthesis remains frozen at consumed 40/40.';freeze.reviewPolicy.completion40HumanReview={record:'docs/audio/COMPLETION40-PUBLICATION-20261011.json',confirmed:27,actualAudioErrors:2,ttsCalls:0,newAsrCalls:0,remainingDefects:['S-01-450','C1-01-617-owner']};
 for(const [f,d] of [['PROGRESSIVE-STATUS',status],['PUBLISHED-SADALTAGER-PARTIAL-20260903',marker],['ENGINE-STRATEGY-STATE',strategy],['TTS-FREEZE',freeze]])await write(`docs/audio/${f}.json`,d);
 for(const a of marker.articles){const p=`public/audio/articles/${audioKeyFor(a.articleId)}/manifest.json`,m=await json(p);if((m.candidateFingerprint||m.fingerprint)!==a.fingerprint||m.fullSha256!==a.fullSha256)throw new Error('Published identity drift');liveIdentity.push({articleId:a.articleId,path:p.replace('public',''),fingerprint:a.fingerprint,fullSha256:a.fullSha256});}
 const outcome={schema:'bareeq.audio-completion40-publication.v1',generatedAt:now,publishedCount:13,fallbackCount:2,publicationComplete:false,sourceSubmissionSha256:SUBMISSION_SHA,sourceReviewManifestSha256:MANIFEST_SHA,sourceReviewRunId:'37781294858',reviewer:bound.reviewer,confirmed:27,actualAudioErrors:2,results,published,liveIdentity,protectedAudioFiles:protectedBefore.size,successfulTtsSinceLastNewExact:40,threshold:40,globalFreezeActive:true,queueMode:freeze.queuePolicy.mode,ttsCalls:0,newAsrCalls:0};await write('docs/audio/COMPLETION40-PUBLICATION-20261011.json',outcome);
 console.log('COMPLETION40_PROMOTION=PASS exact=13/15 fallback=2 counter=40/40 tts=0 asr=0');return outcome;
}
if(process.argv[1]&&path.basename(process.argv[1])==='audio-completion40-certify.mjs')await certifyCompletion40({two:process.argv[2],others:process.argv[3],review:process.argv[4]});
