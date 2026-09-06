import type { VisualStoryCard, VisualStoryCardKind, VisualStoryData } from '../../types/visual-story';

const KIND_VALUES: VisualStoryCardKind[] = [
  'hook', 'reveal', 'question', 'example', 'contrast', 'myth',
  'evidence', 'experiment', 'reflection', 'application', 'takeaway'
];

const ALLOWED_VISUALS = new Set([
  'threshold', 'rings', 'path', 'layers', 'contrast', 'pulse',
  'constellation', 'horizon', 'opening', 'seal', 'orbit',
  'wave', 'ledger', 'prism', 'compass', 'weave', 'arc', 'field', 'dawn', 'paper', 'ladder',
  'currents', 'stamps', 'orbit', 'compass', 'pulse', 'weave'
]);

const MIN_BODY_CHARS = 96;
const MAX_BODY_CHARS = 290;
const MIN_TITLE_CHARS = 8;
const MAX_TITLE_CHARS = 88;
const MIN_CARDS = 7;
const MAX_CARDS = 10;
const MIN_KICKER_CHARS = 3;
const MAX_KICKER_CHARS = 26;

const stripWhitespace = (value: string | undefined): string => (value || '').replace(/\s+/g, ' ').trim();

// Truncated endings: a card that ends with an ellipsis, comma, semicolon, or
// colon is a sign of mechanical cutting. Question marks and exclamation
// marks are legitimate editorial endings for hook / question / reveal cards,
// so they are NOT in this set.
const ENDS_INCOMPLETE = /(\.\.\.|…|،|:|؛|,|;)$/;
const STARTS_INCOMPLETE = /^(\.\.\.|…|،|:|؛)/;
const TABLE_FRAGMENT = /^\s*\|?\s*-{2,}\s*\|/;
const HTML_PATTERN = /<\/?[a-z][^>]*>/i;
const ARABIC_LETTER = /[\u0600-\u06FF]/;

const hasArabicContent = (value: string): boolean => ARABIC_LETTER.test(value);

const uniqueBy = <T,>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
};

const jaccard = (a: string, b: string): number => {
  const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const word of A) if (B.has(word)) intersection += 1;
  const union = A.size + B.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

export interface EditorialIssue {
  slug: string;
  cardId?: string;
  code: string;
  message: string;
}

export const validateEditorialStory = (story: VisualStoryData): EditorialIssue[] => {
  const issues: EditorialIssue[] = [];
  if (!story || !story.slug) {
    issues.push({ slug: story?.slug || '<unknown>', code: 'missing-slug', message: 'slug مفقود' });
    return issues;
  }
  if (!story.arc || stripWhitespace(story.arc).length < 24) {
    issues.push({ slug: story.slug, code: 'arc-missing', message: 'arc (ملخص القصة) مفود أو قصير جدًا' });
  }
  if (!['technical', 'reflective', 'books', 'world', 'simply'].includes(story.path)) {
    issues.push({ slug: story.slug, code: 'arc-path', message: 'path غير معروف' });
  }
  if (!Array.isArray(story.cards) || story.cards.length < MIN_CARDS || story.cards.length > MAX_CARDS) {
    issues.push({ slug: story.slug, code: 'card-count', message: `عدد البطاقات خارج ${MIN_CARDS}–${MAX_CARDS}` });
    return issues;
  }
  const ids = new Set<string>();
  const bodies: string[] = [];
  const kickers: string[] = [];
  const kinds: string[] = [];
  for (const card of story.cards) {
    if (!card.id || ids.has(card.id)) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'card-id', message: 'معرّف بطاقة مفقود أو مكرر' });
    }
    ids.add(card.id);
    const kicker = stripWhitespace(card.kicker);
    if (!kicker || kicker.length < MIN_KICKER_CHARS || kicker.length > MAX_KICKER_CHARS) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'kicker-len', message: 'طول الـkicker خارج النطاق 3–26' });
    }
    if (!hasArabicContent(kicker)) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'kicker-lang', message: 'kicker يجب أن يحتوي العربية' });
    }
    kickers.push(kicker);
    const title = stripWhitespace(card.title);
    if (!title || title.length < MIN_TITLE_CHARS || title.length > MAX_TITLE_CHARS) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'title-len', message: `طول العنوان خارج ${MIN_TITLE_CHARS}–${MAX_TITLE_CHARS}` });
    }
    if (!hasArabicContent(title)) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'title-lang', message: 'العنوان يجب أن يحتوي العربية' });
    }
    if (ENDS_INCOMPLETE.test(title)) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'title-truncated', message: 'العنوان منتهٍ بعلامة قطع أو فاصلة' });
    }
    if (STARTS_INCOMPLETE.test(title)) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'title-truncated', message: 'العنوان يبدأ بعلامة قطع أو فاصلة' });
    }
    const body = stripWhitespace(card.body);
    if (!body) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'body-empty', message: 'النص فارغ' });
    } else {
      if (body.length < MIN_BODY_CHARS) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-short', message: `النص أقصر من ${MIN_BODY_CHARS} حرفًا (${body.length})` });
      }
      if (body.length > MAX_BODY_CHARS) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-long', message: `النص أطول من ${MAX_BODY_CHARS} حرفًا (${body.length})` });
      }
      if (!hasArabicContent(body)) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-lang', message: 'النص يجب أن يحتوي العربية' });
      }
      if (TABLE_FRAGMENT.test(body) || /\|.*\|/m.test(body)) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-table', message: 'تسرب جدول Markdown إلى النص' });
      }
      if (HTML_PATTERN.test(body)) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-html', message: 'تسرب HTML إلى النص' });
      }
      if (ENDS_INCOMPLETE.test(body)) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-truncated', message: 'النص ينتهي بعلامة قطع (القص الميكانيكي ممنوع)' });
      }
      if (STARTS_INCOMPLETE.test(body)) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-truncated', message: 'النص يبدأ بعلامة قطع' });
      }
      // Detect leaked markdown artifacts and frontmatter lines.
      if (/^-{3,}\s*$/.test(body) || /^\s*---\s*$/m.test(body)) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-frontmatter', message: 'تسرب frontmatter إلى النص' });
      }
      if (/^[-*]\s/m.test(body)) {
        issues.push({ slug: story.slug, cardId: card.id, code: 'body-list', message: 'تسرب قائمة نقطية إلى النص' });
      }
    }
    if (!KIND_VALUES.includes(card.kind)) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'kind-invalid', message: 'نوع البطاقة غير معروف' });
    }
    kinds.push(card.kind);
    if (!card.visual || !ALLOWED_VISUALS.has(card.visual)) {
      issues.push({ slug: story.slug, cardId: card.id, code: 'visual-invalid', message: 'قيمة visual غير معروفة' });
    }
    bodies.push(body);
  }
  // Single-type variety: at least 3 distinct kinds per story.
  const distinctKinds = new Set(kinds);
  if (distinctKinds.size < 3) {
    issues.push({ slug: story.slug, code: 'kinds-monotone', message: `أنواع البطاقات متشابهة (${distinctKinds.size} فقط)` });
  }
  // Editorial kicker variety: at most 2 cards may share the same kicker text.
  const kickerCounts = new Map<string, number>();
  for (const k of kickers) kickerCounts.set(k, (kickerCounts.get(k) || 0) + 1);
  for (const [k, count] of kickerCounts) {
    if (count > 2) issues.push({ slug: story.slug, code: 'kicker-repeat', message: `kicker مكرر أكثر من مرتين: ${k} (${count}×)` });
  }
  // Detect high pairwise similarity across bodies (PowerPoint-style duplication).
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const sim = jaccard(bodies[i], bodies[j]);
      if (sim > 0.55) {
        issues.push({ slug: story.slug, code: 'body-overlap', message: `تشابه مرتفع بين البطاقتين ${i + 1} و ${j + 1} (${(sim * 100).toFixed(0)}%)` });
      }
    }
  }
  // Hook vs. takeaway must not be identical.
  if (story.cards[0]?.id === 'hook' && story.cards[story.cards.length - 1]?.id === 'takeaway') {
    const sim = jaccard(stripWhitespace(story.cards[0].body), stripWhitespace(story.cards[story.cards.length - 1].body));
    if (sim > 0.4) {
      issues.push({ slug: story.slug, code: 'arc-bookends', message: 'الافتتاح والخاتمة متقاربان جدًا' });
    }
  }
  if (story.cards[0]?.title && story.cards[story.cards.length - 1]?.title) {
    if (stripWhitespace(story.cards[0].title) === stripWhitespace(story.cards[story.cards.length - 1].title)) {
      issues.push({ slug: story.slug, code: 'arc-title-bookends', message: 'عنوان الافتتاح والخاتمة متطابق' });
    }
  }
  // Unique titles inside a single story.
  const titleSet = new Set(story.cards.map((c) => stripWhitespace(c.title)));
  if (titleSet.size !== story.cards.length) {
    issues.push({ slug: story.slug, code: 'title-dup', message: 'عنوان بطاقة مكرر داخل القصة' });
  }
  return issues;
};

export const isValidVisualStory = (story: VisualStoryData | undefined): story is VisualStoryData => {
  if (!story || !story.slug || !story.title || !/^[a-f0-9]{64}$/.test(story.sourceFingerprint)) return false;
  if (!Array.isArray(story.cards) || story.cards.length < MIN_CARDS || story.cards.length > MAX_CARDS) return false;
  const ids = new Set<string>();
  for (const card of story.cards) {
    if (!card.id || ids.has(card.id) || !stripWhitespace(card.title) || !stripWhitespace(card.body)) return false;
    if (card.body.length < MIN_BODY_CHARS || card.body.length > MAX_BODY_CHARS) return false;
    ids.add(card.id);
  }
  return story.director?.density === 'airy'
    && story.director?.motion === 'calm'
    && story.director?.palette?.length === 4
    && story.path !== undefined
    && stripWhitespace(story.arc).length >= 24
    && validateEditorialStory(story).length === 0;
};

export const collectEditorialIssues = (stories: VisualStoryData[]): EditorialIssue[] => {
  const issues: EditorialIssue[] = [];
  const titles = new Set<string>();
  for (const story of stories) {
    issues.push(...validateEditorialStory(story));
    if (titles.has(story.title)) {
      issues.push({ slug: story.slug, code: 'cross-title-dup', message: `عنوان القصة مكرر: ${story.title}` });
    }
    titles.add(story.title);
  }
  return issues;
};

export const uniqueCards = (cards: VisualStoryCard[]): VisualStoryCard[] => uniqueBy(cards, (c) => c.id);
