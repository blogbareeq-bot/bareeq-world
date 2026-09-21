import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './audio-constants.mjs';
import { ARABIC_NORMALIZER_VERSION, DEFAULT_PRONUNCIATION_LEXICON_VERSION } from './audio-engine-config.mjs';

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;
const TATWEEL = /\u0640/gu;
const LEXICON_KINDS = new Set([
  'word', 'section-name', 'name', 'foreign-term', 'number', 'year',
  'percent', 'currency', 'abbreviation', 'polyphonic',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

function lexicalPattern(source) {
  const letters = [...source].map((character) => escapeRegExp(character) + '[\\u064B-\\u065F\\u0670]*').join('');
  return new RegExp('(?<![\\p{L}\\p{N}])' + letters + '(?![\\p{L}\\p{N}])', 'gu');
}

export function normalizeArabicSurface(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[\u200B\u200C]/gu, ' ')
    .replace(INVISIBLE, ' ')
    .replace(TATWEEL, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s*\n\s*/gu, ' ')
    .replace(/\s+([،؛؟.!,:])/gu, '$1')
    .replace(/([،؛؟.!,:])(?=[\p{L}\p{N}])/gu, (punctuation, _capture, offset, source) => {
      const before = source[offset - 1] || '';
      const after = source[offset + 1] || '';
      if (/[.,،:]/u.test(punctuation) && /[0-9٠-٩۰-۹]/u.test(before) && /[0-9٠-٩۰-۹]/u.test(after)) return punctuation;
      if (punctuation === '.' && /[A-Za-z]/u.test(before) && /[A-Za-z]/u.test(after)) return punctuation;
      return punctuation + ' ';
    })
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
  const sources = new Set();
  for (const entry of payload.entries) {
    if (!entry || typeof entry.source !== 'string' || !entry.source.trim()
      || typeof entry.synthesis !== 'string' || !entry.synthesis.trim()
      || (entry.prefixes && (!Array.isArray(entry.prefixes) || entry.prefixes.some((prefix) => !/^[وف]$/u.test(prefix))))
      || (entry.kind && !LEXICON_KINDS.has(entry.kind))
      || (entry.priority != null && (!Number.isInteger(entry.priority) || Math.abs(entry.priority) > 100))
      || (entry.context && (typeof entry.context !== 'object'
        || ['before', 'after'].some((key) => entry.context[key] != null
          && (!Array.isArray(entry.context[key]) || entry.context[key].some((word) => typeof word !== 'string')))))) {
      throw new Error('Pronunciation lexicon has an invalid entry.');
    }
    const ruleId = JSON.stringify([entry.source, entry.context || null, entry.priority || 0]);
    if (sources.has(ruleId)) throw new Error('Pronunciation lexicon has a duplicate rule: ' + entry.source);
    sources.add(ruleId);
  }
  return { ...payload, file: resolved };
}

export function applyPronunciationLexicon(text, lexicon) {
  let synthesisText = normalizeArabicSurface(text);
  const transformations = [];
  const entries = [...(lexicon?.entries || [])]
    .filter((entry) => typeof entry?.source === 'string' && entry.source && typeof entry?.synthesis === 'string' && entry.synthesis)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)
      || Number(Boolean(b.context)) - Number(Boolean(a.context)) || b.source.length - a.source.length);
  for (const entry of entries) {
    const bareSource = entry.source.normalize('NFC');
    const prefix = entry.prefixes?.length ? '(?:(' + entry.prefixes.map(escapeRegExp).join('|') + '))?' : '';
    const barePattern = lexicalPattern(bareSource).source;
    const pattern = prefix
      ? new RegExp(barePattern.replace('(?<![\\p{L}\\p{N}])', '(?<![\\p{L}\\p{N}])' + prefix), 'gu')
      : lexicalPattern(bareSource);
    let count = 0;
    synthesisText = synthesisText.replace(pattern, (matched, matchedPrefix = '', offset, fullText) => {
      // A rule with contextual readings applies only to its reviewed neighboring words.
      // Without a prefix capture, replace() supplies the offset in the second argument.
      const start = prefix ? offset : matchedPrefix;
      const full = prefix ? fullText : offset;
      const previous = full.slice(0, start).trim().match(/(\S+)$/u)?.[1] || '';
      const next = full.slice(start + matched.length).trim().match(/^(\S+)/u)?.[1] || '';
      if (entry.context?.before && !entry.context.before.includes(previous)) return matched;
      if (entry.context?.after && !entry.context.after.includes(next)) return matched;
      count += 1;
      const finalMarks = matched.match(/[\u064B-\u065F\u0670]+$/u)?.[0] || '';
      const replacement = finalMarks
        ? entry.synthesis.replace(/[\u064B-\u065F\u0670]+$/u, '') + finalMarks
        : entry.synthesis;
      return (prefix ? matchedPrefix : '') + replacement;
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
