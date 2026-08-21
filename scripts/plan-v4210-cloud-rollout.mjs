import { spawnSync } from 'node:child_process';
import { PENDING_CLOUD } from './cloud-tts-rollout.mjs';

const result = spawnSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    BAREEQ_TTS_PROVIDER: 'google-cloud',
    BAREEQ_TTS_INCLUDE_IDS: PENDING_CLOUD.join(','),
    BAREEQ_CLOUD_TTS_ACTIVATE: '',
    GOOGLE_CLOUD_ACCESS_TOKEN: '',
    GOOGLE_SERVICE_ACCOUNT_JSON: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
  },
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Cloud TTS plan exited with status ${result.status ?? 'unknown'}`);
console.log('V4.21.0 Cloud TTS plan completed without credentials, activation, or synthesis requests.');
