import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeVerbal } from './audio-exact-match.mjs';
import { sha256 } from './audio-constants.mjs';

const RUN_ID='37581607040';
const ARTICLE='why-some-passports-are-stronger';
const FP='2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b';
const T03_INDEX=818;
const T02_INDEX=1484;

function arg(name,fallback){
  const prefix=`--${name}=`;
  return process.argv.find(v=>v.startsWith(prefix))?.slice(prefix.length)||fallback;
}
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }

async function findFile(root, suffix){
  const entries=await readdir(root,{withFileTypes:true});
  for(const e of entries){
    const p=path.join(root,e.name);
    if(e.isDirectory()){
      const hit=await findFile(p,suffix);
      if(hit) return hit;
    } else if(p.replaceAll('\\','/').endsWith(suffix)) return p;
  }
  return null;
}
function allIssues(adj={}){
  return [
    ...(adj.substantiveDifferences||[]).map(x=>({bucket:'substantive',...x})),
    ...(adj.unresolved||[]).map(x=>({bucket:'unresolved',type:x.type||'unresolved',...x})),
  ].sort((a,b)=>Number(a.expectedIndex)-Number(b.expectedIndex));
}
function diffAt(report,index){
  return (report?.differences||[]).filter(x=>Number(x.expectedIndex)===index)
    .map(x=>({type:x.type,expected:x.expected??null,actual:x.actual??null}));
}
function partTokenRanges(manifest){
  let cursor=0;
  return (manifest.parts||[]).map(part=>{
    const text=part.text || (part.items||[]).map(x=>x.text||'').join(' ');
    const count=tokenizeVerbal(text).length;
    const row={partIndex:Number(part.partIndex),partNumber:Number(part.partIndex)+1,start:cursor,end:cursor+count-1,tokenCount:count};
    cursor+=count;
    return row;
  });
}
function partDigestMap(checkpoint={}){
  return Object.fromEntries(Object.entries(checkpoint.completedParts||{}).map(([k,v])=>[
    Number(k),{file:v.file||null,sha256:v.sha256||null,bytes:v.bytes??null}
  ]));
}

export async function analyzeGate5PassportsArtifact({root}){
  const suffix=`audio-candidates/_diagnostics/${RUN_ID}/${ARTICLE}/${FP}/metadata.json`;
  const metadataPath=await findFile(root,suffix);
  if(!metadataPath) throw new Error(`diagnostic metadata not found under ${root}`);
  const diag=path.dirname(metadataPath);
  const baseline=path.join(diag,'baseline');
  const trial=path.join(diag,'trial');

  const [meta,baseCheckpoint,trialCheckpoint,baseRawAdj,trialAdj,trialManifest]=await Promise.all([
    json(metadataPath),
    json(path.join(baseline,'checkpoint.json')),
    json(path.join(trial,'checkpoint.json')),
    json(path.join(baseline,'reports','asr-adjudication.pre-gate5.json')),
    json(path.join(trial,'reports','asr-adjudication.json')),
    json(path.join(trial,'manifest.candidate.json')),
  ]);
  const models=trialAdj.models||[];
  if(models.length!==2) throw new Error('trial adjudication does not contain two models');
  const trialReports=[];
  for(const model of models) trialReports.push(await json(path.join(trial,'reports',`asr-${model}.json`)));

  const baseParts=partDigestMap(baseCheckpoint);
  const trialParts=partDigestMap(trialCheckpoint);
  const changedParts=[];
  for(const index of [...new Set([...Object.keys(baseParts),...Object.keys(trialParts)].map(Number))].sort((a,b)=>a-b)){
    const a=baseParts[index],b=trialParts[index];
    if(!a||!b||a.sha256!==b.sha256) changedParts.push({
      partIndex:index,partNumber:index+1,
      baselineSha256:a?.sha256||null,trialSha256:b?.sha256||null,
      baselineFile:a?.file||null,trialFile:b?.file||null,
    });
  }
  if(changedParts.length!==1||changedParts[0].partIndex!==3) {
    throw new Error(`expected only part 4 to change; got ${changedParts.map(x=>x.partNumber).join(',')}`);
  }
  if(baseParts[5]?.sha256!==trialParts[5]?.sha256) throw new Error('part 6 changed; T02 human evidence cannot be carried');

  const ranges=partTokenRanges(trialManifest);
  const part4=ranges.find(x=>x.partIndex===3);
  const part6=ranges.find(x=>x.partIndex===5);
  if(!part4||!part6) throw new Error('part token ranges missing');

  const baselineIssues=allIssues(baseRawAdj);
  const trialIssues=allIssues(trialAdj);
  const baselineIndexes=new Set(baselineIssues.map(x=>Number(x.expectedIndex)));
  const trialIndexes=new Set(trialIssues.map(x=>Number(x.expectedIndex)));
  const t03StillAdjudicated=trialIndexes.has(T03_INDEX);
  const t02StillAdjudicated=trialIndexes.has(T02_INDEX);

  const t03Raw=Object.fromEntries(trialReports.map(r=>[
    r.requestedModel||r.model,diffAt(r,T03_INDEX)
  ]));
  const t02Raw=Object.fromEntries(trialReports.map(r=>[
    r.requestedModel||r.model,diffAt(r,T02_INDEX)
  ]));

  const issuesWithSurface=trialIssues.map(issue=>{
    const index=Number(issue.expectedIndex);
    const range=ranges.find(r=>index>=r.start&&index<=r.end);
    return {
      ...issue,
      expectedIndex:index,
      partNumber:range?.partNumber??null,
      insideRegeneratedPart:index>=part4.start&&index<=part4.end,
      existedInBaseline:baselineIndexes.has(index),
    };
  });
  const newIssues=issuesWithSurface.filter(x=>!x.existedInBaseline);
  const newInsidePart4=newIssues.filter(x=>x.insideRegeneratedPart);
  const outsidePart4=issuesWithSurface.filter(x=>!x.insideRegeneratedPart);

  const targetRawModelsMatching=models.filter(model=>(t03Raw[model]||[]).length===0);
  const targetFixedByRawAsr=targetRawModelsMatching.length===2;
  const targetFixedByConsensus=!t03StillAdjudicated;
  const verdict=targetFixedByRawAsr && targetFixedByConsensus
    ? (trialIssues.length===0 ? 'T03_FIXED_TRIAL_EXACT_RAW' : 'T03_FIXED_BUT_TRIAL_REGRESSED_ELSEWHERE')
    : 'T03_NOT_FIXED';

  const trialFull=await readFile(path.join(trial,'full.mp3'));
  const baseFull=await readFile(path.join(baseline,'full.mp3'));
  const result={
    schema:'bareeq.audio-gate5-passports-forensics.v1',
    generatedAt:new Date().toISOString(),
    sourceRunId:RUN_ID,
    diagnosticMetadata:meta,
    verdict,
    target:{
      caseId:'T03',expectedIndex:T03_INDEX,expectedToken:'لا',
      rawModelEvidence:t03Raw,
      modelsMatchingExpected:targetRawModelsMatching,
      fixedByBothRawModels:targetFixedByRawAsr,
      absentFromTrialConsensus:targetFixedByConsensus,
    },
    carriedHumanEvidence:{
      caseId:'T02',expectedIndex:T02_INDEX,
      partNumber:6,
      baselinePartSha256:baseParts[5]?.sha256||null,
      trialPartSha256:trialParts[5]?.sha256||null,
      audioBytesUnchanged:baseParts[5]?.sha256===trialParts[5]?.sha256,
      trialRawModelEvidence:t02Raw,
      appearsInTrialConsensus:t02StillAdjudicated,
    },
    repairSurface:{
      changedParts,
      part4TokenRange:part4,
      part6TokenRange:part6,
      baselineFullSha256:sha256(baseFull),
      trialFullSha256:sha256(trialFull),
      fullAudioChanged:sha256(baseFull)!==sha256(trialFull),
    },
    baseline:{
      consensus:baseRawAdj.consensus,
      issues:baselineIssues,
    },
    trial:{
      consensus:trialAdj.consensus,
      issueCount:trialIssues.length,
      issues:issuesWithSurface,
      newIssues,
      newIssuesInsideRegeneratedPart:newInsidePart4,
      issuesOutsideRegeneratedPart:outsidePart4,
    },
    conclusion:{
      publishable:false,
      baselineRestorationCorrect:true,
      additionalTtsAuthorized:false,
      strategicState:'30/30',
      explanation: verdict==='T03_FIXED_BUT_TRIAL_REGRESSED_ELSEWHERE'
        ? 'The authorized synthesis fixed the target لا according to both fresh ASR models, but whole-part regeneration introduced new lexical disagreements. The trial must remain rejected and the immutable baseline/fallback retained.'
        : verdict==='T03_NOT_FIXED'
          ? 'The authorized synthesis did not reliably fix the target لا. The trial remains rejected.'
          : 'The raw trial is Exact before carrying any unchanged-region human evidence; publication still requires normal policy review and is not authorized by this forensic report.',
    },
  };
  return result;
}

export function markdown(r){
  const issueLines=r.trial.issues.map(x=>`- index ${x.expectedIndex}: ${x.expected??'∅'} → ${x.actual??(x.first?.actual||x.second?.actual||'unresolved')} [${x.type}] — part ${x.partNumber}; new=${!x.existedInBaseline}; regenerated-part=${x.insideRegeneratedPart}`).join('\n')||'- none';
  return `# Gate 5 Passports — Postmortem

**Verdict:** \`${r.verdict}\`

## Target T03

- Expected: **لا**
- expectedIndex: **818**
- Both fresh ASR models match expected: **${r.target.fixedByBothRawModels}**
- T03 absent from trial consensus errors: **${r.target.absentFromTrialConsensus}**

Raw model evidence:

\`\`\`json
${JSON.stringify(r.target.rawModelEvidence,null,2)}
\`\`\`

## Repair surface

- Only changed generated part: **${r.repairSurface.changedParts.map(x=>x.partNumber).join(', ')}**
- Part 6 (T02 region) byte-identical: **${r.carriedHumanEvidence.audioBytesUnchanged}**
- Baseline full SHA: \`${r.repairSurface.baselineFullSha256}\`
- Trial full SHA: \`${r.repairSurface.trialFullSha256}\`

## Fresh trial consensus

`S=${r.trial.consensus.substitutions} D=${r.trial.consensus.deletions} I=${r.trial.consensus.insertions} unresolved=${r.trial.consensus.unresolved}`

${issueLines}

New issues introduced by the trial: **${r.trial.newIssues.length}**  
New issues inside regenerated part 4: **${r.trial.newIssuesInsideRegeneratedPart.length}**

## Decision

${r.conclusion.explanation}

- Publication: **NO**
- Baseline restoration: **correct**
- Additional TTS authorized: **NO**
- Strategy: **30/30**
`;
}

async function cli(){
  const root=path.resolve(arg('root','gate5-artifact'));
  const out=path.resolve(arg('out','gate5-forensics-output'));
  const result=await analyzeGate5PassportsArtifact({root});
  await mkdir(out,{recursive:true});
  await writeFile(path.join(out,'GATE-5-PASSPORTS-POSTMORTEM.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(path.join(out,'GATE-5-PASSPORTS-POSTMORTEM.md'),markdown(result));
  console.log(`GATE5_FORENSICS=PASS verdict=${result.verdict} targetFixed=${result.target.fixedByBothRawModels} newIssues=${result.trial.newIssues.length} changedParts=${result.repairSurface.changedParts.map(x=>x.partNumber).join(',')} tts=0 provider=0`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
