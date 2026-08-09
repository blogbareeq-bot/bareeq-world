(() => {
  const buttons = [...document.querySelectorAll('[data-filter]')];
  const cards = [...document.querySelectorAll('[data-archive-grid] [data-post-card]')];
  const empty = document.querySelector('[data-filter-empty]');
  buttons.forEach((button) => button.addEventListener('click', () => {
    const filter = button.dataset.filter;
    let visible = 0;
    buttons.forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    cards.forEach((card) => {
      const show = filter === 'all' || card.dataset.category === filter;
      card.hidden = !show;
      if (show) visible += 1;
    });
    if (empty) empty.hidden = visible !== 0;
  }));
})();
