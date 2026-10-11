import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProductionMode } from './audio-production.mjs';
import { validateWithConsensus } from './audio-validate-consensus.mjs';
import { readTestClipPlan, verifyTestClipEvidence } from './speech-script-core.mjs';
import { buildAudioPriorityQueue, evaluateGenerationPriority } from './audio-priority-guard.mjs';
import { readTtsFreeze } from './audio-tts-freeze-guard.mjs';

const ROOT=process.cwd();
const AUTH_PATH=path.join(ROOT,'docs','audio','NEW-CONTENT-FULL-SYNTHESIS-AUTHORIZATION.json');
const PREFLIGHT_PATH=path.join(ROOT,'docs','audio','NEW-CONTENT-FULL-SYNTHESIS-PREFLIGHT.json');
const RESULT_PATH=path.join(ROOT,'docs','audio','NEW-CONTENT-FULL-SYNTHESIS-RESULT.json');

async function readJson(file){return JSON.parse(await readFile(file,'utf8'));}
async function writeJson(file,value){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,`${JSON.stringify(value,null,2)}\n`);}

export async function executeBoundedNewContentFullSynthesis({root=ROOT}={}){
  const authPath=path.join(root,'docs','audio','NEW-CONTENT-FULL-SYNTHESIS-AUTHORIZATION.json');
  const preflightPath=path.join(root,'docs','audio','NEW-CONTENT-FULL-SYNTHESIS-PREFLIGHT.json');
  const resultPath=path.join(root,'docs','audio','NEW-CONTENT-FULL-SYNTHESIS-RESULT.json');
  const [auth,preflight]=await Promise.all([readJson(authPath),readJson(preflightPath)]);
  if(auth.schema!=='bareeq.audio-new-content-full-synthesis-authorization.v1'||auth.authorizationStatus!=='AUTHORIZED') throw new Error('full synthesis authorization is not active');
  if(preflight.schema!=='bareeq.audio-new-content-full-synthesis-preflight.v1'||preflight.status!=='READY_FOR_BOUNDED_FULL_SYNTHESIS_AUTHORIZATION') throw new Error('full synthesis preflight is not ready');
  for(const key of ['targetArticleId','speechScriptHash','testClipPlanHash','candidateFingerprint']){
    const pkey=key==='targetArticleId'?'articleId':key;
    if(auth[key]!==preflight[pkey]) throw new Error(`authorization/preflight binding mismatch: ${key}`);
  }
  if(Number(auth.successfulTtsRequestsAuthorized)!==8||Number(auth.providerAttemptsAuthorized)!==8) throw new Error('authorization budget must be exactly 8/8');
  if(Number(preflight.successfulTtsRequestsRequired)!==8||Number(preflight.providerAttemptsMaximum)!==8) throw new Error('preflight budget must be exactly 8/8');
  if(auth.automaticRetry!==false||auth.publicationAuthorized!==false||auth.legacyRenewalAuthorized!==false||auth.freezeRemainsActive!==true) throw new Error('authorization scope is broader than allowed');
  if(preflight.automaticRetry!==false||preflight.publish!==false) throw new Error('preflight retry/publication scope invalid');

  const plan=await readTestClipPlan(auth.targetArticleId,root);
  if(!plan||plan.speechScriptHash!==auth.speechScriptHash||plan.planHash!==auth.testClipPlanHash||plan.testClipPassed!==true||plan.fullSynthesisAllowed!==true) throw new Error('passed test clip plan binding failed');
  if(!(await verifyTestClipEvidence(plan,root))) throw new Error('human test clip evidence verification failed');

  const queue=await buildAudioPriorityQueue(root);
  const priority=evaluateGenerationPriority(queue,auth.targetArticleId);
  if(!priority.allowed||priority.target?.isNewContent!==true||queue.nextSynthesisTarget!==auth.targetArticleId) throw new Error(`new-content priority gate failed: ${priority.reason}`);
  const freeze=await readTtsFreeze(path.join(root,'docs','audio','TTS-FREEZE.json'));
  if(freeze.active!==true) throw new Error('global freeze unexpectedly inactive');

  auth.authorizationStatus='EXECUTING';
  auth.execution={
    runId:process.env.GITHUB_RUN_ID||null,
    runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT||0)||null,
    startedAt:new Date().toISOString(),
  };
  await writeJson(authPath,auth);

  process.env.BAREEQ_NEW_CONTENT_FULL_AUTHORIZED='1';
  process.env.BAREEQ_NEW_CONTENT_FULL_DECISION_ID=auth.decisionId;
  process.env.BAREEQ_NEW_CONTENT_FULL_ARTICLE=auth.targetArticleId;
  process.env.BAREEQ_NEW_CONTENT_FULL_SCRIPT_HASH=auth.speechScriptHash;
  process.env.BAREEQ_NEW_CONTENT_FULL_PLAN_HASH=auth.testClipPlanHash;
  process.env.BAREEQ_NEW_CONTENT_FULL_FINGERPRINT=auth.candidateFingerprint;
  process.env.BAREEQ_AUDIO_PRODUCTION_LOCK='1';

  let generation=null;
  try{
    generation=await runProductionMode({mode:'generate-candidate',articleId:auth.targetArticleId,root});
  }catch(error){
    const partial=error?.result||{};
    auth.providerAttemptsConsumed=Number(partial.providerAttempts||0);
    auth.successfulTtsRequestsConsumed=Number(partial.successfulRequests||0);
    auth.authorizationStatus=(error?.httpStatus===429||error?.code==='BAREEQ_QUOTA'||error?.exitCode===75)?'PAUSED_QUOTA_NO_RETRY':'FAILED_NO_RETRY';
    auth.result={
      status:auth.authorizationStatus,
      failedAt:new Date().toISOString(),
      candidateFingerprint:partial.fingerprint||auth.candidateFingerprint,
      providerAttemptsConsumed:auth.providerAttemptsConsumed,
      successfulTtsRequestsConsumed:auth.successfulTtsRequestsConsumed,
      completedParts:Number(partial.completedParts||0),
      pausedAtPart:partial.pausedAtPart??null,
      error:String(error?.message||error).slice(0,1000),
    };
    await writeJson(authPath,auth);
    await writeJson(resultPath,{
      schema:'bareeq.audio-new-content-full-synthesis-result.v1',
      decisionId:auth.decisionId,
      articleId:auth.targetArticleId,
      generation:auth.result,
      validation:{status:'NOT_RUN'},
      publication:{authorized:false,performed:false},
      finalHumanListening:{status:'NOT_RUN'},
      generatedAt:new Date().toISOString(),
    });
    throw error;
  }

  if(generation.fingerprint!==auth.candidateFingerprint) throw new Error(`generated candidate fingerprint mismatch: ${generation.fingerprint}`);
  if(Number(generation.ttsRequestsPlanned)!==8||Number(generation.providerAttempts)!==8||Number(generation.successfulRequests)!==8||Number(generation.ttsRequestsSent)!==8||Number(generation.resumedParts)!==0) {
    throw new Error(`unexpected generation accounting planned=${generation.ttsRequestsPlanned} attempts=${generation.providerAttempts} success=${generation.successfulRequests} sent=${generation.ttsRequestsSent} resumed=${generation.resumedParts}`);
  }

  auth.providerAttemptsConsumed=8;
  auth.successfulTtsRequestsConsumed=8;
  auth.authorizationStatus='EXECUTED_GENERATED';
  auth.generation={
    status:'generated',
    fingerprint:generation.fingerprint,
    completedParts:generation.completedParts,
    transportsUsed:generation.transportsUsed,
    completedAt:new Date().toISOString(),
  };
  await writeJson(authPath,auth);

  let validation=null;
  let validationError=null;
  try{
    validation=await validateWithConsensus({articleId:auth.targetArticleId,fingerprint:generation.fingerprint,root});
  }catch(error){
    validationError=error;
  }

  const validationSummary=validation ? {
    status:validation.status,
    fingerprint:validation.fingerprint,
    fullSha256:validation.fullSha256,
    consensus:validation.consensus,
    representationOnly:validation.representationOnly,
    modelDisagreements:validation.modelDisagreements,
    models:validation.models,
    completedAt:new Date().toISOString(),
  } : {
    status:'FAILED_OR_NEEDS_ADJUDICATION',
    fingerprint:generation.fingerprint,
    error:String(validationError?.message||validationError||'unknown').slice(0,1200),
    evidence:validationError?.result||validationError?.dual||null,
    completedAt:new Date().toISOString(),
  };

  const finalStatus=validation?.status==='validated'
    && ['substitutions','deletions','insertions','unresolved'].every((k)=>Number(validation.consensus?.[k])===0)
    ? 'GENERATED_VALIDATED_AWAITING_FINAL_HUMAN_LISTENING'
    : 'GENERATED_AWAITING_VALIDATION_ADJUDICATION';

  auth.authorizationStatus='EXECUTED';
  auth.result={
    status:finalStatus,
    completedAt:new Date().toISOString(),
    candidateFingerprint:generation.fingerprint,
    providerAttemptsConsumed:8,
    successfulTtsRequestsConsumed:8,
    publicationPerformed:false,
  };
  await writeJson(authPath,auth);

  const result={
    schema:'bareeq.audio-new-content-full-synthesis-result.v1',
    decisionId:auth.decisionId,
    articleId:auth.targetArticleId,
    speechScriptHash:auth.speechScriptHash,
    testClipPlanHash:auth.testClipPlanHash,
    candidateFingerprint:generation.fingerprint,
    generation:{
      status:'generated',
      ttsRequestsPlanned:generation.ttsRequestsPlanned,
      ttsRequestsSent:generation.ttsRequestsSent,
      providerAttempts:generation.providerAttempts,
      successfulRequests:generation.successfulRequests,
      resumedParts:generation.resumedParts,
      completedParts:generation.completedParts,
      transportsUsed:generation.transportsUsed,
    },
    validation:validationSummary,
    status:finalStatus,
    publication:{authorized:false,performed:false},
    finalHumanListening:{status:'required-not-performed'},
    completedAt:new Date().toISOString(),
  };
  await writeJson(resultPath,result);
  console.log(JSON.stringify(result,null,2));
  return result;
}

const isCli=process.argv[1]&&path.basename(process.argv[1])==='audio-new-content-full-synthesis-execute.mjs';
if(isCli){
  try{
    const result=await executeBoundedNewContentFullSynthesis();
    process.exit(result.status==='GENERATED_VALIDATED_AWAITING_FINAL_HUMAN_LISTENING'?0:3);
  }catch(error){
    console.error(error.message);
    process.exit(error.exitCode||1);
  }
}
