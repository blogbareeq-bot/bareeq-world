import { spawnSync } from 'node:child_process';
import { EXIT_HARD } from './audio-constants.mjs';
import { audioKeyFor } from './audio-constants.mjs';

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || '';
  return headers[name] || headers[name.toLowerCase()] || '';
}

export function resolvePublishRef(root, env = process.env, spawn = spawnSync) {
  const fromEnv = String(env.BAREEQ_AUDIO_PUBLISH_REF || '').trim();
  if (fromEnv) {
    if (fromEnv.includes('..') || fromEnv.includes('\0') || /\s/.test(fromEnv)) {
      throw Object.assign(new Error('BAREEQ_AUDIO_PUBLISH_REF is not a safe git ref'), { exitCode: EXIT_HARD });
    }
    return fromEnv.startsWith('refs/heads/') ? fromEnv : `refs/heads/${fromEnv}`;
  }
  const branch = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const name = branch.stdout?.trim();
  if (branch.status !== 0 || !name || name === 'HEAD') {
    throw Object.assign(new Error('publish push requires BAREEQ_AUDIO_PUBLISH_REF or a named branch; refusing detached HEAD'), { exitCode: EXIT_HARD });
  }
  return `refs/heads/${name}`;
}

export function confirmRemoteSha({ root, ref, expectedSha, spawn = spawnSync }) {
  const remote = spawn('git', ['ls-remote', 'origin', ref], { cwd: root, encoding: 'utf8' });
  if (remote.status !== 0) {
    throw Object.assign(new Error(`git ls-remote failed for ${ref}: ${remote.stderr || remote.stdout}`), { exitCode: EXIT_HARD });
  }
  const remoteSha = String(remote.stdout || '').trim().split(/\s+/)[0] || '';
  if (!remoteSha) {
    throw Object.assign(new Error(`origin ${ref} has no SHA after push`), { exitCode: EXIT_HARD });
  }
  if (remoteSha !== expectedSha) {
    throw Object.assign(new Error(`origin ${ref} is ${remoteSha}, expected ${expectedSha}`), { exitCode: EXIT_HARD });
  }
  return { ref, remoteSha, matched: true };
}

export async function verifyPublishedManifest({
  origin,
  articleId,
  fingerprint,
  fullSha256,
  parts = [],
  defaultVoice,
  fetchImpl = globalThis.fetch,
}) {
  if (!origin) {
    return {
      skipped: true,
      cloudflareVerified: false,
      note: 'BAREEQ_AUDIO_VERIFY_ORIGIN unset; Cloudflare was not verified',
    };
  }
  const base = String(origin).replace(/\/$/, '');
  const url = `${base}/audio/articles/${audioKeyFor(articleId)}/manifest.json`;
  const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const contentType = header(response.headers, 'content-type');
  if (!response.ok) {
    throw Object.assign(new Error(`production manifest HTTP ${response.status} at ${url}`), { exitCode: EXIT_HARD, url, httpStatus: response.status });
  }
  if (contentType && !/json/i.test(contentType)) {
    throw Object.assign(new Error(`production manifest Content-Type is ${contentType}, not JSON`), { exitCode: EXIT_HARD, url, contentType });
  }
  const body = await response.text();
  let manifest;
  try { manifest = JSON.parse(body); } catch {
    throw Object.assign(new Error('production manifest is not JSON'), { exitCode: EXIT_HARD, url });
  }
  const liveFingerprint = manifest.fingerprint || manifest.candidateFingerprint || manifest.publishedFromCandidate;
  if (liveFingerprint !== fingerprint) {
    throw Object.assign(new Error(`production manifest fingerprint ${liveFingerprint} does not match published ${fingerprint}`), { exitCode: EXIT_HARD, url });
  }
  if (fullSha256 && manifest.fullSha256 && manifest.fullSha256 !== fullSha256) {
    throw Object.assign(new Error('production manifest fullSha256 does not match published file'), { exitCode: EXIT_HARD, url });
  }
  const voice = defaultVoice || manifest.defaultVoice;
  const checkedParts = [];
  for (const part of (parts.length ? parts : manifest.parts || [])) {
    const asset = part.audio?.[voice] || part.audio?.[manifest.defaultVoice];
    const src = asset?.src;
    if (!src) continue;
    const partUrl = src.startsWith('http') ? src : `${base}${src.startsWith('/') ? '' : '/'}${src}`;
    const partRes = await fetchImpl(partUrl, { method: 'GET' });
    if (!partRes.ok) {
      throw Object.assign(new Error(`production part HTTP ${partRes.status} at ${partUrl}`), { exitCode: EXIT_HARD, url: partUrl });
    }
    checkedParts.push({ url: partUrl, httpStatus: partRes.status });
  }
  return {
    skipped: false,
    cloudflareVerified: true,
    url,
    contentType: contentType || 'application/json',
    fingerprint: liveFingerprint,
    fullSha256: manifest.fullSha256 || fullSha256 || null,
    parts: checkedParts,
    verifiedAt: new Date().toISOString(),
  };
}

export async function waitAndVerifyPublished({
  origin,
  articleId,
  fingerprint,
  fullSha256,
  parts,
  defaultVoice,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180000,
  intervalMs = 4000,
}) {
  if (!origin) {
    return {
      skipped: true,
      cloudflareVerified: false,
      note: 'BAREEQ_AUDIO_VERIFY_ORIGIN unset; Cloudflare was not verified',
    };
  }
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const verified = await verifyPublishedManifest({
        origin, articleId, fingerprint, fullSha256, parts, defaultVoice, fetchImpl,
      });
      return { ...verified, waitedMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      if (Date.now() - started + intervalMs > timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw Object.assign(lastError || new Error('production manifest was not reachable'), {
    exitCode: EXIT_HARD,
    waitedMs: Date.now() - started,
    cloudflareVerified: false,
  });
}
