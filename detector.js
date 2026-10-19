/* Treppenzähler – Erkennungskern.
 *
 * Nur Beschleunigungssensor + Gyroskop, kein Barometer.
 * Idee:
 *  1. Schwerkraftrichtung per Tiefpass schätzen -> vertikale Beschleunigung av,
 *     horizontale Restbeschleunigung h, Drehrate um die Hochachse (Gierrate).
 *  2. Schritte = Spitzen in der tiefpassgefilterten av.
 *  3. Pro Schritt Merkmale berechnen und klassifizieren (eben / hoch / runter /
 *     hoch mit 2 Stufen pro Schritt ...). Klassifikator: Gauß-Naive-Bayes,
 *     dessen Parameter per Kalibrierung gelernt werden.
 *  4. Aufeinanderfolgende Treppenschritte bilden einen Lauf ("Flight").
 *     180°-Drehungen (Gierwinkel) trennen Läufe an Podesten.
 *  5. Läufe im Treppenhaus-Kontext (Drehung davor/danach) werden auf bekannte
 *     Lauflängen (z. B. 5 / 10 Stufen beim Splitlevel) eingerastet.
 *
 * Hinweis: Eine gleichmäßige Steiggeschwindigkeit ist aus Beschleunigung
 * prinzipiell nicht beobachtbar (konstante Geschwindigkeit = 0 Beschleunigung).
 * Deshalb wird nicht integriert, sondern Schrittmuster erkannt und gezählt.
 *
 * Läuft im Browser (self.StairCore) und in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StairCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FEATURES = ['dur', 'p2p', 'hRms', 'jerk', 'swing', 'skew', 'zExc'];
  const MODEL_VERSION = 2;
  // Untergrenzen der Standardabweichung je Merkmal (verhindert Überanpassung)
  const MIN_SD = [0.04, 0.8, 0.3, 8, 3, 0.2, 0.5];

  const CLASSES = {
    flat:  { dir: 0,  per: 0, label: 'eben' },
    up:    { dir: 1,  per: 1, label: 'hoch' },
    up2:   { dir: 1,  per: 2, label: 'hoch, 2 Stufen/Schritt' },
    down:  { dir: -1, per: 1, label: 'runter' },
    down2: { dir: -1, per: 2, label: 'runter, 2 Stufen/Schritt' },
  };

  // Grobe Schätzwerte (Handy seitlich am Gürtel). Kalibrierung ersetzt sie.
  // swing = Beckenkippung (°), zExc = vertikaler Hub der Hüfte je Schritt (cm)
  const DEFAULT_MODEL = {
    version: MODEL_VERSION,
    calibrated: false,
    classes: {
      flat: { mu: [0.55, 6, 2.0, 50, 12, 0.5, 4], sd: [0.08, 2, 0.8, 20, 5, 0.5, 1.5] },
      up:   { mu: [0.68, 5, 1.6, 40, 16, 0.2, 6], sd: [0.10, 2, 0.8, 20, 6, 0.5, 2] },
      up2:  { mu: [0.85, 8, 2.0, 50, 20, 0.2, 9], sd: [0.12, 3, 0.8, 25, 7, 0.5, 3] },
      down: { mu: [0.52, 9, 2.2, 80, 12, 1.0, 5], sd: [0.08, 3, 0.8, 30, 5, 0.6, 2] },
    },
  };

  const DEFAULT_CFG = {
    riserCm: 17,            // Stufenhöhe
    stairsPerFloor: 30,     // Stufen pro Stockwerk (Splitlevel: 5+10+5+10)
    flightLengths: [5, 10], // bekannte Lauflängen; [] = nicht einrasten
    snapAlways: false,      // auch ohne erkannte Drehung einrasten
    snapTolerance: 0.4,     // max. relative Abweichung fürs Einrasten
    alternateBonus: 0.15,   // Bonus, wenn kurz/lang abwechseln
    doublePenalty: 0.2,     // Malus für Umdeutung als 2 Stufen/Schritt
    singlePenalty: 0.15,    // Malus für Umdeutung als 1 Stufe/Schritt
    minFlightStairs: 3,     // kürzere Läufe werden verworfen
    flatStepsEnd: 3,        // so viele ebene Schritte beenden einen Lauf
    pauseEndS: 3,           // Pause beendet einen Lauf
    turnDeg: 130,           // Drehung ab dieser Gierwinkeländerung ...
    turnWindowS: 4,         // ... innerhalb dieses Zeitfensters
    turnLinkS: 5,           // Drehung gilt als zum Lauf gehörig, wenn so nah
    minPeak: 0.7,           // m/s², minimale Schrittspitze
    minStepS: 0.28,
    maxStepS: 2.0,
  };

  const norm = (v) => Math.hypot(v[0], v[1], v[2]);
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  class StairDetector {
    constructor(cfg = {}, model = null) {
      this.cfg = Object.assign({}, DEFAULT_CFG, cfg);
      this.model = model || DEFAULT_MODEL;
      this.handlers = {};
      this.collectLabel = null;
      this.calib = {};
      this.reset();
    }

    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev, data) { for (const fn of this.handlers[ev] || []) fn(data); }

    reset() {
      this.lastT = null;
      this.g = null; this.gf = null;
      this.avf = 0; this.p1 = 0; this.p2 = 0; this.prevAv = 0;
      this.heading = 0; this.headHist = []; this.turnCooldownUntil = 0;
      this.lastTurnT = -Infinity;
      this.buf = [];
      this.lastPeakT = null; this.prevPeakT = null; this.peakEma = 2;
      this.held = null; this.prevRawDir = null;
      this.flight = null; this.closing = null; this.flatRun = 0; this.lastFlight = null;
      this.totals = { steps: 0, up: 0, down: 0, flights: 0 };
    }

    /** t in ms, a inkl. Schwerkraft in m/s², w Drehrate in °/s (Gerätekoordinaten x,y,z; darf null sein). */
    push(t, ax, ay, az, wx, wy, wz) {
      if (this.lastT === null || t <= this.lastT || t - this.lastT > 500) {
        if (this.lastT !== null && t > this.lastT) this._gap();
        this.lastT = t;
        this.g = [ax, ay, az]; this.gf = [ax, ay, az];
        this.buf = []; this.avf = 0; this.p1 = 0; this.p2 = 0; this.prevAv = 0;
        return;
      }
      const dt = (t - this.lastT) / 1000;
      this.lastT = t;
      const a = [ax, ay, az];
      const kS = 1 - Math.exp(-dt / 0.6);   // Schwerkraft (langsam)
      const kF = 1 - Math.exp(-dt / 0.08);  // Neigung des Geräts (schnell, für Neigungsschwung)
      const kA = 1 - Math.exp(-dt / 0.05);  // Glättung av für Schrittspitzen
      for (let i = 0; i < 3; i++) {
        this.g[i] += kS * (a[i] - this.g[i]);
        this.gf[i] += kF * (a[i] - this.gf[i]);
      }
      const gn = norm(this.g) || 1;
      const u = [this.g[0] / gn, this.g[1] / gn, this.g[2] / gn];
      const lin = [a[0] - this.g[0], a[1] - this.g[1], a[2] - this.g[2]];
      const av = lin[0] * u[0] + lin[1] * u[1] + lin[2] * u[2];
      const h = Math.sqrt(Math.max(0, lin[0] ** 2 + lin[1] ** 2 + lin[2] ** 2 - av * av));
      const jerk = Math.abs(av - this.prevAv) / dt;
      this.prevAv = av;
      const fn = norm(this.gf) || 1;
      this.buf.push({ t, av, h, jerk, fx: this.gf[0] / fn, fy: this.gf[1] / fn, fz: this.gf[2] / fn });
      while (this.buf.length && this.buf[0].t < t - 5000) this.buf.shift();

      if (wx != null && wy != null && wz != null) {
        this.heading += (wx * u[0] + wy * u[1] + wz * u[2]) * dt;
        this._detectTurn(t);
      }

      this.avf += kA * (av - this.avf);
      if (this.p1 > this.p2 && this.p1 >= this.avf && this.buf.length >= 2) {
        const tp = this.buf[this.buf.length - 2].t;
        const thr = Math.max(this.cfg.minPeak, 0.4 * this.peakEma);
        if (this.p1 > thr && (this.lastPeakT === null || tp - this.lastPeakT >= this.cfg.minStepS * 1000)) {
          this._peak(tp, this.p1);
        }
      }
      this.p2 = this.p1; this.p1 = this.avf;

      if (this.flight && t - this.flight.tLast > this.cfg.pauseEndS * 1000) {
        this._flushHeld();
        this._closeFlight(false);
      }
      if (this.closing && t > this.closing.deadline) this._commit();
    }

    /** Am Ende einer Messung aufrufen: offene Läufe werden verbucht. */
    flush() { this._gap(); }

    /** Noch nicht verbuchte Stufen (laufender Lauf), für die Live-Anzeige. */
    provisional() {
      const out = { up: 0, down: 0 };
      for (const f of [this.closing, this.flight]) {
        if (!f) continue;
        const n = f.steps.reduce((s, x) => s + x.per, 0);
        if (f.dir > 0) out.up += n; else out.down += n;
      }
      if (this.held && this.held.rawDir) {
        const per = CLASSES[this.held.cls].per;
        if (this.held.rawDir > 0) out.up += per; else out.down += per;
      }
      return out;
    }

    // ---- Kalibrierung -------------------------------------------------------

    startCollect(label) { this.collectLabel = label; this.calib[label] = []; }
    stopCollect() { const l = this.collectLabel; this.collectLabel = null; return (this.calib[l] || []).length; }
    collectedCounts() {
      const o = {};
      for (const k in this.calib) o[k] = this.calib[k].length;
      return o;
    }

    /** Baut aus gesammelten Schritten ein Modell (robust: Median / MAD). */
    buildModel() {
      const classes = {};
      for (const [label, rows] of Object.entries(this.calib)) {
        if (rows.length < 8) continue;
        const mu = [], sd = [];
        for (let i = 0; i < FEATURES.length; i++) {
          const col = rows.map((r) => r[i]);
          const m = median(col);
          mu.push(m);
          sd.push(Math.max(MIN_SD[i], 1.4826 * median(col.map((v) => Math.abs(v - m)))));
        }
        classes[label] = { mu, sd, n: rows.length };
      }
      if (!classes.flat || (!classes.up && !classes.down)) return null;
      // Doppelstufen-Klasse aus "hoch" ableiten, falls nicht selbst kalibriert
      if (classes.up && !classes.up2) {
        const s = [1.25, 1.3, 1.1, 1.1, 1.25, 1, 1.5];
        classes.up2 = { mu: classes.up.mu.map((v, i) => v * s[i]), sd: classes.up.sd.slice(), derived: true };
      }
      return { version: MODEL_VERSION, calibrated: true, created: Date.now(), classes };
    }

    // ---- intern ---------------------------------------------------------------

    _detectTurn(t) {
      const hh = this.headHist;
      hh.push({ t, h: this.heading });
      while (hh.length && hh[0].t < t - this.cfg.turnWindowS * 1000) hh.shift();
      if (t < this.turnCooldownUntil) return;
      let ext = hh[0];
      for (const e of hh) if (Math.abs(e.h - this.heading) > Math.abs(ext.h - this.heading)) ext = e;
      const delta = this.heading - ext.h;
      if (Math.abs(delta) < this.cfg.turnDeg) return;
      const half = (ext.h + this.heading) / 2;
      let tm = t;
      for (const e of hh) {
        if (e.t >= ext.t && (e.h - half) * Math.sign(delta) >= 0) { tm = e.t; break; }
      }
      this.turnCooldownUntil = t + 2500;
      this.headHist = [{ t, h: this.heading }];
      this._turn(tm, delta);
    }

    _turn(tm, deg) {
      this.lastTurnT = tm;
      this.emit('turn', { t: tm, deg });
      this._flushHeld();
      const f = this.flight;
      if (f) {
        const before = f.steps.filter((s) => s.t <= tm);
        const after = f.steps.filter((s) => s.t > tm);
        if (before.length) {
          f.steps = before;
          f.tLast = before[before.length - 1].t;
          this._closeFlight(true);
        } else {
          this.flight = null;
        }
        if (after.length) {
          this.flight = { dir: f.dir, steps: after, turnBefore: true, tLast: after[after.length - 1].t };
        }
        if (before.length) return;
      }
      if (this.closing && tm - this.closing.tLast < this.cfg.turnLinkS * 1000) this.closing.turnAfter = true;
    }

    _peak(tp, p) {
      this.peakEma += 0.2 * (p - this.peakEma);
      const t0 = this.lastPeakT;
      const contiguous = t0 !== null && tp - t0 <= this.cfg.maxStepS * 1000;
      const feats = contiguous ? this._features(t0, tp, this.prevPeakT) : null;
      this.prevPeakT = contiguous ? t0 : null;
      this.lastPeakT = tp;
      this._step({ t: tp, feats });
    }

    _features(t0, t1, tPrev) {
      const w = this.buf.filter((s) => s.t > t0 && s.t <= t1);
      if (w.length < 5) return null;
      const n = w.length;
      let mean = 0, min = Infinity, max = -Infinity, h2 = 0, jerk = 0;
      for (const s of w) {
        mean += s.av; h2 += s.h * s.h; jerk += s.jerk;
        if (s.av < min) min = s.av;
        if (s.av > max) max = s.av;
      }
      mean /= n;
      let m2 = 0, m3 = 0;
      for (const s of w) { const d = s.av - mean; m2 += d * d; m3 += d * d * d; }
      const sd = Math.sqrt(m2 / n) || 1e-6;
      const skew = m3 / n / sd ** 3;

      // Neigungsschwung des Geräts über die letzten 2 Schritte (Halfter: Beckenkippung, Tasche: Oberschenkel)
      const ws = this.buf.filter((s) => s.t > (tPrev ?? t0) && s.t <= t1);
      let mx = 0, my = 0, mz = 0;
      for (const s of ws) { mx += s.fx; my += s.fy; mz += s.fz; }
      const mn = Math.hypot(mx, my, mz) || 1;
      mx /= mn; my /= mn; mz /= mn;
      let maxAng = 0;
      for (const s of ws) {
        const c = Math.min(1, Math.max(-1, s.fx * mx + s.fy * my + s.fz * mz));
        maxAng = Math.max(maxAng, Math.acos(c));
      }
      const swing = (2 * maxAng * 180) / Math.PI;

      // Vertikaler Hub: av zweimal integrieren. Am gleichen Gangphasenpunkt (Spitze) ist die
      // Geschwindigkeit gleich -> Geschwindigkeit linear entdriften; Weg ebenso (Netto-Steigung
      // ist ohnehin nicht beobachtbar), übrig bleibt die Auf-und-ab-Bewegung innerhalb des Schritts.
      const v = [0], z = [0];
      for (let i = 1; i < n; i++) v.push(v[i - 1] + ((w[i].av + w[i - 1].av) / 2) * ((w[i].t - w[i - 1].t) / 1000));
      for (let i = 0; i < n; i++) v[i] -= (v[n - 1] * i) / (n - 1);
      for (let i = 1; i < n; i++) z.push(z[i - 1] + ((v[i] + v[i - 1]) / 2) * ((w[i].t - w[i - 1].t) / 1000));
      let zMin = Infinity, zMax = -Infinity;
      for (let i = 0; i < n; i++) {
        const zi = z[i] - (z[n - 1] * i) / (n - 1);
        if (zi < zMin) zMin = zi;
        if (zi > zMax) zMax = zi;
      }
      const zExc = (zMax - zMin) * 100;

      return [(t1 - t0) / 1000, max - min, Math.sqrt(h2 / n), jerk / n, swing, skew, zExc];
    }

    classify(x) {
      let best = 'flat', bestLL = -Infinity;
      for (const [name, c] of Object.entries(this.model.classes)) {
        if (!CLASSES[name]) continue;
        let ll = 0;
        for (let i = 0; i < x.length; i++) {
          const sd = Math.max(c.sd[i], MIN_SD[i]);
          const z = (x[i] - c.mu[i]) / sd;
          ll -= 0.5 * z * z + Math.log(sd);
        }
        if (ll > bestLL) { bestLL = ll; best = name; }
      }
      return best;
    }

    _step(step) {
      this.totals.steps++;
      if (step.feats) {
        step.cls = this.classify(step.feats);
        step.rawDir = CLASSES[step.cls].dir;
        if (this.collectLabel) this.calib[this.collectLabel].push(step.feats);
      } else {
        step.cls = null;
        step.rawDir = null; // erster Schritt nach Stillstand: unbekannt
      }
      this.emit('step', step);
      if (this.held) {
        // Glättung: ein einzelner Ausreißer zwischen zwei gleichen Nachbarn wird überstimmt
        const h = this.held;
        const prev = this.prevRawDir, next = step.rawDir;
        let dir = h.rawDir, per = h.cls ? CLASSES[h.cls].per : 0;
        if (prev !== null && prev === next && dir !== prev) {
          dir = next;
          per = CLASSES[step.cls].per;
        } else if (dir === null) {
          const nb = next ?? prev;
          if (nb !== null) { dir = nb; per = nb === 0 ? 0 : (next !== null ? CLASSES[step.cls].per : 1); }
        }
        this._finalize(h, dir ?? 0, per);
        this.prevRawDir = h.rawDir;
      }
      this.held = step;
    }

    _flushHeld() {
      const h = this.held;
      if (!h) return;
      this.held = null;
      this.prevRawDir = h.rawDir;
      this._finalize(h, h.rawDir ?? 0, h.cls ? CLASSES[h.cls].per : 0);
    }

    _finalize(step, dir, per) {
      if (dir === 0) {
        this.flatRun++;
        if (this.flight && this.flatRun >= this.cfg.flatStepsEnd) this._closeFlight(false);
        return;
      }
      this.flatRun = 0;
      if (this.flight && this.flight.dir !== dir) this._closeFlight(false);
      if (!this.flight) {
        this.flight = { dir, steps: [], turnBefore: step.t - this.lastTurnT < this.cfg.turnLinkS * 1000 };
      }
      this.flight.steps.push({ t: step.t, per: per || 1 });
      this.flight.tLast = step.t;
      this.emit('progress', this.provisional());
    }

    _closeFlight(turnAfter) {
      const f = this.flight;
      this.flight = null;
      if (!f) return;
      f.turnAfter = turnAfter;
      if (this.closing) this._commit();
      f.deadline = f.tLast + this.cfg.turnLinkS * 1000;
      this.closing = f;
    }

    _commit() {
      const f = this.closing;
      this.closing = null;
      if (!f) return;
      const raw = f.steps.reduce((s, x) => s + x.per, 0);
      const info = { dir: f.dir, steps: f.steps.length, raw, t0: f.steps[0].t, t1: f.tLast,
        turnBefore: !!f.turnBefore, turnAfter: !!f.turnAfter };
      if (raw < this.cfg.minFlightStairs) { this.emit('discard', info); return; }
      info.stairs = this._snap(f, raw);
      info.snapped = info.stairs !== raw;
      if (f.dir > 0) this.totals.up += info.stairs; else this.totals.down += info.stairs;
      this.totals.flights++;
      this.lastFlight = { dir: f.dir, n: info.stairs, t: f.tLast };
      this.emit('flight', info);
    }

    _snap(f, raw) {
      const lens = this.cfg.flightLengths;
      if (!lens || !lens.length) return raw;
      if (!(f.turnBefore || f.turnAfter || this.cfg.snapAlways)) return raw;
      const k = f.steps.length;
      const lf = this.lastFlight;
      const prevLen = lf && lf.dir === f.dir && f.steps[0].t - lf.t < 30000 ? lf.n : null;
      const readings = [{ est: raw, pen: 0 }];
      if (k !== raw) readings.push({ est: k, pen: this.cfg.singlePenalty });
      if (2 * k !== raw) readings.push({ est: 2 * k, pen: this.cfg.doublePenalty });
      let best = raw, bestScore = Infinity;
      for (const len of lens) {
        for (const r of readings) {
          const dev = Math.abs(r.est - len) / len;
          if (dev > this.cfg.snapTolerance) continue;
          const score = dev + r.pen - (prevLen !== null && len !== prevLen ? this.cfg.alternateBonus : 0);
          if (score < bestScore) { bestScore = score; best = len; }
        }
      }
      return best;
    }

    _gap() {
      this._flushHeld();
      this._closeFlight(false);
      this._commit();
      this.lastPeakT = null; this.prevPeakT = null; this.prevRawDir = null;
      this.headHist = [];
    }
  }

  return { StairDetector, FEATURES, CLASSES, DEFAULT_MODEL, DEFAULT_CFG, MODEL_VERSION };
});
