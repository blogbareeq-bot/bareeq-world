import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const file = 'scripts/audio-dual-asr-adjudicate.mjs';
let source = await readFile(file, 'utf8');

const anchorA = "  const substantiveDifferences = [];\n  const unresolved = [];\n";
const patchA = "  const substantiveDifferences = [];\n  const unresolved = [];\n  // In a strictly accepted lam+numeric tokenization (for example لألف = ل + 1000),\n  // the detached lam is part of that representation, not an extra spoken token.\n  const representationConsumedInsertionBoundaries = [new Set(), new Set()];\n";
if (!source.includes(patchA)) {
  assert.ok(source.includes(anchorA), 'adjudicator patch anchor A missing');
  source = source.replace(anchorA, patchA);
}

const anchorB = "      if (aRepresentation && bRepresentation) {\n        representationOnly.push({";
const patchB = "      if (aRepresentation && bRepresentation) {\n        const expectedLamNumeric = lamNumericCanonical(expected);\n        for (const [modelIndex, diff] of [[0, a], [1, b]]) {\n          const boundaryItems = insertions[modelIndex].get(index) || [];\n          const actualNumeric = NUMBER_CANONICAL.get(normalizedActual(diff));\n          if (expectedLamNumeric && boundaryItems.length === 1 && normalizedActual(boundaryItems[0]) === 'ل' && actualNumeric && `ل:${actualNumeric}` === expectedLamNumeric) {\n            representationConsumedInsertionBoundaries[modelIndex].add(index);\n          }\n        }\n        representationOnly.push({";
if (!source.includes(patchB)) {
  assert.ok(source.includes(anchorB), 'adjudicator patch anchor B missing');
  source = source.replace(anchorB, patchB);
}

const anchorC = "    const a = insertions[0].get(boundary) || [];\n    const b = insertions[1].get(boundary) || [];\n    if (!a.length || !b.length) {";
const patchC = "    const a = insertions[0].get(boundary) || [];\n    const b = insertions[1].get(boundary) || [];\n    if (representationConsumedInsertionBoundaries[0].has(boundary) && representationConsumedInsertionBoundaries[1].has(boundary)) {\n      continue;\n    }\n    if (!a.length || !b.length) {";
if (!source.includes(patchC)) {
  assert.ok(source.includes(anchorC), 'adjudicator patch anchor C missing');
  source = source.replace(anchorC, patchC);
}

await writeFile(file, source);

const { adjudicateDualAsr } = await import(`./audio-dual-asr-adjudicate.mjs?repair=${Date.now()}`);
const { INDEPENDENT_ASR_MODELS } = await import('./audio-constants.mjs');
const reports = INDEPENDENT_ASR_MODELS.map((model) => ({
  model,
  requestedModel: model,
  substitutions: 1,
  deletions: 0,
  insertions: 1,
  status: 'failed',
  differences: [
    { type: 'insertion', expected: null, actual: 'ل', expectedIndex: 0, actualIndex: 0 },
    { type: 'substitution', expected: 'لألف', actual: '1000', expectedIndex: 0, actualIndex: 1 },
  ],
}));
const represented = adjudicateDualAsr({ expectedText: 'لألف ريال', reports });
assert.equal(represented.passed, true);
assert.deepEqual(represented.consensus, { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 });
assert.equal(represented.representationOnly.length, 1);
assert.equal(represented.substantiveDifferences.length, 0);

const stray = structuredClone(reports);
for (const report of stray) {
  report.differences.push({ type: 'insertion', expected: null, actual: 'ل', expectedIndex: 1, actualIndex: 2 });
}
const strayResult = adjudicateDualAsr({ expectedText: 'لألف ريال', reports: stray });
assert.equal(strayResult.passed, false);
assert.equal(strayResult.consensus.insertions, 1);

console.log('LAM_NUMERIC_BOUNDARY_REPAIR=PASS representation_only=yes stray_insertion_still_fails=yes');
