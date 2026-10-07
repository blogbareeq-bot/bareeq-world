import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {promoteHumanExact} from './audio-promote-human-exact.mjs';
const paths=['docs/audio/ENGINE-STRATEGY-STATE.json','docs/audio/TTS-FREEZE.json','docs/audio/PROGRESSIVE-STATUS.json','docs/audio/PUBLISHED-SADALTAGER-PARTIAL-20260903.json'];
const before=await Promise.all(paths.map(p=>readFile(p,'utf8')));
assert.ok(JSON.parse(before[2]).exactCount>=9);
await assert.rejects(()=>promoteHumanExact({root:process.cwd(),triageRoot:'must-never-be-read'}),/Historical 7-to-9 promotion refused/);
assert.deepEqual(await Promise.all(paths.map(p=>readFile(p,'utf8'))),before);
console.log('Historical promotion replay blocked before artifact access; canonical accounting and publication records unchanged.');
