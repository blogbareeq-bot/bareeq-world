import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {loadSpokenArticle,splitSpokenArticle,activeSplitSettings} from './audio-split.mjs';
import {QUOTA_SPLIT,sha256} from './audio-constants.mjs';
import {tokenizeVerbal} from './audio-exact-match.mjs';
const [retained,baseline,triage,out]=process.argv.slice(2);const json=async p=>JSON.parse(await readFile(p,'utf8'));
const identities=[['C1','language-soft-power-politics','64d18819c78cdd92b6c133409669ee47d492d7ba809d3172007a31a9101977f8','0eb1d93db3bf280c1bf049270a8487a163e5389fdb2bfad81144544c287983a2'],['C2','intuition-first-impression-decisions-signature','ffd1bf6e71ede6114156a94a8fd0666c4f3ab5d5a4b53df745b7a5469c27176b','aa7b8de471872095858ed47ca6a8326c609262bb81e2ca21bea26b2a0bebf7bc'],['C3','why-some-passports-are-stronger','2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b','38945dab4c6af24354b106285ca43ae3c29377f0905399175b3f8922382d8a90']];
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
async function one(dir,suffix){const h=await find(dir,suffix);if(h.length!==1)throw new Error('Ambiguous retained evidence '+suffix);return h[0];}
const live=await json('docs/audio/LIVE-AUDIO-OBSERVED-20260828.json'),history=await json(await one(triage,'internal-evidence.json')),review=await json('docs/audio/HUMAN-TRIAGE-FULL-RESULT-20261006.json'),reviewed=new Set(review.confirmedFalsePositiveCandidates),oldPreflight=await json('docs/audio/TRANCHE33-PREFLIGHT.json');
if(history.packageId!==review.packageId)throw new Error('Historical package mismatch');
await mkdir(out,{recursive:false});const articles=[];
for(const [prefix,articleId,fingerprint,fullSha256] of identities){
 const full=await one(retained,`audio-candidates/${articleId}/${fingerprint}/full.mp3`);if(sha256(await readFile(full))!==fullSha256)throw new Error('Saved candidate full identity');const dir=path.dirname(full),oldFull=await one(baseline,`audio-candidates/${articleId}/${fingerprint}/full.mp3`),oldDir=path.dirname(oldFull),ck=await json(path.join(dir,'checkpoint.json')),oldCk=await json(path.join(oldDir,'checkpoint.json')),adj=await json(path.join(dir,'reports/asr-adjudication.json')),article=await loadSpokenArticle(articleId);
 if(adj.fullSha256!==fullSha256||adj.speechScriptHash!==article.speechScriptHash)throw new Error('Saved ASR canonical binding');
 const all=[...adj.substantiveDifferences,...adj.unresolved].sort((a,b)=>a.expectedIndex-b.expectedIndex),carried=[];
 for(const [caseId,m] of Object.entries(history.mapping)){
  if(!reviewed.has(caseId)||m.articleId!==articleId||m.fingerprint!==fingerprint||m.fullSha256!==sha256(await readFile(oldFull))||!all.some(x=>x.expectedIndex===m.expectedIndex&&x.expected===m.expectedToken))continue;
  if(sha256(await readFile(path.join(triage,m.clipFile)))!==m.clipSha256)throw new Error('Historical reviewed clip changed');
  const source=oldCk.completedParts[String(m.partIndex)],current=ck.completedParts[String(m.partIndex)],sourceSha=sha256(await readFile(path.join(oldDir,'parts',source.file))),currentSha=sha256(await readFile(path.join(dir,'parts',current.file)));
  if(source.sha256!==sourceSha||current.sha256!==currentSha||current.file!==source.file)throw new Error('Part byte checkpoint mismatch');
  if(sourceSha===currentSha){carried.push({caseId,expectedIndex:m.expectedIndex,expectedToken:m.expectedToken,sourcePartSha256:sourceSha,originalFullSha256:m.fullSha256,fullSha256,method:'byte-identical-unchanged-raw-part',mapping:m});continue;}
  // Changed part decisions remain queued until their PCM derivative can be
  // checked independently. Never treat a fingerprint alone as unchanged audio.
 }
 const remaining=all.filter(x=>!carried.some(c=>c.expectedIndex===x.expectedIndex&&c.expectedToken===x.expected)),plan=splitSpokenArticle(article,{settings:activeSplitSettings(QUOTA_SPLIT),liveDurationSeconds:live.articles.find(x=>x.articleId===articleId)?.durationSeconds??null});
 let cursor=0;const segments=article.items.map(item=>{const n=tokenizeVerbal(item.text).length;const s={id:item.runtimeId||item.segmentId,text:item.text,start:cursor,end:cursor+n-1};cursor+=n;return s;});
 const groups=[];for(const issue of remaining){const s=segments.find(s=>s.start<=issue.expectedIndex&&s.end>=issue.expectedIndex);if(!s)throw new Error('Issue outside canonical script');let g=groups.find(x=>x.segment.id===s.id);if(!g){g={caseId:prefix+'-'+String(groups.length+1).padStart(2,'0'),segment:s,issues:[]};groups.push(g);}g.issues.push(issue);}
 const parts=[];let offset=0;
 for(const [partIndex,part] of plan.parts.entries()){
  const tokens=tokenizeVerbal(part.text),cases=groups.filter(g=>g.issues.every(x=>x.expectedIndex>=offset&&x.expectedIndex<offset+tokens.length)).map(g=>({...g,localStart:Math.min(...g.issues.map(x=>x.expectedIndex))-offset,localEnd:Math.max(...g.issues.map(x=>x.expectedIndex))-offset}));
  if(cases.length){const rec=ck.completedParts[String(partIndex)],source=path.join(dir,'parts',rec.file),sourceSha=sha256(await readFile(source));if(sourceSha!==rec.sha256)throw new Error('Review part changed');const sourceFile=prefix+'-part'+(partIndex+1)+'.mp3';await copyFile(source,path.join(out,sourceFile));parts.push({partIndex,sourceFile,sourcePartSha256:sourceSha,expectedTokens:tokens,cases});}
  offset+=tokens.length;
 }
 if(parts.reduce((n,p)=>n+p.cases.length,0)!==groups.length)throw new Error('Review group crosses part boundary');
 articles.push({articleId,fingerprint,fullSha256,speechScriptHash:article.speechScriptHash,title:article.title,originalBaselineFullSha256:sha256(await readFile(oldFull)),rawConsensus:adj.consensus,carriedHumanCases:carried,remainingIssueCount:remaining.length,parts});
}
await writeFile(path.join(out,'review-input.json'),JSON.stringify({schema:'bareeq.audio-completion40-other-review-input.v1',sourceRunId:'37626334800',historicalPackageId:history.packageId,reviewerResultsSha256:review.reviewerResultsSha256,ttsCalls:0,newAsrProviderCalls:0,publicationPerformed:false,articles},null,2)+'\n');
console.log(JSON.stringify(articles.map(a=>({articleId:a.articleId,carried:a.carriedHumanCases.map(x=>x.caseId),remaining:a.remainingIssueCount,parts:a.parts.length}))));
