import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './audio-constants.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';
import { loadSpokenArticle } from './audio-split.mjs';

const EXCLUDED = new Set(['اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع']);
const DECISIONS = Object.freeze([
  'EXPECTED_PRONUNCIATION_CONFIRMED',
  'ACTUAL_AUDIO_ERROR',
  'REPRESENTATION_EQUIVALENT',
  'INCONCLUSIVE',
]);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
function itemId(item) { return item.runtimeId || item.segmentId || null; }
function words(text) { return tokenizeVerbal(text).filter(Boolean); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export function blindSortKey(seed) {
  return sha256(`bareeq-human-triage-v1|${seed}`);
}

export function assertBlindManifest(manifest) {
  const forbidden = /(?:classification|asr|validator|confirmedBy|actual|automationEvidence|control|exact)/i;
  for (const row of manifest.cases || []) {
    for (const key of Object.keys(row)) {
      if (forbidden.test(key)) throw new Error(`reviewer manifest leaks hidden evidence key: ${key}`);
    }
    const blob = JSON.stringify(row);
    if (/AUDIO_ERROR_CANDIDATE|VALIDATOR_AMBIGUITY|substantiveDifferences|modelDisagreements/.test(blob)) {
      throw new Error(`reviewer manifest leaks automated verdict in ${row.caseId}`);
    }
  }
  return true;
}

function articleSegments(article) {
  const globalTokens = words(article.spokenText);
  const segments = [];
  let cursor = 0;
  let current = null;
  for (const item of article.items || []) {
    const tokens = words(item.text);
    const start = cursor;
    const end = cursor + tokens.length;
    cursor = end;
    const id = itemId(item);
    if (!id || item.type === 'title' || !tokens.length) continue;
    if (current?.id === id && current.end === start) {
      current.end = end;
      current.tokens.push(...tokens);
      current.items.push(item);
      continue;
    }
    current = { id, start, end, tokens:[...tokens], items:[item] };
    segments.push(current);
  }
  if (cursor !== globalTokens.length) {
    throw new Error(`${article.articleId}: token accounting mismatch items=${cursor} article=${globalTokens.length}`);
  }
  return { globalTokens, segments };
}

function selectSegment(segments, expectedIndex, type) {
  if (!Number.isInteger(expectedIndex) || expectedIndex < 0) throw new Error(`invalid expectedIndex ${expectedIndex}`);
  let segment = segments.find((seg) => expectedIndex >= seg.start && expectedIndex < seg.end);
  if (!segment && type === 'insertion') {
    segment = segments.find((seg) => expectedIndex === seg.start)
      || [...segments].reverse().find((seg) => expectedIndex === seg.end)
      || segments.find((seg) => expectedIndex < seg.end);
  }
  if (!segment) {
    segment = [...segments].reverse().find((seg) => expectedIndex >= seg.start) || segments[0];
  }
  if (!segment) throw new Error(`could not map expectedIndex ${expectedIndex} to a synchronized segment`);
  return segment;
}

function contextFor(globalTokens, expectedIndex, type, radius = 7) {
  const index = clamp(expectedIndex, 0, globalTokens.length);
  const start = Math.max(0, index - radius);
  const end = Math.min(globalTokens.length, index + radius + (type === 'insertion' ? 0 : 1));
  const slice = globalTokens.slice(start, end);
  const relative = index - start;
  if (type === 'insertion') {
    slice.splice(relative, 0, '⟦|⟧');
  } else if (slice[relative] != null) {
    slice[relative] = `⟦${slice[relative]}⟧`;
  }
  return slice.join(' ');
}

function locateSync(manifest, segmentId) {
  for (const part of manifest.parts || []) {
    const sync = (part.sync || []).find((entry) => entry.id === segmentId);
    if (sync) return { partIndex:Number(part.partIndex), sync };
  }
  throw new Error(`candidate manifest has no sync entry for ${segmentId}`);
}

function partPath(candidateDir, checkpoint, partIndex) {
  const record = checkpoint?.completedParts?.[String(partIndex)];
  if (!record?.file) throw new Error(`missing checkpoint part file for part ${partIndex}`);
  return path.join(candidateDir, 'parts', record.file);
}

function ffprobeDuration(file, ffprobe) {
  const result = spawnSync(ffprobe, [
    '-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file,
  ], { encoding:'utf8' });
  if (result.status !== 0) throw new Error(`ffprobe failed for ${file}: ${result.stderr || result.stdout}`);
  const duration = Number(String(result.stdout).trim());
  if (!(duration > 0)) throw new Error(`invalid duration for ${file}`);
  return duration;
}

function renderClip({ source, output, start, end, ffmpeg }) {
  const duration = Math.max(0.5, end - start);
  const result = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error','-y',
    '-ss',start.toFixed(3),'-i',source,
    '-t',duration.toFixed(3),
    '-vn','-ac','1','-ar','24000','-codec:a','libmp3lame','-q:a','4',
    output,
  ], { encoding:'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${source}: ${result.stderr || result.stdout}`);
}

async function loadCandidate(row, artifactRoot, repoRoot) {
  const article = await loadSpokenArticle(row.articleId, repoRoot);
  const tokenMap = articleSegments(article);
  const candidateDir = path.join(artifactRoot,'audio-candidates',row.articleId,row.fingerprint);
  const [manifest, checkpoint, adjudication] = await Promise.all([
    json(path.join(candidateDir,'manifest.candidate.json')),
    json(path.join(candidateDir,'checkpoint.json')),
    json(path.join(candidateDir,'reports','asr-adjudication.json')),
  ]);
  if ((manifest.candidateFingerprint || manifest.fingerprint) !== row.fingerprint) throw new Error(`${row.articleId}: candidate manifest fingerprint mismatch`);
  if ((adjudication.candidateFingerprint || adjudication.fingerprint) !== row.fingerprint) throw new Error(`${row.articleId}: adjudication fingerprint mismatch`);
  if (adjudication.fullSha256 !== row.fullSha256) throw new Error(`${row.articleId}: adjudication SHA mismatch`);
  return { row, article, tokenMap, candidateDir, manifest, checkpoint, adjudication };
}

function pendingIssues(candidate) {
  return [
    ...(candidate.adjudication.substantiveDifferences || []).map((item) => ({ source:'substantive', ...item })),
    ...(candidate.adjudication.unresolved || []).map((item) => ({ source:'unresolved', type:item.type || 'unresolved', ...item })),
  ].sort((a,b)=>Number(a.expectedIndex)-Number(b.expectedIndex) || String(a.type).localeCompare(String(b.type)));
}

function chooseExactControl(candidate) {
  const eligible = candidate.tokenMap.segments.filter((seg) => seg.tokens.length >= 5);
  if (!eligible.length) throw new Error(`${candidate.row.articleId}: no eligible exact control segment`);
  const articleMiddle = candidate.tokenMap.globalTokens.length / 2;
  eligible.sort((a,b)=>Math.abs((a.start+a.end)/2-articleMiddle)-Math.abs((b.start+b.end)/2-articleMiddle));
  const segment = eligible[0];
  const expectedIndex = segment.start + Math.floor(segment.tokens.length / 2);
  return { type:'control', expectedIndex, expected:candidate.tokenMap.globalTokens[expectedIndex], source:'exact-control' };
}

function hiddenEvidence(issue, candidate) {
  return {
    source:issue.source,
    automatedType:issue.type || 'unresolved',
    expectedIndex:Number(issue.expectedIndex),
    expected:issue.expected ?? null,
    actual:issue.actual ?? null,
    reason:issue.reason ?? null,
    confirmedBy:issue.confirmedBy ?? null,
    first:issue.first ?? null,
    second:issue.second ?? null,
    models:candidate.adjudication.models,
  };
}

async function makeCase({ rawId, candidate, issue, kind, clipsDir, ffmpeg, ffprobe }) {
  const expectedIndex = Number(issue.expectedIndex);
  const type = issue.type || (kind === 'control' ? 'control' : 'unresolved');
  const segment = selectSegment(candidate.tokenMap.segments, expectedIndex, type);
  const { partIndex, sync } = locateSync(candidate.manifest, segment.id);
  const source = partPath(candidate.candidateDir, candidate.checkpoint, partIndex);
  const duration = ffprobeDuration(source, ffprobe);

  const insertion = type === 'insertion';
  const relative = clamp(expectedIndex - segment.start, 0, Math.max(0, segment.tokens.length - (insertion ? 0 : 1)));
  const fraction = insertion
    ? clamp(relative / Math.max(1, segment.tokens.length), 0, 1)
    : clamp((relative + 0.5) / Math.max(1, segment.tokens.length), 0, 1);
  const syncPosition = Number(sync.start) + (Number(sync.end) - Number(sync.start)) * fraction;
  const targetSeconds = duration * syncPosition;
  const start = Math.max(0, targetSeconds - 7);
  const end = Math.min(duration, targetSeconds + 7);
  const clipName = `${rawId}.mp3`;
  const clipPath = path.join(clipsDir, clipName);
  renderClip({ source, output:clipPath, start, end, ffmpeg });

  const expectedToken = insertion ? null : (candidate.tokenMap.globalTokens[expectedIndex] ?? issue.expected ?? null);
  return {
    rawId,
    kind,
    articleId:candidate.row.articleId,
    title:candidate.row.title,
    fingerprint:candidate.row.fingerprint,
    fullSha256:candidate.row.fullSha256,
    partIndex,
    segmentId:segment.id,
    clipFile:`clips/${clipName}`,
    clipStartSeconds:Number(start.toFixed(3)),
    clipEndSeconds:Number(end.toFixed(3)),
    approximateTargetSecondsInClip:Number((targetSeconds-start).toFixed(3)),
    expectedIndex,
    expectedToken,
    expectedContext:contextFor(candidate.tokenMap.globalTokens, expectedIndex, type),
    issueType:type,
    hidden: kind === 'pending' ? hiddenEvidence(issue,candidate) : { source:'exact-control' },
  };
}

function reviewerHtml(manifest) {
  const data = JSON.stringify(manifest).replaceAll('<','\\u003c');
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>بريق — Human Triage</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;max-width:980px;margin:auto;padding:24px;background:#f7f7f8;color:#171717}
header,.case{background:#fff;border:1px solid #ddd;border-radius:14px;padding:18px;margin:0 0 16px}
.case.done{border-color:#7a9}
.meta{color:#666;font-size:.92rem}.context{font-size:1.08rem;line-height:2;background:#f5f5f5;padding:12px;border-radius:9px}
audio{width:100%;margin:10px 0}select,textarea{width:100%;font:inherit;padding:9px;margin-top:8px;box-sizing:border-box}
textarea{min-height:72px}button{font:inherit;padding:10px 16px;margin:6px;border-radius:9px;border:1px solid #bbb;cursor:pointer}
.progress{font-weight:700}code{direction:ltr;display:inline-block}
</style>
</head>
<body>
<header>
<h1>حزمة التدقيق البشري — بريق</h1>
<p>راجع الصوت مقارنة بالنص المتوقع فقط. لا تحاول تخمين نتيجة المدقق الآلي؛ فهي مخفية عمدًا.</p>
<p><strong>القرارات:</strong> النطق المتوقع مؤكد / خطأ صوتي فعلي / تمثيل مكافئ / غير محسوم.</p>
<p class="progress" id="progress"></p>
<button id="export">تصدير النتائج JSON</button>
</header>
<div id="cases"></div>
<script>
const manifest=${data};
const KEY='bareeq-human-triage:'+manifest.packageId;
const saved=JSON.parse(localStorage.getItem(KEY)||'{}');
const labels={
EXPECTED_PRONUNCIATION_CONFIRMED:'النطق المتوقع مؤكد',
ACTUAL_AUDIO_ERROR:'خطأ صوتي فعلي',
REPRESENTATION_EQUIVALENT:'تمثيل مكافئ',
INCONCLUSIVE:'غير محسوم'
};
function persist(){localStorage.setItem(KEY,JSON.stringify(saved));renderProgress()}
function renderProgress(){
 const n=manifest.cases.filter(c=>saved[c.caseId]?.decision).length;
 document.getElementById('progress').textContent='المنجز: '+n+' / '+manifest.cases.length;
}
const root=document.getElementById('cases');
for(const c of manifest.cases){
 const box=document.createElement('section'); box.className='case'; box.dataset.id=c.caseId;
 box.innerHTML='<h2>'+c.caseId+' — '+c.title+'</h2>'+
   '<div class="meta">المقال '+c.articleOrdinal+' / الحالة '+c.caseOrdinalInArticle+'</div>'+
   '<p class="context"><strong>النص المتوقع:</strong> '+c.expectedContext+'</p>'+
   '<audio controls preload="none" src="'+c.clipFile+'"></audio>'+
   '<label>قرار المراجع<select><option value="">— اختر —</option>'+
   manifest.allowedDecisions.map(v=>'<option value="'+v+'">'+labels[v]+'</option>').join('')+
   '</select></label>'+
   '<label>ملاحظة مختصرة<textarea placeholder="اكتب ما سمعته أو سبب الحكم عند الحاجة"></textarea></label>';
 const select=box.querySelector('select'), note=box.querySelector('textarea');
 select.value=saved[c.caseId]?.decision||''; note.value=saved[c.caseId]?.note||'';
 if(select.value) box.classList.add('done');
 select.onchange=()=>{saved[c.caseId]={...(saved[c.caseId]||{}),decision:select.value,note:note.value};box.classList.toggle('done',!!select.value);persist()};
 note.oninput=()=>{saved[c.caseId]={...(saved[c.caseId]||{}),decision:select.value,note:note.value};persist()};
 root.appendChild(box);
}
document.getElementById('export').onclick=()=>{
 const payload={schema:'bareeq.audio-human-triage-results.v1',packageId:manifest.packageId,exportedAt:new Date().toISOString(),results:manifest.cases.map(c=>({caseId:c.caseId,decision:saved[c.caseId]?.decision||null,note:saved[c.caseId]?.note||''}))};
 const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='bareeq-human-triage-results.json'; a.click(); URL.revokeObjectURL(a.href);
};
renderProgress();
</script>
</body></html>`;
}

export async function buildHumanTriagePackage({
  artifactRoot,
  outDir,
  repoRoot=process.cwd(),
  ffmpeg=process.env.BAREEQ_FFMPEG || 'ffmpeg',
  ffprobe=process.env.BAREEQ_FFPROBE || 'ffprobe',
}) {
  const status = await json(path.join(artifactRoot,'docs','audio','PROGRESSIVE-STATUS.json'));
  const active = (status.rows || []).filter((row)=>row.exact !== true && !EXCLUDED.has(row.articleId));
  const exact = (status.rows || []).filter((row)=>row.exact === true);
  if (active.length !== 7) throw new Error(`expected 7 active pending articles, found ${active.length}`);
  if (exact.length !== 7) throw new Error(`expected 7 Exact controls, found ${exact.length}`);

  const clipsDir=path.join(outDir,'clips');
  await mkdir(clipsDir,{recursive:true});
  const rawCases=[];
  let pendingCount=0;

  for(const row of active){
    const candidate=await loadCandidate(row,artifactRoot,repoRoot);
    const issues=pendingIssues(candidate);
    const expectedCount = Number(candidate.adjudication.consensus?.substitutions||0)
      + Number(candidate.adjudication.consensus?.deletions||0)
      + Number(candidate.adjudication.consensus?.insertions||0)
      + Number(candidate.adjudication.consensus?.unresolved||0);
    if(issues.length!==expectedCount) throw new Error(`${row.articleId}: issue count ${issues.length} != consensus ${expectedCount}`);
    for(let i=0;i<issues.length;i++){
      const rawId=`pending-${sha256(`${row.articleId}|${issues[i].expectedIndex}|${issues[i].type}|${i}`).slice(0,12)}`;
      rawCases.push(await makeCase({rawId,candidate,issue:issues[i],kind:'pending',clipsDir,ffmpeg,ffprobe}));
      pendingCount++;
    }
  }
  if(pendingCount!==29) throw new Error(`expected 29 pending mismatches, found ${pendingCount}`);

  for(const row of exact){
    const candidate=await loadCandidate(row,artifactRoot,repoRoot);
    const issue=chooseExactControl(candidate);
    const rawId=`control-${sha256(row.articleId).slice(0,12)}`;
    rawCases.push(await makeCase({rawId,candidate,issue,kind:'control',clipsDir,ffmpeg,ffprobe}));
  }

  rawCases.sort((a,b)=>blindSortKey(a.rawId).localeCompare(blindSortKey(b.rawId)));
  const articleOrder=new Map();
  let nextArticle=1;
  const reviewerCases=rawCases.map((row,index)=>{
    if(!articleOrder.has(row.articleId)) articleOrder.set(row.articleId,nextArticle++);
    const sameBefore=rawCases.slice(0,index).filter(x=>x.articleId===row.articleId).length;
    return {
      caseId:`T${String(index+1).padStart(2,'0')}`,
      title:row.title,
      articleOrdinal:articleOrder.get(row.articleId),
      caseOrdinalInArticle:sameBefore+1,
      expectedContext:row.expectedContext,
      clipFile:row.clipFile,
    };
  });

  const packageId=`triage-${status.sourceRunId || 'unknown'}-${sha256(rawCases.map(x=>x.rawId).join('|')).slice(0,10)}`;
  const reviewerManifest={
    schema:'bareeq.audio-human-triage-reviewer.v1',
    packageId,
    sourceRunId:status.sourceRunId,
    generatedAt:new Date().toISOString(),
    caseCount:reviewerCases.length,
    allowedDecisions:[...DECISIONS],
    cases:reviewerCases,
  };
  assertBlindManifest(reviewerManifest);

  const mapping=Object.fromEntries(reviewerCases.map((reviewer,index)=>[
    reviewer.caseId,
    {
      ...rawCases[index],
      reviewerCaseId:reviewer.caseId,
      clipSha256:sha256(await readFile(path.join(outDir,rawCases[index].clipFile))),
    }
  ]));
  const articleSummary=active.map((row)=>({
    articleId:row.articleId,
    title:row.title,
    expectedMismatchCount:rawCases.filter(c=>c.kind==='pending'&&c.articleId===row.articleId).length,
  }));

  const internalManifest={
    schema:'bareeq.audio-human-triage-internal.v1',
    packageId,
    sourceRunId:status.sourceRunId,
    sourceArtifact:status.sourceArtifact,
    generatedAt:new Date().toISOString(),
    totals:{cases:rawCases.length,pendingMismatches:pendingCount,exactControls:exact.length,activePendingArticles:active.length,excludedArticles:EXCLUDED.size},
    articleSummary,
    mapping,
    providerCalls:0,
    ttsCalls:0,
    asrCalls:0,
  };

  const guide=`# Bareeq Human Triage Package

- Package: \`${packageId}\`
- Cases: **${rawCases.length}**
- Pending mismatches: **${pendingCount}**
- Blind Exact controls: **${exact.length}**
- New TTS calls: **0**
- New ASR calls: **0**

Open \`review.html\` locally in a browser. The reviewer-facing material intentionally hides whether a case is a control and hides ASR/validator verdicts.

Allowed reviewer decisions:
- \`EXPECTED_PRONUNCIATION_CONFIRMED\`
- \`ACTUAL_AUDIO_ERROR\`
- \`REPRESENTATION_EQUIVALENT\`
- \`INCONCLUSIVE\`

Export the completed JSON from the button in the page. Do not edit \`internal-evidence.json\` during first-pass review.
`;

  await Promise.all([
    writeFile(path.join(outDir,'reviewer-manifest.json'),JSON.stringify(reviewerManifest,null,2)+'\n'),
    writeFile(path.join(outDir,'internal-evidence.json'),JSON.stringify(internalManifest,null,2)+'\n'),
    writeFile(path.join(outDir,'review.html'),reviewerHtml(reviewerManifest)),
    writeFile(path.join(outDir,'README.md'),guide),
  ]);
  return internalManifest;
}

async function cli(){
  const artifactRoot=path.resolve(arg('root','triage-input'));
  const outDir=path.resolve(arg('out','triage-output'));
  const result=await buildHumanTriagePackage({artifactRoot,outDir});
  console.log(`HUMAN_TRIAGE_PACKAGE=PASS cases=${result.totals.cases} pending=${result.totals.pendingMismatches} controls=${result.totals.exactControls} tts=0 asr=0`);
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
