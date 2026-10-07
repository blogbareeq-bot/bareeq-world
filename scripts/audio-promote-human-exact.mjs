import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHumanOfflineAdjudication } from './audio-human-evidence-adjudication.mjs';
import { audioKeyFor, sha256 } from './audio-constants.mjs';
import { writeJson, pathExists } from './audio-checkpoint.mjs';
import { isValidProductionManifest } from './audio-manifest.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { boundIdentity } from './audio-report.mjs';

const CAMPAIGN_ID='sadaltager-openrouter-20260901-v1';
const EXPECTED_NEW_EXACT=new Set([
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
]);

function arg(name,fallback){
  const prefix=`--${name}=`;
  return process.argv.find(v=>v.startsWith(prefix))?.slice(prefix.length)||fallback;
}
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }
function exactZero(c={}){ return ['substitutions','deletions','insertions','unresolved'].every(k=>Number(c[k])===0); }

async function assertPartAsset({candidateDir,manifest,part}){
  const asset=part.audio?.[manifest.defaultVoice];
  if(!asset?.src||!asset.sha256) throw new Error(`part ${part.index??'?'} missing src/sha256`);
  const filename=path.basename(asset.src);
  const source=path.join(candidateDir,'parts',filename);
  const bytes=await readFile(source);
  if(sha256(bytes)!==asset.sha256) throw new Error(`part SHA mismatch: ${filename}`);
  if(asset.bytes && Number(asset.bytes)!==bytes.length) throw new Error(`part byte mismatch: ${filename}`);
  if(asset.durationSeconds){
    const duration=mp3DurationSeconds(bytes);
    if(Math.abs(duration-Number(asset.durationSeconds))>0.35) throw new Error(`part duration mismatch: ${filename}`);
  }
  return {filename,source,bytes};
}

async function writeHumanEvidence({root,row,sourceEvidence}){
  const candidateDir=path.join(root,'audio-candidates',row.articleId,row.fingerprint);
  const reportsDir=path.join(candidateDir,'reports');
  const article=await loadSpokenArticle(row.articleId,root);
  const baseAdjPath=path.join(reportsDir,'asr-adjudication.json');
  const [baseAdj,technical,sync,manifest]=await Promise.all([
    json(baseAdjPath),
    json(path.join(reportsDir,'technical-qa.json')),
    json(path.join(reportsDir,'sync.json')),
    json(path.join(candidateDir,'manifest.json')),
  ]);
  if(!(technical.passed===true||technical.status==='passed')) throw new Error(`${row.articleId}: technical QA failed`);
  if(!(sync.passed===true||sync.status==='passed')) throw new Error(`${row.articleId}: sync QA failed`);
  if(!isValidProductionManifest(manifest)) throw new Error(`${row.articleId}: player manifest invalid`);
  if((manifest.candidateFingerprint||manifest.fingerprint)!==row.fingerprint) throw new Error(`${row.articleId}: player manifest fingerprint mismatch`);
  const fullBytes=await readFile(path.join(candidateDir,'full.mp3'));
  if(sha256(fullBytes)!==row.fullSha256) throw new Error(`${row.articleId}: full SHA mismatch`);
  if(!exactZero(row.finalConsensus)||row.exactAfterHumanEvidence!==true) throw new Error(`${row.articleId}: human consensus not exact`);
  if(row.humanConfirmedAudioErrors.length!==0) throw new Error(`${row.articleId}: confirmed audio error cannot be promoted`);
  if(!Array.isArray(baseAdj.models)||baseAdj.models.length!==2||new Set(baseAdj.models).size!==2) throw new Error(`${row.articleId}: base dual ASR pair invalid`);

  for(const part of manifest.parts||[]) await assertPartAsset({candidateDir,manifest,part});

  const humanAdj=boundIdentity({
    article,
    fingerprint:row.fingerprint,
    fullSha256:row.fullSha256,
    status:'validated',
    schema:'bareeq.audio-human-adjudication.v1',
    extra:{
      passed:true,
      consensus:row.finalConsensus,
      baseConsensus:row.baseConsensus,
      models:baseAdj.models,
      method:'independent-dual-asr-plus-binding-blind-human-triage',
      baseAdjudicationSha256:sha256(await readFile(baseAdjPath)),
      humanResolved:row.humanResolved,
      sourceEvidence,
      rawAsrReportsImmutable:true,
      ttsCalls:0,
      newAsrCalls:0,
      providerCalls:0,
    },
  });
  await writeJson(path.join(reportsDir,'human-adjudication.json'),humanAdj);
  return {candidateDir,article,manifest,technical,sync,humanAdj};
}

async function publishOne({root,row,evidence}){
  const {candidateDir,article,manifest,humanAdj}=evidence;
  const audioKey=audioKeyFor(row.articleId);
  const liveDir=path.join(root,'public','audio','articles',audioKey);
  await rm(liveDir,{recursive:true,force:true});
  await mkdir(liveDir,{recursive:true});

  const published=structuredClone(manifest);
  const copied=[];
  for(const part of published.parts||[]){
    const asset=part.audio?.[published.defaultVoice];
    const checked=await assertPartAsset({candidateDir,manifest:published,part});
    await cp(checked.source,path.join(liveDir,checked.filename));
    asset.src=`/audio/articles/${audioKey}/${checked.filename}`;
    copied.push(checked.filename);
  }
  const publishedAt=new Date().toISOString();
  const out={
    ...published,
    ...boundIdentity({
      article,
      fingerprint:row.fingerprint,
      fullSha256:row.fullSha256,
      status:'published',
      schema:published.schema||'bareeq.audio-production-manifest.v3',
      extra:{
        generatedAt:publishedAt,
        publishedAt,
        publishedFromCandidate:row.fingerprint,
        verificationMethod:'human-evidence-offline-v1',
        humanAdjudicationSha256:sha256(Buffer.from(JSON.stringify(humanAdj))),
      },
    }),
    fullSha256:row.fullSha256,
    fingerprint:row.fingerprint,
    candidateFingerprint:row.fingerprint,
    publishedFromCandidate:row.fingerprint,
    publishedAt,
  };
  await writeJson(path.join(liveDir,'manifest.json'),out);
  return {audioKey,liveDir,copied,publishedAt};
}

export async function promoteHumanExact({root=process.cwd(),triageRoot}){
  const adjudication=await runHumanOfflineAdjudication({artifactRoot:root,triageRoot,repoRoot:root});
  const rows=adjudication.rows.filter(r=>r.exactAfterHumanEvidence);
  const ids=new Set(rows.map(r=>r.articleId));
  if(rows.length!==2||ids.size!==EXPECTED_NEW_EXACT.size||[...EXPECTED_NEW_EXACT].some(id=>!ids.has(id))){
    throw new Error(`promotion refused: expected exactly the two approved new Exact articles, got ${[...ids].join(', ')}`);
  }

  const statePath=path.join(root,'audio-candidates','_campaigns',CAMPAIGN_ID,'state.json');
  const state=await json(statePath);
  const markerPath=path.join(root,'docs','audio','PUBLISHED-SADALTAGER-PARTIAL-20260903.json');
  const marker=await json(markerPath);
  const strategyPath=path.join(root,'docs','audio','ENGINE-STRATEGY-STATE.json');
  const strategy=await json(strategyPath);
  const freezePath=path.join(root,'docs','audio','TTS-FREEZE.json');
  const freeze=await json(freezePath);

  const sourceEvidence={
    humanTriagePackageId:adjudication.triagePackageId,
    reviewerResultsSha256:adjudication.reviewerResultsSha256,
    finalForcedChoiceSha256:adjudication.finalForcedChoiceSha256,
    offlineAdjudicationSchema:adjudication.schema,
  };
  const promoted=[];
  for(const row of rows){
    const evidence=await writeHumanEvidence({root,row,sourceEvidence});
    const publication=await publishOne({root,row,evidence});
    const item=state.articles?.[row.articleId];
    if(!item||item.generation?.fingerprint!==row.fingerprint) throw new Error(`${row.articleId}: campaign state generation mismatch`);
    item.validation={
      ...(item.validation||{}),
      status:'validated',
      fingerprint:row.fingerprint,
      fullSha256:row.fullSha256,
      consensus:row.finalConsensus,
      humanEvidence:true,
      method:'human-evidence-offline-v1',
      humanResolved:row.humanResolved.map(x=>x.caseId),
      completedAt:new Date().toISOString(),
      error:null,
    };
    item.publication={
      status:'published',
      fingerprint:row.fingerprint,
      fullSha256:row.fullSha256,
      liveDir:publication.liveDir,
      completedAt:publication.publishedAt,
      policy:'docs/audio/PUBLICATION-POLICY-20260901.json',
      method:'human-evidence-offline-v1',
    };
    promoted.push({articleId:row.articleId,title:row.title,fingerprint:row.fingerprint,fullSha256:row.fullSha256,audioKey:publication.audioKey,consensus:row.finalConsensus,humanResolved:row.humanResolved.map(x=>x.caseId)});
  }

  state.publicationComplete=false;
  state.liveUntouched=false;
  state.partialPublication={
    status:'published-with-fallback',
    publishedCount:9,
    fallbackCount:6,
    publishedArticles:[...new Set([...(state.partialPublication?.publishedArticles||marker.articles.map(x=>x.articleId)),...promoted.map(x=>x.articleId)])],
    fallbackArticles:marker.fallbacks.map(x=>x.articleId).filter(id=>!EXPECTED_NEW_EXACT.has(id)),
    completedAt:new Date().toISOString(),
  };
  await writeJson(statePath,state);

  const priorArticles=new Map(marker.articles.map(x=>[x.articleId,x]));
  for(const p of promoted) priorArticles.set(p.articleId,{articleId:p.articleId,fingerprint:p.fingerprint,fullSha256:p.fullSha256});
  const fallbackIds=marker.fallbacks.map(x=>x.articleId).filter(id=>!EXPECTED_NEW_EXACT.has(id));
  const newMarker={
    ...marker,
    publicationStatus:'partial-with-existing-live-fallback',
    publicationComplete:false,
    publishedCount:priorArticles.size,
    fallbackCount:fallbackIds.length,
    generatedAt:new Date().toISOString(),
    articles:[...priorArticles.values()],
    fallbacks:fallbackIds.map(articleId=>({articleId,reason:'awaiting-exact-campaign-completion'})),
  };
  if(newMarker.publishedCount!==9||newMarker.fallbackCount!==6) throw new Error('partial marker did not become 9/6');
  await writeJson(markerPath,newMarker);

  strategy.exactBaseline=9;
  strategy.successfulTtsSinceLastNewExact=29;
  strategy.status='active';
  strategy.reason='Two new Exact publications were promoted from binding Human Triage evidence with 0 TTS; the 29/30 strategic TTS counter is intentionally unchanged.';
  strategy.lastExactAt=new Date().toISOString();
  strategy.updatedAt=new Date().toISOString();
  await writeJson(strategyPath,strategy);

  freeze.strategySnapshot={...freeze.strategySnapshot,exact:9,total:15,fallback:6,activePending:5,excluded:1,successfulTtsSinceLastNewExact:29,threshold:30};
  freeze.reason='Synthesis remains frozen. Human-evidence offline adjudication promoted two existing candidates to Exact with 0 TTS; campaign is now 9/15 Exact with 6 safe fallbacks.';
  freeze.reviewPolicy.nextAction='assess the five remaining active articles by their confirmed localized audio defects before any Gate 5 synthesis decision; TTS remains frozen at 29/30';
  freeze.reviewPolicy.humanExactPromotion={status:'PROMOTED',exact:'9/15',promotedArticles:promoted.map(x=>x.articleId),ttsCalls:0,newAsrCalls:0};
  await writeJson(freezePath,freeze);

  const record={
    schema:'bareeq.audio-human-exact-promotion.v1',
    generatedAt:new Date().toISOString(),
    sourceRunId:adjudication.sourceRunId,
    promotedCount:promoted.length,
    exactAfterPromotion:9,
    fallbackAfterPromotion:6,
    strategy:'29/30',
    ttsCalls:0,
    newAsrCalls:0,
    providerCalls:0,
    promoted,
  };
  await writeJson(path.join(root,'docs','audio','HUMAN-EXACT-PROMOTION-20261007.json'),record);
  return record;
}

async function cli(){
  const root=path.resolve(arg('root',process.cwd()));
  const triageRoot=path.resolve(arg('triage-root','triage-input'));
  const r=await promoteHumanExact({root,triageRoot});
  console.log(`HUMAN_EXACT_PROMOTION=PASS promoted=${r.promotedCount} exact=${r.exactAfterPromotion}/15 fallback=${r.fallbackAfterPromotion} strategy=${r.strategy} tts=0 asr=0 provider=0`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
