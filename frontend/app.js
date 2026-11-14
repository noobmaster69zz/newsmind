/* NewsMind front end. No framework: one data file, one point-cloud chart, one canvas sky. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const wide = matchMedia('(min-width: 861px)');
  const root = document.documentElement;

  const els = {
    stamp: $('#stamp'), focus: $('#focus'), split: $('#split'), seam: $('#seam'),
    dateline: $('#dateline'), headline: $('#headline'), wire: $('#wire'),
    scopeCompany: $('#scopeCompany'), scopeAll: $('#scopeAll'), tickerClear: $('#tickerClear'),
    chart: $('#chart'), cloud: $('#cloud'), labels: $('#labels'), tip: $('#tip'), chartEmpty: $('#chartEmpty'),
    card: $('#card'), toneText: $('#toneText'), toneScore: $('#toneScore'),
    meterMark: $('#meterMark'), summary: $('#summary'), readLink: $('#readLink'),
  };

  const state = {
    all: [], companies: {}, byTicker: new Map(), mood: new Map(),
    list: [], rows: [], tops: [], lineOffset: 0,
    active: -1, shown: null, scope: 'company', ticker: null,
  };

  const focusOn = () => document.body.dataset.focus === 'on';
  const still = () => reduced.matches || focusOn();

  /* ---------- Formatting ---------- */
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const fmtLong = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
  const toneClass = (label) => 'tone-' + (label || 'unscored');
  const moodLabel = (avg) => (avg == null ? 'unscored' : avg > 0.15 ? 'positive' : avg < -0.15 ? 'negative' : 'neutral');
  const TONE_RGB = { positive: '6,182,212', negative: '224,82,122', neutral: '170,174,182', unscored: '170,174,182' };

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
      buildCloud();
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
    chartStory(true);
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
  const glide = { target: 0, current: 0, raf: 0, last: 0 };
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
    glide.target = y;
    if (!glide.raf) {
      glide.current = els.wire.scrollTop;
      glide.last = performance.now();
      glide.raf = requestAnimationFrame(glideStep);
    }
  }

  function glideStep(now) {
    const dt = clamp(now - glide.last, 0, 400);
    glide.last = now;
    const d = glide.target - glide.current;
    if (Math.abs(d) < 0.5) {
      glide.current = glide.target;
      els.wire.scrollTop = glide.current;
      glide.raf = 0;
      return;
    }
    glide.current += d * (1 - Math.exp(-dt / 110)); // time-based, so the glide feels the same at any refresh rate
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
    if (!still()) {
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
      els.toneText.textContent = `${story.toneLabel[0].toUpperCase()}${story.toneLabel.slice(1)} headline, per FinBERT`;
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

  /* ---------- Chart: the wire as a point cloud ----------
     Every story is a point, coloured by tone. Stories gather around the company
     they name; companies in the same sector sit together. Stories that name no
     tracked company form the thin outer shell. Choosing a story turns the cloud
     to face it and fires links out to its companies and their other stories. */
  const cloud = {
    ctx: els.cloud.getContext('2d'),
    W: 0, H: 0, dpr: 1,
    pts: [], dust: [], centers: new Map(), byId: new Map(),
    sel: null, selTickers: new Set(), hover: null,
    yaw: 0.5, pitch: -0.15, tyaw: 0.5, tpitch: -0.15,
    grow: 0, fire: 1, raf: 0, last: 0,
  };
  const mouse = { x: 0, y: 0, sx: 0, sy: 0, cx: -9999, cy: -9999 };

  // Seeded random numbers, so the cloud has the same shape on every visit.
  function seeded(text) {
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }
  const gauss = (rnd) => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

  function buildCloud() {
    const tickers = Object.keys(state.companies);
    const sectors = [...new Set(tickers.map((t) => state.companies[t].sector))].sort();

    // Sector centres spread evenly over a sphere; companies ring their sector centre.
    const sectorAt = new Map(sectors.map((s, i) => {
      const y = 1 - (2 * (i + 0.5)) / sectors.length;
      const r = Math.sqrt(1 - y * y), a = i * 2.39996;
      return [s, [Math.cos(a) * r * 0.7, y * 0.7, Math.sin(a) * r * 0.7]];
    }));
    for (const s of sectors) {
      const members = tickers.filter((t) => state.companies[t].sector === s).sort();
      const c = sectorAt.get(s);
      const len = Math.hypot(...c);
      const n = c.map((v) => v / len);
      let u = [n[1], -n[0], 0];
      if (Math.hypot(...u) < 0.1) u = [0, n[2], -n[1]];
      const ul = Math.hypot(...u);
      u = u.map((v) => v / ul);
      const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      const turn = seeded(s)() * Math.PI * 2;
      members.forEach((t, i) => {
        const a = turn + (i / members.length) * Math.PI * 2;
        const ring = members.length === 1 ? 0 : 0.14 + members.length * 0.034;
        const pos = c.map((base, k) => base + (u[k] * Math.cos(a) + v[k] * Math.sin(a)) * ring);
        const company = state.companies[t];
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `co ${toneClass(moodLabel(state.mood.get(t)))}`;
        el.dataset.t = t;
        el.setAttribute('aria-pressed', 'false');
        el.setAttribute('aria-label', `${company.name}. Show only ${company.name} stories in the wire`);
        const sym = document.createElement('span');
        sym.className = 'co-sym';
        sym.textContent = t;
        const name = document.createElement('span');
        name.className = 'co-name';
        name.textContent = company.name;
        el.append(sym);
        if (company.name.toUpperCase() !== t) el.append(name);
        els.labels.append(el);
        cloud.centers.set(t, { t, x: pos[0], y: pos[1], z: pos[2], el, sx: 0, sy: 0 });

        // Haze marks where a company sits; busier companies get a denser haze.
        // It takes the colour of the company's average tone, so the cloud doubles as a mood map.
        const rnd = seeded('dust' + t);
        const count = Math.min(460, 110 + state.byTicker.get(t).length * 10);
        const rgb = TONE_RGB[moodLabel(state.mood.get(t))];
        for (let d = 0; d < count; d++) {
          cloud.dust.push({ rgb, x: pos[0] + gauss(rnd) * 0.13, y: pos[1] + gauss(rnd) * 0.13, z: pos[2] + gauss(rnd) * 0.13 });
        }
      });
    }

    for (const s of state.all) {
      const rnd = seeded(s.id);
      const named = s.tickers.filter((t) => cloud.centers.has(t));
      let x, y, z;
      if (named.length) {
        x = y = z = 0;
        for (const t of named) { const c = cloud.centers.get(t); x += c.x; y += c.y; z += c.z; }
        x = x / named.length + gauss(rnd) * 0.07;
        y = y / named.length + gauss(rnd) * 0.07;
        z = z / named.length + gauss(rnd) * 0.07;
      } else {
        const yy = rnd() * 2 - 1, a = rnd() * Math.PI * 2, rr = Math.sqrt(1 - yy * yy), shell = 1.02 + rnd() * 0.1;
        x = Math.cos(a) * rr * shell; y = yy * shell; z = Math.sin(a) * rr * shell;
      }
      const pt = { x, y, z, story: s, named, rgb: TONE_RGB[s.toneLabel || 'unscored'], sx: 0, sy: 0, k: 1, shown: false };
      pt.far = Math.hypot(x, y, z);
      cloud.pts.push(pt);
      cloud.byId.set(s.id, pt);
    }
    for (const d of cloud.dust) d.far = Math.hypot(d.x, d.y, d.z);
    sizeCloud();
  }

  function sizeCloud() {
    cloud.W = els.chart.clientWidth;
    cloud.H = els.chart.clientHeight;
    cloud.dpr = Math.min(window.devicePixelRatio || 1, 2);
    els.cloud.width = Math.round(cloud.W * cloud.dpr);
    els.cloud.height = Math.round(cloud.H * cloud.dpr);
    render(); // resizing a canvas wipes it, so redraw in the same frame to avoid a blank flash
    kick();
  }

  // Point the cloud at the chosen story and mark its companies.
  function chartStory(animate) {
    const story = state.list[state.active];
    const pt = story && cloud.byId.get(story.id);
    if (!pt) return;
    hideTip();
    cloud.sel = pt;
    cloud.selTickers = new Set(pt.named);
    cloud.tyaw = Math.atan2(pt.x, -pt.z);
    cloud.tpitch = clamp(Math.atan2(-pt.y, Math.hypot(pt.x, pt.z)) * 0.8, -0.7, 0.7);
    if (animate) cloud.fire = 0;
    els.chartEmpty.hidden = pt.named.length > 0;
    for (const [t, c] of cloud.centers) {
      c.el.classList.toggle('on', cloud.selTickers.has(t));
      c.el.classList.toggle('filtered', state.ticker === t);
      c.el.setAttribute('aria-pressed', String(state.ticker === t));
    }
    kick();
  }

  const angleGap = (to, from) => {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  function kick() { if (!cloud.raf) { cloud.last = performance.now(); cloud.raf = requestAnimationFrame(frame); } }

  function frame(now) {
    // Everything below is driven by elapsed time, so it runs the same at 30, 60 or 120 frames a second.
    const dt = clamp(now - cloud.last, 0, 400);
    cloud.last = now;
    let busy = false;
    const calm = still();
    const ease = 1 - Math.exp(-dt / 190);

    if (cloud.grow < 1) { cloud.grow = calm ? 1 : Math.min(1, cloud.grow + dt / 1500); busy = true; }
    if (cloud.fire < 1) { cloud.fire = calm ? 1 : Math.min(1, cloud.fire + dt / 950); busy = true; }

    const tilt = wide.matches && !calm;
    const tx = tilt ? mouse.x : 0, ty = tilt ? mouse.y : 0;
    mouse.sx += (tx - mouse.sx) * ease;
    mouse.sy += (ty - mouse.sy) * ease;
    if (Math.abs(tx - mouse.sx) > 0.002 || Math.abs(ty - mouse.sy) > 0.002) busy = true;
    else { mouse.sx = tx; mouse.sy = ty; }
    root.style.setProperty('--mx', mouse.sx.toFixed(3));
    root.style.setProperty('--my', mouse.sy.toFixed(3));

    const goalYaw = cloud.tyaw + mouse.sx * 0.42, goalPitch = cloud.tpitch + mouse.sy * 0.26;
    const dy = angleGap(goalYaw, cloud.yaw), dp = goalPitch - cloud.pitch;
    if (calm || (Math.abs(dy) < 0.0008 && Math.abs(dp) < 0.0008)) {
      cloud.yaw = goalYaw; cloud.pitch = goalPitch;
    } else {
      cloud.yaw += dy * ease; cloud.pitch += dp * ease;
      busy = true;
    }

    render();
    cloud.raf = busy ? requestAnimationFrame(frame) : 0;
  }

  function render() {
    const { ctx, W, H, dpr } = cloud;
    if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cyaw = Math.cos(cloud.yaw), syaw = Math.sin(cloud.yaw);
    const cpit = Math.cos(cloud.pitch), spit = Math.sin(cloud.pitch);
    const S = Math.min(W, H - 20) * 0.47, ox = W / 2, oy = H / 2 - 10, D = 3.4;
    const project = (p) => {
      const x1 = p.x * cyaw + p.z * syaw, z1 = -p.x * syaw + p.z * cyaw;
      const y2 = p.y * cpit - z1 * spit, z2 = p.y * spit + z1 * cpit;
      p.k = D / (D + z2);
      p.sx = ox + x1 * S * p.k;
      p.sy = oy + y2 * S * p.k;
    };

    // The cloud builds outward from its core on first load.
    const reach = cloud.grow * 1.35;
    const sel = cloud.sel, linked = cloud.selTickers.size > 0;
    ctx.globalCompositeOperation = 'lighter';

    if (!focusOn()) {
      let ink = '';
      for (const d of cloud.dust) {
        if (d.far > reach) continue;
        project(d);
        if (d.rgb !== ink) { ink = d.rgb; ctx.fillStyle = `rgb(${ink})`; }
        ctx.globalAlpha = clamp(0.15 + (d.k - 0.76) * 0.75, 0.08, 0.72);
        const s = 1.25 * d.k;
        ctx.fillRect(d.sx, d.sy, s, s);
      }
    }

    for (const c of cloud.centers.values()) project(c);
    for (const pt of cloud.pts) { project(pt); pt.shown = pt.far <= reach; }

    // Links: story -> its companies, then each company -> its other stories.
    if (sel && linked) {
      const a = clamp(cloud.fire * 2, 0, 1), b = clamp(cloud.fire * 2 - 1, 0, 1);
      ctx.lineWidth = 1;
      for (const t of cloud.selTickers) {
        const c = cloud.centers.get(t);
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = `rgb(${sel.rgb})`;
        ctx.beginPath();
        ctx.moveTo(sel.sx, sel.sy);
        ctx.lineTo(sel.sx + (c.sx - sel.sx) * a, sel.sy + (c.sy - sel.sy) * a);
        ctx.stroke();
        if (b > 0) {
          for (const pt of cloud.pts) {
            if (pt === sel || !pt.named.includes(t)) continue;
            ctx.globalAlpha = 0.2;
            ctx.strokeStyle = `rgb(${pt.rgb})`;
            ctx.beginPath();
            ctx.moveTo(c.sx, c.sy);
            ctx.lineTo(c.sx + (pt.sx - c.sx) * b, c.sy + (pt.sy - c.sy) * b);
            ctx.stroke();
          }
        }
      }
    }

    for (const pt of cloud.pts) {
      if (!pt.shown) continue;
      const hot = pt === sel || (linked && pt.named.some((t) => cloud.selTickers.has(t)));
      const base = pt.named.length ? 2.3 : 1.4;
      const r = (base + (hot ? 0.7 : 0)) * pt.k;
      ctx.globalAlpha = hot ? 1 : clamp((linked ? 0.3 : 0.5) + (pt.k - 0.76) * 0.5, 0.16, 0.8);
      ctx.fillStyle = `rgb(${pt.rgb})`;
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    if (sel) {
      const glow = ctx.createRadialGradient(sel.sx, sel.sy, 0, sel.sx, sel.sy, 26);
      glow.addColorStop(0, `rgba(${sel.rgb},0.5)`);
      glow.addColorStop(1, `rgba(${sel.rgb},0)`);
      ctx.globalAlpha = focusOn() ? 0 : 1;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sel.sx, sel.sy, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgb(${sel.rgb})`;
      ctx.beginPath();
      ctx.arc(sel.sx, sel.sy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgb(236,230,220)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sel.sx, sel.sy, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (cloud.hover && cloud.hover !== sel) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgb(236,230,220)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cloud.hover.sx, cloud.hover.sy, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Company labels ride on their cluster. Nearer clusters read stronger.
    const seen = clamp(cloud.grow * 2 - 0.6, 0, 1);
    for (const [t, c] of cloud.centers) {
      const on = cloud.selTickers.has(t) || state.ticker === t;
      // A named company's pill sits just above its cluster so it never covers the story point.
      c.el.style.transform = `translate(${c.sx.toFixed(1)}px, ${(c.sy - (on ? 30 : 0)).toFixed(1)}px) translate(-50%, -50%)`;
      c.el.style.opacity = (seen * (on ? 1 : clamp(0.2 + (c.k - 0.76) * 1.25, 0.16, 0.9))).toFixed(2);
      c.el.style.zIndex = String((on ? 1000 : 0) + Math.round(c.k * 100));
    }
  }

  /* ---------- Chart interaction ---------- */
  function showTip(title, text, x, y) {
    const strong = document.createElement('strong');
    strong.textContent = title;
    const span = document.createElement('span');
    span.textContent = text;
    els.tip.replaceChildren(strong, span);
    els.tip.hidden = false;
    const half = els.tip.offsetWidth / 2 + 8;
    const below = y < els.tip.offsetHeight + 40;
    els.tip.classList.toggle('below', below);
    els.tip.style.left = `${clamp(x, half, Math.max(half, cloud.W - half))}px`;
    els.tip.style.top = `${y + (below ? 22 : -22)}px`;
  }

  function hideTip() { els.tip.hidden = true; }

  function companyTip(t) {
    const company = state.companies[t], c = cloud.centers.get(t);
    const count = state.byTicker.get(t).length, avg = state.mood.get(t);
    showTip(`${company.name}, ${company.sector}`,
      `${count} ${count === 1 ? 'story' : 'stories'} on the wire` +
      (avg == null ? '' : `, average tone ${signed(avg)}`) +
      (state.ticker === t ? '. Select to show every company again.' : '. Select to filter the wire.'),
      c.sx, c.sy);
  }

  function pickCompany(t) {
    state.ticker = state.ticker === t ? null : t;
    applyFilters(state.shown);
    chartStory(false);
  }

  function pickStory(id) {
    if (state.list.some((s) => s.id === id)) {
      goTo(state.list.findIndex((s) => s.id === id), false);
      return;
    }
    state.ticker = null;
    const target = state.all.find((s) => s.id === id);
    if (target && !target.tickers.length) state.scope = 'all';
    applyFilters(id);
  }

  els.labels.addEventListener('click', (e) => { const b = e.target.closest('.co'); if (b) pickCompany(b.dataset.t); });
  els.labels.addEventListener('pointerover', (e) => { const b = e.target.closest('.co'); if (b) companyTip(b.dataset.t); });
  els.labels.addEventListener('pointerout', (e) => { if (e.target.closest('.co')) hideTip(); });
  els.labels.addEventListener('focusin', (e) => { const b = e.target.closest('.co'); if (b) companyTip(b.dataset.t); });
  els.labels.addEventListener('focusout', hideTip);

  function storyUnder(e) {
    const r = els.cloud.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bestD = 121;
    for (const pt of cloud.pts) {
      if (!pt.shown) continue;
      const d = (pt.sx - x) ** 2 + (pt.sy - y) ** 2;
      if (d < bestD) { best = pt; bestD = d; }
    }
    return best;
  }

  els.cloud.addEventListener('pointermove', (e) => {
    const pt = storyUnder(e);
    if (pt === cloud.hover) return;
    cloud.hover = pt;
    els.cloud.style.cursor = pt ? 'pointer' : '';
    if (pt) {
      const s = pt.story;
      showTip(s.headline,
        `${s.source}, ${fmtDay.format(new Date(s.publishedAt))}` + (s.tone == null ? '' : `, tone ${signed(s.tone)}`) +
        (pt === cloud.sel ? '. This is the story on screen.' : '. Select to read it.'),
        pt.sx, pt.sy);
    } else {
      hideTip();
    }
    kick();
  });
  els.cloud.addEventListener('pointerleave', () => { cloud.hover = null; hideTip(); kick(); });
  els.cloud.addEventListener('click', (e) => {
    const pt = storyUnder(e);
    if (pt && pt !== cloud.sel) pickStory(pt.story.id);
  });

  /* ---------- Filters ---------- */
  els.scopeCompany.addEventListener('click', () => { state.scope = 'company'; applyFilters(state.shown); });
  els.scopeAll.addEventListener('click', () => { state.scope = 'all'; applyFilters(state.shown); });
  els.tickerClear.addEventListener('click', () => {
    state.ticker = null;
    applyFilters(state.shown);
    chartStory(false);
  });

  /* ---------- Pointer: cloud tilt and card sheen ---------- */
  window.addEventListener('pointermove', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
    mouse.cx = e.clientX;
    mouse.cy = e.clientY;
    kick();
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
    kick();
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
      const count = clamp(Math.round((w * h) / 34000), 20, 60);
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
        ctx.fillStyle = `rgba(${s.tint},${0.3 + near * 0.6})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r + near * 1.2, 0, Math.PI * 2);
        ctx.fill();
        if (near) {
          ctx.strokeStyle = `rgba(6,182,212,${near * 0.3})`;
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
            ctx.strokeStyle = `rgba(236,230,220,${(1 - d / 118) * 0.08})`;
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
      const run = !document.hidden && !still();
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
      sizeCloud();
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
