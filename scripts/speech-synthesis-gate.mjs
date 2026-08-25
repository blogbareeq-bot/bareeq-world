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

export function evaluateSynthesisReadiness(post) {
  const validation = post?.speechApproval?.validation;
  const plan = post?.speechApproval?.testClipPlan;
  const audioEvidencePassed = plan?.audioReview?.status === 'passed'
    && Boolean(plan.audioReview.evidence)
    && Boolean(plan.audioReview.reviewedBy)
    && Boolean(plan.audioReview.reviewedAt)
    && post?.speechApproval?.testClipEvidenceVerified === true;
  const reasons = [];
  if (!validation?.approved) reasons.push('Speech Script is missing, stale, ambiguous, or not fully linguistically/pronunciation reviewed');
  if (!plan) reasons.push('test clip plan is missing');
  if (plan && plan.speechScriptHash !== post?.speechApproval?.script?.scriptHash) reasons.push('test clip plan targets a stale Speech Script hash');
  if (!plan?.testClipPassed) reasons.push('test clip is not passed');
  if (!audioEvidencePassed) reasons.push('test clip has no actual listening-review evidence');
  if (!plan?.fullSynthesisAllowed) reasons.push('full synthesis is not explicitly allowed');
  return { allowed: reasons.length === 0, reasons, audioEvidencePassed };
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

export const SPEECH_GATE_TEST_BYPASS_VALUE = TEST_BYPASS_VALUE;
