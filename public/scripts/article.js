(() => {
  const bar = document.querySelector('[data-reading-progress]');
  const articleContent = document.querySelector('[data-article-content]');
  const update = () => {
    if (!articleContent) return;
    const rect = articleContent.getBoundingClientRect();
    const start = scrollY + rect.top - innerHeight * 0.2;
    const total = Math.max(1, articleContent.scrollHeight - innerHeight * 0.6);
    const value = Math.max(0, Math.min(1, (scrollY - start) / total));
    if (bar) {
      bar.style.transform = `scaleX(${value})`;
      bar.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    }
  };
  addEventListener('scroll', update, { passive: true });
  update();

  const tocLinks = [...document.querySelectorAll('[data-toc-link]')];
  const tocHeadings = tocLinks.map((link) => {
    const id = decodeURIComponent(link.getAttribute('href')?.slice(1) || '');
    return { link, heading: document.getElementById(id) };
  }).filter((item) => item.heading);
  let tocFrame = 0;
  const updateActiveHeading = () => {
    tocFrame = 0;
    if (!tocHeadings.length) return;
    const threshold = Math.min(innerHeight * 0.3, 220);
    let current = tocHeadings[0];
    tocHeadings.forEach((item) => {
      if (item.heading.getBoundingClientRect().top <= threshold) current = item;
    });
    tocLinks.forEach((link) => {
      const active = link === current.link;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  const scheduleTocUpdate = () => {
    if (!tocFrame) tocFrame = requestAnimationFrame(updateActiveHeading);
  };
  addEventListener('scroll', scheduleTocUpdate, { passive: true });
  addEventListener('resize', scheduleTocUpdate, { passive: true });
  updateActiveHeading();

  const tocBox = document.querySelector('[data-article-toc]');
  const tocToggle = document.querySelector('[data-toc-toggle]');
  const setTocOpen = (open) => {
    tocBox?.classList.toggle('is-open', open);
    tocToggle?.setAttribute('aria-expanded', String(open));
    if (tocToggle) tocToggle.textContent = open ? 'إخفاء الفهرس' : 'عرض الفهرس';
  };
  tocToggle?.addEventListener('click', () => setTocOpen(!tocBox?.classList.contains('is-open')));
  tocLinks.forEach((link) => link.addEventListener('click', () => {
    if (matchMedia('(max-width: 1000px)').matches) setTocOpen(false);
  }));
  document.querySelector('[data-copy-link]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;
    try {
      await navigator.clipboard.writeText(button.dataset.url ?? location.href);
      const old = button.textContent;
      button.textContent = 'تم النسخ';
      setTimeout(() => { button.textContent = old; }, 1600);
    } catch {
      button.textContent = 'انسخ الرابط من المتصفح';
    }
  });
})();
