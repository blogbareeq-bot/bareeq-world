import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';

async function run(url, initialHeaders = {}) {
  return onRequest({
    request: new Request(url),
    next: async () => new Response('ok', { headers: initialHeaders })
  });
}

const previewResponse = await run('https://bareeq-world.pages.dev/');
assert.equal(
  previewResponse.headers.get('X-Robots-Tag'),
  'noindex, nofollow, noarchive',
  'يجب منع فهرسة نطاق pages.dev'
);

const officialResponse = await run('https://bareeqworld.com/', {
  'X-Robots-Tag': 'noindex'
});
assert.equal(
  officialResponse.headers.get('X-Robots-Tag'),
  null,
  'يجب السماح بفهرسة النطاق الرسمي'
);

console.log('Middleware audit passed: preview is noindex and official domain is indexable.');
