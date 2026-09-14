(() => {
  'use strict';

  const cards = [...document.querySelectorAll('[data-monetization-card]')];
  const checkoutLinks = [...document.querySelectorAll('[data-checkout-link]')];
  if (!cards.length && !checkoutLinks.length) return;

  const pending = [];
  const viewed = new WeakSet();

  const send = (name, params) => {
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, params);
      return true;
    }
    pending.push([name, params]);
    return false;
  };

  const flush = () => {
    if (typeof window.gtag !== 'function') return;
    while (pending.length) {
      const [name, params] = pending.shift();
      window.gtag('event', name, params);
    }
  };

  window.addEventListener('bareeq:analytics-ready', flush, { once: true });
  if (typeof window.gtag === 'function') flush();

  const paramsFor = (card) => ({
    offer_id: card.dataset.offerId || '',
    offer_kind: card.dataset.offerKind || '',
    offer_provider: card.dataset.offerProvider || '',
    article_id: card.dataset.articleId || '',
    placement: card.dataset.placement || ''
  });

  cards.forEach((card) => {
    const link = card.querySelector('[data-monetization-link]');
    if (link instanceof HTMLAnchorElement) {
      link.addEventListener('click', () => send('monetization_click', paramsFor(card)));
    }
  });

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.5 || viewed.has(entry.target)) return;
        viewed.add(entry.target);
        send('monetization_view', paramsFor(entry.target));
        observer.unobserve(entry.target);
      });
    }, { threshold: [0.5] });
    cards.forEach((card) => observer.observe(card));
  }

  checkoutLinks.forEach((link) => {
    link.addEventListener('click', () => send('begin_checkout', {
      item_id: link.dataset.productId || '',
      item_name: link.dataset.productName || '',
      currency: link.dataset.currency || 'SAR',
      value: Number(link.dataset.value || '0') || 0
    }));
  });
})();
