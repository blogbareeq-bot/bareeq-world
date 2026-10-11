import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSpokenArticle, splitSpokenArticle, candidateFingerprint, QUOTA_SPLIT } from './audio-split.mjs';
import { readTestClipPlan, verifyTestClipEvidence } from './speech-script-core.mjs';
import { buildAudioPriorityQueue, evaluateGenerationPriority } from './audio-priority-guard.mjs';
import { readTtsFreeze } from './audio-tts-freeze-guard.mjs';

const ROOT = process.cwd();
const ARTICLE = process.argv.find((arg)=>arg.startsWith('--article='))?.slice('--article='.length)
  || process.env.BAREEQ_NEW_CONTENT_FULL_ARTICLE
  || 'هل-سرقت-الشاشه-تركيزنا-لماذا-لم-نعد-نحتمل-الدقائق-الفارغه';

export async function buildFullSynthesisPreflight({ articleId=ARTICLE, root=ROOT }={}) {
  const plan=await readTestClipPlan(articleId,root);
  if(!plan) throw new Error('test clip plan missing');
  if(plan.testClipPassed!==true) throw new Error('human test clip pass is required');
  if(plan.fullSynthesisAllowed!==true) throw new Error('full synthesis flag must be enabled after passed test clip evidence');
  if(plan.audioReview?.status!=='passed'||!plan.audioReview?.reviewedBy||!plan.audioReview?.reviewedAt) throw new Error('human listening review metadata incomplete');
  if(!(await verifyTestClipEvidence(plan,root))) throw new Error('test clip evidence file/hash verification failed');

  const queue=await buildAudioPriorityQueue(root);
  const priority=evaluateGenerationPriority(queue,articleId);
  if(!priority.allowed) throw new Error(`priority gate blocked: ${priority.reason}`);
  if(priority.target?.isNewContent!==true) throw new Error('full synthesis preflight is restricted to new content without live audio');

  const freeze=await readTtsFreeze(path.join(root,'docs','audio','TTS-FREEZE.json'));
  if(freeze.active!==true) throw new Error('expected global TTS freeze to remain active');

  const article=await loadSpokenArticle(articleId,root);
  if(article.speechScriptHash!==plan.speechScriptHash) throw new Error('speech script hash changed after test clip approval');
  const split=splitSpokenArticle(article,{settings:QUOTA_SPLIT,liveDurationSeconds:null});
  const fingerprint=candidateFingerprint(article,split);
  const report={
    schema:'bareeq.audio-new-content-full-synthesis-preflight.v1',
    articleId,
    title:article.title,
    speechScriptHash:article.speechScriptHash,
    testClipPlanHash:plan.planHash,
    humanReview:{
      status:plan.audioReview.status,
      reviewedBy:plan.audioReview.reviewedBy,
      reviewedAt:plan.audioReview.reviewedAt,
      evidence:plan.audioReview.evidence,
    },
    audioPriority:{
      policy:queue.policy,
      newContentPending:queue.newContent.length,
      nextSynthesisTarget:queue.nextSynthesisTarget,
      targetClass:priority.target.priorityClass,
      passed:true,
    },
    freeze:{
      active:true,
      generalSynthesisStillFrozen:true,
      legacyRenewalAuthorized:false,
    }
    candidateFingerprint:fingerprint,
    successfulTtsRequestsRequired:split.ttsRequests,
    providerAttemptsMaximum:split.ttsRequests,
    automaticRetry:false,
    publish:false,
    asrAfterGeneration:true,
    parts:split.parts.map((part)=>({
      partIndex:part.partIndex,
      chars:part.chars,
      bytes:part.bytes,
      estimatedSeconds:part.estimatedSeconds,
      estimatedTokens:part.estimatedTokens,
      syncIds:part.syncIds,
      splitReason:part.splitReason,
      unavoidableReason:part.unavoidableReason||null,
    })),
    maxPartBytes:split.maxPartBytes,
    maxPartEstimatedSeconds:split.maxPartEstimatedSeconds,
    maxPartEstimatedTokens:split.maxPartEstimatedTokens,
    providerCalls:0,
    ttsCalls:0,
    generatedAt:new Date().toISOString(),
    status:'READY_FOR_BOUNDED_FULL_SYNTHESIS_AUTHORIZATION',
  };
  const out=path.join(root,'docs','audio','NEW-CONTENT-FULL-SYNTHESIS-PREFLIGHT.json');
  await mkdir(path.dirname(out),{recursive:true});
  await writeFile(out,`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify(report,null,2));
  return report;
}

const isCli=process.argv[1]&&path.basename(process.argv[1])==='audio-new-content-full-synthesis-preflight.mjs';
if(isCli){
  try{await buildFullSynthesisPreflight();}
  catch(error){console.error(error.message);process.exit(1);}
}
