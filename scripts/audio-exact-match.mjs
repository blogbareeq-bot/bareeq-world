/**
 * Exact spoken-text comparison for dual ASR.
 *
 * Allowed normalization is intentionally narrow and documented:
 *   - Unicode NFC then NFKC
 *   - strip Arabic diacritics for *verbal* comparison only
 *   - remove tatweel
 *   - ignore punctuation
 *   - collapse whitespace
 *
 * Forbidden: stemming, fuzzy matching, synonyms, equivalence groups,
 * or any rewrite that can hide a substitution/deletion/insertion.
 */

const DIACRITICS_PATTERN = /[\u064B-\u065F\u0670\u06D6-\u06ED]/gu;

export const EXACT_MATCH_NORMALIZATION = {
  version: 1,
  steps: [
    'unicode-nfc',
    'strip-arabic-diacritics',
    'unicode-nfkc',
    'remove-tatweel',
    'drop-punctuation',
    'collapse-whitespace',
    'lowercase',
  ],
  forbidden: [
    'stemming',
    'fuzzy-matching',
    'synonyms',
    'equivalence-groups',
    'unrecorded-rewrites',
  ],
};

export function normalizeForVerbalComparison(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(DIACRITICS_PATTERN, '')
    .normalize('NFKC')
    .replace(/[“”«»"'`]/g, '')
    .replace(/[،؛:,.!?؟…()[\]{}\-–—/\\|]/g, ' ')
    .replace(/ـ/g, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function tokenizeVerbal(value) {
  return normalizeForVerbalComparison(value).split(/\s+/u).filter(Boolean);
}

export function compareExactTokens(expectedTokens, actualTokens) {
  const E = expectedTokens;
  const A = actualTokens;
  const dp = Array.from({ length: E.length + 1 }, () => new Uint32Array(A.length + 1));
  for (let i = 0; i <= E.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= A.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= E.length; i += 1) {
    for (let j = 1; j <= A.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (E[i - 1] === A[j - 1] ? 0 : 1),
      );
    }
  }

  let i = E.length;
  let j = A.length;
  const differences = [];
  while (i || j) {
    if (i && j && E[i - 1] === A[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      i -= 1;
      j -= 1;
      continue;
    }
    if (i && j && dp[i][j] === dp[i - 1][j - 1] + 1) {
      differences.push({ type: 'substitution', expected: E[i - 1], actual: A[j - 1], expectedIndex: i - 1, actualIndex: j - 1 });
      i -= 1;
      j -= 1;
      continue;
    }
    if (i && dp[i][j] === dp[i - 1][j] + 1) {
      differences.push({ type: 'deletion', expected: E[i - 1], actual: null, expectedIndex: i - 1, actualIndex: j });
      i -= 1;
      continue;
    }
    differences.push({ type: 'insertion', expected: null, actual: A[j - 1], expectedIndex: i, actualIndex: j - 1 });
    j -= 1;
  }
  differences.reverse();

  const substitutions = differences.filter((item) => item.type === 'substitution').length;
  const deletions = differences.filter((item) => item.type === 'deletion').length;
  const insertions = differences.filter((item) => item.type === 'insertion').length;
  return {
    expectedTokens: E.length,
    transcriptTokens: A.length,
    substitutions,
    deletions,
    insertions,
    passed: substitutions === 0 && deletions === 0 && insertions === 0,
    differences,
    normalization: EXACT_MATCH_NORMALIZATION,
  };
}

export function compareExactSpokenText(expected, actual) {
  return compareExactTokens(tokenizeVerbal(expected), tokenizeVerbal(actual));
}

export function assertIndependentAsrModels(models, { allowed = ['gemini-3.5-transcribe', 'gemini-3.6-flash'], forbidden = ['gemini-3.6-transcribe'] } = {}) {
  const unique = [...new Set((models || []).filter(Boolean))];
  for (const model of unique) {
    if (forbidden.includes(model)) throw new Error(`${model} is forbidden and is not an independent ASR model.`);
    if (allowed.length && !allowed.includes(model)) throw new Error(`${model} is not in the independent ASR pair.`);
  }
  if (unique.length < 2) {
    throw new Error('Independent ASR requires two distinct model identifiers.');
  }
  if (unique.length === 1) {
    throw new Error('Calling the same ASR model twice is not an independent check.');
  }
  return unique;
}
