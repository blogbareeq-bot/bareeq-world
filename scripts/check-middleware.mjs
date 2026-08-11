import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';

async function run(url, initialHeaders = {}) {
  return onRequest({
    request: new Request(url),
    next: async () => new Response('ok', { headers: initialHeaders })
  });
}

const previewResponse = await run('https://bareeq-world.pages.dev/', {
  'Content-Type': 'text/html; charset=utf-8',
  'Access-Control-Allow-Origin': '*'
});
assert.equal(
  previewResponse.headers.get('X-Robots-Tag'),
  'noindex, nofollow, noarchive',
  'يجب منع فهرسة نطاق pages.dev'
);
assert.equal(
  previewResponse.headers.get('Access-Control-Allow-Origin'),
  null,
  'يجب حذف CORS العام من مستندات HTML'
);

const officialResponse = await run('https://bareeqworld.com/', {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Robots-Tag': 'noindex',
  'Access-Control-Allow-Origin': '*'
});
assert.equal(
  officialResponse.headers.get('X-Robots-Tag'),
  null,
  'يجب السماح بفهرسة النطاق الرسمي'
);
assert.equal(
  officialResponse.headers.get('Access-Control-Allow-Origin'),
  null,
  'يجب حذف CORS العام من HTML على النطاق الرسمي'
);

const assetResponse = await run('https://bareeqworld.com/images/example.webp', {
  'Content-Type': 'image/webp',
  'Access-Control-Allow-Origin': '*'
});
assert.equal(
  assetResponse.headers.get('Access-Control-Allow-Origin'),
  '*',
  'لا ينبغي تعديل CORS الخاص بالأصول غير HTML دون حاجة'
);

console.log('Middleware audit passed: preview is noindex, official domain is indexable, and wildcard CORS is removed from HTML only.');
