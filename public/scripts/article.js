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


  // Reading modes: full text, one or more pre-generated voices, editorial summary,
  // synchronized paragraph tracking, saved progress, and a native-controls tablet fallback.
  const modes = document.querySelector('[data-reading-modes]');
  if (modes && articleContent) {
    const modeButtons = [...modes.querySelectorAll('[data-reading-mode]')];
    const listenPanel = modes.querySelector('[data-listen-panel]');
    const summaryPanel = modes.querySelector('[data-summary-panel]');
    const playButton = modes.querySelector('[data-audio-play]');
    const stopButton = modes.querySelector('[data-audio-stop]');
    const nativeFallbackButton = modes.querySelector('[data-audio-native-fallback]');
    const playLabel = modes.querySelector('[data-audio-play-label]');
    const audioStatus = modes.querySelector('[data-audio-status]');
    const voiceSelect = modes.querySelector('[data-audio-voice]');
    const voiceField = modes.querySelector('[data-audio-voice-field]');
    const rateSelect = modes.querySelector('[data-audio-rate]');
    const seekInput = modes.querySelector('[data-audio-seek]');
    const listenLabel = modes.querySelector('[data-listen-label]');
    const currentVoice = modes.querySelector('[data-audio-current-voice]');
    const audioTime = modes.querySelector('[data-audio-time]');
    const audio = modes.querySelector('[data-article-audio]');
    const inlineManifestNode = modes.querySelector('[data-audio-manifest-inline]');
    const summaryRead = modes.querySelector('[data-summary-read]');
    const manifestUrl = modes.dataset.audioManifest;
    const audioCore = window.BareeqAudioCore;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const MANIFEST_TIMEOUT_MS = 9000;
    const PLAY_START_TIMEOUT_MS = 18000;
    let manifest = null;
    let preparingManifest = null;
    let playStartTimer = 0;
    let awaitingPlaybackStart = false;
    let partIndex = 0;
    let finished = false;
    let activeMode = 'read';
    let activeSyncId = '';
    let activeVoiceId = '';
    let pendingSeek = null;
    let lastProgressSaveAt = 0;
    let userNavigatingUntil = 0;
    let programmaticScroll = false;
    const syncTargets = new Map();

    const storageGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
    const storageSet = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private/restricted storage */ } };
    const storageRemove = (key) => { try { localStorage.removeItem(key); } catch { /* private/restricted storage */ } };
    const voiceEntries = () => Array.isArray(manifest?.voices) && manifest.voices.length
      ? manifest.voices
      : manifest ? [{ id: 'legacy', label: manifest.voice || 'الصوت العربي', providerVoice: manifest.voice || 'legacy' }] : [];
    const activeVoiceEntry = () => voiceEntries().find((voice) => voice.id === activeVoiceId) || voiceEntries()[0] || null;
    const voicePreferenceKey = () => `bareeq-audio-voice-v1:${String(manifest?.provider || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const progressStorageKey = () => manifest?.articleId ? `bareeq-audio-progress-v1:${manifest.articleId}` : '';
    const partAsset = (part, voiceId = activeVoiceId) => part?.audio?.[voiceId] || (typeof part?.src === 'string' ? part : null);
    const partDuration = (part, voiceId = activeVoiceId) => Number(partAsset(part, voiceId)?.durationSeconds || 0);
    const totalVoiceDuration = (voiceId = activeVoiceId) => {
      const declared = Number(voiceEntries().find((voice) => voice.id === voiceId)?.totalDurationSeconds || 0);
      return declared > 0 ? declared : (manifest?.parts || []).reduce((sum, part) => sum + partDuration(part, voiceId), 0);
    };
    const elapsedArticleSeconds = () => {
      if (!audio || !manifest) return 0;
      const previous = manifest.parts.slice(0, partIndex).reduce((sum, part) => sum + partDuration(part), 0);
      const expected = partDuration(manifest.parts[partIndex]);
      const ratio = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.max(0, Math.min(1, audio.currentTime / audio.duration)) : 0;
      return previous + (expected > 0 ? expected * ratio : audio.currentTime);
    };
    const readSavedProgress = () => {
      const key = progressStorageKey();
      if (!key) return null;
      try {
        const saved = JSON.parse(storageGet(key) || 'null');
        if (!audioCore?.isSavedProgressValid(saved, manifest?.parts?.length || 0)) { storageRemove(key); return null; }
        return saved;
      } catch { storageRemove(key); return null; }
    };
    const saveProgress = ({ force = false } = {}) => {
      const key = progressStorageKey();
      if (!key || !audio || !manifest || finished || (partIndex === 0 && audio.currentTime <= 0.05 && audio.paused)) return;
      const now = Date.now();
      if (!force && now - lastProgressSaveAt < 4000) return;
      lastProgressSaveAt = now;
      storageSet(key, JSON.stringify({ voiceId: activeVoiceId, partIndex, time: Number(audio.currentTime.toFixed(2)), updatedAt: now }));
    };
    const clearSavedProgress = () => {
      const key = progressStorageKey();
      if (key) storageRemove(key);
    };

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
      const prefixText = hint.slice(0, Math.min(64, hint.length));
      if (prefixText.length >= 16 && blockText.includes(prefixText)) return 650;
      const shorter = blockText.length < hint.length ? blockText : hint;
      if (shorter.length >= 24 && (blockText.includes(shorter) || hint.includes(shorter))) return 500;
      return 0;
    };

    const buildSyncTargets = () => {
      syncTargets.clear();
      articleContent.querySelectorAll('[data-audio-sync-id]').forEach((element) => {
        element.removeAttribute('data-audio-sync-id');
        element.classList.remove('is-audio-active');
        element.removeAttribute('data-audio-current');
      });
      const entries = [];
      const seen = new Set();
      manifest?.parts?.forEach((part) => part.sync?.forEach((entry) => {
        if (entry?.id && (entry?.match || Number.isInteger(entry?.ordinal)) && !seen.has(entry.id)) {
          seen.add(entry.id);
          entries.push(entry);
        }
      }));
      const blocks = [...articleContent.querySelectorAll('h2,h3,h4,p,li')]
        .filter((element) => element.textContent?.trim())
        .map((element) => ({ element, text: normalizeSyncText(element.textContent) }));
      let cursor = 0;
      for (const entry of entries) {
        if (Number.isInteger(entry.ordinal) && entry.ordinal >= 0 && entry.ordinal < blocks.length) {
          const target = blocks[entry.ordinal].element;
          target.dataset.audioSyncId = entry.id;
          syncTargets.set(entry.id, target);
          cursor = Math.max(cursor, entry.ordinal + 1);
          continue;
        }
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
      if (name === 'listen' && !manifest && !preparingManifest) void prepareAudio();
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

    const formatClock = (seconds) => audioCore?.formatClock(seconds) || '';
    const updateVoiceLabel = () => {
      const voice = activeVoiceEntry();
      if (currentVoice) currentVoice.textContent = voice ? `الصوت: ${voice.label}` : 'الصوت الافتراضي';
    };
    const updateTime = () => {
      if (!audio || !audioTime) return;
      const elapsedSeconds = elapsedArticleSeconds();
      const durationSeconds = totalVoiceDuration();
      const elapsed = formatClock(elapsedSeconds);
      const duration = formatClock(durationSeconds);
      audioTime.textContent = duration ? `${elapsed || '0:00'} / ${duration}` : (elapsed || '0:00');
      if (seekInput) {
        const ratio = durationSeconds > 0 ? Math.max(0, Math.min(1, elapsedSeconds / durationSeconds)) : 0;
        seekInput.value = String(Math.round(ratio * 1000));
        seekInput.setAttribute('aria-valuetext', duration ? `${elapsed || '0:00'} من ${duration}` : (elapsed || '0:00'));
      }
    };
    const clearPlayStartTimer = () => {
      if (playStartTimer) clearTimeout(playStartTimer);
      playStartTimer = 0;
    };
    const markPlaybackStarted = () => {
      awaitingPlaybackStart = false;
      clearPlayStartTimer();
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
      const asset = partAsset(manifest.parts[index]);
      if (!asset?.src) return false;
      clearPlayStartTimer();
      partIndex = index;
      finished = false;
      audio.src = asset.src;
      audio.playbackRate = Number(rateSelect?.value || 1);
      // Do not call load() here. On iPadOS/Android tablets the first play must remain
      // directly tied to the user's tap; audio.play() will load the same-origin MP3 itself.
      updateVoiceLabel();
      updateTime();
      updateStopAvailability();
      return true;
    };

    const exposeNativeFallback = (message = 'يمكنك استخدام مشغّل الجهاز إذا منع المتصفح التشغيل المخصص') => {
      if (nativeFallbackButton) nativeFallbackButton.hidden = false;
      if (audioStatus) audioStatus.textContent = message;
    };

    const handlePlayFailure = (error, { automatic = false } = {}) => {
      awaitingPlaybackStart = false;
      clearPlayStartTimer();
      modes.classList.remove('is-speaking');
      const blocked = error?.name === 'NotAllowedError';
      if (playLabel) playLabel.textContent = automatic ? 'متابعة' : 'إعادة المحاولة';
      if (audioStatus) {
        audioStatus.textContent = blocked
          ? 'منع الجهاز التشغيل التلقائي. اضغط «إعادة المحاولة» أو استخدم مشغّل الجهاز'
          : 'تعذر بدء الصوت. أعد المحاولة أو استخدم مشغّل الجهاز';
      }
      exposeNativeFallback(audioStatus?.textContent || undefined);
    };

    const requestPlay = ({ automatic = false } = {}) => {
      if (!audio) return;
      clearPlayStartTimer();
      awaitingPlaybackStart = true;
      if (audioStatus) audioStatus.textContent = automatic ? 'جارٍ الانتقال إلى المقطع التالي' : 'جارٍ بدء القراءة الصوتية';
      // This call is intentionally synchronous inside the click handler on first play.
      const promise = audio.play();
      playStartTimer = setTimeout(() => {
        if (!awaitingPlaybackStart) return;
        awaitingPlaybackStart = false;
        try { audio.pause(); } catch {}
        if (playLabel) playLabel.textContent = 'إعادة المحاولة';
        exposeNativeFallback('استغرق بدء الصوت وقتًا أطول من المتوقع. أعد المحاولة أو استخدم مشغّل الجهاز');
      }, PLAY_START_TIMEOUT_MS);
      if (promise && typeof promise.catch === 'function') promise.catch((error) => handlePlayFailure(error, { automatic }));
    };

    const stopAudio = () => {
      if (!audio || !manifest) return;
      awaitingPlaybackStart = false;
      clearPlayStartTimer();
      if (!audio.paused) audio.pause();
      finished = false;
      clearActiveSync();
      clearSavedProgress();
      pendingSeek = null;
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

    const isValidManifest = (data) => {
      if (!data || !Array.isArray(data.parts) || !data.parts.length || !data.parts.every((part) => Array.isArray(part?.sync))) return false;
      if (Array.isArray(data.voices) && data.voices.length) {
        const ids = data.voices.map((voice) => voice?.id).filter(Boolean);
        return ids.length === data.voices.length && data.parts.every((part) => ids.every((id) => typeof part?.audio?.[id]?.src === 'string' && part.audio[id].src.endsWith('.mp3') && Number(part.audio[id].durationSeconds) > 0));
      }
      return data.parts.every((part) => typeof part?.src === 'string' && part.src.endsWith('.mp3'));
    };
    const setupVoicePicker = () => {
      const voices = voiceEntries();
      const preferred = storageGet(voicePreferenceKey());
      activeVoiceId = voices.some((voice) => voice.id === preferred) ? preferred : (manifest.defaultVoice || voices[0]?.id || 'legacy');
      if (voiceSelect) {
        voiceSelect.replaceChildren(...voices.map((voice) => {
          const option = document.createElement('option');
          option.value = voice.id;
          option.textContent = voice.description ? `${voice.label} — ${voice.description}` : voice.label;
          return option;
        }));
        voiceSelect.value = activeVoiceId;
        voiceSelect.disabled = voices.length < 2;
      }
      if (voiceField) voiceField.hidden = voices.length < 2;
      if (listenLabel) listenLabel.textContent = voices.length > 1
        ? `${voices.length} أصوات مع تتبّع النص`
        : `${voices[0]?.label || 'صوت عربي'} مع تتبّع النص`;
      updateVoiceLabel();
    };
    const switchVoice = (voiceId) => {
      if (!audio || !manifest || voiceId === activeVoiceId || !voiceEntries().some((voice) => voice.id === voiceId)) return;
      const wasPlaying = !audio.paused;
      const ratio = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.max(0, Math.min(1, audio.currentTime / audio.duration)) : 0;
      saveProgress({ force: true });
      if (wasPlaying) audio.pause();
      activeVoiceId = voiceId;
      storageSet(voicePreferenceKey(), voiceId);
      // Persist the new choice immediately. This covers switching while paused and
      // leaving the page before the new source emits its first timeupdate event.
      saveProgress({ force: true });
      pendingSeek = { ratio };
      if (!setPart(partIndex)) return;
      if (audioStatus) audioStatus.textContent = `تم اختيار ${activeVoiceEntry()?.label || 'الصوت'}`;
      if (wasPlaying) requestPlay({ automatic: false });
    };
    const applyManifest = (data) => {
      if (!isValidManifest(data) || !audio || !playButton) return false;
      manifest = data;
      setupVoicePicker();
      buildSyncTargets();
      const saved = readSavedProgress();
      if (saved && voiceEntries().some((voice) => voice.id === saved.voiceId)) {
        activeVoiceId = saved.voiceId;
        if (voiceSelect) voiceSelect.value = activeVoiceId;
      }
      pendingSeek = saved ? { seconds: saved.time } : null;
      setPart(saved?.partIndex || 0);
      playButton.disabled = false;
      if (stopButton) stopButton.disabled = true;
      if (seekInput) seekInput.disabled = false;
      if (playLabel) playLabel.textContent = saved ? 'متابعة الاستماع' : 'ابدأ الاستماع';
      playButton.setAttribute('aria-label', saved ? 'متابعة الاستماع من الموضع المحفوظ' : 'بدء الاستماع');
      if (audioStatus) audioStatus.textContent = saved ? 'جاهز للمتابعة من موضعك المحفوظ' : 'جاهز للاستماع';
      return true;
    };

    const readInlineManifest = () => {
      if (!inlineManifestNode?.textContent) return null;
      try {
        const parsed = JSON.parse(inlineManifestNode.textContent);
        return isValidManifest(parsed) ? parsed : null;
      } catch { return null; }
    };

    const fetchManifestAttempt = async () => {
      if (!manifestUrl) throw new Error('Missing manifest URL');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
      try {
        const response = await fetch(manifestUrl, { cache: 'force-cache', credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!isValidManifest(data)) throw new Error('Invalid synchronized audio manifest');
        return data;
      } finally { clearTimeout(timeout); }
    };

    async function prepareAudio() {
      if (!audio || !playButton) return false;
      if (manifest) return true;
      if (preparingManifest) return preparingManifest;
      playButton.disabled = true;
      if (stopButton) stopButton.disabled = true;
      if (playLabel) playLabel.textContent = 'تهيئة الصوت…';
      if (audioStatus) audioStatus.textContent = 'جارٍ تهيئة القراءة الصوتية';
      preparingManifest = (async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const data = await fetchManifestAttempt();
            return applyManifest(data);
          } catch {
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
          }
        }
        playButton.disabled = false;
        if (playLabel) playLabel.textContent = 'إعادة التهيئة';
        if (audioStatus) audioStatus.textContent = 'تعذر تهيئة الصوت. اضغط «إعادة التهيئة» للمحاولة مجددًا';
        return false;
      })();
      try { return await preparingManifest; }
      finally { preparingManifest = null; }
    }

    playButton?.addEventListener('click', () => {
      if (!audio || playButton.disabled) return;
      if (!manifest) {
        void prepareAudio();
        return;
      }
      if (finished) setPart(0);
      if (audio.paused) requestPlay({ automatic: false });
      else audio.pause();
    });
    stopButton?.addEventListener('click', stopAudio);
    voiceSelect?.addEventListener('change', () => switchVoice(voiceSelect.value));
    nativeFallbackButton?.addEventListener('click', () => {
      if (!audio || !manifest) return;
      modes.classList.add('use-native-audio');
      nativeFallbackButton.hidden = true;
      audio.controls = true;
      audio.preload = 'metadata';
      if (!audio.src) setPart(partIndex);
      if (audioStatus) audioStatus.textContent = 'مشغّل الجهاز جاهز';
      requestPlay({ automatic: false });
    });
    rateSelect?.addEventListener('change', () => {
      if (audio) audio.playbackRate = Number(rateSelect.value || 1);
    });
    seekInput?.addEventListener('input', () => {
      const duration = totalVoiceDuration();
      const preview = duration * (Number(seekInput.value) / 1000);
      seekInput.setAttribute('aria-valuetext', `${formatClock(preview)} من ${formatClock(duration)}`);
    });
    seekInput?.addEventListener('change', () => {
      if (!audio || !manifest) return;
      const wasPlaying = !audio.paused;
      if (wasPlaying) audio.pause();
      const targetArticleSeconds = totalVoiceDuration() * (Number(seekInput.value) / 1000);
      const resolvedSeek = audioCore?.resolveArticleSeek(manifest.parts.map((part) => partDuration(part)), targetArticleSeconds) || { partIndex: 0, seconds: targetArticleSeconds };
      const targetPart = resolvedSeek.partIndex;
      const remaining = resolvedSeek.seconds;
      if (targetPart !== partIndex) {
        pendingSeek = { seconds: Math.max(0, remaining) };
        setPart(targetPart);
      } else if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const expected = partDuration(manifest.parts[targetPart]);
        const localRatio = expected > 0 ? Math.max(0, Math.min(1, remaining / expected)) : 0;
        try { audio.currentTime = Math.min(audio.duration - 0.05, audio.duration * localRatio); } catch { /* metadata may still be settling */ }
      } else {
        pendingSeek = { seconds: Math.max(0, remaining) };
      }
      finished = false;
      updateTime();
      syncTextToAudio();
      saveProgress({ force: true });
      if (wasPlaying) requestPlay({ automatic: false });
    });
    audio?.addEventListener('loadstart', () => {
      if (!audioStatus || modes.classList.contains('is-speaking')) return;
      audioStatus.textContent = 'جارٍ تحميل الصوت';
    });
    audio?.addEventListener('playing', () => {
      markPlaybackStarted();
      if (audioStatus) audioStatus.textContent = `يعمل — ${activeVoiceEntry()?.label || 'الصوت المختار'}`;
    });
    audio?.addEventListener('play', () => {
      finished = false;
      setPlayingUi(true);
      updateStopAvailability();
      syncTextToAudio();
    });
    audio?.addEventListener('pause', () => {
      awaitingPlaybackStart = false;
      clearPlayStartTimer();
      if (audio.ended) return;
      saveProgress({ force: true });
      setPlayingUi(false);
      updateStopAvailability();
      if (audioStatus && !finished && !modes.classList.contains('use-native-audio')) audioStatus.textContent = 'متوقف مؤقتًا';
    });
    audio?.addEventListener('loadedmetadata', () => {
      if (pendingSeek && Number.isFinite(audio.duration) && audio.duration > 0) {
        const desired = Number.isFinite(pendingSeek.seconds) ? pendingSeek.seconds : audio.duration * Number(pendingSeek.ratio || 0);
        try { audio.currentTime = Math.max(0, Math.min(desired, Math.max(0, audio.duration - 0.05))); } catch { /* metadata may still be settling */ }
        pendingSeek = null;
      }
      updateVoiceLabel();
      updateTime();
      updateStopAvailability();
      syncTextToAudio();
    });
    audio?.addEventListener('timeupdate', () => {
      updateTime();
      updateStopAvailability();
      syncTextToAudio();
      saveProgress();
    });
    audio?.addEventListener('ended', () => {
      awaitingPlaybackStart = false;
      clearPlayStartTimer();
      if (!manifest) return;
      if (partIndex + 1 < manifest.parts.length) {
        setPart(partIndex + 1);
        saveProgress({ force: true });
        requestPlay({ automatic: true });
        return;
      }
      finished = true;
      clearSavedProgress();
      modes.classList.remove('is-speaking');
      if (playLabel) playLabel.textContent = 'استمع من البداية';
      if (playButton) playButton.setAttribute('aria-label', 'إعادة تشغيل القراءة الصوتية');
      if (audioStatus) audioStatus.textContent = 'اكتملت قراءة المقال';
      updateTime();
      updateStopAvailability();
    });
    audio?.addEventListener('error', () => {
      awaitingPlaybackStart = false;
      clearPlayStartTimer();
      modes.classList.remove('is-speaking');
      if (playLabel) playLabel.textContent = 'إعادة المحاولة';
      exposeNativeFallback('تعذر تشغيل هذا المقطع. تحقق من الاتصال ثم أعد المحاولة أو استخدم مشغّل الجهاز');
      saveProgress({ force: true });
      updateStopAvailability();
    });
    addEventListener('pagehide', () => {
      awaitingPlaybackStart = false;
      clearPlayStartTimer();
      saveProgress({ force: true });
      if (audio && !audio.paused) audio.pause();
    });

    // Production builds embed the tiny manifest in HTML, eliminating the manifest fetch
    // that could remain pending on some tablets. Network fetch remains a resilient dev fallback.
    const embeddedManifest = readInlineManifest();
    const listenButton = modes.querySelector('[data-reading-mode="listen"]');
    if (!applyManifest(embeddedManifest) && !listenButton?.disabled) void prepareAudio();
  }

})();
