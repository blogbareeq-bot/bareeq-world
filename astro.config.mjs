import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://bareeqworld.com',
  output: 'static',
  trailingSlash: 'always',
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
});
