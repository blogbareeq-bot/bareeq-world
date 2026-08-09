(() => {
  document.documentElement.classList.add('js');
  try {
    const saved = localStorage.getItem('bareeq-theme');
    const theme = saved === 'dark' || saved === 'light' ? saved : 'light';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#071421' : '#faf9f6');
  } catch {}
})();
