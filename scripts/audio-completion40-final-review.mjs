import {readFile, writeFile, readdir, mkdir, copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {loadSpokenArticle, splitSpokenArticle, activeSplitSettings} from './audio-split.mjs';
import {QUOTA_SPLIT, sha256} from './audio-constants.mjs';
import {tokenizeVerbal} from './audio-exact-match.mjs';
import {adjudicateDualAsr} from './audio-dual-asr-adjudicate.mjs';
import {applyHumanEvidence} from './audio-human-evidence-adjudication.mjs';

const [two, others, baseline, triage, out] = process.argv.slice(2);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const write = async (p, x) => writeFile(p, JSON.stringify(x, null, 2) + '\n');
async function find(dir, suffix) {
  const hits = [];
  for (const e of await readdir(dir, {withFileTypes:true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) hits.push(...await find(p, suffix));
    else if (p.replaceAll('\\', '/').endsWith(suffix)) hits.push(p);
  }
  return hits;
}
async function one(dir, suffix) {
  const hits = await find(dir, suffix);
  if (hits.length !== 1) throw new Error('Ambiguous saved evidence: ' + suffix);
  return hits[0];
}
const identities = [
  ['S', 'how-touchscreens-work', '76fa19bf8bb51391c6288f827c7d1fdc793712475731f8413e93776182fb5bf7', '1639362f2e3eaaf27075e5022ffa72a8edcf8a2fc179c2c942d00212ee1e4570', two],
  ['M', 'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع', '0afbc2030f459e1a78ca07d1130be7bb6b4585889d652e35129c86f875135477', '79a15bdf5a3b2d6ed092a0d59f1510d638134189022f8f345df7c00b2227db17', two],
  ['C1', 'language-soft-power-politics', '64d18819c78cdd92b6c133409669ee47d492d7ba809d3172007a31a9101977f8', '0eb1d93db3bf280c1bf049270a8487a163e5389fdb2bfad81144544c287983a2', others],
  ['C2', 'intuition-first-impression-decisions-signature', 'ffd1bf6e71ede6114156a94a8fd0666c4f3ab5d5a4b53df745b7a5469c27176b', 'aa7b8de471872095858ed47ca6a8326c609262bb81e2ca21bea26b2a0bebf7bc', others],
  ['C3', 'why-some-passports-are-stronger', '2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b', '38945dab4c6af24354b106285ca43ae3c29377f0905399175b3f8922382d8a90', others],
];
const history = await json(await one(triage, 'internal-evidence.json'));
const historicalDecisions = await json('docs/audio/HUMAN-TRIAGE-FULL-RESULT-20261006.json');
if (history.packageId !== historicalDecisions.packageId) throw new Error('Historical human package changed');
const resolved = new Set(historicalDecisions.confirmedFalsePositiveCandidates);
const morning = await json('docs/audio/MORNING-HUMAN-REVIEW-20261008.json');
const boundRemaining = await json('docs/audio/BOUND-REVIEW-REMAINING.json');
const boundM9 = await json('docs/audio/BOUND-REVIEW-M9.json');
const live = await json('docs/audio/LIVE-AUDIO-OBSERVED-20260828.json');
const preflight33 = await json('docs/audio/TRANCHE33-PREFLIGHT.json');
const splice40 = [
  ...((await json(await one(two, 'tranche40-execution/touchscreen-splice-result.json'))).targets),
  ...((await json(await one(two, 'tranche40-execution/morning-splice-result.json'))).targets),
];
const splice33 = await json(await one(others, 'tranche33-execution/splice-result.json'));
await mkdir(out, {recursive:false});
const articles = [];
for (const [prefix, articleId, fingerprint, fullSha256, retained] of identities) {
  const full = await one(retained, `audio-candidates/${articleId}/${fingerprint}/full.mp3`);
  if (sha256(await readFile(full)) !== fullSha256) throw new Error('Current saved full SHA mismatch');
  const dir = path.dirname(full), oldFull = await one(baseline, `audio-candidates/${articleId}/${fingerprint}/full.mp3`);
  const oldDir = path.dirname(oldFull), oldFullSha = sha256(await readFile(oldFull));
  const ck = await json(path.join(dir, 'checkpoint.json')), oldCk = await json(path.join(oldDir, 'checkpoint.json'));
  const original = await json(path.join(dir, 'reports/asr-adjudication.json'));
  const article = await loadSpokenArticle(articleId), expectedText = article.items.map(i => i.text).join(' ');
  if (article.speechScriptHash !== original.speechScriptHash || original.fullSha256 !== fullSha256) throw new Error('Current script or adjudication binding changed');
  const raw = [], rawReportBindings = [];
  for (const model of original.models) {
    const p = path.join(dir, 'reports', 'asr-' + model + '.json'), report = await json(p);
    if (report.fullSha256 !== fullSha256 || report.fingerprint !== fingerprint || report.speechScriptHash !== article.speechScriptHash) throw new Error('Raw ASR binding changed');
    if (JSON.stringify(tokenizeVerbal(report.expectedNormalized)) !== JSON.stringify(tokenizeVerbal(expectedText))) throw new Error('Canonical token order changed');
    raw.push(report); rawReportBindings.push({model, sha256:sha256(await readFile(p))});
  }
  const base = adjudicateDualAsr({expectedText, reports:raw, articleId, fingerprint, fullSha256, speechScriptHash:article.speechScriptHash, models:original.models});
  const issues = [...base.substantiveDifferences, ...base.unresolved];
  const sourceDecisions = Object.entries(history.mapping).filter(([id, m]) => resolved.has(id) && m.articleId === articleId)
    .map(([caseId, m]) => ({caseId, mapping:m, clipPath:path.join(triage, m.clipFile), decisionDocument:'docs/audio/HUMAN-TRIAGE-FULL-RESULT-20261006.json'}));
  if (prefix === 'M') {
    for (const caseId of ['M7', 'M9', 'M15']) {
      const d = (caseId === 'M9' ? boundM9 : boundRemaining).decisions.find(d => d.caseId === caseId);
      if (!d || !morning.expectedCases.includes(caseId) || d.decision !== 'EXPECTED_PRONUNCIATION_CONFIRMED' || !d.humanReviewPerformed || !d.bindingVerified || d.expectedIndices.length !== 1) throw new Error('Bound morning human approval changed');
      const originalIssue = issues.find(x => x.expectedIndex === d.expectedIndices[0] && x.expected === d.targetText);
      if (!originalIssue) continue;
      sourceDecisions.push({caseId, mapping:{kind:'pending', articleId, fingerprint:d.fingerprint, fullSha256:d.fullSha256, expectedIndex:d.expectedIndices[0], expectedToken:d.targetText, issueType:originalIssue.type || 'unresolved', partIndex:d.partNumber - 1, clipStartSeconds:d.clipStart, clipEndSeconds:d.clipEnd, clipSha256:d.clipSha256}, decisionDocument:caseId === 'M9' ? 'docs/audio/BOUND-REVIEW-M9.json' : 'docs/audio/BOUND-REVIEW-REMAINING.json', approvedSourcePartSha256:d.sourcePartSha256, submissionSha256:d.submissionSha256});
    }
  }
  const carried = [], mappings = {};
  for (const d of sourceDecisions) {
    const m = d.mapping, hit = issues.find(x => x.expectedIndex === m.expectedIndex && x.expected === m.expectedToken);
    if (!hit || m.kind !== 'pending') continue;
    if (m.fingerprint !== fingerprint || m.fullSha256 !== oldFullSha) throw new Error('Historical decision source identity changed');
    if (d.clipPath && sha256(await readFile(d.clipPath)) !== m.clipSha256) throw new Error('Previously listened clip changed');
    const sourceRecord = oldCk.completedParts[String(m.partIndex)], currentRecord = ck.completedParts[String(m.partIndex)];
    const sourcePath = path.join(oldDir, 'parts', sourceRecord.file), currentPath = path.join(dir, 'parts', currentRecord.file);
    const sourceSha = sha256(await readFile(sourcePath)), currentSha = sha256(await readFile(currentPath));
    if (sourceSha !== sourceRecord.sha256 || currentSha !== currentRecord.sha256 || (d.approvedSourcePartSha256 && sourceSha !== d.approvedSourcePartSha256)) throw new Error('Human source raw part changed');
    let derivative = {method:'byte-identical-unchanged-raw-part'};
    if (sourceSha !== currentSha) {
      const p40 = splice40.find(x => x.articleId === articleId && x.partIndex === m.partIndex);
      const p33 = splice33.targets.find(x => x.articleId === articleId && x.partIndex === m.partIndex);
      const proof = p40 || p33;
      if (!proof || proof.baselinePartSha256 !== sourceSha || proof.candidatePartSha256 !== currentSha || !proof.outsidePcmIdentical || Math.min(proof.prefixCorrelation, proof.suffixCorrelation) < .98) throw new Error('Changed reviewed part lacks a verified saved derivative');
      const pf33 = preflight33.targets.find(x => x.id === proof.id);
      const cut = p40 ? proof.sourceCutSamples.map(x => x / 48000) : [pf33?.cutStartSeconds, pf33?.cutEndSeconds];
      if (!cut.every(Number.isFinite)) throw new Error('Derivative cut missing');
      let shift = 0;
      if (m.clipEndSeconds <= cut[0]) shift = 0;
      else if (p40 && m.clipStartSeconds >= cut[1]) shift = (proof.candidateInsertedSamples[1] - proof.sourceCutSamples[1]) / 48000;
      else throw new Error('A previously listened clip overlaps a repaired region');
      const checked = JSON.parse(execFileSync('python', ['scripts/audio-completion40-carry.py', sourcePath, currentPath, String(m.clipStartSeconds), String(m.clipEndSeconds), String(shift)], {encoding:'utf8'}));
      derivative = {method:'saved-splice-with-identical-outside-PCM-and-independently-correlated-encoded-review-region', sourceCutSeconds:cut, candidateClipShiftSeconds:shift, savedSpliceProofSha256:sha256(JSON.stringify(proof)), savedSpliceProof:proof, ...checked};
    }
    const proof = {caseId:d.caseId, expectedIndex:m.expectedIndex, expectedToken:m.expectedToken, originalFullSha256:oldFullSha, fullSha256, sourcePartSha256:sourceSha, candidatePartSha256:currentSha, originalClipSha256:m.clipSha256, originalClipSeconds:[m.clipStartSeconds,m.clipEndSeconds], decisionDocument:d.decisionDocument, submissionSha256:d.submissionSha256 || historicalDecisions.reviewerResultsSha256, ...derivative};
    carried.push(proof);
    mappings[d.caseId] = {...m, fullSha256, issueType:hit.type || 'unresolved', derivativeProof:proof};
  }
  const reviewed = applyHumanEvidence({baseResult:base, mappings, resolvedCases:new Set(carried.map(x => x.caseId)), ambiguityCases:new Set(), actualCases:new Set()});
  reviewed.derivativeHumanEvidence = carried;
  const remaining = [...reviewed.substantiveDifferences, ...reviewed.unresolved].sort((a,b) => a.expectedIndex - b.expectedIndex);
  let cursor = 0;
  const segments = article.items.map(i => {const n = tokenizeVerbal(i.text).length; const s = {id:i.runtimeId || i.segmentId, text:i.text, start:cursor, end:cursor+n-1}; cursor += n; return s;});
  const groups = [];
  for (const issue of remaining) {
    const segment = segments.find(s => s.start <= issue.expectedIndex && s.end >= issue.expectedIndex);
    if (!segment) throw new Error('Issue outside canonical segment');
    let g = groups.find(g => g.segment.id === segment.id);
    if (!g) {g = {caseId:prefix + '-' + String(groups.length+1).padStart(2,'0'), segment, issues:[]}; groups.push(g);}
    g.issues.push(issue);
  }
  const plan = splitSpokenArticle(article,{settings:activeSplitSettings(QUOTA_SPLIT), liveDurationSeconds:live.articles.find(x => x.articleId === articleId)?.durationSeconds ?? null});
  let offset = 0; const parts = [];
  for (const [partIndex, part] of plan.parts.entries()) {
    const tokens = tokenizeVerbal(part.text), cases = groups.filter(g => g.issues.every(x => x.expectedIndex >= offset && x.expectedIndex < offset + tokens.length)).map(g => ({...g, localStart:Math.min(...g.issues.map(x => x.expectedIndex))-offset, localEnd:Math.max(...g.issues.map(x => x.expectedIndex))-offset}));
    if (cases.length) {
      const rec = ck.completedParts[String(partIndex)], source = path.join(dir, 'parts', rec.file), sourceSha = sha256(await readFile(source));
      if (sourceSha !== rec.sha256) throw new Error('Review raw part changed');
      const sourceFile = prefix + '-part' + (partIndex+1) + '.mp3';
      await copyFile(source, path.join(out, sourceFile));
      parts.push({partIndex, sourceFile, sourcePartSha256:sourceSha, expectedTokens:tokens, cases});
    }
    offset += tokens.length;
  }
  if (parts.reduce((n,p) => n+p.cases.length,0) !== groups.length) throw new Error('Review group crosses part boundary');
  await write(path.join(out, prefix + '-base-v6.json'), base);
  await write(path.join(out, prefix + '-human-bound.json'), reviewed);
  articles.push({articleId, fingerprint, fullSha256, speechScriptHash:article.speechScriptHash, title:article.title, originalBaselineFullSha256:oldFullSha, originalConsensus:original.consensus, baseV6Consensus:base.consensus, boundHumanConsensus:reviewed.consensus, rawReportBindings, carriedHumanCases:carried, remainingIssueCount:remaining.length, parts});
}
await write(path.join(out, 'review-input.json'), {schema:'bareeq.audio-completion40-final-review-input.v1', sourceRuns:['37777589258','37626334800'], historicalPackageId:history.packageId, ttsCalls:0, newAsrProviderCalls:0, publicationPerformed:false, policyVersion:6, newEquivalenceRules:false, articles});
console.log(JSON.stringify(articles.map(a => ({articleId:a.articleId, carried:a.carriedHumanCases.map(x => x.caseId), remaining:a.remainingIssueCount, parts:a.parts.length}))));
