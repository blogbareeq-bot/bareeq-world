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
  const expected = expectedSyncIds(article);
  const expectedSet = new Set(expected);
  const failures = [];
  if (!expected.length) failures.push('article has no expected sync ids');
  if (!Array.isArray(parts) || !parts.length) failures.push('sync is mandatory; no parts were provided');
  const seenOrder = [];
  const seen = new Set();
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
    const syncIds = Array.isArray(part.syncIds) ? part.syncIds : [];
    if (syncIds.length !== part.sync.length) {
      failures.push(`part ${part.partIndex ?? '?'} syncIds length does not match sync`);
    }
    for (let index = 0; index < part.sync.length; index += 1) {
      if (syncIds[index] !== part.sync[index]?.id) {
        failures.push(`part ${part.partIndex ?? '?'} syncIds[${index}] does not match sync`);
      }
    }
    let previousStart = -1;
    let previousEnd = -1;
    for (const entry of part.sync) {
      if (!expectedSet.has(entry.id) && entry.type !== 'title') failures.push(`sync entry references unknown ${entry.id}`);
      if (!(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end)) failures.push(`invalid sync ratio for ${entry.id}`);
      if (entry.start < previousStart) failures.push(`sync entries are not ordered in part ${part.partIndex ?? '?'}`);
      if (previousEnd > 0 && entry.start + 1e-9 < previousEnd) failures.push(`sync overlap for ${entry.id}`);
      previousStart = entry.start;
      previousEnd = entry.end;
      if (seen.has(entry.id)) failures.push(`duplicate sync id ${entry.id}`);
      seen.add(entry.id);
      seenOrder.push(entry.id);
    }
  }
  for (const id of expected) {
    if (!seen.has(id)) failures.push(`segment ${id} is never synchronized to audio`);
  }
  const expectedFiltered = expected.filter((id) => seen.has(id));
  if (JSON.stringify(seenOrder) !== JSON.stringify(expectedFiltered) && seenOrder.length && expectedFiltered.length) {
    failures.push('global sync order does not match article order');
  }
  return {
    passed: failures.length === 0,
    failures,
    expectedIds: expected,
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
