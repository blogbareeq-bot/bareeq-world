import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertTtsUnfrozen, readTtsFreeze, ttsIsFrozen } from './audio-tts-freeze-guard.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'bareeq-tts-freeze-'));
const file = path.join(dir, 'freeze.json');
await writeFile(file, JSON.stringify({ schema:'bareeq.audio-tts-freeze.v1', active:true, reason:'test' }));
assert.equal(await ttsIsFrozen(file), true);
assert.equal((await readTtsFreeze(file)).reason, 'test');
await assert.rejects(() => assertTtsUnfrozen({ file, operation:'unit-test' }), (error) => error?.code === 'BAREEQ_TTS_FROZEN');
await writeFile(file, JSON.stringify({ schema:'bareeq.audio-tts-freeze.v1', active:false }));
assert.equal(await ttsIsFrozen(file), false);
await assertTtsUnfrozen({ file, operation:'unit-test' });
console.log('TTS freeze guard tests passed: active freeze blocks synthesis and inactive state permits it.');
