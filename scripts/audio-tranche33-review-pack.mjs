import {readdir,readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './audio-tranche33-authorization.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
async function find(dir,suffix){let hits=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hits.push(...await find(p,suffix));else if(p.replaceAll('\\','/').endsWith(suffix))hits.push(p);}return hits;}
const out='tranche33-review';await mkdir(out);const preflight=await json('docs/audio/TRANCHE33-PREFLIGHT.json'),splice=await json('tranche33-execution/splice-result.json'),validation=await json('tranche33-execution/validation-result.json'),execution=await json('tranche33-execution/execution-result.json');
const rows=[];
for(const r of [...preflight.targets,{id:'P0',articleId:'why-some-passports-are-stronger',fingerprint:'2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b',repairText:'لا السياسة حاضرة بقوة — لمواطني الدول الأعضاء'}]){
 const dir=path.join('audio-candidates',r.articleId,r.fingerprint),v=validation.targets.find(x=>x.id===r.id),s=splice.targets.find(x=>x.id===r.id),row={id:r.id,articleId:r.articleId,fingerprint:r.fingerprint,repairText:r.repairText,validation:v||null,splice:s||null,humanReviewPerformed:false};
 const local=await readFile(path.join('tranche33-execution',r.id+'-micro-asr.json')).then(x=>JSON.parse(x)).catch(()=>null);row.localMicroAsr=local;
 const full=await readFile(path.join(dir,'full.mp3')).catch(()=>null);row.fullSha256=full?digest(full):null;
 let clip=path.join('tranche33-execution',r.id+'-repaired-context.mp3');
 if(r.id==='P0'){const hits=await find('passports-splice','review-context.mp3');if(hits.length===1)clip=hits[0];}
 let bytes=await readFile(clip).catch(()=>null);if(!bytes){clip=path.join('tranche33-execution',r.id+'-generated.mp3');bytes=await readFile(clip).catch(()=>null);row.clipIsGeneratedMicroOnly=true;}
 if(bytes){row.clipFile=r.id+'-review.mp3';row.clipSha256=digest(bytes);await writeFile(path.join(out,row.clipFile),bytes);}
 for(const name of ['technical-qa.json','sync.json','normalization.json','asr-adjudication.json','asr-retry-log.json']){const b=await readFile(path.join(dir,'reports',name)).catch(()=>null);if(b)await writeFile(path.join(out,r.id+'-'+name),b);}
 const part=r.id==='P0'?v?.newPart:s?.candidatePartFile&&path.join('tranche33-execution',s.candidatePartFile);
 if(part){const b=await readFile(part).catch(()=>null);if(b){row.candidatePartFile=r.id+'-candidate-part.mp3';row.candidatePartSha256=digest(b);await writeFile(path.join(out,row.candidatePartFile),b);}}
 rows.push(row);
}
const status=await json('docs/audio/PROGRESSIVE-STATUS.json'),a=await json('docs/audio/TTS-THRESHOLD-AMENDMENT-33.json');
const manifest={schema:'bareeq.audio-tranche33-review.v1',sourceExecutionRunId:'37622809292',successfulTtsAlreadyConsumed:3,newTtsCalls:0,publicationPerformed:false,publishedExact:status.publishedCount,protectedExact:a.protectedExact,targets:rows};await writeFile(path.join(out,'review-manifest.json'),JSON.stringify(manifest,null,2)+'\n');await writeFile(path.join(out,'execution-result.json'),JSON.stringify(execution,null,2)+'\n');
const escape=x=>String(x||'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
await writeFile(path.join(out,'review.html'),`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مراجعة المقاطع المعدلة</title><style>body{max-width:850px;margin:40px auto;background:#faf7ef;color:#193b34;font:20px/1.8 system-ui}article{background:white;border:1px solid #dfdfd5;border-radius:14px;padding:25px;margin:24px 0}audio{width:100%}code{font-size:14px;word-break:break-all}</style><h1>مراجعة المقاطع المعدلة</h1><p>الطلبات الثلاثة احتُسبت ضمن 33/33. هذه الملفات للمراجعة؛ لم تُنشر بعد. مقطع الجوازات أُصلح من صوت محفوظ دون طلب توليد جديد.</p>${rows.map(r=>`<article><h2>${r.id}</h2><p>${escape(r.repairText)}</p>${r.clipFile?`<audio controls src="${r.clipFile}"></audio>`:'<p>لا يوجد مقطع جاهز.</p>'}<p>${r.clipIsGeneratedMicroOnly?'المقطع هو الصوت المولد قبل الدمج.':'المقطع يشمل سياق الصوت بعد الدمج.'}</p><p>الفحص الكامل: ${escape(r.validation?.status||'لم يبدأ')}</p><code>${escape(r.fullSha256)}</code></article>`).join('')}</html>`);
console.log(JSON.stringify(rows.map(r=>({id:r.id,status:r.validation?.status,localMicroPass:r.localMicroAsr?.passed,fullSha256:r.fullSha256})),null,2));
