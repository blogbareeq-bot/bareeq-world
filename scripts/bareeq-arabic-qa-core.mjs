import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ARABIC_DIACRITICS_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED]/gu;
const DANGEROUS_INVISIBLES_RE = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
const ARABIC_WORD_RE = /[\u0621-\u063A\u0641-\u064A\u066E-\u06D3\u06FA-\u06FC]+/gu;
const MIXED_SCRIPT_TOKEN_RE = /(?=[^\s]*[\u0621-\u063A\u0641-\u064A\u066E-\u06D3\u06FA-\u06FC])(?=[^\s]*[A-Za-z])[^\s]+/gu;
const URL_RE = /https?:\/\/[^\s)\]>"']+/giu;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const NUMBER_RE = /(?<![\p{L}\p{N}])(?:[0-9٠-٩]+(?:[.,٫٬:/-][0-9٠-٩]+)*(?:\s?[%٪])?)(?![\p{L}\p{N}])/gu;
const ACRONYM_RE = /\b[A-Z]{2,8}(?:-[A-Z0-9]{1,8})?\b/g;

export const SEVERITY_ORDER = Object.freeze({ info: 0, warning: 1, error: 2, fatal: 3 });

export async function loadConfig(configPath) {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

export async function discoverMarkdownFiles(root, roots) {
  const files = [];
  for (const relRoot of roots) {
    const absRoot = path.join(root, relRoot);
    await walk(absRoot, files);
  }
  return files.sort();
}

async function walk(dir, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (entry.isFile() && /\.mdx?$/iu.test(entry.name)) files.push(full);
  }
}

export function parseFrontmatter(source) {
  const normalized = source.replace(/^\uFEFF/u, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { ok: false, metadata: {}, body: normalized, frontmatter: '', bodyStartLine: 1, error: 'missing-opening' };
  }
  const lines = normalized.split(/\r?\n/u);
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closing = i;
      break;
    }
  }
  if (closing < 0) {
    return { ok: false, metadata: {}, body: '', frontmatter: lines.slice(1).join('\n'), bodyStartLine: lines.length + 1, error: 'missing-closing' };
  }
  const frontmatterLines = lines.slice(1, closing);
  const metadata = {};
  for (const line of frontmatterLines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (!match) continue;
    metadata[match[1]] = unquoteYamlScalar(match[2].trim());
  }
  return {
    ok: true,
    metadata,
    frontmatter: frontmatterLines.join('\n'),
    body: lines.slice(closing + 1).join('\n'),
    bodyStartLine: closing + 2,
    error: null
  };
}

function unquoteYamlScalar(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      if (value.startsWith('"')) return JSON.parse(value);
    } catch {
      // fall through to simple unquote
    }
    return value.slice(1, -1);
  }
  return value;
}

export function scanArticle({ file, source, config }) {
  const findings = [];
  const rel = file.replaceAll('\\', '/');
  const suppressions = extractSuppressions(source);
  const parsed = parseFrontmatter(source);

  if (!parsed.ok) {
    findings.push(makeFinding({
      ruleId: parsed.error === 'missing-opening' ? 'BQA-DOC-001' : 'BQA-DOC-002',
      severity: 'error',
      provider: 'bareeq-core',
      file: rel,
      line: 1,
      message: parsed.error === 'missing-opening'
        ? 'الملف لا يبدأ بكتلة frontmatter صحيحة.'
        : 'كتلة frontmatter غير مغلقة بعلامة ---.'
    }));
    return finalize(findings, suppressions);
  }

  for (const key of config.requiredFrontmatter ?? []) {
    const value = parsed.metadata[key];
    if (value === undefined || String(value).trim() === '') {
      findings.push(makeFinding({
        ruleId: 'BQA-META-001', severity: 'error', provider: 'bareeq-core', file: rel, line: 1,
        message: `حقل frontmatter الإلزامي مفقود أو فارغ: ${key}.`
      }));
    }
  }

  for (const [key, min] of Object.entries(config.minimumLengths ?? {})) {
    const value = parsed.metadata[key];
    if (value !== undefined && String(value).trim().length < Number(min)) {
      findings.push(makeFinding({
        ruleId: 'BQA-META-002', severity: 'warning', provider: 'bareeq-core', file: rel, line: 1,
        message: `الحقل ${key} أقصر من الحد التحريري المقترح (${min} حرفًا).`
      }));
    }
  }

  if (!parsed.body.trim()) {
    findings.push(makeFinding({
      ruleId: 'BQA-DOC-003', severity: 'error', provider: 'bareeq-core', file: rel, line: parsed.bodyStartLine,
      message: 'المقال لا يحتوي على متن قابل للنشر.'
    }));
  }

  const lines = parsed.body.split(/\r?\n/u);
  let inFence = false;
  let fenceOpenLine = null;
  let previousHeadingDepth = null;
  const headingKeys = new Map();
  const paragraphs = [];
  let paragraphLines = [];
  let paragraphStart = null;
  const sentenceOpeners = [];
  let genericPhraseHits = 0;

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const text = paragraphLines.join(' ').replace(/\s+/gu, ' ').trim();
    if (text) paragraphs.push({ text, line: paragraphStart });
    paragraphLines = [];
    paragraphStart = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = parsed.bodyStartLine + i;
    const rawLine = lines[i];

    if (/^\s*```/u.test(rawLine)) {
      flushParagraph();
      if (!inFence) {
        inFence = true;
        fenceOpenLine = lineNumber;
      } else {
        inFence = false;
        fenceOpenLine = null;
      }
      continue;
    }
    if (inFence) continue;

    if (/^(?:<{7}|={7}|>{7})/u.test(rawLine)) {
      findings.push(makeFinding({
        ruleId: 'BQA-DOC-004', severity: 'error', provider: 'bareeq-core', file: rel, line: lineNumber,
        excerpt: rawLine.trim(), message: 'بقايا تعارض Git موجودة داخل المقال.'
      }));
    }

    const placeholder = rawLine.match(/\b(?:TODO|FIXME|TBD)\b|\[\s*(?:TODO|FIXME|TBD)\s*\]|X{4,}/iu);
    if (placeholder) {
      findings.push(makeFinding({
        ruleId: 'BQA-DOC-005', severity: 'error', provider: 'bareeq-core', file: rel, line: lineNumber,
        column: placeholder.index + 1, excerpt: snippet(rawLine, placeholder.index),
        message: `مؤشر عمل غير مكتمل قبل النشر: ${placeholder[0]}.`
      }));
    }

    const invisibles = [...rawLine.matchAll(DANGEROUS_INVISIBLES_RE)];
    if (invisibles.length) {
      findings.push(makeFinding({
        ruleId: 'BQA-DOC-006', severity: 'error', provider: 'bareeq-core', file: rel, line: lineNumber,
        column: invisibles[0].index + 1, excerpt: visibleInvisibleExcerpt(rawLine),
        message: 'المقال يحتوي على محارف اتجاه/عرض خفية قد تغيّر القراءة أو العرض.'
      }));
    }

    const heading = rawLine.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      flushParagraph();
      const depth = heading[1].length;
      const title = stripInlineMarkdown(heading[2]).trim();
      const key = normalizeForComparison(title);
      if (previousHeadingDepth !== null && depth > previousHeadingDepth + 1) {
        findings.push(makeFinding({
          ruleId: 'BQA-MD-001', severity: 'warning', provider: 'bareeq-core', file: rel, line: lineNumber,
          excerpt: rawLine.trim(), message: `قفزة في تسلسل العناوين من H${previousHeadingDepth} إلى H${depth}.`
        }));
      }
      previousHeadingDepth = depth;
      if (key && headingKeys.has(key)) {
        findings.push(makeFinding({
          ruleId: 'BQA-MD-002', severity: 'info', provider: 'bareeq-core', file: rel, line: lineNumber,
          excerpt: title, message: `عنوان فرعي مكرر؛ ظهر أول مرة في السطر ${headingKeys.get(key)}.`
        }));
      } else if (key) {
        headingKeys.set(key, lineNumber);
      }
      continue;
    }

    if (!rawLine.trim() || /^\s*(?:---+|\|.*\|)\s*$/u.test(rawLine)) {
      flushParagraph();
      continue;
    }

    const line = maskProtectedMarkdown(rawLine);
    const trim = line.trim();
    if (!trim) continue;

    const doubledSpaces = line.match(/ {2,}/u);
    if (doubledSpaces) {
      findings.push(makeFinding({
        ruleId: 'BQA-TYPO-001', severity: 'warning', provider: 'bareeq-core', file: rel, line: lineNumber,
        column: doubledSpaces.index + 1, excerpt: snippet(rawLine, doubledSpaces.index),
        message: 'مسافات متتابعة داخل النص.'
      }));
    }

    const beforeArabicPunctuation = line.match(/\s+[،؛؟]/u);
    if (beforeArabicPunctuation) {
      findings.push(makeFinding({
        ruleId: 'BQA-PUNC-001', severity: 'warning', provider: 'bareeq-core', file: rel, line: lineNumber,
        column: beforeArabicPunctuation.index + 1, excerpt: snippet(rawLine, beforeArabicPunctuation.index),
        message: 'مسافة زائدة قبل علامة ترقيم عربية.'
      }));
    }

    const missingAfterArabicPunctuation = line.match(/[،؛؟](?=[\p{L}\p{N}])/u);
    if (missingAfterArabicPunctuation) {
      findings.push(makeFinding({
        ruleId: 'BQA-PUNC-002', severity: 'warning', provider: 'bareeq-core', file: rel, line: lineNumber,
        column: missingAfterArabicPunctuation.index + 1, excerpt: snippet(rawLine, missingAfterArabicPunctuation.index),
        message: 'لا توجد مسافة بعد علامة ترقيم عربية.'
      }));
    }

    const westernQuestion = line.match(/[\u0600-\u06FF][^\n]{0,120}\?/u);
    if (westernQuestion) {
      const qIndex = line.indexOf('?', westernQuestion.index);
      findings.push(makeFinding({
        ruleId: 'BQA-PUNC-003', severity: 'warning', provider: 'bareeq-core', file: rel, line: lineNumber,
        column: qIndex + 1, excerpt: snippet(rawLine, qIndex),
        message: 'استُخدمت علامة الاستفهام اللاتينية في سياق عربي؛ يفضّل ؟.'
      }));
    }

    for (const [wrong, correct] of Object.entries(config.lexicon?.highConfidenceTypos ?? {})) {
      const rx = new RegExp(`(^|[^\\p{L}])(${escapeRegExp(wrong)})(?=$|[^\\p{L}])`, 'u');
      const match = line.match(rx);
      if (match) {
        const start = match.index + match[1].length;
        findings.push(makeFinding({
          ruleId: 'BQA-LEX-001', severity: 'error', provider: 'bareeq-core', file: rel, line: lineNumber,
          column: start + 1, excerpt: snippet(rawLine, start), suggestion: correct,
          message: `خطأ إملائي عالي الثقة: «${wrong}»؛ المقترح «${correct}».`
        }));
      }
    }

    const duplicateWord = findAdjacentDuplicateArabicWord(line);
    if (duplicateWord) {
      findings.push(makeFinding({
        ruleId: 'BQA-LEX-002', severity: 'info', provider: 'bareeq-core', file: rel, line: lineNumber,
        column: duplicateWord.index + 1, excerpt: snippet(rawLine, duplicateWord.index),
        message: `كلمة عربية متكررة مباشرة: «${duplicateWord.word}».`
      }));
    }

    const mixed = line.match(MIXED_SCRIPT_TOKEN_RE);
    if (mixed) {
      findings.push(makeFinding({
        ruleId: 'BQA-LEX-003', severity: 'warning', provider: 'bareeq-core', file: rel, line: lineNumber,
        column: mixed.index + 1, excerpt: mixed[0],
        message: 'رمز واحد يخلط العربية واللاتينية؛ تحقق أنه مقصود وليس خطأ لصق.'
      }));
    }

    if (/^\s*>/u.test(rawLine) || /^\s*[-*+]\s+/u.test(rawLine) || /^\s*\d+[.)]\s+/u.test(rawLine)) {
      flushParagraph();
      continue;
    }

    if (paragraphStart === null) paragraphStart = lineNumber;
    paragraphLines.push(stripInlineMarkdown(rawLine));
  }
  flushParagraph();

  if (inFence) {
    findings.push(makeFinding({
      ruleId: 'BQA-MD-003', severity: 'error', provider: 'bareeq-core', file: rel, line: fenceOpenLine ?? parsed.bodyStartLine,
      message: 'كتلة كود Markdown بدأت ولم تُغلق.'
    }));
  }

  for (const paragraph of paragraphs) {
    const words = countWords(paragraph.text);
    if (words > Number(config.style?.maxParagraphWords ?? 180)) {
      findings.push(makeFinding({
        ruleId: 'BQA-STYLE-001', severity: 'warning', provider: 'bareeq-style', file: rel, line: paragraph.line,
        message: `فقرة طويلة (${words} كلمة)؛ راجع قابلية القراءة دون فرض إعادة صياغة.`
      }));
    }

    const sentences = splitSentences(paragraph.text);
    for (const sentence of sentences) {
      const sentenceWords = countWords(sentence);
      if (sentenceWords > Number(config.style?.maxSentenceWords ?? 55)) {
        findings.push(makeFinding({
          ruleId: 'BQA-STYLE-002', severity: 'warning', provider: 'bareeq-style', file: rel, line: paragraph.line,
          excerpt: sentence.slice(0, 180),
          message: `جملة طويلة (${sentenceWords} كلمة)؛ راجعها تحريريًا.`
        }));
        break;
      }
      const opener = normalizeForComparison(sentence).split(/\s+/u).filter(Boolean)[0];
      if (opener) sentenceOpeners.push({ opener, line: paragraph.line });
    }

    for (const phrase of config.style?.genericPhrases ?? []) {
      if (paragraph.text.includes(phrase)) genericPhraseHits += 1;
    }
  }

  for (let i = 2; i < sentenceOpeners.length; i += 1) {
    if (sentenceOpeners[i].opener === sentenceOpeners[i - 1].opener && sentenceOpeners[i].opener === sentenceOpeners[i - 2].opener) {
      findings.push(makeFinding({
        ruleId: 'BQA-STYLE-003', severity: 'warning', provider: 'bareeq-style', file: rel, line: sentenceOpeners[i - 2].line,
        message: `ثلاث جمل متتابعة تبدأ بالكلمة نفسها «${sentenceOpeners[i].opener}»؛ تحقق من الإيقاع.`
      }));
      break;
    }
  }

  if (genericPhraseHits >= Number(config.style?.aiMarkerDensityWarn ?? 3)) {
    findings.push(makeFinding({
      ruleId: 'BQA-STYLE-004', severity: 'warning', provider: 'bareeq-style', file: rel, line: parsed.bodyStartLine,
      message: `كثافة مرتفعة نسبيًا لعبارات افتتاحية/انتقالية نمطية (${genericPhraseHits}). هذه ملاحظة أسلوبية فقط ولا تعني أن النص مولد آليًا.`
    }));
  }

  return finalize(findings, suppressions);
}

export function extractProtectedTokens(source) {
  const parsed = parseFrontmatter(source);
  const text = parsed.ok ? parsed.body : source;
  return {
    urls: uniqueMatches(text, URL_RE),
    emails: uniqueMatches(text, EMAIL_RE),
    numbers: uniqueMatches(text, NUMBER_RE),
    acronyms: uniqueMatches(text, ACRONYM_RE)
  };
}

export function compareProtectedTokens({ file, baseSource, headSource, strict = false }) {
  const base = extractProtectedTokens(baseSource);
  const head = extractProtectedTokens(headSource);
  const findings = [];
  for (const key of Object.keys(base)) {
    const removed = multisetDifference(base[key], head[key]);
    const added = multisetDifference(head[key], base[key]);
    if (!removed.length && !added.length) continue;
    findings.push(makeFinding({
      ruleId: 'BQA-SEM-001',
      severity: strict ? 'error' : 'warning',
      provider: 'bareeq-semantic-guard',
      file: file.replaceAll('\\', '/'),
      line: 1,
      message: `تغيّرت رموز محمية من نوع ${key}: أزيل ${removed.length} وأضيف ${added.length}. راجع الأرقام/الروابط/المصطلحات قبل اعتماد إعادة الصياغة.`,
      details: { removed: removed.slice(0, 20), added: added.slice(0, 20), tokenType: key }
    }));
  }
  return findings;
}

export async function runLanguageTool({ file, source, config, endpoint, strict = false }) {
  if (!endpoint) return [];
  const parsed = parseFrontmatter(source);
  const text = toPlainText(parsed.ok ? parsed.body : source);
  const chunks = chunkText(text, Number(config.externalProviders?.languageTool?.maxCharsPerRequest ?? 11000));
  const findings = [];
  let chunkOffset = 0;

  for (const chunk of chunks) {
    const body = new URLSearchParams({ language: 'ar', text: chunk });
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'BareeqArabicQA/1.0' },
        body,
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      findings.push(makeFinding({
        ruleId: 'BQA-PROVIDER-001', severity: strict ? 'error' : 'warning', provider: 'languagetool', file, line: 1,
        message: `تعذر الوصول إلى LanguageTool: ${error.message}`
      }));
      return findings;
    }

    if (!response.ok) {
      findings.push(makeFinding({
        ruleId: 'BQA-PROVIDER-001', severity: strict ? 'error' : 'warning', provider: 'languagetool', file, line: 1,
        message: `LanguageTool أعاد HTTP ${response.status}.`
      }));
      return findings;
    }

    const payload = await response.json();
    for (const match of payload.matches ?? []) {
      const category = match.rule?.category?.id ?? 'UNKNOWN';
      const isTypo = /TYPOS|MISSPELL|SPELL/u.test(`${category} ${match.rule?.id ?? ''}`);
      findings.push(makeFinding({
        ruleId: `LT-${match.rule?.id ?? 'UNKNOWN'}`,
        severity: strict && isTypo ? 'error' : 'warning',
        provider: 'languagetool',
        file,
        line: null,
        column: null,
        excerpt: match.context?.text ?? null,
        suggestion: match.replacements?.slice(0, 3).map((item) => item.value).join(' | ') || null,
        message: match.message ?? 'ملاحظة من LanguageTool.',
        details: { category, offset: chunkOffset + Number(match.offset ?? 0), length: Number(match.length ?? 0) }
      }));
    }
    chunkOffset += chunk.length;
  }

  return findings;
}

export function summarize(findings, filesScanned) {
  const counts = { fatal: 0, error: 0, warning: 0, info: 0 };
  const providers = {};
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    providers[finding.provider] = (providers[finding.provider] ?? 0) + 1;
  }
  return {
    filesScanned,
    findings: findings.length,
    counts,
    providers,
    passed: (counts.error ?? 0) === 0 && (counts.fatal ?? 0) === 0
  };
}

export function renderMarkdownReport({ summary, findings, gateVersion, generatedAt = new Date().toISOString() }) {
  const rows = findings
    .sort(compareFindings)
    .map((item) => `| ${escapeCell(item.severity.toUpperCase())} | ${escapeCell(item.provider)} | ${escapeCell(item.ruleId)} | ${escapeCell(item.file)}${item.line ? `:${item.line}` : ''} | ${escapeCell(item.message)} |`)
    .join('\n');
  return `# Bareeq Arabic Quality Gate\n\n- Gate version: **${gateVersion}**\n- Generated: ${generatedAt}\n- Files scanned: **${summary.filesScanned}**\n- Result: **${summary.passed ? 'PASS' : 'FAIL'}**\n- Fatal: **${summary.counts.fatal}** · Errors: **${summary.counts.error}** · Warnings: **${summary.counts.warning}** · Info: **${summary.counts.info}**\n\n## Findings\n\n${findings.length ? `| Severity | Provider | Rule | Location | Message |\n|---|---|---|---|---|\n${rows}` : 'No findings. ✅'}\n`;
}

export function toPlainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^\s*>\s?/gmu, '')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/^\s*\d+[.)]\s+/gmu, '')
    .replace(/[|*_~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function extractSuppressions(source) {
  const set = new Set();
  const rx = /<!--\s*bareeq-qa-disable\s+([A-Z0-9-*_,\s]+)\s*-->/giu;
  for (const match of source.matchAll(rx)) {
    for (const token of match[1].split(/[\s,]+/u).map((x) => x.trim()).filter(Boolean)) set.add(token);
  }
  return set;
}

function finalize(findings, suppressions) {
  return findings.filter((finding) => !suppressed(finding.ruleId, suppressions));
}

function suppressed(ruleId, suppressions) {
  if (suppressions.has('*') || suppressions.has(ruleId)) return true;
  for (const token of suppressions) {
    if (token.endsWith('*') && ruleId.startsWith(token.slice(0, -1))) return true;
  }
  return false;
}

function makeFinding({ ruleId, severity, provider, file, line = null, column = null, message, excerpt = null, suggestion = null, details = null }) {
  return { ruleId, severity, provider, file, line, column, message, excerpt, suggestion, details };
}

function maskProtectedMarkdown(line) {
  let masked = line;
  const patterns = [
    /`[^`]*`/gu,
    /https?:\/\/[^\s)\]>"']+/giu,
    /\]\([^)]*\)/gu,
    /<[^>]+>/gu
  ];
  for (const rx of patterns) {
    masked = masked.replace(rx, (match) => '¤'.repeat(match.length));
  }
  return masked;
}

function stripInlineMarkdown(text) {
  return text
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_~]/gu, '')
    .replace(/<[^>]+>/gu, ' ')
    .trim();
}

function findAdjacentDuplicateArabicWord(line) {
  const tokens = [...line.matchAll(ARABIC_WORD_RE)].map((match) => ({
    raw: match[0],
    norm: normalizeForComparison(match[0]),
    index: match.index
  }));
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].norm.length >= 3 && tokens[i].norm === tokens[i - 1].norm) {
      const between = line.slice(tokens[i - 1].index + tokens[i - 1].raw.length, tokens[i].index);
      if (/^[\s،؛,:-]*$/u.test(between)) return { word: tokens[i].raw, index: tokens[i].index };
    }
  }
  return null;
}

function normalizeForComparison(text) {
  return String(text)
    .normalize('NFKC')
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('ar');
}

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/u).filter(Boolean).length : 0;
}

function splitSentences(text) {
  return text.split(/(?<=[.!؟!])\s+/u).map((item) => item.trim()).filter(Boolean);
}

function visibleInvisibleExcerpt(line) {
  return line.replace(DANGEROUS_INVISIBLES_RE, '⟦INVISIBLE⟧').slice(0, 220);
}

function snippet(line, index, radius = 55) {
  const start = Math.max(0, index - radius);
  const end = Math.min(line.length, index + radius);
  return line.slice(start, end).trim();
}

function uniqueMatches(text, regex) {
  return [...text.matchAll(new RegExp(regex.source, regex.flags))].map((m) => m[0]);
}

function multisetDifference(a, b) {
  const counts = new Map();
  for (const item of b) counts.set(item, (counts.get(item) ?? 0) + 1);
  const out = [];
  for (const item of a) {
    const count = counts.get(item) ?? 0;
    if (count > 0) counts.set(item, count - 1);
    else out.push(item);
  }
  return out;
}

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function compareFindings(a, b) {
  const sev = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  if (sev) return sev;
  return `${a.file}:${a.line ?? 0}:${a.ruleId}`.localeCompare(`${b.file}:${b.line ?? 0}:${b.ruleId}`, 'ar');
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
