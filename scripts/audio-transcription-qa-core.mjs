const DIACRITICS_PATTERN = /[\u064B-\u065F\u0670\u06D6-\u06ED]/gu;
const ARABIC_LETTER_PATTERN = /[\u0621-\u064A]/u;

export function normalizeBase(value) {
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

function normalizeEquivalenceConfig(config) {
  if (!config || config.version !== 1 || !Array.isArray(config.groups)) {
    throw new Error('Invalid audio transcription equivalence config.');
  }
  const normalizedGroups = config.groups.map((group) => {
    if (!group?.id || !Array.isArray(group.forms) || group.forms.length < 2) {
      throw new Error('Each equivalence group requires id and at least two forms.');
    }
    const forms = [...new Set(group.forms.map(normalizeBase).filter(Boolean))];
    if (forms.length < 2) throw new Error(`Equivalence group ${group.id} has fewer than two distinct normalized forms.`);
    return {
      id: String(group.id),
      canonical: normalizeBase(group.canonical || group.id),
      forms,
    };
  });
  return normalizedGroups;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyEquivalences(normalizedText, config) {
  let output = normalizeBase(normalizedText);
  const groups = normalizeEquivalenceConfig(config);
  const hits = [];
  const replacements = [];

  for (const group of groups) {
    for (const form of group.forms) replacements.push({ group, form });
  }
  replacements.sort((a, b) => b.form.length - a.form.length);

  for (const { group, form } of replacements) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(form)}(?=\\s|$)`, 'gu');
    let count = 0;
    output = output.replace(pattern, (match, prefix) => {
      count += 1;
      return `${prefix}__eq_${group.id}__`;
    });
    if (count) hits.push({ groupId: group.id, form, count });
  }

  return { text: output.replace(/\s+/gu, ' ').trim(), hits };
}

export function tokenize(value) {
  return normalizeBase(value).split(/\s+/u).filter(Boolean);
}

export function compareTokenArrays(expectedTokens, actualTokens) {
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
  const editDistance = dp[E.length][A.length];
  const wer = E.length ? editDistance / E.length : (A.length ? 1 : 0);
  return {
    expectedTokens: E.length,
    transcriptTokens: A.length,
    editDistance,
    wer: Number(wer.toFixed(6)),
    similarityPercent: Number(((1 - Math.min(1, wer)) * 100).toFixed(2)),
    differences,
  };
}

export function compareTexts(expected, actual, equivalenceConfig) {
  const expectedBase = normalizeBase(expected);
  const actualBase = normalizeBase(actual);
  const base = compareTokenArrays(tokenize(expectedBase), tokenize(actualBase));
  const expectedEq = applyEquivalences(expectedBase, equivalenceConfig);
  const actualEq = applyEquivalences(actualBase, equivalenceConfig);
  const canonical = compareTokenArrays(tokenize(expectedEq.text), tokenize(actualEq.text));
  return {
    base,
    canonical,
    equivalenceHits: { expected: expectedEq.hits, actual: actualEq.hits },
  };
}

export function targetedVocabulary(differences) {
  return [...new Set(
    differences
      .map((item) => item.expected)
      .filter((token) => token && ARABIC_LETTER_PATTERN.test(token) && token.length >= 2),
  )].slice(0, 20);
}

function baseDecision(status, extra = {}) {
  return {
    status,
    publicationAllowed: false,
    automaticRegenerationAllowed: false,
    humanReviewRequired: false,
    targetedVerificationRequired: false,
    ...extra,
  };
}

export function evaluateTranscriptionQa({ expected, pass1, pass2 = null, equivalenceConfig }) {
  const first = compareTexts(expected, pass1, equivalenceConfig);

  if (first.canonical.editDistance === 0) {
    if (first.base.editDistance === 0) {
      return {
        ...baseDecision('PASS_EXACT', { publicationAllowed: true }),
        pass1: first,
        pass2: null,
        final: first.canonical,
        persistentDifferences: [],
        verificationVocabulary: [],
      };
    }
    return {
      ...baseDecision('PASS_EQUIVALENT', { publicationAllowed: true }),
      pass1: first,
      pass2: null,
      final: first.canonical,
      persistentDifferences: [],
      verificationVocabulary: [],
    };
  }

  const vocabulary = targetedVocabulary(first.canonical.differences);
  if (pass2 == null) {
    if (vocabulary.length) {
      return {
        ...baseDecision('NEEDS_TARGETED_VERIFICATION', { targetedVerificationRequired: true }),
        pass1: first,
        pass2: null,
        final: first.canonical,
        persistentDifferences: first.canonical.differences,
        verificationVocabulary: vocabulary,
      };
    }
    return {
      ...baseDecision('REVIEW_HUMAN', { humanReviewRequired: true }),
      pass1: first,
      pass2: null,
      final: first.canonical,
      persistentDifferences: first.canonical.differences,
      verificationVocabulary: [],
    };
  }

  const second = compareTexts(expected, pass2, equivalenceConfig);
  if (second.canonical.editDistance === 0) {
    return {
      ...baseDecision('PASS_ASR_VARIANCE', { publicationAllowed: true }),
      pass1: first,
      pass2: second,
      final: second.canonical,
      persistentDifferences: [],
      verificationVocabulary: vocabulary,
    };
  }

  return {
    ...baseDecision('REVIEW_HUMAN', { humanReviewRequired: true }),
    pass1: first,
    pass2: second,
    final: second.canonical,
    persistentDifferences: second.canonical.differences,
    verificationVocabulary: vocabulary,
  };
}

export function assertNoAutomaticRegeneration(result) {
  if (result?.automaticRegenerationAllowed !== false) {
    throw new Error('Audio QA safety invariant violated: automatic regeneration must stay disabled.');
  }
  return true;
}
