import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://bareeqworld.com',
  output: 'static',
  trailingSlash: 'always',
  // Astro 7 returns 403 when Host is not localhost. Proxied previews
  // (Arena e2b, some tunnels) send the public preview hostname.
  // Cloudflare Pages serves the static dist/ and never uses this server.
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
});
