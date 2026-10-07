import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adjudicateDualAsr } from './audio-dual-asr-adjudicate.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { sha256 } from './audio-constants.mjs';

const EXCLUDED = new Set(['اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع']);

function arg(name, fallback) {
  const prefix=`--${name}=`;
  return process.argv.find(v=>v.startsWith(prefix))?.slice(prefix.length) || fallback;
}
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }
function score(c={}){ return ['substitutions','deletions','insertions','unresolved'].reduce((n,k)=>n+(Number(c[k])||0),0); }

function decisionSets(full, finalChoice){
  const resolved = new Set(full.confirmedFalsePositiveCandidates || []);
  for(const row of finalChoice.results || []){
    if(row.disposition === 'EXPECTED_PRONUNCIATION_CONFIRMED') resolved.add(row.sourceCaseId);
  }
  const ambiguity = new Set((finalChoice.results || [])
    .filter(row=>row.disposition === 'VALIDATOR_AMBIGUITY_PHONETIC_COLLISION')
    .map(row=>row.sourceCaseId));
  const actual = new Set(full.confirmedTargetAudioErrors || []);
  return {resolved,ambiguity,actual};
}

function removeOneIssue(result, mapping, caseId, resolution){
  const index=Number(mapping.expectedIndex);
  const type=String(mapping.issueType || mapping.hidden?.automatedType || '');
  const pools=[
    ['substantiveDifferences', result.substantiveDifferences],
    ['unresolved', result.unresolved],
  ];
  const matches=[];
  for(const [poolName,pool] of pools){
    for(let i=0;i<pool.length;i++){
      const item=pool[i];
      if(Number(item.expectedIndex)!==index) continue;
      if(poolName==='substantiveDifferences' && type && type!=='unresolved' && item.type!==type) continue;
      matches.push({poolName,pool,index:i,item});
    }
  }
  if(matches.length!==1){
    throw new Error(`${caseId}: expected exactly one fresh adjudication issue at expectedIndex=${index} type=${type}; found ${matches.length}`);
  }
  const hit=matches[0];
  hit.pool.splice(hit.index,1);
  result.humanResolved.push({
    caseId,
    articleId:mapping.articleId,
    fingerprint:mapping.fingerprint,
    fullSha256:mapping.fullSha256,
    expectedIndex:index,
    expectedToken:mapping.expectedToken,
    originalIssueType:type,
    originalAutomatedEvidence:mapping.hidden,
    resolution,
  });
}

function recompute(result){
  const substitutions=result.substantiveDifferences.filter(x=>x.type==='substitution').length;
  const deletions=result.substantiveDifferences.filter(x=>x.type==='deletion').length;
  const insertions=result.substantiveDifferences.filter(x=>x.type==='insertion').length;
  const unresolved=result.unresolved.length;
  result.consensus={substitutions,deletions,insertions,unresolved};
  result.passed=[substitutions,deletions,insertions,unresolved].every(x=>x===0);
  result.status=result.passed?'passed':'failed';
  return result;
}

export function applyHumanEvidence({baseResult, mappings, resolvedCases, ambiguityCases, actualCases}){
  const result=structuredClone(baseResult);
  result.schema='bareeq.audio-human-evidence-adjudication.v1';
  result.baseSchema=baseResult.schema;
  result.baseConsensus={...baseResult.consensus};
  result.method='independent-dual-asr-consensus-plus-binding-blind-human-triage';
  result.humanResolved=[];
  result.humanConfirmedAudioErrors=[];

  for(const caseId of [...resolvedCases].sort()){
    const mapping=mappings[caseId];
    if(!mapping || mapping.kind!=='pending') throw new Error(`${caseId}: missing pending-case mapping`);
    removeOneIssue(result,mapping,caseId,'EXPECTED_PRONUNCIATION_CONFIRMED');
  }
  for(const caseId of [...ambiguityCases].sort()){
    const mapping=mappings[caseId];
    if(!mapping || mapping.kind!=='pending') throw new Error(`${caseId}: missing pending-case mapping`);
    removeOneIssue(result,mapping,caseId,'VALIDATOR_AMBIGUITY_PHONETIC_COLLISION');
  }
  for(const caseId of [...actualCases].sort()){
    const mapping=mappings[caseId];
    if(!mapping || mapping.kind!=='pending') throw new Error(`${caseId}: missing pending-case mapping`);
    result.humanConfirmedAudioErrors.push({
      caseId,
      articleId:mapping.articleId,
      fingerprint:mapping.fingerprint,
      fullSha256:mapping.fullSha256,
      expectedIndex:Number(mapping.expectedIndex),
      expectedToken:mapping.expectedToken,
      issueType:mapping.issueType,
    });
  }

  result.policy={
    rawAsrReportsImmutable:true,
    baseAdjudicationImmutable:true,
    humanEvidenceMustBindCaseToArticleFingerprintAndFullSha:true,
    humanExpectedPronunciationMayResolveOnlyItsExactMappedIssue:true,
    phoneticCollisionMayResolveOnlyItsExactMappedIssue:true,
    humanConfirmedAudioErrorNeverRemoved:true,
    fuzzyMatching:false,
    ttsCalls:0,
    newAsrCalls:0,
  };
  return recompute(result);
}

export async function runHumanOfflineAdjudication({artifactRoot,triageRoot,repoRoot=process.cwd()}){
  const status=await json(path.join(artifactRoot,'docs','audio','PROGRESSIVE-STATUS.json'));
  const internal=await json(path.join(triageRoot,'internal-evidence.json'));
  const full=await json(path.join(repoRoot,'docs','audio','HUMAN-TRIAGE-FULL-RESULT-20261006.json'));
  const finalChoice=await json(path.join(repoRoot,'docs','audio','HUMAN-TRIAGE-FINAL-FORCED-CHOICE-RESULT-20261006.json'));

  if(internal.packageId!==full.packageId) throw new Error('triage packageId mismatch');
  if(internal.totals?.pendingMismatches!==29 || internal.totals?.exactControls!==7) throw new Error('triage internal totals mismatch');
  if(finalChoice.packageId!=='triage-final-forced-choice-T06-T31') throw new Error('unexpected final forced-choice package');

  const {resolved,ambiguity,actual}=decisionSets(full,finalChoice);
  if(resolved.size!==17) throw new Error(`expected 17 human expected-pronunciation confirmations, got ${resolved.size}`);
  if(ambiguity.size!==1 || !ambiguity.has('T06')) throw new Error('expected only T06 as phonetic ambiguity');
  if(actual.size!==11) throw new Error(`expected 11 target-valid human audio errors, got ${actual.size}`);

  const active=(status.rows||[]).filter(row=>row.exact!==true && !EXCLUDED.has(row.articleId));
  if(active.length!==7) throw new Error(`expected 7 active pending articles, found ${active.length}`);

  const rows=[];
  for(const row of active){
    const dir=path.join(artifactRoot,'audio-candidates',row.articleId,row.fingerprint);
    const reportsDir=path.join(dir,'reports');
    const existing=await json(path.join(reportsDir,'asr-adjudication.json'));
    const models=existing.models||[];
    if(models.length!==2 || new Set(models).size!==2) throw new Error(`${row.articleId}: expected two ASR models`);
    const fullBytes=await readFile(path.join(dir,'full.mp3'));
    const fullSha256=sha256(fullBytes);
    if(fullSha256!==row.fullSha256) throw new Error(`${row.articleId}: status/full.mp3 SHA mismatch`);
    const reports=[];
    for(const model of models){
      const report=await json(path.join(reportsDir,`asr-${model}.json`));
      if((report.candidateFingerprint||report.fingerprint)!==row.fingerprint) throw new Error(`${row.articleId}: ASR fingerprint mismatch`);
      if(report.fullSha256!==fullSha256) throw new Error(`${row.articleId}: ASR full SHA mismatch`);
      reports.push(report);
    }
    const [technical,sync,manifest]=await Promise.all([
      json(path.join(reportsDir,'technical-qa.json')),
      json(path.join(reportsDir,'sync.json')),
      json(path.join(dir,'manifest.candidate.json')),
    ]);
    const technicalPassed=technical.passed===true || technical.status==='passed';
    const syncPassed=sync.passed===true || sync.status==='passed';
    if(!technicalPassed) throw new Error(`${row.articleId}: Technical QA is not passed`);
    if(!syncPassed) throw new Error(`${row.articleId}: sync is not passed`);
    if((manifest.candidateFingerprint||manifest.fingerprint)!==row.fingerprint) throw new Error(`${row.articleId}: candidate manifest fingerprint mismatch`);
    if(manifest.fullSha256 && manifest.fullSha256!==fullSha256) throw new Error(`${row.articleId}: candidate manifest full SHA mismatch`);

    const article=await loadSpokenArticle(row.articleId,repoRoot);
    const base=adjudicateDualAsr({
      expectedText:article.spokenText,
      reports,
      articleId:row.articleId,
      fingerprint:row.fingerprint,
      fullSha256,
      speechScriptHash:article.speechScriptHash,
      models,
    });

    const mappings=internal.mapping||{};
    for(const [caseId,m] of Object.entries(mappings)){
      if(m.kind!=='pending' || m.articleId!==row.articleId) continue;
      if(m.fingerprint!==row.fingerprint || m.fullSha256!==fullSha256){
        throw new Error(`${caseId}: human evidence identity mismatch for ${row.articleId}`);
      }
    }

    const adjudicated=applyHumanEvidence({
      baseResult:base,
      mappings,
      resolvedCases:new Set([...resolved].filter(id=>mappings[id]?.articleId===row.articleId)),
      ambiguityCases:new Set([...ambiguity].filter(id=>mappings[id]?.articleId===row.articleId)),
      actualCases:new Set([...actual].filter(id=>mappings[id]?.articleId===row.articleId)),
    });

    rows.push({
      articleId:row.articleId,
      title:row.title,
      fingerprint:row.fingerprint,
      fullSha256,
      technicalQa:{passed:technicalPassed,status:technical.status||null},
      sync:{passed:syncPassed,status:sync.status||null},
      candidateManifestBound:true,
      baseConsensus:adjudicated.baseConsensus,
      finalConsensus:adjudicated.consensus,
      baseScore:score(adjudicated.baseConsensus),
      finalScore:score(adjudicated.consensus),
      exactAfterHumanEvidence:adjudicated.passed,
      humanResolved:adjudicated.humanResolved,
      humanConfirmedAudioErrors:adjudicated.humanConfirmedAudioErrors,
    });
  }

  return {
    schema:'bareeq.audio-human-offline-adjudication.v1',
    sourceRunId:status.sourceRunId,
    sourceArtifact:status.sourceArtifact,
    triagePackageId:internal.packageId,
    reviewerResultsSha256:full.reviewerResultsSha256,
    finalForcedChoiceSha256:finalChoice.reviewerResultsSha256,
    generatedAt:new Date().toISOString(),
    activePending:rows.length,
    newlyExactWithoutTts:rows.filter(r=>r.exactAfterHumanEvidence).length,
    projectedExactTotal:7+rows.filter(r=>r.exactAfterHumanEvidence).length,
    ttsCalls:0,
    newAsrCalls:0,
    providerCalls:0,
    rows,
  };
}

export function markdown(r){
  const lines=r.rows.map(x=>`- **${x.title}** — base=${x.baseScore} → final=${x.finalScore}; exact=${x.exactAfterHumanEvidence?'YES':'no'}; human-resolved=${x.humanResolved.length}; confirmed-audio-errors=${x.humanConfirmedAudioErrors.length}`).join('\n');
  return `# Human evidence offline adjudication

- Source run: **${r.sourceRunId}**
- Active pending: **${r.activePending}**
- Newly Exact without TTS: **${r.newlyExactWithoutTts}**
- Projected Exact total: **${r.projectedExactTotal}/15**
- TTS calls: **0**
- New ASR calls: **0**
- Provider calls: **0**

## Results

${lines}

## Safety

Raw ASR reports and the base Dual-ASR adjudication are retained unchanged. Human evidence can resolve only the exact issue bound to its case id, article id, fingerprint, full SHA, and expected index. Confirmed audio errors are never removed.
`;
}

async function cli(){
  const artifactRoot=path.resolve(arg('root','adjudication-input'));
  const triageRoot=path.resolve(arg('triage-root','triage-input'));
  const out=path.resolve(arg('out','human-adjudication-output'));
  const result=await runHumanOfflineAdjudication({artifactRoot,triageRoot});
  await mkdir(out,{recursive:true});
  await writeFile(path.join(out,'HUMAN-OFFLINE-ADJUDICATION.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(path.join(out,'HUMAN-OFFLINE-ADJUDICATION.md'),markdown(result));
  console.log(`HUMAN_OFFLINE_ADJUDICATION=PASS newlyExact=${result.newlyExactWithoutTts} projected=${result.projectedExactTotal}/15 tts=0 asr=0 provider=0`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
