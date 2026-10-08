import { access, readFile } from 'node:fs/promises';

const requiredFiles = [
  'src/config/monetization.ts',
  'src/components/BareeqRecommendation.astro',
  'src/pages/products/agents-starter-kit.astro',
  'src/pages/picks.astro',
  'src/content/posts/do-you-need-vpn.md',
  'public/media/do-you-need-vpn.svg',
  'public/scripts/monetization.js'
];

for (const file of requiredFiles) await access(file);

const [config, articlePage, productPage, picksPage, vpnArticle, tracking, sitemap] = await Promise.all([
  readFile('src/config/monetization.ts', 'utf8'),
  readFile('src/pages/posts/[id].astro', 'utf8'),
  readFile('src/pages/products/agents-starter-kit.astro', 'utf8'),
  readFile('src/pages/picks.astro', 'utf8'),
  readFile('src/content/posts/do-you-need-vpn.md', 'utf8'),
  readFile('public/scripts/monetization.js', 'utf8'),
  readFile('src/pages/sitemap.xml.ts', 'utf8')
]);

const checks = [
  ['affiliate links require env activation', /active: Boolean\(amazonFitnessHref\)/.test(config) && /active: Boolean\(nordVpnHref\)/.test(config)],
  ['only HTTPS external URLs are accepted', /parsed\.protocol === 'https:'/.test(config)],
  ['affiliate disclosure is present', config.includes('قد يحصل بريق على عمولة') && config.includes('شركاء أمازون')],
  ['article template renders contextual offers', articlePage.includes('BareeqRecommendation') && articlePage.includes('getMonetizationOffer')],
  ['monetization tracking is loaded', articlePage.includes('/scripts/monetization.js')],
  ['product price is consistent', productPage.includes('29 ر.س') && productPage.includes('data-value="29"')],
  ['checkout has a safe non-card fallback', productPage.includes('mailto:') && productPage.includes('لن نطلب منك بيانات بطاقة عبر البريد')],
  ['picks page exposes staged versus active state', picksPage.includes('جاهز للتفعيل') && picksPage.includes('بانتظار الاعتماد')],
  ['tracking waits for analytics availability', tracking.includes("bareeq:analytics-ready") && tracking.includes("typeof window.gtag === 'function'")],
  ['VPN article does not hard-code a commercial affiliate link', !/nordvpn\.(com|net)|utm_|aff_id|affiliate=/i.test(vpnArticle)],
  ['VPN article uses a real cover asset', vpnArticle.includes('/media/do-you-need-vpn.svg')],
  ['revenue routes are indexed', sitemap.includes('/picks/') && sitemap.includes('/products/agents-starter-kit/')]
];

const failures = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
if (failures.length) {
  throw new Error(`Revenue quality gate failed: ${failures.map(([name]) => name).join('; ')}`);
}
console.log(`Revenue quality gate passed (${checks.length}/${checks.length}).`);
