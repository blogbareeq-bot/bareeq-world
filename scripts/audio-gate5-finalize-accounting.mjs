import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSuccessfulTts } from './audio-engine-strategy-guard.mjs';

function arg(name,fallback){ const p=`--${name}=`; return process.argv.find(x=>x.startsWith(p))?.slice(p.length)||fallback; }
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }

export function successfulFromLog(text){
  const summary=parseSuccessfulTts(text);
  const explicit=(String(text).match(/PROGRESSIVE_REPAIR_TTS_OK/g)||[]).length;
  return Math.max(summary,explicit);
}

export async function finalizeGate5({root=process.cwd(),logPath}){
  const log=await readFile(logPath,'utf8').catch(()=> '');
  const successful=successfulFromLog(log);
  if(successful>1) throw new Error(`Gate 5 invariant violated: successful TTS count ${successful} > 1`);
  const authPath=path.join(root,'docs','audio','GATE-5-AUTHORIZATION.json');
  const freezePath=path.join(root,'docs','audio','TTS-FREEZE.json');
  const strategyPath=path.join(root,'docs','audio','ENGINE-STRATEGY-STATE.json');
  const auth=await json(authPath), freeze=await json(freezePath), strategy=await json(strategyPath);
  if(auth.decisionId!=='GATE5-PASSPORTS-v1') throw new Error('unexpected Gate 5 decision id');
  auth.successfulTtsRequestsConsumed=successful;
  auth.successfulTtsRequestsAuthorized=0;
  auth.authorizationStatus=successful===1?'CONSUMED':'ATTEMPTED_NO_SUCCESS';
  auth.executedAt=new Date().toISOString();
  auth.executionRunId=process.env.GITHUB_RUN_ID||null;
  auth.automaticExpansion=false;

  const campaignPath=path.join(root,'audio-candidates','_campaigns','sadaltager-openrouter-20260901-v1','state.json');
  const campaign=await json(campaignPath).catch(()=>null);
  const row=campaign?.articles?.['why-some-passports-are-stronger']||{};
  const result={
    schema:'bareeq.audio-gate5-passports-result.v1',
    generatedAt:new Date().toISOString(),
    runId:process.env.GITHUB_RUN_ID||null,
    decisionId:auth.decisionId,
    successfulTtsRequests:successful,
    providerAttempted:/PROGRESSIVE_REPAIR_(?:TTS_OK|DAILY_QUOTA_STOP|RATE_WAIT)/.test(log),
    validationStatus:row.validation?.status||null,
    consensus:row.validation?.consensus||null,
    fingerprint:row.generation?.fingerprint||null,
    fullSha256:row.validation?.fullSha256||null,
    diagnosticEvidencePath:row.validation?.diagnosticEvidencePath||null,
    publicationAttempted:false,
    publicAudioMutated:false,
    nextAction:successful===1?'inspect retained trial/validation evidence; no further TTS is authorized':'no successful TTS was consumed; authorization is closed to prevent automatic retry',
  };
  if(successful===1){
    if(Number(strategy.successfulTtsSinceLastNewExact)!==30) throw new Error(`strategy accounting must be 30/30 after successful Gate 5 TTS; got ${strategy.successfulTtsSinceLastNewExact}/${strategy.threshold}`);
    freeze.strategySnapshot.successfulTtsSinceLastNewExact=30;
    freeze.reason='Gate 5 passports experiment consumed the single authorized successful TTS request. Global synthesis remains frozen at 30/30; no further TTS is authorized.';
    freeze.reviewPolicy.nextAction='Inspect and adjudicate the retained passports trial evidence. No further TTS is authorized.';
    freeze.reviewPolicy.gate5SelectedTarget={...freeze.reviewPolicy.gate5SelectedTarget,successfulTtsRequestsAuthorized:0,successfulTtsRequestsConsumed:1,status:'EXECUTED_CONSUMED'};
  } else {
    freeze.reason='The authorized Gate 5 passports execution ended without a successful TTS response. Global synthesis remains frozen; automatic retry is prohibited.';
    freeze.reviewPolicy.nextAction='Inspect the failed/quota execution evidence. Any retry requires a new explicit decision; automatic retry is prohibited.';
    freeze.reviewPolicy.gate5SelectedTarget={...freeze.reviewPolicy.gate5SelectedTarget,successfulTtsRequestsAuthorized:0,successfulTtsRequestsConsumed:0,status:'ATTEMPTED_NO_SUCCESS'};
  }
  await writeFile(authPath,JSON.stringify(auth,null,2)+'\n');
  await writeFile(freezePath,JSON.stringify(freeze,null,2)+'\n');
  await writeFile(path.join(root,'docs','audio','GATE-5-PASSPORTS-RESULT.json'),JSON.stringify(result,null,2)+'\n');
  console.log(`GATE5_ACCOUNTING=PASS successfulTts=${successful} authorization=${auth.authorizationStatus} strategy=${strategy.successfulTtsSinceLastNewExact}/${strategy.threshold} publication=false`);
  return result;
}
async function cli(){
 const root=path.resolve(arg('root',process.cwd()));
 const logPath=path.resolve(arg('log',process.env.RUNNER_TEMP?path.join(process.env.RUNNER_TEMP,'gate5-passports.log'):'gate5-passports.log'));
 await finalizeGate5({root,logPath});
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
