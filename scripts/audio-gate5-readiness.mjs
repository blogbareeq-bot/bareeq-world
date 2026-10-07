import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED='اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع';
const PROMOTED=new Set([
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
]);

function arg(name,fallback){
  const p=`--${name}=`;
  return process.argv.find(x=>x.startsWith(p))?.slice(p.length)||fallback;
}
async function json(file){ return JSON.parse(await readFile(file,'utf8')); }

function riskForCase(mapping){
  const expected=String(mapping.expectedToken||mapping.hidden?.expected||'');
  const actual=String(mapping.hidden?.actual||'');
  const type=String(mapping.issueType||mapping.hidden?.automatedType||'');
  if(type==='deletion' && expected==='لا') return {rank:1,label:'clear-single-token-negation-deletion'};
  if(/[0-9٠-٩]/u.test(expected) || /إحدى|احدى|عشر|اثنا|إثنا/u.test(expected+' '+actual)) return {rank:3,label:'numeric-normalization-risk'};
  if((expected==='قوى' && actual==='قوة') || (expected==='قوة' && actual==='قوى')) return {rank:4,label:'close-phonetic-morphology-risk'};
  if(type==='deletion') return {rank:2,label:'single-token-deletion'};
  if(type==='substitution') return {rank:2,label:'single-token-substitution'};
  return {rank:3,label:'other'};
}

export function rankGate5Candidates({status,triage,internal}){
  if(status.exactCount!==9 || status.publishedCount!==9 || status.fallbackCount!==6) throw new Error('Gate5 readiness requires canonical 9 Exact / 6 fallback');
  if(internal.packageId!==triage.packageId) throw new Error('triage/internal package mismatch');
  const actual=new Set(triage.confirmedTargetAudioErrors||[]);
  if(actual.size!==11) throw new Error(`expected 11 confirmed target audio errors, got ${actual.size}`);
  const activeIds=new Set((status.rows||[])
    .filter(r=>!r.exact && r.articleId!==EXCLUDED && !PROMOTED.has(r.articleId))
    .map(r=>r.articleId));
  if(activeIds.size!==5) throw new Error(`expected five active defective articles, got ${activeIds.size}`);

  const clusterByCase=new Map();
  for(const cluster of triage.defectClusters||[]) for(const id of cluster.cases||[]) clusterByCase.set(id,cluster.id);

  const byArticle=new Map();
  for(const caseId of actual){
    const m=internal.mapping?.[caseId];
    if(!m||m.kind!=='pending') throw new Error(`${caseId}: missing pending mapping`);
    if(!activeIds.has(m.articleId)) continue;
    const risk=riskForCase(m);
    const row=byArticle.get(m.articleId)||{
      articleId:m.articleId,title:m.title,cases:[],clusters:new Set(),segments:new Set(),parts:new Set(),maxRisk:0,riskLabels:new Set(),
    };
    row.cases.push({
      caseId,
      expectedIndex:Number(m.expectedIndex),
      expectedToken:m.expectedToken||m.hidden?.expected||null,
      observed:m.hidden?.actual||null,
      issueType:m.issueType||m.hidden?.automatedType||null,
      partIndex:Number(m.partIndex),
      segmentId:m.segmentId,
      fingerprint:m.fingerprint,
      fullSha256:m.fullSha256,
      risk:risk.label,
    });
    row.clusters.add(clusterByCase.get(caseId)||caseId);
    row.segments.add(m.segmentId);
    row.parts.add(Number(m.partIndex));
    row.maxRisk=Math.max(row.maxRisk,risk.rank);
    row.riskLabels.add(risk.label);
    byArticle.set(m.articleId,row);
  }

  const rows=[...byArticle.values()].map(r=>({
    articleId:r.articleId,title:r.title,
    confirmedErrorCases:r.cases.length,
    distinctClusters:r.clusters.size,
    distinctSegments:r.segments.size,
    distinctParts:r.parts.size,
    maxRisk:r.maxRisk,
    riskLabels:[...r.riskLabels],
    cases:r.cases.sort((a,b)=>a.expectedIndex-b.expectedIndex),
  }));
  if(rows.length!==5) throw new Error(`expected five ranked articles, found ${rows.length}`);
  rows.sort((a,b)=>
    a.distinctClusters-b.distinctClusters ||
    a.distinctSegments-b.distinctSegments ||
    a.distinctParts-b.distinctParts ||
    a.confirmedErrorCases-b.confirmedErrorCases ||
    a.maxRisk-b.maxRisk ||
    a.title.localeCompare(b.title,'ar')
  );
  rows.forEach((r,i)=>r.rank=i+1);

  const recommended=rows[0];
  if(recommended.articleId!=='why-some-passports-are-stronger') {
    throw new Error(`selection policy expected passports as safest candidate, got ${recommended.articleId}`);
  }
  return {
    schema:'bareeq.audio-gate5-readiness-ranking.v1',
    generatedAt:new Date().toISOString(),
    exactState:'9/15',
    fallbacks:6,
    activeDefectiveArticles:5,
    excluded:EXCLUDED,
    strategy:'29/30',
    ttsCalls:0,newAsrCalls:0,providerCalls:0,
    rankingPolicy:[
      'fewest confirmed defect clusters',
      'fewest distinct synchronized segments',
      'fewest distinct generated parts',
      'fewest confirmed error cases',
      'lowest repair-risk heuristic: clear negation deletion < ordinary lexical error < numeric normalization < close phonetic morphology'
    ],
    recommended:{
      articleId:recommended.articleId,
      title:recommended.title,
      reason:'One corroborated missing token (لا), one cluster, one synchronized segment, one part, and a clear lexical success criterion.',
      successfulTtsRequestsRequired:1,
      authorizationStatus:'NOT_AUTHORIZED',
    },
    rows,
  };
}

export function markdown(r){
  const lines=r.rows.map(x=>{
    const detail=x.cases.map(c=>`${c.caseId}: ${c.expectedToken||'∅'}→${c.observed||'∅'} [${c.issueType}] part=${c.partIndex+1} segment=${c.segmentId}`).join('; ');
    return `${x.rank}. **${x.title}** — clusters=${x.distinctClusters}, segments=${x.distinctSegments}, parts=${x.distinctParts}, confirmed-errors=${x.confirmedErrorCases}, risk=${x.riskLabels.join(', ')}\n   - ${detail}`;
  }).join('\n');
  return `# Gate 5 readiness ranking — 9/15

- Current Exact: **9/15**
- Active defective articles: **5**
- TTS strategy: **29/30**
- TTS calls in this analysis: **0**
- Recommended first experiment: **${r.recommended.title}**
- Required successful TTS requests: **1**
- Authorization: **NOT AUTHORIZED**

## Ranking

${lines}

## Recommendation

Prepare one isolated micro-repair experiment for \`${r.recommended.articleId}\` targeting the confirmed missing token **لا**. Do not call TTS until the project owner explicitly authorizes **1 successful TTS request**. A successful provider synthesis counts as request 30/30 even if the candidate is rejected.

The immutable baseline and live fallback must remain untouched until the candidate independently reaches 0/0/0/0 and all technical/sync/SHA gates pass.
`;
}

async function cli(){
  const triageRoot=path.resolve(arg('triage-root','triage-input'));
  const out=path.resolve(arg('out','gate5-readiness-output'));
  const status=await json(path.resolve('docs/audio/PROGRESSIVE-STATUS.json'));
  const triage=await json(path.resolve('docs/audio/HUMAN-TRIAGE-FULL-RESULT-20261006.json'));
  const internal=await json(path.join(triageRoot,'internal-evidence.json'));
  const result=rankGate5Candidates({status,triage,internal});
  await mkdir(out,{recursive:true});
  await writeFile(path.join(out,'GATE5-READINESS.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(path.join(out,'GATE5-READINESS.md'),markdown(result));
  console.log(`GATE5_READINESS=PASS recommended=${result.recommended.articleId} requests=1 authorized=false tts=0 asr=0 provider=0`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
