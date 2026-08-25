const nativeFetch = globalThis.fetch.bind(globalThis);

const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const POLL_INTERVAL_MS = Number(process.env.BAREEQ_GEMINI_BACKGROUND_POLL_MS || '5000');
const MAX_WAIT_MS = Number(process.env.BAREEQ_GEMINI_BACKGROUND_MAX_WAIT_MS || '600000');
const NETWORK_RETRIES = Number(process.env.BAREEQ_GEMINI_BACKGROUND_NETWORK_RETRIES || '4');

if (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 1000) throw new Error('BAREEQ_GEMINI_BACKGROUND_POLL_MS must be at least 1000ms.');
if (!Number.isFinite(MAX_WAIT_MS) || MAX_WAIT_MS < POLL_INTERVAL_MS) throw new Error('BAREEQ_GEMINI_BACKGROUND_MAX_WAIT_MS must be at least one poll interval.');
if (!Number.isInteger(NETWORK_RETRIES) || NETWORK_RETRIES < 0) throw new Error('BAREEQ_GEMINI_BACKGROUND_NETWORK_RETRIES must be zero or a positive integer.');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return input?.url || String(input);
}

function responseFromJson(payload, status = 200) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function retryDelay(attempt, response) {
  const retryAfter = Number.parseFloat(response?.headers?.get?.('retry-after') || '');
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter * 1000);
  return Math.min(30000, 2000 * (2 ** attempt));
}

async function fetchWithRetry(url, init, label) {
  let lastError;
  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt += 1) {
    try {
      const response = await nativeFetch(url, init);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === NETWORK_RETRIES) return response;
      const delay = retryDelay(attempt, response);
      await response.arrayBuffer().catch(() => {});
      console.warn(`${label} HTTP ${response.status}; retry ${attempt + 1}/${NETWORK_RETRIES} in ${delay}ms.`);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === NETWORK_RETRIES) throw error;
      const delay = Math.min(30000, 2000 * (2 ** attempt));
      console.warn(`${label} transport error (${error?.cause?.code || error?.code || error?.message || 'unknown'}); retry ${attempt + 1}/${NETWORK_RETRIES} in ${delay}ms.`);
      await sleep(delay);
    }
  }
  throw lastError || new Error(`${label} failed after retries.`);
}

async function bestEffortDelete(interactionId, headers) {
  try {
    const response = await nativeFetch(`${INTERACTIONS_ENDPOINT}/${encodeURIComponent(interactionId)}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      console.warn(`Gemini background cleanup returned HTTP ${response.status}; verification result is unaffected.`);
    }
  } catch (error) {
    console.warn(`Gemini background cleanup failed (${error?.cause?.code || error?.code || error?.message || 'unknown'}); verification result is unaffected.`);
  }
}

globalThis.fetch = async function bareeqBackgroundFetch(input, init = {}) {
  const url = requestUrl(input);
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

  if (url !== INTERACTIONS_ENDPOINT || method !== 'POST') {
    return nativeFetch(input, init);
  }

  let payload;
  try {
    payload = JSON.parse(String(init.body || '{}'));
  } catch {
    return nativeFetch(input, init);
  }

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  headers.set('Api-Revision', API_REVISION);

  // Background execution requires storage while the job is running. The interaction
  // is deleted on a best-effort basis immediately after we capture the completed result.
  delete payload.store;
  payload.background = true;

  const startResponse = await fetchWithRetry(INTERACTIONS_ENDPOINT, {
    ...init,
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }, 'Gemini background start');

  if (!startResponse.ok) return startResponse;

  let interaction;
  try {
    interaction = await startResponse.json();
  } catch (error) {
    return responseFromJson({ error: { message: `Gemini background start returned invalid JSON: ${error.message}` } }, 502);
  }

  if (interaction?.status === 'completed') return responseFromJson(interaction);
  if (!interaction?.id) return responseFromJson({ error: { message: 'Gemini background start did not return an interaction id.' } }, 502);

  const interactionId = interaction.id;
  const pollHeaders = new Headers();
  const apiKey = headers.get('x-goog-api-key');
  if (apiKey) pollHeaders.set('x-goog-api-key', apiKey);
  pollHeaders.set('Api-Revision', API_REVISION);
  pollHeaders.set('Accept', 'application/json');

  const startedAt = Date.now();
  console.log(`Gemini ASR background interaction started: ${interactionId}.`);

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const pollResponse = await fetchWithRetry(`${INTERACTIONS_ENDPOINT}/${encodeURIComponent(interactionId)}`, {
      method: 'GET',
      headers: pollHeaders,
    }, 'Gemini background poll');

    if (!pollResponse.ok) return pollResponse;

    let current;
    try {
      current = await pollResponse.json();
    } catch (error) {
      return responseFromJson({ error: { message: `Gemini background poll returned invalid JSON: ${error.message}` } }, 502);
    }

    if (current?.status === 'completed') {
      console.log(`Gemini ASR background interaction completed: ${interactionId}.`);
      await bestEffortDelete(interactionId, pollHeaders);
      return responseFromJson(current);
    }

    if (current?.status === 'failed' || current?.status === 'cancelled' || current?.status === 'canceled') {
      const detail = current?.error?.message || current?.error || current?.status;
      await bestEffortDelete(interactionId, pollHeaders);
      return responseFromJson({ error: { message: `Gemini background interaction ${interactionId} ${current.status}: ${detail}` } }, 400);
    }
  }

  await bestEffortDelete(interactionId, pollHeaders);
  return responseFromJson({ error: { message: `Gemini background interaction ${interactionId} exceeded ${MAX_WAIT_MS}ms.` } }, 400);
};
