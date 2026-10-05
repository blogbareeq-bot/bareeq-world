import assert from 'node:assert/strict';
import { validateAudioState } from './audio-state-consistency.mjs';

function fixture() {
  const rows = Array.from({ length: 15 }, (_, i) => ({
    articleId: `a${i}`,
    exact: i < 7,
    publishedExact: i < 7,
    fingerprint: `fp${i}`,
    fullSha256: `sha${i}`,
  }));
  return {
    status:{ schema:'bareeq.audio-progressive-status.v2', exactCount:7, publishedCount:7, fallbackCount:8, rows },
    strategy:{ schema:'bareeq.audio-engine-strategy.v1', exactBaseline:7, successfulTtsSinceLastNewExact:29, threshold:30, status:'active' },
    marker:{ articles:rows.slice(0,7).map(r=>({articleId:r.articleId,fingerprint:r.fingerprint,fullSha256:r.fullSha256})), fallbacks:rows.slice(7).map(r=>({articleId:r.articleId})) },
    classification:{ rows:rows.map(r=>({articleId:r.articleId,baselineScore:r.exact?0:1,rejectedScore:null})) },
    freeze:{ active:true, strategySnapshot:{successfulTtsSinceLastNewExact:29,threshold:30} },
  };
}
const ok=fixture();
assert.equal(validateAudioState(ok).strategy,'29/30');
const bad=fixture();
bad.status.fallbackCount=7;
assert.throws(()=>validateAudioState(bad),/fallbackCount mismatch|published \+ fallback/);
const badSha=fixture();
badSha.marker.articles[0].fullSha256='wrong';
assert.throws(()=>validateAudioState(badSha),/full SHA mismatch/);
console.log('Audio state consistency tests passed: count drift and publication identity drift are rejected.');
