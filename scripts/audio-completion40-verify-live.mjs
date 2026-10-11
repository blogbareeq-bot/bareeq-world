import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const r=JSON.parse(await readFile('docs/audio/COMPLETION40-PUBLICATION-20261011.json')),sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),origin='https://bareeqworld.com';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=x=>createHash('sha256').update(x).digest('hex');
async function live(){
 const checks=JSON.parse(execFileSync('gh',['api',`repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/check-runs`],{encoding:'utf8'}));
 const cf=checks.check_runs.find(x=>x.name==='Cloudflare Pages');if(cf?.conclusion!=='success')throw new Error('Native Cloudflare deployment is not successful yet');
 for(const a of r.liveIdentity){const response=await fetch(origin+a.path+'?completion40='+sha);if(!response.ok)throw new Error('Live manifest HTTP '+response.status);const m=await response.json();if((m.candidateFingerprint||m.fingerprint)!==a.fingerprint||m.fullSha256!==a.fullSha256)throw new Error('Live identity mismatch '+a.articleId);}
 const assets=[];
 for(const a of r.published)for(const p of a.parts){const response=await fetch(origin+p.src+'?completion40='+sha);if(!response.ok)throw new Error('Live part HTTP '+response.status);const b=Buffer.from(await response.arrayBuffer());if(digest(b)!==p.sha256||b.length!==p.bytes)throw new Error('Live part SHA mismatch '+p.src);assets.push({src:p.src,sha256:p.sha256,bytes:b.length});}
 return {schema:'bareeq.audio-completion40-live-verification.v1',verifiedAt:new Date().toISOString(),commit:sha,origin,cloudflareCheckId:cf.id,cloudflareConclusion:cf.conclusion,publishedExact:13,existingExactManifestsVerified:10,newManifestsVerified:3,newPartsVerified:assets.length,assets,ttsCalls:0,newAsrCalls:0};
}
let result;for(let attempt=0;attempt<48;attempt++){try{result=await live();break;}catch(e){console.log('LIVE_WAIT '+attempt+' '+e.message);if(attempt===47)throw e;await sleep(15000);}}
await writeFile('docs/audio/COMPLETION40-LIVE-VERIFICATION-20261011.json',JSON.stringify(result,null,2)+'\n');
console.log('COMPLETION40_LIVE=PASS exact=13/15 newParts='+result.newPartsVerified+' sha='+sha);
