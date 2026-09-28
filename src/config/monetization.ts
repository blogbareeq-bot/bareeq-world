export type MonetizationKind = 'affiliate' | 'digital-product' | 'sponsor';

export interface MonetizationOffer {
  id: string;
  kind: MonetizationKind;
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
  href: string;
  active: boolean;
  external: boolean;
  provider?: string;
  disclosure?: string;
  repeat?: boolean;
  priceLabel?: string;
}

const env = import.meta.env as Record<string, string | undefined>;

function readHttpsEnv(name: string): string {
  const value = env[name]?.trim() ?? '';
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

const amazonFitnessHref = readHttpsEnv('PUBLIC_BAREEQ_AMAZON_FITNESS_URL');
const nordVpnHref = readHttpsEnv('PUBLIC_BAREEQ_NORDVPN_AFFILIATE_URL');
const agentsCheckoutHref = readHttpsEnv('PUBLIC_BAREEQ_AGENTS_CHECKOUT_URL');

export const AMAZON_ASSOCIATE_DISCLOSURE = 'بصفتي أحد شركاء أمازون، فإنني أربح من عملية الشراء المستحقة للعمولة.';
export const GENERAL_AFFILIATE_DISCLOSURE = 'قد يحصل بريق على عمولة عند الشراء عبر بعض الروابط، دون تكلفة إضافية عليك. لا تؤثر الشراكة في معاييرنا التحريرية أو حكمنا على المنتج.';

const offersByPost: Record<string, MonetizationOffer> = {
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا': {
    id: 'amazon-fitness-after-40-book',
    kind: 'affiliate',
    eyebrow: 'اختيار بريق',
    title: 'الكتاب الذي يناقشه المقال',
    description: 'إذا رغبت في قراءة الكتاب كاملًا، استخدم الرابط النظامي بعد تفعيل شراكة بريق مع أمازون. المقال مستقل ومتكامل حتى دون شراء الكتاب.',
    cta: 'عرض الكتاب',
    href: amazonFitnessHref,
    active: Boolean(amazonFitnessHref),
    external: true,
    provider: 'Amazon.sa',
    disclosure: AMAZON_ASSOCIATE_DISCLOSURE
  },
  'ai-agents-future-now': {
    id: 'bareeq-agents-starter-kit',
    kind: 'digital-product',
    eyebrow: 'أداة بريق',
    title: 'حوّل الفكرة إلى أول سير عمل آمن',
    description: 'حزمة عملية عربية: دليل واضح، 20 برومبت جاهز، قالب سير عمل، وقائمة فحص للأمان والصلاحيات. صُممت لتبدأ بمهمة صغيرة قابلة للقياس بدل بناء وكيل ضخم من اليوم الأول.',
    cta: 'استعرض الحزمة',
    href: '/products/agents-starter-kit/',
    active: true,
    external: false,
    provider: 'بريق',
    repeat: true,
    priceLabel: '29 ر.س'
  },
  'do-you-need-vpn': {
    id: 'nordvpn-contextual-affiliate',
    kind: 'affiliate',
    eyebrow: 'اختيار بريق',
    title: 'إذا قررت أن VPN مناسب لك',
    description: 'بعد فهم ما يفعله VPN وما لا يفعله، يمكنك الاطلاع على NordVPN عبر رابط بريق المعتمد عند اكتمال الشراكة. لا نعرض هذا الرابط قبل تفعيله رسميًا.',
    cta: 'اطّلع على NordVPN',
    href: nordVpnHref,
    active: Boolean(nordVpnHref),
    external: true,
    provider: 'NordVPN',
    disclosure: GENERAL_AFFILIATE_DISCLOSURE
  }
};

export function getMonetizationOffer(postId: string): MonetizationOffer | undefined {
  const offer = offersByPost[postId];
  return offer?.active ? offer : undefined;
}

export function getMonetizationCatalog(): Array<{ postId: string; offer: MonetizationOffer }> {
  return Object.entries(offersByPost).map(([postId, offer]) => ({ postId, offer }));
}

export function getAgentsCheckoutUrl(): string {
  return agentsCheckoutHref;
}

export function hasAmazonAffiliate(): boolean {
  return Boolean(amazonFitnessHref);
}

export function hasNordVpnAffiliate(): boolean {
  return Boolean(nordVpnHref);
}
