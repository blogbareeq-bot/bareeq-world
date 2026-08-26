const nativeFetch = globalThis.fetch.bind(globalThis);

const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const STREAM_ENDPOINT = `${INTERACTIONS_ENDPOINT}?alt=sse`;
const API_REVISION = '2026-05-20';
const NETWORK_RETRIES = Number(process.env.BAREEQ_GEMINI_STREAM_NETWORK_RETRIES || '3');
const STREAM_RETRIES = Number(process.env.BAREEQ_GEMINI_STREAM_RETRIES || '2');

if (!Number.isInteger(NETWORK_RETRIES) || NETWORK_RETRIES < 0) throw new Error('BAREEQ_GEMINI_STREAM_NETWORK_RETRIES must be zero or a positive integer.');
if (!Number.isInteger(STREAM_RETRIES) || STREAM_RETRIES < 0) throw new Error('BAREEQ_GEMINI_STREAM_RETRIES must be zero or a positive integer.');

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

function consumeSseData(data, state) {
  const trimmed = data.trim();
  if (!trimmed || trimmed === '[DONE]') return;

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Gemini SSE returned invalid JSON data: ${error.message}; data=${trimmed.slice(0, 300)}`);
  }

  if (event?.event_type === 'step.start' && event?.step?.type === 'model_output') {
    for (const block of event.step.content || []) {
      if (block?.type === 'text' && typeof block.text === 'string') state.text += block.text;
    }
  }

  if (event?.event_type === 'step.delta' && event?.delta?.type === 'text' && typeof event.delta.text === 'string') {
    state.text += event.delta.text;
  }

  if (event?.event_type === 'interaction.completed') {
    state.completed = event.interaction || { status: 'completed' };
  }

  if (event?.event_type === 'interaction.failed') {
    state.failed = event?.interaction?.error || event?.error || 'interaction.failed';
  }
}

async function readSseInteraction(response) {
  if (!response.body) throw new Error('Gemini SSE response did not contain a body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { text: '', completed: null, failed: null };
  let buffer = '';
  let dataLines = [];

  const flushEvent = () => {
    if (!dataLines.length) return;
    consumeSseData(dataLines.join('\n'), state);
    dataLines = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (!line) {
        flushEvent();
        continue;
      }
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    let line = buffer.trimEnd();
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  flushEvent();

  if (state.failed) throw new Error(`Gemini SSE interaction failed: ${typeof state.failed === 'string' ? state.failed : JSON.stringify(state.failed)}`);
  if (!state.text.trim()) throw new Error('Gemini SSE interaction completed without text output.');

  const completed = state.completed || {};
  return {
    ...completed,
    status: completed.status || 'completed',
    steps: [
      {
        type: 'model_output',
        content: [{ type: 'text', text: state.text }],
      },
    ],
  };
}

globalThis.fetch = async function bareeqStreamingFetch(input, init = {}) {
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
  headers.set('Accept', 'text/event-stream');

  delete payload.background;
  payload.stream = true;
  payload.generation_config = {
    ...(payload.generation_config || {}),
    thinking_level: 'low',
  };

  let lastError;
  for (let streamAttempt = 0; streamAttempt <= STREAM_RETRIES; streamAttempt += 1) {
    try {
      const streamResponse = await fetchWithRetry(STREAM_ENDPOINT, {
        ...init,
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }, 'Gemini SSE start');

      if (!streamResponse.ok) return streamResponse;

      const interaction = await readSseInteraction(streamResponse);
      console.log(`Gemini ASR SSE completed${interaction.id ? `: ${interaction.id}` : ''}.`);
      return responseFromJson(interaction);
    } catch (error) {
      lastError = error;
      if (streamAttempt === STREAM_RETRIES) throw error;
      const delay = Math.min(30000, 3000 * (2 ** streamAttempt));
      console.warn(`Gemini SSE stream error (${error?.cause?.code || error?.code || error?.message || 'unknown'}); retry ${streamAttempt + 1}/${STREAM_RETRIES} in ${delay}ms.`);
      await sleep(delay);
    }
  }

  throw lastError || new Error('Gemini SSE stream failed after retries.');
};
