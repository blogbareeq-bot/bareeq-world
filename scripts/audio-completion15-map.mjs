import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {loadSpokenArticle,splitSpokenArticle,activeSplitSettings} from './audio-split.mjs';
import {QUOTA_SPLIT} from './audio-constants.mjs';
import {tokenizeVerbal} from './audio-exact-match.mjs';

const json=async p=>JSON.parse(await readFile(p,'utf8'));
const root=process.argv[2], out=process.argv[3];
if(!root||!out) throw new Error('usage: script retained-root output-root');
const inventory=await json(path.join(root,'inventory.json'));
const live=await json('docs/audio/LIVE-AUDIO-OBSERVED-20260828.json');
const confirmed={
 'how-touchscreens-work':[[184,'الشاشة'],[489,'إنه'],[1304,'به']],
 'intuition-first-impression-decisions-signature':[[632,'11']],
 'language-soft-power-politics':[[214,'ما'],[215,'علاقة'],[216,'اللغة'],[217,'بالقوة'],[218,'الناعمة']],
 'why-some-passports-are-stronger':[[818,'لا']],
 'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء':[[700,'قوى']],
};
const rows=[];
for(const row of inventory.pending){
 const dir=path.join(root,'candidate-metadata',row.audioKey);
 const manifest=await json(path.join(dir,'manifest.candidate.json'));
 const adj=await json(path.join(dir,'reports/asr-adjudication.json'));
 const article=await loadSpokenArticle(row.articleId);
 if(article.speechScriptHash!==adj.speechScriptHash) throw new Error(`${row.articleId}: speech hash drift`);
 const all=tokenizeVerbal(article.spokenText);
 const ranges=items=>{let cursor=0;return items.map(item=>{const n=tokenizeVerbal(item.text).length;const r={...item,start:cursor,end:cursor+n-1};cursor+=n;return r;});};
 const itemRanges=ranges(article.items);
 const plan=splitSpokenArticle(article,{settings:activeSplitSettings(QUOTA_SPLIT),liveDurationSeconds:live.articles.find(x=>x.articleId===row.articleId)?.durationSeconds??null});
 if(plan.parts.length!==manifest.parts.length) throw new Error(`${row.articleId}: part count drift`);
 const partRanges=ranges(plan.parts);
 if(partRanges.at(-1).end!==all.length-1 || itemRanges.at(-1).end!==all.length-1) throw new Error('token coverage mismatch');
 const issues=confirmed[row.articleId] ? confirmed[row.articleId].map(([expectedIndex,expected])=>({expectedIndex,expected,humanConfirmed:true})) : [...adj.substantiveDifferences,...adj.unresolved].map(x=>({expectedIndex:x.expectedIndex,expected:x.expected,humanConfirmed:false}));
 const targets=issues.map(x=>{
  if(all[x.expectedIndex]!==tokenizeVerbal(x.expected)[0]) throw new Error(`${row.articleId}: expected token drift at ${x.expectedIndex}`);
  const item=itemRanges.find(y=>x.expectedIndex>=y.start&&x.expectedIndex<=y.end), part=partRanges.find(y=>x.expectedIndex>=y.start&&x.expectedIndex<=y.end);
  if(!item||!part) throw new Error('missing target location');
  return {...x,segmentId:item.runtimeId||item.segmentId,segmentText:item.text,partNumber:part.partIndex+1,partLocalIndex:x.expectedIndex-part.start,expectedContext:all.slice(Math.max(0,x.expectedIndex-12),x.expectedIndex+13).join(' ')};
 });
 rows.push({...row,variants:undefined,targets,scope:confirmed[row.articleId]?'confirmed-repair':'morning-review-mini-campaign',publicationPermitted:false});
}
await mkdir(out,{recursive:true});
await writeFile(path.join(out,'completion15-map.json'),JSON.stringify({schema:'bareeq.audio-completion15-map.v1',currentExact:9,targetExact:15,providerCalls:0,ttsCalls:0,protectedExact:inventory.protectedExact,rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(x=>({articleId:x.articleId,targets:x.targets.length,parts:[...new Set(x.targets.map(t=>t.partNumber))]}))));
