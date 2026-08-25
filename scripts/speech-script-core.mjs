import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const SPEECH_SCRIPT_VERSION = 1;
export const DIACRITICS_PATTERN = /[\u064B-\u065F\u0670\u06D6-\u06ED]/gu;
export const ARABIC_DIACRITIC_PATTERN = /[\u064B-\u065F\u0670]/u;
export const ALLOWED_TRANSFORMATIONS = new Set([
  'arabic-diacritization',
  'contextual-disambiguation',
  'number-expansion',
  'abbreviation-expansion',
  'foreign-name-pronunciation',
  'remove-duplicated-english',
  'punctuation-pause-normalization',
  'exclude-references',
]);

const REFERENCE_HEADINGS = new Set([
  'المصادر',
  'المراجع',
  'المصادر والمراجع',
  'المصادر والتحقق',
  'المصادر والقراءة الإضافية',
  'مصادر للتوسع',
  'references',
]);

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const stripDiacritics = (value) => String(value ?? '').normalize('NFC').replace(DIACRITICS_PATTERN, '');

export function normalizeArabicForComparison(value) {
  return stripDiacritics(value)
    .normalize('NFKC')
    .replace(/[“”«»"'`]/g, '')
    .replace(/[،؛:,.!?؟…()[\]{}\-–—/\\|]/g, ' ')
    .replace(/ـ/g, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeReferenceHeading(value) {
  return stripDiacritics(value)
    .replace(/[*_~`#]/g, '')
    .replace(/[.:：،؛!?؟…]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function isReferenceHeading(value) {
  return REFERENCE_HEADINGS.has(normalizeReferenceHeading(value));
}

export function parseArticleSource(source, filename = 'article.md') {
  const normalized = source.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error(`${filename}: invalid frontmatter.`);
  const frontmatter = match[1];
  const body = match[2].trim();
  const title = frontmatter.match(/^title:\s*["']?(.*?)["']?\s*$/m)?.[1]?.trim();
  const draft = /^draft:\s*true\s*$/mi.test(frontmatter);
  if (!title) throw new Error(`${filename}: title is missing.`);
  return { title, draft, body, bodyHash: sha256(body), frontmatter };
}

export function cleanInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\([^)]*https?:\/\/[^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+([،؛؟.!])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function normalizeMatchText(text) {
  return stripDiacritics(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function prepareBody(body) {
  return body
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n');
}

export function splitReferenceSection(body) {
  const prepared = prepareBody(body);
  const lines = prepared.split(/\r?\n/);
  let referenceLine = -1;
  let referenceHeading = '';
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].trim().match(/^##\s+(.+)$/);
    if (heading && isReferenceHeading(heading[1])) {
      referenceLine = index;
      referenceHeading = cleanInlineMarkdown(heading[1]);
      break;
    }
  }
  if (referenceLine === -1) return { spokenBody: prepared.trim(), referenceBody: '', referenceHeading: '', referenceLine: -1 };
  return {
    spokenBody: lines.slice(0, referenceLine).join('\n').trim(),
    referenceBody: lines.slice(referenceLine).join('\n').trim(),
    referenceHeading,
    referenceLine,
  };
}

function extractRawSegments(body) {
  const lines = prepareBody(body).split(/\r?\n/);
  const segments = [];
  let paragraph = [];
  let quote = [];

  const add = (type, raw) => {
    const sourceText = cleanInlineMarkdown(raw);
    if (!sourceText || sourceText.length < 2) return;
    const match = normalizeMatchText(sourceText);
    if (!match) return;
    segments.push({ type, sourceText, match: match.slice(0, 120) });
  };
  const flushParagraph = () => {
    if (paragraph.length) add('paragraph', paragraph.join(' '));
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length) add('quote', quote.join(' '));
    quote = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushQuote();
      continue;
    }
    if (/^\|.*\|$/.test(trimmed) || /^[-:| ]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      continue;
    }
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      continue;
    }
    const heading = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushQuote();
      add(`h${heading[1].length}`, heading[2]);
      continue;
    }
    const listItem = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (listItem) {
      flushParagraph();
      flushQuote();
      add('list-item', listItem[1]);
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      quote.push(trimmed.replace(/^>\s?/, ''));
      continue;
    }
    if (quote.length) flushQuote();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushQuote();
  return segments;
}

function stableIds(rawSegments) {
  const occurrences = new Map();
  return rawSegments.map((segment, order) => {
    const sourceHash = sha256(segment.sourceText);
    const base = `${segment.type}-${sourceHash.slice(0, 12)}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return {
      segmentId: occurrence === 1 ? base : `${base}-${occurrence}`,
      runtimeId: segment.type === 'title' ? null : `b${String(order).padStart(4, '0')}`,
      order,
      ...segment,
      sourceHash,
    };
  });
}

export function extractArticleSpeechModel({ articleId, source, filename = `${articleId}.md` }) {
  const article = parseArticleSource(source, filename);
  const split = splitReferenceSection(article.body);
  const spoken = extractRawSegments(split.spokenBody);
  const references = split.referenceBody ? extractRawSegments(split.referenceBody) : [];
  const segments = stableIds([
    { type: 'title', sourceText: article.title, match: normalizeMatchText(article.title).slice(0, 120) },
    ...spoken,
  ]);
  const structure = segments.map(({ segmentId, type }) => ({ segmentId, type }));
  return {
    articleId,
    title: article.title,
    draft: article.draft,
    bodyHash: article.bodyHash,
    structureHash: sha256(JSON.stringify(structure)),
    segments,
    referenceExclusion: {
      heading: split.referenceHeading,
      segmentCount: references.length,
      sourceHash: split.referenceBody ? sha256(split.referenceBody) : null,
    },
  };
}

export function applyDeclaredTransformations(sourceText, transformations = []) {
  let expected = sourceText;
  for (const transformation of transformations) {
    if (!transformation || !ALLOWED_TRANSFORMATIONS.has(transformation.type)) {
      throw new Error(`Unknown speech transformation: ${transformation?.type ?? 'missing'}`);
    }
    if (['arabic-diacritization', 'contextual-disambiguation', 'punctuation-pause-normalization', 'exclude-references'].includes(transformation.type)) continue;
    const from = transformation.from;
    const to = transformation.to ?? '';
    if (typeof from !== 'string' || !from) throw new Error(`${transformation.type}: transformation.from is required.`);
    if (typeof to !== 'string') throw new Error(`${transformation.type}: transformation.to must be a string.`);
    const occurrences = expected.split(from).length - 1;
    if (occurrences !== 1) throw new Error(`${transformation.type}: expected exactly one occurrence of "${from}", found ${occurrences}.`);
    expected = expected.replace(from, to);
  }
  return expected;
}

function arabicTokens(value) {
  return String(value ?? '').match(/[\u0621-\u064A][\u0621-\u064A\u064B-\u065F\u0670]*/gu) ?? [];
}

export function startsWithSukunToken(value) {
  return arabicTokens(value).find((token) => token.length > 1 && token.codePointAt(1) === 0x0652) ?? null;
}

export function findForeignTerms(value) {
  const matches = String(value ?? '').match(/[A-Za-z][A-Za-z0-9+./-]*(?:\s+[A-Za-z][A-Za-z0-9+./-]*)*/g) ?? [];
  return [...new Set(matches.map((item) => item.trim()).filter(Boolean))];
}

function contextualTokenCore(token, lexeme) {
  const normalized = token.normalize('NFC');
  const bare = stripDiacritics(normalized);
  if (bare === lexeme) return normalized;
  if (!['و', 'ف'].some((prefix) => bare === `${prefix}${lexeme}`)) return null;
  const chars = [...normalized];
  chars.shift();
  while (chars.length && /[\u064B-\u065F\u0670]/u.test(chars[0])) chars.shift();
  return chars.join('').normalize('NFC');
}

function canonicalVocalizedToken(value) {
  const clusters = [];
  let current = '';
  let marks = [];
  for (const character of [...String(value).normalize('NFD')]) {
    if (/[\u064B-\u065F\u0670]/u.test(character)) marks.push(character);
    else {
      if (current) clusters.push(`${current}${marks.sort().join('')}`);
      current = character;
      marks = [];
    }
  }
  if (current) clusters.push(`${current}${marks.sort().join('')}`);
  return clusters.join('');
}

export function detectContextualAmbiguities(sourceText, spokenText, rules) {
  const sourceTokens = arabicTokens(sourceText);
  const spokenTokens = arabicTokens(spokenText);
  const findings = [];
  for (const rule of rules) {
    const sourceMatches = sourceTokens.map((token) => contextualTokenCore(token, rule.lexeme)).filter(Boolean);
    const sourceCount = sourceMatches.length;
    if (!sourceCount) continue;
    const candidates = spokenTokens.map((token) => contextualTokenCore(token, rule.lexeme)).filter(Boolean);
    const approved = rule.readings.map(canonicalVocalizedToken);
    const resolved = candidates.filter((token) => approved.includes(canonicalVocalizedToken(token))).length;
    findings.push({
      ruleId: rule.id,
      lexeme: rule.lexeme,
      occurrences: sourceCount,
      resolved,
      unresolved: Math.max(0, sourceCount - resolved),
      readings: rule.readings,
      observed: candidates,
    });
  }
  return findings;
}

export async function readAmbiguityRules(root = process.cwd()) {
  const file = path.join(root, 'scripts', 'contextual-ambiguities.json');
  const payload = JSON.parse(await readFile(file, 'utf8'));
  if (payload.version !== 1 || !Array.isArray(payload.rules)) throw new Error('Invalid contextual ambiguity rules file.');
  return payload.rules;
}

export async function readSpeechScript(articleId, root = process.cwd()) {
  const file = path.join(root, 'scripts', 'speech-scripts', `${articleId}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readTestClipPlan(articleId, root = process.cwd()) {
  const file = path.join(root, 'scripts', 'speech-test-clips', `${articleId}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function verifyTestClipEvidence(plan, root = process.cwd()) {
  if (!plan?.testClipPassed || plan?.audioReview?.status !== 'passed') return false;
  const evidence = plan.audioReview.evidence;
  if (!evidence || typeof evidence.file !== 'string' || !evidence.file || !/^[a-f0-9]{64}$/i.test(evidence.sha256 ?? '')) return false;
  const absolute = path.resolve(root, evidence.file);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) return false;
  try {
    const bytes = await readFile(absolute);
    return sha256(bytes) === evidence.sha256.toLowerCase();
  } catch { return false; }
}

function reviewPassed(review) {
  return review?.status === 'passed' && typeof review?.reviewedAt === 'string' && typeof review?.reviewer === 'string' && review.reviewer.trim();
}

export function validateSpeechScript(model, script, ambiguityRules, { requireReviews = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!script) return { valid: false, approved: false, errors: ['missing speech script'], warnings, segmentResults: [], missingSegmentIds: model.segments.map((segment) => segment.segmentId), staleSegmentIds: [], structuralChange: true };
  if (script.version !== SPEECH_SCRIPT_VERSION) errors.push(`unsupported speech script version ${script.version}`);
  if (script.articleId !== model.articleId) errors.push(`articleId mismatch: ${script.articleId}`);
  if (!Array.isArray(script.segments)) errors.push('segments must be an array');
  const records = new Map((script.segments ?? []).map((segment) => [segment.segmentId, segment]));
  if (records.size !== (script.segments ?? []).length) errors.push('duplicate segmentId in speech script');
  const sourceIds = new Set(model.segments.map((segment) => segment.segmentId));
  const missingSegmentIds = model.segments.filter((segment) => !records.has(segment.segmentId)).map((segment) => segment.segmentId);
  const staleSegmentIds = (script.segments ?? []).filter((segment) => !sourceIds.has(segment.segmentId)).map((segment) => segment.segmentId);
  const actualOrder = model.segments.map((segment) => segment.segmentId);
  const storedOrder = (script.segments ?? []).filter((segment) => sourceIds.has(segment.segmentId)).map((segment) => segment.segmentId);
  const structuralChange = script.sourceStructureHash !== model.structureHash || JSON.stringify(actualOrder) !== JSON.stringify(storedOrder);
  if (missingSegmentIds.length) errors.push(`missing current segment(s): ${missingSegmentIds.join(', ')}`);
  if (staleSegmentIds.length) errors.push(`stale segment(s): ${staleSegmentIds.join(', ')}`);
  if (structuralChange) errors.push('article segment structure/order changed');

  const segmentResults = [];
  for (const sourceSegment of model.segments) {
    const record = records.get(sourceSegment.segmentId);
    if (!record) continue;
    const segmentErrors = [];
    const segmentWarnings = [];
    if (record.sourceHash !== sourceSegment.sourceHash) segmentErrors.push('sourceHash mismatch');
    if (record.sourceText !== sourceSegment.sourceText) segmentErrors.push('sourceText mismatch');
    if (typeof record.spokenText !== 'string' || !record.spokenText.trim()) segmentErrors.push('spokenText is missing');
    let transformed = sourceSegment.sourceText;
    try { transformed = applyDeclaredTransformations(sourceSegment.sourceText, record.transformations ?? []); }
    catch (error) { segmentErrors.push(error.message); }
    if (normalizeArabicForComparison(transformed) !== normalizeArabicForComparison(record.spokenText ?? '')) {
      segmentErrors.push('spokenText changes source meaning/content outside declared transformations');
    }
    const sukun = startsWithSukunToken(record.spokenText ?? '');
    if (sukun) segmentErrors.push(`Arabic phonetic token starts with sukun: ${sukun}`);
    const ambiguities = detectContextualAmbiguities(sourceSegment.sourceText, record.spokenText ?? '', ambiguityRules);
    const unresolved = ambiguities.reduce((sum, item) => sum + item.unresolved, 0);
    if (unresolved) segmentErrors.push(`unresolved contextual ambiguity (${unresolved})`);
    const foreignTerms = findForeignTerms(record.spokenText ?? '');
    if (foreignTerms.length) segmentWarnings.push(`unresolved foreign text: ${foreignTerms.join(', ')}`);
    const linguisticPassed = reviewPassed(record.linguisticReview);
    const pronunciationPassed = reviewPassed(record.pronunciationReview);
    if (requireReviews && !linguisticPassed) segmentErrors.push('linguistic review is not passed');
    if (requireReviews && !pronunciationPassed) segmentErrors.push('pronunciation review is not passed');
    segmentResults.push({
      segmentId: sourceSegment.segmentId,
      type: sourceSegment.type,
      valid: segmentErrors.length === 0,
      linguisticPassed,
      pronunciationPassed,
      ambiguities,
      unresolvedAmbiguities: unresolved,
      foreignTerms,
      errors: segmentErrors,
      warnings: segmentWarnings,
    });
  }

  const unresolvedAmbiguities = segmentResults.reduce((sum, segment) => sum + segment.unresolvedAmbiguities, 0);
  const foreignTerms = [...new Set(segmentResults.flatMap((segment) => segment.foreignTerms))];
  const reviewsPassed = segmentResults.length === model.segments.length && segmentResults.every((segment) => segment.linguisticPassed && segment.pronunciationPassed);
  if (script.referenceExclusion?.heading !== model.referenceExclusion.heading) errors.push('reference exclusion heading mismatch');
  if (script.referenceExclusion?.sourceHash !== model.referenceExclusion.sourceHash) errors.push('reference exclusion sourceHash mismatch');
  if (script.referenceExclusion?.segmentCount !== model.referenceExclusion.segmentCount) errors.push('reference exclusion segment count mismatch');
  const valid = errors.length === 0 && segmentResults.every((segment) => segment.valid);
  const approved = valid && reviewsPassed;
  return {
    valid,
    approved,
    errors,
    warnings,
    reviewsPassed,
    segmentResults,
    missingSegmentIds,
    staleSegmentIds,
    structuralChange,
    unresolvedAmbiguities,
    foreignTerms,
    referenceSegmentCount: model.referenceExclusion.segmentCount,
  };
}

export function deriveInventoryStatus(validation, model) {
  if (validation.approved) return { bucket: 'A', status: 'speech-script-passed', riskLevel: 'low' };
  const unresolved = validation.unresolvedAmbiguities ?? 0;
  const foreign = validation.foreignTerms?.length ?? 0;
  const high = unresolved >= 8 || foreign >= 5 || model.segments.length >= 100;
  return high
    ? { bucket: 'C', status: 'high-risk-major-review-required', riskLevel: 'high' }
    : { bucket: 'B', status: 'needs-linguistic-review', riskLevel: 'medium' };
}

export async function loadPublishedArticleModels(root = process.cwd()) {
  const postsDir = path.join(root, 'src', 'content', 'posts');
  const files = (await readdir(postsDir)).filter((name) => name.endsWith('.md')).sort();
  const models = [];
  for (const filename of files) {
    const articleId = filename.replace(/\.md$/, '');
    const source = await readFile(path.join(postsDir, filename), 'utf8');
    const model = extractArticleSpeechModel({ articleId, source, filename });
    if (!model.draft) models.push(model);
  }
  return models;
}

export async function pathExists(file) {
  try { await access(file); return true; } catch { return false; }
}
