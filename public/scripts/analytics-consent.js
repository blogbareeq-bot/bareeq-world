(() => {
  'use strict';

  const banner = document.querySelector('[data-analytics-consent]');
  const settingsButtons = [...document.querySelectorAll('[data-analytics-settings]')];
  if (!(banner instanceof HTMLElement)) return;

  const measurementId = banner.dataset.measurementId?.trim() ?? '';
  const productionHost = banner.dataset.productionHost?.trim() ?? '';
  const allowedHosts = new Set([productionHost, `www.${productionHost}`]);
  const storageKey = 'bareeq-analytics-consent-v1';
  const isProduction = allowedHosts.has(window.location.hostname.toLowerCase());

  if (!isProduction || !/^G-[A-Z0-9]+$/.test(measurementId)) {
    settingsButtons.forEach((button) => { button.hidden = true; });
    return;
  }

  const acceptButton = banner.querySelector('[data-analytics-accept]');
  const rejectButton = banner.querySelector('[data-analytics-reject]');
  const title = banner.querySelector('#analytics-consent-title');

  const readChoice = () => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  };

  const saveChoice = (choice) => {
    try { localStorage.setItem(storageKey, choice); } catch {}
  };

  const setBannerOpen = (open, moveFocus = false) => {
    banner.hidden = !open;
    banner.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('analytics-consent-open', open);
    if (open && moveFocus && title instanceof HTMLElement) title.focus({ preventScroll: true });
  };

  const setConsent = (analyticsStorage) => {
    if (typeof window.gtag !== 'function') return;
    window.gtag('consent', 'update', {
      analytics_storage: analyticsStorage,
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
  };

  const clearAnalyticsCookies = () => {
    const cookieNames = document.cookie
      .split(';')
      .map((cookie) => cookie.split('=')[0]?.trim())
      .filter((name) => name?.startsWith('_ga'));
    const domains = ['', window.location.hostname, productionHost, `.${productionHost}`];
    cookieNames.forEach((name) => domains.forEach((domain) => {
      const domainPart = domain ? ` Domain=${domain};` : '';
      document.cookie = `${name}=; Max-Age=0; Path=/;${domainPart} SameSite=Lax; Secure`;
    }));
  };

  const loadAnalytics = () => {
    if (window.__bareeqAnalyticsLoaded) return;
    window.__bareeqAnalyticsLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      functionality_storage: 'granted',
      security_storage: 'granted'
    });
    window.gtag('js', new Date());
    window.gtag('config', measurementId, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_flags: 'SameSite=Lax;Secure',
      cookie_expires: 34128000,
      send_page_view: true
    });

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    script.dataset.bareeqAnalytics = 'true';
    document.head.appendChild(script);
  };

  acceptButton?.addEventListener('click', () => {
    saveChoice('granted');
    loadAnalytics();
    setConsent('granted');
    setBannerOpen(false);
  });

  rejectButton?.addEventListener('click', () => {
    saveChoice('denied');
    setConsent('denied');
    clearAnalyticsCookies();
    setBannerOpen(false);
  });

  settingsButtons.forEach((button) => button.addEventListener('click', () => setBannerOpen(true, true)));

  const choice = readChoice();
  if (choice === 'granted') loadAnalytics();
  else if (choice !== 'denied') setBannerOpen(true);
})();
