import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractArticleSpeechModel, readSpeechScript } from './speech-script-core.mjs';
import { buildGeminiPrompt } from './speech-prompt.mjs';
import {
  LEGACY_SPLIT,
  QUOTA_SPLIT,
  PERFORMANCE_INSTRUCTIONS,
  PRODUCTION_TTS_MODEL,
  PRODUCTION_VOICE,
  GENERATOR_VERSION,
  utf8Bytes,
  sha256,
  joinSpeechPieces,
  estimateGeminiTokens,
} from './audio-constants.mjs';
import { attachSync } from './audio-sync.mjs';

function splitOversizedText(text, maxBytes) {
  if (utf8Bytes(text) <= maxBytes) return [text];
  const sentences = text.match(/[^.!؟؛]+[.!؟؛]?/g) || [text];
  const chunks = [];
  let current = '';
  const pushWords = (sentence) => {
    const words = sentence.trim().split(/\s+/);
    let part = '';
    for (const word of words) {
      const candidate = part ? `${part} ${word}` : word;
      if (utf8Bytes(candidate) > maxBytes && part) {
        chunks.push(part.trim());
        part = word;
      } else if (utf8Bytes(candidate) > maxBytes) {
        let tiny = '';
        for (const char of [...word]) {
          if (utf8Bytes(tiny + char) > maxBytes && tiny) {
            chunks.push(tiny);
            tiny = '';
          }
          tiny += char;
        }
        part = tiny;
      } else {
        part = candidate;
      }
    }
    if (part) chunks.push(part.trim());
  };
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (utf8Bytes(sentence) > maxBytes) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      pushWords(sentence);
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (utf8Bytes(candidate) > maxBytes && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export async function loadSpokenArticle(articleId, root = process.cwd()) {
  const filename = `${articleId}.md`;
  const source = await readFile(path.join(root, 'src', 'content', 'posts', filename), 'utf8');
  const model = extractArticleSpeechModel({ articleId, source, filename });
  const script = await readSpeechScript(articleId, root);
  const records = new Map((script?.segments ?? []).map((segment) => [segment.segmentId, segment]));
  const items = model.segments.map((segment) => ({
    segmentId: segment.segmentId,
    runtimeId: segment.runtimeId,
    type: segment.type,
    match: segment.match,
    text: records.get(segment.segmentId)?.spokenText ?? segment.sourceText,
  }));
  const spokenText = joinSpeechPieces(items);
  return {
    articleId,
    title: model.title,
    model,
    script,
    items,
    spokenText,
    spokenChars: [...spokenText].length,
    spokenBytes: utf8Bytes(spokenText),
    speechScriptHash: script?.scriptHash ?? null,
  };
}

export function estimateCharsPerSecond(article, liveDurationSeconds) {
  if (liveDurationSeconds > 0 && article.spokenChars > 0) {
    return article.spokenChars / liveDurationSeconds;
  }
  return QUOTA_SPLIT.defaultCharsPerSecond;
}

function estimateSeconds(text, charsPerSecond) {
  return [...text].length / Math.max(1, charsPerSecond);
}

function wouldExceed(text, settings, charsPerSecond, articleTitle, partIndex, partCount) {
  const transcriptBytes = utf8Bytes(text);
  if (settings.maxTranscriptBytes && transcriptBytes > settings.maxTranscriptBytes) return true;
  if (settings.maxSeconds && estimateSeconds(text, charsPerSecond) > settings.maxSeconds) return true;
  if (settings.geminiInputTokenLimit) {
    const prompt = buildGeminiPrompt({ text }, { articleTitle, partIndex, partCount });
    if (estimateGeminiTokens(prompt) > settings.geminiInputTokenLimit) return true;
  }
  return false;
}

function makePart(items, charsPerSecond, articleTitle, partIndex, partCount) {
  const text = joinSpeechPieces(items);
  const prompt = buildGeminiPrompt({ text }, { articleTitle, partIndex, partCount });
  return attachSync({
    text,
    items,
    chars: [...text].length,
    bytes: utf8Bytes(text),
    estimatedSeconds: Number(estimateSeconds(text, charsPerSecond).toFixed(2)),
    promptBytes: utf8Bytes(prompt),
    estimatedTokens: estimateGeminiTokens(prompt),
    partIndex,
    partCount,
  });
}

function reindex(parts, charsPerSecond, articleTitle) {
  return parts.map((part, index) => makePart(part.items, charsPerSecond, articleTitle, index, parts.length));
}

function asItemParts(parts) {
  return parts.map((part) => ({ items: part.items || part }));
}

function rebalanceAllParts(parts, settings, charsPerSecond, articleTitle) {
  const min = settings.minSeconds ?? 0;
  if (parts.length < 2 || min <= 0) return parts;
  let current = parts;
  for (let guard = 0; guard < 24; guard += 1) {
    const shortIndex = current.findIndex((part) => part.estimatedSeconds < min);
    if (shortIndex === -1) return current;
    const tryMerge = (left, right) => {
      const mergedItems = [...current[left].items, ...current[right].items];
      const text = joinSpeechPieces(mergedItems);
      if (wouldExceed(text, settings, charsPerSecond, articleTitle, left, current.length - 1)) return null;
      return reindex([
        ...asItemParts(current.slice(0, left)),
        { items: mergedItems },
        ...asItemParts(current.slice(right + 1)),
      ], charsPerSecond, articleTitle);
    };
    if (shortIndex > 0) {
      const merged = tryMerge(shortIndex - 1, shortIndex);
      if (merged) {
        current = merged;
        continue;
      }
    }
    if (shortIndex < current.length - 1) {
      const merged = tryMerge(shortIndex, shortIndex + 1);
      if (merged) {
        current = merged;
        continue;
      }
    }
    const donor = shortIndex > 0 ? shortIndex - 1 : shortIndex < current.length - 1 ? shortIndex + 1 : -1;
    if (donor < 0 || current[donor].items.length < 2) {
      current[shortIndex] = {
        ...current[shortIndex],
        splitReason: current[shortIndex].splitReason || `short-part-unavoidable:${current[shortIndex].estimatedSeconds}s`,
      };
      return current;
    }
    const fromLeft = donor < shortIndex;
    const remain = [...current[donor].items];
    const stolen = [...current[shortIndex].items];
    while (remain.length > 1) {
      const piece = fromLeft ? remain.pop() : remain.shift();
      const nextStolen = fromLeft ? [piece, ...stolen] : [...stolen, piece];
      const donorText = joinSpeechPieces(remain);
      const shortText = joinSpeechPieces(nextStolen);
      if (wouldExceed(shortText, settings, charsPerSecond, articleTitle, shortIndex, current.length)) {
        if (fromLeft) remain.push(piece);
        else remain.unshift(piece);
        break;
      }
      if (estimateSeconds(donorText, charsPerSecond) < min) {
        if (fromLeft) remain.push(piece);
        else remain.unshift(piece);
        break;
      }
      stolen.length = 0;
      stolen.push(...nextStolen);
      if (estimateSeconds(joinSpeechPieces(stolen), charsPerSecond) >= min) break;
    }
    if (stolen.length === current[shortIndex].items.length) {
      current[shortIndex] = {
        ...current[shortIndex],
        splitReason: current[shortIndex].splitReason || `short-part-unavoidable:${current[shortIndex].estimatedSeconds}s`,
      };
      return current;
    }
    const rebuilt = asItemParts(current);
    rebuilt[donor] = { items: remain };
    rebuilt[shortIndex] = { items: stolen };
    current = reindex(rebuilt, charsPerSecond, articleTitle);
  }
  return current;
}

function rebalanceParts(parts, settings, charsPerSecond, articleTitle) {
  return rebalanceAllParts(parts, settings, charsPerSecond, articleTitle);
}

function packEven(units, settings, charsPerSecond, articleTitle) {
  if (!units.length) return [];
  const min = settings.minSeconds ?? 0;
  const max = settings.maxSeconds || Infinity;
  const target = settings.targetSeconds || (Number.isFinite(max) ? max : 165);
  const canHold = (items, partIndex, partCount) => !wouldExceed(joinSpeechPieces(items), settings, charsPerSecond, articleTitle, partIndex, partCount);
  const totalSeconds = estimateSeconds(joinSpeechPieces(units), charsPerSecond);
  if (canHold(units, 0, 1) && totalSeconds <= max && totalSeconds <= target * 1.2) {
    return reindex([{ items: units }], charsPerSecond, articleTitle);
  }
  const weights = units.map((item) => Math.max(0.01, estimateSeconds(item.text, charsPerSecond)));
  const totalW = weights.reduce((sum, weight) => sum + weight, 0);
  let n = Math.max(1, Math.round(totalW / Math.max(1, target)));
  n = Math.min(Math.max(1, n), units.length);
  if (min > 0) {
    while (n > 1 && totalW / n < min) n -= 1;
  }
  if (Number.isFinite(max)) {
    while (n < units.length && totalW / n > max) n += 1;
  }
  const parts = [];
  let start = 0;
  for (let index = 0; index < n; index += 1) {
    const remainingParts = n - index;
    if (start >= units.length) break;
    if (remainingParts === 1) {
      parts.push({ items: units.slice(start) });
      start = units.length;
      break;
    }
    const maxEnd = units.length - (remainingParts - 1);
    const desired = totalW * ((index + 1) / n);
    let acc = weights.slice(0, start).reduce((sum, weight) => sum + weight, 0);
    let end = Math.min(start + 1, maxEnd);
    acc += weights[start] || 0;
    while (end < maxEnd) {
      if (!canHold(units.slice(start, end + 1), index, n)) break;
      const currentSeconds = estimateSeconds(joinSpeechPieces(units.slice(start, end)), charsPerSecond);
      if (end > start && currentSeconds >= Math.min(target, Number.isFinite(max) ? max : target)) break;
      if (acc >= desired && (min <= 0 || currentSeconds >= min)) break;
      if (acc >= desired * 0.9 && (min <= 0 || currentSeconds >= min * 0.85)) {
        const overshoot = (acc + weights[end]) - desired;
        const undershoot = desired - acc;
        if (overshoot >= undershoot) break;
      }
      acc += weights[end];
      end += 1;
    }
    parts.push({ items: units.slice(start, end) });
    start = end;
  }
  if (start < units.length) parts.push({ items: units.slice(start) });
  return splitOversizedItemParts(parts, settings, charsPerSecond, articleTitle);
}

function splitOversizedItemParts(parts, settings, charsPerSecond, articleTitle) {
  const max = settings.maxSeconds || Infinity;
  if (!Number.isFinite(max)) return parts;
  const out = [];
  for (const part of parts) {
    const items = [...(part.items || [])];
    if (items.length <= 1) {
      out.push({ items });
      continue;
    }
    let current = [];
    for (const item of items) {
      const candidate = [...current, item];
      const seconds = estimateSeconds(joinSpeechPieces(candidate), charsPerSecond);
      const over = seconds > max || wouldExceed(joinSpeechPieces(candidate), settings, charsPerSecond, articleTitle, out.length, out.length + 1);
      if (current.length && over) {
        out.push({ items: current });
        current = [item];
      } else {
        current = candidate;
      }
    }
    if (current.length) out.push({ items: current });
  }
  return out.length ? out : parts;
}

function packGreedy(units, settings, charsPerSecond, articleTitle) {
  const parts = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    parts.push({ items: current });
    current = [];
  };
  for (const item of units) {
    const candidateItems = [...current, item];
    const candidateText = joinSpeechPieces(candidateItems);
    const over = wouldExceed(candidateText, settings, charsPerSecond, articleTitle, parts.length, parts.length + 1);
    if (current.length && over) flush();
    current.push(item);
    const solo = joinSpeechPieces(current);
    if (wouldExceed(solo, settings, charsPerSecond, articleTitle, parts.length, parts.length + 1) && current.length > 1) {
      const overflow = current.pop();
      flush();
      current = [overflow];
    }
  }
  flush();
  return parts;
}

function packItems(items, settings, charsPerSecond, articleTitle) {
  const units = [];
  for (const item of items) {
    const pieces = splitOversizedText(item.text, settings.maxTranscriptBytes || utf8Bytes(item.text));
    for (const text of pieces) units.push({ ...item, text });
  }
  const useEven = Boolean(settings.targetSeconds || settings.maxSeconds);
  const packed = useEven
    ? packEven(units, settings, charsPerSecond, articleTitle)
    : packGreedy(units, settings, charsPerSecond, articleTitle);
  const source = packed.length ? packed : [{ items: units }];
  const folded = [];
  for (let index = 0; index < source.length; index += 1) {
    const part = source[index];
    const hasBody = (part.items || []).some((item) => item.type !== 'title');
    if (!hasBody && index + 1 < source.length) {
      const combined = { items: [...part.items, ...source[index + 1].items] };
      const combinedText = joinSpeechPieces(combined.items);
      if (!wouldExceed(combinedText, settings, charsPerSecond, articleTitle, folded.length, Math.max(1, source.length - 1))) {
        source[index + 1] = combined;
        continue;
      }
    }
    folded.push(part);
  }
  const balanced = rebalanceParts(reindex(folded, charsPerSecond, articleTitle), settings, charsPerSecond, articleTitle);
  return balanced.map((part) => ({
    ...part,
    splitReason: part.splitReason || (
      balanced.length === 1
        ? 'single-part-article-fits-contract'
        : part.estimatedSeconds < (settings.minSeconds || 0)
          ? `below-min-${settings.minSeconds}s-unavoidable`
          : `even-pack-target-${settings.targetSeconds}s-cap-${settings.maxSeconds}s`
    ),
  }));
}

export function activeSplitSettings(settings) {
  if (process.env.BAREEQ_AUDIO_TEST_SPLIT === 'tiny' && process.env.BAREEQ_TTS_CONTRACT_TEST === '1') {
    return {
      ...QUOTA_SPLIT,
      name: 'test-tiny',
      maxTranscriptBytes: 400,
      maxSeconds: 600,
      minSeconds: 0,
      rebalanceFloorSeconds: 0,
      targetSeconds: 1,
    };
  }
  return settings || QUOTA_SPLIT;
}

export function splitSpokenArticle(article, { settings = QUOTA_SPLIT, liveDurationSeconds = null } = {}) {
  const charsPerSecond = estimateCharsPerSecond(article, liveDurationSeconds);
  const parts = packItems(article.items, settings, charsPerSecond, article.title);
  const justification = parts.length > 6
    ? `Article spoken length ${article.spokenChars} chars / live ${liveDurationSeconds ?? 'n/a'}s needs ${parts.length} parts at ≤${settings.maxSeconds || 'n/a'}s Gemini quality cap and ≤${settings.geminiInputTokenLimit || 'n/a'} input tokens.`
    : null;
  return {
    articleId: article.articleId,
    settings,
    charsPerSecond: Number(charsPerSecond.toFixed(3)),
    liveDurationSeconds,
    parts,
    ttsRequests: parts.length,
    maxPartBytes: Math.max(0, ...parts.map((part) => part.bytes)),
    maxPartEstimatedSeconds: Math.max(0, ...parts.map((part) => part.estimatedSeconds)),
    maxPartEstimatedTokens: Math.max(0, ...parts.map((part) => part.estimatedTokens || 0)),
    justification,
  };
}

function splitFingerprintPayload(splitPlan) {
  return {
    version: splitPlan.settings.version,
    algorithmVersion: splitPlan.settings.algorithmVersion || splitPlan.settings.version,
    name: splitPlan.settings.name,
    maxTranscriptBytes: splitPlan.settings.maxTranscriptBytes,
    targetSeconds: splitPlan.settings.targetSeconds,
    maxSeconds: splitPlan.settings.maxSeconds,
    minSeconds: splitPlan.settings.minSeconds,
    geminiInputTokenLimit: splitPlan.settings.geminiInputTokenLimit,
    geminiTokenEstimateDivisorBytes: splitPlan.settings.geminiTokenEstimateDivisorBytes,
    rebalanceFloorSeconds: splitPlan.settings.rebalanceFloorSeconds,
    defaultCharsPerSecond: splitPlan.settings.defaultCharsPerSecond,
    charsPerSecond: splitPlan.charsPerSecond,
    liveDurationSeconds: splitPlan.liveDurationSeconds ?? null,
    generatorVersion: splitPlan.settings.generatorVersion || GENERATOR_VERSION,
  };
}

export function candidateFingerprint(article, splitPlan) {
  return sha256(JSON.stringify({
    articleId: article.articleId,
    spokenText: article.spokenText,
    speechScriptHash: article.speechScriptHash,
    model: PRODUCTION_TTS_MODEL,
    voice: PRODUCTION_VOICE,
    generatorVersion: GENERATOR_VERSION,
    performanceInstructions: PERFORMANCE_INSTRUCTIONS,
    split: splitFingerprintPayload(splitPlan),
    partTexts: splitPlan.parts.map((part) => part.text),
    partIndexes: splitPlan.parts.map((part) => part.partIndex),
  }));
}

export function partFingerprint(article, splitPlan, part) {
  return sha256(JSON.stringify({
    articleId: article.articleId,
    spokenText: part.text,
    speechScriptHash: article.speechScriptHash,
    model: PRODUCTION_TTS_MODEL,
    voice: PRODUCTION_VOICE,
    generatorVersion: GENERATOR_VERSION,
    performanceInstructions: PERFORMANCE_INSTRUCTIONS,
    split: splitFingerprintPayload(splitPlan),
    partIndex: part.partIndex,
    partCount: splitPlan.parts.length,
  }));
}

export { LEGACY_SPLIT, QUOTA_SPLIT };
