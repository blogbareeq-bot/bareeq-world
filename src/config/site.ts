export const site = {
  name: 'عالم بريق',
  brand: 'بريق',
  tagline: 'نافذتك إلى المعرفة',
  description: 'منصة عربية معرفية تقدّم أفكارًا موثوقة وممتعة بأسلوب واضح وهادئ، في العقل والكتب والثقافة والتقنية وتبسيط المفاهيم.',
  url: 'https://bareeqworld.com',
  email: 'blogbareeq@gmail.com',
  logo: '/images/bareeq-logo-display.png',
  originalLogo: '/images/bareeq-logo-official.png',
  socialImage: '/images/bareeq-logo-display.png'
};

export const categories = [
  { name: 'أطياف العقل', slug: 'atyaf-al-aql', arabicSlug: 'أطياف-العقل', short: 'قرارات وعمل العقل', icon: '◌' },
  { name: 'بريق الكتب', slug: 'bareeq-books', arabicSlug: 'بريق-الكتب', short: 'كتب وأفكار تستحق القراءة', icon: '▤' },
  { name: 'نافذة على العالم', slug: 'window-on-world', arabicSlug: 'نافذة-على-العالم', short: 'ثقافات واكتشافات', icon: '◎' },
  { name: 'المستقبل الآن', slug: 'future-now', arabicSlug: 'المستقبل-الآن', short: 'التقنية والذكاء الاصطناعي', icon: '✦' },
  { name: 'ببساطة…', slug: 'simply', arabicSlug: 'ببساطة', short: 'تبسيط المفاهيم المعقدة', icon: '◇' }
] as const;

export const series = [
  { slug: 'mind-and-decisions', title: 'العقل والقرارات', description: 'مقالات لفهم طريقة التفكير، والمغالطات، وبناء الوعي والاختيارات الأفضل.', categorySlugs: ['atyaf-al-aql'] },
  { slug: 'technology-simply', title: 'التقنية ببساطة', description: 'شرح واضح لما يحدث خلف الشاشات، من الإنترنت والذكاء الاصطناعي إلى الفضاء.', categorySlugs: ['future-now', 'simply'] },
  { slug: 'windows-to-world', title: 'نوافذ إلى العالم', description: 'ثقافات وعادات وتجارب توسّع زاوية النظر إلى البشر والمجتمعات.', categorySlugs: ['window-on-world'] },
  { slug: 'books-for-life', title: 'كتب للحياة', description: 'أفكار وقراءات تربط الكتب بالصحة والعمل والحياة اليومية.', categorySlugs: ['bareeq-books'] }
] as const;

export type CategorySlug = (typeof categories)[number]['slug'];
