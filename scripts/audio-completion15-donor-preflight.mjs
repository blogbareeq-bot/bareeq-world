import {readFile,writeFile,readdir,cp,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './audio-tranche33-authorization.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));const review=await json('remaining-review/review-manifest.json');
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
await mkdir('donor15-working');await mkdir('donor15-result');
for(const article of review.articles){
 const needed=article.articleId==='how-touchscreens-work'?article.parts:article.parts.filter(x=>x.cases.some(c=>c.caseId==='M12'));
 const hits=await find('retained-evidence',`audio-candidates/${article.articleId}/${article.fingerprint}/full.mp3`);if(hits.length!==1||digest(await readFile(hits[0]))!==article.baselineFullSha256)throw new Error('Review source full mismatch');
 for(const p of needed){const source=path.join(path.dirname(hits[0]),'parts',p.sourceCheckpointRecord.file);if(digest(await readFile(source))!==p.sourcePartSha256)throw new Error('Review source raw mismatch');await copyFile(source,path.join('donor15-working',p.sourceFile));}
}
console.log('DONOR15_PREFLIGHT_INPUT=PASS tts=0 provider=0');
