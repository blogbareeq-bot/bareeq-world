(() => {
  const bar = document.querySelector('[data-reading-progress]');
  const articleContent = document.querySelector('[data-article-content]');
  let sentReadDepth = false;
  let sentEngagedTime = false;
  const articleEventData = () => ({
    article_path: location.pathname,
    article_title: document.querySelector('.article-header h1')?.textContent?.trim() ?? document.title,
    engagement_type: 'editorial_reading'
  });
  const sendArticleEvent = (name) => {
    if (!window.__bareeqAnalyticsLoaded || typeof window.gtag !== 'function') return false;
    window.gtag('event', name, articleEventData());
    return true;
  };
  const update = () => {
    if (!articleContent) return;
    const rect = articleContent.getBoundingClientRect();
    const start = scrollY + rect.top - innerHeight * 0.2;
    const total = Math.max(1, articleContent.scrollHeight - innerHeight * 0.6);
    const value = Math.max(0, Math.min(1, (scrollY - start) / total));
    if (bar) {
      const percentage = Math.round(value * 100);
      if (bar instanceof HTMLProgressElement) bar.value = percentage;
      bar.setAttribute('aria-valuenow', String(percentage));
      if (percentage >= 75 && !sentReadDepth) {
        sentReadDepth = sendArticleEvent('article_read_75');
      }
    }
  };
  addEventListener('scroll', update, { passive: true });
  update();

  let visibleReadingSeconds = 0;
  const sendEngagedTime = () => {
    if (visibleReadingSeconds < 60 || sentEngagedTime) return;
    sentEngagedTime = sendArticleEvent('article_engaged_60s');
    if (sentEngagedTime) clearInterval(engagementTimer);
  };
  const engagementTimer = setInterval(() => {
    if (document.visibilityState === 'visible') visibleReadingSeconds += 5;
    sendEngagedTime();
  }, 5000);
  addEventListener('bareeq:analytics-ready', () => {
    update();
    sendEngagedTime();
  });

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


  // Reading modes: full text, pre-generated Azure AI Speech audio, editorial summary,
  // and synchronized paragraph tracking. Audio remains HTML5-based for mobile reliability.
  const modes = document.querySelector('[data-reading-modes]');
  if (modes && articleContent) {
    const modeButtons = [...modes.querySelectorAll('[data-reading-mode]')];
    const listenPanel = modes.querySelector('[data-listen-panel]');
    const summaryPanel = modes.querySelector('[data-summary-panel]');
    const playButton = modes.querySelector('[data-audio-play]');
    const stopButton = modes.querySelector('[data-audio-stop]');
    const playLabel = modes.querySelector('[data-audio-play-label]');
    const audioStatus = modes.querySelector('[data-audio-status]');
    const rateSelect = modes.querySelector('[data-audio-rate]');
    const audioPart = modes.querySelector('[data-audio-part]');
    const audioTime = modes.querySelector('[data-audio-time]');
    const audio = modes.querySelector('[data-article-audio]');
    const summaryRead = modes.querySelector('[data-summary-read]');
    const manifestUrl = modes.dataset.audioManifest;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let manifest = null;
    let partIndex = 0;
    let finished = false;
    let activeMode = 'read';
    let activeSyncId = '';
    let userNavigatingUntil = 0;
    let programmaticScroll = false;
    const syncTargets = new Map();

    const normalizeSyncText = (value) => (value || '')
      .normalize('NFKD')
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const syncCandidateScore = (blockText, hint) => {
      if (!blockText || !hint) return 0;
      if (blockText === hint) return 1000;
      if (blockText.startsWith(hint) || hint.startsWith(blockText)) return 850 - Math.min(200, Math.abs(blockText.length - hint.length));
      const prefix = hint.slice(0, Math.min(64, hint.length));
      if (prefix.length >= 16 && blockText.includes(prefix)) return 650;
      const shorter = blockText.length < hint.length ? blockText : hint;
      if (shorter.length >= 24 && (blockText.includes(shorter) || hint.includes(shorter))) return 500;
      return 0;
    };

    const buildSyncTargets = () => {
      syncTargets.clear();
      const entries = [];
      const seen = new Set();
      manifest?.parts?.forEach((part) => part.sync?.forEach((entry) => {
        if (entry?.id && entry?.match && !seen.has(entry.id)) {
          seen.add(entry.id);
          entries.push(entry);
        }
      }));
      const blocks = [...articleContent.querySelectorAll('h2,h3,h4,p,li')]
        .filter((element) => element.textContent?.trim())
        .map((element) => ({ element, text: normalizeSyncText(element.textContent) }));
      let cursor = 0;
      for (const entry of entries) {
        const hint = normalizeSyncText(entry.match);
        let bestIndex = -1;
        let bestScore = 0;
        const scan = (from, to) => {
          for (let index = from; index < to; index += 1) {
            const score = syncCandidateScore(blocks[index]?.text || '', hint);
            if (score > bestScore) { bestScore = score; bestIndex = index; }
            if (score >= 900) break;
          }
        };
        scan(cursor, Math.min(blocks.length, cursor + 14));
        if (bestScore < 500) scan(cursor, blocks.length);
        if (bestScore < 500) scan(0, Math.min(cursor, blocks.length));
        if (bestIndex >= 0 && bestScore >= 500) {
          const target = blocks[bestIndex].element;
          target.dataset.audioSyncId = entry.id;
          syncTargets.set(entry.id, target);
          if (bestIndex >= cursor) cursor = bestIndex + 1;
        }
      }
    };

    const markUserNavigation = () => { userNavigatingUntil = Date.now() + 8000; };
    articleContent.addEventListener('wheel', markUserNavigation, { passive: true });
    articleContent.addEventListener('touchstart', markUserNavigation, { passive: true });
    articleContent.addEventListener('pointerdown', markUserNavigation, { passive: true });
    addEventListener('keydown', (event) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(event.key)) markUserNavigation();
    });

    const clearActiveSync = () => {
      if (activeSyncId) {
        const previous = syncTargets.get(activeSyncId);
        previous?.classList.remove('is-audio-active');
        previous?.removeAttribute('data-audio-current');
      }
      activeSyncId = '';
    };

    const smartScrollTo = (target) => {
      if (!target || Date.now() < userNavigatingUntil || activeMode === 'summary' || audio?.paused) return;
      const rect = target.getBoundingClientRect();
      const topSafe = Math.min(170, innerHeight * 0.2);
      const bottomSafe = innerHeight * 0.82;
      if (rect.top >= topSafe && rect.bottom <= bottomSafe) return;
      programmaticScroll = true;
      target.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
      setTimeout(() => { programmaticScroll = false; }, reduceMotion.matches ? 0 : 650);
    };

    const setActiveSync = (id, { scroll = true } = {}) => {
      if (!id || id === activeSyncId) return;
      const target = syncTargets.get(id);
      if (!target) return;
      if (activeSyncId) {
        const previous = syncTargets.get(activeSyncId);
        previous?.classList.remove('is-audio-active');
        previous?.removeAttribute('data-audio-current');
      }
      activeSyncId = id;
      target.classList.add('is-audio-active');
      target.setAttribute('data-audio-current', 'true');
      if (scroll && !programmaticScroll) smartScrollTo(target);
    };

    const syncTextToAudio = () => {
      if (!audio || !manifest?.parts?.[partIndex]) return;
      const entries = manifest.parts[partIndex].sync;
      if (!Array.isArray(entries) || !entries.length || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const ratio = Math.max(0, Math.min(1, audio.currentTime / audio.duration));
      let current = null;
      for (const entry of entries) {
        if (ratio >= Number(entry.start || 0) && ratio < Number(entry.end ?? 1)) { current = entry; break; }
        if (ratio >= Number(entry.start || 0)) current = entry;
      }
      if (current?.id) setActiveSync(current.id);
    };

    const setMode = (name, { focus = false } = {}) => {
      activeMode = name;
      modeButtons.forEach((button) => {
        const active = button.dataset.readingMode === name;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        if (active && focus) button.focus();
      });
      if (listenPanel) listenPanel.hidden = name !== 'listen';
      if (summaryPanel) summaryPanel.hidden = name !== 'summary';
      if (name === 'read') articleContent.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    };
    modeButtons.forEach((button, index) => {
      button.addEventListener('click', () => setMode(button.dataset.readingMode || 'read'));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        const rtl = getComputedStyle(modes).direction === 'rtl';
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = modeButtons.length - 1;
        else if (event.key === 'ArrowLeft') nextIndex = (index + (rtl ? 1 : -1) + modeButtons.length) % modeButtons.length;
        else if (event.key === 'ArrowRight') nextIndex = (index + (rtl ? -1 : 1) + modeButtons.length) % modeButtons.length;
        setMode(modeButtons[nextIndex]?.dataset.readingMode || 'read', { focus: true });
      });
    });
    summaryRead?.addEventListener('click', () => setMode('read'));

    const formatClock = (seconds) => {
      if (!Number.isFinite(seconds) || seconds < 0) return '';
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${String(secs).padStart(2, '0')}`;
    };
    const updatePartStatus = () => {
      if (!manifest || !audioPart) return;
      audioPart.textContent = manifest.parts.length > 1 ? `المقطع ${partIndex + 1} من ${manifest.parts.length}` : 'المقال كاملًا';
    };
    const updateTime = () => {
      if (!audio || !audioTime) return;
      const current = formatClock(audio.currentTime);
      const duration = formatClock(audio.duration);
      audioTime.textContent = duration ? `${current} / ${duration}` : current;
    };
    const setPlayingUi = (playing) => {
      modes.classList.toggle('is-speaking', playing);
      if (playLabel) playLabel.textContent = playing ? 'إيقاف مؤقت' : (finished ? 'استمع من البداية' : 'متابعة');
      if (playButton) playButton.setAttribute('aria-label', playing ? 'إيقاف القراءة الصوتية مؤقتًا' : (finished ? 'إعادة تشغيل القراءة الصوتية' : 'متابعة القراءة الصوتية'));
    };
    const updateStopAvailability = () => {
      if (!stopButton || !audio || !manifest) return;
      stopButton.disabled = partIndex === 0 && audio.currentTime <= 0.05 && !finished && audio.paused;
    };
    const setPart = (index) => {
      if (!audio || !manifest?.parts?.[index]) return false;
      partIndex = index;
      finished = false;
      audio.src = manifest.parts[index].src;
      audio.playbackRate = Number(rateSelect?.value || 1);
      audio.load();
      updatePartStatus();
      updateTime();
      updateStopAvailability();
      return true;
    };
    const playCurrent = async () => {
      if (!audio) return;
      try {
        await audio.play();
      } catch {
        modes.classList.remove('is-speaking');
        if (playLabel) playLabel.textContent = 'متابعة';
        if (audioStatus) audioStatus.textContent = 'اضغط «متابعة» لتشغيل المقطع التالي';
      }
    };
    const stopAudio = () => {
      if (!audio || !manifest) return;
      audio.pause();
      finished = false;
      clearActiveSync();
      if (partIndex !== 0) setPart(0);
      else {
        try { audio.currentTime = 0; } catch { /* metadata can still be loading */ }
        updateTime();
      }
      modes.classList.remove('is-speaking');
      if (playLabel) playLabel.textContent = 'ابدأ الاستماع';
      if (playButton) playButton.setAttribute('aria-label', 'بدء الاستماع');
      if (audioStatus) audioStatus.textContent = 'تم إيقاف القراءة وإعادتها إلى البداية';
      updateStopAvailability();
    };

    const prepareAudio = async () => {
      if (!audio || !playButton || !manifestUrl) return;
      playButton.disabled = true;
      if (stopButton) stopButton.disabled = true;
      try {
        const response = await fetch(manifestUrl, { cache: 'force-cache', credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.parts) || data.parts.length === 0 || !data.parts.every((part) => typeof part?.src === 'string' && part.src.endsWith('.mp3') && Array.isArray(part.sync))) {
          throw new Error('Invalid synchronized audio manifest');
        }
        manifest = data;
        buildSyncTargets();
        setPart(0);
        playButton.disabled = false;
        updateStopAvailability();
        if (playLabel) playLabel.textContent = 'ابدأ الاستماع';
        playButton.setAttribute('aria-label', 'بدء الاستماع');
        if (audioStatus) audioStatus.textContent = syncTargets.size ? 'القراءة الصوتية جاهزة مع تتبّع النص' : 'القراءة الصوتية جاهزة';
      } catch {
        playButton.disabled = true;
        if (stopButton) stopButton.disabled = true;
        if (playLabel) playLabel.textContent = 'الصوت غير متاح';
        if (audioStatus) audioStatus.textContent = 'تعذر تحميل القراءة الصوتية لهذا المقال';
      }
    };

    playButton?.addEventListener('click', () => {
      if (!audio || playButton.disabled || !manifest) return;
      if (finished) setPart(0);
      if (audio.paused) void playCurrent();
      else audio.pause();
    });
    stopButton?.addEventListener('click', stopAudio);
    rateSelect?.addEventListener('change', () => {
      if (audio) audio.playbackRate = Number(rateSelect.value || 1);
    });
    audio?.addEventListener('play', () => {
      finished = false;
      setPlayingUi(true);
      updateStopAvailability();
      syncTextToAudio();
      if (audioStatus) audioStatus.textContent = 'جارٍ تشغيل القراءة الصوتية';
    });
    audio?.addEventListener('pause', () => {
      if (audio.ended) return;
      setPlayingUi(false);
      updateStopAvailability();
      if (audioStatus && !finished) audioStatus.textContent = 'متوقف مؤقتًا';
    });
    audio?.addEventListener('loadedmetadata', () => {
      updatePartStatus();
      updateTime();
      updateStopAvailability();
      syncTextToAudio();
    });
    audio?.addEventListener('timeupdate', () => {
      updateTime();
      updateStopAvailability();
      syncTextToAudio();
    });
    audio?.addEventListener('ended', () => {
      if (!manifest) return;
      if (partIndex + 1 < manifest.parts.length) {
        setPart(partIndex + 1);
        if (audioStatus) audioStatus.textContent = 'جارٍ الانتقال إلى المقطع التالي';
        void playCurrent();
        return;
      }
      finished = true;
      modes.classList.remove('is-speaking');
      if (playLabel) playLabel.textContent = 'استمع من البداية';
      if (playButton) playButton.setAttribute('aria-label', 'إعادة تشغيل القراءة الصوتية');
      if (audioStatus) audioStatus.textContent = 'اكتملت قراءة المقال';
      updateTime();
      updateStopAvailability();
    });
    audio?.addEventListener('error', () => {
      modes.classList.remove('is-speaking');
      if (playLabel) playLabel.textContent = 'إعادة المحاولة';
      if (audioStatus) audioStatus.textContent = 'تعذر تشغيل هذا المقطع. تحقق من الاتصال ثم أعد المحاولة';
      updateStopAvailability();
    });
    addEventListener('pagehide', () => audio?.pause());

    // Prepare the manifest and first MP3 before the user's play tap. This keeps
    // the actual audio.play() call directly inside a user gesture on mobile Safari/Chrome.
    void prepareAudio();
  }

})();
