/* CT30.A7.Highways -- MIDI, through the CT45.A1.USB standard layer (lib/ct45midi.js + lib/ct45.profiles.js); the CT55.A7 glue.
 *
 *  * Default assignments: CT30.A7.Highways_midimap.js (X-TOUCH MINI, Launchpad Mini MK3 / original, nanoKEY2).
 *  * Right-click any on-screen button, then press (or turn) a MIDI control: it is assigned to that button.
 *    Learned assignments live in this browser (localStorage) and override the file. Any MIDI device works this way.
 *  * Lights: X-TOUCH buttons light when their switch is on (Record blinks); encoder rings show the lane speeds;
 *    Launchpad pads show each action in its colour, and the lane ladders show each lane's speed as a bar.
 *  * Encoders: one mph per detent; knobs / faders: set the value directly (0-80 mph).
 */
(function () {
  'use strict';
  const C = window.CT30, $ = (id) => document.getElementById(id);
  const LEARN_KEY = 'CT30.midimap.learned';
  const DEFAULTS = window.CT30_MIDIMAP || {};
  const VALUE_ACTIONS = new Set(['lane1', 'lane2', 'lane3', 'lane4', 'lane5', 'lane6', 'lane7', 'lane8', 'heliSpeed', 'altitude', 'others']);
  const BUTTON_TO_VALUE = { heliFaster: 'heliSpeed', heliSlower: 'heliSpeed', up: 'altitude', down: 'altitude', othersFaster: 'others', othersSlower: 'others' };
  const COLORS = { reset: '#ffffff', forward: '#4ff0a8', pause: '#ffd23a', playPause: '#4ff0a8', record: '#ff2a3a', up: '#9ad0ff', down: '#9ad0ff', tilt: '#9ad0ff',
    follow: '#7fc4ff', hover: '#7fc4ff', heliFaster: '#7fc4ff', heliSlower: '#7fc4ff', allStop: '#ff3a3a', auto: '#ffbf6a', mad: '#ff3a3a', boxes: '#7fc4ff', laneTint: '#ff9aa8', othersFaster: '#c0c0c0', othersSlower: '#c0c0c0',
    interchange: '#b48cff', nextX: '#d5c2f5', prevX: '#d5c2f5', suburbs: '#ffd2a8', approach: '#7fc4ff', retreat: '#7fc4ff', sound: '#4ff0a8', display: '#9a9a9a', hud: '#9a9a9a', home: '#ffffff' };
  const NAMES = { reset: 'Reset', forward: 'Forward', pause: 'Pause', playPause: 'Play / pause', record: 'Record', up: 'Higher', down: 'Lower', tilt: 'Tilt',
    follow: 'Follow traffic', hover: 'Hover', heliFaster: 'Helicopter faster', heliSlower: 'Helicopter slower', allStop: 'Stop all lanes', auto: 'Auto stop-and-go', mad: 'Mad traffic', boxes: 'Wire boxes / car photos', laneTint: 'Lane colours',
    othersFaster: 'Other roads faster', othersSlower: 'Other roads slower', interchange: 'Interchanges on / off', nextX: 'Next interchange', prevX: 'Previous interchange', suburbs: 'Suburbs on / off', approach: 'Approach (hold)', retreat: 'Back (hold)', sound: 'Sound', display: 'Show / hide buttons (D)', hud: 'Show / hide text', home: 'Home view',
    heliSpeed: 'Helicopter speed (value)', altitude: 'Helicopter height (value)', others: 'Other roads speed (value)' };
  for (let i = 1; i <= 8; i++) {
    const c = (window.CT30 && window.CT30.LANE_COL[i - 1]) || '#ffffff';
    BUTTON_TO_VALUE['lane' + i + 'Up'] = BUTTON_TO_VALUE['lane' + i + 'Down'] = 'lane' + i;
    NAMES['lane' + i] = `Lane ${i} speed (value)`; NAMES['lane' + i + 'Up'] = `Lane ${i} faster`; NAMES['lane' + i + 'Down'] = `Lane ${i} slower`; NAMES['lane' + i + 'Stop'] = `Lane ${i} stop / go`;
    COLORS['lane' + i + 'Up'] = COLORS['lane' + i + 'Down'] = COLORS['lane' + i + 'Stop'] = c;
    for (const k of ['60', '45', '30', '15', '5', '0']) { NAMES['lane' + i + 'At' + k] = k === '0' ? `Lane ${i} stop` : `Lane ${i} at ${k} mph`; COLORS['lane' + i + 'At' + k] = c; }
  }

  let learned = {};
  try { learned = JSON.parse(localStorage.getItem(LEARN_KEY) || '{}') || {}; } catch { learned = {}; }
  const saveLearned = () => { try { localStorage.setItem(LEARN_KEY, JSON.stringify(learned)); } catch { /* */ } };
  const mapFor = (pid) => Object.assign({}, DEFAULTS[pid] || {}, learned[pid] || {});
  const lookup = (pid, control) => { const a = mapFor(pid)[control]; return typeof a === 'string' && !control.startsWith('_') ? a : null; };

  // short names for the hints under the buttons
  const DEV_SHORT = { 'behringer-xtouch-mini': 'XT', 'novation-launchpad-mini-mk3': 'LP', 'novation-launchpad-mini': 'LP', 'korg-nanokey2': 'nK' };
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function ctlShort(pid, id) {
    let m;
    if ((m = /^btn([ab])(\d)$/.exec(id))) return (m[1] === 'a' ? 'top' : 'bot') + m[2];
    if ((m = /^pad\.(\d)\.(\d)$/.exec(id))) return `r${+m[1] + 1}c${+m[2] + 1}`;
    if ((m = /^side(\d)$/.exec(id))) return 'side' + m[1];
    if ((m = /^key(\d+)$/.exec(id))) return NOTE[+m[1] % 12] + (+m[1] >= 12 ? (+m[1] >= 24 ? "''" : "'") : '');
    if ((m = /^enc(\d)$/.exec(id))) return 'knob' + m[1];
    return id;
  }

  // ------------------------------------------------------------------ the hub
  const hub = new CT45.MidiHub();
  let status = hub.supported ? 'not connected' : 'Web MIDI is not available in this browser (use Chrome or Edge)';
  hub.on('connect', (d) => { d.autoRing = false; setTimeout(() => { lights(d, true); refresh(); C.toast(`MIDI: ${d.profile.name || d.profile.id} connected`); }, 60); });
  hub.on('disconnect', (d) => { refresh(); C.toast(`MIDI: ${d.profile.name || d.profile.id} disconnected`); });
  hub.on('status', () => refresh());

  let learning = null;
  hub.on('input', (e) => {
    const d = e.device, pid = d.profile.id, ctl = e.control;
    if (learning) {                                          // assign this control to the button being learned
      const isValue = e.type === 'encoder' || e.type === 'knob' || e.type === 'fader';
      if (!isValue && e.action !== 'press') return;
      if (e.type === 'bender') return;
      let action = learning.action;
      if (isValue) action = BUTTON_TO_VALUE[action] || (VALUE_ACTIONS.has(action) ? action : null);
      if (!action) { C.toast(`"${NAMES[learning.action]}" needs a button, pad or key (not a knob)`); return; }
      (learned[pid] = learned[pid] || {})[ctl] = action; saveLearned();
      C.toast(`${d.profile.name || pid} · ${ctlShort(pid, ctl)} → ${NAMES[action]}`);
      endLearn(); lights(d, true); refresh();
      return;
    }
    const action = lookup(pid, ctl);
    if (!action) return;
    if (VALUE_ACTIONS.has(action)) {
      if (e.type === 'encoder' && e.delta) C.setValue(action, { delta: e.delta });
      else if (e.type === 'knob' || e.type === 'fader') C.setValue(action, { value: e.value });
      else if (e.type === 'bender') C.setValue(action, { value: (e.value + 1) / 2 });
      else if (e.action === 'press') C.setValue(action, { delta: 1 });
      return;
    }
    if (e.action === 'press') C.act(action, 'press');
    else if (e.action === 'release') C.act(action, 'release');
  });

  async function connect() {
    if (!hub.supported) { refresh(); return; }
    status = 'asking the browser for MIDI…'; refresh();
    const r = await hub.start();
    status = r.ok ? `on${r.sysex ? ' (with sysex — full Launchpad colours)' : ' (no sysex — approximate Launchpad colours)'}` : 'refused: ' + r.error;
    refresh();
    for (const d of hub.list()) lights(d, true);
  }

  // ------------------------------------------------------------------ lights
  const dim = (hex, k) => { const n = parseInt(hex.slice(1), 16); return '#' + [16, 8, 0].map(s => Math.round(((n >> s) & 255) * k).toString(16).padStart(2, '0')).join(''); };
  const VALUE_FRAC = { heliSpeed: () => Math.min(1, C.S.heliMph / 80), altitude: () => Math.log(C.heli.hT / 15.24) / Math.log(300), others: () => C.S.others / 3 };
  for (let i = 1; i <= 8; i++) VALUE_FRAC['lane' + i] = () => C.S.laneMph[i - 1] / 80;
  // Launchpad ladder: a pad is "on" when its lane is at that speed or faster (a bar graph per lane)
  const ladderOn = (action) => { const m = /^lane(\d)At(\d+)$/.exec(action); if (!m) return undefined; const i = +m[1] - 1, k = +m[2], st = C.S.laneStop[i] || C.S.allStop;
    return k === 0 ? st : !st && C.S.laneMph[i] >= k; };
  function lights(d, force) {
    if (!d || !d.connected && !d.simulated) return;
    const map = mapFor(d.profile.id);
    for (const [ctl, action] of Object.entries(map)) {
      if (ctl.startsWith('_')) continue;
      const c = d.control(ctl); if (!c || !c.led) continue;
      const kind = c.led.kind;
      try {
        if (kind === 'ring-mackie') { if (VALUE_FRAC[action]) d.setLight(ctl, Math.max(0.02, VALUE_FRAC[action]()), { style: 'fan' }); continue; }
        const on = C.isOn(action) !== undefined ? C.isOn(action) : ladderOn(action);
        if (kind === 'mono') d.setLight(ctl, action === 'record' && on ? 'blink' : !!on);
        else {
          const col = COLORS[action] || '#ffffff';
          d.setLight(ctl, on === undefined ? dim(col, 0.35) : on ? col : dim(col, 0.12));
        }
      } catch (err) { if (force) console.warn('CT30 light', ctl, err); }
    }
  }
  C.onChange(() => { for (const d of hub.list()) lights(d); hints(); });

  // ------------------------------------------------------------------ learning (right-click a button)
  function endLearn() { if (learning) learning.btn.classList.remove('learn'); learning = null; }
  C.setLearnHook((action, btn) => {
    endLearn();
    if (!hub.list().length) { C.toast('Connect a MIDI device first (MIDI button), then right-click a button and press a control'); return; }
    learning = { action, btn }; btn.classList.add('learn');
    C.toast(`Press (or turn) the MIDI control for "${NAMES[action]}" — Esc cancels`, 8000);
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && learning) { endLearn(); C.toast('Cancelled'); } });

  // ------------------------------------------------------------------ panel, chip, hints
  function hints() {
    const devs = hub.list();
    for (const b of C.buttons) {
      const a = b.dataset.action, out = [];
      for (const d of devs) {
        const map = mapFor(d.profile.id), sh = DEV_SHORT[d.profile.id] || 'MIDI';
        for (const [ctl, act] of Object.entries(map)) if (act === a && !ctl.startsWith('_')) { out.push(sh + ' ' + ctlShort(d.profile.id, ctl)); break; }
      }
      const m = b.querySelector('.m'); if (m) m.textContent = out.slice(0, 2).join(' · ');
    }
  }
  function refresh() {
    const devs = hub.list();
    $('midiChip').textContent = hub.status === 'running' ? (devs.length ? devs.length + ' device' + (devs.length > 1 ? 's' : '') : 'no devices') : (hub.supported ? 'off' : 'n/a');
    $('midiStatus').textContent = 'MIDI: ' + status + (hub.status === 'running' ? ` · ${devs.length} device(s)` : '');
    C.setMidiLine('MIDI: ' + (hub.status === 'running' ? (devs.length ? devs.map(d => (d.profile.name || d.profile.id) + (d.simulated ? ' (sim)' : '')).join(', ') : 'no devices plugged in') : status));
    const box = $('midiDevices'); box.innerHTML = '';
    for (const d of devs) {
      const pid = d.profile.id, map = mapFor(pid), lr = learned[pid] || {};
      const h = document.createElement('h3'); h.textContent = `${d.profile.name || pid}  (${d.portNames.join(' | ')})`; box.appendChild(h);
      const t = document.createElement('table');
      t.innerHTML = '<tr><th>control</th><th>action</th></tr>' + Object.entries(map).filter(([k]) => !k.startsWith('_'))
        .map(([k, a]) => `<tr><td>${ctlShort(pid, k)} <span style="color:#8a8597">(${k})</span></td><td class="${lr[k] ? 'learned' : ''}">${NAMES[a] || a}</td></tr>`).join('');
      if (map._layout) { const p = document.createElement('p'); p.textContent = map._layout; box.appendChild(p); }
      box.appendChild(t);
    }
    hints();
  }
  $('b_midi').onclick = () => { $('midiPanel').classList.toggle('on'); refresh(); };
  $('midiConnect').onclick = () => connect();
  $('midiForget').onclick = () => { learned = {}; saveLearned(); refresh(); for (const d of hub.list()) lights(d, true); C.toast('Learned MIDI forgotten — back to the defaults'); };

  window.CT30.midi = { hub, connect, lookup, get learned() { return learned; }, refresh };
  refresh();
  if (new URLSearchParams(location.search).get('midi') !== '0') connect();   // ask at once; Chrome remembers the answer
})();
