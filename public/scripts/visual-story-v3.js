(() => {
  const root = document.querySelector('[data-window-v3-root]');
  const trigger = document.querySelector('[data-reading-mode="window"]');
  if (!root || !trigger) return;

  function initWindowV3(root, trigger) {
    const dialog = root.querySelector('[data-visual-dialog]');
    const scroller = root.querySelector('[data-v3-scroller]');
    const scenes = [...root.querySelectorAll('[data-v3-scene]')];
    const position = root.querySelector('[data-visual-position]');
    const progressBar = root.querySelector('[data-v3-progress-bar]');
    const navCount = root.querySelector('[data-v3-nav-count]');
    const status = root.querySelector('[data-visual-status]');
    const next = root.querySelector('[data-visual-next]');
    const previous = root.querySelector('[data-visual-prev]');
    const home = root.querySelector('[data-v3-home]');
    const share = root.querySelector('[data-visual-share]');
    const motion = root.querySelector('[data-v3-motion]');
    const storyId = root.dataset.storyKey;
    const storageKey = `bareeq-visual-progress-v1:${storyId}`;
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    let index = 0;
    let returnFocus = null;
    let openedAt = 0;
    let calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scrollRaf = 0;
    const seen = new Set();

    const emit = (action, extra = {}) => {
      const detail = { action, storyId, cardId: scenes[index]?.dataset.cardId, cardIndex: index, cardCount: scenes.length, ...extra };
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
      try { localStorage.setItem(storageKey, JSON.stringify({ index, completed, updatedAt: Date.now() })); } catch {}
    };
    const cardIndexFromHash = () => {
      const id = decodeURIComponent(location.hash.match(/^#visual=(.+)$/)?.[1] || '');
      return scenes.findIndex((scene) => scene.dataset.cardId === id);
    };
    const setHash = (cardId, replace = true) => {
      const url = `${location.pathname}${location.search}#visual=${encodeURIComponent(cardId)}`;
      history[replace ? 'replaceState' : 'pushState'](null, '', url);
    };
    const sync = (target, { updateHash = true, saveProgress = true } = {}) => {
      index = Math.max(0, Math.min(scenes.length - 1, target));
      scenes.forEach((scene, sceneIndex) => {
        const active = sceneIndex === index;
        scene.classList.toggle('is-active', active);
        if (active) scene.setAttribute('aria-current', 'step'); else scene.removeAttribute('aria-current');
      });
      if (position) position.textContent = String(index + 1);
      if (navCount) navCount.textContent = `${index + 1} / ${scenes.length}`;
      if (progressBar) progressBar.style.width = `${((index + 1) / scenes.length) * 100}%`;
      previous.disabled = index === 0;
      next.disabled = index === scenes.length - 1;
      if (saveProgress) save(index === scenes.length - 1);
      if (updateHash) setHash(scenes[index].dataset.cardId);
      if (!seen.has(index)) { seen.add(index); emit('card_view'); }
    };
    const scrollToIndex = (target, { updateHash = true, instant = false } = {}) => {
      const nextIndex = Math.max(0, Math.min(scenes.length - 1, target));
      sync(nextIndex, { updateHash });
      const scene = scenes[nextIndex];
      scroller.scrollTo({ top: scene.offsetTop, behavior: instant || calm ? 'auto' : 'smooth' });
    };
    const nearestIndex = () => {
      const y = scroller.scrollTop;
      let best = 0;
      let distance = Infinity;
      scenes.forEach((scene, sceneIndex) => {
        const d = Math.abs(scene.offsetTop - y);
        if (d < distance) { distance = d; best = sceneIndex; }
      });
      return best;
    };
    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        const nearest = nearestIndex();
        if (nearest !== index) sync(nearest, { updateHash: true });
      });
    };
    const setCalm = (value) => {
      calm = Boolean(value);
      root.classList.toggle('is-calm', calm);
      motion?.setAttribute('aria-pressed', String(calm));
    };
    const open = ({ fromHash = false } = {}) => {
      returnFocus = document.activeElement;
      const hashIndex = cardIndexFromHash();
      const saved = readSaved();
      const start = hashIndex >= 0 ? hashIndex : saved && !saved.completed ? Number(saved.index) : 0;
      root.hidden = false;
      document.body.classList.add('visual-story-open');
      openedAt = Date.now();
      requestAnimationFrame(() => {
        scrollToIndex(start, { updateHash: !fromHash || hashIndex < 0, instant: true });
        dialog?.focus();
      });
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

    trigger.addEventListener('click', () => open());
    root.querySelectorAll('[data-visual-close]').forEach((button) => button.addEventListener('click', close));
    next.addEventListener('click', () => scrollToIndex(index + 1));
    previous.addEventListener('click', () => scrollToIndex(index - 1));
    home?.addEventListener('click', () => scrollToIndex(0));
    motion?.addEventListener('click', () => setCalm(!calm));
    scroller.addEventListener('scroll', onScroll, { passive: true });
    share?.addEventListener('click', async () => {
      const scene = scenes[index];
      const title = scene.querySelector('h2')?.textContent?.trim() || root.dataset.storyTitle;
      const text = `${title} — نافذة بريق`;
      const url = new URL(location.href);
      url.hash = `visual=${scene.dataset.cardId}`;
      try {
        if (navigator.share) await navigator.share({ title: root.dataset.storyTitle, text, url: url.toString() });
        else { await navigator.clipboard.writeText(`${text}\n${url}`); if (status) status.textContent = 'تم نسخ رابط المشهد.'; }
        emit('share');
      } catch (error) {
        if (error?.name !== 'AbortError' && status) status.textContent = 'تعذر فتح المشاركة. انسخ الرابط من المتصفح.';
      }
    });

    const probe = root.querySelector('[data-v3-probe]');
    if (probe) {
      const svg = probe.querySelector('svg');
      const nodes = [...probe.querySelectorAll('[data-v3-probe-node]')];
      const touch = probe.querySelector('[data-v3-probe-touch]');
      const output = probe.querySelector('[data-v3-probe-output]');
      let px = -999, py = -999, engaged = false, raf = 0;
      const local = (event) => {
        const rect = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const scale = Math.min(rect.width / vb.width, rect.height / vb.height);
        const ox = (rect.width - vb.width * scale) / 2;
        const oy = (rect.height - vb.height * scale) / 2;
        px = (event.clientX - rect.left - ox) / scale;
        py = (event.clientY - rect.top - oy) / scale;
      };
      const draw = () => {
        raf = 0;
        let peak = 0;
        nodes.forEach((node) => {
          const distance = Math.hypot(Number(node.dataset.x) - px, Number(node.dataset.y) - py);
          const near = engaged ? Math.max(0, 1 - distance / 95) : 0;
          node.style.setProperty('--v3-near', near.toFixed(3));
          peak = Math.max(peak, near);
        });
        touch.setAttribute('cx', String(px)); touch.setAttribute('cy', String(py)); touch.style.opacity = engaged ? '1' : '0';
        output.textContent = !engaged ? 'محاكاة بصرية نوعية' : peak > .72 ? 'أثر تمثيلي أقوى بالقرب' : peak > .35 ? 'أثر تمثيلي متوسط' : 'أثر تمثيلي خفيف';
      };
      const queue = () => { if (!raf) raf = requestAnimationFrame(draw); };
      const engage = (event) => { engaged = true; local(event); queue(); };
      probe.addEventListener('pointermove', engage);
      probe.addEventListener('pointerdown', engage);
      probe.addEventListener('pointerleave', () => { engaged = false; queue(); });
      probe.addEventListener('pointercancel', () => { engaged = false; queue(); });
      draw();
    }

    const pinch = root.querySelector('[data-v3-pinch]');
    if (pinch) {
      const svg = pinch.querySelector('svg');
      const link = pinch.querySelector('[data-v3-pinch-link]');
      const dots = { a: pinch.querySelector('[data-v3-pinch-dot="a"]'), b: pinch.querySelector('[data-v3-pinch-dot="b"]') };
      const halos = { a: pinch.querySelector('[data-v3-pinch-halo="a"]'), b: pinch.querySelector('[data-v3-pinch-halo="b"]') };
      const handles = [...pinch.querySelectorAll('[data-v3-pinch-handle]')];
      const pos = { a: { x: 185, y: 130 }, b: { x: 335, y: 130 } };
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const render = () => {
        const stageRect = pinch.getBoundingClientRect();
        const svgRect = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const scale = Math.min(svgRect.width / vb.width, svgRect.height / vb.height);
        const ox = (svgRect.width - vb.width * scale) / 2;
        const oy = (svgRect.height - vb.height * scale) / 2;
        ['a', 'b'].forEach((key) => {
          dots[key].setAttribute('cx', String(pos[key].x)); dots[key].setAttribute('cy', String(pos[key].y));
          halos[key].setAttribute('cx', String(pos[key].x)); halos[key].setAttribute('cy', String(pos[key].y));
          const handle = pinch.querySelector(`[data-v3-pinch-handle="${key}"]`);
          handle.style.left = `${svgRect.left - stageRect.left + ox + pos[key].x * scale}px`;
          handle.style.top = `${svgRect.top - stageRect.top + oy + pos[key].y * scale}px`;
        });
        link.setAttribute('x1', String(pos.a.x)); link.setAttribute('y1', String(pos.a.y)); link.setAttribute('x2', String(pos.b.x)); link.setAttribute('y2', String(pos.b.y));
      };
      const moveFromEvent = (event, key) => {
        const rect = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const scale = Math.min(rect.width / vb.width, rect.height / vb.height);
        const ox = (rect.width - vb.width * scale) / 2;
        const oy = (rect.height - vb.height * scale) / 2;
        pos[key].x = clamp((event.clientX - rect.left - ox) / scale, 38, 482);
        pos[key].y = clamp((event.clientY - rect.top - oy) / scale, 32, 218);
        render();
      };
      handles.forEach((handle) => {
        const key = handle.dataset.v3PinchHandle;
        let dragging = false;
        handle.addEventListener('pointerdown', (event) => { dragging = true; handle.setPointerCapture(event.pointerId); moveFromEvent(event, key); });
        handle.addEventListener('pointermove', (event) => { if (dragging) moveFromEvent(event, key); });
        handle.addEventListener('pointerup', () => { dragging = false; });
        handle.addEventListener('pointercancel', () => { dragging = false; });
        handle.addEventListener('keydown', (event) => {
          if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
          event.preventDefault(); const step = event.shiftKey ? 12 : 5;
          if (event.key === 'ArrowLeft') pos[key].x -= step;
          if (event.key === 'ArrowRight') pos[key].x += step;
          if (event.key === 'ArrowUp') pos[key].y -= step;
          if (event.key === 'ArrowDown') pos[key].y += step;
          pos[key].x = clamp(pos[key].x, 38, 482); pos[key].y = clamp(pos[key].y, 32, 218); render();
        });
      });
      pinch.querySelector('[data-v3-pinch-reset]')?.addEventListener('click', () => { pos.a.x = 185; pos.a.y = 130; pos.b.x = 335; pos.b.y = 130; render(); });
      addEventListener('resize', render);
      requestAnimationFrame(render);
    }

    const lab = root.querySelector('[data-v3-lab]');
    if (lab) {
      const output = lab.querySelector('[data-v3-lab-output]');
      const controls = [...root.querySelectorAll('[data-v3-lab-state]')];
      controls.forEach((button) => button.addEventListener('click', () => {
        const wet = button.dataset.v3LabState === 'wet';
        lab.classList.toggle('is-wet', wet);
        controls.forEach((control) => control.classList.toggle('is-active', control === button));
        output.textContent = wet ? 'الرطوبة قد تشوش القراءة أو تشبه إشارات اللمس.' : 'سطح جاف.';
      }));
    }

    document.addEventListener('keydown', (event) => {
      if (root.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Home') { event.preventDefault(); scrollToIndex(0); return; }
      if (event.key === 'End') { event.preventDefault(); scrollToIndex(scenes.length - 1); return; }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); scrollToIndex(index + 1); return; }
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); scrollToIndex(index - 1); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    addEventListener('hashchange', () => {
      const hashIndex = cardIndexFromHash();
      if (hashIndex >= 0) { if (root.hidden) open({ fromHash: true }); else scrollToIndex(hashIndex, { updateHash: false }); }
    });
    setCalm(calm);
    if (cardIndexFromHash() >= 0) open({ fromHash: true });
  }

  initWindowV3(root, trigger);
})();
