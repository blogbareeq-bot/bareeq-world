import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {loadSpokenArticle,splitSpokenArticle,activeSplitSettings} from './audio-split.mjs';
import {QUOTA_SPLIT,sha256} from './audio-constants.mjs';
import {tokenizeVerbal} from './audio-exact-match.mjs';
const root=process.argv[2],out=process.argv[3];const json=async p=>JSON.parse(await readFile(p,'utf8'));
const status=await json('docs/audio/PROGRESSIVE-STATUS.json'),live=await json('docs/audio/LIVE-AUDIO-OBSERVED-20260828.json');
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
await mkdir(out,{recursive:false});await mkdir(path.join(out,'working'));
const articles=[];
for(const articleId of ['how-touchscreens-work','اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع']){
 const row=status.rows.find(r=>r.articleId===articleId);if(!row||row.publishedExact)throw new Error('review target identity changed');
 const hits=await find(root,`audio-candidates/${articleId}/${row.fingerprint}/full.mp3`);if(hits.length!==1||sha256(await readFile(hits[0]))!==row.fullSha256)throw new Error('retained full mismatch');
 const dir=path.dirname(hits[0]),checkpoint=await json(path.join(dir,'checkpoint.json')),adj=await json(path.join(dir,'reports','asr-adjudication.json')),article=await loadSpokenArticle(articleId);
 if(article.speechScriptHash!==adj.speechScriptHash)throw new Error('approved script drift');
 const plan=splitSpokenArticle(article,{settings:activeSplitSettings(QUOTA_SPLIT),liveDurationSeconds:live.articles.find(x=>x.articleId===articleId)?.durationSeconds??null});
 const touch=articleId==='how-touchscreens-work',issues=[...(adj.substantiveDifferences||[]),...(adj.unresolved||[])].filter(x=>!touch||[184,489,1304].includes(x.expectedIndex)).sort((a,b)=>a.expectedIndex-b.expectedIndex);
 const cases=[];for(const issue of issues){const prev=cases.at(-1);if(issue.type==='deletion'&&prev?.issues.at(-1).type==='deletion'&&prev.expectedEnd+1===issue.expectedIndex){prev.expectedEnd=issue.expectedIndex;prev.issues.push(issue);}else cases.push({caseId:`${touch?'S':'M'}${cases.length+1}`,expectedStart:issue.expectedIndex,expectedEnd:issue.expectedIndex,humanConfirmed:touch,issues:[issue]});}
 let cursor=0;const segments=article.items.map(x=>{const n=tokenizeVerbal(x.text).length;const r={id:x.runtimeId||x.segmentId,text:x.text,start:cursor,end:cursor+n-1};cursor+=n;return r;});
 let offset=0;const parts=[];
 for(const [index,part] of plan.parts.entries()){
  const tokens=tokenizeVerbal(part.text),pcases=cases.filter(c=>c.expectedStart>=offset&&c.expectedEnd<offset+tokens.length).map(c=>({...c,localStart:c.expectedStart-offset,localEnd:c.expectedEnd-offset,approvedSegment:segments.find(s=>c.expectedStart>=s.start&&c.expectedEnd<=s.end)}));
  if(touch||pcases.length){const record=checkpoint.completedParts[String(index)],source=path.join(dir,'parts',record.file),sha=sha256(await readFile(source));if(sha!==record.sha256)throw new Error('retained part drift');const file=`${touch?'touch':'morning'}-part${index+1}.mp3`;await copyFile(source,path.join(out,'working',file));parts.push({partIndex:index,sourceFile:file,sourcePartSha256:sha,sourceCheckpointRecord:record,expectedTokens:tokens,cases:pcases});}
  offset+=tokens.length;
 }
 if(parts.reduce((n,p)=>n+p.cases.length,0)!==cases.length)throw new Error('case crosses part boundary');
 articles.push({articleId,fingerprint:row.fingerprint,baselineFullSha256:row.fullSha256,speechScriptHash:article.speechScriptHash,title:article.title,parts});
}
await writeFile(path.join(out,'review-input.json'),JSON.stringify({schema:'bareeq.audio-completion15-review-input.v1',sourceRunId:'37581607040',ttsCalls:0,providerCalls:0,articles},null,2)+'\n');console.log('REMAINING15_REVIEW_PREP=PASS tts=0 provider=0');
