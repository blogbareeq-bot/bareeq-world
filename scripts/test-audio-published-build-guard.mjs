import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {snapshotPublishedAudio,assertPublishedAudioUnchanged} from './audio-published-build-guard.mjs';
const source=process.cwd(),before=await snapshotPublishedAudio(source),fixture=await mkdtemp(path.join(os.tmpdir(),'bareeq-published-build-'));
try{
 await mkdir(path.join(fixture,'docs/audio'),{recursive:true});for(const f of ['PROGRESSIVE-STATUS.json','PUBLISHED-SADALTAGER-PARTIAL-20260903.json'])await cp(path.join(source,'docs/audio',f),path.join(fixture,'docs/audio',f));
 for(const a of before.articles)await cp(path.join(source,'public/audio/articles',a.audioKey),path.join(fixture,'public/audio/articles',a.audioKey),{recursive:true});
 await assertPublishedAudioUnchanged(before,fixture);
 const a=before.articles.find(x=>x.articleId==='altadakhom-explained-simply')||before.articles[0],mf=path.join(fixture,'public/audio/articles',a.audioKey,'manifest.json'),original=await readFile(mf),m=JSON.parse(original);
 await writeFile(mf,JSON.stringify({...m,provider:'Microsoft Azure AI Speech',defaultVoice:'hamed'}));await assert.rejects(()=>snapshotPublishedAudio(fixture),/approved identity drift/,'a legacy Hamed restore must not overwrite published Exact');await writeFile(mf,original);
 const part=m.parts[0].audio[m.defaultVoice],file=path.join(fixture,'public',part.src.slice(1)),bytes=await readFile(file);await writeFile(file,Buffer.concat([bytes,Buffer.from('tamper')]));await assert.rejects(()=>snapshotPublishedAudio(fixture),/SHA\/size mismatch/,'a changed published audio asset must be rejected');await writeFile(file,bytes);
 await assertPublishedAudioUnchanged(before,fixture);console.log('PUBLISHED_BUILD_GUARD_TESTS=PASS actual approved corpus retained; legacy-voice replacement and part corruption rejected');
}finally{await rm(fixture,{recursive:true,force:true});}
