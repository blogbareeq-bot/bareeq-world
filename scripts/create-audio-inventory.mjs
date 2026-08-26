#!/usr/bin/env node
/**
 * Automated audio inventory for the Bareeq speech factory.
 *
 * For every published article this tool records:
 *  - the approved speech script and its hash (scripts/speech-scripts/<id>.json),
 *  - segment count and total spoken words,
 *  - the provider/model/voice currently backing the article in the repository
 *    and (with --production) on the live origin,
 *  - file status: approved / needs-review / failed / not-generated,
 *  - sync + manifest consistency for every local candidate,
 *  - whether the current audio is published live or kept only as a fallback copy.
 *
 * Usage:
 *   node scripts/create-audio-inventory.mjs                 # repository facts only
 *   node scripts/create-audio-inventory.mjs --production    # also probe the live origin
 *   node scripts/create-audio-inventory.mjs --json out.json # also write a JSON snapshot
 *
 * The tool is read-only: it never mutates audio, manifests, or scripts.
 */
import { createHash } from 'node:crypto';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PENDING_CLOUD, RETAINED_GEMINI, TEMPORARY_HAMED_ARTICLES } from './cloud-tts-rollout.mjs';

const ROOT = process.cwd();
const PRODUCTION = process.argv.includes('--production');
const JSON_FLAG_INDEX = process.argv.indexOf('--json');
const JSON_OUT = JSON_FLAG_INDEX >= 0 ? process.argv[JSON_FLAG_INDEX + 1] : '';
if (JSON_FLAG_INDEX >= 0 && !JSON_OUT) throw new Error('--json requires an output path.');
const ORIGIN = (process.env.BAREEQ_AUDIO_CACHE_ORIGIN || 'https://bareeqworld.com').replace(/\/$/, '');

const sha = (value) => createHash('sha256').update(value).digest('hex');
const audioKeyFor = (id) => sha(id).slice(0, 16);
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const readJson = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

const POSTS_DIR = path.join(ROOT, 'src', 'content', 'posts');
const SCRIPTS_DIR = path.join(ROOT, 'scripts', 'speech-scripts');
const AUDIO_ROOT = path.join(ROOT, 'public', 'audio', 'articles');
const EVIDENCE_DIR = path.join(ROOT, 'scripts', 'speech-transcript-evidence');

const publishedPosts = [];
for (const entry of (await readdir(POSTS_DIR)).filter((name) => name.endsWith('.md')).sort()) {
  const id = entry.replace(/\.md$/, '');
  const source = await readFile(path.join(POSTS_DIR, entry), 'utf8');
  const draft = /^draft:\s*true\s*$/mi.test(source);
  publishedPosts.push({ id, draft, sourceHash: sha(source) });
}

const bundledLock = await readJson(path.join(ROOT, 'scripts', 'bundled-azure-audio-map.json'));
const bundledByArticle = new Map((bundledLock?.articles ?? []).map((article) => [article.articleId, article]));
const culturalCurrent = await readJson(path.join(ROOT, 'audio-releases', 'cultural-habits-world', 'current.json'));
let culturalRelease = null;
if (culturalCurrent?.manifest) {
  culturalRelease = await readJson(path.join(ROOT, 'audio-releases', 'cultural-habits-world', culturalCurrent.manifest));
}

async function inspectLocalCandidate(articleId) {
  const key = audioKeyFor(articleId);
  const dir = path.join(AUDIO_ROOT, key);
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  if (!manifest) return null;
  const problems = [];
  let totalBlocks = 0;
  let missingFiles = 0;
  const partInfos = [];
  const defaultVoice = manifest.defaultVoice;
  for (const [index, part] of (manifest.parts ?? []).entries()) {
    const asset = part?.audio?.[defaultVoice];
    if (!asset?.src) { problems.push(`part ${index + 1}: no audio asset for voice ${defaultVoice}`); continue; }
    const file = path.join(ROOT, 'public', asset.src.replace(/^\//, ''));
    if (!(await exists(file))) { missingFiles += 1; problems.push(`part ${index + 1}: missing file ${asset.src}`); continue; }
    const bytes = await readFile(file);
    if (asset.sha256 && sha(bytes) !== asset.sha256) problems.push(`part ${index + 1}: sha256 mismatch`);
    if (asset.bytes && bytes.length !== asset.bytes) problems.push(`part ${index + 1}: byte size mismatch`);
    partInfos.push({ index: index + 1, src: asset.src, bytes: bytes.length, durationSeconds: asset.durationSeconds });
    totalBlocks += (part.sync ?? []).length;
  }
  return {
    manifestVersion: manifest.version,
    provider: manifest.provider,
    model: manifest.model,
    defaultVoice,
    sourceHash: manifest.sourceHash,
    parts: partInfos.length,
    syncBlocks: totalBlocks,
    missingFiles,
    problems,
    partCountConsistent: partInfos.length === (manifest.parts ?? []).length,
  };
}

async function inspectProduction(articleId) {
  const key = audioKeyFor(articleId);
  const url = `${ORIGIN}/audio/articles/${key}/manifest.json`;
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(20000) }); }
  catch (error) { return { url, error: `fetch failed: ${error.message}` }; }
  if (!response.ok) return { url, status: response.status };
  const manifest = await response.json();
  let blocks = 0;
  let declaredParts = 0;
  for (const part of manifest.parts ?? []) { blocks += (part.sync ?? []).length; declaredParts += 1; }
  const sample = manifest.parts?.[0]?.audio?.[manifest.defaultVoice];
  let firstPartStatus = null;
  if (sample?.src) {
    try {
      const audioResponse = await fetch(`${ORIGIN}${sample.src}`, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
      firstPartStatus = { status: audioResponse.status, cacheControl: audioResponse.headers.get('cache-control'), contentType: audioResponse.headers.get('content-type') };
    } catch (error) { firstPartStatus = { error: error.message }; }
  }
  return {
    url,
    status: response.status,
    provider: manifest.provider,
    model: manifest.model,
    defaultVoice: manifest.defaultVoice,
    sourceHash: manifest.sourceHash,
    parts: declaredParts,
    syncBlocks: blocks,
    cacheControl: response.headers.get('cache-control'),
    firstPartHead: firstPartStatus,
  };
}

const inventory = [];
for (const post of publishedPosts) {
  const script = await readJson(path.join(SCRIPTS_DIR, `${post.id}.json`));
  const spokenWords = script ? script.segments.reduce((total, segment) => total + segment.spokenText.split(/\s+/).filter(Boolean).length, 0) : 0;
  const local = await inspectLocalCandidate(post.id);
  const bundled = bundledByArticle.get(post.id) ?? null;
  const evidence = [];
  if (await exists(EVIDENCE_DIR)) {
    for (const name of (await readdir(EVIDENCE_DIR)).sort()) {
      if (!name.startsWith(post.id)) continue;
      const record = await readJson(path.join(EVIDENCE_DIR, name));
      if (!record) continue;
      evidence.push({
        file: name,
        status: record.status ?? null,
        asrModel: record.asrModel ?? record.transcriptionModel ?? null,
        wordErrorCount: record.wordErrorCount ?? record.wordErrorCountAcrossAllPasses ?? null,
        expectedWordCount: record.expectedWordCount ?? null,
      });
    }
  }
  const rollout = RETAINED_GEMINI.includes(post.id) ? 'retained-gemini'
    : TEMPORARY_HAMED_ARTICLES.includes(post.id) ? 'temporary-hamed'
    : PENDING_CLOUD.includes(post.id) ? 'pending-cloud'
    : 'unlisted';
  const qaFailed = evidence.some((item) => item.status === 'failed');
  const qaPassed = evidence.some((item) => item.status === 'passed');
  const production = PRODUCTION ? await inspectProduction(post.id) : null;
  const hasLegacyFallback = Boolean(bundled) || (post.id === 'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء' && Boolean(culturalRelease));
  let fileStatus = 'not-generated';
  if (local && local.problems.length === 0) fileStatus = qaFailed ? 'needs-review' : qaPassed ? 'approved' : 'needs-review';
  else if (local) fileStatus = 'failed';
  else if (rollout === 'retained-gemini') fileStatus = 'approved'; // published from production cache, gated before repository evidence existed
  else if (hasLegacyFallback) fileStatus = 'approved'; // locked legacy fallback kept for rollback
  inventory.push({
    articleId: post.id,
    draft: post.draft,
    sourceSha256: post.sourceHash,
    audioKey: audioKeyFor(post.id),
    rollout,
    speechScript: script ? {
      scriptHash: script.scriptHash,
      reviewVersion: script.reviewVersion,
      status: script.status,
      sourceSnapshotHash: script.sourceSnapshotHash,
      segments: script.segments.length,
      spokenWords,
    } : null,
    repositoryCandidate: local,
    bundledFallback: bundled ? {
      releaseId: bundledLock.releaseId,
      provider: 'Microsoft Azure AI Speech (bundled Hamed lock)',
      parts: bundled.parts.length,
      sourceManifestSha256: bundled.sourceManifestSha256,
    } : (post.id === 'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء' && culturalRelease) ? {
      releaseId: culturalRelease.release_id,
      provider: `${culturalRelease.provider}/${culturalRelease.model}/${culturalRelease.default_voice}`,
      parts: culturalRelease.voices?.[culturalRelease.default_voice]?.parts?.length ?? null,
      sourceManifestSha256: null,
    } : null,
    production,
    qaEvidence: evidence,
    fileStatus,
  });
}

const totals = {
  articles: inventory.length,
  published: inventory.filter((entry) => !entry.draft).length,
  withRepositoryCandidate: inventory.filter((entry) => entry.repositoryCandidate).length,
  productionParts: PRODUCTION ? inventory.reduce((total, entry) => total + (entry.production?.parts ?? 0), 0) : null,
  productionSyncBlocks: PRODUCTION ? inventory.reduce((total, entry) => total + (entry.production?.syncBlocks ?? 0), 0) : null,
  scriptSegments: inventory.reduce((total, entry) => total + (entry.speechScript?.segments ?? 0), 0),
  scriptWords: inventory.reduce((total, entry) => total + (entry.speechScript?.spokenWords ?? 0), 0),
};

const lines = [];
lines.push('# Bareeq audio inventory');
lines.push('');
lines.push(`Generated at: ${new Date().toISOString()}`);
lines.push(`Mode: ${PRODUCTION ? `repository + production (${ORIGIN})` : 'repository only'}`);
lines.push('');
lines.push('| article | rollout | script hash | segs | words | repo candidate | provider/model | production | prod parts/blocks | file status |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const entry of inventory) {
  const script = entry.speechScript;
  const local = entry.repositoryCandidate;
  const prod = entry.production;
  const localLabel = local ? `${local.provider}/${local.model}/${local.defaultVoice} ${local.parts}p ${local.problems.length === 0 ? 'OK' : 'BROKEN'}` : '—';
  const prodLabel = prod ? (prod.status === 200 ? `${prod.provider}/${prod.model}` : `HTTP ${prod.status ?? prod.error ?? '?'}`) : 'not-probed';
  const prodCounts = prod?.status === 200 ? `${prod.parts}/${prod.syncBlocks}` : '—';
  const fallbackLabel = entry.bundledFallback ? `${entry.bundledFallback.provider} ${entry.bundledFallback.parts ?? '?'}p` : '—';
  lines.push(`| ${entry.articleId.slice(0, 42)} | ${entry.rollout} | ${script ? script.scriptHash.slice(0, 8) : '—'} | ${script?.segments ?? '—'} | ${script?.spokenWords ?? '—'} | ${localLabel} | ${fallbackLabel} | ${prodLabel} | ${prodCounts} | ${entry.fileStatus} |`);
}
lines.push('');
lines.push(`Totals: ${JSON.stringify(totals)}`);
const report = lines.join('\n') + '\n';
process.stdout.write(report);

if (JSON_OUT) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
  const snapshot = { generatedAt: new Date().toISOString(), mode: PRODUCTION ? 'repository+production' : 'repository', origin: ORIGIN, totals, articles: inventory };
  await writeFile(JSON_OUT, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`inventory snapshot written to ${JSON_OUT}`);
}
