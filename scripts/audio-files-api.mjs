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

export async function uploadResumableFile({
  apiKey,
  bytes,
  mimeType = 'audio/mpeg',
  displayName = 'bareeq-audio.mp3',
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new Error('Files API upload requires an API key');
  if (!bytes?.length) throw new Error('Files API upload requires bytes');
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
    throw Object.assign(new Error('Files API start HTTP 429'), { httpStatus: 429, exitCode: EXIT_QUOTA });
  }
  if (!start.ok) {
    const error = new Error(`Files API start failed HTTP ${start.status}`);
    error.httpStatus = start.status;
    error.exitCode = EXIT_HARD;
    throw error;
  }
  const uploadUrl = header(start.headers, 'X-Goog-Upload-URL') || header(start.headers, 'x-goog-upload-url');
  if (!uploadUrl) throw Object.assign(new Error('Files API start did not return X-Goog-Upload-URL'), { exitCode: EXIT_HARD });

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
    throw Object.assign(new Error('Files API finalize HTTP 429'), { httpStatus: 429, exitCode: EXIT_QUOTA });
  }
  if (!finish.ok) {
    const error = new Error(`Files API finalize failed HTTP ${finish.status}`);
    error.httpStatus = finish.status;
    error.exitCode = EXIT_HARD;
    throw error;
  }
  const payload = await finish.json();
  const file = payload.file || payload;
  const uri = file.uri || file.name;
  if (!uri) throw Object.assign(new Error('Files API finalize did not return a file URI'), { exitCode: EXIT_HARD });
  return {
    uri,
    mimeType: file.mimeType || file.mime_type || mimeType,
    name: file.name || displayName,
    bytes: bytes.length,
    raw: payload,
  };
}

export async function deleteUploadedFile({ apiKey, name, fetchImpl = globalThis.fetch }) {
  if (!name) return { deleted: false, reason: 'missing-name' };
  const resource = String(name).startsWith('files/') ? name : `files/${String(name).split('/').pop()}`;
  const response = await fetchImpl(`${filesApiRestBase()}/${resource}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!response.ok && response.status !== 404) {
    return { deleted: false, httpStatus: response.status };
  }
  return { deleted: true, httpStatus: response.status };
}
