#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertNoAutomaticRegeneration, evaluateTranscriptionQa } from './audio-transcription-qa-core.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const expectedFile = arg('expected');
const pass1File = arg('pass1');
const pass2File = arg('pass2');
const outputFile = arg('output', 'qa/audio-transcription-qa-result.json');
const configFile = arg('equivalences', 'scripts/audio-transcription-equivalences.json');
const enforce = process.argv.includes('--enforce');

if (!expectedFile || !pass1File) {
  throw new Error('Usage: node scripts/audio-transcription-qa-cli.mjs --expected FILE --pass1 FILE [--pass2 FILE] [--output FILE] [--enforce]');
}

const [expected, pass1, config] = await Promise.all([
  readFile(resolve(expectedFile), 'utf8'),
  readFile(resolve(pass1File), 'utf8'),
  readFile(resolve(configFile), 'utf8').then(JSON.parse),
]);
const pass2 = pass2File ? await readFile(resolve(pass2File), 'utf8') : null;
const result = evaluateTranscriptionQa({ expected, pass1, pass2, equivalenceConfig: config });
assertNoAutomaticRegeneration(result);
await writeFile(resolve(outputFile), `${JSON.stringify(result, null, 2)}\n`);
console.log(`Audio transcription QA: ${result.status}; similarity=${result.final.similarityPercent}%; edits=${result.final.editDistance}`);
if (result.verificationVocabulary.length) console.log(`Targeted vocabulary: ${result.verificationVocabulary.join(', ')}`);
if (result.persistentDifferences.length) console.log(JSON.stringify(result.persistentDifferences));
if (enforce && !result.publicationAllowed) process.exitCode = 2;
