import { evaluateGenerationAuthorization, evaluatePublishability } from './audio-lifecycle.mjs';

const TEST_BYPASS_VALUE = 'I_ACKNOWLEDGE_LOCAL_CONTRACT_ONLY';

function isLocalContractEndpoint(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch { return false; }
}

export function testBypassAllowed(env = process.env) {
  if (env.BAREEQ_SPEECH_GATE_UNSAFE_TEST_BYPASS !== TEST_BYPASS_VALUE) return false;
  if (env.BAREEQ_TTS_CONTRACT_TEST !== '1') return false;
  return [env.GEMINI_TTS_ENDPOINT, env.OPENAI_TTS_ENDPOINT].some(isLocalContractEndpoint);
}

/**
 * Generation authorization only. Listening/ASR evidence is a later gate and
 * must not block the first TTS request — that would be circular.
 */
export function evaluateSynthesisReadiness(post) {
  const generation = evaluateGenerationAuthorization(post);
  const plan = post?.speechApproval?.testClipPlan;
  const audioEvidencePassed = plan?.audioReview?.status === 'passed'
    && Boolean(plan.audioReview.evidence)
    && Boolean(plan.audioReview.reviewedBy)
    && Boolean(plan.audioReview.reviewedAt)
    && post?.speechApproval?.testClipEvidenceVerified === true;
  return {
    allowed: generation.passed,
    reasons: generation.reasons,
    audioEvidencePassed,
    textReady: generation.textReady,
    generationAuthorized: generation.passed,
    publishable: false,
  };
}

export function evaluatePublicationReadiness(post, record = {}) {
  const publication = evaluatePublishability(post, record);
  return {
    allowed: publication.passed,
    reasons: publication.reasons,
    parts: publication.parts,
  };
}

export function assertSynthesisAllowed(posts, env = process.env) {
  if (!posts.length) return { bypassed: false };
  if (testBypassAllowed(env)) {
    console.warn('⚠ UNSAFE LOCAL CONTRACT-TEST BYPASS: Speech Script synthesis gate bypassed for an authenticated loopback-only mock. This cannot target a production provider.');
    return { bypassed: true };
  }
  const blocked = posts.map((post) => ({ post, readiness: evaluateSynthesisReadiness(post) })).filter(({ readiness }) => !readiness.allowed);
  if (blocked.length) {
    const details = blocked.map(({ post, readiness }) => `- ${post.id}: ${readiness.reasons.join('; ')}`).join('\n');
    throw new Error(`Speech synthesis blocked before provider access for ${blocked.length} article(s).\n${details}\nNo TTS provider request was sent.`);
  }
  return { bypassed: false };
}

export function assertPublicationAllowed(posts, recordsById = {}, env = process.env) {
  if (!posts.length) return { bypassed: false };
  if (testBypassAllowed(env)) return { bypassed: true };
  const blocked = posts.map((post) => ({
    post,
    readiness: evaluatePublicationReadiness(post, recordsById[post.id] || {}),
  })).filter(({ readiness }) => !readiness.allowed);
  if (blocked.length) {
    const details = blocked.map(({ post, readiness }) => `- ${post.id}: ${readiness.reasons.join('; ')}`).join('\n');
    throw new Error(`Publication blocked for ${blocked.length} article(s).\n${details}\nExisting live audio was left in place.`);
  }
  return { bypassed: false };
}

export const SPEECH_GATE_TEST_BYPASS_VALUE = TEST_BYPASS_VALUE;
