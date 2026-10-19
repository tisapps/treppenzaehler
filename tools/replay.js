// Spielt eine aufgezeichnete CSV aus der App ab: node tools/replay.js aufnahme.csv [modell.json]
'use strict';
const fs = require('fs');
const { StairDetector } = require('../detector.js');

const [csv, modelFile] = process.argv.slice(2);
if (!csv) { console.error('Aufruf: node tools/replay.js aufnahme.csv [modell.json]'); process.exit(1); }
const model = modelFile ? JSON.parse(fs.readFileSync(modelFile, 'utf8')) : null;
const d = new StairDetector({}, model);
d.on('turn', (e) => console.log(`${(e.t / 1000).toFixed(1)}s  Wende ${Math.round(e.deg)}°`));
d.on('flight', (f) => console.log(`${(f.t1 / 1000).toFixed(1)}s  ${f.dir > 0 ? '↑' : '↓'}${f.stairs} (roh ${f.raw}, ${f.steps} Schritte)`));
d.on('discard', (f) => console.log(`${(f.t1 / 1000).toFixed(1)}s  verworfen: ${f.raw}`));
for (const line of fs.readFileSync(csv, 'utf8').split('\n').slice(1)) {
  const c = line.split(',');
  if (c.length < 4) continue;
  const n = (i) => (c[i] === '' || c[i] == null ? null : +c[i]);
  if (c[7]) console.log(`${(+c[0] / 1000).toFixed(1)}s  Markierung: ${c[7]}`);
  d.push(+c[0], +c[1], +c[2], +c[3], n(4), n(5), n(6));
}
d.flush();
console.log(d.totals);
