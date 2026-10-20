// Plausibilitätstest mit synthetischen Sensordaten: node tools/sim-test.js
// Prüft die Logik (Schritte, Drehungen, Läufe, Einrasten), nicht die Erkennung echter Gangmuster.
'use strict';
const { StairDetector } = require('../detector.js');

const HZ = 60, G = 9.81;
const KINDS = {
  flat: { dur: 0.55, amp: 3.0, swing: 40 },
  up:   { dur: 0.70, amp: 2.2, swing: 75 },
  up2:  { dur: 0.88, amp: 3.2, swing: 100 },
  down: { dur: 0.50, amp: 4.5, swing: 50 },
};

function makeRng(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }

// Erzeugt Samples [t, ax, ay, az, wx, wy, wz] für eine Abfolge von Segmenten.
function synth(segments, seed = 1) {
  const rnd = makeRng(seed);
  const out = [];
  let t = 0, phase = 0;
  const emit = (dur, fn) => {
    const n = Math.round(dur * HZ);
    for (let i = 0; i < n; i++) { fn(i / n, i / HZ); t += 1000 / HZ; }
  };
  for (const seg of segments) {
    if (seg.turn) {
      const rate = seg.turn / seg.s;
      emit(seg.s, () => out.push([t, 0, G, 0, 0, rate, 0]));
      continue;
    }
    if (seg.still) { emit(seg.still, () => out.push([t, (rnd() - .5) * .05, G, 0, 0, 0, 0])); continue; }
    for (let s = 0; s < seg.steps; s++) {
      // mix: Anteil Schritte, die wie Treppe aussehen (überlappende Gangmuster)
      const k = KINDS[seg.mix && rnd() < seg.mix.p ? seg.mix.kind : seg.kind];
      const dur = k.dur * (0.95 + 0.1 * rnd());
      emit(dur, (x) => {
        const av = k.amp * Math.cos(2 * Math.PI * x) + (rnd() - .5) * 0.3;
        phase += Math.PI / (dur * HZ); // Schrittfrequenz/2 = Oberschenkelschwung
        const tilt = (k.swing / 2) * Math.PI / 180 * Math.sin(phase);
        // Schwerkraft + vertikale Beschleunigung, gekippt um die x-Achse
        const ay = (G + av) * Math.cos(tilt), az = (G + av) * Math.sin(tilt);
        out.push([t, (rnd() - .5) * 0.6, ay, az, 0, (rnd() - .5) * 20, 0]);
      });
    }
  }
  return out;
}

function run(det, samples) { for (const s of samples) det.push(...s); det.flush(); }

// 1) Kalibrieren
const det = new StairDetector();
for (const kind of ['flat', 'up', 'down']) {
  det.startCollect(kind);
  run(det, synth([{ still: 1 }, { kind, steps: 30 }, { still: 1 }], kind.length));
  det.stopCollect();
}
console.log('Kalibrierschritte:', det.collectedCounts());
const model = det.buildModel();
if (!model) throw new Error('Modell konnte nicht gebaut werden');

// 2) Szenarien
const cases = [
  { name: 'Splitlevel hoch 5/10/5/10', expectUp: 30, expectDown: 0,
    seq: [{ still: 1 }, { kind: 'flat', steps: 10 }, { kind: 'up', steps: 5 }, { turn: 180, s: 1.2 },
      { kind: 'up', steps: 10 }, { turn: 180, s: 1.2 }, { kind: 'up', steps: 5 }, { turn: 180, s: 1.2 },
      { kind: 'up', steps: 10 }, { kind: 'flat', steps: 8 }, { still: 2 }] },
  { name: 'Splitlevel runter 10/5', expectUp: 0, expectDown: 15,
    seq: [{ still: 1 }, { kind: 'flat', steps: 6 }, { kind: 'down', steps: 10 }, { turn: -180, s: 1.0 },
      { kind: 'down', steps: 5 }, { kind: 'flat', steps: 6 }, { still: 2 }] },
  { name: 'schnell hoch (2 Stufen/Schritt)', expectUp: 15, expectDown: 0,
    seq: [{ still: 1 }, { kind: 'flat', steps: 6 }, { kind: 'up2', steps: 3 }, { turn: 180, s: 1.0 },
      { kind: 'up2', steps: 5 }, { kind: 'flat', steps: 6 }, { still: 2 }] },
  { name: 'eben, 20 % treppenähnliche Schritte, mit Wenden', expectUp: 0, expectDown: 0,
    seq: [{ still: 1 }, { kind: 'flat', steps: 40, mix: { kind: 'up', p: 0.2 } }, { turn: 180, s: 1.0 },
      { kind: 'flat', steps: 40, mix: { kind: 'up', p: 0.2 } }, { turn: -180, s: 1.0 },
      { kind: 'flat', steps: 40, mix: { kind: 'down', p: 0.2 } }, { still: 1 }] },
  { name: 'gerade Treppe ohne Wende (wird nicht gezählt)', expectUp: 0, expectDown: 0,
    seq: [{ still: 1 }, { kind: 'flat', steps: 8 }, { kind: 'up', steps: 12 }, { kind: 'flat', steps: 8 }, { still: 1 }] },
  { name: 'nur eben mit Wenden', expectUp: 0, expectDown: 0,
    seq: [{ still: 1 }, { kind: 'flat', steps: 20 }, { turn: 180, s: 1.0 }, { kind: 'flat', steps: 20 }, { still: 1 }] },
];

let fail = 0;
for (const c of cases) {
  const d = new StairDetector({}, model);
  const log = [];
  d.on('flight', (f) => log.push(`${f.dir > 0 ? '↑' : '↓'}${f.stairs}${f.snapped ? `(roh ${f.raw})` : ''}`));
  run(d, synth(c.seq, 7));
  const ok = d.totals.up === c.expectUp && d.totals.down === c.expectDown;
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.name}: hoch ${d.totals.up}/${c.expectUp}, runter ${d.totals.down}/${c.expectDown}, Schritte ${d.totals.steps} [${log.join(' ')}]`);
}
process.exit(fail ? 1 : 0);
