import assert from 'node:assert/strict';
import { successfulFromLog } from './audio-gate5-finalize-accounting.mjs';
assert.equal(successfulFromLog(''),0);
assert.equal(successfulFromLog('PROGRESSIVE_REPAIR_TTS_OK part=4 transport=x attempt=1'),1);
assert.equal(successfulFromLog('PROGRESSIVE_REPAIR_SUMMARY exact=7/15 tts={"sent":1,"successful":1,"quotaRejected":0}'),1);
assert.equal(successfulFromLog('PROGRESSIVE_REPAIR_TTS_OK x\nPROGRESSIVE_REPAIR_SUMMARY exact=7/15 tts={"successful":1}'),1);
console.log('Gate 5 accounting tests passed.');
