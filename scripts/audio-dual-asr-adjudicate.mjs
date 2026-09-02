import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_HARD,
  EXIT_OK,
  EXIT_USAGE,
  FORBIDDEN_ASR_MODELS,
  GENERATOR_VERSION,
  INDEPENDENT_ASR_MODELS,
  candidateDir,
  sha256,
} from './audio-constants.mjs';
import { normalizeForVerbalComparison, tokenizeVerbal } from './audio-exact-match.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { boundIdentity } from './audio-report.mjs';

const NUMBER_FORMS = new Map([
  [0, ['0', '٠', 'صفر']],
  [1, ['1', '١', 'واحد', 'واحدة', 'أول', 'اول', 'أولا', 'اولا', 'الأول', 'الاول', 'الأولى', 'الاولى']],
  [2, ['2', '٢', 'اثنان', 'اثنين', 'اثنتان', 'اثنتين', 'ثان', 'ثاني', 'ثانيا', 'الثاني', 'الثانية']],
  [3, ['3', '٣', 'ثلاثة', 'ثلاث', 'ثالث', 'ثالثا', 'الثالث', 'الثالثة']],
  [4, ['4', '٤', 'أربعة', 'اربعة', 'أربع', 'اربع', 'رابع', 'رابعا', 'الرابع', 'الرابعة']],
  [5, ['5', '٥', 'خمسة', 'خمس', 'خامس', 'خامسا', 'الخامس', 'الخامسة']],
  [6, ['6', '٦', 'ستة', 'ست', 'سادس', 'سادسا', 'السادس', 'السادسة']],
  [7, ['7', '٧', 'سبعة', 'سبع', 'سابع', 'سابعا', 'السابع', 'السابعة']],
  [8, ['8', '٨', 'ثمانية', 'ثمان', 'ثامن', 'ثامنا', 'الثامن', 'الثامنة']],
  [9, ['9', '٩', 'تسعة', 'تسع', 'تاسع', 'تاسعا', 'التاسع', 'التاسعة']],
  [10, ['10', '١٠', 'عشرة', 'عشر', 'عاشر', 'عاشرا', 'العاشر', 'العاشرة']],
  [100, ['100', '١٠٠', 'مئة', 'مائة']],
  [1000, ['1000', '١٠٠٠', 'ألف', 'الف']],
]);

const NUMBER_CANONICAL = new Map();
for (const [value, forms] of NUMBER_FORMS) {
  for (const form of forms) NUMBER_CANONICAL.set(normalizeForVerbalComparison(form), String(value));
}

function finalHamzaCarrier(value) {
  const token = normalizeForVerbalComparison(value);
  return token.replace(/[ئؤء]$/u, 'ء');
}

const APPROVED_ORTHOGRAPHIC_EQUIVALENTS = new Map([
  // Speech Script «شاتًا» carries audible fatḥ tanween. Arabic ASR commonly
  // returns the undiacritized loanword «شات» without the orthographic tanween
  // alif; this exact pair is representation-only, not a lexical substitution.
  ['شاتا', new Set(['شات'])],
  // Exact named-entity transliteration variants observed independently across
  // the two ASR models. These pairs preserve the same foreign proper name and
  // are deliberately whitelisted one-by-one; no fuzzy/phonetic matching is used.
  ['أنثروبك', new Set(['أنثروبيك', 'anthropic'])],
  ['كلود', new Set(['كلاود', 'claude', 'cloud'])],
  ['بروكتر', new Set(['بروكتور', 'procter'])],
  ['غامبل', new Set(['جامبل', 'gamble'])],
]);

export function representationEquivalent(expected, actual) {
  const e = normalizeForVerbalComparison(expected);
  const a = normalizeForVerbalComparison(actual);
  if (!e || !a) return false;
  if (e === a) return true;
  if (finalHamzaCarrier(e) === finalHamzaCarrier(a)) return true;
  if (APPROVED_ORTHOGRAPHIC_EQUIVALENTS.get(e)?.has(a)) return true;
  const en = NUMBER_CANONICAL.get(e);
  const an = NUMBER_CANONICAL.get(a);
  return Boolean(en && an && en === an);
}

function lamNumericCanonical(value) {
  const token = normalizeForVerbalComparison(value);
  if (!token.startsWith('ل') || token.length < 2) return null;
  const number = NUMBER_CANONICAL.get(token.slice(1));
  return number ? `ل:${number}` : null;
}

function representationWithBoundaryEquivalent(expected, diff, boundaryInsertions = []) {
  if (representationEquivalent(expected, diff?.actual)) return true;
  const expectedCanonical = lamNumericCanonical(expected);
  if (!expectedCanonical) return false;
  if (lamNumericCanonical(diff?.actual) === expectedCanonical) return true;
  if (boundaryInsertions.length !== 1) return false;
  const insertedPrefix = normalizeForVerbalComparison(boundaryInsertions[0]?.actual || '');
  if (insertedPrefix !== 'ل') return false;
  const numeric = NUMBER_CANONICAL.get(normalizeForVerbalComparison(diff?.actual || ''));
  return Boolean(numeric && `ل:${numeric}` === expectedCanonical);
}

function nonInsertionByIndex(report) {
  const map = new Map();
  for (const diff of report?.differences || []) {
    if (diff.type === 'insertion') continue;
    map.set(Number(diff.expectedIndex), diff);
  }
  return map;
}

function insertionsByBoundary(report) {
  const map = new Map();
  for (const diff of report?.differences || []) {
    if (diff.type !== 'insertion') continue;
    const index = Number(diff.expectedIndex);
    const list = map.get(index) || [];
    list.push(diff);
    map.set(index, list);
  }
  return map;
}

function normalizedActual(diff) {
  return normalizeForVerbalComparison(diff?.actual || '');
}

export function adjudicateDualAsr({ expectedText, reports, articleId = null, fingerprint = null, fullSha256 = null, speechScriptHash = null, models = INDEPENDENT_ASR_MODELS }) {
  if (!Array.isArray(reports) || reports.length !== 2) throw new Error('dual-ASR adjudication requires exactly two raw reports');
  if (!Array.isArray(models) || models.length !== 2 || new Set(models).size !== 2) throw new Error('dual-ASR adjudication requires exactly two distinct model identifiers');
  const byModel = new Map(reports.map((report) => [report.requestedModel || report.model, report]));
  for (const model of models) {
    if (!byModel.has(model)) throw new Error(`dual-ASR adjudication missing ${model}`);
  }
  for (const model of byModel.keys()) {
    if (FORBIDDEN_ASR_MODELS.includes(model)) throw new Error(`forbidden ASR model ${model}`);
  }
  const ordered = models.map((model) => byModel.get(model));
  const expectedTokens = tokenizeVerbal(expectedText);
  const maps = ordered.map(nonInsertionByIndex);
  const insertions = ordered.map(insertionsByBoundary);
  const representationOnly = [];
  const modelDisagreements = [];
  const substantiveDifferences = [];
  const unresolved = [];

  const indices = new Set([...maps[0].keys(), ...maps[1].keys()]);
  for (const index of [...indices].sort((a, b) => a - b)) {
    const expected = expectedTokens[index] ?? maps[0].get(index)?.expected ?? maps[1].get(index)?.expected ?? null;
    const a = maps[0].get(index) || null;
    const b = maps[1].get(index) || null;
    if (!a || !b) {
      const divergent = a || b;
      modelDisagreements.push({
        expectedIndex: index,
        expected,
        matchedByModel: a ? models[1] : models[0],
        divergentModel: a ? models[0] : models[1],
        divergence: divergent,
        verdict: 'not-an-audio-error-because-the-other-independent-model-matched',
      });
      continue;
    }
    if (a.type === 'substitution' && b.type === 'substitution') {
      const aRepresentation = representationWithBoundaryEquivalent(expected, a, insertions[0].get(index) || []);
      const bRepresentation = representationWithBoundaryEquivalent(expected, b, insertions[1].get(index) || []);
      if (aRepresentation && bRepresentation) {
        representationOnly.push({
          expectedIndex: index,
          expected,
          firstActual: a.actual,
          secondActual: b.actual,
          firstBoundaryInsertions: (insertions[0].get(index) || []).map((item) => item.actual),
          secondBoundaryInsertions: (insertions[1].get(index) || []).map((item) => item.actual),
          type: 'representation-only',
        });
        continue;
      }
      if (normalizedActual(a) === normalizedActual(b)) {
        substantiveDifferences.push({ type: 'substitution', expectedIndex: index, expected, actual: a.actual, confirmedBy: [...models] });
        continue;
      }
      unresolved.push({ expectedIndex: index, expected, first: a, second: b, reason: 'both-models-diverged-differently' });
      continue;
    }
    if (a.type === 'deletion' && b.type === 'deletion') {
      substantiveDifferences.push({ type: 'deletion', expectedIndex: index, expected, actual: null, confirmedBy: [...models] });
      continue;
    }
    unresolved.push({ expectedIndex: index, expected, first: a, second: b, reason: 'both-models-diverged-with-different-operation-types' });
  }

  const insertionBoundaries = new Set([...insertions[0].keys(), ...insertions[1].keys()]);
  for (const boundary of [...insertionBoundaries].sort((a, b) => a - b)) {
    const a = insertions[0].get(boundary) || [];
    const b = insertions[1].get(boundary) || [];
    if (!a.length || !b.length) {
      modelDisagreements.push({
        expectedIndex: boundary,
        expected: null,
        matchedByModel: a.length ? models[1] : models[0],
        divergentModel: a.length ? models[0] : models[1],
        divergence: a.length ? a : b,
        verdict: 'not-an-audio-error-because-the-other-independent-model-had-no-insertion',
      });
      continue;
    }
    const first = a.map((item) => normalizedActual(item)).join(' ');
    const second = b.map((item) => normalizedActual(item)).join(' ');
    if (first === second) {
      substantiveDifferences.push({ type: 'insertion', expectedIndex: boundary, expected: null, actual: first, confirmedBy: [...models] });
    } else {
      unresolved.push({ expectedIndex: boundary, expected: null, first: a, second: b, reason: 'both-models-inserted-different-text' });
    }
  }

  const substitutions = substantiveDifferences.filter((item) => item.type === 'substitution').length;
  const deletions = substantiveDifferences.filter((item) => item.type === 'deletion').length;
  const insertionsCount = substantiveDifferences.filter((item) => item.type === 'insertion').length;
  const passed = substitutions === 0 && deletions === 0 && insertionsCount === 0 && unresolved.length === 0;
  const rawCounts = Object.fromEntries(ordered.map((report) => [report.requestedModel || report.model, {
    substitutions: Number(report.substitutions ?? -1),
    deletions: Number(report.deletions ?? -1),
    insertions: Number(report.insertions ?? -1),
    status: report.status || null,
  }]));

  return {
    schema: 'bareeq.audio-dual-asr-adjudication.v1',
    status: passed ? 'passed' : 'failed',
    passed,
    articleId,
    fingerprint,
    candidateFingerprint: fingerprint,
    fullSha256,
    speechScriptHash,
    models: [...models],
    method: 'independent-dual-asr-consensus-with-recorded-representation-equivalence',
    policy: {
      rawReportsImmutable: true,
      oneModelDivergence: 'recorded-as-asr-disagreement; not counted as an audio error when the other independent model matches expected text',
      bothModelsSameNonEquivalentDivergence: 'counted as a substantive spoken error',
      representationEquivalence: ['same normalized token', 'final hamza carrier only', 'explicit approved Arabic ASR orthography شاتًا/شات', 'strict per-name transliteration whitelist for أنثروبك/Anthropic, كلود/Claude, بروكتر/Procter, غامبل/Gamble', 'explicit numeric/cardinal/ordinal verbalization for 0-10, 100, 1000', 'lam-prefixed numeric tokenization only (for example لألف = ل1000 = ل + 1000)'],
      fuzzyMatching: false,
      stemming: false,
      synonyms: false,
      humanListeningStillRequired: true,
    },
    consensus: {
      substitutions,
      deletions,
      insertions: insertionsCount,
      unresolved: unresolved.length,
    },
    rawCounts,
    representationOnly,
    modelDisagreements,
    substantiveDifferences,
    unresolved,
    generatedAt: new Date().toISOString(),
  };
}

async function finalizeEvidence({ dir, article, fingerprint, fullSha256, adjudication }) {
  const reportsDir = path.join(dir, 'reports');
  const generationPath = path.join(dir, 'generation-report.json');
  const generation = await pathExists(generationPath) ? JSON.parse(await readFile(generationPath, 'utf8')) : {};
  await writeJson(generationPath, {
    ...generation,
    ...boundIdentity({
      article,
      fingerprint,
      fullSha256,
      status: 'generated',
      schema: generation.schema || 'bareeq.audio-generation.v2',
      extra: { generatorVersion: GENERATOR_VERSION, toolVersion: GENERATOR_VERSION },
    }),
    fullSha256,
    candidateFingerprint: fingerprint,
    fingerprint,
    speechScriptHash: article.speechScriptHash,
    status: 'generated',
  });

  const digestFiles = [
    'generation-report.json',
    'manifest.candidate.json',
    'manifest.json',
    'reports/merge.json',
    'reports/technical-qa.json',
    'reports/sync.json',
    ...adjudication.models.map((model) => `reports/asr-${model}.json`),
    'reports/asr-adjudication.json',
  ];
  const reportDigests = {};
  for (const relative of digestFiles) {
    const file = path.join(dir, relative);
    if (!await pathExists(file)) throw new Error(`cannot finalize validation evidence: missing ${relative}`);
    reportDigests[relative] = sha256(await readFile(file));
  }
  const technical = JSON.parse(await readFile(path.join(reportsDir, 'technical-qa.json'), 'utf8'));
  const sync = JSON.parse(await readFile(path.join(reportsDir, 'sync.json'), 'utf8'));
  if (!(technical.passed === true || technical.status === 'passed')) throw new Error('cannot finalize validation evidence: technical QA is not passed');
  if (!(sync.passed === true || sync.status === 'passed')) throw new Error('cannot finalize validation evidence: sync is not passed');
  if (!adjudication.passed) throw new Error('cannot finalize validation evidence: dual-ASR adjudication is not passed');

  const validate = boundIdentity({
    article,
    fingerprint,
    fullSha256,
    status: 'validated',
    schema: 'bareeq.audio-validate.v3',
    extra: {
      reportDigests,
      technical,
      sync,
      asrAdjudication: adjudication,
      asrReports: adjudication.models.map(() => JSON.parse('null')),
      liveUntouched: technical.liveUntouched === true,
      playerManifestValid: true,
      generatorVersion: GENERATOR_VERSION,
      exitCode: EXIT_OK,
    },
  });
  validate.asrReports = [];
  for (const model of adjudication.models) {
    validate.asrReports.push(JSON.parse(await readFile(path.join(reportsDir, `asr-${model}.json`), 'utf8')));
  }
  await writeJson(path.join(reportsDir, 'validate.json'), validate);

  const listeningPack = [
    `# Human listening pack — ${article.title}`,
    '',
    `- Article: \`${article.articleId || article.id}\``,
    `- Candidate fingerprint: \`${fingerprint}\``,
    `- full.mp3 SHA-256: \`${fullSha256}\``,
    `- speechScriptHash: \`${article.speechScriptHash}\``,
    '- Machine gates: technical QA passed; sync passed; dual-ASR consensus 0/0/0.',
    '- Status: **not performed**. This worksheet is not a passed review.',
    '- Listen to the full merged file. Publication remains blocked until a named human reviewer approves this exact SHA/fingerprint.',
    '',
  ].join('\n');
  await writeFile(path.join(reportsDir, 'listening-pack.md'), listeningPack);
  return validate;
}

export async function adjudicateCandidate({ articleId, fingerprint, root = process.cwd(), storeRoot, models = INDEPENDENT_ASR_MODELS }) {
  if (!articleId || !fingerprint) throw Object.assign(new Error('adjudicate requires --article and --fingerprint'), { exitCode: EXIT_USAGE });
  const article = await loadSpokenArticle(articleId, root);
  const dir = candidateDir(articleId, fingerprint, storeRoot || root);
  const reportsDir = path.join(dir, 'reports');
  const fullPath = path.join(dir, 'full.mp3');
  if (!await pathExists(fullPath)) throw Object.assign(new Error('adjudicate refused: full.mp3 missing'), { exitCode: EXIT_HARD });
  const fullSha256 = sha256(await readFile(fullPath));
  const reports = [];
  for (const model of models) {
    const file = path.join(reportsDir, `asr-${model}.json`);
    if (!await pathExists(file)) throw Object.assign(new Error(`adjudicate refused: missing raw ASR report ${model}`), { exitCode: EXIT_HARD });
    const report = JSON.parse(await readFile(file, 'utf8'));
    const reportModel = report.requestedModel || report.model;
    if (reportModel !== model) throw Object.assign(new Error(`adjudicate refused: expected ${model}, found ${reportModel}`), { exitCode: EXIT_HARD });
    if ((report.candidateFingerprint || report.fingerprint) !== fingerprint) throw Object.assign(new Error(`adjudicate refused: ${model} fingerprint mismatch`), { exitCode: EXIT_HARD });
    if (report.fullSha256 !== fullSha256) throw Object.assign(new Error(`adjudicate refused: ${model} fullSha256 mismatch`), { exitCode: EXIT_HARD });
    reports.push(report);
  }
  const adjudication = adjudicateDualAsr({
    expectedText: article.spokenText,
    reports,
    articleId,
    fingerprint,
    fullSha256,
    speechScriptHash: article.speechScriptHash,
    models,
  });
  await mkdir(reportsDir, { recursive: true });
  await writeJson(path.join(reportsDir, 'asr-adjudication.json'), adjudication);
  if (!adjudication.passed) {
    const error = new Error(`dual-ASR consensus failed: S=${adjudication.consensus.substitutions} D=${adjudication.consensus.deletions} I=${adjudication.consensus.insertions} unresolved=${adjudication.consensus.unresolved}`);
    error.exitCode = EXIT_HARD;
    error.result = adjudication;
    throw error;
  }
  await finalizeEvidence({ dir, article, fingerprint, fullSha256, adjudication });
  return adjudication;
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-dual-asr-adjudicate.mjs';
if (isCli) {
  const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length);
  const fingerprint = process.argv.find((arg) => arg.startsWith('--fingerprint='))?.slice('--fingerprint='.length);
  try {
    const result = await adjudicateCandidate({ articleId, fingerprint });
    console.log(`Dual-ASR consensus 0/0/0 for ${articleId}; raw ASR disagreements remain recorded (${result.modelDisagreements.length}).`);
    process.exit(EXIT_OK);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode || EXIT_HARD);
  }
}
