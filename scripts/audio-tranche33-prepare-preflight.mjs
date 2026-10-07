import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {readThresholdAmendment} from './audio-tts-threshold-amendment.mjs';
import {loadSpokenArticle,splitSpokenArticle,activeSplitSettings} from './audio-split.mjs';
import {QUOTA_SPLIT,sha256} from './audio-constants.mjs';
import {tokenizeVerbal} from './audio-exact-match.mjs';
const root=process.argv[2],out=process.argv[3];if(!root||!out)throw new Error('expected retained root and output directory');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const {amendment:a}=await readThresholdAmendment();
if(a.executionStatus!=='PREFLIGHT_REQUIRED'||a.successfulRequestsConsumed!==0)throw new Error('preflight must precede provider execution');
const live=await json('docs/audio/LIVE-AUDIO-OBSERVED-20260828.json');
async function findSuffix(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await findSuffix(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
await mkdir(out,{recursive:false});const rows=[];
for(const [index,t] of a.targets.entries()){
 const hits=await findSuffix(root,`audio-candidates/${t.articleId}/${t.fingerprint}/full.mp3`);
 if(hits.length!==1)throw new Error(`${t.articleId}: ambiguous retained source`);
 const full=hits[0],dir=path.dirname(full);if(sha256(await readFile(full))!==t.baselineFullSha256)throw new Error('retained full SHA drift');
 const [checkpoint,manifest,adj,article]=await Promise.all([json(path.join(dir,'checkpoint.json')),json(path.join(dir,'manifest.candidate.json')),json(path.join(dir,'reports','asr-adjudication.json')),loadSpokenArticle(t.articleId)]);
 if(article.speechScriptHash!==adj.speechScriptHash)throw new Error('approved speech hash drift');
 const plan=splitSpokenArticle(article,{settings:activeSplitSettings(QUOTA_SPLIT),liveDurationSeconds:live.articles.find(x=>x.articleId===t.articleId)?.durationSeconds??null});
 if(plan.parts.length!==manifest.parts.length)throw new Error('retained part plan drift');
 const partIndex=t.targets[0].partNumber-1,part=plan.parts[partIndex],record=checkpoint.completedParts[String(partIndex)];
 if(!record||t.targets.some(x=>x.partNumber!==partIndex+1))throw new Error('mixed part request');
 const source=path.join(dir,'parts',record.file),sourceSha=sha256(await readFile(source));if(sourceSha!==record.sha256)throw new Error('part SHA drift');
 let cursor=0;const ranges=article.items.map(item=>{const n=tokenizeVerbal(item.text).length;const r={...item,start:cursor,end:cursor+n-1};cursor+=n;return r;});
 const item=ranges.find(x=>(x.runtimeId||x.segmentId)===t.targets[0].segmentId);if(!item||t.targets.some(x=>x.expectedIndex<item.start||x.expectedIndex>item.end))throw new Error('target segment drift');
 const partStart=plan.parts.slice(0,partIndex).reduce((n,p)=>n+tokenizeVerbal(p.text).length,0);
 const expected=tokenizeVerbal(part.text),start=item.start-partStart,end=item.end-partStart;
 if(start<0||end>=expected.length)throw new Error('segment crosses part boundary');
 const filename=`target-${index+1}-baseline-part.mp3`;await copyFile(source,path.join(out,filename));
 rows.push({...t,id:`R${index+1}`,sourceFile:filename,sourcePartSha256:sourceSha,sourceCheckpointRecord:record,partIndex,partNumber:partIndex+1,partExpectedTokens:expected,repairExpectedStart:start,repairExpectedEnd:end,repairText:item.text,speechScriptHash:article.speechScriptHash,articleTitle:article.title,insertionExpected:t.articleId==='language-soft-power-politics'});
}
await writeFile(path.join(out,'preflight-input.json'),JSON.stringify({schema:'bareeq.audio-tranche33-preflight-input.v1',decisionId:a.decisionId,sourceRunId:'37581607040',providerCalls:0,ttsCalls:0,targets:rows},null,2)+'\n');
console.log('TRANCHE33_INPUT=PASS targets=3 tts=0 provider=0');
