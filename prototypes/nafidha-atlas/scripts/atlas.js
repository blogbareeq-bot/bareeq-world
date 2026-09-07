/* ============================================================
   نافذة بريق — Atlas runtime
   Loads Story JSON, renders scenes, drives the depth gauge and
   the light↔dark rhythm between scenes.
   ============================================================ */
(function () {
  'use strict';
  const { resolve, helpers } = window.BareeqScenes;
  const atlas = document.querySelector('[data-atlas]');
  const gauge = document.querySelector('[data-gauge]');
  const gaugeList = document.querySelector('[data-gauge-list]');
  const gaugeFill = document.querySelector('[data-gauge-fill]');
  const chromeSub = document.querySelector('[data-chrome-sub]');
  const motionBtn = document.querySelector('[data-motion-toggle]');

  /* ---- motion preference (user override on top of OS) ---- */
  const MKEY = 'bareeq-atlas-motion';
  const setMotion = (calm) => {
    document.documentElement.classList.toggle('is-calm', calm);
    motionBtn.setAttribute('aria-pressed', String(calm));
    try { localStorage.setItem(MKEY, calm ? '1' : '0'); } catch (e) {}
  };
  let calm = false;
  try { calm = localStorage.getItem(MKEY) === '1'; } catch (e) {}
  if (helpers.noMotion()) calm = true;
  setMotion(calm);
  motionBtn.addEventListener('click', () => setMotion(!document.documentElement.classList.contains('is-calm')));

  fetch('./story.json', { cache: 'no-cache' })
    .then((r) => r.json())
    .then(render)
    .catch(() => {
      atlas.innerHTML = '<div class="statement"><p class="scene__body">تعذّر تحميل القصة.</p></div>';
    });

  function render(story) {
    document.title = `نافذة بريق — ${story.title}`;
    const link = document.querySelector('[data-article-link]');
    if (link) link.href = story.articlePath;
    if (chromeSub) chromeSub.textContent = story.director.label;
    // director palette hook — a story may tint, never repaint
    if (Array.isArray(story.director.palette)) {
      const [navy, teal, ivory, gold] = story.director.palette;
      const r = document.documentElement.style;
      if (navy) r.setProperty('--navy', navy);
      if (teal) r.setProperty('--teal', teal);
      if (ivory) r.setProperty('--ivory', ivory);
      if (gold) r.setProperty('--gold', gold);
    }

    const ctx = { articlePath: story.articlePath, title: story.title, director: story.director };
    const mounted = [];

    story.cards.forEach((card, i) => {
      const scene = resolve(card);
      const section = document.createElement('section');
      section.className = `scene scene--${scene.tone}`;
      section.dataset.scene = String(i);
      section.id = `scene-${i + 1}`;
      section.setAttribute('aria-label', card.kicker);
      section.innerHTML = `<div class="scene__inner">${scene.build(card, ctx)}</div>`;
      atlas.appendChild(section);
      if (scene.mount) mounted.push(() => scene.mount(section, card, ctx));
    });
    mounted.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } });

    /* ---- depth gauge ---- */
    gaugeList.innerHTML = story.cards.map((c, i) =>
      `<li><a href="#scene-${i + 1}" data-gauge-item="${i}"><i aria-hidden="true"></i><span>${helpers.esc ? c.kicker : c.kicker}</span></a></li>`
    ).join('');
    const items = [...gaugeList.querySelectorAll('[data-gauge-item]')];
    const sections = [...atlas.querySelectorAll('.scene')];

    let active = -1;
    const setActive = (i) => {
      if (i === active) return;
      active = i;
      items.forEach((a, k) => a.parentElement.classList.toggle('is-active', k === i));
      document.documentElement.dataset.tone = sections[i].classList.contains('scene--deep') ? 'deep'
        : sections[i].classList.contains('scene--paper') ? 'paper' : 'ivory';
      gaugeFill.style.setProperty('--p', ((i + 1) / sections.length * 100).toFixed(2) + '%');
    };

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(+e.target.dataset.scene); });
    }, { rootMargin: '-40% 0px -55% 0px' });
    sections.forEach((s) => io.observe(s));
    setActive(0);

    // reveal-on-enter for prose blocks (opacity/translate only)
    const rio = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); rio.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -12% 0px' });
    atlas.querySelectorAll('.scene__inner > *').forEach((el) => { el.classList.add('rise'); rio.observe(el); });

    /* ---- keyboard: scene-to-scene navigation ---- */
    document.addEventListener('keydown', (e) => {
      if (/^(INPUT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName || '')) return;
      let next = null;
      if (e.key === 'PageDown' || e.key === 'ArrowDown') next = active + 1;
      if (e.key === 'PageUp' || e.key === 'ArrowUp') next = active - 1;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = sections.length - 1;
      if (next == null || next < 0 || next >= sections.length) return;
      e.preventDefault();
      sections[next].scrollIntoView({ behavior: document.documentElement.classList.contains('is-calm') ? 'auto' : 'smooth', block: 'start' });
    });

    gauge.hidden = false;
  }
})();
