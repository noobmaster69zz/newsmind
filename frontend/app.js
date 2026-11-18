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
    all: [], companies: {}, market: null, briefs: {}, prices: {}, query: '', cutoff: Infinity, cardText: '', byTicker: new Map(), mood: new Map(),
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
  const ARROW = { up: '\u25B2', down: '\u25BC', mixed: '\u25C6' };
  const DIR_RGB = { up: '6,182,212', down: '224,82,122', mixed: '170,174,182' };
  const MARK = { right: '\u2713', wrong: '\u2717', flat: '\u2013', early: '\u2026', unscored: '' };
  const VERDICT = { right: 'So far: right.', wrong: 'So far: wrong.', flat: 'So far: too close to call.' };

  // Plain-words account of how one call has held up against the price since the story.
  function checkText(ticker, check) {
    if (!check || check.status === 'unscored') return '';
    if (check.status === 'early') return 'Too early to check: the market has not traded since this story.';
    const span = check.days === 1 ? '1 trading day' : `${check.days} trading days`;
    return `Since the story ${ticker} is ${signed(check.stock)}% and the S&P 500 ${signed(check.market)}% over ${span}. ${VERDICT[check.status]}`;
  }

  // The same call judged at fixed horizons, so one story's result can be compared with another's.
  function windowText(check) {
    if (!check || !check.d1) return '';
    const line = (label, w) => (w.status === 'early' ? `${label}: not due yet.`
      : w.status === 'unscored' ? `${label}: not scored.`
      : `${label}: ${w.excess >= 0 ? 'beat' : 'trailed'} the S&P 500 by ${Math.abs(w.excess).toFixed(2)} points, ${
        { right: 'right', wrong: 'wrong', flat: 'too close to call' }[w.status]}.`);
    return `${line('After 1 trading day', check.d1)} ${line('After 5 trading days', check.d5)}`;
  }

  function showScore(card) {
    const el = $('#score');
    if (!card || !(card.right + card.wrong + card.flat)) { el.textContent = "Claude's calls have not been checked against prices yet."; return; }
    const text = `Claude's calls so far: ${card.right} right, ${card.wrong} wrong, ${card.flat} too close to call.`;
    el.textContent = `${text} Not advice.`;
    const d1 = card.d1 ? ` On a fixed 1-day window: ${card.d1.right} right, ${card.d1.wrong} wrong. On 5 days: ${card.d5.right} right, ${card.d5.wrong} wrong, ${card.d5.early} not due yet.` : '';
    $('#introScore').textContent = `${text} Another ${card.early} are too early to check.${d1}`;
  }

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
      state.market = data.market || null;
      state.briefs = data.briefs || {};
      state.prices = data.prices || {};
      showScore(data.scorecard);
      for (const s of state.all) {
        s.time = Date.parse(s.publishedAt);
        for (const t of s.tickers) {
          if (!state.byTicker.has(t)) state.byTicker.set(t, []);
          state.byTicker.get(t).push(s);
        }
      }
      for (const [t, list] of state.byTicker) {
        const scored = list.filter((s) => s.tone != null);
        state.mood.set(t, scored.length ? scored.reduce((a, s) => a + s.tone, 0) / scored.length : null);
      }
      state.pulled = new Date(data.generatedAt);
      const showAge = () => {
        const mins = Math.max(0, Math.round((Date.now() - state.pulled) / 60000));
        const age = mins < 60 ? `${Math.max(1, mins)} min ago` : mins < 2880 ? `${Math.round(mins / 60)} hours ago` : `${Math.round(mins / 1440)} days ago`;
        els.stamp.textContent = `Updated ${age}`;
      };
      showAge();
      setInterval(showAge, 60000);
      els.stamp.title = 'New stories arrive about every two hours. Right and wrong counts move once a trading day, after the US market closes.';
      watchForUpdates(showAge);
      els.scopeCompany.textContent = `Company stories (${state.all.filter((s) => s.tickers.length).length})`;
      els.scopeAll.textContent = `Whole wire (${state.all.length})`;
      buildCloud();
      blip.ready();
      setUpTime();
      greet();
      applyFilters(null);
    } catch (err) {
      root.classList.remove('booting');
      els.dateline.textContent = 'The wire could not be loaded';
      els.headline.textContent = 'Run the export step, then reload this page.';
      els.summary.textContent = 'python -m backend.export_site_data writes frontend/data/events.json.';
      console.error('NewsMind: failed to load data/events.json', err);
    }
  }

  /* ---------- Auto update ----------
     The pipeline publishes a new snapshot about every two hours. The page checks for one
     every five minutes and offers to load it, so a long-open tab never goes stale. */
  // A newer snapshot carries re-checked calls. Swap them in where they are shown, without a reload:
  // the scorecard, the marks on the company chips and the profile reasoning all read from state.
  async function applyNewChecks(showAge) {
    let data;
    try {
      const r = await fetch('data/events.json', { cache: 'no-cache' });
      if (!r.ok) return;
      data = await r.json();
    } catch (_) { return; }
    const fresh = new Map(data.stories.map((st) => [st.id, st]));
    for (const st of state.all) {
      const next = fresh.get(st.id);
      if (next && next.impact) st.impact = next.impact;
    }
    showScore(data.scorecard);
    state.pulled = new Date(data.generatedAt);
    showAge();
    const story = state.list[state.active];
    if (story) showReads(story);
    const added = data.stories.filter((st) => !state.all.some((old) => old.id === st.id)).length;
    if (added) {
      $('#freshText').textContent = `${added} new ${added === 1 ? 'story has' : 'stories have'} arrived.`;
      $('#fresh').hidden = false;
    }
  }

  function watchForUpdates(showAge) {
    const url = 'data/events.json';
    let seen = null;
    const stamp = async () => {
      try {
        const r = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
        return r.headers.get('etag') || r.headers.get('last-modified');
      } catch (_) { return null; }
    };
    const check = async () => {
      const now = await stamp();
      if (!now) return;
      if (seen && now !== seen) applyNewChecks(showAge);
      seen = now;
    };
    check();
    setInterval(() => { if (!document.hidden) check(); }, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    $('#freshLoad').addEventListener('click', () => location.reload());
  }

  /* ---------- Wire ---------- */
  function applyFilters(keepId) {
    let list = state.all;
    // A search looks across the whole wire, not just stories that name a company.
    if (state.scope === 'company' && !state.query) list = list.filter((s) => s.tickers.length);
    if (state.ticker) list = list.filter((s) => s.tickers.includes(state.ticker));
    if (state.cutoff < Infinity) list = list.filter((s) => s.time <= state.cutoff);
    if (state.query) {
      const q = state.query;
      list = list.filter((s) => s.headline.toLowerCase().includes(q) ||
        s.tickers.some((t) => t.toLowerCase() === q || state.companies[t].name.toLowerCase().includes(q)));
    }
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
      p.textContent = state.query ? `No stories match "${state.query}". Try a company name, a ticker or a word from a headline.`
        : 'No stories here yet. Run the ingest pipeline, then the export step.';
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
    // Claude's one-line read replaces the wire's own summary when there is one.
    const wire = (story.summary || '').trim();
    state.cardText = story.impact ? story.impact.summary
      : wire && wire !== story.headline ? wire : 'The wire carried no summary for this story.';
    els.summary.textContent = state.cardText;
    showReads(story);
    if (story.url) {
      els.readLink.href = story.url;
      els.readLink.textContent = `Read the story at ${story.source}`;
      els.readLink.hidden = false;
    } else {
      els.readLink.hidden = true;
    }
  }

  // One chip per company Claude expects the story to move. Pointing at a chip shows its reason.
  function showReads(story) {
    const list = $('#readsList');
    list.replaceChildren();
    if (!story.impact) { list.textContent = "Claude hasn't read this story yet."; return; }
    if (!story.impact.effects.length) { list.textContent = 'No clear effect on a tracked company.'; return; }
    for (const e of story.impact.effects) {
      const company = state.companies[e.ticker];
      if (!company) continue;
      const named = story.tickers.includes(e.ticker);
      const reason = `${company.name}, likely ${e.direction}, ${e.confidence} confidence. ${e.reason} ${checkText(e.ticker, e.check)}`.trim();
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `read-chip dir-${e.direction}${named ? '' : ' unnamed'}`;
      chip.textContent = `${e.ticker} ${ARROW[e.direction]} ${MARK[(e.check || {}).status || 'unscored']}`.trim();
      chip.setAttribute('aria-label', `${named ? 'Named in the story' : 'Not named in the story'}. ${reason} Select for the price chart.`);
      const show = () => { els.summary.textContent = reason; };
      const hide = () => { els.summary.textContent = state.cardText; };
      chip.addEventListener('pointerenter', show);
      chip.addEventListener('focus', show);
      chip.addEventListener('pointerleave', hide);
      chip.addEventListener('blur', hide);
      chip.addEventListener('click', () => blip.company(e.ticker, e));
      list.append(chip);
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
    sel: null, selTickers: new Set(), selEffects: new Map(), hover: null,
    yaw: 0.5, pitch: -0.15, tyaw: 0.5, tpitch: -0.15,
    dyaw: 0, dpitch: 0, zoom: 1, view: 'story', hoverT: null, cutoff: Infinity, sectors: [], pairs: [],
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
        const dir = document.createElement('span');
        dir.className = 'co-dir';
        el.append(dir);
        cloud.centers.set(t, { t, x: pos[0], y: pos[1], z: pos[2], el, dir, sx: 0, sy: 0 });

        // Haze marks where a company sits; busier companies get a denser haze.
        // It takes the colour of the company's average tone, so the cloud doubles as a mood map.
        const rnd = seeded('dust' + t);
        const count = Math.min(460, 110 + (state.byTicker.get(t) || []).length * 10);
        const rgb = TONE_RGB[moodLabel(state.mood.get(t))];
        for (let d = 0; d < count; d++) {
          cloud.dust.push({ rgb, x: pos[0] + gauss(rnd) * 0.13, y: pos[1] + gauss(rnd) * 0.13, z: pos[2] + gauss(rnd) * 0.13 });
        }
      });
    }

    cloud.sectors = sectors.map((name) => {
      const c = sectorAt.get(name);
      return { name, x: c[0], y: c[1], z: c[2], sx: 0, sy: 0, k: 1,
        members: tickers.filter((t) => state.companies[t].sector === name).map((t) => cloud.centers.get(t)) };
    });
    // Two companies are related when one story names or is expected to move both.
    const pairs = new Map();
    for (const st of state.all) {
      const set = [...new Set(st.tickers.concat(((st.impact || {}).effects || []).map((e) => e.ticker)))]
        .filter((t) => cloud.centers.has(t)).sort();
      for (let i = 0; i < set.length; i++) {
        for (let j = i + 1; j < set.length; j++) {
          const key = `${set[i]}|${set[j]}`;
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      }
    }
    cloud.pairs = [...pairs].map(([key, n]) => {
      const [a, b] = key.split('|');
      return { a: cloud.centers.get(a), b: cloud.centers.get(b), n };
    });

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
      pt.time = s.time;
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
    if (animate) { cloud.fire = 0; cloud.dyaw = 0; cloud.dpitch = 0; }
    // Companies Claude expects the story to move, including ones it never names.
    const effects = (story.impact && story.impact.effects) || [];
    cloud.selEffects = new Map(effects.filter((e) => cloud.centers.has(e.ticker)).map((e) => [e.ticker, e]));
    els.chartEmpty.hidden = pt.named.length > 0 || cloud.selEffects.size > 0;
    for (const [t, c] of cloud.centers) {
      c.el.classList.toggle('on', cloud.selTickers.has(t));
      c.el.classList.toggle('filtered', state.ticker === t);
      c.el.setAttribute('aria-pressed', String(state.ticker === t));
      const effect = cloud.selEffects.get(t);
      c.el.classList.toggle('hit', Boolean(effect) && !cloud.selTickers.has(t));
      c.el.classList.remove('dir-up', 'dir-down', 'dir-mixed');
      if (effect) c.el.classList.add(`dir-${effect.direction}`);
      c.dir.textContent = effect ? ARROW[effect.direction] : '';
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

    const goalYaw = cloud.tyaw + cloud.dyaw + mouse.sx * 0.42;
    const goalPitch = clamp(cloud.tpitch + cloud.dpitch, -1.2, 1.2) + mouse.sy * 0.26;
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
    const S = Math.min(W, H - 20) * 0.47 * cloud.zoom, ox = W / 2, oy = H / 2 - 10, D = 3.4;
    const stories = cloud.view === 'story';
    const project = (p) => {
      const x1 = p.x * cyaw + p.z * syaw, z1 = -p.x * syaw + p.z * cyaw;
      const y2 = p.y * cpit - z1 * spit, z2 = p.y * spit + z1 * cpit;
      p.k = D / (D + z2);
      p.sx = ox + x1 * S * p.k;
      p.sy = oy + y2 * S * p.k;
    };

    // The cloud builds outward from its core on first load.
    const reach = cloud.grow * 1.35;
    const sel = stories ? cloud.sel : null, linked = stories && cloud.selTickers.size > 0;
    const lit = cloud.hoverT;
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
    for (const sector of cloud.sectors) project(sector);
    for (const pt of cloud.pts) { project(pt); pt.shown = stories && pt.far <= reach && pt.time <= cloud.cutoff; }

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

    // Dashed links: companies Claude expects to be affected that the story does not name.
    if (sel && cloud.selEffects.size) {
      const a = clamp(cloud.fire * 2, 0, 1);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 1;
      for (const [t, effect] of cloud.selEffects) {
        if (cloud.selTickers.has(t)) continue;
        const c = cloud.centers.get(t);
        ctx.strokeStyle = `rgb(${DIR_RGB[effect.direction]})`;
        ctx.beginPath();
        ctx.moveTo(sel.sx, sel.sy);
        ctx.lineTo(sel.sx + (c.sx - sel.sx) * a, sel.sy + (c.sy - sel.sy) * a);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    for (const pt of cloud.pts) {
      if (!pt.shown) continue;
      const hot = lit ? pt.named.includes(lit)
        : pt === sel || (linked && pt.named.some((t) => cloud.selTickers.has(t)));
      const base = pt.named.length ? 2.3 : 1.4;
      const r = (base + (hot ? 0.7 : 0)) * pt.k;
      ctx.globalAlpha = hot ? 1 : lit ? 0.12 : clamp((linked ? 0.3 : 0.5) + (pt.k - 0.76) * 0.5, 0.16, 0.8);
      ctx.fillStyle = `rgb(${pt.rgb})`;
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';

    // Company and sector views: stories step back and the structure between companies shows.
    if (!stories) {
      ctx.lineWidth = 1;
      if (cloud.view === 'company') {
        for (const pair of cloud.pairs) {
          const hotPair = lit && (pair.a.t === lit || pair.b.t === lit);
          ctx.globalAlpha = lit ? (hotPair ? 0.9 : 0.04) : clamp(0.06 + pair.n * 0.05, 0.06, 0.6);
          ctx.strokeStyle = hotPair ? 'rgb(6,182,212)' : 'rgb(236,230,220)';
          ctx.beginPath();
          ctx.moveTo(pair.a.sx, pair.a.sy);
          ctx.lineTo(pair.b.sx, pair.b.sy);
          ctx.stroke();
        }
      } else {
        ctx.font = '600 13px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        for (const sector of cloud.sectors) {
          ctx.strokeStyle = 'rgb(236,230,220)';
          for (const c of sector.members) {
            ctx.globalAlpha = 0.34;
            ctx.beginPath();
            ctx.moveTo(sector.sx, sector.sy);
            ctx.lineTo(c.sx, c.sy);
            ctx.stroke();
          }
          ctx.globalAlpha = clamp(0.5 + (sector.k - 0.76) * 1.2, 0.4, 1);
          ctx.fillStyle = 'rgb(236,230,220)';
          ctx.beginPath();
          ctx.arc(sector.sx, sector.sy, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillText(sector.name, sector.sx, sector.sy - 12);
        }
      }
      for (const c of cloud.centers.values()) {
        const count = (state.byTicker.get(c.t) || []).length;
        ctx.globalAlpha = lit && c.t !== lit ? 0.3 : 0.9;
        ctx.fillStyle = `rgb(${TONE_RGB[moodLabel(state.mood.get(c.t))]})`;
        ctx.beginPath();
        ctx.arc(c.sx, c.sy, (2.5 + Math.sqrt(count) * 1.5) * c.k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

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
      const on = (stories && (cloud.selTickers.has(t) || cloud.selEffects.has(t))) || state.ticker === t || lit === t;
      // A named company's pill sits just above its cluster so it never covers the story point.
      c.el.style.transform = `translate(${c.sx.toFixed(1)}px, ${(c.sy - (on ? 30 : 0)).toFixed(1)}px) translate(-50%, -50%)`;
      c.el.style.opacity = (seen * (on ? 1 : clamp((stories ? 0.2 : 0.55) + (c.k - 0.76) * 1.25, 0.16, 0.95))).toFixed(2);
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
    const count = (state.byTicker.get(t) || []).length, avg = state.mood.get(t);
    showTip(`${company.name}, ${company.sector}`,
      `${count} ${count === 1 ? 'story' : 'stories'} on the wire` +
      (avg == null ? '' : `, average tone ${signed(avg)}`) +
      '. Select to open its profile.',
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

  const lightUp = (t) => { cloud.hoverT = t; kick(); };
  els.labels.addEventListener('click', (e) => { const b = e.target.closest('.co'); if (b) { hideTip(); tour.stop(); blip.company(b.dataset.t); } });
  els.labels.addEventListener('pointerover', (e) => { const b = e.target.closest('.co'); if (b) { companyTip(b.dataset.t); lightUp(b.dataset.t); } });
  els.labels.addEventListener('pointerout', (e) => { if (e.target.closest('.co')) { hideTip(); lightUp(null); } });
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

  // Drag turns the cloud, the wheel zooms it, a double-click puts it back.
  const turn = { on: false, moved: false, x: 0, y: 0 };
  els.cloud.addEventListener('pointerdown', (e) => {
    turn.on = true; turn.moved = false; turn.x = e.clientX; turn.y = e.clientY;
    els.cloud.setPointerCapture(e.pointerId);
  });
  els.cloud.addEventListener('pointerup', () => { turn.on = false; els.cloud.classList.remove('turning'); });
  els.cloud.addEventListener('pointercancel', () => { turn.on = false; });
  els.cloud.addEventListener('wheel', (e) => {
    e.preventDefault();
    cloud.zoom = clamp(cloud.zoom * Math.exp(-e.deltaY * 0.0012), 0.6, 2.8);
    kick();
  }, { passive: false });
  els.cloud.addEventListener('dblclick', () => { cloud.zoom = 1; cloud.dyaw = 0; cloud.dpitch = 0; kick(); });

  els.cloud.addEventListener('pointermove', (e) => {
    if (turn.on) {
      const dx = e.clientX - turn.x, dy = e.clientY - turn.y;
      if (turn.moved || Math.hypot(dx, dy) > 4) {
        turn.moved = true;
        els.cloud.classList.add('turning');
        cloud.dyaw += dx * 0.006;
        cloud.dpitch += dy * 0.004;
        turn.x = e.clientX; turn.y = e.clientY;
        hideTip();
        kick();
        return;
      }
    }
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
    if (turn.moved) { turn.moved = false; return; }
    const pt = storyUnder(e);
    if (pt && pt !== cloud.sel) pickStory(pt.story.id);
  });

  /* ---------- Search and the intro ---------- */
  let searchTimer = 0;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value.trim().toLowerCase();
      applyFilters(state.shown);
    }, 160);
  });

  /* ---------- Views: stories, companies, sectors ---------- */
  const VIEWS = { story: 'Showing every story', company: 'Showing how companies connect', sector: 'Showing sectors' };
  function setView(view) {
    cloud.view = view;
    document.querySelectorAll('.views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    $('#viewNote').textContent = VIEWS[view];
    els.chartEmpty.hidden = view !== 'story' || !cloud.sel || cloud.sel.named.length > 0 || cloud.selEffects.size > 0;
    hideTip();
    kick();
  }
  document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  /* ---------- Time machine: wind the wire back ---------- */
  let timeTimer = 0;
  function setUpTime() {
    const times = state.all.map((s) => s.time);
    const first = Math.min(...times), last = Math.max(...times);
    const scrub = $('#scrub'), outEl = $('#scrubOut');
    scrub.addEventListener('input', () => {
      const v = Number(scrub.value);
      const cutoff = v >= 1000 ? Infinity : first + ((last - first) * v) / 1000;
      cloud.cutoff = state.cutoff = cutoff;
      const shown = state.all.filter((s) => s.time <= cutoff).length;
      outEl.textContent = cutoff === Infinity ? `Now, ${state.all.length} stories`
        : `${fmtDay.format(new Date(cutoff))}, ${fmtTime.format(new Date(cutoff))}. ${shown} stories so far`;
      kick();
      clearTimeout(timeTimer);
      timeTimer = setTimeout(() => applyFilters(state.shown), 140);
    });
    outEl.textContent = `Now, ${state.all.length} stories`;
  }

  /* ---------- Guided tour ---------- */
  const tour = (() => {
    const box = $('#tour'), ring = $('#tourRing'), text = $('#tourText'), count = $('#tourCount');
    const tidy = () => blip.close();
    // Open a profile for a company the story on screen is expected to move, so the reasoning step has something to show.
    const openProfile = () => {
      const story = state.list[state.active];
      const effect = story && story.impact && story.impact.effects.find((e) => state.companies[e.ticker]);
      blip.company(effect ? effect.ticker : Object.keys(state.companies)[0], effect || undefined);
    };
    const STEPS = [
      ['.stage', 'This is a news story. Whichever headline sits on the reading line of the wire is the one being charted.', tidy],
      ['#chart', 'These points are stories. Cyan reads as good news, maroon as bad news, grey as neutral.', tidy],
      ['#labels', 'These clusters are companies. Hover a company name to light up every story about it.', tidy],
      ['.reads', 'These are relationships. Solid means the story names the company; dashed means Claude expects a knock-on effect. The lines in the cloud show the same thing.', tidy],
      ['.views', 'Switch what the cloud shows: every story, how companies connect, or sectors (keys 1, 2, 3). Drag the cloud to turn it and scroll to zoom.', tidy],
      ['.time', 'The time machine winds the wire back to an earlier moment, so you can watch stories arrive.', tidy],
      ['#search', 'Search headlines, tickers or company names. Press / to jump here.', tidy],
      ['.pv-chart', 'Selecting a company opens its profile, led by the share price. Switch between candles and a line, or pick a range or start date. Each marker is a day with news: select it to open the article.', openProfile],
      ['.ask-reason', 'Claude explains every call: why, what in the story supports it, whether the link is direct or indirect, how confident it is, and what would prove it wrong. Whether it proved right is checked against the price separately.', null],
      ['.ask-compare', 'Compare this company with another: news tone, Claude\'s record and share price side by side.', null],
      ['#blip', 'Blip, down here, opens this panel any time. Ask what is moving the market, or about any company.', null],
      ['#labels', 'Your turn: select any company name in the cloud to open its profile.', tidy],
    ];
    let at = -1;
    function place() {
      if (at < 0) return;
      const target = document.querySelector(STEPS[at][0]);
      if (!target) return;
      const r = target.getBoundingClientRect();
      ring.style.left = `${r.left - 4}px`;
      ring.style.top = `${r.top - 4}px`;
      ring.style.width = `${r.width + 8}px`;
      ring.style.height = `${r.height + 8}px`;
    }
    function show(i) {
      at = i;
      if (STEPS[i][2]) STEPS[i][2]();
      const target = document.querySelector(STEPS[i][0]);
      if (target && target.closest('#askOut')) target.scrollIntoView({ block: 'nearest' });
      box.classList.toggle('aside', !$('#ask').hidden);
      // The profile chart loads a moment later, so place the ring again once it has.
      setTimeout(place, 120);
      setTimeout(place, 700);
      text.textContent = STEPS[i][1];
      count.textContent = `${i + 1} of ${STEPS.length}`;
      $('#tourBack').disabled = i === 0;
      $('#tourNext').textContent = i === STEPS.length - 1 ? 'Finish' : 'Next';
      box.hidden = ring.hidden = false;
      place();
    }
    function stop() { at = -1; box.hidden = ring.hidden = true; box.classList.remove('aside'); }
    function start() { if (state.cutoff < Infinity || cloud.view !== 'story') setView('story'); show(0); $('#tourNext').focus(); }
    $('#tourNext').addEventListener('click', () => (at === STEPS.length - 1 ? stop() : show(at + 1)));
    $('#tourBack').addEventListener('click', () => show(Math.max(0, at - 1)));
    $('#tourSkip').addEventListener('click', stop);
    window.addEventListener('resize', place);
    // Panels scroll and charts load while the tour is open, so keep the ring on its target.
    $('#askOut').addEventListener('scroll', place, { passive: true });
    setInterval(() => { if (at >= 0) place(); }, 400);
    return { start, stop };
  })();

  /* ---------- Keyboard shortcuts ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target.closest && e.target.closest('input, textarea, dialog'))) return;
    const view = { 1: 'story', 2: 'company', 3: 'sector' }[e.key];
    if (view) setView(view);
    else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === '?') intro.showModal();
    else if (e.key === 't') tour.start();
    else if (e.key === 'Escape') tour.stop();
  });

  const intro = $('#intro');
  $('#introTour').addEventListener('click', () => { intro.close(); tour.start(); });
  $('#help').addEventListener('click', () => intro.showModal());
  $('#introClose').addEventListener('click', () => intro.close());
  intro.addEventListener('close', () => {
    try { localStorage.setItem('newsmind-intro', 'seen'); } catch (_) { /* private mode */ }
  });
  function greet() {
    let seen = null;
    try { seen = localStorage.getItem('newsmind-intro'); } catch (_) { /* private mode */ }
    if (!seen) intro.showModal();
  }

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

  /* ---------- Price chart with news markers ----------
     A year of daily bars, drawn with TradingView's Lightweight Charts. Every day a story
     landed gets a marker on the bar: an up arrow where Claude expected a rise, a down
     arrow where it expected a fall, a dot for news with no call. */
  const priceView = (() => {
    let chart = null, token = 0, barsPromise = null;
    const COLORS = { up: '#06B6D4', down: '#E0527A', none: '#9AA0A8' };
    const RANGES = [['1M', 1], ['3M', 3], ['6M', 6], ['1Y', 12]];

    const loadBars = () => (barsPromise = barsPromise || fetch('data/bars.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : { bars: {} })).then((d) => d.bars || {}).catch(() => ({})));

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };

    // The trading day a story first lands on: the same day if it came out before the US close, else the next one.
    function landingDay(story, days) {
      const when = new Date(story.publishedAt);
      const date = when.toISOString().slice(0, 10);
      const afterClose = when.getUTCHours() >= 21;
      return days.find((d) => (afterClose ? d > date : d >= date)) || null;
    }

    function newsByDay(t, days) {
      const byDay = new Map();
      for (const story of state.all) {
        const effect = ((story.impact || {}).effects || []).find((e) => e.ticker === t);
        if (!story.tickers.includes(t) && !effect) continue;
        const day = landingDay(story, days);
        if (!day) continue;
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push({ story, effect });
      }
      return byDay;
    }

    function markersFor(byDay) {
      return [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, items]) => {
        // The marker follows the majority of Claude's calls that day; a tie or no calls gives a dot.
        const ups = items.filter((i) => i.effect && i.effect.direction === 'up').length;
        const downs = items.filter((i) => i.effect && i.effect.direction === 'down').length;
        const dir = ups > downs ? 'up' : downs > ups ? 'down' : 'none';
        return {
          time: day, id: day, color: COLORS[dir],
          position: dir === 'up' ? 'belowBar' : 'aboveBar',
          shape: dir === 'up' ? 'arrowUp' : dir === 'down' ? 'arrowDown' : 'circle',
          size: items.length >= 10 ? 2 : items.length >= 3 ? 1.5 : 1,
        };
      });
    }

    function build(t, effect) {
      const my = ++token;
      const wrap = el('section', 'pv');
      const bar = el('div', 'pv-bar');
      const kinds = el('div', 'pv-seg');
      kinds.setAttribute('role', 'group');
      kinds.setAttribute('aria-label', 'Chart type');
      const candleBtn = el('button', null, 'Candles'), lineBtn = el('button', null, 'Line');
      [candleBtn, lineBtn].forEach((b) => { b.type = 'button'; kinds.append(b); });
      const ranges = el('div', 'pv-seg');
      ranges.setAttribute('role', 'group');
      ranges.setAttribute('aria-label', 'Time range');
      const rangeBtns = RANGES.map(([label]) => { const b = el('button', null, label); b.type = 'button'; ranges.append(b); return b; });
      const fromLabel = el('label', 'pv-from', 'From ');
      const from = el('input');
      from.type = 'date';
      fromLabel.append(from);
      bar.append(kinds, ranges, fromLabel);

      const box = el('div', 'pv-chart');
      const tip = el('div', 'pv-tip');
      tip.hidden = true;
      box.append(tip);
      const note = el('p', 'pv-note', 'Loading prices');
      const list = el('div', 'pv-list');
      wrap.append(bar, box, note, list);

      loadBars().then((all) => {
        if (my !== token || !wrap.isConnected) return;
        const rows = all[t];
        if (!rows || rows.length < 2 || !window.LightweightCharts) {
          note.textContent = 'No price history is available for this company yet.';
          box.remove();
          bar.remove();
          return;
        }
        const days = rows.map((r) => r[0]);
        const byDay = newsByDay(t, days);
        const markers = markersFor(byDay);

        chart = LightweightCharts.createChart(box, {
          autoSize: true,
          layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9AA0A8', fontFamily: 'Chakra Petch, sans-serif' },
          grid: { vertLines: { color: 'rgba(236,230,220,0.05)' }, horzLines: { color: 'rgba(236,230,220,0.05)' } },
          rightPriceScale: { borderColor: 'rgba(236,230,220,0.15)' },
          timeScale: { borderColor: 'rgba(236,230,220,0.15)' },
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        });
        const candles = chart.addCandlestickSeries({
          upColor: COLORS.up, downColor: COLORS.down, borderVisible: false,
          wickUpColor: COLORS.up, wickDownColor: COLORS.down,
        });
        candles.setData(rows.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
        const line = chart.addLineSeries({ color: '#ECE6DC', lineWidth: 2, visible: false });
        line.setData(rows.map(([time, , , , close]) => ({ time, value: close })));
        candles.setMarkers(markers);
        line.setMarkers(markers);

        function kind(useCandles) {
          candles.applyOptions({ visible: useCandles });
          line.applyOptions({ visible: !useCandles });
          candleBtn.setAttribute('aria-pressed', String(useCandles));
          lineBtn.setAttribute('aria-pressed', String(!useCandles));
        }
        candleBtn.addEventListener('click', () => kind(true));
        lineBtn.addEventListener('click', () => kind(false));
        kind(true);

        const last = days[days.length - 1];
        function showFrom(start, pressed) {
          const first = days.find((d) => d >= start) || days[0];
          chart.timeScale().setVisibleRange({ from: first, to: last });
          from.value = first;
          rangeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === pressed)));
        }
        RANGES.forEach(([, months], i) => rangeBtns[i].addEventListener('click', () => {
          const d = new Date(`${last}T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() - months);
          showFrom(d.toISOString().slice(0, 10), rangeBtns[i]);
        }));
        from.min = days[0];
        from.max = last;
        from.addEventListener('change', () => { if (from.value) showFrom(from.value, null); });
        // Open on the month that holds the news, or the story being looked at.
        rangeBtns[0].click();

        const headlinesFor = (day) => (byDay.get(day) || []);
        chart.subscribeCrosshairMove((param) => {
          const items = param.hoveredObjectId ? headlinesFor(param.hoveredObjectId) : [];
          if (!items.length || !param.point) { tip.hidden = true; return; }
          tip.replaceChildren(el('strong', null, `${fmtDay.format(new Date(`${param.hoveredObjectId}T12:00:00Z`))}, ${items.length} ${items.length === 1 ? 'story' : 'stories'}`));
          items.slice(0, 3).forEach(({ story }) => tip.append(el('span', null, story.headline)));
          if (items.length > 3) tip.append(el('span', 'pv-more', `and ${items.length - 3} more.`));
          tip.append(el('span', 'pv-more', items.length === 1 ? 'Select the marker to open the article.' : 'Select the marker to list the articles.'));
          tip.hidden = false;
          tip.style.left = `${Math.min(param.point.x + 14, box.clientWidth - 250)}px`;
          tip.style.top = `${Math.max(param.point.y - 30, 4)}px`;
        });

        function listDay(day) {
          const items = headlinesFor(day);
          list.replaceChildren();
          if (!items.length) return;
          list.append(el('p', 'ask-label', `News on ${fmtDay.format(new Date(`${day}T12:00:00Z`))}`));
          for (const { story, effect: e } of items) {
            const row = el('div', 'pv-item');
            const call = e ? `Claude: likely ${e.direction} ${ARROW[e.direction]}` : 'No call from Claude';
            const head = story.url ? el('a', 'pv-head', story.headline) : el('span', 'pv-head', story.headline);
            if (story.url) { head.href = story.url; head.target = '_blank'; head.rel = 'noopener noreferrer'; }
            const meta = el('p', 'pv-meta', `${story.source}, ${fmtTime.format(new Date(story.publishedAt))}. ${call}`);
            const show = el('button', 'pv-show', 'Show in the wire');
            show.type = 'button';
            show.dataset.story = story.id;
            row.append(head, meta, show);
            list.append(row);
          }
        }
        // Selecting a marker opens the article itself; a day with several stories lists them as links.
        chart.subscribeClick((param) => {
          if (!param.hoveredObjectId) return;
          const items = headlinesFor(param.hoveredObjectId);
          listDay(param.hoveredObjectId);
          if (items.length === 1 && items[0].story.url) window.open(items[0].story.url, '_blank', 'noopener');
          else list.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });

        const latest = markers.length ? markers[markers.length - 1].id : null;
        const focus = effect && byDay.size ? [...byDay].find(([, items]) => items.some((i) => i.effect === effect)) : null;
        if (focus || latest) listDay(focus ? focus[0] : latest);
        note.textContent = markers.length
          ? `Each marker is a trading day with news about ${t} (${markers.length} so far). ` +
            'Up arrow: Claude mostly expected a rise. Down arrow: a fall. Dot: no clear lean. Bigger markers mean more stories. Select a marker to open its article.'
          : `No news about ${t} has landed on a trading day in this range yet.`;
      });
      return wrap;
    }

    function clear() {
      token++;
      if (chart) { chart.remove(); chart = null; }
    }

    return { build, clear };
  })();

  /* ---------- Blip: the assistant that reads Claude's saved analysis back ----------
     Blip never calls Claude from the browser. It shows the briefs the pipeline
     saved into events.json, so no API key is ever shipped to the page. */
  const blip = (() => {
    const btn = $('#blip'), cv = $('#blipSprite'), g = cv.getContext('2d'), floor = $('#floor');
    const ask = $('#ask'), out = $('#askOut'), foot = $('#askFoot'), input = $('#askInput');
    const BODY = [
      '......c......', '......c......', '.....hcc.....', '.....ccc.....', '....ccccc....',
      '..ccccccccc..', 'ccccccccccccc', '..ccccccccc..', '....ccccc....',
    ];
    const LEGS = {
      idle: ['....c...c....', '....f...f....'],
      a: ['....c...f....', '....f........'],
      b: ['....f...c....', '........f....'],
    };
    const INK = { c: '#06B6D4', h: '#B8F1FA', f: '#E0527A', e: '#08090A' };
    const s = { x: 40, target: 40, mode: 'pause', until: 1500, frame: 'idle', stepAt: 0, blinkAt: 2500, blinkUntil: 0, look: 0, last: 0 };

    function draw(now) {
      g.clearRect(0, 0, 13, 11);
      BODY.concat(LEGS[s.frame]).forEach((row, y) => {
        for (let x = 0; x < 13; x++) {
          if (row[x] === '.') continue;
          g.fillStyle = INK[row[x]];
          g.fillRect(x, y, 1, 1);
        }
      });
      g.fillStyle = INK.e;
      for (const ex of [5 + s.look, 8 + s.look]) {
        if (now > s.blinkUntil) g.fillRect(ex, 5, 1, 1);
        g.fillRect(ex, 6, 1, 1);
      }
    }

    // Wander the lane, follow the pointer when it comes near, stand by the panel while it is open.
    function tick(now) {
      const dt = clamp(now - s.last, 0, 100);
      s.last = now;
      const open = !ask.hidden, calm = still();
      const maxX = Math.max(8, floor.clientWidth - 60);
      const follow = !calm && !open && wide.matches && mouse.cx >= 0 && mouse.cy > window.innerHeight - 150;
      let goal = s.x;
      if (open) goal = Math.min(24, maxX);
      else if (follow) goal = clamp(mouse.cx - 26, 8, maxX);
      else if (!calm) {
        if (s.mode === 'pause' && now > s.until) { s.mode = 'walk'; s.target = 8 + Math.random() * (maxX - 8); }
        if (s.mode === 'walk') goal = s.target;
      }
      const d = goal - s.x;
      if (Math.abs(d) > 1.5) {
        s.x += Math.sign(d) * Math.min(Math.abs(d), (46 * dt) / 1000);
        s.look = Math.sign(d);
        if (now > s.stepAt) { s.frame = s.frame === 'a' ? 'b' : 'a'; s.stepAt = now + 170; }
      } else {
        if (s.mode === 'walk' && !open && !follow) { s.mode = 'pause'; s.until = now + 1200 + Math.random() * 3400; }
        s.frame = 'idle';
        s.look = mouse.cx < 0 ? 0 : clamp(Math.round((mouse.cx - (s.x + 26)) / 120), -1, 1);
      }
      if (now > s.blinkAt) { s.blinkUntil = now + 130; s.blinkAt = now + 2200 + Math.random() * 3000; }
      s.x = clamp(s.x, 8, maxX);
      btn.style.transform = `translate(${s.x.toFixed(1)}px, ${s.frame === 'b' ? -2 : 0}px)`;
      draw(now);
      requestAnimationFrame(tick);
    }

    const node = (tag, cls, text) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };

    // The full text is in the page at once (so screen readers get it); words fade in one after another.
    function write(el, text) {
      el.replaceChildren();
      text.split(/\s+/).forEach((word, i) => {
        const span = node('span', 'w', word + ' ');
        span.style.animationDelay = `${i * 22}ms`;
        el.append(span);
      });
    }

    const credit = (entry, unit) =>
      `Written by Claude (${entry.model}) on ${fmtDay.format(new Date(entry.writtenAt.replace(' ', 'T') + 'Z'))} ` +
      `from ${entry.stories} ${unit}. A judgement, not advice.`;

    function showMarket() {
      const m = state.market;
      priceView.clear();
      ask.classList.remove('wide');
      out.replaceChildren();
      foot.textContent = '';
      if (!m) {
        out.append(node('p', 'ask-text', "Claude hasn't written a market digest yet. It appears once the pipeline runs with an API key."));
        return;
      }
      out.append(node('h3', 'ask-h', 'What is moving the market'));
      const p = node('p', 'ask-text');
      write(p, m.brief);
      out.append(p);
      for (const theme of m.themes) {
        const box = node('div', 'ask-theme');
        box.append(node('strong', null, theme.title), node('p', null, theme.detail));
        const row = node('div', 'ask-chips');
        for (const t of theme.tickers) {
          if (!state.companies[t]) continue;
          const chip = node('button', 'chip', t);
          chip.type = 'button';
          chip.dataset.t = t;
          chip.setAttribute('aria-label', `Ask about ${state.companies[t].name}`);
          row.append(chip);
        }
        if (row.children.length) box.append(row);
        out.append(box);
      }
      foot.textContent = credit(m, 'of the newest headlines');
    }

    // Stock and market as % change over the charted days, with a marker at the story.
    function priceChart(t, check) {
      const rows = state.prices[t], spy = state.prices.SPY;
      if (!rows || rows.length < 2 || !spy) return null;
      const market = new Map(spy), days = rows.map((r) => r[0]);
      const m0 = market.get(days[0]);
      const stock = rows.map((r) => (r[1] / rows[0][1] - 1) * 100);
      const bench = days.map((d) => (market.has(d) && m0 ? (market.get(d) / m0 - 1) * 100 : null));
      const all = stock.concat(bench.filter((v) => v != null), 0);
      const lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.14 || 1;
      const W = 400, H = 132;
      const x = (i) => 8 + (i * (W - 16)) / (days.length - 1);
      const y = (v) => H - 20 - ((v - (lo - pad)) / (hi - lo + pad * 2)) * (H - 34);
      const path = (vals) => vals.map((v, i) => (v == null ? '' : `${i && vals[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join(' ');
      const at = check && check.from ? days.indexOf(check.from) : -1;
      const last = stock[stock.length - 1], lastBench = bench[bench.length - 1];
      const fig = node('figure', 'ask-chart');
      fig.innerHTML =
        `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t} is ${signed(last)}% over the last ${days.length} trading days; the S&P 500 is ${signed(lastBench || 0)}%.">` +
        (at >= 0 ? `<rect class="since" x="${x(at).toFixed(1)}" y="6" width="${(W - 8 - x(at)).toFixed(1)}" height="${H - 26}"/>` +
          `<line class="mark" x1="${x(at).toFixed(1)}" x2="${x(at).toFixed(1)}" y1="6" y2="${H - 20}"/>` : '') +
        `<line class="zero" x1="8" x2="${W - 8}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` +
        `<path class="bench" d="${path(bench)}"/><path class="stock" d="${path(stock)}"/>` +
        `<text x="8" y="${H - 4}">${days[0].slice(5)}</text><text x="${W - 8}" y="${H - 4}" text-anchor="end">${days[days.length - 1].slice(5)}</text>` +
        (at >= 0 ? `<text x="${Math.min(x(at) + 4, W - 60).toFixed(1)}" y="16">story</text>` : '') + '</svg>';
      fig.append(node('figcaption', null,
        `Solid line: ${t}. Dashed: S&P 500. Both as % change over ${days.length} trading days` +
        (at >= 0 ? '; the shaded part is since the story.' : '.')));
      return fig;
    }

    const record = (t) => {
      const own = state.byTicker.get(t) || [];
      const calls = state.all.flatMap((st) => ((st.impact || {}).effects || []).filter((e) => e.ticker === t));
      const avg = state.mood.get(t);
      const series = state.prices[t];
      return {
        tone: avg == null ? 'Not scored' : `${moodLabel(avg)} (${signed(avg)})`,
        stories: String(own.length),
        calls: String(calls.length),
        right: String(calls.filter((e) => (e.check || {}).status === 'right').length),
        wrong: String(calls.filter((e) => (e.check || {}).status === 'wrong').length),
        price: series && series.length > 1 ? `${signed((series[series.length - 1][1] / series[0][1] - 1) * 100)}%` : 'No data',
      };
    };

    function compare(a, b, holder) {
      holder.replaceChildren();
      if (!b) return;
      const A = record(a), B = record(b);
      const touches = (st, t) => st.tickers.includes(t) || ((st.impact || {}).effects || []).some((e) => e.ticker === t);
      const shared = state.all.filter((st) => touches(st, a) && touches(st, b));
      const table = node('table', 'ask-table');
      const row = (cells, tag) => {
        const tr = document.createElement('tr');
        cells.forEach((c, i) => tr.append(node(i === 0 || tag === 'th' ? 'th' : 'td', null, c)));
        table.append(tr);
      };
      row(['', a, b], 'th');
      row(['News tone', A.tone, B.tone]);
      row(['Stories naming it', A.stories, B.stories]);
      row(['Claude calls', A.calls, B.calls]);
      row(['Right so far', A.right, B.right]);
      row(['Wrong so far', A.wrong, B.wrong]);
      row([`Price, ${(state.prices[a] || []).length} trading days`, A.price, B.price]);
      holder.append(table);

      const ra = state.prices[a], rb = state.prices[b];
      if (ra && rb && ra.length > 1 && rb.length === ra.length) {
        const pa = ra.map((r) => (r[1] / ra[0][1] - 1) * 100), pb = rb.map((r) => (r[1] / rb[0][1] - 1) * 100);
        const all = pa.concat(pb, 0), lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.14 || 1;
        const W = 400, H = 120;
        const x = (i) => 8 + (i * (W - 16)) / (ra.length - 1);
        const y = (v) => H - 18 - ((v - (lo - pad)) / (hi - lo + pad * 2)) * (H - 30);
        const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
        const fig = node('figure', 'ask-chart');
        fig.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${a} is ${A.price} and ${b} is ${B.price} over the same days.">` +
          `<line class="zero" x1="8" x2="${W - 8}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` +
          `<path class="stock" d="${path(pa)}"/><path class="rival" d="${path(pb)}"/>` +
          `<text x="8" y="${H - 3}">${ra[0][0].slice(5)}</text><text x="${W - 8}" y="${H - 3}" text-anchor="end">${ra[ra.length - 1][0].slice(5)}</text></svg>`;
        fig.append(node('figcaption', null, `Light line: ${a}. Cyan line: ${b}. Both as % change over the same days.`));
        holder.append(fig);
      }
      holder.append(node('p', 'ask-label', shared.length
        ? `${shared.length} ${shared.length === 1 ? 'story touches' : 'stories touch'} both companies`
        : 'No story on the wire touches both companies'));
      for (const st of shared.slice(0, 4)) {
        const link = node('button', 'ask-story', st.headline);
        link.type = 'button';
        link.dataset.story = st.id;
        holder.append(link);
      }
    }

    function showCompany(t, effect) {
      const company = state.companies[t], b = state.briefs[t];
      priceView.clear();
      ask.classList.add('wide');
      out.replaceChildren();
      foot.textContent = '';
      const own = state.byTicker.get(t) || [];
      out.append(node('h3', 'ask-h', company.name), node('p', 'ask-id', `${t}, ${company.sector}`));

      // The price chart comes first: what the stock did, with the news pinned to the days it landed.
      out.append(priceView.build(t, effect));

      // Reasoning for one call: what Claude claimed, on what basis, and what would undo it.
      if (effect) {
        const box = node('div', `ask-reason dir-${effect.direction}`);
        box.append(node('p', 'ask-reason-head',
          `For the story on screen: likely ${effect.direction} ${ARROW[effect.direction]}`));
        const tags = node('p', 'ask-tags');
        tags.append(node('span', null, effect.link ? `${effect.link} link` : 'link type not recorded'),
          node('span', null, `${effect.confidence} confidence`));
        box.append(tags);
        const part = (title, body) => { if (body) box.append(node('p', 'ask-part-title', title), node('p', 'ask-part', body)); };
        part('Why this connection exists', effect.reason);
        part('What in the story supports it', effect.evidence);
        part('What would contradict it', effect.counter);
        part('How it has played out so far', checkText(t, effect.check) ||
          'Not scored: a mixed call has no single direction to check.');
        part('At fixed horizons', windowText(effect.check));
        box.append(node('p', 'ask-note', 'Confidence is how sure Claude was when it read the story. Whether the call proved right is tracked separately, above.'));
        out.append(box);
      }

      // The numbers at a glance.
      const avg = state.mood.get(t);
      const calls = state.all.flatMap((st) => ((st.impact || {}).effects || []).filter((e) => e.ticker === t));
      const right = calls.filter((e) => (e.check || {}).status === 'right').length;
      const wrong = calls.filter((e) => (e.check || {}).status === 'wrong').length;
      const stats = node('dl', 'ask-stats');
      const stat = (k, v) => stats.append(node('dt', null, k), node('dd', null, v));
      stat('News tone', avg == null ? 'Not scored' : `${moodLabel(avg)} (${signed(avg)})`);
      stat('Stories naming it', String(own.length));
      stat('Claude calls on it', `${calls.length}, ${right} right and ${wrong} wrong so far`);
      out.append(stats);

      // Compare mode: put a second company beside this one.
      const pickOther = node('select', 'ask-compare');
      pickOther.setAttribute('aria-label', `Compare ${company.name} with another company`);
      pickOther.append(new Option('Compare with another company', ''));
      Object.entries(state.companies).filter(([o]) => o !== t).sort((a, b) => a[1].name.localeCompare(b[1].name))
        .forEach(([o, c]) => pickOther.append(new Option(`${c.name} (${o})`, o)));
      const versus = node('div', 'ask-versus');
      pickOther.addEventListener('change', () => compare(t, pickOther.value, versus));
      out.append(pickOther, versus);

      // How the tone of its coverage has moved, day by day.
      const days = new Map();
      for (const st of own) {
        if (st.tone == null) continue;
        const day = st.publishedAt.slice(0, 10);
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(st.tone);
      }
      if (days.size > 1) {
        const rows = [...days].sort().map(([day, tones]) => [day, tones.reduce((a, b) => a + b, 0) / tones.length, tones.length]);
        const W2 = 400, H2 = 96, mid = 44, bw = Math.min(46, (W2 - 16) / rows.length - 6);
        const fig = node('figure', 'ask-chart');
        fig.innerHTML = `<svg viewBox="0 0 ${W2} ${H2}" role="img" aria-label="Average headline tone per day for ${t}">` +
          `<line class="zero" x1="8" x2="${W2 - 8}" y1="${mid}" y2="${mid}"/>` +
          rows.map(([day, tone, n], i) => {
            const x = 12 + i * ((W2 - 24) / rows.length), h = Math.max(2, Math.abs(tone) * 34);
            return `<rect class="${tone >= 0 ? 'bar-up' : 'bar-down'}" x="${x.toFixed(1)}" y="${(tone >= 0 ? mid - h : mid).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>` +
              `<text x="${(x + bw / 2).toFixed(1)}" y="${H2 - 4}" text-anchor="middle">${day.slice(5)} (${n})</text>`;
          }).join('') + '</svg>';
        fig.append(node('figcaption', null, 'Average headline tone per day. Bars above the line read positive, below negative. Story counts in brackets.'));
        out.append(node('p', 'ask-label', 'How its coverage has read over time'), fig);
      }

      const chart = priceChart(t, effect && effect.check);
      if (chart) out.append(node('p', 'ask-label', 'Last month against the S&P 500'), chart);

      // Sectors it keeps appearing alongside in the same stories.
      const partners = new Map();
      for (const pair of cloud.pairs) {
        const other = pair.a.t === t ? pair.b.t : pair.b.t === t ? pair.a.t : null;
        if (!other) continue;
        const sector = state.companies[other].sector;
        if (sector !== company.sector) partners.set(sector, (partners.get(sector) || 0) + pair.n);
      }
      if (partners.size) {
        out.append(node('p', 'ask-label', 'Sectors it shares stories with'));
        const row = node('p', 'ask-tags');
        [...partners].sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([sector, n]) => row.append(node('span', null, `${sector} (${n})`)));
        out.append(row);
      }
      if (!b) {
        out.append(node('p', 'ask-text', `Claude has no brief for ${company.name} yet. It is written once the company has stories on the wire.`));
        return;
      }
      const stance = node('p', 'ask-stance ' + toneClass(b.stance === 'positive' || b.stance === 'negative' ? b.stance : 'neutral'),
        b.stance === 'quiet' ? 'Coverage is quiet' : `Coverage reads ${b.stance}`);
      const p = node('p', 'ask-text');
      write(p, b.brief);
      out.append(node('p', 'ask-label', "Claude's brief"), stance, p);
      if (b.drivers.length) {
        out.append(node('p', 'ask-label', 'Recent developments'));
        const ul = node('ul', 'ask-drivers');
        b.drivers.forEach((d) => ul.append(node('li', null, d)));
        out.append(ul);
      }
      out.append(node('p', 'ask-watch', `Watch next: ${b.watch}`));

      if (own.length && state.ticker !== t) {
        const show = node('button', 'chip', `Show its ${own.length} ${own.length === 1 ? 'story' : 'stories'} in the wire`);
        show.type = 'button';
        show.dataset.filter = t;
        out.append(show);
      }
      const linked = state.all.filter((st) => st.impact && !st.tickers.includes(t) &&
        st.impact.effects.some((e) => e.ticker === t)).slice(0, 3);
      if (linked.length) {
        out.append(node('p', 'ask-label', `Stories that don't name ${company.name} but Claude links to it`));
        for (const st of linked) {
          const link = node('button', 'ask-story', st.headline);
          link.type = 'button';
          link.dataset.story = st.id;
          out.append(link);
        }
      }
      foot.textContent = credit(b, b.stories === 1 ? 'headline' : 'headlines');
    }

    function resolve(text) {
      let q = text.trim().toLowerCase();
      if (!q) return null;
      const tagged = q.match(/\(([a-z.]+)\)\s*$/);
      if (tagged) q = tagged[1];
      const all = Object.entries(state.companies);
      const hit = all.find(([t]) => t.toLowerCase() === q) ||
        all.find(([, c]) => c.name.toLowerCase() === q) ||
        all.find(([, c]) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()));
      return hit ? hit[0] : null;
    }

    function open() {
      if (!ask.hidden) return;
      ask.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      if (!out.children.length) showMarket();
      $('#askMarket').focus({ preventScroll: true });
    }

    function close() {
      priceView.clear();
      ask.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.focus({ preventScroll: true });
    }

    btn.addEventListener('click', () => (ask.hidden ? open() : close()));
    $('#askClose').addEventListener('click', close);
    $('#askMarket').addEventListener('click', showMarket);
    ask.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $('#askForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const t = resolve(input.value);
      if (t) { showCompany(t); return; }
      out.replaceChildren(node('p', 'ask-text',
        `I don't follow "${input.value.trim()}". I track ${Object.keys(state.companies).length} companies, such as Nvidia, Exxon Mobil and Boeing.`));
      foot.textContent = '';
    });
    out.addEventListener('click', (e) => {
      const el = e.target.closest('button');
      if (!el) return;
      if (el.dataset.t) showCompany(el.dataset.t);
      else if (el.dataset.story) pickStory(el.dataset.story);
      else if (el.dataset.filter) {
        if (state.ticker !== el.dataset.filter) pickCompany(el.dataset.filter);
        showCompany(el.dataset.filter);
      }
    });

    function ready() {
      const list = $('#askList');
      for (const [t, c] of Object.entries(state.companies)) {
        const opt = document.createElement('option');
        opt.value = `${c.name} (${t})`;
        list.append(opt);
      }
      if (!still()) {
        btn.classList.add('hello');
        setTimeout(() => btn.classList.remove('hello'), 5000);
      }
    }

    requestAnimationFrame(tick);
    return { ready, company: (t, effect) => { open(); showCompany(t, effect); }, close: () => { if (!ask.hidden) close(); } };
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
