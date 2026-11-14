/* NewsMind front end. No framework: one data file, one SVG chart, one canvas sky. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const wide = matchMedia('(min-width: 861px)');
  const root = document.documentElement;

  const els = {
    stamp: $('#stamp'), focus: $('#focus'), split: $('#split'), seam: $('#seam'),
    dateline: $('#dateline'), headline: $('#headline'), wire: $('#wire'),
    scopeCompany: $('#scopeCompany'), scopeAll: $('#scopeAll'), tickerClear: $('#tickerClear'),
    chart: $('#chart'), map: $('#map'), tip: $('#tip'), chartEmpty: $('#chartEmpty'),
    card: $('#card'), toneText: $('#toneText'), toneScore: $('#toneScore'),
    meterMark: $('#meterMark'), summary: $('#summary'), readLink: $('#readLink'),
  };

  const state = {
    all: [], companies: {}, byTicker: new Map(), mood: new Map(),
    list: [], rows: [], tops: [], lineOffset: 0,
    active: -1, shown: null, scope: 'company', ticker: null,
  };

  const focusOn = () => document.body.dataset.focus === 'on';

  /* ---------- Formatting ---------- */
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const fmtLong = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
  const toneClass = (label) => 'tone-' + (label || 'unscored');
  const moodLabel = (avg) => (avg == null ? 'unscored' : avg > 0.15 ? 'positive' : avg < -0.15 ? 'negative' : 'neutral');

  function setTone(el, label) {
    el.classList.remove('tone-positive', 'tone-negative', 'tone-neutral', 'tone-unscored');
    el.classList.add(toneClass(label));
  }

  /* ---------- Load ---------- */
  // Resolves when the webfonts are usable, or after 1.5s so a slow font host never blocks the page.
  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    const wanted = ['800 40px "Bodoni Moda"', 'italic 800 28px "Bodoni Moda"', 'italic 500 17px "Bodoni Moda"',
      '400 16px "Chakra Petch"', '500 16px "Chakra Petch"', '600 16px "Chakra Petch"'];
    const loaded = Promise.all(wanted.map((f) => document.fonts.load(f))).catch(() => {});
    return Promise.race([loaded, new Promise((done) => setTimeout(done, 1500))]);
  }

  async function load() {
    const fonts = fontsReady();
    try {
      const res = await fetch('data/events.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      await fonts;
      root.classList.remove('booting');
      state.all = data.stories;
      state.companies = data.companies;
      for (const s of state.all) {
        for (const t of s.tickers) {
          if (!state.byTicker.has(t)) state.byTicker.set(t, []);
          state.byTicker.get(t).push(s);
        }
      }
      for (const [t, list] of state.byTicker) {
        const scored = list.filter((s) => s.tone != null);
        state.mood.set(t, scored.length ? scored.reduce((a, s) => a + s.tone, 0) / scored.length : null);
      }
      const pulled = new Date(data.generatedAt);
      els.stamp.textContent = `Wire pulled ${fmtDay.format(pulled)}, ${fmtTime.format(pulled)}`;
      els.scopeCompany.textContent = `Company stories (${state.all.filter((s) => s.tickers.length).length})`;
      els.scopeAll.textContent = `Whole wire (${state.all.length})`;
      applyFilters(null);
    } catch (err) {
      root.classList.remove('booting');
      els.dateline.textContent = 'The wire could not be loaded';
      els.headline.textContent = 'Run the export step, then reload this page.';
      els.summary.textContent = 'python -m backend.export_site_data writes frontend/data/events.json.';
      console.error('NewsMind: failed to load data/events.json', err);
    }
  }

  /* ---------- Wire ---------- */
  function applyFilters(keepId) {
    let list = state.all;
    if (state.scope === 'company') list = list.filter((s) => s.tickers.length);
    if (state.ticker) list = list.filter((s) => s.tickers.includes(state.ticker));
    state.list = list;

    els.scopeCompany.setAttribute('aria-pressed', String(state.scope === 'company'));
    els.scopeAll.setAttribute('aria-pressed', String(state.scope === 'all'));
    els.tickerClear.hidden = !state.ticker;
    if (state.ticker) {
      els.tickerClear.textContent = `Only ${state.companies[state.ticker].name}. Show every company`;
    }

    renderWire();
    layoutWire();
    state.active = -1;
    if (!list.length) return;
    const idx = Math.max(0, list.findIndex((s) => s.id === keepId));
    goTo(idx, true);
  }

  function renderWire() {
    const frag = document.createDocumentFragment();
    state.rows = state.list.map((s, i) => {
      const row = document.createElement('div');
      row.className = 'row ' + toneClass(s.toneLabel);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.tabIndex = -1;
      row.dataset.i = i;

      const when = new Date(s.publishedAt);
      const bar = document.createElement('span');
      bar.className = 'row-bar';
      const time = document.createElement('span');
      time.className = 'row-time';
      const hm = document.createElement('span');
      hm.textContent = fmtTime.format(when);
      const dm = document.createElement('span');
      dm.textContent = fmtDay.format(when);
      time.append(hm, dm);

      const body = document.createElement('span');
      const head = document.createElement('span');
      head.className = 'row-head';
      head.textContent = s.headline;
      body.append(head);
      if (s.tickers.length) {
        const tags = document.createElement('span');
        tags.className = 'row-tags';
        tags.textContent = s.tickers.join('  ');
        body.append(tags);
      }

      const score = document.createElement('span');
      score.className = 'row-score';
      score.textContent = s.tone == null ? '' : signed(s.tone);
      score.title = s.tone == null ? '' : `FinBERT tone: ${s.toneLabel}`;

      row.append(bar, time, body, score);
      frag.append(row);
      return row;
    });

    els.wire.replaceChildren(frag);
    if (!state.rows.length) {
      const p = document.createElement('p');
      p.className = 'wire-empty';
      p.textContent = 'No stories here yet. Run the ingest pipeline, then the export step.';
      els.wire.append(p);
    }
  }

  // The reading line sits a little below the top of the wire. Padding lets the
  // first and last rows reach it, so every story can be charted by scrolling.
  function layoutWire() {
    if (wide.matches) {
      const h = els.wire.clientHeight;
      state.lineOffset = Math.max(22, Math.round(h * 0.09));
      els.wire.style.setProperty('--pad-top', `${state.lineOffset - 8}px`);
      els.wire.style.setProperty('--pad-bottom', `${Math.max(24, h - state.lineOffset - 40)}px`);
    } else {
      els.wire.style.removeProperty('--pad-top');
      els.wire.style.removeProperty('--pad-bottom');
    }
    state.tops = state.rows.map((r) => r.offsetTop);
  }

  function rowAtLine() {
    const y = els.wire.scrollTop + state.lineOffset;
    const tops = state.tops;
    let lo = 0, hi = tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid; else hi = mid - 1;
    }
    // Prefer whichever row starts nearest the line, so the charted row is the one in full view.
    if (lo + 1 < tops.length && tops[lo + 1] - y < y - tops[lo]) lo += 1;
    return lo;
  }

  let commitTimer = 0;
  function setActive(idx, now) {
    if (idx !== state.active) {
      const prev = state.rows[state.active];
      if (prev) { prev.setAttribute('aria-selected', 'false'); prev.tabIndex = -1; }
      const row = state.rows[idx];
      if (row) { row.setAttribute('aria-selected', 'true'); row.tabIndex = 0; }
      state.active = idx;
    }
    clearTimeout(commitTimer);
    if (now) commit(); else commitTimer = setTimeout(commit, 130);
  }

  function commit() {
    const story = state.list[state.active];
    if (!story) return;
    // Scrolling has settled: ease the charted row onto the reading line.
    if (wide.matches) scrollWireTo(state.tops[state.active] - state.lineOffset + 8, false);
    if (story.id === state.shown) return;
    state.shown = story.id;
    showStage(story);
    showCard(story);
    drawMap(true);
  }

  function goTo(idx, instant) {
    idx = clamp(idx, 0, state.list.length - 1);
    if (wide.matches) {
      scrollWireTo(state.tops[idx] - state.lineOffset + 8, instant);
      if (instant) setActive(idx, true);
    } else {
      setActive(idx, true);
      if (!instant) window.scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' });
    }
  }

  /* ---------- Inertial scrolling for the wire ---------- */
  const glide = { target: 0, current: 0, raf: 0 };
  const maxScroll = () => els.wire.scrollHeight - els.wire.clientHeight;

  function scrollWireTo(y, instant) {
    y = clamp(y, 0, maxScroll());
    if (instant || reduced.matches) {
      cancelAnimationFrame(glide.raf);
      glide.raf = 0;
      glide.target = glide.current = y;
      els.wire.scrollTop = y;
      return;
    }
    if (!glide.raf) glide.current = els.wire.scrollTop;
    glide.target = y;
    if (!glide.raf) glide.raf = requestAnimationFrame(glideStep);
  }

  function glideStep() {
    const d = glide.target - glide.current;
    if (Math.abs(d) < 0.5) {
      glide.current = glide.target;
      els.wire.scrollTop = glide.current;
      glide.raf = 0;
      return;
    }
    glide.current += d * 0.14;
    els.wire.scrollTop = glide.current;
    glide.raf = requestAnimationFrame(glideStep);
  }

  els.wire.addEventListener('wheel', (e) => {
    if (e.ctrlKey || reduced.matches || !wide.matches) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? els.wire.clientHeight : 1;
    const from = glide.raf ? glide.target : els.wire.scrollTop;
    scrollWireTo(from + e.deltaY * unit, false);
  }, { passive: false });

  els.wire.addEventListener('scroll', () => {
    if (!wide.matches || !state.rows.length) return;
    if (!glide.raf) glide.target = glide.current = els.wire.scrollTop;
    setActive(rowAtLine(), false);
  }, { passive: true });

  els.wire.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) goTo(Number(row.dataset.i), false);
  });

  els.wire.addEventListener('keydown', (e) => {
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 6, PageUp: -6 };
    let idx = null;
    if (e.key in moves) idx = state.active + moves[e.key];
    else if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = state.list.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      const row = e.target.closest('.row');
      if (row) idx = Number(row.dataset.i);
    }
    if (idx == null) return;
    e.preventDefault();
    idx = clamp(idx, 0, state.list.length - 1);
    goTo(idx, true);
    state.rows[idx].focus({ preventScroll: true });
  });

  /* ---------- Stage and card ---------- */
  function showStage(story) {
    els.dateline.textContent = `${story.source}, ${fmtLong.format(new Date(story.publishedAt))}`;
    els.headline.textContent = story.headline;
    fitHeadline();
    if (!reduced.matches && !focusOn()) {
      els.headline.classList.remove('glitch');
      void els.headline.offsetWidth; // restart the animation
      els.headline.classList.add('glitch');
    }
  }

  // Largest type size at which the headline still fits the fixed-height stage.
  function fitHeadline() {
    const h = els.headline;
    if (!wide.matches) { h.style.fontSize = ''; return; }
    const room = h.parentElement.clientHeight - h.offsetTop - 14;
    let lo = 20, hi = 104;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      h.style.fontSize = `${mid}px`;
      if (h.scrollHeight <= room && h.scrollWidth <= h.clientWidth) lo = mid; else hi = mid;
    }
    h.style.fontSize = `${lo}px`;
  }

  function showCard(story) {
    setTone(els.card, story.toneLabel);
    if (story.tone == null) {
      els.toneText.textContent = "This headline hasn't been scored yet.";
      els.toneScore.textContent = '';
      els.meterMark.style.setProperty('--pos', '0.5');
    } else {
      els.toneText.textContent = `FinBERT reads the headline as ${story.toneLabel}`;
      els.toneScore.textContent = signed(story.tone);
      els.meterMark.style.setProperty('--pos', ((story.tone + 1) / 2).toFixed(3));
    }
    const summary = (story.summary || '').trim();
    els.summary.textContent = summary && summary !== story.headline
      ? summary
      : 'The wire carried no summary for this story.';
    if (story.url) {
      els.readLink.href = story.url;
      els.readLink.textContent = `Read the story at ${story.source}`;
      els.readLink.hidden = false;
    } else {
      els.readLink.hidden = true;
    }
  }

  /* ---------- Chart ---------- */
  const map = { nodes: [], edges: [], info: new WeakMap() };

  function mk(name, attrs, parent) {
    const el = document.createElementNS(SVGNS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.append(el);
    return el;
  }

  function place(el, x, y, depth) {
    const node = { el, x, y, depth, px: x, py: y };
    map.nodes.push(node);
    return node;
  }

  function link(a, b, ring, parent) {
    const el = mk('line', { class: `edge edge-${ring}`, pathLength: 1 }, parent);
    map.edges.push({ el, a, b });
  }

  function drawMap(animate) {
    const story = state.list[state.active];
    const W = els.chart.clientWidth, H = els.chart.clientHeight;
    if (!story || !W || !H) return;

    hideTip();
    const svg = els.map;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    svg.classList.toggle('draw', Boolean(animate) && !reduced.matches && !focusOn());
    map.nodes = [];
    map.edges = [];

    const cx = W / 2, cy = H / 2 - 12; // nudged up to leave room for the legend line
    const R = Math.max(110, Math.min(W, H - 24) / 2 - 46);
    const radii = [R * 0.32, R * 0.64, R * 0.97];
    const depth = [5, 11, 19];
    const at = (deg, r) => [cx + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180)];

    const gOrbits = mk('g', {}, svg), gEdges = mk('g', {}, svg), gNodes = mk('g', {}, svg);
    radii.forEach((r, i) => place(mk('circle', { class: `orbit orbit-${i + 1}`, r }, gOrbits), cx, cy, depth[i]));

    const gCore = mk('g', { class: `core ${toneClass(story.toneLabel)}` }, gNodes);
    mk('circle', { class: 'halo', r: 22 }, gCore);
    mk('circle', { class: 'dot', r: 6.5 }, gCore);
    mk('text', { y: 30, 'text-anchor': 'middle' }, gCore).textContent = story.source;
    const core = place(gCore, cx, cy, 0);

    const tickers = story.tickers
      .filter((t) => state.companies[t])
      .sort((a, b) => state.companies[a].sector.localeCompare(state.companies[b].sector) || a.localeCompare(b))
      .slice(0, 8);
    const n = tickers.length;
    els.chartEmpty.hidden = n > 0;

    const spacing = n > 1 ? Math.min(360 / n, 72) : 0;
    const first = n === 1 ? -42 : -90 - (spacing * (n - 1)) / 2;
    const angle = new Map(tickers.map((t, i) => [t, first + i * spacing]));

    const sectors = new Map();
    for (const t of tickers) {
      const s = state.companies[t].sector;
      if (!sectors.has(s)) sectors.set(s, []);
      sectors.get(s).push(t);
    }

    // Boxes a sector label must stay clear of: the core, every company pill and its name.
    const taken = [[cx - 44, cy - 14, cx + 44, cy + 40]];
    for (const t of tickers) {
      const [tx, ty] = at(angle.get(t), radii[1]);
      const half = Math.max(Math.max(48, t.length * 10 + 24), state.companies[t].name.length * 6.6) / 2;
      taken.push([tx - half, ty - 16, tx + half, ty + 38]);
    }
    const overlap = (a, b) =>
      Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

    for (const [sector, members] of sectors) {
      const a = members.reduce((sum, t) => sum + angle.get(t), 0) / members.length;
      const [sx, sy] = at(a, radii[0]);
      const g = mk('g', { class: 'sector' }, gNodes);
      mk('circle', { r: 3.5 }, g);

      // Try four spots around the dot and keep the one that collides least.
      const lw = sector.length * 7.6;
      const spots = [
        { x: 0, y: -11, anchor: 'middle', box: [sx - lw / 2, sy - 26, sx + lw / 2, sy - 6] },
        { x: 11, y: 4.5, anchor: 'start', box: [sx + 9, sy - 9, sx + 11 + lw, sy + 9] },
        { x: -11, y: 4.5, anchor: 'end', box: [sx - 11 - lw, sy - 9, sx - 9, sy + 9] },
        { x: 0, y: 20, anchor: 'middle', box: [sx - lw / 2, sy + 8, sx + lw / 2, sy + 26] },
      ];
      let best = spots[0], bestCost = Infinity;
      for (const spot of spots) {
        let cost = taken.reduce((sum, box) => sum + overlap(spot.box, box), 0);
        if (spot.box[0] < 4 || spot.box[2] > W - 4) cost += 1e6;
        if (cost < bestCost) { best = spot; bestCost = cost; }
      }
      taken.push(best.box);
      const label = mk('text', { x: best.x, y: best.y, 'text-anchor': best.anchor }, g);
      label.textContent = sector;
      const sNode = place(g, sx, sy, depth[0]);
      link(core, sNode, 1, gEdges);

      for (const t of members) {
        const company = state.companies[t];
        const ta = angle.get(t);
        const [tx, ty] = at(ta, radii[1]);
        const others = state.byTicker.get(t).filter((s) => s.id !== story.id);
        const avg = state.mood.get(t);
        const gT = mk('g', {
          class: `ticker ${toneClass(moodLabel(avg))}${state.ticker === t ? ' filtered' : ''}`,
          role: 'button', tabindex: 0,
          'aria-pressed': String(state.ticker === t),
          'aria-label': `${company.name}. Show only ${company.name} stories in the wire`,
        }, gNodes);
        const w = Math.max(48, t.length * 10 + 24);
        mk('rect', { x: -w / 2, y: -14, width: w, height: 28, rx: 14 }, gT);
        mk('text', { class: 'sym', y: 5, 'text-anchor': 'middle' }, gT).textContent = t;
        mk('text', { class: 'name', y: 31, 'text-anchor': 'middle' }, gT).textContent = company.name;
        const tNode = place(gT, tx, ty, depth[1]);
        link(sNode, tNode, 2, gEdges);
        const count = state.byTicker.get(t).length;
        map.info.set(gT, {
          kind: 'ticker', ticker: t, node: tNode,
          title: `${company.name}, ${company.sector}`,
          text: `${count} ${count === 1 ? 'story' : 'stories'} on the wire` +
            (avg == null ? '' : `, average tone ${signed(avg)}`) +
            (state.ticker === t ? '. Select to show every company again.' : '. Select to filter the wire.'),
        });

        const rel = others.slice(0, n === 1 ? 8 : 5);
        const fan = n === 1 ? 105 : Math.min(spacing * 0.78, 90);
        const gap = rel.length > 1 ? Math.min(fan / (rel.length - 1), 15) : 0;
        rel.forEach((other, j) => {
          const [rx, ry] = at(ta + (j - (rel.length - 1) / 2) * gap, radii[2]);
          const gR = mk('g', {
            class: `rel ${toneClass(other.toneLabel)}`, role: 'button', tabindex: 0,
            'aria-label': `Go to story: ${other.headline}`,
          }, gNodes);
          mk('circle', { class: 'hit', r: 13 }, gR);
          mk('circle', { class: 'star', r: 4 }, gR);
          const rNode = place(gR, rx, ry, depth[2]);
          link(tNode, rNode, 3, gEdges);
          map.info.set(gR, {
            kind: 'rel', id: other.id, node: rNode,
            title: other.headline,
            text: `${other.source}, ${fmtDay.format(new Date(other.publishedAt))}` +
              (other.tone == null ? '' : `, tone ${signed(other.tone)}`),
          });
        });
      }
    }
    applyParallax();
  }

  function infoFor(target) {
    const g = target.closest && target.closest('.ticker, .rel');
    return g ? map.info.get(g) : null;
  }

  function showTip(info) {
    const strong = document.createElement('strong');
    strong.textContent = info.title;
    const span = document.createElement('span');
    span.textContent = info.text;
    els.tip.replaceChildren(strong, span);
    els.tip.hidden = false;
    const W = els.chart.clientWidth;
    const half = els.tip.offsetWidth / 2 + 8;
    const below = info.node.py < els.tip.offsetHeight + 40;
    els.tip.classList.toggle('below', below);
    els.tip.style.left = `${clamp(info.node.px, half, Math.max(half, W - half))}px`;
    els.tip.style.top = `${info.node.py + (below ? 24 : -24)}px`;
  }

  function hideTip() { els.tip.hidden = true; }

  function activate(info) {
    if (info.kind === 'ticker') {
      state.ticker = state.ticker === info.ticker ? null : info.ticker;
      const keep = state.shown;
      applyFilters(keep);
      drawMap(false);
    } else {
      if (!state.list.some((s) => s.id === info.id)) {
        state.ticker = null;
        const target = state.all.find((s) => s.id === info.id);
        if (target && !target.tickers.length) state.scope = 'all';
        applyFilters(info.id);
      } else {
        goTo(state.list.findIndex((s) => s.id === info.id), false);
      }
    }
  }

  els.map.addEventListener('pointerover', (e) => { const i = infoFor(e.target); if (i) showTip(i); });
  els.map.addEventListener('pointerout', (e) => { if (infoFor(e.target)) hideTip(); });
  els.map.addEventListener('focusin', (e) => { const i = infoFor(e.target); if (i) showTip(i); });
  els.map.addEventListener('focusout', hideTip);
  els.map.addEventListener('click', (e) => { const i = infoFor(e.target); if (i) activate(i); });
  els.map.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const i = infoFor(e.target);
    if (i) { e.preventDefault(); activate(i); }
  });

  /* ---------- Filters ---------- */
  els.scopeCompany.addEventListener('click', () => { state.scope = 'company'; applyFilters(state.shown); });
  els.scopeAll.addEventListener('click', () => { state.scope = 'all'; applyFilters(state.shown); });
  els.tickerClear.addEventListener('click', () => {
    state.ticker = null;
    applyFilters(state.shown);
    drawMap(false);
  });

  /* ---------- Pointer: chart parallax and card sheen ---------- */
  const mouse = { x: 0, y: 0, sx: 0, sy: 0, cx: -9999, cy: -9999, raf: 0 };
  const parallaxOn = () => wide.matches && !reduced.matches && !focusOn();

  function applyParallax() {
    root.style.setProperty('--mx', mouse.sx.toFixed(3));
    root.style.setProperty('--my', mouse.sy.toFixed(3));
    for (const nd of map.nodes) {
      nd.px = nd.x - mouse.sx * nd.depth;
      nd.py = nd.y - mouse.sy * nd.depth;
      nd.el.setAttribute('transform', `translate(${nd.px.toFixed(1)} ${nd.py.toFixed(1)})`);
    }
    for (const e of map.edges) {
      e.el.setAttribute('x1', e.a.px.toFixed(1));
      e.el.setAttribute('y1', e.a.py.toFixed(1));
      e.el.setAttribute('x2', e.b.px.toFixed(1));
      e.el.setAttribute('y2', e.b.py.toFixed(1));
    }
  }

  function parallaxStep() {
    const tx = parallaxOn() ? mouse.x : 0, ty = parallaxOn() ? mouse.y : 0;
    mouse.sx += (tx - mouse.sx) * 0.09;
    mouse.sy += (ty - mouse.sy) * 0.09;
    const settled = Math.abs(tx - mouse.sx) < 0.002 && Math.abs(ty - mouse.sy) < 0.002;
    if (settled) { mouse.sx = tx; mouse.sy = ty; }
    applyParallax();
    mouse.raf = settled ? 0 : requestAnimationFrame(parallaxStep);
  }

  const kickParallax = () => { if (!mouse.raf) mouse.raf = requestAnimationFrame(parallaxStep); };

  window.addEventListener('pointermove', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
    mouse.cx = e.clientX;
    mouse.cy = e.clientY;
    kickParallax();
    const r = els.card.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      els.card.style.setProperty('--px', `${e.clientX - r.left}px`);
      els.card.style.setProperty('--py', `${e.clientY - r.top}px`);
    }
  }, { passive: true });

  document.addEventListener('pointerleave', () => { mouse.cx = mouse.cy = -9999; });

  /* ---------- Seam: drag or arrow keys to resize the two halves ---------- */
  function setSplit(pct) {
    pct = clamp(pct, 32, 64);
    root.style.setProperty('--split', `${pct}%`);
    els.seam.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  els.seam.addEventListener('pointerdown', (e) => {
    els.seam.setPointerCapture(e.pointerId);
    els.seam.classList.add('dragging');
  });
  els.seam.addEventListener('pointermove', (e) => {
    if (!els.seam.hasPointerCapture(e.pointerId)) return;
    const r = els.split.getBoundingClientRect();
    setSplit(((e.clientX - r.left) / r.width) * 100);
  });
  const endDrag = () => els.seam.classList.remove('dragging');
  els.seam.addEventListener('pointerup', endDrag);
  els.seam.addEventListener('pointercancel', endDrag);
  els.seam.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -2, ArrowRight: 2 }[e.key];
    if (!step) return;
    e.preventDefault();
    setSplit(Number(els.seam.getAttribute('aria-valuenow')) + step);
  });

  /* ---------- Focus mode ---------- */
  function setFocus(on) {
    document.body.dataset.focus = on ? 'on' : 'off';
    els.focus.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('newsmind-focus', on ? 'on' : 'off'); } catch (_) { /* private mode */ }
    kickParallax();
    sky.sync();
  }

  els.focus.addEventListener('click', () => setFocus(!focusOn()));

  /* ---------- Sky: drifting points that link up near the pointer ---------- */
  const sky = (() => {
    const canvas = $('#sky');
    const ctx = canvas.getContext('2d');
    const TINTS = ['236,230,220', '236,230,220', '6,182,212', '224,82,122'];
    let stars = [], w = 0, h = 0, raf = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = clamp(Math.round((w * h) / 24000), 28, 84);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12,
        r: 0.6 + Math.random() * 1.1,
        tint: TINTS[Math.floor(Math.random() * TINTS.length)],
      }));
      draw(false);
    }

    function draw(move) {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        if (move) {
          s.x += s.vx; s.y += s.vy;
          if (s.x < -10) s.x = w + 10; else if (s.x > w + 10) s.x = -10;
          if (s.y < -10) s.y = h + 10; else if (s.y > h + 10) s.y = -10;
        }
        const dc = Math.hypot(s.x - mouse.cx, s.y - mouse.cy);
        const near = dc < 190 ? 1 - dc / 190 : 0;
        ctx.fillStyle = `rgba(${s.tint},${0.38 + near * 0.6})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r + near * 1.2, 0, Math.PI * 2);
        ctx.fill();
        if (near) {
          ctx.strokeStyle = `rgba(6,182,212,${near * 0.32})`;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(mouse.cx, mouse.cy);
          ctx.stroke();
        }
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          const a = stars[i], b = stars[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 118) {
            ctx.strokeStyle = `rgba(236,230,220,${(1 - d / 118) * 0.09})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    }

    function frame() {
      draw(true);
      raf = requestAnimationFrame(frame);
    }

    function sync() {
      const run = !document.hidden && !focusOn() && !reduced.matches;
      if (run && !raf) raf = requestAnimationFrame(frame);
      if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!run && !focusOn()) draw(false);
    }

    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    return { resize, sync };
  })();

  /* ---------- Resize ---------- */
  let resizeRaf = 0;
  const onResize = () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (!state.rows.length) return;
      layoutWire();
      if (wide.matches && state.active >= 0) {
        scrollWireTo(state.tops[state.active] - state.lineOffset + 8, true);
      }
      fitHeadline();
      drawMap(false);
    });
  };
  new ResizeObserver(onResize).observe(els.chart);
  new ResizeObserver(onResize).observe(els.wire);
  wide.addEventListener('change', onResize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(onResize);

  /* ---------- Start ---------- */
  let savedFocus = 'off';
  try { savedFocus = localStorage.getItem('newsmind-focus') || 'off'; } catch (_) { /* private mode */ }
  sky.resize();
  setFocus(savedFocus === 'on');
  load();
})();
