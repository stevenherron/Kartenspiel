/* Kartenmappe – Kernlogik ohne DOM-Zugriff (im Browser und in Node testbar) */
(function (root) {
  'use strict';

  /** Normalisiert Namen für den Vergleich: klein, ohne Akzente, ß→ss, Umlaute→Grundbuchstabe. */
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/æ/g, 'ae')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Levenshtein-Distanz mit zwei Zeilen. */
  function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= b.length; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  }

  function sim(a, b) {
    if (!a || !b) return 0;
    return 1 - lev(a, b) / Math.max(a.length, b.length);
  }

  /** Ähnlichkeit zwischen OCR-Text und Kartenname. Toleriert Rauschen am Ende (Manasymbole). */
  function score(cand, key) {
    if (cand.length < key.length * 0.5) return 0;
    let s = sim(cand, key);
    if (cand.length > key.length) {
      s = Math.max(
        s,
        sim(cand.slice(0, key.length), key) * 0.97,
        sim(cand.slice(0, key.length + 1), key) * 0.97
      );
    }
    return s;
  }

  /** Aus dem OCR-Text mehrere Lesarten bilden (ohne kurze Rand-Fragmente). */
  function candidatesFromText(text) {
    const out = new Set();
    const lines = String(text || '').split(/\n+/).map(norm).filter(function (l) { return l.length >= 3; });
    lines.forEach(function (l) {
      out.add(l);
      const t = l.split(' ');
      let a = t.slice();
      while (a.length > 1 && a[0].length <= 2) a.shift();
      out.add(a.join(' '));
      a = t.slice();
      while (a.length > 1 && a[a.length - 1].length <= 2) a.pop();
      out.add(a.join(' '));
      a = t.slice();
      while (a.length > 1 && a[0].length <= 2) a.shift();
      while (a.length > 1 && a[a.length - 1].length <= 2) a.pop();
      out.add(a.join(' '));
    });
    return Array.from(out).filter(function (x) { return x.length >= 3; });
  }

  /** Alle Namen einer Karte (englisch und deutsch, je Kartenseite). */
  function namesOf(card) {
    const out = [];
    String(card.n || '').split(' // ').forEach(function (x) { if (x) out.push(x); });
    if (card.de) String(card.de).split(' // ').forEach(function (x) { if (x) out.push(x); });
    return out;
  }

  function buildIndex(cards) {
    const idx = [];
    cards.forEach(function (c) {
      const seen = new Set();
      namesOf(c).forEach(function (nm) {
        const k = norm(nm);
        if (k && !seen.has(k)) { seen.add(k); idx.push({ k: k, c: c }); }
      });
    });
    return idx;
  }

  /** Beste Treffer pro Karte (Druck), absteigend nach Ähnlichkeit. */
  function matchText(index, text, minScore) {
    const min = minScore == null ? 0.5 : minScore;
    const cands = candidatesFromText(text);
    const best = new Map();
    for (let i = 0; i < index.length; i++) {
      const row = index[i];
      let s = 0;
      for (let j = 0; j < cands.length; j++) {
        const v = score(cands[j], row.k);
        if (v > s) s = v;
      }
      if (s >= min) {
        const b = best.get(row.c.id);
        if (!b || s > b.s) best.set(row.c.id, { c: row.c, s: s });
      }
    }
    return Array.from(best.values()).sort(function (a, b) { return b.s - a.s; });
  }

  /** Tippen-Suche: Präfix vor Teilstring vor unscharfem Treffer. */
  function searchName(index, q, limit) {
    const nq = norm(q);
    if (nq.length < 2) return [];
    const best = new Map();
    for (let i = 0; i < index.length; i++) {
      const row = index[i];
      let s = 0;
      if (row.k.indexOf(nq) === 0) s = 1;
      else if (row.k.indexOf(nq) > -1) s = 0.9;
      else if (nq.length >= 4) {
        const f = sim(nq, row.k.slice(0, nq.length));
        if (f >= 0.75) s = 0.6 + f * 0.2;
      }
      if (s > 0) {
        const b = best.get(row.c.id);
        if (!b || s > b.s) best.set(row.c.id, { c: row.c, s: s });
      }
    }
    return Array.from(best.values())
      .sort(function (a, b) { return b.s - a.s || (a.c.n < b.c.n ? -1 : 1); })
      .slice(0, limit || 8);
  }

  /** Gruppiert Treffer nach englischem Namen, behält pro Name den besten Druck zuerst. */
  function groupByName(list) {
    const groups = new Map();
    list.forEach(function (m) {
      const k = norm(m.c.n);
      if (!groups.has(k)) groups.set(k, { s: m.s, cards: [m.c] });
      else groups.get(k).cards.push(m.c);
    });
    return Array.from(groups.values());
  }

  /** Preis einer Karte in der gewünschten Währung; null, wenn keiner vorliegt. */
  function priceOf(c, foil, cur) {
    if (!c) return null;
    const v = cur === 'usd' ? (foil ? c.usdF : c.usd) : (foil ? c.eurF : c.eur);
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function canNonFoil(c) { return !c.fin || c.fin.indexOf('nonfoil') > -1; }
  function canFoil(c) { return !!c.fin && (c.fin.indexOf('foil') > -1 || c.fin.indexOf('etched') > -1); }

  /** Rahmen für die Karte im Kamerabild (Seitenverhältnis 63:88). */
  function guideRect(cw, ch) {
    let w = cw * 0.84;
    let h = w * 88 / 63;
    if (h > ch * 0.9) { h = ch * 0.9; w = h * 63 / 88; }
    return { x: (cw - w) / 2, y: (ch - h) / 2, w: w, h: h };
  }

  /** Titelzeile relativ zum Kartenrahmen. */
  function titleRegion(g) {
    return { x: g.x + g.w * 0.03, y: g.y + g.h * 0.02, w: g.w * 0.80, h: g.h * 0.11 };
  }

  /** Bereich im Container → Bereich im Videobild (object-fit: cover). */
  function toVideoRect(reg, cw, ch, vw, vh) {
    const scale = Math.max(cw / vw, ch / vh);
    const ox = (cw - vw * scale) / 2;
    const oy = (ch - vh * scale) / 2;
    return { sx: (reg.x - ox) / scale, sy: (reg.y - oy) / scale, sw: reg.w / scale, sh: reg.h / scale };
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, max = 0, th = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > max) { max = between; th = t; }
    }
    return th;
  }

  const api = {
    norm: norm, lev: lev, sim: sim, score: score, candidatesFromText: candidatesFromText,
    namesOf: namesOf, buildIndex: buildIndex, matchText: matchText, searchName: searchName,
    groupByName: groupByName, priceOf: priceOf, canFoil: canFoil, canNonFoil: canNonFoil,
    guideRect: guideRect, titleRegion: titleRegion, toVideoRect: toVideoRect, otsu: otsu
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof self !== 'undefined' ? self : globalThis);
