import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {readThresholdAmendment} from './audio-tts-threshold-amendment.mjs';
import {loadSpokenArticle,splitSpokenArticle,activeSplitSettings} from './audio-split.mjs';
import {QUOTA_SPLIT,sha256} from './audio-constants.mjs';
import {tokenizeVerbal} from './audio-exact-match.mjs';
const [root,review,out]=process.argv.slice(2);if(!root||!review||!out)throw new Error('retained root, saved review root, output required');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const {amendment:a}=await readThresholdAmendment();
if(a.newThreshold!==40||a.executionStatus!=='PREFLIGHT_REQUIRED'||a.successfulRequestsConsumed!==0||a.executionClaim)throw new Error('preflight precedes all dispatch');
const live=await json('docs/audio/LIVE-AUDIO-OBSERVED-20260828.json');
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
await mkdir(out,{recursive:false});const rows=[],cache=new Map();
for(const t of a.targets){
 if(!cache.has(t.articleId)){
  const hits=await find(root,`audio-candidates/${t.articleId}/${t.fingerprint}/full.mp3`);if(hits.length!==1||sha256(await readFile(hits[0]))!==t.baselineFullSha256)throw new Error('retained full identity');
  const dir=path.dirname(hits[0]),article=await loadSpokenArticle(t.articleId),checkpoint=await json(path.join(dir,'checkpoint.json')),adj=await json(path.join(dir,'reports/asr-adjudication.json'));
  if(article.speechScriptHash!==t.speechScriptHash||adj.speechScriptHash!==t.speechScriptHash)throw new Error('canonical/source script drift');
  const plan=splitSpokenArticle(article,{settings:activeSplitSettings(QUOTA_SPLIT),liveDurationSeconds:live.articles.find(x=>x.articleId===t.articleId)?.durationSeconds??null});
  cache.set(t.articleId,{dir,article,checkpoint,plan});
 }
 const {dir,article,checkpoint,plan}=cache.get(t.articleId),partIndex=t.sourcePartNumber-1,part=plan.parts[partIndex],record=checkpoint.completedParts[String(partIndex)];
 const source=path.join(dir,'parts',record.file);if(sha256(await readFile(source))!==t.sourcePartSha256||record.sha256!==t.sourcePartSha256)throw new Error('raw source part drift');
 const item=article.items.find(x=>x.segmentId===t.canonicalSpeechSegmentId);if(!item||!item.text.includes(t.generationText))throw new Error('approved segment/text drift');
 const expected=tokenizeVerbal(part.text),repair=tokenizeVerbal(t.generationText),matches=expected.flatMap((_,i)=>expected.slice(i,i+repair.length).join('\0')===repair.join('\0')?[i]:[]);
 if(matches.length!==1)throw new Error('repair is not a unique whole sentence in this source part');
 const start=matches[0],end=start+repair.length-1,partStart=plan.parts.slice(0,partIndex).reduce((n,p)=>n+tokenizeVerbal(p.text).length,0);
 if(t.expectedIndices.some(x=>x-partStart<start||x-partStart>end))throw new Error('repair misses approved error');
 const prefix=t.articleId==='how-touchscreens-work'?'touch':'morning',wordHits=await find(review,`${prefix}-part${partIndex+1}-words.json`);
 if(wordHits.length!==1)throw new Error('saved local timing evidence ambiguous');const words=await json(wordHits[0]);if(words.sourcePartSha256!==t.sourcePartSha256||words.partIndex!==partIndex)throw new Error('saved timing source mismatch');
 const filename=t.id+'-baseline-part.mp3',wordfile=t.id+'-words.json';await copyFile(source,path.join(out,filename));await copyFile(wordHits[0],path.join(out,wordfile));
 rows.push({...t,partIndex,partNumber:partIndex+1,sourceFile:filename,wordFile:wordfile,sourceCheckpointRecord:record,partExpectedTokens:expected,repairExpectedStart:start,repairExpectedEnd:end,repairText:t.generationText,repairTextSha256:t.generationTextSha256,partLocalIndices:t.expectedIndices.map(x=>x-partStart),articleTitle:article.title});
}
await writeFile(path.join(out,'preflight-input.json'),JSON.stringify({schema:'bareeq.audio-tranche40-preflight-input.v1',decisionId:a.decisionId,sourceRunId:'37581607040',timingSourceRunId:'37623097600',providerCalls:0,ttsCalls:0,targets:rows},null,2)+'\n');
console.log('TRANCHE40_INPUT=PASS targets=7 tts=0 provider=0');
