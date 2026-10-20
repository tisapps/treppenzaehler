/* Treppenzähler – UI, Sensoranbindung, Speicherung. */
'use strict';

const { StairDetector, CLASSES, DEFAULT_MODEL, DEFAULT_CFG, MODEL_VERSION } = self.StairCore;
const $ = (id) => document.getElementById(id);

// ---- Speicher (localStorage, defensiv) ----------------------------------------
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* voll / gesperrt */ } },
};
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD lokal

const savedCfg = store.get('tz.cfg', {});
if (!savedCfg.cfgVersion) delete savedCfg.requireTurn; // früherer Standard "nur mit Wende" entfällt
let cfg = Object.assign({}, DEFAULT_CFG, savedCfg);
let model = store.get('tz.model', null);
if (!model || model.version !== MODEL_VERSION) model = DEFAULT_MODEL; // altes Merkmalsformat verwerfen
let days = store.get('tz.days', {});

function day() {
  const d = today();
  if (!days[d]) days[d] = { up: 0, down: 0, flights: 0, steps: 0 };
  return days[d];
}
let saveTimer = null;
function saveDays() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set('tz.days', days), 1000);
}

// ---- Detektor -------------------------------------------------------------------
let det;
function makeDetector() {
  const d = new StairDetector(cfg, model);
  d.on('step', (s) => {
    day().steps++;
    saveDays();
    if (s.cls) lastStepInfo = `letzter Schritt: ${CLASSES[s.cls].label} (Vorsprung ${s.llr >= 0 ? '+' : ''}${s.llr.toFixed(1)})`;
    render();
  });
  d.on('discard', (f) => {
    if (f.raw >= 3) addLog(`${clock()} verworfen: ${f.dir > 0 ? '↑' : '↓'}${f.raw} – ${f.reason}`);
  });
  d.on('progress', render);
  d.on('flight', (f) => {
    const t = day();
    if (f.dir > 0) t.up += f.stairs; else t.down += f.stairs;
    t.flights++;
    saveDays();
    addLog(`${clock()} ${f.dir > 0 ? '↑' : '↓'} ${f.stairs} Stufen` +
      (f.snapped ? ` (gemessen ${f.raw}, eingerastet)` : '') +
      ` · ${f.steps} Schritte` + (f.turnBefore || f.turnAfter ? ' · Wende' : ''));
    render();
  });
  d.on('turn', (e) => { lastTurnInfo = `Wende ${Math.round(e.deg)}° um ${clock()}`; });
  return d;
}
det = makeDetector();
let lastTurnInfo = '', lastStepInfo = '';

// ---- Sensoren -------------------------------------------------------------------
let running = false;
let sampleCount = 0, rateT0 = 0, rate = 0, hasGyro = null;
let recording = null; // Array von CSV-Zeilen
let pendingMark = '';

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const r = e.rotationRate;
  const gyro = r && r.alpha != null;
  if (hasGyro === null) hasGyro = gyro;
  const t = e.timeStamp || performance.now();
  // rotationRate: alpha um z, beta um x, gamma um y (°/s)
  det.push(t, a.x, a.y, a.z, gyro ? r.beta : null, gyro ? r.gamma : null, gyro ? r.alpha : null);
  sampleCount++;
  if (recording) {
    recording.push([t.toFixed(1), a.x.toFixed(3), a.y.toFixed(3), a.z.toFixed(3),
      gyro ? r.beta.toFixed(2) : '', gyro ? r.gamma.toFixed(2) : '', gyro ? r.alpha.toFixed(2) : '',
      pendingMark.replace(/[,\n]/g, ' ')].join(','));
    pendingMark = '';
  }
}

async function start() {
  if (typeof DeviceMotionEvent === 'undefined') { alert('Dieses Gerät/Browser liefert keine Bewegungssensoren.'); return; }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const p = await DeviceMotionEvent.requestPermission().catch(() => 'denied');
    if (p !== 'granted') { alert('Zugriff auf Bewegungssensoren verweigert.'); return; }
  }
  window.addEventListener('devicemotion', onMotion);
  running = true;
  rateT0 = performance.now(); sampleCount = 0;
  if ($('optWake').checked) await requestWake();
  store.set('tz.running', true);
  render();
}

function stop() {
  window.removeEventListener('devicemotion', onMotion);
  det.flush();
  running = false;
  releaseWake();
  store.set('tz.running', false);
  store.set('tz.days', days);
  render();
}

// ---- Wake Lock --------------------------------------------------------------------
let wakeLock = null;
async function requestWake() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; render(); });
    }
  } catch { wakeLock = null; }
  render();
}
function releaseWake() { if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null; }

let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); store.set('tz.days', days); return; }
  if (running && hiddenAt) {
    const min = Math.round((Date.now() - hiddenAt) / 60000);
    if (min >= 1) {
      const w = $('warnHidden');
      w.hidden = false;
      w.textContent = `Bildschirm war ${min} min aus bzw. App im Hintergrund – in dieser Zeit wurde nicht gezählt.`;
    }
    if ($('optWake').checked) requestWake();
  }
  hiddenAt = null;
});

// ---- Anzeige ----------------------------------------------------------------------
const clock = () => new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmt = (n, d = 0) => n.toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d });

function addLog(text) {
  const ul = $('log');
  if (ul.firstElementChild && ul.firstElementChild.classList.contains('muted')) ul.innerHTML = '';
  const li = document.createElement('li');
  li.textContent = text;
  ul.prepend(li);
  while (ul.children.length > 50) ul.lastElementChild.remove();
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; draw(); });
}

function draw() {
  const t = day();
  const prov = running ? det.provisional() : { up: 0, down: 0 };
  const up = t.up + prov.up;
  $('sUp').textContent = fmt(up);
  $('sDown').textContent = fmt(t.down + prov.down);
  $('sFloors').textContent = fmt(up / cfg.stairsPerFloor, 1);
  $('sHeight').textContent = fmt((up * cfg.riserCm) / 100, 1) + ' m';
  $('btnRun').textContent = running ? 'Zählung stoppen' : 'Zählung starten';

  if (running) {
    const now = performance.now();
    if (now - rateT0 > 2000) { rate = (sampleCount * 1000) / (now - rateT0); rateT0 = now; sampleCount = 0; }
    const parts = [`Läuft · ${fmt(t.steps)} Schritte heute`];
    if (prov.up || prov.down) parts.push(`aktueller Lauf: ${prov.up ? '↑' + prov.up : '↓' + prov.down}`);
    parts.push(wakeLock ? 'Bildschirm bleibt an' : 'Bildschirm-Sperre nicht aktiv');
    $('live').textContent = parts.join(' · ');
  } else {
    $('live').textContent = `Gestoppt · ${fmt(t.steps)} Schritte heute`;
  }
  $('sensorInfo').textContent = running
    ? `Abtastrate ≈ ${fmt(rate)} Hz · Gyroskop: ${hasGyro === null ? '?' : hasGyro ? 'ja' : 'nein (keine Wenden-Erkennung)'}` +
      (lastStepInfo ? ` · ${lastStepInfo}` : '') + (lastTurnInfo ? ` · ${lastTurnInfo}` : '')
    : '';

  const counts = det.collectedCounts();
  $('calInfo').textContent = calibrating
    ? `Aufnahme „${CLASSES[calibrating].label}“: ${counts[calibrating] || 0} Schritte …`
    : Object.keys(counts).length
      ? 'Gesammelt: ' + Object.entries(counts).map(([k, n]) => `${CLASSES[k].label} ${n}`).join(', ')
      : '';
  $('btnCal').textContent = calibrating ? 'Stopp' : 'Aufnehmen';
  $('modelInfo').textContent = model.calibrated
    ? `Kalibriertes Modell vom ${new Date(model.created).toLocaleString('de-DE')}. ` + qualityText(model)
    : 'Standardmodell (grobe Schätzung – bitte kalibrieren).';
  $('recInfo').textContent = recording ? `Aufnahme läuft: ${recording.length - 1} Messwerte` : '';
  $('btnRec').textContent = recording ? 'Aufnahme beenden & speichern' : 'Aufnahme starten';

  const rows = Object.keys(days).sort().reverse().slice(0, 14).map((d) => {
    const x = days[d];
    return `<tr><td>${d}</td><td>${x.up}</td><td>${x.down}</td><td>${fmt(x.up / cfg.stairsPerFloor, 1)}</td><td>${x.steps}</td></tr>`;
  });
  $('hist').innerHTML = rows.join('');
}
setInterval(() => { if (running) render(); }, 1000);

// ---- Bedienung ----------------------------------------------------------------------
$('btnRun').onclick = () => (running ? stop() : start());

let calibrating = null;
$('btnCal').onclick = async () => {
  if (calibrating) {
    det.stopCollect();
    calibrating = null;
  } else {
    if (!running) await start();
    calibrating = $('calLabel').value;
    det.startCollect(calibrating);
  }
  render();
};
$('btnBuild').onclick = () => {
  const m = det.buildModel();
  if (!m) { alert('Zu wenig Daten: mindestens „eben“ und „hoch“ oder „runter“ mit je ≥ 8 Schritten aufnehmen.'); return; }
  model = m;
  store.set('tz.model', model);
  det.model = model;
  render();
};
$('btnModelReset').onclick = () => {
  if (!confirm('Kalibrierung verwerfen und Standardmodell nutzen?')) return;
  model = DEFAULT_MODEL;
  store.set('tz.model', null);
  det.model = model;
  render();
};

$('btnResetDay').onclick = () => {
  if (!confirm('Zähler für heute auf 0 setzen?')) return;
  delete days[today()];
  store.set('tz.days', days);
  render();
};

$('btnRec').onclick = async () => {
  if (!recording) {
    if (!running) await start();
    recording = ['t_ms,ax,ay,az,wx,wy,wz,mark'];
  } else {
    const blob = new Blob([recording.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `treppen-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    recording = null;
  }
  render();
};
$('btnMark').onclick = () => { pendingMark = $('markText').value || 'mark'; };

$('fileReplay').onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const text = await file.text();
  const d = new StairDetector(cfg, model);
  const flights = [];
  d.on('flight', (f) => flights.push(`${f.dir > 0 ? '↑' : '↓'}${f.stairs}${f.snapped ? ` (roh ${f.raw})` : ''}`));
  for (const line of text.split('\n').slice(1)) {
    const c = line.split(',');
    if (c.length < 4) continue;
    const n = (i) => (c[i] === '' || c[i] == null ? null : +c[i]);
    d.push(+c[0], +c[1], +c[2], +c[3], n(4), n(5), n(6));
  }
  d.flush();
  alert(`Wiedergabe „${file.name}“:\nSchritte ${d.totals.steps}\nhoch ${d.totals.up}, runter ${d.totals.down}\nLäufe: ${flights.join(' ') || '–'}`);
  ev.target.value = '';
};

// ---- Einstellungen ----------------------------------------------------------------
function qualityText(m) {
  if (!m.quality) return '';
  const parts = Object.entries(m.quality).map(([k, q]) => k === 'flat'
    ? `eben: ${Math.round(q.stairShare * 100)} % fälschlich als Stufe`
    : `${CLASSES[k].label}: ${Math.round(q.stairShare * 100)} % erkannt`);
  return 'Trennschärfe auf den Kalibrierschritten – ' + parts.join(', ') + '.';
}

function loadSettingsUI() {
  $('cfgRiser').value = cfg.riserCm;
  $('cfgPerFloor').value = cfg.stairsPerFloor;
  $('cfgLengths').value = cfg.flightLengths.join(', ');
  $('cfgSnapAlways').checked = cfg.snapAlways;
  $('cfgRequireTurn').checked = cfg.requireTurn;
  $('cfgBias').value = cfg.stairBias;
}
function saveSettings() {
  cfg.riserCm = +$('cfgRiser').value || DEFAULT_CFG.riserCm;
  cfg.stairsPerFloor = +$('cfgPerFloor').value || DEFAULT_CFG.stairsPerFloor;
  cfg.flightLengths = $('cfgLengths').value.split(/[,; ]+/).map(Number).filter((n) => n > 0);
  cfg.snapAlways = $('cfgSnapAlways').checked;
  cfg.requireTurn = $('cfgRequireTurn').checked;
  cfg.stairBias = Number.isFinite(+$('cfgBias').value) ? +$('cfgBias').value : DEFAULT_CFG.stairBias;
  store.set('tz.cfg', { cfgVersion: 2, riserCm: cfg.riserCm, stairsPerFloor: cfg.stairsPerFloor,
    flightLengths: cfg.flightLengths, snapAlways: cfg.snapAlways, requireTurn: cfg.requireTurn, stairBias: cfg.stairBias });
  Object.assign(det.cfg, cfg);
  render();
}
for (const id of ['cfgRiser', 'cfgPerFloor', 'cfgLengths', 'cfgSnapAlways', 'cfgRequireTurn', 'cfgBias']) $(id).onchange = saveSettings;
$('optWake').onchange = () => { if (running) ($('optWake').checked ? requestWake() : releaseWake()); };

loadSettingsUI();
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
