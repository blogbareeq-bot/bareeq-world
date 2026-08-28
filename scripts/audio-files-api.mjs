const FILES_START_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

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
  const start = await fetchImpl(FILES_START_URL, {
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
  if (!start.ok) {
    const error = new Error(`Files API start failed HTTP ${start.status}`);
    error.httpStatus = start.status;
    throw error;
  }
  const uploadUrl = header(start.headers, 'X-Goog-Upload-URL') || header(start.headers, 'x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API start did not return X-Goog-Upload-URL');

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
  if (!finish.ok) {
    const error = new Error(`Files API finalize failed HTTP ${finish.status}`);
    error.httpStatus = finish.status;
    throw error;
  }
  const payload = await finish.json();
  const file = payload.file || payload;
  const uri = file.uri || file.name;
  if (!uri) throw new Error('Files API finalize did not return a file URI');
  return { uri, mimeType: file.mimeType || mimeType, name: file.name || displayName, raw: payload };
}
