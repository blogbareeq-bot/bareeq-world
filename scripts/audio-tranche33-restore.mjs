import {readdir,readFile,cp} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './audio-tranche33-authorization.mjs';
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
const hits=await find('execution-evidence','tranche33-execution/execution-result.json');if(hits.length!==1)throw new Error('Ambiguous saved execution result');
const result=JSON.parse(await readFile(hits[0],'utf8'));if(result.runId!=='37622809292'||result.successfulRequestsConsumed!==3)throw new Error('Only the already completed three-request execution may be recovered');
await cp(path.dirname(hits[0]),'tranche33-execution',{recursive:true});
const p=JSON.parse(await readFile('docs/audio/TRANCHE33-PREFLIGHT.json','utf8'));
for(const r of p.targets){const full=await find('execution-evidence',`audio-candidates/${r.articleId}/${r.fingerprint}/full.mp3`);if(full.length!==1||digest(await readFile(full[0]))!==r.baselineFullSha256)throw new Error('Saved candidate baseline mismatch');await cp(path.dirname(full[0]),path.join('audio-candidates',r.articleId,r.fingerprint),{recursive:true});const gen=result.targets.find(t=>t.articleId===r.articleId);if(!gen.generatedFile||digest(await readFile(path.join('tranche33-execution',gen.generatedFile)))!==gen.generatedSha256)throw new Error('Generated micro audio receipt mismatch');}
console.log('TRANCHE33_RESTORED=PASS successfulTtsAlreadyCounted=3 newTts=0');
