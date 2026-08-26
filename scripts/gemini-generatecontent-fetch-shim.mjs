const nativeFetch = globalThis.fetch.bind(globalThis);

const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const NETWORK_RETRIES = Number(process.env.BAREEQ_GC_STREAM_NETWORK_RETRIES || '3');
const STREAM_RETRIES = Number(process.env.BAREEQ_GC_STREAM_RETRIES || '2');

if (!Number.isInteger(NETWORK_RETRIES) || NETWORK_RETRIES < 0) throw new Error('BAREEQ_GC_STREAM_NETWORK_RETRIES must be zero or a positive integer.');
if (!Number.isInteger(STREAM_RETRIES) || STREAM_RETRIES < 0) throw new Error('BAREEQ_GC_STREAM_RETRIES must be zero or a positive integer.');

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

function parseSseData(data, state) {
  const trimmed = data.trim();
  if (!trimmed || trimmed === '[DONE]') return;
  let chunk;
  try {
    chunk = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Gemini GenerateContent SSE returned invalid JSON: ${error.message}; data=${trimmed.slice(0, 300)}`);
  }
  if (chunk?.error) throw new Error(`Gemini GenerateContent SSE error: ${JSON.stringify(chunk.error)}`);
  for (const candidate of chunk?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (part?.thought === true) continue;
      if (typeof part?.text === 'string') state.text += part.text;
    }
  }
}

async function readGenerateContentSse(response) {
  if (!response.body) throw new Error('Gemini GenerateContent SSE response did not contain a body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { text: '' };
  let buffer = '';
  let dataLines = [];

  const flush = () => {
    if (!dataLines.length) return;
    parseSseData(dataLines.join('\n'), state);
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
        flush();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    let line = buffer.trimEnd();
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  if (!state.text.trim()) throw new Error('Gemini GenerateContent SSE completed without text output.');
  return state.text;
}

globalThis.fetch = async function bareeqGenerateContentStreamingFetch(input, init = {}) {
  const url = requestUrl(input);
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url !== INTERACTIONS_ENDPOINT || method !== 'POST') return nativeFetch(input, init);

  let interactionPayload;
  try {
    interactionPayload = JSON.parse(String(init.body || '{}'));
  } catch {
    return nativeFetch(input, init);
  }

  const model = String(interactionPayload.model || '').trim();
  if (!model) return responseFromJson({ error: { message: 'GenerateContent shim received no model.' } }, 400);

  const parts = [];
  for (const item of interactionPayload.input || []) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push({ text: item.text });
    } else if (item?.type === 'audio' && typeof item.data === 'string') {
      parts.push({ inlineData: { mimeType: item.mime_type || 'audio/mp3', data: item.data } });
    } else {
      return responseFromJson({ error: { message: `GenerateContent shim does not support input type: ${item?.type || 'unknown'}` } }, 400);
    }
  }

  const schema = interactionPayload?.response_format?.schema;
  const generationConfig = {
    temperature: 0,
    responseMimeType: 'application/json',
    ...(schema ? { responseJsonSchema: schema } : {}),
  };

  const body = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig,
  });

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  headers.delete('Api-Revision');
  headers.set('Accept', 'text/event-stream');
  headers.set('Content-Type', 'application/json');

  const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let lastError;

  for (let streamAttempt = 0; streamAttempt <= STREAM_RETRIES; streamAttempt += 1) {
    try {
      const streamResponse = await fetchWithRetry(streamUrl, {
        method: 'POST',
        headers,
        body,
      }, 'Gemini GenerateContent SSE start');
      if (!streamResponse.ok) return streamResponse;
      const text = await readGenerateContentSse(streamResponse);
      console.log('Gemini GenerateContent ASR SSE completed.');
      return responseFromJson({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
      });
    } catch (error) {
      lastError = error;
      if (streamAttempt === STREAM_RETRIES) throw error;
      const delay = Math.min(30000, 3000 * (2 ** streamAttempt));
      console.warn(`Gemini GenerateContent SSE stream error (${error?.cause?.code || error?.code || error?.message || 'unknown'}); retry ${streamAttempt + 1}/${STREAM_RETRIES} in ${delay}ms.`);
      await sleep(delay);
    }
  }

  throw lastError || new Error('Gemini GenerateContent SSE failed after retries.');
};
