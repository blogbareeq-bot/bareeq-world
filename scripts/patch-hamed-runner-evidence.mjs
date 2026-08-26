import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const runnerFile = 'scripts/run-hamed-final-production-v3.mjs';
const pilotFile = 'scripts/speech-test-evidence/how-touchscreens-work-hamed-corrected-final-pilot-v1.mp3';
const expectedPilotSha = '78ed2a90885a629903426727c1aa22fd70770f073b638cdec9e8b01cd97cbe71';
const audio = await readFile(pilotFile);
const actualPilotSha = createHash('sha256').update(audio).digest('hex');
if (actualPilotSha !== expectedPilotSha) throw new Error(`Corrected Hamed pilot SHA mismatch: ${actualPilotSha}`);

let source = await readFile(runnerFile, 'utf8');
const oldBlock = `evidence: {
      humanListening: false,
      approvalBasis: 'User authorized continuation through publication after exact automated transcript validation.',
    },`;
const newBlock = `evidence: {
      file: 'scripts/speech-test-evidence/how-touchscreens-work-hamed-corrected-final-pilot-v1.mp3',
      sha256: '78ed2a90885a629903426727c1aa22fd70770f073b638cdec9e8b01cd97cbe71',
      provider: 'Microsoft Azure AI Speech',
      model: 'Neural TTS',
      voice: 'ar-SA-HamedNeural',
      automatedTranscriptReport: 'scripts/speech-transcript-evidence/how-touchscreens-work-hamed-corrected-gemini36-independent-final.json',
      transcriptionModel: 'gemini-3.6-flash',
      wordErrorCount: 0,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      humanListening: false,
      approvalBasis: 'User authorized continuation through publication after exact automated transcript validation.',
    },`;
if (!source.includes(oldBlock)) throw new Error('Ephemeral Hamed evidence marker was not found exactly once.');
if (source.split(oldBlock).length !== 2) throw new Error('Ephemeral Hamed evidence marker is ambiguous.');
source = source.replace(oldBlock, newBlock);
await writeFile(runnerFile, source);
console.log(`HAMED_RUNNER_EVIDENCE_PATCH=PASS pilotSha=${actualPilotSha}`);
