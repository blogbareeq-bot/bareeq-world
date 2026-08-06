export const site = {
  name: 'عالم بريق',
  brand: 'بريق',
  tagline: 'نافذتك إلى المعرفة',
  description: 'منصة عربية معرفية تقدّم أفكارًا موثوقة وممتعة بأسلوب واضح وجميل.',
  url: 'https://bareeqworld.com',
  email: 'blogbareeq@gmail.com'
};

export const categories = [
  {
    name: 'أطياف العقل',
    slug: 'atyaf-al-aql',
    short: 'قرارات وعمل العقل',
    icon: '◌'
  },
  {
    name: 'بريق الكتب',
    slug: 'bareeq-books',
    short: 'كتب وأفكار تستحق القراءة',
    icon: '▤'
  },
  {
    name: 'نافذة على العالم',
    slug: 'window-on-world',
    short: 'ثقافات واكتشافات',
    icon: '◎'
  },
  {
    name: 'المستقبل الآن',
    slug: 'future-now',
    short: 'التقنية والذكاء الاصطناعي',
    icon: '✦'
  },
  {
    name: 'ببساطة…',
    slug: 'simply',
    short: 'تبسيط المفاهيم المعقدة',
    icon: '◇'
  }
] as const;

export type CategorySlug = (typeof categories)[number]['slug'];
