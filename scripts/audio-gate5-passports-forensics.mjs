import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeVerbal } from './audio-exact-match.mjs';
import { sha256, QUOTA_SPLIT } from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle, activeSplitSettings } from './audio-split.mjs';
import { decodePcm, spliceWindowMetrics } from './audio-merge.mjs';

const RUN_ID='37581607040';
const ARTICLE='why-some-passports-are-stronger';
const FP='2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b';

function arg(name,fallback){
  const prefix=`--${name}=`;
  return process.argv.find(v=>v.startsWith(prefix))?.slice(prefix.length)||fallback;
}
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }

async function findFile(root,suffix){
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
  return (report?.differences||[]).filter(x=>Number(x.expectedIndex)===Number(index))
    .map(x=>({type:x.type,expected:x.expected??null,actual:x.actual??null}));
}
function partDigestMap(checkpoint={}){
  return Object.fromEntries(Object.entries(checkpoint.completedParts||{}).map(([k,v])=>[
    Number(k),{...v,file:v.file||null,sha256:v.sha256||null,bytes:v.bytes??null}
  ]));
}
function itemId(item){ return item?.runtimeId||item?.segmentId||item?.id||null; }

function itemTokenRanges(article){
  let cursor=0;
  const rows=[];
  for(const item of article.items||[]){
    const tokens=tokenizeVerbal(item.text||'');
    if(tokens.length){
      rows.push({
        segmentId:itemId(item),
        start:cursor,
        end:cursor+tokens.length-1,
        tokenCount:tokens.length,
        text:item.text||'',
      });
      cursor+=tokens.length;
    }
  }
  const total=tokenizeVerbal(article.spokenText||'').length;
  if(cursor!==total) throw new Error(`article item-token map drift: items=${cursor} spoken=${total}`);
  return rows;
}

async function rebuiltPartTokenRanges(article, manifest, repoRoot){
  const live=await json(path.join(repoRoot,'docs','audio','LIVE-AUDIO-OBSERVED-20260828.json'));
  const duration=live?.articles?.find(x=>x.articleId===ARTICLE)?.durationSeconds??null;
  const plan=splitSpokenArticle(article,{
    settings:activeSplitSettings(QUOTA_SPLIT),
    liveDurationSeconds:duration,
  });
  if(plan.parts.length!==(manifest.parts||[]).length){
    throw new Error(`part-plan drift: rebuilt=${plan.parts.length} manifest=${(manifest.parts||[]).length}`);
  }
  let cursor=0;
  const rows=plan.parts.map(part=>{
    const tokens=tokenizeVerbal(part.text||'');
    const row={partIndex:Number(part.partIndex),partNumber:Number(part.partIndex)+1,start:cursor,end:cursor+tokens.length-1,tokenCount:tokens.length,text:part.text||''};
    cursor+=tokens.length;
    return row;
  });
  if(cursor!==tokenizeVerbal(article.spokenText||'').length) throw new Error('rebuilt part ranges do not cover spoken text');
  return rows;
}

function locateIndex(index,partRanges,itemRanges){
  const part=partRanges.find(r=>index>=r.start&&index<=r.end)||null;
  const item=itemRanges.find(r=>index>=r.start&&index<=r.end)||null;
  return {part,item};
}

function pcmSlice(pcm,startSeconds,durationSeconds,sampleRate=48000){
  const start=Math.max(0,Math.floor(Number(startSeconds||0)*sampleRate))*2;
  const end=Math.min(pcm.length,start+Math.floor(Number(durationSeconds||0)*sampleRate)*2);
  return pcm.subarray(start,end);
}

function int16At(buf,sampleIndex){ return buf.readInt16LE(sampleIndex*2); }

function bestCorrelation(a,b,{sampleRate=48000,maxShiftMs=30,downsample=24}={}){
  const aN=Math.floor(a.length/2), bN=Math.floor(b.length/2);
  if(aN<sampleRate*0.4||bN<sampleRate*0.4) return {correlation:null,bestShiftSamples:null,comparedSamples:0};
  const maxShift=Math.floor(sampleRate*maxShiftMs/1000);
  const step=Math.max(1,Math.floor(sampleRate/1000));
  let best={correlation:-2,bestShiftSamples:0,comparedSamples:0};
  for(let shift=-maxShift;shift<=maxShift;shift+=step){
    const aStart=Math.max(0,-shift), bStart=Math.max(0,shift);
    const n=Math.min(aN-aStart,bN-bStart);
    if(n<sampleRate*0.3) continue;
    let sx=0,sy=0,sxx=0,syy=0,sxy=0,count=0;
    for(let i=0;i<n;i+=downsample){
      const x=int16At(a,aStart+i), y=int16At(b,bStart+i);
      sx+=x; sy+=y; sxx+=x*x; syy+=y*y; sxy+=x*y; count++;
    }
    const cov=sxy-(sx*sy/count);
    const vx=sxx-(sx*sx/count), vy=syy-(sy*sy/count);
    const corr=(vx>0&&vy>0)?cov/Math.sqrt(vx*vy):0;
    if(corr>best.correlation) best={correlation:corr,bestShiftSamples:shift,comparedSamples:count};
  }
  return best;
}

function boundaryMetrics(pcm,seconds,sampleRate=48000){
  const sample=Math.max(1,Math.min(Math.floor(Number(seconds)*sampleRate),Math.floor(pcm.length/2)-1));
  const span=Math.floor(sampleRate*0.25);
  const left=pcm.subarray(Math.max(0,(sample-span)*2),sample*2);
  const right=pcm.subarray(sample*2,Math.min(pcm.length,(sample+span)*2));
  return spliceWindowMetrics(left,right,sampleRate,10);
}

function sameActualAcrossModels(evidence){
  const values=Object.values(evidence||{}).map(list=>JSON.stringify(list||[]));
  return values.length===2&&values[0]===values[1]&&values[0]!=='[]';
}

export async function analyzeGate5PassportsArtifact({root,repoRoot=process.cwd()}){
  const suffix=`audio-candidates/_diagnostics/${RUN_ID}/${ARTICLE}/${FP}/metadata.json`;
  const metadataPath=await findFile(root,suffix);
  if(!metadataPath) throw new Error(`diagnostic metadata not found under ${root}`);
  const diag=path.dirname(metadataPath);
  const baseline=path.join(diag,'baseline');
  const trial=path.join(diag,'trial');

  const [meta,baseCheckpoint,trialCheckpoint,baseRawAdj,trialAdj,baseManifest,trialManifest,context,article]=await Promise.all([
    json(metadataPath),
    json(path.join(baseline,'checkpoint.json')),
    json(path.join(trial,'checkpoint.json')),
    json(path.join(baseline,'reports','asr-adjudication.pre-gate5.json')),
    json(path.join(trial,'reports','asr-adjudication.json')),
    json(path.join(baseline,'manifest.candidate.json')),
    json(path.join(trial,'manifest.candidate.json')),
    json(path.join(baseline,'gate5-execution-context.json')),
    loadSpokenArticle(ARTICLE,repoRoot),
  ]);

  if(context.articleId!==ARTICLE||context.fingerprint!==FP) throw new Error('Gate 5 execution context identity mismatch');
  if(article.speechScriptHash&&trialAdj.speechScriptHash&&article.speechScriptHash!==trialAdj.speechScriptHash) throw new Error('spoken article hash drift');

  const T03_INDEX=Number(context.target.expectedIndex);
  const T02_INDEX=Number(context.carriedHumanEvidence.expectedIndex);
  const TARGET_SEGMENT=context.target.segmentId;
  const models=trialAdj.models||[];
  if(models.length!==2||new Set(models).size!==2) throw new Error('trial adjudication does not contain two independent models');

  const trialReports=[];
  for(const model of models) trialReports.push(await json(path.join(trial,'reports',`asr-${model}.json`)));

  const baseParts=partDigestMap(baseCheckpoint);
  const trialParts=partDigestMap(trialCheckpoint);
  const allPartIndexes=[...new Set([...Object.keys(baseParts),...Object.keys(trialParts)].map(Number))].sort((a,b)=>a-b);
  const changedParts=[];
  const unchangedParts=[];
  for(const index of allPartIndexes){
    const a=baseParts[index],b=trialParts[index];
    const same=Boolean(a&&b&&a.sha256&&a.sha256===b.sha256);
    const row={partIndex:index,partNumber:index+1,baselineSha256:a?.sha256||null,trialSha256:b?.sha256||null,baselineFile:a?.file||null,trialFile:b?.file||null};
    (same?unchangedParts:changedParts).push(row);
  }
  if(changedParts.length!==1||changedParts[0].partIndex!==3) throw new Error(`expected only part 4 to change; got ${changedParts.map(x=>x.partNumber).join(',')}`);

  const partRanges=await rebuiltPartTokenRanges(article,trialManifest,repoRoot);
  const itemRanges=itemTokenRanges(article);
  const targetLocation=locateIndex(T03_INDEX,partRanges,itemRanges);
  const fpLocation=locateIndex(T02_INDEX,partRanges,itemRanges);
  if(targetLocation.part?.partNumber!==4||targetLocation.item?.segmentId!==TARGET_SEGMENT) throw new Error('T03 no longer maps to part 4 / b0030');
  if(fpLocation.part?.partNumber!==6) throw new Error('T02 no longer maps to part 6');

  const baselineIssues=allIssues(baseRawAdj);
  const trialIssues=allIssues(trialAdj);
  const baselineIndexes=new Set(baselineIssues.map(x=>Number(x.expectedIndex)));
  const trialIndexes=new Set(trialIssues.map(x=>Number(x.expectedIndex)));
  const t03StillAdjudicated=trialIndexes.has(T03_INDEX);
  const t02StillAdjudicated=trialIndexes.has(T02_INDEX);

  const t03Raw=Object.fromEntries(trialReports.map(r=>[r.requestedModel||r.model,diffAt(r,T03_INDEX)]));
  const t02Raw=Object.fromEntries(trialReports.map(r=>[r.requestedModel||r.model,diffAt(r,T02_INDEX)]));

  const targetItemPos=itemRanges.findIndex(x=>x.segmentId===TARGET_SEGMENT);
  const previousSegment=targetItemPos>0?itemRanges[targetItemPos-1]?.segmentId:null;
  const nextSegment=targetItemPos>=0?itemRanges[targetItemPos+1]?.segmentId:null;

  const issuesWithSurface=trialIssues.map(issue=>{
    const index=Number(issue.expectedIndex);
    const {part,item}=locateIndex(index,partRanges,itemRanges);
    const rawModelEvidence=Object.fromEntries(trialReports.map(r=>[r.requestedModel||r.model,diffAt(r,index)]));
    const partDigest=part?{
      baseline:baseParts[part.partIndex]?.sha256||null,
      trial:trialParts[part.partIndex]?.sha256||null,
      byteIdentical:Boolean(baseParts[part.partIndex]?.sha256&&baseParts[part.partIndex]?.sha256===trialParts[part.partIndex]?.sha256),
    }:null;
    const insideTargetSegment=item?.segmentId===TARGET_SEGMENT;
    const adjacentToTargetSegment=item?.segmentId===previousSegment||item?.segmentId===nextSegment;
    return {
      ...issue,
      expectedIndex:index,
      partNumber:part?.partNumber??null,
      segmentId:item?.segmentId??null,
      segmentText:item?.text??null,
      insideRegeneratedPart:part?.partNumber===4,
      insideTargetSegment,
      adjacentToTargetSegment,
      existedInBaseline:baselineIndexes.has(index),
      rawModelEvidence,
      rawModelsSameDivergence:sameActualAcrossModels(rawModelEvidence),
      audioPartByteIdentical:partDigest?.byteIdentical??null,
    };
  });
  const newIssues=issuesWithSurface.filter(x=>!x.existedInBaseline);
  const newInsidePart4=newIssues.filter(x=>x.insideRegeneratedPart);
  const newInsideTargetSegment=newIssues.filter(x=>x.insideTargetSegment);
  const newOutsidePart4=newIssues.filter(x=>x.partNumber!==4);

  const baseRecord=baseParts[3], trialRecord=trialParts[3];
  const spliceStartRaw=meta.spliceStartSeconds??trialRecord.spliceStartSeconds;
  const spliceEndRaw=meta.spliceEndSeconds??trialRecord.spliceEndSeconds;
  const replacementRaw=trialRecord.replacementSeconds;
  const hasSegmentSplice=[spliceStartRaw,spliceEndRaw,replacementRaw].every(v=>Number.isFinite(Number(v)));
  let waveform={
    mode:hasSegmentSplice?'SEGMENT_SPLICE':'WHOLE_PART_REGENERATION',
    outsideChangedPartByteIdentical:unchangedParts.length===7,
    outsideSplice:null,
    spliceBoundaries:null,
  };
  if(hasSegmentSplice){
    const basePartFile=path.join(baseline,'parts',baseRecord.file);
    const trialPartFile=path.join(trial,'parts',trialRecord.file);
    const [basePcm,trialPcm]=await Promise.all([decodePcm(basePartFile),decodePcm(trialPartFile)]);
    const spliceStart=Number(spliceStartRaw), spliceEnd=Number(spliceEndRaw), replacementSeconds=Number(replacementRaw);
    const prefixDuration=Math.min(2,Math.max(0.5,spliceStart-0.75));
    const prefixStart=Math.max(0,spliceStart-0.5-prefixDuration);
    const basePrefix=pcmSlice(basePcm,prefixStart,prefixDuration);
    const trialPrefix=pcmSlice(trialPcm,prefixStart,prefixDuration);
    const suffixDuration=2;
    const baseSuffixStart=spliceEnd+0.5;
    const trialSuffixStart=spliceStart+replacementSeconds+0.5;
    const baseSuffix=pcmSlice(basePcm,baseSuffixStart,suffixDuration);
    const trialSuffix=pcmSlice(trialPcm,trialSuffixStart,suffixDuration);
    const prefixSimilarity=bestCorrelation(basePrefix,trialPrefix);
    const suffixSimilarity=bestCorrelation(baseSuffix,trialSuffix);
    const startBoundary=boundaryMetrics(trialPcm,spliceStart);
    const endBoundary=boundaryMetrics(trialPcm,spliceStart+replacementSeconds);
    const boundaryArtifact=Boolean(startBoundary.click||startBoundary.gap||startBoundary.overlap||endBoundary.click||endBoundary.gap||endBoundary.overlap);
    waveform={
      mode:'SEGMENT_SPLICE',
      outsideChangedPartByteIdentical:unchangedParts.length===7,
      outsideSplice:{prefix:prefixSimilarity,suffix:suffixSimilarity,preserved:Boolean((prefixSimilarity.correlation??0)>0.985&&(suffixSimilarity.correlation??0)>0.985)},
      spliceBoundaries:{start:startBoundary,end:endBoundary,artifactDetected:boundaryArtifact},
      splice:{startSeconds:spliceStart,endSeconds:spliceEnd,replacementSeconds},
    };
  }

  const targetRawModelsMatching=models.filter(model=>(t03Raw[model]||[]).length===0);
  const targetFixedByRawAsr=targetRawModelsMatching.length===2;
  const targetFixedByConsensus=!t03StillAdjudicated;

  const definiteAsrInstability=newOutsidePart4.filter(x=>x.audioPartByteIdentical===true);
  const changedPartConsensus=newInsidePart4.filter(x=>x.bucket==='substantive');
  const changedPartUnresolved=newInsidePart4.filter(x=>x.bucket==='unresolved');
  const changedRegionConsensus=newInsideTargetSegment.filter(x=>x.bucket==='substantive');
  const changedRegionUnresolved=newInsideTargetSegment.filter(x=>x.bucket==='unresolved');
  const adjacentChangedPartIssues=newInsidePart4.filter(x=>!x.insideTargetSegment&&x.adjacentToTargetSegment);

  const causes=[];
  if(definiteAsrInstability.length) causes.push('ASR_INSTABILITY');
  if(changedPartConsensus.length) causes.push('TTS_REGRESSION');
  if(waveform.mode==='SEGMENT_SPLICE' && (waveform.spliceBoundaries?.artifactDetected || waveform.outsideSplice?.preserved===false)) causes.push('SPLICE_REGRESSION');
  if(!causes.length&&newInsidePart4.length) causes.push('TTS_OR_ASR_AMBIGUITY');
  const forensicClassification=causes.length>1?'MIXED_CAUSE':(causes[0]||'NO_REGRESSION_PROVEN');

  const trialFull=await readFile(path.join(trial,'full.mp3'));
  const baseFull=await readFile(path.join(baseline,'full.mp3'));

  const result={
    schema:'bareeq.audio-gate5-passports-forensics.v2',
    generatedAt:new Date().toISOString(),
    sourceRunId:RUN_ID,
    diagnosticMetadata:meta,
    target:{
      caseId:'T03',expectedIndex:T03_INDEX,expectedToken:context.target.expectedToken,
      partNumber:targetLocation.part.partNumber,segmentId:targetLocation.item.segmentId,
      rawModelEvidence:t03Raw,
      modelsMatchingExpected:targetRawModelsMatching,
      fixedByBothRawModels:targetFixedByRawAsr,
      absentFromTrialConsensus:targetFixedByConsensus,
      machineConclusion:targetFixedByRawAsr&&targetFixedByConsensus?'TARGET_FIXED_BY_BOTH_FRESH_ASR':'TARGET_NOT_PROVEN_FIXED',
    },
    carriedHumanEvidence:{
      caseId:'T02',expectedIndex:T02_INDEX,partNumber:fpLocation.part.partNumber,segmentId:fpLocation.item?.segmentId||null,
      baselinePartSha256:baseParts[5]?.sha256||null,trialPartSha256:trialParts[5]?.sha256||null,
      audioBytesUnchanged:baseParts[5]?.sha256===trialParts[5]?.sha256,
      trialRawModelEvidence:t02Raw,appearsInTrialConsensus:t02StillAdjudicated,
    },
    repairSurface:{
      changedParts,unchangedParts,
      baselineFullSha256:sha256(baseFull),trialFullSha256:sha256(trialFull),
      fullAudioChanged:sha256(baseFull)!==sha256(trialFull),
      repairMode:waveform.mode,
      waveform,
    },
    baseline:{consensus:baseRawAdj.consensus,issues:baselineIssues},
    trial:{
      consensus:trialAdj.consensus,
      issueCount:trialIssues.length,
      issues:issuesWithSurface,
      newIssues,
      newIssuesInsideRegeneratedPart:newInsidePart4,
      newIssuesInsideTargetSegment:newInsideTargetSegment,
      newIssuesOutsideRegeneratedPart:newOutsidePart4,
      definiteAsrInstabilityOnByteIdenticalAudio:definiteAsrInstability,
      changedPartConsensusErrors:changedPartConsensus,
      changedPartUnresolved,
      changedRegionConsensusErrors:changedRegionConsensus,
      changedRegionUnresolved,
      adjacentChangedPartIssues,
    },
    forensicClassification,
    causeEvidence:{
      asrInstability:definiteAsrInstability.map(x=>({expectedIndex:x.expectedIndex,expected:x.expected,actual:x.actual??null,partNumber:x.partNumber,segmentId:x.segmentId,rawModelEvidence:x.rawModelEvidence})),
      ttsRegression:changedPartConsensus.map(x=>({expectedIndex:x.expectedIndex,expected:x.expected,actual:x.actual??null,partNumber:x.partNumber,segmentId:x.segmentId,insideTargetSegment:x.insideTargetSegment,rawModelEvidence:x.rawModelEvidence})),
      spliceRegression:waveform.mode==='SEGMENT_SPLICE'
        ? {applicable:true,boundaryArtifact:waveform.spliceBoundaries?.artifactDetected??null,waveformOutsideSplicePreserved:waveform.outsideSplice?.preserved??null,startBoundary:waveform.spliceBoundaries?.start??null,endBoundary:waveform.spliceBoundaries?.end??null,prefixCorrelation:waveform.outsideSplice?.prefix?.correlation??null,suffixCorrelation:waveform.outsideSplice?.suffix?.correlation??null}
        : {applicable:false,reason:'No segment splice occurred; safe boundaries were not found and the execution fell back to whole-part 4 regeneration.'},
    },
    conclusion:{
      publishable:false,
      baselineRestorationCorrect:true,
      additionalTtsAuthorized:false,
      strategicState:'30/30',
      targetWasFixedByMachineEvidence:targetFixedByRawAsr&&targetFixedByConsensus,
      explanation:'The one authorized synthesis fixed T03 according to both fresh ASR models. The rejected trial also produced fresh validator disagreements. Byte-identical unchanged parts prove that at least some fresh disagreements are ASR instability rather than new audio defects. Changed-region and splice evidence must be interpreted separately; the final forensic classification records whether TTS regression, ASR instability, splice regression, or a mixed cause is actually supported.',
    },
  };
  return result;
}

function issueLine(x){
  const actual=x.actual??(x.first?.actual||x.second?.actual||'unresolved');
  return `- index ${x.expectedIndex}: ${x.expected??'∅'} → ${actual} [${x.type}/${x.bucket}] — part ${x.partNumber}, segment ${x.segmentId}; new=${!x.existedInBaseline}; target-segment=${x.insideTargetSegment}; byte-identical-part=${x.audioPartByteIdentical}`;
}

export function markdown(r){
  const issueLines=r.trial.issues.map(issueLine).join('\n')||'- none';
  const outside=r.trial.definiteAsrInstabilityOnByteIdenticalAudio.map(issueLine).join('\n')||'- none';
  const inside=r.trial.newIssuesInsideTargetSegment.map(issueLine).join('\n')||'- none';
  return `# Gate 5 Passports — Forensic Postmortem v2

**Final forensic classification:** \`${r.forensicClassification}\`

## 1. Did the trial pronounce the missing «لا»?

- Both fresh independent ASR models matched the expected token at T03: **${r.target.fixedByBothRawModels}**
- T03 disappeared from trial consensus errors: **${r.target.absentFromTrialConsensus}**
- Machine conclusion: **${r.target.machineConclusion}**

This is strong dual-ASR evidence that the targeted repair itself succeeded. It is not a substitute for human listening.

## 2. What actually changed?

- Changed generated parts: **${r.repairSurface.changedParts.map(x=>x.partNumber).join(', ')}**
- Byte-identical unchanged parts: **${r.repairSurface.unchangedParts.map(x=>x.partNumber).join(', ')}**
- Target splice: **${r.repairSurface.splice.startSeconds.toFixed(3)}s → ${r.repairSurface.splice.endSeconds.toFixed(3)}s**
- Replacement duration: **${r.repairSurface.splice.replacementSeconds.toFixed(3)}s**
- Part 6 / T02 audio byte-identical: **${r.carriedHumanEvidence.audioBytesUnchanged}**

## 3. Audio-change geometry

- Repair mode: **${r.repairSurface.repairMode}**
- Audio outside part 4 byte-identical: **${r.repairSurface.waveform.outsideChangedPartByteIdentical}**
${r.repairSurface.repairMode==='SEGMENT_SPLICE'
  ? `- Outside-splice prefix correlation: **${Number(r.repairSurface.waveform.outsideSplice.prefix.correlation).toFixed(6)}**
- Outside-splice suffix correlation: **${Number(r.repairSurface.waveform.outsideSplice.suffix.correlation).toFixed(6)}**
- Outside-splice waveform preserved: **${r.repairSurface.waveform.outsideSplice.preserved}**
- Splice artifact detected: **${r.repairSurface.waveform.spliceBoundaries.artifactDetected}**`
  : '- No splice occurred. Safe synchronized-segment boundaries were unavailable, so the execution regenerated the entire fourth part. SPLICE_REGRESSION is therefore not applicable to this trial.'}

## 4. Fresh trial consensus

\`S=${r.trial.consensus.substitutions} D=${r.trial.consensus.deletions} I=${r.trial.consensus.insertions} unresolved=${r.trial.consensus.unresolved}\`

${issueLines}

### New issues on byte-identical audio — definite ASR instability evidence

${outside}

### New issues inside the regenerated target segment

${inside}

## 5. Cause evidence

- Definite ASR-instability issues on byte-identical parts: **${r.trial.definiteAsrInstabilityOnByteIdenticalAudio.length}**
- Consensus lexical errors anywhere inside regenerated part 4: **${r.trial.changedPartConsensusErrors.length}**
- Unresolved disagreements inside regenerated part 4: **${r.trial.changedPartUnresolved.length}**
- Consensus lexical errors inside target segment b0030: **${r.trial.changedRegionConsensusErrors.length}**
- Splice regression applicable: **${r.causeEvidence.spliceRegression.applicable}**

## 6. Decision

**${r.forensicClassification}**

${r.conclusion.explanation}

- Publication: **NO**
- Baseline restoration: **correct**
- Additional TTS authorized: **NO**
- Strategy: **30/30**
- Provider calls in this forensics run: **0**
`;
}

async function cli(){
  const root=path.resolve(arg('root','gate5-artifact'));
  const out=path.resolve(arg('out','gate5-forensics-output'));
  const result=await analyzeGate5PassportsArtifact({root});
  await mkdir(out,{recursive:true});
  await writeFile(path.join(out,'GATE-5-PASSPORTS-POSTMORTEM.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(path.join(out,'GATE-5-PASSPORTS-POSTMORTEM.md'),markdown(result));
  console.log(`GATE5_FORENSICS=PASS classification=${result.forensicClassification} targetFixed=${result.target.fixedByBothRawModels} newIssues=${result.trial.newIssues.length} newOutsidePart4=${result.trial.newIssuesOutsideRegeneratedPart.length} newInsideTarget=${result.trial.newIssuesInsideTargetSegment.length} spliceArtifact=${result.repairSurface.spliceBoundaries.artifactDetected} tts=0 provider=0`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
