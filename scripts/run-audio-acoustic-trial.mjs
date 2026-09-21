import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { writeApprovedFixture } from './test-audio-fixture.mjs';

const ROOT = process.cwd();
const engine = String(process.argv.find((arg) => arg.startsWith('--engine='))?.slice(9) || process.env.BAREEQ_TTS_ENGINE || '').trim();
const engines = new Set(['gemini', 'voxcpm2', 'moss-v15', 'moss-nano']);
if (!engines.has(engine)) throw new Error('Use --engine=gemini|voxcpm2|moss-v15|moss-nano');

const articleId = 'acoustic-trial-arabic-v1';
const markdown = `---
title: "اختبار بريق الصوتي العربي"
draft: false
---
ببساطة، في عام 2026 ارتفعت النسبة إلى 12.5%، لكن الرقم وحده لا يشرح القصة كاملة. نريد نطقًا عربيًا طبيعيًا يحافظ على المعنى، ويقف عند الفاصلة والنقطة دون تكلّف.

قال عبد الوهاب مطاوع إن التفاصيل الصغيرة قد تغيّر نظرتنا إلى الموقف؛ وفي المقابل، تستخدم تقنيات OpenAI وGemini نماذج حديثة لمعالجة اللغة. هل ينطق المحرك الأسماء والمصطلحات الأجنبية بوضوح من دون أن يفسد إيقاع الجملة العربية؟

هذه جملة طويلة لاختبار الثبات والتنفس والإيقاع؛ فهي تجمع رقمًا، ونسبة مئوية، وسنة، واسمًا عربيًا، ومصطلحًا أجنبيًا، وسؤالًا، ثم تعود إلى كلمة ببساطة مرة أخرى للتأكد من أن قاعدة النطق تعمل بثبات من أول المقطع إلى آخره.
`;

const resultRoot = path.join(ROOT, '.acoustic-trials', 'results', engine);
const workRoot = path.join(ROOT, '.acoustic-trials', 'work', engine);
await rm(resultRoot, { recursive: true, force: true });
await rm(workRoot, { recursive: true, force: true });
await mkdir(resultRoot, { recursive: true });
await writeApprovedFixture(workRoot, { articleId, markdown, copyRulesFrom: ROOT });

const local = engine !== 'gemini';
const revisionVars = {
  voxcpm2: ['BAREEQ_VOXCPM2_MODEL_REVISION', 'BAREEQ_VOXCPM2_WORKER_REVISION'],
  'moss-v15': ['BAREEQ_MOSS_V15_MODEL_REVISION', 'BAREEQ_MOSS_V15_WORKER_REVISION'],
  'moss-nano': ['BAREEQ_MOSS_NANO_MODEL_REVISION', 'BAREEQ_MOSS_NANO_WORKER_REVISION'],
};
const endpointVars = {
  voxcpm2: ['BAREEQ_VOXCPM2_ENDPOINT', 'BAREEQ_VOXCPM2_BIN'],
  'moss-v15': ['BAREEQ_MOSS_V15_ENDPOINT', 'BAREEQ_MOSS_V15_BIN'],
  'moss-nano': ['BAREEQ_MOSS_NANO_ENDPOINT', 'BAREEQ_MOSS_NANO_BIN'],
};

const missing = [];
if (!process.env.GEMINI_API_KEY?.trim()) missing.push('GEMINI_API_KEY');
if (local) {
  const [modelRev, workerRev] = revisionVars[engine];
  if (!process.env[modelRev]?.trim()) missing.push(modelRev);
  if (!process.env[workerRev]?.trim()) missing.push(workerRev);
  if (!endpointVars[engine].some((key) => process.env[key]?.trim())) missing.push(endpointVars[engine].join(' or '));
}
const statusFile = path.join(resultRoot, 'status.json');
if (missing.length) {
  await writeFile(statusFile, JSON.stringify({
    schema: 'bareeq.audio-acoustic-trial.v1',
    engine,
    articleId,
    status: 'blocked-missing-runtime',
    missing,
    publishAttempted: false,
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  console.error('Acoustic trial blocked for ' + engine + ': ' + missing.join(', '));
  process.exit(78);
}

const env = {
  ...process.env,
  BAREEQ_TTS_ENGINE: engine,
  BAREEQ_AUDIO_PRODUCTION_LOCK: '1',
  BAREEQ_AUDIO_ENGINE_V2_PUBLISH: '0',
  BAREEQ_AUDIO_PUBLISH_GIT: '0',
  BAREEQ_LOCAL_TTS_ENABLE: local ? '1' : '0',
  BAREEQ_SEGMENT_CACHE_ENABLE: '0',
  BAREEQ_LOCAL_ASR_PREFLIGHT: '0',
  BAREEQ_CLOUD_TTS_ACTIVATE: '0',
  BAREEQ_GEMINI_FREE_ROLLOUT: '0',
  BAREEQ_AUDIO_DEBUG_STACK: '1',
};
if (local) {
  const [modelRev, workerRev] = revisionVars[engine];
  env.BAREEQ_TTS_MODEL_REVISION = process.env[modelRev];
  env.BAREEQ_TTS_WORKER_REVISION = process.env[workerRev];
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'audio-production.mjs'), ...args], {
      cwd: workRoot,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const generate = await runCli(['--mode=generate-candidate', `--article=${articleId}`]);
await writeFile(path.join(resultRoot, 'generate.stdout.txt'), generate.stdout);
await writeFile(path.join(resultRoot, 'generate.stderr.txt'), generate.stderr);
if (generate.code !== 0) {
  await writeFile(statusFile, JSON.stringify({
    schema: 'bareeq.audio-acoustic-trial.v1', engine, articleId,
    status: 'generation-failed', exitCode: generate.code, publishAttempted: false,
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  process.exit(generate.code || 1);
}
const generated = JSON.parse(generate.stdout.trim());
const fingerprint = generated.fingerprint;
const validate = await runCli(['--mode=validate-candidate', `--article=${articleId}`, `--fingerprint=${fingerprint}`]);
await writeFile(path.join(resultRoot, 'validate.stdout.txt'), validate.stdout);
await writeFile(path.join(resultRoot, 'validate.stderr.txt'), validate.stderr);

const candidateDir = path.join(workRoot, 'audio-candidates', articleId, fingerprint);
try {
  await cp(candidateDir, path.join(resultRoot, 'candidate'), { recursive: true });
} catch {
  // Preserve status/stdout/stderr even if candidate creation was incomplete.
}
const summary = {
  schema: 'bareeq.audio-acoustic-trial.v1',
  engine,
  articleId,
  fingerprint,
  status: validate.code === 0 ? 'validated' : 'validation-failed',
  generationExitCode: generate.code,
  validationExitCode: validate.code,
  publishAttempted: false,
  publishLock: env.BAREEQ_AUDIO_ENGINE_V2_PUBLISH,
  generatedAt: new Date().toISOString(),
};
await writeFile(statusFile, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exit(validate.code || 0);
