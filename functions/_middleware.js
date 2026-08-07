export async function onRequest(context) {
  const response = await context.next();
  const headers = new Headers(response.headers);
  const hostname = new URL(context.request.url).hostname.toLowerCase();
  if (hostname.endsWith('.pages.dev')) {
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  } else {
    headers.delete('X-Robots-Tag');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
