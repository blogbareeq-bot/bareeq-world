import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpokenArticle, splitSpokenArticle, activeSplitSettings } from './audio-split.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';

const PENDING_IDS = [
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
];

function arg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((v) => v.startsWith(prefix))?.slice(prefix.length) || fallback;
}
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
function safeWords(text) { return tokenizeVerbal(text).filter(Boolean); }
function itemId(item) { return item.runtimeId || item.segmentId || null; }

function partRanges(parts) {
  let cursor = 0;
  return parts.map((part) => {
    const count = safeWords(part.text).length;
    const row = { part, start: cursor, end: cursor + count };
    cursor += count;
    return row;
  });
}

function itemRanges(part, partStart) {
  let cursor = partStart;
  return (part.items || []).map((item) => {
    const count = safeWords(item.text).length;
    const row = { item, start: cursor, end: cursor + count };
    cursor += count;
    return row;
  });
}

function segmentText(part, id) {
  return (part.items || [])
    .filter((item) => itemId(item) === id)
    .map((item) => item.text)
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function reconstruct(row, artifactRoot, repoRoot, live) {
  const article = await loadSpokenArticle(row.articleId, repoRoot);
  const duration = live?.articles?.find((item) => item.articleId === row.articleId)?.durationSeconds ?? null;
  const split = splitSpokenArticle(article, {
    settings: activeSplitSettings(),
    liveDurationSeconds: duration,
  });
  const dir = path.join(artifactRoot, 'audio-candidates', row.articleId, row.fingerprint);
  const checkpoint = await json(path.join(dir, 'checkpoint.json'));
  const generation = await json(path.join(dir, 'generation-report.json'));
  if (Number(generation?.split?.parts?.length) !== split.parts.length) {
    throw new Error(`${row.articleId}: reconstructed split count ${split.parts.length} != generation ${generation?.split?.parts?.length}`);
  }
  return { row, article, split, dir, checkpoint };
}

function partAudioPath(recon, partIndex) {
  const record = recon.checkpoint?.completedParts?.[String(partIndex)];
  if (!record?.file) throw new Error(`${recon.row.articleId}: missing checkpoint file for part ${partIndex}`);
  return path.join(recon.dir, 'parts', record.file);
}

async function exactSegmentCandidate(recon) {
  const candidates = [];
  for (const part of recon.split.parts) {
    const audioPath = partAudioPath(recon, part.partIndex);
    const info = await stat(audioPath);
    for (const sync of part.sync || []) {
      const text = segmentText(part, sync.id);
      const words = safeWords(text);
      if (words.length < 6 || words.length > 45) continue;
      const estimatedSeconds = Number(part.estimatedSeconds || 0) * (Number(sync.end) - Number(sync.start));
      if (!(estimatedSeconds >= 3 && estimatedSeconds <= 28)) continue;
      candidates.push({
        part,
        sync,
        text,
        words,
        audioPath,
        audioBytes: info.size,
        estimatedSeconds,
        fitness: Math.abs(estimatedSeconds - 10) + Math.abs(words.length - 18) / 6,
      });
    }
  }
  if (!candidates.length) throw new Error(`${recon.row.articleId}: no bounded Exact control segment found`);
  candidates.sort((a,b)=>a.fitness-b.fitness || a.audioBytes-b.audioBytes);
  return candidates[0];
}

async function pendingErrorSegment(recon) {
  const adjudication = await json(path.join(recon.dir, 'reports', 'asr-adjudication.json'));
  const diffs = [
    ...(adjudication.substantiveDifferences || []),
    ...(adjudication.unresolved || []),
  ].filter((item) => Number.isInteger(Number(item.expectedIndex)));
  if (!diffs.length) throw new Error(`${recon.row.articleId}: no adjudicated error index`);
  const expectedIndex = Number(diffs[0].expectedIndex);
  const ranges = partRanges(recon.split.parts);
  const pr = ranges.find((r) => expectedIndex >= r.start && expectedIndex < r.end);
  if (!pr) throw new Error(`${recon.row.articleId}: error index ${expectedIndex} is outside reconstructed parts`);
  const ir = itemRanges(pr.part, pr.start).find((r) => expectedIndex >= r.start && expectedIndex < r.end && itemId(r.item));
  if (!ir) throw new Error(`${recon.row.articleId}: could not map error index ${expectedIndex} to a sync item`);
  const id = itemId(ir.item);
  const sync = (pr.part.sync || []).find((entry) => entry.id === id);
  if (!sync) throw new Error(`${recon.row.articleId}: sync entry missing for ${id}`);
  const text = segmentText(pr.part, id);
  const words = safeWords(text);
  const partRelativeIndex = expectedIndex - pr.start;
  let itemRelativeIndex = expectedIndex - ir.start;
  itemRelativeIndex = Math.max(0, Math.min(words.length - 1, itemRelativeIndex));
  return {
    part: pr.part,
    sync,
    text,
    words,
    audioPath: partAudioPath(recon, pr.part.partIndex),
    expectedIndex,
    targetWordIndex: itemRelativeIndex,
    expectedWord: words[itemRelativeIndex] || null,
    baselineError: diffs[0],
  };
}

function negativeControl(words) {
  const candidates = words
    .map((word,index)=>({word,index}))
    .filter(({word}) => /[؀-ۿ]/.test(word) && [...word].length >= 4);
  const pick = candidates[Math.floor(candidates.length / 2)] || { word: words[Math.floor(words.length/2)], index: Math.floor(words.length/2) };
  const replacement = pick.word === 'مختلفة' ? 'تجريبية' : 'مختلفة';
  const changed = [...words];
  changed[pick.index] = replacement;
  return { index: pick.index, original: pick.word, replacement, text: changed.join(' ') };
}

export async function buildPilotManifest({ artifactRoot, repoRoot = process.cwd() }) {
  const status = await json(path.join(artifactRoot, 'docs', 'audio', 'PROGRESSIVE-STATUS.json'));
  const live = await json(path.join(repoRoot, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json'));
  const exactRows = (status.rows || []).filter((row)=>row.exact === true);
  const reconstructedExact = [];
  for (const row of exactRows) {
    const recon = await reconstruct(row, artifactRoot, repoRoot, live);
    const segment = await exactSegmentCandidate(recon);
    reconstructedExact.push({ recon, segment });
  }
  reconstructedExact.sort((a,b)=>a.segment.audioBytes-b.segment.audioBytes || a.segment.fitness-b.segment.fitness);
  const exact = reconstructedExact.slice(0,2).map(({recon,segment}) => {
    const words = safeWords(segment.text);
    return {
      role:'exact-control',
      articleId:recon.row.articleId,
      title:recon.row.title,
      fingerprint:recon.row.fingerprint,
      fullSha256:recon.row.fullSha256,
      partIndex:segment.part.partIndex,
      audioPath:segment.audioPath,
      startRatio:segment.sync.start,
      endRatio:segment.sync.end,
      verificationText:words.join(' '),
      expectedTokens:words,
      negativeControl:negativeControl(words),
    };
  });

  const pending = [];
  for (const articleId of PENDING_IDS) {
    const row = (status.rows || []).find((item)=>item.articleId === articleId);
    if (!row || row.exact === true) throw new Error(`${articleId}: expected active pending row`);
    const recon = await reconstruct(row, artifactRoot, repoRoot, live);
    const segment = await pendingErrorSegment(recon);
    pending.push({
      role:'one-error-pending',
      articleId:row.articleId,
      title:row.title,
      fingerprint:row.fingerprint,
      fullSha256:row.fullSha256,
      partIndex:segment.part.partIndex,
      audioPath:segment.audioPath,
      startRatio:segment.sync.start,
      endRatio:segment.sync.end,
      verificationText:segment.words.join(' '),
      expectedTokens:segment.words,
      targetWordIndex:segment.targetWordIndex,
      expectedWord:segment.expectedWord,
      baselineError:segment.baselineError,
    });
  }

  return {
    schema:'bareeq.audio-gate4-pilot-manifest.v1',
    generatedAt:new Date().toISOString(),
    sourceRunId:status.sourceRunId,
    alignmentModel:'jonatasgrosman/wav2vec2-large-xlsr-53-arabic',
    entries:[...exact,...pending],
    providerCalls:0,
    ttsCalls:0,
  };
}

async function cli() {
  const artifactRoot=path.resolve(arg('root','gate4-input'));
  const out=path.resolve(arg('out','gate4-output/PILOT-MANIFEST.json'));
  const result=await buildPilotManifest({artifactRoot});
  await mkdir(path.dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(result,null,2)+'\n');
  console.log(`GATE4_PILOT_PREP exact=${result.entries.filter(x=>x.role==='exact-control').length} pending=${result.entries.filter(x=>x.role==='one-error-pending').length} providerCalls=0`);
}
const isCli=process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
