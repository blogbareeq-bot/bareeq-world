(() => {
  const input = document.querySelector('[data-search-input]');
  const results = document.querySelector('[data-search-results]');
  const count = document.querySelector('[data-search-count]');
  const node = document.getElementById('search-index');
  if (!(input instanceof HTMLInputElement) || !results || !count || !node) return;
  const data = JSON.parse(node.textContent || '[]');
  const normalize = (value) => value.toLowerCase().normalize('NFKD').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ًٌٍَُِّْـ]/g, '');
  const render = () => {
    const query = normalize(input.value.trim());
    results.replaceChildren();
    const url = new URL(location.href);
    if (input.value.trim()) url.searchParams.set('q', input.value.trim()); else url.searchParams.delete('q');
    history.replaceState(null, '', url);
    if (!query) { count.textContent = 'ابدأ بالكتابة لعرض النتائج.'; return; }
    const matched = data.filter((item) => normalize(`${item.title} ${item.description} ${item.category} ${(item.tags || []).join(' ')}`).includes(query));
    count.textContent = matched.length ? `${new Intl.NumberFormat('ar-SA').format(matched.length)} نتيجة` : 'لم نجد نتيجة مطابقة. جرّب كلمة أقصر أو تصفح الأقسام.';
    matched.forEach((item) => {
      const link = document.createElement('a');
      link.className = 'search-result-card';
      link.href = item.url;
      const category = document.createElement('span'); category.textContent = item.category;
      const title = document.createElement('strong'); title.textContent = item.title;
      const description = document.createElement('p'); description.textContent = item.description;
      link.append(category, title, description); results.append(link);
    });
  };
  input.addEventListener('input', render);
  input.value = new URL(location.href).searchParams.get('q') || '';
  render();
  input.focus();
})();
