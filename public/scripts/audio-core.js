(() => {
  const POSITION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  const formatClock = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  const isSavedProgressValid = (saved, partCount, now = Date.now()) => {
    const updatedAt = Number(saved?.updatedAt);
    const age = Number(now) - updatedAt;
    const time = Number(saved?.time);
    return Boolean(
      saved
      && Number.isInteger(partCount)
      && partCount > 0
      && Number.isFinite(updatedAt)
      && Number.isFinite(age)
      && age >= 0
      && age <= POSITION_RETENTION_MS
      && Number.isInteger(saved.partIndex)
      && saved.partIndex >= 0
      && saved.partIndex < partCount
      && Number.isFinite(time)
      && time >= 0
    );
  };

  const resolveArticleSeek = (durations, targetSeconds) => {
    const safeDurations = durations.map((value) => Math.max(0, Number(value) || 0));
    const total = safeDurations.reduce((sum, value) => sum + value, 0);
    let remaining = Math.max(0, Math.min(Number(targetSeconds) || 0, total));
    let partIndex = 0;
    for (let index = 0; index < safeDurations.length; index += 1) {
      if (remaining <= safeDurations[index] || index === safeDurations.length - 1) {
        partIndex = index;
        break;
      }
      remaining -= safeDurations[index];
    }
    return { partIndex, seconds: remaining, total };
  };

  window.BareeqAudioCore = Object.freeze({
    POSITION_RETENTION_MS,
    formatClock,
    isSavedProgressValid,
    resolveArticleSeek,
  });
})();
