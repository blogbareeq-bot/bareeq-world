(() => {
  const root = document.querySelector('[data-visual-story]');
  const trigger = document.querySelector('[data-reading-mode="window"]');
  if (!root || !trigger) return;

  const dialog = root.querySelector('[data-visual-dialog]');
  const cards = [...root.querySelectorAll('[data-visual-card]')];
  const dots = [...root.querySelectorAll('[data-visual-dot]')];
  const position = root.querySelector('[data-visual-position]');
  const status = root.querySelector('[data-visual-status]');
  const next = root.querySelector('[data-visual-next]');
  const previous = root.querySelector('[data-visual-prev]');
  const share = root.querySelector('[data-visual-share]');
  const storyId = root.dataset.storyKey;
  const storageKey = `bareeq-visual-progress-v1:${storyId}`;
  const maxAge = 30 * 24 * 60 * 60 * 1000;
  let index = 0;
  let returnFocus = null;
  let touchX = null;
  let openedAt = 0;
  const seen = new Set();

  const emit = (action, extra = {}) => {
    const detail = { action, storyId, cardId: cards[index]?.dataset.cardId, cardIndex: index, cardCount: cards.length, ...extra };
    window.dispatchEvent(new CustomEvent('bareeq:visual-story', { detail }));
    window.dataLayer?.push({ event: 'bareeq_visual_story', ...detail });
    if (window.__bareeqAnalyticsLoaded && typeof window.gtag === 'function') window.gtag('event', `visual_${action}`, detail);
  };
  const readSaved = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (!saved || Date.now() - saved.updatedAt > maxAge) { localStorage.removeItem(storageKey); return null; }
      return saved;
    } catch { return null; }
  };
  const save = (completed = false) => {
    try { localStorage.setItem(storageKey, JSON.stringify({ index, completed, updatedAt: Date.now() })); } catch { /* restricted storage */ }
  };
  const cardIndexFromHash = () => {
    const id = decodeURIComponent(location.hash.match(/^#visual=(.+)$/)?.[1] || '');
    return cards.findIndex((card) => card.dataset.cardId === id);
  };
  const setHash = (cardId, replace = true) => {
    const url = `${location.pathname}${location.search}#visual=${encodeURIComponent(cardId)}`;
    history[replace ? 'replaceState' : 'pushState'](null, '', url);
  };
  const show = (target, { updateHash = true } = {}) => {
    index = Math.max(0, Math.min(cards.length - 1, target));
    cards.forEach((card, cardIndex) => {
      const active = cardIndex === index;
      card.classList.toggle('is-active', active);
      card.setAttribute('aria-hidden', String(!active));
    });
    dots.forEach((dot, dotIndex) => dot.setAttribute('aria-selected', String(dotIndex === index)));
    if (position) position.textContent = String(index + 1);
    previous.disabled = index === 0;
    next.querySelector('span').textContent = index === cards.length - 1 ? 'إتمام' : 'التالي';
    const completed = index === cards.length - 1;
    save(completed);
    if (updateHash) setHash(cards[index].dataset.cardId);
    if (!seen.has(index)) { seen.add(index); emit('card_view'); }
  };
  const open = ({ fromHash = false } = {}) => {
    returnFocus = document.activeElement;
    const hashIndex = cardIndexFromHash();
    const saved = readSaved();
    const start = hashIndex >= 0 ? hashIndex : saved && !saved.completed ? Number(saved.index) : 0;
    root.hidden = false;
    document.body.classList.add('visual-story-open');
    openedAt = Date.now();
    show(start, { updateHash: !fromHash || hashIndex < 0 });
    requestAnimationFrame(() => dialog?.focus());
    emit('open', { resumed: hashIndex < 0 && Boolean(saved && !saved.completed) });
  };
  const close = () => {
    if (root.hidden) return;
    emit('close', { sessionSeconds: Math.round((Date.now() - openedAt) / 1000) });
    root.hidden = true;
    document.body.classList.remove('visual-story-open');
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    document.querySelector('[data-reading-mode="read"]')?.click();
    returnFocus?.focus?.();
  };
  const goNext = () => {
    if (index === cards.length - 1) { save(true); emit('complete'); close(); return; }
    show(index + 1);
  };
  const goPrevious = () => show(index - 1);

  trigger.addEventListener('click', () => open());
  root.querySelectorAll('[data-visual-close]').forEach((button) => button.addEventListener('click', close));
  next.addEventListener('click', goNext);
  previous.addEventListener('click', goPrevious);
  dots.forEach((dot) => dot.addEventListener('click', () => show(Number(dot.dataset.index))));
  share.addEventListener('click', async () => {
    const card = cards[index];
    const title = card.querySelector('h2')?.textContent?.trim() || root.dataset.storyTitle;
    const text = `${title} — نافذة بريق`;
    const url = new URL(location.href);
    url.hash = `visual=${card.dataset.cardId}`;
    try {
      if (navigator.share) await navigator.share({ title: root.dataset.storyTitle, text, url: url.toString() });
      else { await navigator.clipboard.writeText(`${text}\n${url}`); status.textContent = 'تم نسخ رابط البطاقة.'; }
      emit('share');
    } catch (error) {
      if (error?.name !== 'AbortError') status.textContent = 'تعذر فتح المشاركة. انسخ الرابط من المتصفح.';
    }
  });
  dialog.addEventListener('touchstart', (event) => { touchX = event.touches[0]?.clientX ?? null; }, { passive: true });
  dialog.addEventListener('touchend', (event) => {
    if (touchX === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? touchX) - touchX;
    touchX = null;
    if (Math.abs(delta) < 48) return;
    if (delta > 0) goNext(); else goPrevious();
  }, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (root.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Home') { event.preventDefault(); show(0); return; }
    if (event.key === 'End') { event.preventDefault(); show(cards.length - 1); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); goNext(); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); goPrevious(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  addEventListener('hashchange', () => {
    const hashIndex = cardIndexFromHash();
    if (hashIndex >= 0) { if (root.hidden) open({ fromHash: true }); else show(hashIndex, { updateHash: false }); }
  });
  if (cardIndexFromHash() >= 0) open({ fromHash: true });
})();
