import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readSpeechScript } from './speech-script-core.mjs';

const ROOT = process.cwd();
const snapshot = JSON.parse(await readFile(path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json'), 'utf8'));
const outDir = path.join(ROOT, 'docs', 'audio', 'listening-packs');
await mkdir(outDir, { recursive: true });

for (const article of snapshot.articles) {
  const script = await readSpeechScript(article.articleId, ROOT);
  const spoken = (script?.segments ?? []).map((segment, index) => `${index + 1}. [${segment.type}] ${segment.spokenText}`).join('\n\n');
  const body = `# Human listening pack — ${article.title}

- Article: \`${article.articleId}\`
- Previous live voice: ${article.previousVoice?.voiceId || 'none'} (${article.previousVoice?.provider || 'n/a'})
- Target narrator: Sadaltager / gemini-3.1-flash-tts-preview
- Status: **not performed**. This file is a listening worksheet, not a passed review.
- Do not stamp \`humanListening.status = passed\` unless a named reviewer listened to the full merged file.

## Checklist

- [ ] Full merged file, not a clip
- [ ] Natural Modern Standard Arabic (not mechanical pause endings)
- [ ] Every written diacritic respected
- [ ] No added, omitted, or substituted word
- [ ] Foreign terms match the approved pronunciation
- [ ] No skip / jump / stall / clipping / volume spike
- [ ] Reviewer name and ISO date recorded below

## Reviewer

- reviewedBy:
- reviewedAt:
- result: pending
- notes:

## Approved spoken text (${article.spoken.spokenChars} chars)

${spoken}
`;
  await writeFile(path.join(outDir, `${article.articleId}.md`), body);
}
console.log(`Wrote ${snapshot.articles.length} human listening pack(s) under docs/audio/listening-packs/. None are stamped passed.`);
