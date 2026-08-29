import { EXIT_HARD, EXIT_QUOTA } from './audio-constants.mjs';

export function filesApiStartUrl() {
  const override = process.env.GEMINI_FILES_ENDPOINT?.trim();
  if (override) {
    if (process.env.BAREEQ_TTS_CONTRACT_TEST !== '1') {
      throw Object.assign(new Error('GEMINI_FILES_ENDPOINT is restricted to BAREEQ_TTS_CONTRACT_TEST=1'), { exitCode: EXIT_HARD });
    }
    return override.replace(/\/$/, '');
  }
  return 'https://generativelanguage.googleapis.com/upload/v1beta/files';
}

export function filesApiRestBase() {
  const override = process.env.GEMINI_FILES_REST_ENDPOINT?.trim();
  if (override) {
    if (process.env.BAREEQ_TTS_CONTRACT_TEST !== '1') {
      throw Object.assign(new Error('GEMINI_FILES_REST_ENDPOINT is restricted to BAREEQ_TTS_CONTRACT_TEST=1'), { exitCode: EXIT_HARD });
    }
    return override.replace(/\/$/, '');
  }
  return 'https://generativelanguage.googleapis.com/v1beta';
}

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || '';
  return headers[name] || headers[name.toLowerCase()] || headers[name.replace(/-/g, '_')] || '';
}

function emptyHttp() {
  return {
    logicalUploads: 0,
    filesApiStartRequests: 0,
    filesApiFinalizeRequests: 0,
    filesApiMetadataRequests: 0,
    filesApiDeleteRequests: 0,
    interactionsRequests: 0,
    totalHttpRequests: 0,
  };
}

function addHttp(http, key, count = 1) {
  const next = { ...emptyHttp(), ...http };
  next[key] = (next[key] || 0) + count;
  next.totalHttpRequests = (next.totalHttpRequests || 0) + count;
  return next;
}

export async function getUploadedFileMetadata({ apiKey, name, fetchImpl = globalThis.fetch }) {
  if (!name) throw Object.assign(new Error('Files API metadata requires a file name'), { exitCode: EXIT_HARD });
  const resource = String(name).startsWith('files/') ? name : `files/${String(name).split('/').pop()}`;
  const response = await fetchImpl(`${filesApiRestBase()}/${resource}`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey, Accept: 'application/json' },
  });
  const body = await response.text().catch(() => '');
  if (response.status === 429) {
    throw Object.assign(new Error('Files API metadata HTTP 429'), { httpStatus: 429, exitCode: EXIT_QUOTA });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Files API metadata failed HTTP ${response.status}`), { httpStatus: response.status, exitCode: EXIT_HARD });
  }
  let payload;
  try { payload = JSON.parse(body); } catch {
    throw Object.assign(new Error('Files API metadata is not JSON'), { exitCode: EXIT_HARD });
  }
  const file = payload.file || payload;
  return { file, payload, httpStatus: response.status };
}

export async function uploadResumableFile({
  apiKey,
  bytes,
  mimeType = 'audio/mpeg',
  displayName = 'bareeq-audio.mp3',
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new Error('Files API upload requires an API key');
  if (!bytes?.length) throw new Error('Files API upload requires bytes');
  let http = addHttp(emptyHttp(), 'filesApiStartRequests');
  http.logicalUploads = 1;
  const start = await fetchImpl(filesApiStartUrl(), {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (start.status === 429) {
    throw Object.assign(new Error('Files API start HTTP 429'), { httpStatus: 429, exitCode: EXIT_QUOTA, http, stage: 'start' });
  }
  if (!start.ok) {
    throw Object.assign(new Error(`Files API start failed HTTP ${start.status}`), { httpStatus: start.status, exitCode: EXIT_HARD, http, stage: 'start' });
  }
  const uploadUrl = header(start.headers, 'X-Goog-Upload-URL') || header(start.headers, 'x-goog-upload-url');
  if (!uploadUrl) throw Object.assign(new Error('Files API start did not return X-Goog-Upload-URL'), { exitCode: EXIT_HARD, http, stage: 'start' });

  http = addHttp(http, 'filesApiFinalizeRequests');
  const finish = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Length': String(bytes.length),
      'Content-Type': mimeType,
    },
    body: bytes,
  });
  if (finish.status === 429) {
    throw Object.assign(new Error('Files API finalize HTTP 429'), { httpStatus: 429, exitCode: EXIT_QUOTA, http, stage: 'finalize' });
  }
  if (!finish.ok) {
    throw Object.assign(new Error(`Files API finalize failed HTTP ${finish.status}`), { httpStatus: finish.status, exitCode: EXIT_HARD, http, stage: 'finalize' });
  }
  const payload = await finish.json();
  const file = payload.file || payload;
  let uri = typeof file.uri === 'string' && file.uri.trim() ? file.uri.trim() : null;
  const name = file.name || null;
  if (!uri) {
    if (!name) {
      throw Object.assign(new Error('Files API finalize did not return a file URI or name; refusing to invent a URI'), { exitCode: EXIT_HARD, http, stage: 'finalize' });
    }
    http = addHttp(http, 'filesApiMetadataRequests');
    let meta;
    try {
      meta = await getUploadedFileMetadata({ apiKey, name, fetchImpl });
    } catch (error) {
      throw Object.assign(error, { http, stage: 'metadata' });
    }
    uri = typeof meta.file?.uri === 'string' && meta.file.uri.trim() ? meta.file.uri.trim() : null;
    if (!uri) {
      throw Object.assign(new Error('Files API metadata did not return a URI; refusing to invent one from file.name'), { exitCode: EXIT_HARD, http, stage: 'metadata' });
    }
  }
  const actualMime = file.mimeType || file.mime_type || mimeType;
  const actualSize = Number(file.sizeBytes || file.size || bytes.length);
  if (actualMime && actualMime !== mimeType && !String(actualMime).includes('mpeg') && !String(actualMime).includes('mp3')) {
    throw Object.assign(new Error(`Files API MIME mismatch: ${actualMime}`), { exitCode: EXIT_HARD, http, stage: 'metadata' });
  }
  if (actualSize && Math.abs(actualSize - bytes.length) > 0 && file.sizeBytes) {
    throw Object.assign(new Error(`Files API size mismatch: ${actualSize} != ${bytes.length}`), { exitCode: EXIT_HARD, http, stage: 'metadata' });
  }
  return {
    uri,
    mimeType: actualMime,
    name: name || displayName,
    bytes: bytes.length,
    sizeBytes: actualSize,
    raw: payload,
    http,
  };
}

export async function deleteUploadedFile({ apiKey, name, fetchImpl = globalThis.fetch }) {
  if (!name) return { deleted: false, reason: 'missing-name', http: emptyHttp() };
  const resource = String(name).startsWith('files/') ? name : `files/${String(name).split('/').pop()}`;
  const response = await fetchImpl(`${filesApiRestBase()}/${resource}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': apiKey },
  });
  const http = addHttp(emptyHttp(), 'filesApiDeleteRequests');
  if (!response.ok && response.status !== 404) {
    return { deleted: false, httpStatus: response.status, http };
  }
  return { deleted: true, httpStatus: response.status, http };
}

export { emptyHttp, addHttp };
