import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './audio-constants.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';

const ARTICLE='why-some-passports-are-stronger';
const CASE='T03';
const EXPECTED_TOKEN='لا';

function arg(name,fallback){
  const p=`--${name}=`;
  return process.argv.find(x=>x.startsWith(p))?.slice(p.length)||fallback;
}
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }
function itemId(item){ return item?.runtimeId||item?.segmentId||null; }

export async function gate5PassportsPreflight({artifactRoot,triageRoot,repoRoot=process.cwd()}){
  const status=await json(path.join(repoRoot,'docs','audio','PROGRESSIVE-STATUS.json'));
  const row=(status.rows||[]).find(x=>x.articleId===ARTICLE);
  if(!row) throw new Error('passports status row missing');
  if(row.exact===true || row.publishedExact===true) throw new Error('passports is already Exact; Gate5 experiment is unnecessary');
  const triage=await json(path.join(repoRoot,'docs','audio','HUMAN-TRIAGE-FULL-RESULT-20261006.json'));
  if(!(triage.confirmedTargetAudioErrors||[]).includes(CASE)) throw new Error('T03 is not a binding confirmed audio error');
  const internal=await json(path.join(triageRoot,'internal-evidence.json'));
  const m=internal.mapping?.[CASE];
  if(!m||m.articleId!==ARTICLE||m.kind!=='pending') throw new Error('T03 mapping is missing or points to another article');
  if(m.fingerprint!==row.fingerprint||m.fullSha256!==row.fullSha256) throw new Error('T03 identity does not match current passports candidate');
  if((m.expectedToken||m.hidden?.expected)!==EXPECTED_TOKEN) throw new Error('T03 no longer targets لا');
  if(Number(m.partIndex)!==3||m.segmentId!=='b0030') throw new Error(`unexpected T03 location part=${Number(m.partIndex)+1} segment=${m.segmentId}`);

  const dir=path.join(artifactRoot,'audio-candidates',ARTICLE,row.fingerprint);
  const [manifest,checkpoint,technical,sync,baseAdj]=await Promise.all([
    json(path.join(dir,'manifest.candidate.json')),
    json(path.join(dir,'checkpoint.json')),
    json(path.join(dir,'reports','technical-qa.json')),
    json(path.join(dir,'reports','sync.json')),
    json(path.join(dir,'reports','asr-adjudication.json')),
  ]);
  const full=await readFile(path.join(dir,'full.mp3'));
  if(sha256(full)!==row.fullSha256) throw new Error('baseline full.mp3 SHA mismatch');
  if((manifest.candidateFingerprint||manifest.fingerprint)!==row.fingerprint) throw new Error('candidate manifest fingerprint mismatch');
  if(!(technical.passed===true||technical.status==='passed')) throw new Error('baseline Technical QA is not passed');
  if(!(sync.passed===true||sync.status==='passed')) throw new Error('baseline sync QA is not passed');
  if((baseAdj.candidateFingerprint||baseAdj.fingerprint)!==row.fingerprint||baseAdj.fullSha256!==row.fullSha256) throw new Error('baseline adjudication identity mismatch');

  const article=await loadSpokenArticle(ARTICLE,repoRoot);
  const segmentItems=(article.items||[]).filter(x=>itemId(x)==='b0030');
  if(!segmentItems.length) throw new Error('b0030 missing from current spoken article');
  const segmentText=segmentItems.map(x=>x.text).join(' ').replace(/\s+/g,' ').trim();
  const segmentTokens=tokenizeVerbal(segmentText);
  if(!segmentTokens.includes(EXPECTED_TOKEN)) throw new Error('b0030 does not contain expected token لا');

  const part=manifest.parts?.[3];
  if(!part) throw new Error('candidate manifest part 4 missing');
  const syncEntry=(part.sync||[]).find(x=>x.id==='b0030');
  if(!syncEntry) throw new Error('part 4 has no b0030 sync entry');
  const record=checkpoint.completedParts?.['3'];
  if(!record?.file||!record?.sha256) throw new Error('checkpoint part 4 record missing');
  const partFile=path.join(dir,'parts',record.file);
  const partBytes=await readFile(partFile);
  if(sha256(partBytes)!==record.sha256) throw new Error('baseline part 4 SHA mismatch');

  const result={
    schema:'bareeq.audio-gate5-passports-preflight.v1',
    generatedAt:new Date().toISOString(),
    articleId:ARTICLE,
    title:row.title,
    caseId:CASE,
    target:{
      expectedToken:EXPECTED_TOKEN,
      observed:m.hidden?.actual??null,
      issueType:m.issueType||m.hidden?.automatedType||null,
      expectedIndex:Number(m.expectedIndex),
      partIndexZeroBased:3,
      partNumber:4,
      segmentId:'b0030',
      segmentText,
      segmentTokenCount:segmentTokens.length,
      syncStart:Number(syncEntry.start),
      syncEnd:Number(syncEntry.end),
    },
    baseline:{
      fingerprint:row.fingerprint,
      fullSha256:row.fullSha256,
      partFile:record.file,
      partSha256:record.sha256,
      technicalQaPassed:true,
      syncQaPassed:true,
      dualAsrModels:baseAdj.models,
    },
    experiment:{
      successfulTtsRequestsAuthorized:0,
      successfulTtsRequestsRequired:1,
      maximumSuccessfulTtsRequests:1,
      scope:'one isolated synchronized micro-repair inside part 4 / b0030 only',
      hypothesis:'Regenerating only the synchronized sentence/segment containing the missing negation لا can restore that token without changing the rest of the immutable baseline.',
      newInformationIfRejected:'Whether Sadaltager can preserve the required negation in this exact localized context under a single bounded regeneration; the rejected candidate is retained and does not replace fallback.',
      correctionHint:'Read only the approved transcript. Clearly pronounce and preserve the word «لا». Do not omit it, paraphrase it, or change surrounding words.',
      successCriteria:[
        'successful synthesis count <= 1',
        'candidate isolated from public/audio until certified',
        'target لا is present in the regenerated speech',
        'fresh production Dual-ASR reaches 0 substitutions / 0 deletions / 0 insertions / 0 unresolved',
        'Technical QA passes',
        'sync QA passes',
        'fingerprint/full SHA/part SHA evidence is bound',
      ],
      failureCriteria:[
        'provider returns a successful synthesis but exact gate is non-zero',
        'splice boundary is unsafe or corrupt',
        'new lexical error appears',
        'technical/sync/identity gate fails',
      ],
      rollback:'Keep immutable baseline and current live fallback. Never overwrite public/audio on failure.',
      artifactRetention:'Retain replacement audio, trial candidate, baseline copy, comparison reports, and rejection reason even when the trial fails.',
      authorizationStatus:'NOT_AUTHORIZED',
    },
    ttsCalls:0,newAsrCalls:0,providerCalls:0,
  };
  return result;
}

export function markdown(r){
 return `# Gate 5 experiment preflight — Passports

**Status: PREPARED / NOT AUTHORIZED**

- Article: **${r.title}**
- Human case: **${r.caseId}**
- Target: **${r.target.expectedToken}** (confirmed missing)
- Part: **${r.target.partNumber}**
- Segment: **${r.target.segmentId}**
- Baseline fingerprint: \`${r.baseline.fingerprint}\`
- Baseline full SHA-256: \`${r.baseline.fullSha256}\`
- Baseline part SHA-256: \`${r.baseline.partSha256}\`
- Required successful TTS requests: **1**
- Currently authorized: **0**

## Exact segment

> ${r.target.segmentText}

## Experiment

${r.experiment.hypothesis}

Correction hint:

> ${r.experiment.correctionHint}

Even if the generated candidate fails, the experiment records whether Sadaltager can preserve the confirmed missing negation in this exact localized context. A successful synthesis counts as request **30/30** whether accepted or rejected.

## Safety

The current fallback and baseline stay immutable. Publication is prohibited unless the changed candidate passes fresh Dual-ASR 0/0/0/0, Technical QA, sync QA, fingerprint and SHA binding.

**No TTS, ASR, or provider call occurred during this preflight.**
`;
}

async function cli(){
 const artifactRoot=path.resolve(arg('root','evidence-input'));
 const triageRoot=path.resolve(arg('triage-root','triage-input'));
 const out=path.resolve(arg('out','gate5-passports-preflight'));
 const r=await gate5PassportsPreflight({artifactRoot,triageRoot});
 await mkdir(out,{recursive:true});
 await writeFile(path.join(out,'GATE5-PASSPORTS-PREFLIGHT.json'),JSON.stringify(r,null,2)+'\n');
 await writeFile(path.join(out,'GATE5-PASSPORTS-PREFLIGHT.md'),markdown(r));
 console.log(`GATE5_PASSPORTS_PREFLIGHT=PASS case=${r.caseId} part=${r.target.partNumber} segment=${r.target.segmentId} authorized=0 tts=0 asr=0 provider=0`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
