import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sha256 } from './audio-constants.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { assertFfmpeg } from './audio-ffmpeg.mjs';
import { transcribeDualAsr } from './audio-asr-transcribe.mjs';

const ROOT = process.cwd();

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out=[]; const err=[];
    child.stdout.on('data',(d)=>out.push(d));
    child.stderr.on('data',(d)=>err.push(d));
    child.on('close',(code)=>resolve({code,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8')}));
  });
}

export async function validateNewContentTestClip({ root=ROOT, audioPath=process.env.BAREEQ_TEST_CLIP_AUDIO, apiKey=process.env.GEMINI_API_KEY }={}) {
  const auth = JSON.parse(await readFile(path.join(root,'docs','audio','NEW-CONTENT-TEST-CLIP-AUTHORIZATION.json'),'utf8'));
  const result = JSON.parse(await readFile(path.join(root,'docs','audio','NEW-CONTENT-TEST-CLIP-RESULT.json'),'utf8'));
  const speech = JSON.parse(await readFile(path.join(root,'scripts','speech-scripts',`${auth.targetArticleId}.json`),'utf8'));
  const plan = JSON.parse(await readFile(path.join(root,'scripts','speech-test-clips',`${auth.targetArticleId}.json`),'utf8'));
  if(auth.authorizationStatus!=='EXECUTED'||result.status!=='GENERATED_AWAITING_HUMAN_LISTENING') throw new Error('test clip is not in generated-awaiting-listening state');
  if(!audioPath) throw new Error('BAREEQ_TEST_CLIP_AUDIO is required');
  const bytes=await readFile(audioPath);
  const digest=sha256(bytes);
  if(digest!==result.audio.sha256) throw new Error('test clip SHA-256 mismatch');
  const selectedIds=plan.selectedSegments.map(x=>x.segmentId);
  const map=new Map(speech.segments.map(x=>[x.segmentId,x]));
  const expectedText=selectedIds.map(id=>map.get(id)?.spokenText).filter(Boolean).join('\n\n');
  if(selectedIds.length!==5 || expectedText.length<100) throw new Error('selected test text is incomplete');

  const { ffmpeg } = await assertFfmpeg();
  const decode=await run(ffmpeg,['-v','error','-i',audioPath,'-f','null','-']);
  const duration=await mp3DurationSeconds(audioPath);
  const technical={
    decodePassed:decode.code===0,
    durationSeconds:duration,
    sha256:digest,
    bytes:bytes.length,
  };

  const reportsDir=path.join(root,'audio-candidates','_test-clip-auto-qa',auth.targetArticleId,auth.speechScriptHash);
  await mkdir(reportsDir,{recursive:true});
  let dual=null, asrError=null;
  try {
    dual=await transcribeDualAsr({
      audioPath,
      expectedText,
      apiKey,
      reportsDir,
      fingerprint:auth.testClipPlanHash,
      fullSha256:digest,
      article:{articleId:auth.targetArticleId,speechScriptHash:auth.speechScriptHash},
    });
  } catch(error) {
    asrError=error;
    dual=error.dual||null;
  }
  const asrReports=dual?.asrReports||[];
  const exact=asrReports.length===2 && asrReports.every(r=>r.status==='passed'&&Number(r.substitutions)===0&&Number(r.deletions)===0&&Number(r.insertions)===0);
  const report={
    schema:'bareeq.audio-new-content-test-clip-auto-qa.v1',
    articleId:auth.targetArticleId,
    decisionId:auth.decisionId,
    speechScriptHash:auth.speechScriptHash,
    testClipPlanHash:auth.testClipPlanHash,
    audio:{sha256:digest,bytes:bytes.length,durationSeconds:duration},
    technical,
    asr:{
      status:exact?'EXACT_0_0_0_BOTH':'NOT_EXACT_OR_UNAVAILABLE',
      models:asrReports.map(r=>r.requestedModel||r.model),
      reports:asrReports.map(r=>({
        model:r.requestedModel||r.model,
        status:r.status,
        substitutions:r.substitutions??null,
        deletions:r.deletions??null,
        insertions:r.insertions??null,
        transcript:r.transcript||null,
        httpStatus:r.httpStatus??null,
        error:r.error||null,
      })),
      filesApiDeletePassed:dual?.deleteResult?.deleted===true,
      error:asrError?String(asrError.message).slice(0,900):null,
    },
    humanListening:{status:'required-not-performed'},
    passedAutomated:technical.decodePassed&&exact&&dual?.deleteResult?.deleted===true,
    generatedAt:new Date().toISOString(),
  };
  await writeFile(path.join(root,'docs','audio','NEW-CONTENT-TEST-CLIP-AUTO-QA.json'),`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify(report,null,2));
  return report;
}

const isCli=process.argv[1]&&path.basename(process.argv[1])==='audio-new-content-test-clip-validate.mjs';
if(isCli){
  try{await validateNewContentTestClip();}
  catch(error){console.error(error.message);process.exit(error.exitCode||1);}
}
