import { joinSpeechPieces } from './audio-constants.mjs';

export function estimateSpeechWeight(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const letters = [...String(text || '').replace(/\s/g, '')].length;
  const strongPauses = (String(text || '').match(/[.!؟]/g) || []).length;
  const mediumPauses = (String(text || '').match(/[،؛:]/g) || []).length;
  return Math.max(1, words + letters / 22 + strongPauses * 1.1 + mediumPauses * 0.45);
}

export function buildPartSync(items) {
  const weights = items.map((item) => estimateSpeechWeight(item.text));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let elapsed = 0;
  const sync = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const start = elapsed / total;
    elapsed += weights[index];
    const end = elapsed / total;
    const id = item.runtimeId || item.segmentId;
    if (!id || item.type === 'title') continue;
    const previous = sync[sync.length - 1];
    if (previous?.id === id) previous.end = Number(end.toFixed(6));
    else {
      sync.push({
        id,
        type: item.type,
        match: item.match,
        start: Number(start.toFixed(6)),
        end: Number(end.toFixed(6)),
      });
    }
  }
  return sync;
}

export function expectedSyncIds(article) {
  return [...new Set((article.items || [])
    .filter((item) => item.type !== 'title')
    .map((item) => item.runtimeId || item.segmentId)
    .filter(Boolean))];
}

export function validateSyncMap(article, parts) {
  const expected = new Set(expectedSyncIds(article));
  const seen = new Set();
  const failures = [];
  if (!expected.size) failures.push('article has no expected sync ids');
  if (!Array.isArray(parts) || !parts.length) failures.push('sync is mandatory; no parts were provided');
  for (const part of parts || []) {
    if (!Array.isArray(part.sync)) {
      failures.push(`part ${part.partIndex ?? '?'} is missing a sync map`);
      continue;
    }
    const contentItems = (part.items || []).filter((item) => item.type !== 'title' && (item.runtimeId || item.segmentId));
    if (!part.sync.length && contentItems.length) {
      failures.push(`part ${part.partIndex ?? '?'} is missing a sync map`);
      continue;
    }
    if (!Array.isArray(part.syncIds) || part.syncIds.length !== part.sync.length) {
      failures.push(`part ${part.partIndex ?? '?'} is missing syncIds`);
    }
    let previousStart = -1;
    for (const entry of part.sync) {
      if (!expected.has(entry.id) && entry.type !== 'title') failures.push(`sync entry references unknown ${entry.id}`);
      if (!(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end)) failures.push(`invalid sync ratio for ${entry.id}`);
      if (entry.start < previousStart) failures.push(`sync entries are not ordered in part ${part.partIndex ?? '?'}`);
      previousStart = entry.start;
      seen.add(entry.id);
    }
  }
  for (const id of expected) {
    if (!seen.has(id)) failures.push(`segment ${id} is never synchronized to audio`);
  }
  return {
    passed: failures.length === 0,
    failures,
    expectedIds: [...expected],
    seenIds: [...seen],
    method: 'paragraph-weighted',
  };
}

export function attachSync(part) {
  const sync = buildPartSync(part.items || []);
  return {
    ...part,
    text: part.text || joinSpeechPieces(part.items || []),
    sync,
    syncIds: sync.map((entry) => entry.id),
  };
}
