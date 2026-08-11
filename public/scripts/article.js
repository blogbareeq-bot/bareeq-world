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


  // Reading modes: full text, pre-generated Azure AI Speech audio, and editorial summary.
  const modes = document.querySelector('[data-reading-modes]');
  if (modes && articleContent) {
    const modeButtons = [...modes.querySelectorAll('[data-reading-mode]')];
    const listenPanel = modes.querySelector('[data-listen-panel]');
    const summaryPanel = modes.querySelector('[data-summary-panel]');
    const playButton = modes.querySelector('[data-audio-play]');
    const playLabel = modes.querySelector('[data-audio-play-label]');
    const audioStatus = modes.querySelector('[data-audio-status]');
    const rateSelect = modes.querySelector('[data-audio-rate]');
    const audioPart = modes.querySelector('[data-audio-part]');
    const audioTime = modes.querySelector('[data-audio-time]');
    const audio = modes.querySelector('[data-article-audio]');
    const summaryRead = modes.querySelector('[data-summary-read]');
    const manifestUrl = modes.dataset.audioManifest;
    let manifest = null;
    let partIndex = 0;
    let finished = false;

    const setMode = (name) => {
      modeButtons.forEach((button) => {
        const active = button.dataset.readingMode === name;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
      });
      if (listenPanel) listenPanel.hidden = name !== 'listen';
      if (summaryPanel) summaryPanel.hidden = name !== 'summary';
      if (name === 'read') articleContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    modeButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.readingMode || 'read')));
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
      if (playButton) playButton.setAttribute('aria-label', playing ? 'إيقاف القراءة الصوتية مؤقتًا' : 'متابعة القراءة الصوتية');
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

    const prepareAudio = async () => {
      if (!audio || !playButton || !manifestUrl) return;
      playButton.disabled = true;
      try {
        const response = await fetch(manifestUrl, { cache: 'force-cache', credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.parts) || data.parts.length === 0 || !data.parts.every((part) => typeof part?.src === 'string' && part.src.endsWith('.mp3'))) {
          throw new Error('Invalid audio manifest');
        }
        manifest = data;
        setPart(0);
        playButton.disabled = false;
        if (playLabel) playLabel.textContent = 'ابدأ الاستماع';
        if (playButton) playButton.setAttribute('aria-label', 'بدء الاستماع');
        if (audioStatus) audioStatus.textContent = 'القراءة الصوتية جاهزة';
      } catch {
        playButton.disabled = true;
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
    rateSelect?.addEventListener('change', () => {
      if (audio) audio.playbackRate = Number(rateSelect.value || 1);
    });
    audio?.addEventListener('play', () => {
      finished = false;
      setPlayingUi(true);
      if (audioStatus) audioStatus.textContent = 'جارٍ تشغيل القراءة الصوتية';
    });
    audio?.addEventListener('pause', () => {
      if (audio.ended) return;
      setPlayingUi(false);
      if (audioStatus && !finished) audioStatus.textContent = 'متوقف مؤقتًا';
    });
    audio?.addEventListener('loadedmetadata', () => {
      updatePartStatus();
      updateTime();
    });
    audio?.addEventListener('timeupdate', updateTime);
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
    });
    audio?.addEventListener('error', () => {
      modes.classList.remove('is-speaking');
      if (playLabel) playLabel.textContent = 'إعادة المحاولة';
      if (audioStatus) audioStatus.textContent = 'تعذر تشغيل هذا المقطع. تحقق من الاتصال ثم أعد المحاولة';
    });
    addEventListener('pagehide', () => audio?.pause());

    // Prepare the manifest and first MP3 before the user's play tap. This keeps
    // the actual audio.play() call directly inside a user gesture on mobile Safari/Chrome.
    void prepareAudio();
  }
})();
