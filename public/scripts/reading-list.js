(() => {
  const KEY = 'bareeq-reading-list-v1';
  const STYLE_ID = 'bareeq-reading-list-style';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.reading-list-link{position:relative;text-decoration:none}.reading-list-count{position:absolute;inset-block-start:-4px;inset-inline-start:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:999px;font-size:11px;line-height:18px;text-align:center;background:var(--teal-700,#087566);color:#fff}.save-reading-button{min-height:44px;border:1px solid var(--line);border-radius:999px;padding:.55rem .85rem;background:var(--surface);color:var(--text);font:inherit;cursor:pointer}.save-reading-button[aria-pressed="true"]{font-weight:700}.saved-reading-page [hidden]{display:none!important}';
    document.head.appendChild(style);
  }
  const read = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } };
  const write = (ids) => { localStorage.setItem(KEY, JSON.stringify([...new Set(ids)])); window.dispatchEvent(new CustomEvent('bareeq:reading-list')); };
  const sync = () => {
    const ids = read();
    document.querySelectorAll('[data-reading-list-count]').forEach(el => { el.textContent = String(ids.length); el.hidden = ids.length === 0; });
    document.querySelectorAll('[data-save-post]').forEach(btn => {
      const id = btn.dataset.postId; const saved = ids.includes(id);
      btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
      const label = btn.querySelector('[data-save-label]'); if (label) label.textContent = saved ? 'محفوظ للقراءة' : 'حفظ للقراءة لاحقًا';
    });
    document.querySelectorAll('[data-saved-card]').forEach(card => { card.hidden = !ids.includes(card.dataset.postId); });
    const empty = document.querySelector('[data-saved-empty]'); if (empty) empty.hidden = ids.length > 0;
  };
  document.addEventListener('click', (event) => {
    const btn = event.target.closest?.('[data-save-post]'); if (!btn) return;
    const id = btn.dataset.postId; if (!id) return;
    const ids = read(); write(ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  });
  window.addEventListener('storage', sync); window.addEventListener('bareeq:reading-list', sync);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true }); else sync();
})();
