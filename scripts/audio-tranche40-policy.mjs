import {createHash} from 'node:crypto';
export const TRANCHE40_PATH='docs/audio/TTS-THRESHOLD-AMENDMENT-40.json';
export const TRANCHE40_PREFLIGHT='docs/audio/TRANCHE40-PREFLIGHT.json';
export const DECISION40='COMPLETION15-TRANCHE40-v1';
export const digest40=x=>createHash('sha256').update(x).digest('hex');
const fail=s=>{throw new Error(`Tranche40 authorization invalid: ${s}`);};
const texts=[
 'a315650636cd680bd8cc494f54bd543db8f98657a54909ff106924f94c4aa6ec',
 'b9a6aaa6fce706365cd38fb5b9e7620a8ea90ce9e34eaf39d522052ff9ce7aae',
 'dc569c0d6ca586b9c3d50a63b44ce2194ea6d806c8ddc10996afe0f4778e6f62',
 '6da5ebb34e04b37a1d72305089b2e34d7b740bf54f135000ac54cca14e288290',
 'e0c25a2b3675032df17a563408146a42976b06c9d5b701ca0008172623170183',
 'acd2554f9c0093a7b03667c5494d99bd2e8aa29950efd7621fc3801804e11e4b',
 'f02e98edefff19bbb1bca2ee31c77b93c933a1f8804c45b0c5b978fae5e66373',
];
const cases=[['S1'],['S2'],['S3'],['M3'],['M8'],['M11'],['M13','M14']];
export function validateTranche40Policy({amendment:a,strategy,freeze,status}) {
 if(a?.schema!=='bareeq.audio-tts-threshold-amendment.v2'||a.decisionId!==DECISION40)fail('schema/decision');
 if(a.authorizedBy!=='project-owner'||a.authorizationText!=='اعتمد'||a.approvedProposal!=='docs/audio/TARGETED-REPAIR-PROPOSAL-40.json'||!Number.isFinite(Date.parse(a.authorizedAt)))fail('owner decision');
 if(!['AUTHORIZED','IN_PROGRESS','CONSUMED','BLOCKED'].includes(a.authorizationStatus))fail('status');
 if(a.previousThreshold!==33||a.newThreshold!==40||a.successfulRequestBaseline!==33||a.additionalSuccessfulRequestsAuthorized!==7)fail('bounded 33 to 40 budget');
 if(a.automaticExpansion!==false||a.automaticProviderDispatch!==false||a.qualityPolicyUnchanged!==true||a.existingExactAudioImmutable!==true||a.automaticRetry!==false)fail('protections');
 if(!Number.isInteger(a.successfulRequestsConsumed)||a.successfulRequestsConsumed<0||a.successfulRequestsConsumed>7)fail('budget');
 if(freeze?.active!==true||strategy?.threshold!==40||freeze.strategySnapshot?.threshold!==40||strategy.successfulTtsSinceLastNewExact!==33+a.successfulRequestsConsumed||freeze.strategySnapshot.successfulTtsSinceLastNewExact!==strategy.successfulTtsSinceLastNewExact||strategy.exactBaseline!==status?.exactCount)fail('freeze/counter drift');
 if(a.targets?.length!==7||new Set(a.targets.map(t=>t.id)).size!==7)fail('seven unique requests');
 if(a.protectedExact?.length!==10)fail('ten protected articles');
 for(const p of a.protectedExact){const row=status.rows.find(r=>r.articleId===p.articleId);if(!row?.publishedExact||row.fingerprint!==p.fingerprint||row.fullSha256!==p.fullSha256)fail('protected audio drift');}
 let consumed=0;
 for(const [i,t] of a.targets.entries()){
  const article=i<3?'how-touchscreens-work':'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع';
  if(t.id!==`R40-${String(i+1).padStart(2,'0')}`||t.articleId!==article||JSON.stringify(t.caseIds)!==JSON.stringify(cases[i])||t.generationTextSha256!==texts[i]||digest40(t.generationText)!==texts[i]||t.maximumRequests!==1||t.automaticRetry!==false)fail('approved target/text');
  if(!Number.isInteger(t.successfulTtsConsumed)||t.successfulTtsConsumed<0||t.successfulTtsConsumed>1)fail('per-request budget');
  const row=status.rows.find(r=>r.articleId===article);if(!row||row.fingerprint!==t.fingerprint||(!row.publishedExact&&row.fullSha256!==t.baselineFullSha256))fail('source identity');
  for(const key of ['sourcePartSha256','baselineFullSha256','speechScriptHash'])if(!/^[0-9a-f]{64}$/.test(t[key]||''))fail('source binding');
  consumed+=t.successfulTtsConsumed;
 }
 if(consumed!==a.successfulRequestsConsumed)fail('consumption sum');
 if(a.authorizationStatus==='CONSUMED'&&consumed!==7)fail('premature consumed closure');
 return {threshold:40,consumed,remaining:7-consumed,providerExecutionReady:a.executionStatus==='PREFLIGHT_PASSED'};
}
