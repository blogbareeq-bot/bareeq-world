export const ARABIC_TRANSCRIPT_COMPARISON_PROFILE = 'arabic-lexical-exact-v1';

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function normalizeDigits(value) {
  return [...value].map((character) => {
    const arabicIndic = ARABIC_INDIC_DIGITS.indexOf(character);
    if (arabicIndic >= 0) return String(arabicIndic);
    const easternArabic = EASTERN_ARABIC_DIGITS.indexOf(character);
    if (easternArabic >= 0) return String(easternArabic);
    return character;
  }).join('');
}

export function normalizeArabicTranscript(value) {
  if (typeof value !== 'string') throw new TypeError('Transcript must be a string.');
  let normalized = value
    .normalize('NFKC')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/\p{M}/gu, '')
    .replace(/\u0640/gu, '')
    .toLowerCase();
  normalized = normalizeDigits(normalized)
    .replace(/\boled\b/gu, ' اوليد ')
    .replace(/\blcd\b/gu, ' ال سي دي ')
    .replace(/\bx\b/gu, ' اكس ')
    .replace(/\by\b/gu, ' واي ')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized;
}

export function transcriptTokens(value) {
  const normalized = normalizeArabicTranscript(value);
  return normalized ? normalized.split(' ') : [];
}

export function diffTranscriptTokens(expectedTokens, actualTokens) {
  const rows = expectedTokens.length + 1;
  const columns = actualTokens.length + 1;
  const distance = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let row = 0; row < rows; row += 1) distance[row][0] = row;
  for (let column = 0; column < columns; column += 1) distance[0][column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = distance[row - 1][column - 1] + (expectedTokens[row - 1] === actualTokens[column - 1] ? 0 : 1);
      const deletion = distance[row - 1][column] + 1;
      const insertion = distance[row][column - 1] + 1;
      distance[row][column] = Math.min(substitution, deletion, insertion);
    }
  }

  const operations = [];
  let row = expectedTokens.length;
  let column = actualTokens.length;
  while (row > 0 || column > 0) {
    if (row > 0 && column > 0 && expectedTokens[row - 1] === actualTokens[column - 1]
      && distance[row][column] === distance[row - 1][column - 1]) {
      row -= 1;
      column -= 1;
      continue;
    }
    if (row > 0 && column > 0 && distance[row][column] === distance[row - 1][column - 1] + 1) {
      operations.push({ type: 'substitution', expected: expectedTokens[row - 1], actual: actualTokens[column - 1], expectedIndex: row - 1, actualIndex: column - 1 });
      row -= 1;
      column -= 1;
      continue;
    }
    if (row > 0 && distance[row][column] === distance[row - 1][column] + 1) {
      operations.push({ type: 'deletion', expected: expectedTokens[row - 1], actual: null, expectedIndex: row - 1, actualIndex: column });
      row -= 1;
      continue;
    }
    operations.push({ type: 'insertion', expected: null, actual: actualTokens[column - 1], expectedIndex: row, actualIndex: column - 1 });
    column -= 1;
  }
  operations.reverse();
  return { distance: distance[expectedTokens.length][actualTokens.length], operations };
}

export function compareArabicTranscripts(expected, actual) {
  const expectedNormalized = normalizeArabicTranscript(expected);
  const actualNormalized = normalizeArabicTranscript(actual);
  const expectedTokens = expectedNormalized ? expectedNormalized.split(' ') : [];
  const actualTokens = actualNormalized ? actualNormalized.split(' ') : [];
  const diff = diffTranscriptTokens(expectedTokens, actualTokens);
  const substitutions = diff.operations.filter((operation) => operation.type === 'substitution').length;
  const deletions = diff.operations.filter((operation) => operation.type === 'deletion').length;
  const insertions = diff.operations.filter((operation) => operation.type === 'insertion').length;
  return {
    exact: diff.distance === 0,
    expectedNormalized,
    actualNormalized,
    expectedWordCount: expectedTokens.length,
    actualWordCount: actualTokens.length,
    wordErrorCount: diff.distance,
    substitutions,
    deletions,
    insertions,
    operations: diff.operations,
  };
}
