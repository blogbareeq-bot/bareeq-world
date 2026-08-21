import { writeFile } from 'node:fs/promises';
import {
  CLOUD_TTS_STYLE,
  assertCloudTtsActivation,
  buildCloudTtsRequest,
  extractCloudTtsMp3,
  getCloudTtsAccessToken,
} from './cloud-tts.mjs';

if (!process.argv.includes('--live')) {
  throw new Error('Live Cloud TTS smoke test is locked. Re-run with --live only after CNTXT billing, API, IAM, credentials, and BAREEQ_CLOUD_TTS_ACTIVATE=1 are confirmed. No request was sent.');
}
assertCloudTtsActivation(process.env, false);

const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || 'bareeq-tts';
const accessToken = await getCloudTtsAccessToken(process.env);
const { url, options } = buildCloudTtsRequest({
  env: process.env,
  accessToken,
  projectId,
  prompt: CLOUD_TTS_STYLE,
  text: 'مرحبًا بك في عالم بريق. هذه عيّنة قصيرة للتحقق من وضوح الصوت العربي واتساق نبرة الراوي.',
  userAgent: 'Bareeq-Cloud-TTS-Smoke/4.21.0',
});
const response = await fetch(url, options);
let payload;
try { payload = await response.json(); }
catch { payload = null; }
if (!response.ok) throw new Error(`Google Cloud TTS smoke test failed (HTTP ${response.status}): ${String(payload?.error?.message || 'invalid response').slice(0, 400)}`);
const audio = extractCloudTtsMp3(payload);
const output = 'cloud-tts-smoke.mp3';
await writeFile(output, audio);
console.log(`Google Cloud TTS live smoke passed: wrote ${output} (${audio.length} bytes). Review the audio manually before activating the 11-article rollout.`);
