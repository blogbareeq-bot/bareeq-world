import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveAudioDir, EXIT_CONFIG, EXIT_USAGE } from './audio-constants.mjs';

const ROOT = process.cwd();

function parseFrontmatter(source, filename = 'article.md') {
  const normalized = String(source ?? '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) throw new Error(`${filename}: invalid frontmatter`);
  const fm = match[1];
  const title = fm.match(/^title:\s*["']?(.*?)["']?\s*$/m)?.[1]?.trim() || filename.replace(/\.md$/, '');
  const publishedAt = fm.match(/^publishedAt:\s*["']?(.*?)["']?\s*$/m)?.[1]?.trim() || '';
  const draft = /^draft:\s*true\s*$/mi.test(fm);
  return { title, publishedAt, draft };
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function buildAudioPriorityQueue(root = ROOT) {
  const postsDir = path.join(root, 'src', 'content', 'posts');
  const files = (await readdir(postsDir)).filter((name) => name.endsWith('.md')).sort();
  const rows = [];
  for (const filename of files) {
    const articleId = filename.replace(/\.md$/, '');
    const source = await readFile(path.join(postsDir, filename), 'utf8');
    const meta = parseFrontmatter(source, filename);
    if (meta.draft) continue;
    const liveManifest = path.join(liveAudioDir(articleId, root), 'manifest.json');
    const hasLiveAudio = await exists(liveManifest);
    rows.push({
      articleId,
      title: meta.title,
      publishedAt: meta.publishedAt || null,
      hasLiveAudio,
      priorityClass: hasLiveAudio ? 'legacy-existing-audio' : 'new-content-no-live-audio',
      liveManifest: hasLiveAudio ? liveManifest : null,
    });
  }

  const byPublishedAt = (a, b) => {
    const ad = Date.parse(a.publishedAt || '') || Number.MAX_SAFE_INTEGER;
    const bd = Date.parse(b.publishedAt || '') || Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return a.articleId.localeCompare(b.articleId, 'ar');
  };

  const newContent = rows.filter((row) => !row.hasLiveAudio).sort(byPublishedAt);
  const existingAudio = rows.filter((row) => row.hasLiveAudio).sort(byPublishedAt);
  return {
    schema: 'bareeq.audio-priority-queue.v1',
    policy: 'new-content-before-renewal',
    generatedAt: new Date().toISOString(),
    newContent,
    existingAudio,
    nextSynthesisTarget: newContent[0]?.articleId || null,
  };
}

export function evaluateGenerationPriority(queue, targetArticleId) {
  const target = [...(queue.newContent || []), ...(queue.existingAudio || [])]
    .find((row) => row.articleId === targetArticleId);
  if (!target) {
    return { allowed: false, exitCode: EXIT_USAGE, reason: 'target article is not a published article in the queue', target: null };
  }
  if (!target.hasLiveAudio) {
    return {
      allowed: true,
      exitCode: 0,
      reason: 'new article without live audio has synthesis priority',
      target,
      nextSynthesisTarget: queue.nextSynthesisTarget,
    };
  }
  if ((queue.newContent || []).length > 0) {
    return {
      allowed: false,
      exitCode: EXIT_CONFIG,
      reason: `legacy renewal blocked while ${queue.newContent.length} new article(s) have no live audio`,
      target,
      nextSynthesisTarget: queue.nextSynthesisTarget,
    };
  }
  return {
    allowed: true,
    exitCode: 0,
    reason: 'no new article is waiting for first audio; legacy renewal may proceed',
    target,
    nextSynthesisTarget: null,
  };
}

async function cli() {
  const queue = await buildAudioPriorityQueue();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(queue, null, 2));
    return;
  }

  if (process.argv.includes('--allow-legacy')) {
    if (queue.newContent.length > 0) {
      console.error(`BAREEQ_AUDIO_PRIORITY=BLOCK_LEGACY newPending=${queue.newContent.length} next=${queue.nextSynthesisTarget}`);
      process.exitCode = EXIT_CONFIG;
      return;
    }
    console.log('BAREEQ_AUDIO_PRIORITY=LEGACY_ALLOWED newPending=0');
    return;
  }

  const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
  if (targetArg) {
    const target = targetArg.slice('--target='.length);
    const decision = evaluateGenerationPriority(queue, target);
    if (!decision.allowed) {
      console.error(`BAREEQ_AUDIO_PRIORITY=BLOCK target=${target} next=${decision.nextSynthesisTarget || 'none'} reason=${decision.reason}`);
      process.exitCode = decision.exitCode;
      return;
    }
    console.log(`BAREEQ_AUDIO_PRIORITY=PASS target=${target} class=${decision.target.priorityClass} next=${decision.nextSynthesisTarget || 'none'}`);
    return;
  }

  console.log(`BAREEQ_AUDIO_PRIORITY policy=${queue.policy} newPending=${queue.newContent.length} next=${queue.nextSynthesisTarget || 'none'}`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await cli();
