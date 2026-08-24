import { spawnSync } from 'node:child_process';
import { PENDING_CLOUD } from './cloud-tts-rollout.mjs';

const result = spawnSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    BAREEQ_TTS_PROVIDER: 'gemini',
    BAREEQ_TTS_INCLUDE_IDS: PENDING_CLOUD.join(','),
  },
  maxBuffer: 4 * 1024 * 1024,
});

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const output = result.stdout || '';
if (!output.includes(`Sadaltager rollout plan: ${PENDING_CLOUD.length} selected article(s)`)) {
  throw new Error(`V4.21.1 pending Gemini plan did not select the exact ${PENDING_CLOUD.length}-article backlog.`);
}

process.stdout.write(output);
console.log('V4.21.1 free-tier plan completed with 0 API requests. A production build attempts at most one unresolved article; completed recordings are restored before any synthesis.');
