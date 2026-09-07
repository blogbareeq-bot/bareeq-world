/* ============================================================
   نافذة بريق — Atlas
   Semantic Scene Renderer
   ------------------------------------------------------------
   Story JSON  →  resolve(card, director)  →  Scene module
   A scene module owns its own GEOMETRY, not just its colours.
   Resolution order:  visual → kind → fallback
   No editorial metadata (arc, fingerprint, kind…) is ever
   rendered for the reader.
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- tiny helpers ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const kicker = (c) => `<p class="eyebrow">${esc(c.kicker)}</p>`;
  const title = (c, tag = 'h2') => `<${tag} class="scene__title">${esc(c.title)}</${tag}>`;
  const body = (c) => `<p class="scene__body">${esc(c.body)}</p>`;
  // Split body into editorial beats so scenes can distribute prose spatially
  const beats = (c, n) => {
    const parts = String(c.body).split(/(?<=[.؟!])\s+/).filter(Boolean);
    if (parts.length <= n) return parts;
    const out = [], per = Math.ceil(parts.length / n);
    for (let i = 0; i < parts.length; i += per) out.push(parts.slice(i, i + per).join(' '));
    return out;
  };
  const noMotion = () => global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ============================================================
     1. HOOK — «مدخل سينمائي»
     Geometry: full-bleed dark stage. Type is the subject.
     Visual: an old resistive press vs. a modern hover, drawn as
     two thin silhouettes that resolve as you enter.
     ============================================================ */
  const sceneOverture = {
    tone: 'deep',
    build(c) {
      return `
      <div class="overture">
        <div class="overture__type">
          ${kicker(c)}
          ${title(c, 'h1')}
          <div class="overture__rule" aria-hidden="true"></div>
          ${body(c)}
        </div>
        <figure class="overture__stage" aria-hidden="true">
          <svg viewBox="0 0 420 300" class="ov-svg" preserveAspectRatio="xMidYMid meet">
            <defs>
              <linearGradient id="ovGlass" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="var(--teal)" stop-opacity=".26"/>
                <stop offset="1" stop-color="var(--teal)" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <!-- الماضي: طبقتان تنحنيان تحت الضغط -->
            <g class="ov-past">
              <path d="M40 118 H190" class="ov-line"/>
              <path d="M40 140 H190" class="ov-line ov-line--soft"/>
              <path class="ov-bend" d="M40 118 H100 Q115 132 130 118 H190"/>
              <path d="M115 40 L115 108" class="ov-stylus"/>
              <path d="M108 40 L122 40" class="ov-stylus"/>
              <circle cx="115" cy="122" r="3.4" class="ov-dot"/>
            </g>
            <!-- الحاضر: لمسة تُقرأ من دون تلامس -->
            <g class="ov-now">
              <rect x="232" y="112" width="150" height="9" rx="4.5" fill="url(#ovGlass)"/>
              <path d="M232 121 H382" class="ov-line"/>
              <ellipse cx="307" cy="121" rx="46" ry="13" class="ov-halo"/>
              <ellipse cx="307" cy="121" rx="27" ry="8" class="ov-halo ov-halo--in"/>
              <path d="M307 52 q16 22 16 36 a16 16 0 0 1 -32 0 q0 -14 16 -36Z" class="ov-finger"/>
              <path d="M307 104 v-4" class="ov-gap"/>
            </g>
          </svg>
        </figure>
        <p class="overture__cue" aria-hidden="true"><span></span>انزل تحت الزجاج</p>
      </div>`;
    }
  };

  /* ============================================================
     2. REVEAL / layers — «مقطع عرضي»
     Geometry: sticky exploded cross-section on one flank,
     prose walks past it. Layers light up one by one.
     ============================================================ */
  const sceneCrossSection = {
    tone: 'ivory',
    build(c) {
      const b = beats(c, 3);
      const labels = ['الزجاج الواقي', 'خطوط الاستقبال', 'خطوط الإرسال'];
      return `
      <div class="xsec">
        <figure class="xsec__stage" data-sticky>
          <svg viewBox="0 0 340 300" class="xs-svg" aria-hidden="true">
            <g class="xs-layer" data-layer="0">
              <path d="M40 66 L250 26 L300 52 L90 92 Z" class="xs-plate xs-plate--glass"/>
              <path d="M40 66 L250 26" class="xs-edge"/>
            </g>
            <g class="xs-layer" data-layer="1">
              <path d="M40 150 L250 110 L300 136 L90 176 Z" class="xs-plate"/>
              ${Array.from({ length: 6 }, (_, i) => {
                const t = i / 5, x1 = 40 + 210 * t, y1 = 150 - 40 * t;
                return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${(x1 + 50).toFixed(1)} ${(y1 + 26).toFixed(1)}" class="xs-wire xs-wire--rx" style="--i:${i}"/>`;
              }).join('')}
            </g>
            <g class="xs-layer" data-layer="2">
              <path d="M40 234 L250 194 L300 220 L90 260 Z" class="xs-plate"/>
              ${Array.from({ length: 6 }, (_, i) => {
                const t = i / 5, x1 = 40 + 50 * t, y1 = 234 + 26 * t;
                return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${(x1 + 210).toFixed(1)} ${(y1 - 40).toFixed(1)}" class="xs-wire xs-wire--tx" style="--i:${i}"/>`;
              }).join('')}
            </g>
          </svg>
          <figcaption class="xsec__legend">
            ${labels.map((l, i) => `<span data-legend="${i}"><i></i>${l}</span>`).join('')}
          </figcaption>
        </figure>
        <div class="xsec__prose">
          ${kicker(c)}
          ${title(c)}
          ${b.map((t, i) => `<p class="scene__body xsec__beat" data-beat="${i}">${esc(t)}</p>`).join('')}
        </div>
      </div>`;
    },
    mount(root) {
      const beatEls = [...root.querySelectorAll('[data-beat]')];
      const layers = [...root.querySelectorAll('[data-layer]')];
      const legends = [...root.querySelectorAll('[data-legend]')];
      const set = (i) => {
        layers.forEach((l, k) => l.classList.toggle('is-lit', k <= i));
        legends.forEach((l, k) => l.classList.toggle('is-lit', k === i));
        beatEls.forEach((b, k) => b.classList.toggle('is-focus', k === i));
      };
      set(0);
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) set(+e.target.dataset.beat); });
      }, { rootMargin: '-45% 0px -45% 0px' });
      beatEls.forEach((el) => io.observe(el));
    }
  };

  /* ============================================================
     3. EVIDENCE — «رسم يشرح الفكرة»
     Geometry: annotated diagram at the centre, prose as a
     grounded caption. The definition becomes a drawing.
     ============================================================ */
  const sceneDiagram = {
    tone: 'paper',
    build(c) {
      return `
      <div class="diagram">
        <header class="diagram__head">
          ${kicker(c)}
          ${title(c)}
        </header>
        <figure class="diagram__plate">
          <svg viewBox="0 0 520 260" class="dg-svg" aria-hidden="true">
            <!-- قطبان يفصل بينهما عازل -->
            <g class="dg-plates">
              <rect x="150" y="70" width="220" height="10" rx="5" class="dg-plate dg-plate--tx"/>
              <rect x="150" y="180" width="220" height="10" rx="5" class="dg-plate dg-plate--rx"/>
              ${Array.from({ length: 7 }, (_, i) => `<path d="M${175 + i * 28} 84 V176" class="dg-field" style="--i:${i}"/>`).join('')}
              <rect x="150" y="84" width="220" height="92" class="dg-dielectric"/>
            </g>
            <g class="dg-notes">
              <path d="M150 75 H86" class="dg-lead"/><text x="80" y="79" class="dg-note">إرسال</text>
              <path d="M150 185 H86" class="dg-lead"/><text x="80" y="189" class="dg-note">استقبال</text>
              <path d="M370 130 H434" class="dg-lead"/><text x="440" y="126" class="dg-note dg-note--start">عازل</text>
              <text x="440" y="146" class="dg-note dg-note--start dg-note--dim">(الزجاج)</text>
            </g>
            <text x="260" y="232" class="dg-caption">الشحنة المخزّنة بين القطبين = السعة</text>
          </svg>
        </figure>
        <div class="diagram__prose">${body(c)}</div>
      </div>`;
    }
  };

  /* ============================================================
     4. REVEAL / wave — «تجربة مؤشر»
     Geometry: wide interactive stage, prose demoted to a narrow
     side caption. The reader's own pointer *is* the finger.
     ============================================================ */
  const sceneFieldProbe = {
    tone: 'deep',
    build(c) {
      const COLS = 9, ROWS = 6;
      let nodes = '';
      for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) {
        const x = 40 + col * 55, y = 34 + r * 44;
        nodes += `<circle cx="${x}" cy="${y}" r="4" class="pb-node" data-x="${x}" data-y="${y}"/>`;
      }
      const grid = [
        ...Array.from({ length: COLS }, (_, i) => `<path d="M${40 + i * 55} 20 V${34 + (ROWS - 1) * 44 + 14}" class="pb-line pb-line--tx"/>`),
        ...Array.from({ length: ROWS }, (_, i) => `<path d="M26 ${34 + i * 44} H${40 + (COLS - 1) * 55 + 14}" class="pb-line pb-line--rx"/>`)
      ].join('');
      return `
      <div class="probe">
        <aside class="probe__caption">
          ${kicker(c)}
          ${title(c, 'h2')}
          ${body(c)}
          <p class="probe__hint" data-hint><span class="probe__hint-dot"></span>مرّر إصبعك أو المؤشر فوق الشبكة</p>
        </aside>
        <figure class="probe__stage" data-probe>
          <svg viewBox="0 0 545 290" class="pb-svg" role="img" aria-label="شبكة أقطاب تتغير قراءتها عند اقتراب الإصبع">
            <g class="pb-grid">${grid}</g>
            <g class="pb-nodes">${nodes}</g>
            <circle class="pb-touch" r="46" cx="-999" cy="-999" aria-hidden="true"/>
          </svg>
          <output class="probe__readout" data-readout>
            <span>الاقتران المقاس</span><b data-readout-val>—</b>
          </output>
        </figure>
      </div>`;
    },
    mount(root) {
      const stage = root.querySelector('[data-probe]');
      const svg = stage.querySelector('svg');
      const nodes = [...stage.querySelectorAll('.pb-node')];
      const touch = stage.querySelector('.pb-touch');
      const val = stage.querySelector('[data-readout-val]');
      const hint = stage.querySelector('[data-hint]');
      let raf = 0, px = -999, py = -999, engaged = false;

      const draw = () => {
        raf = 0;
        let min = 100;
        nodes.forEach((n) => {
          const nx = +n.dataset.x, ny = +n.dataset.y;
          const d = Math.hypot(nx - px, ny - py);
          const drop = engaged ? clamp(1 - d / 92, 0, 1) : 0;
          n.style.setProperty('--drop', drop.toFixed(3));
          min = Math.min(min, 100 - drop * 46);
        });
        touch.setAttribute('cx', px); touch.setAttribute('cy', py);
        touch.style.opacity = engaged ? 1 : 0;
        val.textContent = engaged ? Math.round(min) + '٪' : '—';
        val.classList.toggle('is-low', engaged && min < 78);
      };
      const queue = () => { if (!raf) raf = requestAnimationFrame(draw); };
      const toLocal = (e) => {
        const r = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        // uniform scale (preserveAspectRatio meet)
        const s = Math.min(r.width / vb.width, r.height / vb.height);
        const ox = (r.width - vb.width * s) / 2, oy = (r.height - vb.height * s) / 2;
        px = (e.clientX - r.left - ox) / s; py = (e.clientY - r.top - oy) / s;
      };
      const on = (e) => { engaged = true; hint.classList.add('is-done'); toLocal(e); queue(); };
      const off = () => { engaged = false; queue(); };
      stage.addEventListener('pointermove', on);
      stage.addEventListener('pointerdown', on);
      stage.addEventListener('pointerleave', off);
      stage.addEventListener('pointercancel', off);
      stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

      // Keyboard / reduced-motion friendly fallback: a slow scripted sweep
      let demoT = 0, demoRaf = 0;
      const demo = () => {
        demoT += 0.006;
        px = 272 + Math.cos(demoT) * 170; py = 145 + Math.sin(demoT * 1.4) * 78;
        engaged = true; draw();
        demoRaf = requestAnimationFrame(demo);
      };
      const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !hint.classList.contains('is-done') && !noMotion()) {
          if (!demoRaf) demoRaf = requestAnimationFrame(demo);
        } else if (demoRaf) { cancelAnimationFrame(demoRaf); demoRaf = 0; if (!hint.classList.contains('is-done')) off(); }
      }, { threshold: 0.55 });
      io.observe(stage);
      stage.addEventListener('pointerenter', () => { if (demoRaf) { cancelAnimationFrame(demoRaf); demoRaf = 0; } });
      draw();
    }
  };

  /* ============================================================
     5. APPLICATION / contrast — «وجهان متقابلان»
     Geometry: a true diptych split by a hairline. One tap flips
     which side is alive. No decorative motion.
     ============================================================ */
  const sceneDiptych = {
    tone: 'ivory',
    build(c) {
      const b = beats(c, 2);
      const glove = (variant) => `
        <svg viewBox="0 0 200 170" class="dp-svg" aria-hidden="true">
          <path d="M20 132 H180" class="dp-glass"/>
          <path d="M20 140 H180" class="dp-glass dp-glass--soft"/>
          <g class="dp-halo-g">
            <ellipse cx="100" cy="132" rx="${variant === 'on' ? 52 : 18}" ry="${variant === 'on' ? 14 : 5}" class="dp-halo"/>
          </g>
          <path d="M100 34 q20 28 20 46 a20 20 0 0 1 -40 0 q0 -18 20 -46Z" class="dp-finger"/>
          <path d="M74 96 q26 18 52 0 l4 20 q-30 20 -60 0Z" class="dp-fabric"/>
          ${variant === 'on'
            ? `<g class="dp-fibres">${Array.from({ length: 7 }, (_, i) => `<path d="M${80 + i * 7} 112 V126" style="--i:${i}"/>`).join('')}</g>`
            : `<g class="dp-block"><path d="M84 116 H116" /></g>`}
        </svg>`;
      return `
      <div class="diptych">
        <header class="diptych__head">${kicker(c)}${title(c)}</header>
        <div class="diptych__pair" role="group" aria-label="مقارنة بين قماش عازل وألياف موصلة">
          <section class="dp-face" data-face="off">
            <h3>قماش عازل</h3>
            ${glove('off')}
            <p>${esc(b[0] || '')}</p>
            <span class="dp-verdict">لا تُميَّز اللمسة</span>
          </section>
          <span class="diptych__seam" aria-hidden="true"></span>
          <section class="dp-face" data-face="on">
            <h3>ألياف موصلة</h3>
            ${glove('on')}
            <p>${esc(b[1] || '')}</p>
            <span class="dp-verdict dp-verdict--yes">التأثير يصل</span>
          </section>
        </div>
      </div>`;
    },
    mount(root) {
      const faces = [...root.querySelectorAll('.dp-face')];
      const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting) faces.forEach((f, i) => setTimeout(() => f.classList.add('is-in'), i * 220));
      }, { threshold: 0.4 });
      io.observe(root);
    }
  };

  /* ============================================================
     6. REVEAL / constellation — «موقف حي»
     Geometry: a stage the reader operates with two handles;
     prose sits beneath as a single measured line of thought.
     ============================================================ */
  const scenePinch = {
    tone: 'deep',
    build(c) {
      return `
      <div class="pinch">
        <header class="pinch__head">${kicker(c)}${title(c)}</header>
        <figure class="pinch__stage" data-pinch>
          <svg viewBox="0 0 520 250" class="pn-svg" aria-hidden="true">
            <g class="pn-grid">
              ${Array.from({ length: 13 }, (_, i) => `<path d="M${30 + i * 38} 24 V226" />`).join('')}
              ${Array.from({ length: 6 }, (_, i) => `<path d="M30 ${34 + i * 38} H486" />`).join('')}
            </g>
            <g class="pn-blob" data-blob="a"><circle r="34" class="pn-soft"/><circle r="12" class="pn-core"/></g>
            <g class="pn-blob" data-blob="b"><circle r="34" class="pn-soft"/><circle r="12" class="pn-core"/></g>
            <path class="pn-span" data-span/>
          </svg>
          <div class="pinch__handles">
            <button class="pn-handle" type="button" data-handle="a" aria-label="نقطة اللمس الأولى"></button>
            <button class="pn-handle" type="button" data-handle="b" aria-label="نقطة اللمس الثانية"></button>
          </div>
          <output class="pinch__readout" data-pinch-out>نقطتان مستقلتان · المسافة بينهما تتغير</output>
        </figure>
        <p class="scene__body pinch__body">${esc(c.body)}</p>
      </div>`;
    },
    mount(root) {
      const stage = root.querySelector('[data-pinch]');
      const svg = stage.querySelector('svg');
      const span = stage.querySelector('[data-span]');
      const out = stage.querySelector('[data-pinch-out]');
      const pts = { a: { x: 170, y: 125 }, b: { x: 350, y: 125 } };
      const els = { a: stage.querySelector('[data-blob="a"]'), b: stage.querySelector('[data-blob="b"]') };
      const handles = { a: stage.querySelector('[data-handle="a"]'), b: stage.querySelector('[data-handle="b"]') };
      let base = 180;

      const geom = () => {
        const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
        const s = Math.min(r.width / vb.width, r.height / vb.height);
        return { r, s, ox: (r.width - vb.width * s) / 2, oy: (r.height - vb.height * s) / 2 };
      };
      const render = () => {
        const g = geom();
        Object.keys(pts).forEach((k) => {
          els[k].setAttribute('transform', `translate(${pts[k].x} ${pts[k].y})`);
          handles[k].style.insetInlineStart = 'auto';
          handles[k].style.left = (g.ox + pts[k].x * g.s) + 'px';
          handles[k].style.top = (g.oy + pts[k].y * g.s) + 'px';
        });
        span.setAttribute('d', `M${pts.a.x} ${pts.a.y} L${pts.b.x} ${pts.b.y}`);
        const d = Math.hypot(pts.a.x - pts.b.x, pts.a.y - pts.b.y);
        const ratio = d / base;
        out.textContent = ratio > 1.12 ? 'المسافة تتسع — تكبير' : ratio < 0.88 ? 'المسافة تضيق — تصغير' : 'نقطتان مستقلتان · المسافة بينهما تتغير';
        stage.style.setProperty('--zoom', clamp(ratio, .8, 1.25).toFixed(3));
      };
      const drag = (key) => (ev) => {
        ev.preventDefault();
        const el = handles[key];
        el.setPointerCapture(ev.pointerId);
        const move = (e) => {
          const g = geom();
          pts[key].x = clamp((e.clientX - g.r.left - g.ox) / g.s, 40, 480);
          pts[key].y = clamp((e.clientY - g.r.top - g.oy) / g.s, 34, 216);
          render();
        };
        const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
      };
      Object.keys(handles).forEach((k) => {
        handles[k].addEventListener('pointerdown', drag(k));
        handles[k].addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 24 : 10;
          const map = { ArrowRight: [-step, 0], ArrowLeft: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          if (!map[e.key]) return;
          e.preventDefault();
          pts[k].x = clamp(pts[k].x + map[e.key][0], 40, 480);
          pts[k].y = clamp(pts[k].y + map[e.key][1], 34, 216);
          render();
        });
      });
      new ResizeObserver(render).observe(stage);
      render();
    }
  };

  /* ============================================================
     7. EXPERIMENT — «مختبر صغير»
     Geometry: control on one side, live plate on the other,
     prose as a lab note strip underneath.
     ============================================================ */
  const sceneLab = {
    tone: 'ivory',
    build(c) {
      return `
      <div class="lab">
        <div class="lab__panel">
          ${kicker(c)}
          ${title(c)}
          <label class="lab__control">
            <span>كمية الرطوبة على الزجاج</span>
            <input type="range" min="0" max="100" value="0" step="1" data-wet aria-describedby="lab-state" />
            <output id="lab-state" data-wet-state>زجاج جاف — الإشارة نظيفة</output>
          </label>
          <p class="scene__body lab__note">${esc(c.body)}</p>
        </div>
        <figure class="lab__plate" data-plate>
          <svg viewBox="0 0 320 300" class="lb-svg" aria-hidden="true">
            <rect x="24" y="20" width="272" height="260" rx="18" class="lb-glass"/>
            <g class="lb-signal">
              ${Array.from({ length: 8 }, (_, i) => `<path class="lb-trace" style="--i:${i}" d="M40 ${44 + i * 30} H280"/>`).join('')}
            </g>
            <g class="lb-drops" data-drops></g>
            <g class="lb-ghosts" data-ghosts></g>
          </svg>
        </figure>
      </div>`;
    },
    mount(root) {
      const input = root.querySelector('[data-wet]');
      const state = root.querySelector('[data-wet-state]');
      const drops = root.querySelector('[data-drops]');
      const ghosts = root.querySelector('[data-ghosts]');
      const plate = root.querySelector('[data-plate]');
      const seeds = Array.from({ length: 16 }, (_, i) => ({
        x: 48 + ((i * 97) % 224), y: 40 + ((i * 61) % 224), r: 5 + ((i * 13) % 11)
      }));
      const paint = () => {
        const v = +input.value / 100;
        const n = Math.round(v * seeds.length);
        drops.innerHTML = seeds.slice(0, n).map((s, i) => `<circle cx="${s.x}" cy="${s.y}" r="${(s.r * (0.6 + v * 0.7)).toFixed(1)}" class="lb-drop" style="--i:${i}"/>`).join('');
        const gn = Math.round(clamp((v - 0.42) / 0.58, 0, 1) * 5);
        ghosts.innerHTML = seeds.slice(2, 2 + gn).map((s, i) => `<g class="lb-ghost" style="--i:${i}"><circle cx="${s.x}" cy="${s.y}" r="15"/><path d="M${s.x - 9} ${s.y} H${s.x + 9}M${s.x} ${s.y - 9} V${s.y + 9}"/></g>`).join('');
        plate.style.setProperty('--noise', v.toFixed(2));
        state.textContent = v === 0 ? 'زجاج جاف — الإشارة نظيفة'
          : v < 0.45 ? 'رطوبة خفيفة — الإشارة ما زالت مقروءة'
          : v < 0.8 ? 'الماء يغيّر البيئة العازلة حول الأقطاب'
          : 'نمط يشبه اللمس — لمسات غير مقصودة';
        state.classList.toggle('is-warn', v >= 0.45);
      };
      input.addEventListener('input', paint);
      paint();
    }
  };

  /* ============================================================
     8. REVEAL / horizon — «مشهد صامت»
     Geometry: maximum negative space. A single measured
     statement, and one honest little instrument that refuses
     to move no matter how hard you press.
     ============================================================ */
  const sceneQuiet = {
    tone: 'paper',
    build(c) {
      const b = beats(c, 2);
      return `
      <div class="quiet">
        <div class="quiet__lede">
          ${kicker(c)}
          ${title(c)}
        </div>
        <figure class="quiet__meter" data-press>
          <div class="qt-track">
            <label class="sr" for="qt-force">قوة الضغط</label>
            <input id="qt-force" type="range" min="0" max="100" value="18" data-force />
            <div class="qt-bar" aria-hidden="true"><i data-force-fill></i></div>
            <div class="qt-scale" aria-hidden="true"><span>لمسة خفيفة</span><span>ضغط شديد</span></div>
          </div>
          <div class="qt-answers">
            <div class="qt-answer"><small>سؤال الشاشة</small><b>أين الإصبع؟</b><em data-where>٣١٤ ، ٢٠٨</em></div>
            <div class="qt-answer qt-answer--flat"><small>ما لا تقيسه</small><b>كم يضغط؟</b><em data-force-out>الإشارة نفسها</em></div>
          </div>
        </figure>
        <div class="quiet__prose">${b.map((t) => `<p class="scene__body">${esc(t)}</p>`).join('')}</div>
      </div>`;
    },
    mount(root) {
      const input = root.querySelector('[data-force]');
      const fill = root.querySelector('[data-force-fill]');
      const out = root.querySelector('[data-force-out]');
      const paint = () => {
        fill.style.setProperty('--v', input.value + '%');
        out.textContent = 'الإشارة نفسها';
        out.classList.toggle('is-pulse', +input.value > 60);
      };
      input.addEventListener('input', paint);
      paint();
    }
  };

  /* ============================================================
     9. TAKEAWAY — «الخاتمة»
     Geometry: the whole mechanism compressed into one chain of
     three, then the window closes. This must not read as
     «card 9 of 9».
     ============================================================ */
  const sceneClosing = {
    tone: 'deep',
    build(c, ctx) {
      const chain = [
        { n: 'شبكة', t: 'أقطاب تخلق مجالات كهربائية صغيرة' },
        { n: 'إصبع', t: 'يخفض الاقتران عند نقاط معينة' },
        { n: 'شريحة', t: 'تقيس التغير وتحسب الإحداثيات' }
      ];
      return `
      <div class="closing">
        <div class="closing__chain" aria-hidden="true">
          ${chain.map((s, i) => `
            <div class="cl-step" style="--i:${i}">
              <svg viewBox="0 0 90 90" class="cl-ico cl-ico--${i}">
                ${i === 0 ? `${Array.from({ length: 4 }, (_, k) => `<path d="M${18 + k * 18} 16 V74"/>`).join('')}${Array.from({ length: 4 }, (_, k) => `<path d="M16 ${18 + k * 18} H74"/>`).join('')}`
                : i === 1 ? `<path d="M45 12 q16 26 16 40 a16 16 0 0 1 -32 0 q0 -14 16 -40Z"/><ellipse cx="45" cy="70" rx="26" ry="7"/>`
                : `<rect x="22" y="22" width="46" height="46" rx="8"/><path d="M45 34 v22M34 45 h22"/>`}
              </svg>
              <b>${s.n}</b><span>${s.t}</span>
              ${i < 2 ? '<i class="cl-arrow"></i>' : ''}
            </div>`).join('')}
        </div>
        <div class="closing__word">
          ${kicker(c)}
          ${title(c)}
          ${body(c)}
        </div>
        <footer class="closing__foot">
          <a class="closing__cta" href="${esc(ctx.articlePath)}">اقرأ المقال الكامل</a>
          <p class="closing__sign"><span aria-hidden="true">◆</span> بريق — نافذتك إلى المعرفة</p>
        </footer>
      </div>`;
    },
    mount(root) {
      const steps = [...root.querySelectorAll('.cl-step')];
      const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting) steps.forEach((s, i) => setTimeout(() => s.classList.add('is-in'), i * 260));
      }, { threshold: 0.35 });
      io.observe(root.querySelector('.closing__chain'));
    }
  };

  /* ---------- generic safety net for unknown kinds ---------- */
  const sceneStatement = {
    tone: 'ivory',
    build(c) {
      return `<div class="statement">${kicker(c)}${title(c)}${body(c)}</div>`;
    }
  };

  /* ============================================================
     RESOLVER — the only place that maps semantics → geometry.
     Adding an article = adding entries here, never a new page.
     ============================================================ */
  const BY_VISUAL = {
    field: sceneOverture,
    layers: sceneCrossSection,
    rings: sceneDiagram,
    wave: sceneFieldProbe,
    contrast: sceneDiptych,
    constellation: scenePinch,
    pulse: sceneLab,
    horizon: sceneQuiet,
    seal: sceneClosing
  };
  const BY_KIND = {
    hook: sceneOverture,
    reveal: sceneCrossSection,
    evidence: sceneDiagram,
    application: sceneDiptych,
    contrast: sceneDiptych,
    experiment: sceneLab,
    example: sceneDiagram,
    question: sceneQuiet,
    myth: sceneDiptych,
    reflection: sceneQuiet,
    takeaway: sceneClosing
  };

  // Short labels for the depth gauge — derived from the kicker,
  // never from internal metadata.
  function resolve(card) {
    return BY_VISUAL[card.visual] || BY_KIND[card.kind] || sceneStatement;
  }

  global.BareeqScenes = { resolve, helpers: { esc, beats, clamp, noMotion } };
})(window);
