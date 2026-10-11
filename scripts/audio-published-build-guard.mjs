import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function tree(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await tree(p));else out.push(p);}return out.sort();}
export async function snapshotPublishedAudio(root=process.cwd()){
 const marker=JSON.parse(await readFile(path.join(root,'docs/audio/PUBLISHED-SADALTAGER-PARTIAL-20260903.json'))),status=JSON.parse(await readFile(path.join(root,'docs/audio/PROGRESSIVE-STATUS.json')));
 if(!Array.isArray(marker.articles)||marker.articles.length!==status.publishedCount||new Set(marker.articles.map(x=>x.articleId)).size!==marker.articles.length)throw new Error('Published audio protection: canonical publication set is inconsistent');
 const snapshots=[];
 for(const a of marker.articles){
  const row=status.rows.find(x=>x.articleId===a.articleId),key=hash(a.articleId).slice(0,16),dir=path.join(root,'public/audio/articles',key),m=JSON.parse(await readFile(path.join(dir,'manifest.json')));
  if(!row?.publishedExact||row.fingerprint!==a.fingerprint||row.fullSha256!==a.fullSha256||m.articleId!==a.articleId||(m.candidateFingerprint||m.fingerprint)!==a.fingerprint||m.fullSha256!==a.fullSha256||m.provider!=='Google Gemini API'||m.defaultVoice!=='sadaltager'||!Array.isArray(m.parts)||!m.parts.length)throw new Error('Published audio protection: approved identity drift '+a.articleId);
  for(const part of m.parts){const asset=part.audio?.[m.defaultVoice];if(!asset?.src?.startsWith(`/audio/articles/${key}/`)||!asset.sha256)throw new Error('Published audio protection: incomplete asset binding '+a.articleId);const file=path.resolve(root,'public',asset.src.slice(1));if(!file.startsWith(dir+path.sep))throw new Error('Published audio protection: asset path escape');const b=await readFile(file);if(hash(b)!==asset.sha256||b.length!==asset.bytes)throw new Error('Published audio protection: part SHA/size mismatch '+a.articleId);}
  const files={};for(const f of await tree(dir))files[path.relative(dir,f)]=hash(await readFile(f));snapshots.push({articleId:a.articleId,audioKey:key,fingerprint:a.fingerprint,fullSha256:a.fullSha256,files});
 }
 return {schema:'bareeq.audio-published-build-protection.v1',articles:snapshots};
}
export async function assertPublishedAudioUnchanged(before,root=process.cwd()){
 const after=await snapshotPublishedAudio(root);if(JSON.stringify(after)!==JSON.stringify(before))throw new Error('Published audio protection: a build/cache importer changed an approved manifest or audio file');
 console.log(`PUBLISHED_AUDIO_BUILD_PROTECTION=PASS exact=${before.articles.length} immutableFiles=${before.articles.reduce((n,a)=>n+Object.keys(a.files).length,0)} providerCalls=0`);
}
