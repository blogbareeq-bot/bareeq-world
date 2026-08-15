import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const resultsArg = process.argv[2];
if (!resultsArg) throw new Error('Usage: npm run voice:lab:reveal -- /absolute/path/to/bareeq-voice-lab-results.json');
const resultsFile = path.resolve(ROOT, resultsArg);
const keyFile = path.join(ROOT, '.voice-lab', 'answer-key.json');
const labFile = path.join(ROOT, '.voice-lab', 'site', 'lab.json');
const [results, key, lab] = await Promise.all([
  readFile(resultsFile, 'utf8').then(JSON.parse),
  readFile(keyFile, 'utf8').then(JSON.parse),
  readFile(labFile, 'utf8').then(JSON.parse),
]);
if (!results.labId || results.labId !== key.labId || results.labId !== lab.labId) throw new Error('Results belong to a different Voice Lab build.');

const mapping = new Map();
for (const testCase of key.cases || []) {
  for (const answer of testCase.answers || []) mapping.set(`${testCase.id}:${answer.code}`, answer);
}
const aggregates = new Map();
for (const candidate of key.candidates || []) {
  aggregates.set(candidate.id, {
    ...candidate,
    wins: 0,
    scoredCases: 0,
    scores: Object.fromEntries(lab.criteria.map((criterion) => [criterion.id, { sum: 0, count: 0 }])),
  });
}

for (const [caseId, voices] of Object.entries(results.ratings || {})) {
  for (const [code, rating] of Object.entries(voices || {})) {
    const answer = mapping.get(`${caseId}:${code}`);
    const aggregate = answer ? aggregates.get(answer.candidateId) : null;
    if (!aggregate) continue;
    let caseHasScore = false;
    for (const criterion of lab.criteria) {
      const value = Number(rating.scores?.[criterion.id]);
      if (!(value >= 1 && value <= 5)) continue;
      aggregate.scores[criterion.id].sum += value;
      aggregate.scores[criterion.id].count += 1;
      caseHasScore = true;
    }
    if (caseHasScore) aggregate.scoredCases += 1;
  }
}
for (const [caseId, code] of Object.entries(results.winners || {})) {
  const answer = mapping.get(`${caseId}:${code}`);
  if (answer && aggregates.has(answer.candidateId)) aggregates.get(answer.candidateId).wins += 1;
}

const ranking = [...aggregates.values()].map((aggregate) => {
  const criterionAverages = {};
  let total = 0;
  let count = 0;
  for (const criterion of lab.criteria) {
    const score = aggregate.scores[criterion.id];
    const average = score.count ? score.sum / score.count : null;
    criterionAverages[criterion.id] = average == null ? null : Number(average.toFixed(3));
    if (average != null) { total += score.sum; count += score.count; }
  }
  return {
    candidateId: aggregate.id,
    provider: aggregate.provider,
    model: aggregate.model,
    voice: aggregate.voice,
    language: aggregate.language,
    wins: aggregate.wins,
    scoredCases: aggregate.scoredCases,
    overallAverage: count ? Number((total / count).toFixed(3)) : null,
    criterionAverages,
  };
}).sort((a, b) => (b.overallAverage ?? -1) - (a.overallAverage ?? -1) || b.wins - a.wins);

const output = {
  schemaVersion: 1,
  labId: lab.labId,
  revealedAt: new Date().toISOString(),
  sourceResults: path.basename(resultsFile),
  completion: results.completion || null,
  criteria: lab.criteria,
  ranking,
};
const outputFile = path.join(ROOT, '.voice-lab', 'revealed-results.json');
await writeFile(outputFile, JSON.stringify(output, null, 2) + '\n');
console.table(ranking.map((item, index) => ({
  rank: index + 1,
  provider: item.provider,
  model: item.model,
  voice: item.voice,
  average: item.overallAverage ?? '—',
  wins: item.wins,
})));
console.log(`Revealed ranking written to ${path.relative(ROOT, outputFile)}.`);
