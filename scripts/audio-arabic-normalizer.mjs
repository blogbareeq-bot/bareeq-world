import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './audio-constants.mjs';
import { ARABIC_NORMALIZER_VERSION, DEFAULT_PRONUNCIATION_LEXICON_VERSION } from './audio-engine-config.mjs';

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;
const TATWEEL = /\u0640/gu;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

function lexicalPattern(source) {
  const escaped = escapeRegExp(source);
  return new RegExp('(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])', 'gu');
}

export function normalizeArabicSurface(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(TATWEEL, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s*\n\s*/gu, ' ')
    .replace(/\s+([،؛؟.!,:])/gu, '$1')
    .replace(/([،؛؟.!,:])(?=[\p{L}\p{N}])/gu, '$1 ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

export async function readPronunciationLexicon(root = process.cwd(), file = process.env.BAREEQ_PRONUNCIATION_LEXICON) {
  const resolved = file
    ? path.resolve(root, file)
    : path.join(root, 'scripts', 'audio-pronunciation-lexicon.json');
  const payload = JSON.parse(await readFile(resolved, 'utf8'));
  if (payload?.schema !== 'bareeq.audio-pronunciation-lexicon.v1' || !Array.isArray(payload.entries)) {
    throw new Error('Invalid Bareeq pronunciation lexicon: ' + resolved);
  }
  if (Number(payload.version) !== DEFAULT_PRONUNCIATION_LEXICON_VERSION) {
    throw new Error('Pronunciation lexicon version ' + payload.version + ' does not match engine contract ' + DEFAULT_PRONUNCIATION_LEXICON_VERSION + '.');
  }
  return { ...payload, file: resolved };
}

export function applyPronunciationLexicon(text, lexicon) {
  let synthesisText = normalizeArabicSurface(text);
  const transformations = [];
  const entries = [...(lexicon?.entries || [])]
    .filter((entry) => typeof entry?.source === 'string' && entry.source && typeof entry?.synthesis === 'string' && entry.synthesis)
    .sort((a, b) => b.source.length - a.source.length);
  for (const entry of entries) {
    const pattern = lexicalPattern(entry.source);
    let count = 0;
    synthesisText = synthesisText.replace(pattern, () => {
      count += 1;
      return entry.synthesis;
    });
    if (count) transformations.push({ source: entry.source, synthesis: entry.synthesis, count, reason: entry.reason || null });
  }
  return { synthesisText, transformations };
}

export function prepareArabicSynthesisText(text, lexicon = { version: DEFAULT_PRONUNCIATION_LEXICON_VERSION, entries: [] }) {
  const canonicalText = String(text ?? '').trim();
  const surface = normalizeArabicSurface(canonicalText);
  const applied = applyPronunciationLexicon(surface, lexicon);
  const fingerprint = sha256(JSON.stringify({
    normalizerVersion: ARABIC_NORMALIZER_VERSION,
    lexiconVersion: Number(lexicon?.version || DEFAULT_PRONUNCIATION_LEXICON_VERSION),
    canonicalText,
    synthesisText: applied.synthesisText,
  }));
  return {
    canonicalText,
    synthesisText: applied.synthesisText,
    changed: applied.synthesisText !== canonicalText,
    transformations: applied.transformations,
    normalizerVersion: ARABIC_NORMALIZER_VERSION,
    lexiconVersion: Number(lexicon?.version || DEFAULT_PRONUNCIATION_LEXICON_VERSION),
    fingerprint,
  };
}
