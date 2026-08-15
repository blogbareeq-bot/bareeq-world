import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('public/scripts/audio-core.js', 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: 'audio-core.js' });
const core = sandbox.window.BareeqAudioCore;
if (!core) throw new Error('BareeqAudioCore was not initialized.');

const now = Date.UTC(2026, 7, 15, 12, 0, 0);
const valid = { voiceId: 'cedar', partIndex: 0, time: 42.25, updatedAt: now - core.POSITION_RETENTION_MS + 1 };
if (!core.isSavedProgressValid(valid, 1, now)) throw new Error('A listening position inside the 30-day window was rejected.');
if (core.isSavedProgressValid({ ...valid, updatedAt: now - core.POSITION_RETENTION_MS - 1 }, 1, now)) throw new Error('A listening position older than 30 days was accepted.');
if (core.isSavedProgressValid({ ...valid, updatedAt: now + 1 }, 1, now)) throw new Error('A future-dated listening position was accepted.');
if (core.isSavedProgressValid({ ...valid, partIndex: 1 }, 1, now) || core.isSavedProgressValid({ ...valid, time: -1 }, 1, now) || core.isSavedProgressValid({ ...valid, time: 'not-a-number' }, 1, now)) throw new Error('Malformed listening progress was accepted.');

const single = core.resolveArticleSeek([281.088], 140.544);
if (single.partIndex !== 0 || Math.abs(single.seconds - 140.544) > 0.001 || Math.abs(single.total - 281.088) > 0.001) throw new Error('Single-track Cedar seek calculation is incorrect.');
const multiple = core.resolveArticleSeek([10, 20, 30], 45);
if (multiple.partIndex !== 2 || multiple.seconds !== 15 || multiple.total !== 60) throw new Error('Multi-part seek calculation is incorrect.');
if (core.formatClock(281.088) !== '4:41' || core.formatClock(0) !== '0:00') throw new Error('Player clock formatting is incorrect.');

console.log('Audio state audit passed: exact 30-day retention boundary, invalid-state rejection, single/multi-track seeking, and 4:41 Cedar clock formatting.');
