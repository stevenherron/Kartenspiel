/* Kartenmappe – Magic-Sammlung per Kamera erfassen, mit Scryfall-Preisen. Alles lokal im Browser gespeichert. */
(function () {
  'use strict';

  /* ---------- Helfer ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function localDate() { return new Date().toLocaleDateString('sv-SE'); }
  function money(v, cur) {
    if (v == null) return '–';
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: (cur || S.settings.cur).toUpperCase() }).format(v);
  }
  function ago(ms) {
    if (!ms) return 'noch nie';
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'gerade eben';
    if (m < 60) return 'vor ' + m + ' Min.';
    var h = Math.round(m / 60);
    if (h < 48) return 'vor ' + h + ' Std.';
    return 'vor ' + Math.round(h / 24) + ' Tagen';
  }
  var RARITY = { common: 'C', uncommon: 'U', rare: 'R', mythic: 'M', special: 'S', bonus: 'B' };
  function bigImg(c) { return c.img ? c.img.replace('/small/', '/normal/') : ''; }

  /* ---------- Speicher (IndexedDB, Fallback: Arbeitsspeicher) ---------- */
  var DB = {
    db: null, ok: false, mem: new Map(),
    open: function () {
      var self = this;
      return new Promise(function (res) {
        try {
          var r = indexedDB.open('kartenmappe', 1);
          r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
          r.onsuccess = function () { self.db = r.result; self.ok = true; res(); };
          r.onerror = function () { res(); };
          r.onblocked = function () { res(); };
        } catch (e) { res(); }
      });
    },
    get: function (k) {
      var self = this;
      if (!this.ok) return Promise.resolve(this.mem.get(k));
      return new Promise(function (res, rej) {
        var q = self.db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    },
    set: function (k, v) {
      var self = this;
      if (!this.ok) { this.mem.set(k, v); return Promise.resolve(); }
      return new Promise(function (res, rej) {
        var t = self.db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(v, k);
        t.oncomplete = function () { res(); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    },
    del: function (k) {
      var self = this;
      if (!this.ok) { this.mem.delete(k); return Promise.resolve(); }
      return new Promise(function (res, rej) {
        var t = self.db.transaction('kv', 'readwrite');
        t.objectStore('kv').delete(k);
        t.oncomplete = function () { res(); };
        t.onerror = function () { rej(t.error); };
      });
    }
  };

  /* ---------- Zustand ---------- */
  var S = {
    sets: [],            // {code, name, date, count, active, loadedAt}
    collection: {},      // "<cardId>|n|f" -> {id, foil, qty, cond, at}
    settings: { cur: 'eur', multi: false, sort: 'value', foilMode: false, auto: true },
    history: []          // {d, v, cur, chg, n}
  };
  var CARDS = new Map(); // setcode -> schlanke Karten
  var BYID = new Map();
  var INDEX = [];
  var SETLIST = null;
  var LOAD = new Map();  // setcode -> Statustext beim Laden
  var tab = 'scan';
  var saveT = null;

  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(function () { DB.set('state', S).catch(function () {}); }, 150);
  }
  function getSet(code) { return S.sets.filter(function (s) { return s.code === code; })[0]; }
  function activeSets() { return S.sets.filter(function (s) { return s.active && CARDS.has(s.code); }); }
  function loadedSets() { return S.sets.filter(function (s) { return CARDS.has(s.code); }); }
  function rebuild() {
    BYID = new Map();
    CARDS.forEach(function (cs) { cs.forEach(function (c) { BYID.set(c.id, c); }); });
    var cards = [];
    activeSets().forEach(function (s) { CARDS.get(s.code).forEach(function (c) { cards.push(c); }); });
    INDEX = Core.buildIndex(cards);
  }
  async function loadAll() {
    await DB.open();
    var st = null;
    try { st = await DB.get('state'); } catch (e) { /* leer starten */ }
    if (st) {
      S.sets = st.sets || [];
      S.collection = st.collection || {};
      S.history = st.history || [];
      S.settings = Object.assign(S.settings, st.settings || {});
    }
    for (var i = 0; i < S.sets.length; i++) {
      try {
        var cs = await DB.get('cards:' + S.sets[i].code);
        if (cs) CARDS.set(S.sets[i].code, cs);
      } catch (e) { /* Set fehlt, wird unter Sets neu geladen */ }
    }
    rebuild();
  }

  /* ---------- Scryfall ---------- */
  async function sf(url, tries) {
    tries = tries || 0;
    var r;
    try { r = await fetch(url, { headers: { Accept: 'application/json' } }); }
    catch (e) { var err = new Error('Keine Verbindung zu Scryfall.'); err.status = 0; throw err; }
    if (r.status === 429 && tries < 4) { await sleep(1200 * (tries + 1)); return sf(url, tries + 1); }
    if (!r.ok) {
      var e2 = new Error(r.status === 404 ? 'Nichts gefunden.' : 'Scryfall-Fehler ' + r.status);
      e2.status = r.status;
      throw e2;
    }
    return r.json();
  }
  async function sfAll(url, onPage) {
    var out = [];
    while (url) {
      var j = await sf(url);
      j.data.forEach(function (c) { out.push(c); });
      if (onPage) onPage(out.length, j.total_cards);
      url = j.has_more ? j.next_page : null;
      if (url) await sleep(110);
    }
    return out;
  }
  function num(x) { var v = parseFloat(x); return isFinite(v) ? v : null; }
  function slim(c, deMap) {
    var faces = c.card_faces || [];
    var uris = c.image_uris || (faces[0] && faces[0].image_uris) || {};
    var p = c.prices || {};
    return {
      id: c.id, n: c.name, de: deMap.get(c.set + '|' + c.collector_number) || null,
      s: c.set, sn: c.set_name, cn: c.collector_number, r: c.rarity, img: uris.small || null,
      fin: c.finishes || ['nonfoil'],
      eur: num(p.eur), eurF: num(p.eur_foil), usd: num(p.usd), usdF: num(p.usd_foil),
      uri: c.scryfall_uri
    };
  }
  async function fetchSet(code, opts, onProgress) {
    opts = opts || {};
    var base = 'https://api.scryfall.com/cards/search?unique=prints&include_variations=true&order=set&q=';
    var en = await sfAll(base + encodeURIComponent('e:' + code), onProgress);
    var deMap = new Map();
    if (opts.prev) {
      opts.prev.forEach(function (c) { if (c.de) deMap.set(c.s + '|' + c.cn, c.de); });
    } else {
      try {
        var de = await sfAll(base + encodeURIComponent('e:' + code + ' lang:de') + '&include_multilingual=true', null);
        de.forEach(function (c) {
          var nm = c.printed_name || (c.card_faces || []).map(function (f) { return f.printed_name; }).filter(Boolean).join(' // ');
          if (nm) deMap.set(c.set + '|' + c.collector_number, nm);
        });
      } catch (e) { if (e.status !== 404) throw e; }
    }
    return en.map(function (c) { return slim(c, deMap); });
  }
  var setListP = null;
  function getSetList() {
    if (SETLIST) return Promise.resolve(SETLIST);
    if (!setListP) setListP = loadSetList().catch(function (e) { setListP = null; throw e; });
    return setListP;
  }
  async function loadSetList() {
    var cached = null;
    try { cached = await DB.get('setlist'); } catch (e) { /* neu laden */ }
    if (cached && Date.now() - cached.t < 7 * 864e5) { SETLIST = cached.list; return SETLIST; }
    var j = await sf('https://api.scryfall.com/sets');
    SETLIST = j.data
      .filter(function (s) { return !s.digital && s.card_count > 0 && ['token', 'memorabilia', 'minigame'].indexOf(s.set_type) < 0; })
      .map(function (s) { return { code: s.code, name: s.name, released_at: s.released_at, card_count: s.card_count, set_type: s.set_type }; });
    try { await DB.set('setlist', { t: Date.now(), list: SETLIST }); } catch (e) { /* egal */ }
    return SETLIST;
  }

  async function addSet(meta) {
    if (getSet(meta.code)) { toast('Dieses Set ist schon in deiner Liste.'); return; }
    S.sets.push({ code: meta.code, name: meta.name, date: meta.released_at, count: 0, active: false, loadedAt: 0 });
    LOAD.set(meta.code, 'Lade Karten …');
    renderSets();
    try {
      var cards = await fetchSet(meta.code, {}, function (n, t) {
        LOAD.set(meta.code, 'Lade Karten … ' + n + (t ? ' von ' + t : ''));
        renderSets();
      });
      CARDS.set(meta.code, cards);
      await DB.set('cards:' + meta.code, cards);
      var s = getSet(meta.code);
      s.loadedAt = Date.now();
      s.count = cards.length;
      if (!activeSets().length) s.active = true;
      rebuild();
      save();
      toast(meta.name + ': ' + cards.length + ' Karten geladen.');
    } catch (e) {
      S.sets = S.sets.filter(function (s2) { return s2.code !== meta.code; });
      toast(e.message || 'Set konnte nicht geladen werden.');
    } finally {
      LOAD.delete(meta.code);
      renderSets();
      renderScanUI();
      syncCamera();
    }
  }

  async function refreshSets(codes, silent) {
    var v0 = totals().value;
    var ok = 0;
    for (var i = 0; i < codes.length; i++) {
      var code = codes[i];
      var s = getSet(code);
      if (!s) continue;
      LOAD.set(code, 'Aktualisiere Preise …');
      if (tab === 'sets') renderSets();
      try {
        var cards = await fetchSet(code, { prev: CARDS.get(code) || [] });
        CARDS.set(code, cards);
        await DB.set('cards:' + code, cards);
        s.loadedAt = Date.now();
        s.count = cards.length;
        ok++;
      } catch (e) {
        if (!silent) toast(s.name + ': ' + (e.message || 'Fehler beim Aktualisieren.'));
      } finally {
        LOAD.delete(code);
      }
    }
    if (ok) {
      rebuild();
      var v1 = totals().value;
      recordHistory(v1 - v0);
      if (!silent) toast('Preise aktualisiert.');
    }
    save();
    if (tab === 'sets') renderSets();
    if (tab === 'coll') renderCollection();
  }
  async function autoRefresh() {
    if (!navigator.onLine) return;
    var stale = loadedSets().filter(function (s) { return Date.now() - s.loadedAt > 24 * 3600e3; });
    if (stale.length) await refreshSets(stale.map(function (s) { return s.code; }), true);
  }

  /* ---------- Sammlung ---------- */
  function ckey(id, foil) { return id + '|' + (foil ? 'f' : 'n'); }
  function ownedQty(id) {
    return (S.collection[ckey(id, false)] ? S.collection[ckey(id, false)].qty : 0) +
           (S.collection[ckey(id, true)] ? S.collection[ckey(id, true)].qty : 0);
  }
  function addCard(c, foil, n) {
    var k = ckey(c.id, foil);
    var e = S.collection[k] || (S.collection[k] = { id: c.id, foil: !!foil, qty: 0, cond: 'NM', at: Date.now() });
    e.qty += n;
    save();
    recordHistory(null);
  }
  function removeCard(k, n) {
    var e = S.collection[k];
    if (!e) return;
    e.qty -= n;
    if (e.qty <= 0) delete S.collection[k];
    save();
    recordHistory(null);
  }
  function totals() {
    var value = 0, cards = 0, uniq = 0, missing = 0;
    Object.keys(S.collection).forEach(function (k) {
      var e = S.collection[k];
      var c = BYID.get(e.id);
      if (!c) return;
      cards += e.qty; uniq++;
      var p = Core.priceOf(c, e.foil, S.settings.cur);
      if (p == null) missing += e.qty; else value += p * e.qty;
    });
    return { value: value, cards: cards, uniq: uniq, missing: missing };
  }
  function recordHistory(chg) {
    var t = totals();
    var d = localDate();
    var h = S.history;
    var last = h[h.length - 1];
    var entry = { d: d, v: Math.round(t.value * 100) / 100, cur: S.settings.cur, chg: chg, n: t.cards };
    if (last && last.d === d && last.cur === entry.cur) {
      entry.chg = chg != null ? chg : last.chg;
      h[h.length - 1] = entry;
    } else h.push(entry);
    if (h.length > 400) h.shift();
    save();
  }

  /* ---------- Toast, Sheet ---------- */
  var toastT = null;
  function toast(msg, action) {
    var t = $('#toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button data-act="toastAction">' + esc(action.label) + '</button>' : '');
    t.hidden = false;
    t._fn = action ? action.fn : null;
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, action ? 6000 : 3200);
  }
  function openSheet(html) {
    var host = $('#sheetHost');
    var had = !!host.innerHTML;
    host.innerHTML = html;
    if (had) { var sh = host.querySelector('.sheet'); if (sh) sh.style.animation = 'none'; }
  }
  function closeSheet() { $('#sheetHost').innerHTML = ''; R = null; E = null; }

  /* ---------- Tabs ---------- */
  function setTab(t) {
    if (CK) closeCheck();
    tab = t;
    $$('.view').forEach(function (v) { v.classList.toggle('on', v.id === 'view-' + t); });
    $$('.tab').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false'); });
    if (t === 'coll') renderCollection();
    if (t === 'sets') { renderSets(); ensureSetList(); }
    if (t === 'scan') renderScanUI();
    syncCamera();
  }

  /* ---------- Scannen: Oberfläche ---------- */
  var statusT = null;
  function setStatus(t, ttl) {
    var el = $('#status');
    el.textContent = t || '';
    el.hidden = !t;
    clearTimeout(statusT);
    if (t && ttl !== 0) statusT = setTimeout(function () { el.hidden = true; el.textContent = ''; }, ttl || 6000);
  }
  function readyHint() {
    return S.settings.auto
      ? 'Kartenname in den Kasten halten'
      : 'Karte in den Rahmen halten, dann „Karte lesen“ tippen.';
  }
  function renderScanUI() {
    var all = loadedSets();
    var act = activeSets();
    var html = '';
    if (all.length > 1) html += '<button class="chip" data-act="chipAll" aria-pressed="' + (act.length === all.length) + '">Alle</button>';
    html += all.map(function (s) {
      return '<button class="chip" data-act="chipSet" data-code="' + esc(s.code) + '" aria-pressed="' + (!!s.active) + '">' +
        esc(s.name) + '<span class="mono">' + esc(s.code.toUpperCase()) + '</span></button>';
    }).join('');
    $('#setChips').innerHTML = html;
    $('#foilBtn').setAttribute('aria-pressed', S.settings.foilMode ? 'true' : 'false');
    $('#autoBtn').setAttribute('aria-pressed', S.settings.auto ? 'true' : 'false');
    var hasSets = act.length > 0;
    $('#scanBtn').disabled = !hasSets;
    var msg = $('#camMsg');
    if (!hasSets) {
      msg.hidden = false;
      msg.innerHTML = '<p><b>Noch keine Sets.</b><br>Füge zuerst die Editionen hinzu, die du scannen willst. Danach erkennt die App Karten nur innerhalb dieser Sets.</p><button class="btn primary" data-act="gotoSets">Sets hinzufügen</button>';
    } else if (!stream && !camError) {
      msg.hidden = true;
    }
  }

  /* ---------- Kamera ---------- */
  var video = $('#video');
  var cam = $('#cam');
  var overlay = $('#overlay');
  var stream = null;
  var camError = false;
  var starting = false;
  var busy = false;

  function camMsg(html) {
    var m = $('#camMsg');
    if (!html) { m.hidden = true; m.innerHTML = ''; return; }
    m.hidden = false; m.innerHTML = html;
  }
  async function startCam() {
    if (stream || starting) return;
    starting = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
      });
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* Autoplay-Hinweis ignorieren */ }
      camError = false;
      camMsg(null);
      drawOverlay();
      setStatus(readyHint(), 5000);
      getWorker().then(function () { if (!busy) setStatus(readyHint(), 5000); }).catch(function (e) { setStatus(e.message); });
    } catch (e) {
      camError = true;
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      camMsg('<p>' + (denied
        ? 'Kamerazugriff verweigert. Erlaube die Kamera in den Browser-Einstellungen oder tippe den Kartennamen ein.'
        : 'Die Kamera ist hier nicht verfügbar. Du kannst den Kartennamen eintippen.') + '</p><button class="btn" data-act="openManual">Namen eintippen</button>');
    } finally { starting = false; }
  }
  function stopCam() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    try { video.srcObject = null; } catch (e) { /* egal */ }
  }
  function syncCamera() {
    if (tab === 'scan' && activeSets().length && !document.hidden) startCam(); else stopCam();
  }
  function drawOverlay() {
    var r = cam.getBoundingClientRect();
    if (!r.width) return;
    var dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(r.width * dpr);
    overlay.height = Math.round(r.height * dpr);
    var ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    var g = Core.guideRect(r.width, r.height);
    var reg = Core.titleRegion(g);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, r.width, r.height);
    ctx.roundRect ? ctx.roundRect(g.x, g.y, g.w, g.h, 14) : ctx.rect(g.x, g.y, g.w, g.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    var L = 22;
    [[g.x, g.y, 1, 1], [g.x + g.w, g.y, -1, 1], [g.x, g.y + g.h, 1, -1], [g.x + g.w, g.y + g.h, -1, -1]].forEach(function (c) {
      ctx.beginPath();
      ctx.moveTo(c[0], c[1] + c[3] * L); ctx.lineTo(c[0], c[1]); ctx.lineTo(c[0] + c[2] * L, c[1]);
      ctx.stroke();
    });
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(82,209,179,0.95)';
    ctx.strokeRect(reg.x, reg.y, reg.w, reg.h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText('Kartenname hierhin', reg.x + 4, reg.y + reg.h + 16);
  }

  /* ---------- Texterkennung ---------- */
  var worker = null, workerP = null;
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error('Die Texterkennung konnte nicht geladen werden. Prüfe die Internetverbindung oder tippe den Namen ein.')); };
      document.head.appendChild(s);
    });
  }
  function getWorker() {
    if (worker) return Promise.resolve(worker);
    if (!workerP) {
      workerP = (async function () {
        if (!window.Tesseract) {
          setStatus('Texterkennung wird geladen …', 0);
          await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
        }
        var w = await Tesseract.createWorker(['deu', 'eng'], 1, {
          logger: function (m) {
            if (m && m.status && m.status !== 'recognizing text' && typeof m.progress === 'number') {
              setStatus('Texterkennung wird eingerichtet … ' + Math.round(m.progress * 100) + ' % (beim ersten Mal ca. 10 MB)', 0);
            }
          }
        });
        await w.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' });
        worker = w;
        return w;
      })().catch(function (e) { workerP = null; throw e; });
    }
    return workerP;
  }

  function captureTitle(mode) {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var r = cam.getBoundingClientRect();
    var g = Core.guideRect(r.width, r.height);
    var v = Core.toVideoRect(Core.titleRegion(g), r.width, r.height, vw, vh);
    var sx = Math.max(0, v.sx), sy = Math.max(0, v.sy);
    var sw = Math.min(vw - sx, v.sw), sh = Math.min(vh - sy, v.sh);
    var k = Math.max(0.5, Math.min(2.5, 110 / sh));
    var w = Math.max(200, Math.round(sw * k));
    var h = Math.max(40, Math.round(w * sh / sw));
    var pad = 14;
    var cv = document.createElement('canvas');
    cv.width = w + pad * 2; cv.height = h + pad * 2;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, sx, sy, sw, sh, pad, pad, w, h);
    var img = ctx.getImageData(pad, pad, w, h);
    var d = img.data, n = w * h;
    var gray = new Uint8Array(n), hist = new Uint32Array(256), i, p;
    for (i = 0, p = 0; i < d.length; i += 4, p++) {
      var y = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) | 0;
      gray[p] = y; hist[y]++;
    }
    if (mode === 'bin') {
      var th = Core.otsu(hist, n), white = 0;
      for (p = 0; p < n; p++) if (gray[p] > th) white++;
      var invert = white < n / 2;
      for (i = 0, p = 0; i < d.length; i += 4, p++) {
        var b = gray[p] > th ? 255 : 0;
        if (invert) b = 255 - b;
        d[i] = d[i + 1] = d[i + 2] = b; d[i + 3] = 255;
      }
    } else {
      var acc = 0, lo = 0, hi = 255, sum = 0;
      for (i = 0; i < 256; i++) { acc += hist[i]; if (acc < n * 0.02) lo = i; if (acc < n * 0.98) hi = i; sum += i * hist[i]; }
      var span = Math.max(1, hi - lo);
      var dark = sum / n < 110;
      for (i = 0, p = 0; i < d.length; i += 4, p++) {
        var s = Math.max(0, Math.min(255, ((gray[p] - lo) * 255) / span));
        if (dark) s = 255 - s;
        d[i] = d[i + 1] = d[i + 2] = s; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, pad, pad);
    return cv;
  }
  var sigCv = null;
  function captureSig() {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var r = cam.getBoundingClientRect();
    var g = Core.guideRect(r.width, r.height);
    var v = Core.toVideoRect(Core.titleRegion(g), r.width, r.height, vw, vh);
    var sx = Math.max(0, v.sx), sy = Math.max(0, v.sy);
    if (!sigCv) { sigCv = document.createElement('canvas'); sigCv.width = 96; sigCv.height = 16; }
    var ctx = sigCv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, sx, sy, Math.max(1, Math.min(vw - sx, v.sw)), Math.max(1, Math.min(vh - sy, v.sh)), 0, 0, 96, 16);
    var d = ctx.getImageData(0, 0, 96, 16).data;
    var out = new Uint8Array(96 * 16);
    for (var i = 0, p = 0; i < d.length; i += 4, p++) out[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    return out;
  }

  async function scanOnce() {
    if (busy) return;
    if (!activeSets().length) { toast('Füge zuerst ein Set hinzu.'); return; }
    if (!stream) { toast('Die Kamera ist nicht aktiv. Tippe den Namen ein.'); return; }
    busy = true;
    $('#scanBtn').disabled = true;
    setStatus('Lese Karte …', 0);
    while (autoBusy) await sleep(60);
    try {
      var w = await getWorker();
      var best = 0, bestList = [], lastText = '';
      var modes = ['bin', 'gray'];
      for (var i = 0; i < modes.length; i++) {
        var cv = captureTitle(modes[i]);
        if (!cv) { setStatus('Die Kamera ist noch nicht bereit. Gleich nochmal versuchen.'); return; }
        var res = await w.recognize(cv);
        lastText = (res.data.text || '').trim();
        var list = Core.matchText(INDEX, lastText);
        if (list.length && list[0].s > best) { best = list[0].s; bestList = list; }
        if (best >= 0.85) break;
      }
      if (!bestList.length) {
        setStatus('Nichts erkannt' + (lastText ? ' („' + lastText.slice(0, 40) + '“)' : '') + '. Karte näher ans Bild halten, Licht prüfen oder Namen tippen.');
        return;
      }
      setStatus('');
      armGuard();
      openResult(bestList, best);
    } catch (e) {
      setStatus(e.message || 'Beim Lesen ist ein Fehler aufgetreten.');
    } finally {
      busy = false;
      $('#scanBtn').disabled = !activeSets().length;
    }
  }

  /* ---------- Automatisches Erkennen ---------- */
  var autoBusy = false, autoPrev = null, autoRef = null, autoNeedChange = false, autoFails = 0, autoTimer = null;
  var autoConfirm = Core.createConfirmer(2);

  function autoActive() {
    return !!S.settings.auto && tab === 'scan' && !!stream && !busy && !R && !E && !CK &&
      $('#manualBox').hidden && !document.hidden && activeSets().length > 0 && video.videoWidth > 0;
  }
  /** Nach einem Treffer erst wieder auslösen, wenn eine andere Karte im Kasten liegt. */
  function armGuard() {
    autoRef = captureSig();
    autoNeedChange = !!autoRef;
    autoConfirm.reset();
    autoFails = 0;
  }
  function autoSchedule(ms) { clearTimeout(autoTimer); autoTimer = setTimeout(autoTick, ms); }
  async function autoTick() {
    if (!autoActive() || autoBusy) { autoPrev = null; autoSchedule(500); return; }
    autoBusy = true;
    var wait = 220;
    try {
      var sig = captureSig();
      if (!sig) { wait = 400; return; }
      var moved = autoPrev ? Core.sigDiff(sig, autoPrev) : 0;
      autoPrev = sig;
      if (autoNeedChange) {
        if (Core.sigDiff(sig, autoRef) > 22) { autoNeedChange = false; autoConfirm.reset(); }
        else { wait = 500; return; }
      }
      if (Core.sigSd(sig) < 9 || moved > 30) { autoConfirm.reset(); autoFails = 0; return; }
      wait = 300;
      var w = await getWorker();
      if (!autoActive()) return;
      var cv = captureTitle(autoFails % 2 ? 'gray' : 'bin');
      if (!cv) return;
      var res = await w.recognize(cv);
      if (!autoActive()) return;
      var list = Core.matchText(INDEX, res.data.text || '');
      var top = list[0];
      if (top && top.s >= Core.autoMin(top.c.n)) {
        setStatus('Erkenne: ' + (top.c.de || top.c.n) + ' …', 2500);
        if (autoConfirm.push(Core.norm(top.c.n))) {
          armGuard();
          setStatus('');
          openResult(list, top.s);
        }
      } else { autoConfirm.reset(); autoFails++; }
    } catch (e) {
      wait = 1500;
      setStatus(e.message || 'Fehler bei der Texterkennung.');
    } finally {
      autoBusy = false;
      autoSchedule(wait);
    }
  }

  /* ---------- Ergebnis-Sheet ---------- */
  var R = null; // {groups:[{s,cards}], gi, ci, foil, conf}
  function curCard() { return R.groups[R.gi].cards[R.ci]; }
  function fixFoil() {
    var c = curCard();
    if (!Core.canFoil(c)) R.foil = false;
    else if (!Core.canNonFoil(c)) R.foil = true;
  }
  function openResult(list, conf, pickId) {
    var groups = Core.groupByName(list);
    groups.forEach(function (g) {
      g.cards.sort(function (a, b) {
        var pa = Core.priceOf(a, false, S.settings.cur) != null ? 0 : 1;
        var pb = Core.priceOf(b, false, S.settings.cur) != null ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return (parseInt(a.cn, 10) || 0) - (parseInt(b.cn, 10) || 0);
      });
    });
    var gi = 0, ci = 0;
    if (pickId) {
      groups.forEach(function (g, i) {
        g.cards.forEach(function (c, j) { if (c.id === pickId) { gi = i; ci = j; } });
      });
    }
    R = { groups: groups, gi: gi, ci: ci, foil: !!S.settings.foilMode, conf: conf };
    fixFoil();
    renderResult();
  }
  function renderResult() {
    if (!R) return;
    var g = R.groups[R.gi], c = curCard();
    var p = Core.priceOf(c, R.foil, S.settings.cur);
    var owned = ownedQty(c.id);
    var low = R.conf < 0.72;
    var foilOk = Core.canFoil(c) && Core.canNonFoil(c);
    var html = '<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Erkannte Karte"><div class="grab"></div><div class="sheet-scroll">';
    if (low) html += '<div class="warn">Nicht sicher, ob das die richtige Karte ist. Prüfe den Namen oder wähle unten einen anderen Vorschlag.</div>';
    html += '<div class="sheet-top"><img class="cardimg" src="' + esc(bigImg(c)) + '" alt="' + esc(c.n) + '"><div>' +
      '<h2>' + esc(c.de || c.n) + '</h2>' + (c.de ? '<div class="sub">' + esc(c.n) + '</div>' : '') +
      '<div class="mono sub">' + esc(c.s.toUpperCase()) + ' · ' + esc(c.cn) + ' · ' + esc(RARITY[c.r] || '') + '</div>' +
      '<div class="price">' + (p == null ? 'kein Preis' : money(p)) + '</div>' +
      '<div class="sub">' + (R.foil ? 'Foil' : 'Normal') + ' · ' + (S.settings.cur === 'usd' ? 'TCGplayer' : 'Cardmarket') + '</div>' +
      '<div style="margin-top:8px"><button class="chip foil" data-act="resFoil" aria-pressed="' + R.foil + '"' + (foilOk ? '' : ' disabled') + '>Foil</button></div>' +
      (owned ? '<p class="owned">Schon ' + owned + '× in deiner Sammlung</p>' : '') +
      '</div></div>';
    if (g.cards.length > 1) {
      html += '<div class="subtle">Druck</div><div class="chips">' + g.cards.map(function (x, i) {
        return '<button class="chip" data-act="resPrint" data-i="' + i + '" aria-pressed="' + (i === R.ci) + '">' + esc(x.s.toUpperCase()) +
          '<span class="mono">#' + esc(x.cn) + '</span></button>';
      }).join('') + '</div>';
    }
    if (R.groups.length > 1) {
      html += '<div class="subtle">Andere Vorschläge</div><div class="chips">' + R.groups.slice(0, 6).map(function (x, i) {
        if (i === R.gi) return '';
        var cc = x.cards[0];
        return '<button class="chip" data-act="resGroup" data-i="' + i + '">' + esc(cc.de || cc.n) + '</button>';
      }).join('') + '</div>';
    }
    html += '</div><div class="acts2"><button class="btn" data-act="closeSheet">Verwerfen</button><button class="btn primary" data-act="resAdd">Zur Sammlung</button></div></div></div>';
    openSheet(html);
  }

  /* ---------- Tippen-Suche ---------- */
  function renderSuggest() {
    var q = $('#q').value;
    var list = Core.searchName(INDEX, q, 8);
    $('#sugg').innerHTML = list.map(function (m) {
      var c = m.c;
      return '<li><button class="row" style="grid-template-columns:28px 1fr auto;padding:6px" data-act="pickSugg" data-id="' + esc(c.id) + '">' +
        '<img class="thumb" style="width:28px;height:39px" src="' + esc(c.img || '') + '" alt="" loading="lazy">' +
        '<span class="rowmain"><span class="nm">' + esc(c.de || c.n) + '</span>' + (c.de ? '<br><span class="sub">' + esc(c.n) + '</span>' : '') + '</span>' +
        '<span class="mono sub">' + esc(c.s.toUpperCase()) + ' #' + esc(c.cn) + '</span></button></li>';
    }).join('');
  }
  function pickSuggestion(id) {
    var list = Core.searchName(INDEX, $('#q').value, 30);
    if (!list.length) return;
    openResult(list, 1, id);
  }

  /* ---------- Sammlung: Ansicht ---------- */
  var collFilter = { set: 'all', q: '' };
  var E = null; // geöffneter Sammlungseintrag (Schlüssel)

  function sparkSVG(vals) {
    if (vals.length < 2) return '';
    var w = 120, h = 34;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), rng = max - min || 1;
    var pts = vals.map(function (v, i) {
      return [(i / (vals.length - 1)) * (w - 6) + 3, h - 4 - ((v - min) / rng) * (h - 10)];
    });
    var last = pts[pts.length - 1];
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Gesamtwert über die Zeit"><polyline points="' +
      pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/><circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3"/></svg>';
  }
  function renderCollection() {
    var body = $('#collBody');
    var entries = Object.keys(S.collection);
    if (!entries.length) {
      body.innerHTML = '<h1>Sammlung</h1><div class="empty"><h2>Noch keine Karten</h2><p>Scanne deine erste Karte im Tab „Scannen“. Der Gesamtwert und die Preise erscheinen dann hier.</p><button class="btn primary" data-act="gotoScan">Zum Scannen</button></div>';
      return;
    }
    var t = totals();
    var cur = S.settings.cur;
    var hist = S.history.filter(function (h) { return h.cur === cur; });
    var vals = hist.slice(-30).map(function (h) { return h.v; });
    var lastChg = null;
    for (var i = hist.length - 1; i >= 0; i--) { if (hist[i].chg != null) { lastChg = hist[i]; break; } }
    var setsIn = {};
    entries.forEach(function (k) { var c = BYID.get(S.collection[k].id); if (c) setsIn[c.s] = c.sn; });
    var html = '<div class="hero"><div><div class="label">Gesamtwert</div><div class="big">' + money(t.value) + '</div>';
    if (lastChg && Math.abs(lastChg.chg) >= 0.005) {
      html += '<div class="delta ' + (lastChg.chg >= 0 ? 'up' : 'down') + '">' + (lastChg.chg >= 0 ? '+' : '−') + money(Math.abs(lastChg.chg)) + ' beim Preis-Update am ' + esc(lastChg.d.split('-').reverse().join('.')) + '</div>';
    }
    html += '</div>' + sparkSVG(vals) + '</div>';
    html += '<div class="facts"><div class="fact"><b>' + t.cards + '</b><span>Karten</span></div><div class="fact"><b>' + t.uniq + '</b><span>verschiedene</span></div><div class="fact"><b>' + t.missing + '</b><span>ohne Preis</span></div></div>';
    html += '<div class="tools"><input class="field" id="cq" type="search" placeholder="In der Sammlung suchen" value="' + esc(collFilter.q) + '" autocomplete="off">';
    html += '<div class="split"><div class="chips"><button class="chip" data-act="collSet" data-code="all" aria-pressed="' + (collFilter.set === 'all') + '">Alle</button>' +
      Object.keys(setsIn).map(function (code) {
        return '<button class="chip" data-act="collSet" data-code="' + esc(code) + '" aria-pressed="' + (collFilter.set === code) + '">' + esc(code.toUpperCase()) + '</button>';
      }).join('') + '</div>' +
      '<select class="field" id="csort" aria-label="Sortierung"><option value="value"' + (S.settings.sort === 'value' ? ' selected' : '') + '>Wert</option><option value="name"' + (S.settings.sort === 'name' ? ' selected' : '') + '>Name</option><option value="recent"' + (S.settings.sort === 'recent' ? ' selected' : '') + '>Zuletzt</option></select></div></div>';
    html += '<ul class="list" id="collList"></ul>';
    body.innerHTML = html;
    renderCollList();
  }
  function renderCollList() {
    var cur = S.settings.cur;
    var nq = Core.norm(collFilter.q);
    var rows = Object.keys(S.collection).map(function (k) { return { k: k, e: S.collection[k], c: BYID.get(S.collection[k].id) }; })
      .filter(function (r) { return r.c; })
      .filter(function (r) { return collFilter.set === 'all' || r.c.s === collFilter.set; })
      .filter(function (r) { return !nq || Core.norm((r.c.de || '') + ' ' + r.c.n).indexOf(nq) > -1; });
    var val = function (r) { var p = Core.priceOf(r.c, r.e.foil, cur); return (p || 0) * r.e.qty; };
    rows.sort(function (a, b) {
      if (S.settings.sort === 'name') return (a.c.de || a.c.n).localeCompare(b.c.de || b.c.n, 'de');
      if (S.settings.sort === 'recent') return (b.e.at || 0) - (a.e.at || 0);
      return val(b) - val(a);
    });
    var ul = $('#collList');
    if (!ul) return;
    ul.innerHTML = rows.length ? rows.map(function (r) {
      var p = Core.priceOf(r.c, r.e.foil, cur);
      return '<li><button class="row" data-act="openEntry" data-k="' + esc(r.k) + '"><img class="thumb" src="' + esc(r.c.img || '') + '" alt="" loading="lazy">' +
        '<span class="rowmain"><span class="nm">' + esc(r.c.de || r.c.n) + (r.e.foil ? '<span class="foilbadge">Foil</span>' : '') + '</span>' +
        (r.c.de ? '<br><span class="sub">' + esc(r.c.n) + '</span>' : '') + '<br><span class="mono sub">' + esc(r.c.s.toUpperCase()) + ' · ' + esc(r.c.cn) + ' · ' + esc(r.e.cond || 'NM') + '</span></span>' +
        '<span class="rowend"><span class="qty">' + r.e.qty + '×</span><br><span class="val">' + (p == null ? '–' : money(p * r.e.qty)) + '</span></span></button></li>';
    }).join('') : '<li class="empty">Keine Treffer.</li>';
  }

  function renderEntry() {
    if (!E) return;
    var e = S.collection[E];
    if (!e) { closeSheet(); return; }
    var c = BYID.get(e.id);
    var p = Core.priceOf(c, e.foil, S.settings.cur);
    var both = Core.canFoil(c) && Core.canNonFoil(c);
    var conds = ['NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
    openSheet('<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Karte in der Sammlung"><div class="grab"></div><div class="sheet-scroll">' +
      '<div class="sheet-top"><img class="cardimg" src="' + esc(bigImg(c)) + '" alt="' + esc(c.n) + '"><div>' +
      '<h2>' + esc(c.de || c.n) + '</h2>' + (c.de ? '<div class="sub">' + esc(c.n) + '</div>' : '') +
      '<div class="mono sub">' + esc(c.s.toUpperCase()) + ' · ' + esc(c.cn) + ' · ' + esc(c.sn || '') + '</div>' +
      '<div class="price">' + (p == null ? 'kein Preis' : money(p * e.qty)) + '</div>' +
      '<div class="sub">' + (p == null ? 'Für diese Variante liegt kein Preis vor.' : money(p) + ' pro Karte') + '</div>' +
      '<div style="margin-top:8px"><button class="chip foil" data-act="entFoil" aria-pressed="' + e.foil + '"' + (both ? '' : ' disabled') + '>Foil</button></div></div></div>' +
      '<div class="setting"><span>Anzahl</span><span class="stepper"><button data-act="entDec" aria-label="Eine weniger">−</button><output>' + e.qty + '</output><button data-act="entInc" aria-label="Eine mehr">+</button></span></div>' +
      '<div class="setting"><label for="cond">Zustand</label><select class="field" id="cond">' + conds.map(function (x) { return '<option' + (x === (e.cond || 'NM') ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></div>' +
      '<p class="hint">Der Zustand ist nur eine Notiz. Die Preise gelten für Karten in gutem Zustand (Near Mint) und werden nicht angepasst.</p></div>' +
      '<div class="acts2"><button class="btn danger" data-act="entRemove">Entfernen</button><a class="btn" style="text-align:center;text-decoration:none" href="' + esc(c.uri || '#') + '" target="_blank" rel="noopener">Bei Scryfall öffnen</a></div></div></div>');
  }

  /* ---------- Sets: Ansicht ---------- */
  var setQ = '';
  async function ensureSetList() {
    if (SETLIST || !navigator.onLine) return;
    try { await getSetList(); if (tab === 'sets') renderSets(); } catch (e) { /* Hinweis erscheint beim Suchen */ }
  }
  function setsReferenced(code) {
    return Object.keys(S.collection).some(function (k) { var c = BYID.get(S.collection[k].id); return c && c.s === code; });
  }
  function renderSets() {
    var body = $('#setsBody');
    var focused = document.activeElement && document.activeElement.id === 'sq';
    var html = '<h1>Sets</h1><p class="hint">Hier legst du fest, welche Editionen du besitzt. Beim Scannen wird nur innerhalb der aktiven Sets gesucht.</p>';
    html += '<h2 class="sec">Meine Sets</h2>';
    if (!S.sets.length) html += '<div class="card hint">Noch kein Set. Suche unten zum Beispiel nach „Kaladesh“.</div>';
    S.sets.forEach(function (s) {
      var load = LOAD.get(s.code);
      html += '<div class="card setrow"><div class="top"><b>' + esc(s.name) + '</b><span class="mono">' + esc(s.code.toUpperCase()) + '</span></div>' +
        '<div class="hint">' + (load ? esc(load) : (s.count || 0) + ' Karten · ' + ownedInSet(s.code) + ' in deiner Sammlung · Preise ' + ago(s.loadedAt)) + '</div>' +
        (load ? '<div class="progress"><i></i></div>' : '<div class="acts"><button class="btn small primary" data-act="ckOpen" data-code="' + esc(s.code) + '">Checkliste</button><button class="btn small" data-act="setRefresh" data-code="' + esc(s.code) + '">Preise aktualisieren</button>' +
          '<button class="btn small danger" data-act="setRemove" data-code="' + esc(s.code) + '">Entfernen</button></div>') + '</div>';
    });
    if (S.sets.length > 1) html += '<p><button class="btn small" data-act="refreshAll">Alle Preise aktualisieren</button></p>';
    html += '<h2 class="sec">Set hinzufügen</h2><input class="field" id="sq" type="search" placeholder="Name oder Kürzel, z. B. Kaladesh oder KLD" autocomplete="off" value="' + esc(setQ) + '">';
    var nq = Core.norm(setQ);
    if (nq.length >= 2) {
      if (!SETLIST) html += '<p class="hint">' + (navigator.onLine ? 'Setliste wird geladen …' : 'Zum Suchen wird eine Internetverbindung gebraucht.') + '</p>';
      else {
        var res = SETLIST.filter(function (s) { return Core.norm(s.name).indexOf(nq) > -1 || s.code === nq; })
          .sort(function (a, b) { return (b.released_at || '').localeCompare(a.released_at || ''); }).slice(0, 25);
        html += '<ul class="list" style="margin-top:8px">' + (res.map(function (s) {
          var have = !!getSet(s.code);
          return '<li><button class="row" style="grid-template-columns:1fr auto" data-act="addSet" data-code="' + esc(s.code) + '"' + (have ? ' disabled' : '') + '>' +
            '<span class="rowmain"><span class="nm">' + esc(s.name) + '</span><br><span class="mono sub">' + esc(s.code.toUpperCase()) + ' · ' + esc((s.released_at || '').slice(0, 4)) + ' · ' + s.card_count + ' Karten</span></span>' +
            '<span class="sub">' + (have ? 'hinzugefügt' : 'Hinzufügen') + '</span></button></li>';
        }).join('') || '<li class="hint">Kein Set gefunden.</li>') + '</ul>';
      }
    }
    html += '<h2 class="sec">Einstellungen</h2><div class="card">' +
      '<div class="setting"><span>Währung</span><span class="seg"><button data-act="cur" data-v="eur" aria-pressed="' + (S.settings.cur === 'eur') + '">EUR</button><button data-act="cur" data-v="usd" aria-pressed="' + (S.settings.cur === 'usd') + '">USD</button></span></div>' +
      '<div class="setting"><span>Beim Scannen mehrere Sets gleichzeitig<br><span class="hint">Aus: Ein Tipp wählt genau ein Set.</span></span><button class="chip" data-act="multi" aria-pressed="' + S.settings.multi + '">' + (S.settings.multi ? 'An' : 'Aus') + '</button></div></div>';
    html += '<h2 class="sec">Sicherung</h2><div class="card"><p class="hint" style="margin-top:0">Deine Sammlung liegt nur in diesem Browser. Sichere sie ab und zu, besonders vor dem Löschen von Browserdaten.</p>' +
      '<div class="acts" style="display:flex;flex-wrap:wrap;gap:8px"><button class="btn small" data-act="exportJson">Sicherung (JSON)</button><button class="btn small" data-act="exportCsv">Tabelle (CSV)</button><button class="btn small" data-act="importJson">Sicherung laden</button></div>' +
      '<input type="file" id="importFile" accept="application/json,.json" hidden></div>';
    html += '<p class="hint" style="margin-top:20px">Preise und Kartendaten: Scryfall (Cardmarket in EUR, TCGplayer in USD). Sie werden dort einmal täglich aktualisiert und gelten für die englische Ausgabe.</p>';
    body.innerHTML = html;
    if (focused) { var el = $('#sq'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  }

  /* ---------- Checkliste je Set ---------- */
  var CK = null; // {code, name, cards, st, rar, q}
  var CK_RAR = [['common', 'C'], ['uncommon', 'U'], ['rare', 'R'], ['mythic', 'M']];
  function byNumber(a, b) {
    var na = parseInt(a.cn, 10) || 0, nb = parseInt(b.cn, 10) || 0;
    return na - nb || (a.cn < b.cn ? -1 : a.cn > b.cn ? 1 : 0);
  }
  function ownedInSet(code) {
    var ids = {};
    Object.keys(S.collection).forEach(function (k) {
      var c = BYID.get(S.collection[k].id);
      if (c && c.s === code) ids[c.id] = 1;
    });
    return Object.keys(ids).length;
  }
  function dropAll(id) { delete S.collection[ckey(id, false)]; delete S.collection[ckey(id, true)]; }
  function ckFiltered() { return CK.st !== 'all' || !!CK.q.trim() || CK_RAR.some(function (r) { return CK.rar[r[0]]; }); }
  function ckVisible() {
    var nq = Core.norm(CK.q), num = CK.q.trim();
    var rars = CK_RAR.map(function (r) { return r[0]; }).filter(function (r) { return CK.rar[r]; });
    return CK.cards.filter(function (c) {
      var own = ownedQty(c.id) > 0;
      if (CK.st === 'own' && !own) return false;
      if (CK.st === 'miss' && own) return false;
      if (rars.length && rars.indexOf(c.r) < 0) return false;
      if (nq && Core.norm((c.de || '') + ' ' + c.n).indexOf(nq) < 0 && c.cn !== num) return false;
      return true;
    });
  }
  function ckStats() {
    var own = 0, val = 0;
    CK.cards.forEach(function (c) {
      var q = 0;
      [false, true].forEach(function (f) {
        var e = S.collection[ckey(c.id, f)];
        if (!e) return;
        q += e.qty;
        var p = Core.priceOf(c, f, S.settings.cur);
        if (p != null) val += p * e.qty;
      });
      if (q) own++;
    });
    return { own: own, total: CK.cards.length, val: val };
  }
  function ckCell(c) {
    var q = ownedQty(c.id);
    return '<button class="cell ' + (q ? 'own' : 'miss') + '" data-act="ckToggle" data-id="' + esc(c.id) + '" aria-pressed="' + (q > 0) + '" aria-label="' + esc(c.de || c.n) + '">' +
      '<span class="cimg"><img src="' + esc(c.img || '') + '" alt="" loading="lazy"><span class="tick">✓</span>' + (q > 1 ? '<span class="qb">×' + q + '</span>' : '') + '</span>' +
      '<span class="cap"><span class="mono">' + esc(c.cn) + '</span> ' + esc(c.de || c.n) + '</span></button>';
  }
  function openCheck(code) {
    var s = getSet(code);
    if (!s || !CARDS.has(code)) { toast('Dieses Set ist noch nicht geladen.'); return; }
    CK = { code: code, name: s.name, cards: CARDS.get(code).slice().sort(byNumber), st: 'all', rar: {}, q: '' };
    renderCheckShell();
  }
  function closeCheck() {
    CK = null;
    var h = $('#checkHost');
    h.innerHTML = '';
    h.hidden = true;
    if (tab === 'sets') renderSets();
  }
  function renderCheckShell() {
    var h = $('#checkHost');
    h.hidden = false;
    h.innerHTML =
      '<div class="ck-head gut"><button class="btn small" data-act="ckBack">‹ Zurück</button><div class="ck-title"><b>' + esc(CK.name) + '</b><span class="mono" id="ckSub"></span></div></div>' +
      '<div class="ck-tools gut"><input class="field" id="ckq" type="search" placeholder="Name oder Nummer suchen" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="chips" id="ckChips"></div></div>' +
      '<p class="hint ck-hint gut" id="ckHint" hidden>Tipp: Unten „Alle markieren“ tippen, dann die Karten antippen, die dir fehlen.</p>' +
      '<div class="ck-scroll gut" id="ckScroll"><div class="ck-grid" id="ckGrid"></div></div>' +
      '<div class="ck-bar gut"><span class="hint" id="ckVis"></span><div class="ck-bar-btns"><button class="btn small primary" id="ckAllBtn" data-act="ckAll">Alle markieren</button><button class="btn small" id="ckNoneBtn" data-act="ckNone">Alle abwählen</button></div></div>';
    renderCheckGrid(false);
  }
  function ckHeader() {
    var st = ckStats();
    $('#ckSub').textContent = st.own + ' von ' + st.total + ' · ' + money(st.val);
    return st;
  }
  function renderCheckGrid(keep) {
    var sc = $('#ckScroll');
    var top = sc.scrollTop || 0;
    var vis = ckVisible();
    var st = ckHeader();
    $('#ckChips').innerHTML = [['all', 'Alle'], ['own', 'Habe'], ['miss', 'Fehlt']].map(function (x) {
      return '<button class="chip" data-act="ckSt" data-v="' + x[0] + '" aria-pressed="' + (CK.st === x[0]) + '">' + x[1] + '</button>';
    }).join('') + CK_RAR.map(function (r) {
      return '<button class="chip" data-act="ckRar" data-v="' + r[0] + '" aria-pressed="' + (!!CK.rar[r[0]]) + '">' + r[1] + '</button>';
    }).join('');
    $('#ckGrid').innerHTML = vis.length ? vis.map(ckCell).join('') : '<p class="empty">Keine Karten für diesen Filter.</p>';
    var f = ckFiltered();
    $('#ckAllBtn').textContent = f ? 'Sichtbare markieren' : 'Alle markieren';
    $('#ckNoneBtn').textContent = f ? 'Sichtbare abwählen' : 'Alle abwählen';
    $('#ckVis').textContent = vis.length + ' angezeigt';
    $('#ckHint').hidden = !(st.own === 0 && !f);
    sc.scrollTop = keep ? top : 0;
  }
  function ckUpdateCell(id) {
    var grid = $('#ckGrid');
    var el = grid && grid.querySelector('[data-id="' + id + '"]');
    var c = BYID.get(id);
    if (el && c) el.outerHTML = ckCell(c);
  }
  function ckToggle(id) {
    var c = BYID.get(id);
    if (!c) return;
    var q = ownedQty(id);
    if (q > 0) {
      var copy = [false, true].map(function (f) { var e = S.collection[ckey(id, f)]; return e ? Object.assign({}, e) : null; });
      dropAll(id);
      save(); recordHistory(null);
      if (q > 1) {
        toast((c.de || c.n) + ' (' + q + '×) entfernt', { label: 'Rückgängig', fn: function () {
          copy.forEach(function (e) { if (e) S.collection[ckey(e.id, e.foil)] = e; });
          save(); recordHistory(null);
          if (CK) { ckUpdateCell(id); ckHeader(); }
        } });
      }
    } else addCard(c, !Core.canNonFoil(c), 1);
    ckUpdateCell(id);
    ckHeader();
  }
  function ckBulk(on) {
    var vis = ckVisible();
    var todo = vis.filter(function (c) { return on ? !ownedQty(c.id) : ownedQty(c.id) > 0; });
    if (!todo.length) { toast(on ? 'Alle angezeigten Karten sind schon markiert.' : 'Keine markierte Karte angezeigt.'); return; }
    if (!on && todo.length > 20 && !window.confirm(todo.length + ' Karten aus der Sammlung nehmen?')) return;
    var snap = JSON.stringify(S.collection);
    todo.forEach(function (c) {
      if (on) {
        var foil = !Core.canNonFoil(c);
        S.collection[ckey(c.id, foil)] = { id: c.id, foil: foil, qty: 1, cond: 'NM', at: Date.now() };
      } else dropAll(c.id);
    });
    save(); recordHistory(null);
    renderCheckGrid(true);
    toast(todo.length + (on ? ' Karten markiert' : ' Karten abgewählt'), { label: 'Rückgängig', fn: function () {
      S.collection = JSON.parse(snap);
      save(); recordHistory(null);
      if (CK) renderCheckGrid(true);
    } });
  }

  /* ---------- Export / Import ---------- */
  function download(name, text, type) {
    var b = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }
  function exportCsv() {
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var cur = S.settings.cur;
    var lines = [['Menge', 'Name (de)', 'Name (en)', 'Set', 'Nr.', 'Foil', 'Zustand', 'Einzelpreis ' + cur.toUpperCase(), 'Summe ' + cur.toUpperCase()].map(q).join(';')];
    Object.keys(S.collection).forEach(function (k) {
      var e = S.collection[k], c = BYID.get(e.id);
      if (!c) return;
      var p = Core.priceOf(c, e.foil, cur);
      lines.push([e.qty, c.de || '', c.n, c.s.toUpperCase(), c.cn, e.foil ? 'ja' : 'nein', e.cond || 'NM',
        p == null ? '' : String(p).replace('.', ','), p == null ? '' : String(Math.round(p * e.qty * 100) / 100).replace('.', ',')].map(q).join(';'));
    });
    download('kartenmappe-' + localDate() + '.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }
  function exportJson() {
    download('kartenmappe-sicherung-' + localDate() + '.json', JSON.stringify({ v: 1, sets: S.sets, collection: S.collection, settings: S.settings, history: S.history }), 'application/json');
  }
  async function importJson(file) {
    try {
      var data = JSON.parse(await file.text());
      if (!data || !data.collection || !Array.isArray(data.sets)) throw new Error('bad');
      if (!window.confirm('Die aktuelle Sammlung wird durch die Sicherung ersetzt. Fortfahren?')) return;
      S.collection = data.collection;
      S.history = data.history || [];
      S.settings = Object.assign(S.settings, data.settings || {});
      var known = {};
      S.sets.forEach(function (s) { known[s.code] = s; });
      var missing = [];
      data.sets.forEach(function (s) {
        if (known[s.code]) known[s.code].active = !!s.active;
        else { S.sets.push({ code: s.code, name: s.name, date: s.date, count: 0, active: !!s.active, loadedAt: 0 }); missing.push(s.code); }
      });
      save();
      toast('Sicherung geladen.');
      for (var i = 0; i < missing.length; i++) {
        var code = missing[i];
        LOAD.set(code, 'Lade Karten …');
        renderSets();
        try {
          var cards = await fetchSet(code, {});
          CARDS.set(code, cards);
          await DB.set('cards:' + code, cards);
          var s2 = getSet(code); s2.loadedAt = Date.now(); s2.count = cards.length;
        } catch (e) { toast('Set ' + code.toUpperCase() + ' konnte nicht geladen werden.'); }
        LOAD.delete(code);
      }
      rebuild(); save(); renderSets(); renderScanUI();
    } catch (e) { toast('Diese Datei ist keine gültige Sicherung.'); }
  }

  /* ---------- Aktionen ---------- */
  var actions = {
    scrim: function (t, e) { if (e.target === t) closeSheet(); },
    closeSheet: function () { closeSheet(); },
    toastAction: function () { var t = $('#toast'); if (t._fn) t._fn(); t.hidden = true; },
    gotoSets: function () { setTab('sets'); },
    gotoScan: function () { setTab('scan'); },
    openManual: function () { setManual(true); },
    chipSet: function (t) {
      var s = getSet(t.dataset.code);
      if (S.settings.multi) { s.active = !s.active; if (!activeSets().length) s.active = true; }
      else S.sets.forEach(function (x) { x.active = x.code === s.code; });
      save(); rebuild(); renderScanUI(); if ($('#q').value) renderSuggest();
    },
    chipAll: function () { S.sets.forEach(function (x) { x.active = true; }); save(); rebuild(); renderScanUI(); },
    resFoil: function () { R.foil = !R.foil; renderResult(); },
    resPrint: function (t) { R.ci = +t.dataset.i; fixFoil(); renderResult(); },
    resGroup: function (t) { R.gi = +t.dataset.i; R.ci = 0; R.conf = R.groups[R.gi].s; fixFoil(); renderResult(); },
    resAdd: function () {
      var c = curCard(), foil = R.foil;
      addCard(c, foil, 1);
      var q = ownedQty(c.id);
      var k = ckey(c.id, foil);
      closeSheet();
      toast((c.de || c.n) + ' hinzugefügt (jetzt ' + q + '×)', { label: 'Rückgängig', fn: function () { removeCard(k, 1); if (tab === 'coll') renderCollection(); } });
    },
    pickSugg: function (t) { pickSuggestion(t.dataset.id); },
    collSet: function (t) { collFilter.set = t.dataset.code; renderCollection(); },
    openEntry: function (t) { E = t.dataset.k; renderEntry(); },
    entInc: function () { S.collection[E].qty++; save(); recordHistory(null); renderEntry(); if (tab === 'coll') renderCollection(); },
    entDec: function () {
      var e = S.collection[E];
      if (e.qty <= 1) { actions.entRemove(); return; }
      e.qty--; save(); recordHistory(null); renderEntry(); if (tab === 'coll') renderCollection();
    },
    entFoil: function () {
      var e = S.collection[E];
      var nk = ckey(e.id, !e.foil);
      var other = S.collection[nk];
      delete S.collection[E];
      if (other) other.qty += e.qty; else { e.foil = !e.foil; S.collection[nk] = e; }
      E = nk; save(); recordHistory(null); renderEntry(); renderCollection();
    },
    entRemove: function () {
      var k = E, e = S.collection[k];
      if (!e) return;
      var copy = Object.assign({}, e);
      delete S.collection[k];
      save(); recordHistory(null);
      closeSheet(); renderCollection();
      toast('Karte entfernt', { label: 'Rückgängig', fn: function () { S.collection[k] = copy; save(); recordHistory(null); renderCollection(); } });
    },
    addSet: function (t) {
      var meta = (SETLIST || []).filter(function (s) { return s.code === t.dataset.code; })[0];
      if (meta) addSet(meta);
    },
    setRefresh: function (t) { refreshSets([t.dataset.code], false); },
    refreshAll: function () { refreshSets(S.sets.map(function (s) { return s.code; }), false); },
    setRemove: function (t) {
      var code = t.dataset.code;
      if (setsReferenced(code)) { toast('Aus diesem Set sind Karten in deiner Sammlung. Entferne sie zuerst.'); return; }
      if (!window.confirm('Set aus der Liste entfernen?')) return;
      S.sets = S.sets.filter(function (s) { return s.code !== code; });
      CARDS.delete(code); DB.del('cards:' + code).catch(function () {});
      if (!activeSets().length && S.sets.length) S.sets[0].active = true;
      rebuild(); save(); renderSets(); renderScanUI(); syncCamera();
    },
    cur: function (t) { S.settings.cur = t.dataset.v; save(); renderSets(); },
    multi: function () { S.settings.multi = !S.settings.multi; save(); renderSets(); },
    ckOpen: function (t) { openCheck(t.dataset.code); },
    ckBack: function () { closeCheck(); },
    ckSt: function (t) { if (CK) { CK.st = t.dataset.v; renderCheckGrid(false); } },
    ckRar: function (t) { if (CK) { CK.rar[t.dataset.v] = !CK.rar[t.dataset.v]; renderCheckGrid(false); } },
    ckToggle: function (t) { if (CK) ckToggle(t.dataset.id); },
    ckAll: function () { if (CK) ckBulk(true); },
    ckNone: function () { if (CK) ckBulk(false); },
    exportJson: exportJson,
    exportCsv: exportCsv,
    importJson: function () { $('#importFile').click(); }
  };

  function setManual(on) {
    $('#manualBox').hidden = !on;
    $('#view-scan').classList.toggle('typing', on);
    if (!on) armGuard();
    $('#manualBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) { $('#q').focus(); renderSuggest(); }
  }

  /* ---------- Ereignisse ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (t && actions[t.dataset.act] && !t.disabled) { actions[t.dataset.act](t, e); return; }
    var tb = e.target.closest('[data-tab]');
    if (tb) setTab(tb.dataset.tab);
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') renderSuggest();
    else if (e.target.id === 'cq') { collFilter.q = e.target.value; renderCollList(); }
    else if (e.target.id === 'sq') { setQ = e.target.value; renderSets(); if (!SETLIST) ensureSetList(); }
    else if (e.target.id === 'ckq' && CK) { CK.q = e.target.value; renderCheckGrid(false); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'csort') { S.settings.sort = e.target.value; save(); renderCollList(); }
    else if (e.target.id === 'cond' && E && S.collection[E]) { S.collection[E].cond = e.target.value; save(); renderCollList(); }
    else if (e.target.id === 'importFile' && e.target.files[0]) { importJson(e.target.files[0]); e.target.value = ''; }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if ($('#sheetHost').innerHTML) closeSheet(); else if (CK) closeCheck(); }
    if (e.key === 'Enter' && e.target.id === 'q') {
      var first = Core.searchName(INDEX, e.target.value, 1)[0];
      if (first) pickSuggestion(first.c.id);
    }
  });
  $('#scanBtn').addEventListener('click', scanOnce);
  $('#autoBtn').addEventListener('click', function () {
    S.settings.auto = !S.settings.auto;
    save();
    $('#autoBtn').setAttribute('aria-pressed', S.settings.auto ? 'true' : 'false');
    setStatus(readyHint(), 4000);
    armGuard();
  });
  cam.addEventListener('click', function (e) { if (!e.target.closest('button')) scanOnce(); });
  $('#manualBtn').addEventListener('click', function () { setManual($('#manualBox').hidden); });
  $('#foilBtn').addEventListener('click', function () {
    S.settings.foilMode = !S.settings.foilMode; save();
    $('#foilBtn').setAttribute('aria-pressed', S.settings.foilMode ? 'true' : 'false');
  });
  document.addEventListener('visibilitychange', syncCamera);
  window.addEventListener('pagehide', function () { DB.set('state', S).catch(function () {}); });
  /** App-Höhe an den wirklich sichtbaren Bereich koppeln (Browserleisten, Tastatur). */
  function fitViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var root = document.documentElement;
    root.style.setProperty('--app-h', Math.round(vv.height) + 'px');
    root.style.setProperty('--app-top', Math.round(vv.offsetTop) + 'px');
    $('#app').classList.toggle('kbd', vv.height < window.innerHeight - 140);
    drawOverlay();
  }
  window.addEventListener('resize', fitViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }
  document.addEventListener('focusout', function () { setTimeout(function () { if (window.scrollTo) window.scrollTo(0, 0); }, 60); });
  if (window.ResizeObserver) new ResizeObserver(drawOverlay).observe(cam);

  /* ---------- Start ---------- */
  (async function init() {
    await loadAll();
    fitViewport();
    autoSchedule(800);
    if (!S.sets.length) tab = 'scan';
    setTab('scan');
    renderScanUI();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
    autoRefresh();
  })();
})();
