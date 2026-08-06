export const site = {
  name: 'عالم بريق',
  brand: 'بريق',
  tagline: 'نافذتك إلى المعرفة',
  description: 'منصة عربية معرفية تقدّم أفكارًا موثوقة وممتعة بأسلوب واضح وهادئ، في العقل والكتب والثقافة والتقنية وتبسيط المفاهيم.',
  url: 'https://bareeqworld.com',
  email: 'blogbareeq@gmail.com',
  logo: '/favicon.svg',
  originalLogo: '/images/bareeq-logo-official.png',
  socialImage: '/images/bareeq-logo-official.png'
};

export const categories = [
  { name: 'أطياف العقل', slug: 'atyaf-al-aql', arabicSlug: 'أطياف-العقل', short: 'قرارات وعمل العقل', description: 'علم النفس والتفكير والقرارات', icon: '◌', color: '#7c3aed' },
  { name: 'بريق الكتب', slug: 'bareeq-books', arabicSlug: 'بريق-الكتب', short: 'كتب وأفكار تستحق القراءة', description: 'قراءات ومراجعات وأفكار من الكتب', icon: '▤', color: '#087566' },
  { name: 'نافذة على العالم', slug: 'window-on-world', arabicSlug: 'نافذة-على-العالم', short: 'ثقافات واكتشافات', description: 'ثقافات وتجارب توسّع زاوية النظر', icon: '◎', color: '#2563eb' },
  { name: 'المستقبل الآن', slug: 'future-now', arabicSlug: 'المستقبل-الآن', short: 'التقنية والذكاء الاصطناعي', description: 'التقنية والذكاء الاصطناعي والمستقبل', icon: '✦', color: '#b87512' },
  { name: 'ببساطة…', slug: 'simply', arabicSlug: 'ببساطة', short: 'تبسيط المفاهيم المعقدة', description: 'شرح واضح للأفكار المعقدة', icon: '◇', color: '#0a2342' }
] as const;

export const series = [
  { slug: 'mind-and-decisions', title: 'العقل والقرارات', description: 'مقالات لفهم طريقة التفكير، والمغالطات، وبناء الوعي والاختيارات الأفضل.', categorySlugs: ['atyaf-al-aql'] },
  { slug: 'technology-simply', title: 'التقنية ببساطة', description: 'شرح واضح لما يحدث خلف الشاشات، من الإنترنت والذكاء الاصطناعي إلى الفضاء.', categorySlugs: ['future-now', 'simply'] },
  { slug: 'windows-to-world', title: 'نوافذ إلى العالم', description: 'ثقافات وعادات وتجارب توسّع زاوية النظر إلى البشر والمجتمعات.', categorySlugs: ['window-on-world'] },
  { slug: 'books-for-life', title: 'كتب للحياة', description: 'أفكار وقراءات تربط الكتب بالصحة والعمل والحياة اليومية.', categorySlugs: ['bareeq-books'] }
] as const;

export type CategorySlug = (typeof categories)[number]['slug'];
