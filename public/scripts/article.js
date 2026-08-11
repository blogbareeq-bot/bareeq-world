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


  // Reading modes: full text, Arabic speech synthesis, and editorial summary.
  const modes = document.querySelector('[data-reading-modes]');
  if (modes && articleContent) {
    const modeButtons = [...modes.querySelectorAll('[data-reading-mode]')];
    const listenPanel = modes.querySelector('[data-listen-panel]');
    const summaryPanel = modes.querySelector('[data-summary-panel]');
    const playButton = modes.querySelector('[data-audio-play]');
    const playLabel = modes.querySelector('[data-audio-play-label]');
    const audioStatus = modes.querySelector('[data-audio-status]');
    const rateSelect = modes.querySelector('[data-audio-rate]');
    const summaryRead = modes.querySelector('[data-summary-read]');
    const speechSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    let chunks = [];
    let chunkIndex = 0;
    let speaking = false;
    let paused = false;
    let speechToken = 0;

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

    const cleanText = () => [...articleContent.querySelectorAll('h2,h3,p,li')]
      .filter((node) => !node.closest('table, .sources, [aria-hidden="true"]'))
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const splitSpeech = () => {
      const result = [];
      cleanText().forEach((text) => {
        if (text.length <= 650) result.push(text);
        else {
          const sentences = text.match(/[^.!؟؛]+[.!؟؛]?/g) || [text];
          let part = '';
          sentences.forEach((sentence) => {
            if ((part + sentence).length > 650 && part) { result.push(part.trim()); part = ''; }
            part += sentence;
          });
          if (part.trim()) result.push(part.trim());
        }
      });
      return result;
    };
    const preferredArabicVoice = () => speechSynthesis.getVoices().find((voice) => /^ar(-|_)/i.test(voice.lang) && /Saudi|Hamed|Maged|Tarik|Arabic/i.test(voice.name))
      || speechSynthesis.getVoices().find((voice) => /^ar(-|_)/i.test(voice.lang));
    const speakNext = (token = speechToken) => {
      if (token !== speechToken) return;
      if (!speaking || chunkIndex >= chunks.length) {
        speaking = false; paused = false; modes.classList.remove('is-speaking');
        if (playLabel) playLabel.textContent = 'ابدأ الاستماع';
        if (audioStatus) audioStatus.textContent = chunkIndex >= chunks.length ? 'اكتملت قراءة المقال' : 'جاهز للقراءة الصوتية';
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[chunkIndex]);
      utterance.lang = 'ar-SA';
      utterance.rate = Number(rateSelect?.value || 1);
      const voice = preferredArabicVoice(); if (voice) utterance.voice = voice;
      utterance.onend = () => { if (token !== speechToken) return; chunkIndex += 1; speakNext(token); };
      utterance.onerror = () => { if (token !== speechToken) return; speaking = false; paused = false; modes.classList.remove('is-speaking'); if (playLabel) playLabel.textContent = 'ابدأ الاستماع'; if (audioStatus) audioStatus.textContent = 'تعذر إكمال القراءة على هذا الجهاز'; };
      speechSynthesis.speak(utterance);
    };
    if (!speechSupported && playButton) {
      playButton.disabled = true;
      if (audioStatus) audioStatus.textContent = 'القراءة الصوتية غير مدعومة في هذا المتصفح';
    }
    playButton?.addEventListener('click', () => {
      if (!speechSupported) return;
      if (speaking && !paused) { speechSynthesis.pause(); paused = true; modes.classList.remove('is-speaking'); if (playLabel) playLabel.textContent = 'متابعة'; if (audioStatus) audioStatus.textContent = 'متوقف مؤقتًا'; return; }
      if (speaking && paused) { speechSynthesis.resume(); paused = false; modes.classList.add('is-speaking'); if (playLabel) playLabel.textContent = 'إيقاف مؤقت'; if (audioStatus) audioStatus.textContent = 'جارٍ قراءة المقال'; return; }
      chunks = splitSpeech(); chunkIndex = 0; speaking = chunks.length > 0; paused = false; speechToken += 1; modes.classList.toggle('is-speaking', speaking);
      if (!speaking) { if (audioStatus) audioStatus.textContent = 'لا يوجد نص متاح للقراءة'; return; }
      if (playLabel) playLabel.textContent = 'إيقاف مؤقت'; if (audioStatus) audioStatus.textContent = 'جارٍ قراءة المقال'; speakNext(speechToken);
    });
    rateSelect?.addEventListener('change', () => {
      if (!speaking) return;
      speechToken += 1;
      const token = speechToken;
      speechSynthesis.cancel();
      paused = false;
      queueMicrotask(() => speakNext(token));
    });
    addEventListener('pagehide', () => { if (speechSupported) { speechToken += 1; speechSynthesis.cancel(); } });
  }
})();
