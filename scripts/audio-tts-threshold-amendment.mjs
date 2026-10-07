import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const AMENDMENT_PATH='docs/audio/TTS-THRESHOLD-AMENDMENT-33.json';
const fail=message=>{throw new Error(`TTS threshold amendment invalid: ${message}`);};
export function validateThresholdAmendment({amendment:a,strategy,freeze,status}) {
 if(a?.schema!=='bareeq.audio-tts-threshold-amendment.v1') fail('schema');
 if(!['AUTHORIZED','IN_PROGRESS','CONSUMED','BLOCKED'].includes(a.authorizationStatus)) fail('authorization status');
 if(a.authorizedBy!=='project-owner'||a.authorizationText!=='ارفع الحد إلى 33'||!Number.isFinite(Date.parse(a.authorizedAt))) fail('owner authorization');
 if(a.previousThreshold!==30||a.newThreshold!==33||a.successfulRequestBaseline!==30||a.additionalSuccessfulRequestsAuthorized!==3) fail('bounded 30 to 33 envelope');
 if(!Number.isInteger(a.successfulRequestsConsumed)||a.successfulRequestsConsumed<0||a.successfulRequestsConsumed>3) fail('consumed budget');
 if(a.automaticExpansion!==false||a.qualityPolicyUnchanged!==true||a.automaticProviderDispatch!==false||a.existingExactAudioImmutable!==true) fail('scope protections');
 if(freeze.active!==true||strategy.threshold!==33||freeze.strategySnapshot.threshold!==33) fail('global freeze / threshold drift');
 if(strategy.successfulTtsSinceLastNewExact!==30+a.successfulRequestsConsumed||freeze.strategySnapshot.successfulTtsSinceLastNewExact!==strategy.successfulTtsSinceLastNewExact) fail('counter drift');
 if(strategy.exactBaseline!==status.exactCount) fail('Exact baseline drift');
 if(!Array.isArray(a.targets)||a.targets.length!==3||new Set(a.targets.map(t=>t.articleId)).size!==3) fail('three unique targets');
 const protectedRows=status.rows.filter(r=>r.publishedExact===true);
 if(!Array.isArray(a.protectedExact)||a.protectedExact.length!==9) fail('protected Exact identities');
 for(const p of a.protectedExact){const row=protectedRows.find(r=>r.articleId===p.articleId);if(!row||row.fingerprint!==p.fingerprint||row.fullSha256!==p.fullSha256) fail('protected Exact identity changed');}
 let consumed=0;
 for(const t of a.targets){
  if(t.successfulTtsMaximum!==1||!Number.isInteger(t.successfulTtsConsumed)||t.successfulTtsConsumed<0||t.successfulTtsConsumed>1) fail('per-target budget');
  const row=status.rows.find(r=>r.articleId===t.articleId);
  if(!row||row.fingerprint!==t.fingerprint||(!row.publishedExact&&row.fullSha256!==t.baselineFullSha256)) fail('target identity drift');
  if(!/^[a-f0-9]{64}$/.test(t.baselineFullSha256)||!t.targets.length||t.targets.some(x=>x.humanConfirmed!==true)) fail('target evidence');
  consumed+=t.successfulTtsConsumed;
 }
 if(consumed!==a.successfulRequestsConsumed) fail('per-target consumption sum');
 if(a.authorizationStatus==='CONSUMED'&&consumed!==3) fail('premature closure');
 return {threshold:33,consumed,remaining:3-consumed,providerExecutionReady:a.executionStatus==='PREFLIGHT_PASSED'};
}
export async function readThresholdAmendment(root=process.cwd()){
 const json=async p=>JSON.parse(await readFile(path.join(root,p),'utf8'));
 const [amendment,strategy,freeze,status]=await Promise.all([json(AMENDMENT_PATH),json('docs/audio/ENGINE-STRATEGY-STATE.json'),json('docs/audio/TTS-FREEZE.json'),json('docs/audio/PROGRESSIVE-STATUS.json')]);
 return {...validateThresholdAmendment({amendment,strategy,freeze,status}),amendment};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const r=await readThresholdAmendment(); console.log(`TTS_THRESHOLD_AMENDMENT=PASS threshold=${r.threshold} consumed=${r.consumed}/3 remaining=${r.remaining} globalFreeze=active`);
}
