export const site = {
  name: 'عالم بريق',
  brand: 'بريق',
  tagline: 'نافذتك إلى المعرفة',
  description: 'منصة عربية معرفية تقدّم أفكارًا موثوقة وممتعة بأسلوب واضح وهادئ، في العقل والكتب والثقافة والتقنية وتبسيط المفاهيم.',
  url: 'https://bareeqworld.com',
  email: 'blogbareeq@gmail.com',
  logo: '/images/apple-touch-icon.png',
  originalLogo: '/images/apple-touch-icon.png',
  socialImage: '/images/bareeq-social-card.jpg',
  socialImageWidth: 1200,
  socialImageHeight: 630
};

export const categories = [
  { name: 'أطياف العقل', slug: 'atyaf-al-aql', arabicSlug: 'أطياف-العقل', short: 'تفكير أوضح وقرارات أكثر وعيًا', description: 'مقالات تساعدك على فهم التفكير والسلوك والمغالطات، واتخاذ قرارات يومية أكثر وعيًا وهدوءًا.', icon: 'mind', color: '#6d28d9', darkColor: '#c4b5fd' },
  { name: 'بريق الكتب', slug: 'bareeq-books', arabicSlug: 'بريق-الكتب', short: 'كتب وأفكار تستحق أن تبقى', description: 'قراءات ومراجعات تربط أفكار الكتب بالحياة والعمل، وتعرض ما يفيد القارئ بوضوح وتوازن.', icon: 'book', color: '#087566', darkColor: '#6ee7d0' },
  { name: 'نافذة على العالم', slug: 'window-on-world', arabicSlug: 'نافذة-على-العالم', short: 'ثقافات وتجارب توسّع زاوية النظر', description: 'رحلات موثقة بين ثقافات المجتمعات وعاداتها وتجاربها، توسّع زاوية النظر وتحترم اختلاف الناس.', icon: 'world', color: '#1d4ed8', darkColor: '#93c5fd' },
  { name: 'المستقبل الآن', slug: 'future-now', arabicSlug: 'المستقبل-الآن', short: 'التقنية كما تؤثر في يومنا وغدنا', description: 'شرح واضح للتقنية والذكاء الاصطناعي والتحولات الرقمية، وكيف تؤثر في يومنا وقراراتنا ومستقبلنا.', icon: 'future', color: '#965708', darkColor: '#f9c76b' },
  { name: 'ببساطة…', slug: 'simply', arabicSlug: 'ببساطة', short: 'أفكار معقدة بلغة واضحة وقريبة', description: 'تبسيط للمفاهيم العلمية والصحية والفكرية المعقدة بلغة قريبة، مع الحفاظ على الدقة وحدود المعرفة.', icon: 'simple', color: '#0a2342', darkColor: '#a7c7e7' }
] as const;

export const series = [
  { slug: 'mind-and-decisions', title: 'العقل والقرارات', description: 'مقالات لفهم طريقة التفكير، والمغالطات، وبناء الوعي والاختيارات الأفضل.', categorySlugs: ['atyaf-al-aql'] },
  { slug: 'technology-simply', title: 'التقنية ببساطة', description: 'شرح واضح لما يحدث خلف الشاشات، من الإنترنت والذكاء الاصطناعي إلى الفضاء.', categorySlugs: ['future-now', 'simply'] },
  { slug: 'windows-to-world', title: 'نوافذ إلى العالم', description: 'ثقافات وعادات وتجارب توسّع زاوية النظر إلى البشر والمجتمعات.', categorySlugs: ['window-on-world'] },
  { slug: 'books-for-life', title: 'كتب للحياة', description: 'أفكار وقراءات تربط الكتب بالصحة والعمل والحياة اليومية.', categorySlugs: ['bareeq-books'] }
] as const;

export type CategorySlug = (typeof categories)[number]['slug'];
