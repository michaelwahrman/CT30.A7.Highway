/*
 * CT45.A1.USB -- ct45midi.js : the standard MIDI device layer.
 *
 * One API for every USB MIDI controller.  A device is described by a profile
 * (profiles/*.json, bundled into lib/ct45.profiles.js).  The hub finds devices
 * through Web MIDI, turns their raw MIDI into standard control events, keeps
 * their state, and drives their LEDs.  Unknown devices still work (generic
 * profile, controls created as they are used).  Every profile can also be run
 * as a SIMULATED device (no hardware) that behaves identically.
 *
 *   const hub = new CT45.MidiHub();              // uses window.CT45_PROFILES
 *   hub.on('connect',    dev => ...);            // real or simulated device appeared
 *   hub.on('disconnect', dev => ...);
 *   hub.on('input',      e   => ...);            // standard control event (below)
 *   await hub.start();                           // asks for Web MIDI (+ sysex) permission
 *   const sim = hub.addSimulated('korg-nanokey2');
 *   dev.setLight('pad.0.0', '#ff0000');          // colour / true / 'blink' / 0..1 (rings)
 *
 * Standard event:
 *   { deviceId, profile, device, control, type, action, value, delta, velocity,
 *     note, raw, time, virtual }
 *   type   : button | pad | key | encoder | knob | fader | bender | light
 *   action : press | release | change
 *   value  : buttons/pads/keys 1 or 0 (velocity separate, 0..1);
 *            encoder/knob/fader 0..1; bender -1..1
 *   delta  : encoders only, signed detent count of this message
 *
 * Browser support: Chrome / Edge (Web MIDI).  Works from file:// and localhost.
 */
(function (global) {
  'use strict';
  const VERSION = 'CT45.A1';

  // --------------------------------------------------------------- utilities
  class Emitter {
    constructor() { this._ev = {}; }
    on(t, f) { (this._ev[t] = this._ev[t] || []).push(f); return () => this.off(t, f); }
    off(t, f) { const a = this._ev[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } }
    emit(t, ...a) { for (const f of (this._ev[t] || []).slice()) { try { f(...a); } catch (e) { console.error(e); } } }
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const hex2 = b => b.toString(16).padStart(2, '0');
  const toHex = bytes => Array.from(bytes, hex2).join(' ');

  /** Any colour-ish value -> {r,g,b} 0..1, or null for "off". */
  function parseColor(v, onColor) {
    if (v === undefined || v === null || v === false || v === 0 || v === 'off') return null;
    if (v === true || v === 'on' || v === 'blink') return parseColor(onColor || '#ffffff');
    if (typeof v === 'number') { const g = clamp(v, 0, 1); const c = parseColor(onColor || '#ffffff'); return g ? { r: c.r * g, g: c.g * g, b: c.b * g } : null; }
    if (typeof v === 'string') {
      let s = v.trim();
      if (/^#?[0-9a-f]{3}$/i.test(s)) s = s.replace(/^#?(.)(.)(.)$/, '#$1$1$2$2$3$3');
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
      if (m) { const c = { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 }; return (c.r || c.g || c.b) ? c : null; }
      return null;
    }
    if (Array.isArray(v)) v = { r: v[0], g: v[1], b: v[2] };
    if (typeof v === 'object') {
      let { r = 0, g = 0, b = 0 } = v;
      if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
      return (r || g || b) ? { r: clamp(r, 0, 1), g: clamp(g, 0, 1), b: clamp(b, 0, 1) } : null;
    }
    return null;
  }
  const colorHex = c => c ? '#' + [c.r, c.g, c.b].map(x => hex2(Math.round(clamp(x, 0, 1) * 255))).join('') : null;

  /** Approximate Novation MK3 128-colour palette (used only when sysex RGB is unavailable). */
  const LP_PALETTE = (() => {
    const p = [[0, 0, 0], [.11, .11, .11], [.49, .49, .49], [1, 1, 1]];
    const hues = [0, 20, 50, 80, 120, 140, 165, 185, 200, 215, 240, 260, 280, 300, 330];
    const hsl = (h, s, l) => { const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
      const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return [f(0), f(8), f(4)]; };
    for (const h of hues) for (const [s, l] of [[1, .75], [1, .5], [1, .25], [1, .1]]) p.push(hsl(h, s, l));
    while (p.length < 128) p.push(hsl((p.length * 37) % 360, 1, .5));
    return p;
  })();
  function nearestPalette(c) {
    if (!c) return 0;
    let best = 0, bd = 1e9;
    LP_PALETTE.forEach((q, i) => { const d = (q[0] - c.r) ** 2 + (q[1] - c.g) ** 2 + (q[2] - c.b) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  }

  function portKey(name) {   // pairs "X In"/"X Out", "MIDIIN2 (X)"/"MIDIOUT2 (X)"
    return String(name || '').toLowerCase()
      .replace(/midi(in|out)\d*/g, 'midi#').replace(/\b(in|out|input|output)\b/g, '')
      .replace(/[^a-z0-9#]+/g, '');
  }
  const IGNORE_PORTS = /midi through|wavetable|microsoft gs/i;

  // ------------------------------------------------------------------ Device
  class Device extends Emitter {
    constructor(hub, profile, opts = {}) {
      super();
      this.hub = hub;
      this.profile = profile;
      this.instance = opts.instance || 1;
      this.id = `${profile.id}#${this.instance}`;
      this.name = opts.name || profile.name;
      this.simulated = !!opts.simulated;
      this.inputs = opts.inputs || [];
      this.outputs = opts.outputs || [];
      this.key = opts.key || this.id;
      this.connected = true;
      this.autoRing = true;          // encoder LED rings follow the encoder value
      this.encoderStep = 1 / 48;     // value change per encoder detent (2 turns = full range)
      this.controls = new Map();
      this.state = {};
      this._map = new Map();
      this._lastSent = new Map();
      this._rgbQueue = new Map();
      this._recent = new Map();
      this._activeNotes = new Map();
      const kb = profile.keyboard;
      this.keyboardBase = kb ? kb.firstNote : 0;
      for (const c of profile.controls || []) this._addControl(c);
    }

    get octave() { const kb = this.profile.keyboard; return kb ? (this.keyboardBase - kb.firstNote) / 12 : 0; }
    get hasOutput() { return this.outputs.length > 0; }
    /** Output port(s) for LED traffic: profile.ledOutput.prefer regexes in order, else all outputs. */
    get ledOutputs() {
      const pref = (this.profile.ledOutput && this.profile.ledOutput.prefer) || [];
      for (const r of pref) { const re = new RegExp(r, 'i'); const o = this.outputs.filter(p => re.test(p.name)); if (o.length) return o.slice(0, 1); }
      return this.outputs;
    }
    get portNames() { return [...new Set([...this.inputs, ...this.outputs].map(p => p.name))]; }
    control(id) { return this.controls.get(id); }

    _addControl(c) {
      this.controls.set(c.id, c);
      if (!this.state[c.id]) this.state[c.id] = { value: c.type === 'fader' || c.type === 'encoder' || c.type === 'knob' ? 0 : 0, pressed: false, light: null };
      const i = c.in;
      if (!i) return;
      const ch = i.ch === null || i.ch === undefined ? '*' : i.ch;
      if (i.note !== undefined) this._map.set(`n:${ch}:${i.note}`, c);
      if (i.cc !== undefined) this._map.set(`c:${ch}:${i.cc}`, c);
      if (i.pitchbend) this._map.set(`p:${ch}`, c);
    }
    _lookup(kind, ch, num) {
      const s = num === undefined ? '' : ':' + num;
      return this._map.get(`${kind}:${ch}${s}`) || this._map.get(`${kind}:*${s}`);
    }

    // ---------------------------------------------------------- input path
    _receive(data, port, virtual) {
      if (!data || !data.length) return;
      const st = data[0];
      if (st === 0xF8 || st === 0xFE) return;                 // clock / active sensing
      if (!virtual && this.inputs.length > 1) {                 // same message on 2 ports of one device
        const k = toHex(data), now = performance.now(), prev = this._recent.get(k);
        if (prev && prev.port !== port && now - prev.t < 6) return;
        this._recent.set(k, { t: now, port });
        if (this._recent.size > 64) this._recent.clear();
      }
      this.hub.emit('raw', { device: this, deviceId: this.id, data: Array.from(data), hex: toHex(data), port: port && port.name, virtual: !!virtual });
      if (st >= 0xF0) return;
      const type = st & 0xF0, ch = (st & 0x0F) + 1, d1 = data[1] || 0, d2 = data[2] || 0;
      if (type === 0x90 || type === 0x80) {
        const on = type === 0x90 && d2 > 0;
        let c = this._lookup('n', ch, d1), note;
        if (!c && this.profile.keyboard) { note = d1; c = this._keyFor(d1, on, ch); }
        if (!c && this.profile.generic) c = this._learn('note', ch, d1);
        if (c) this._apply(c, on ? 'press' : 'release', { velocity: on ? d2 / 127 : 0, note }, data, virtual);
      } else if (type === 0xB0) {
        let c = this._lookup('c', ch, d1);
        if (!c && this.profile.generic) c = this._learn('cc', ch, d1);
        if (c) this._fromCC(c, d2, data, virtual);
      } else if (type === 0xE0) {
        let c = this._lookup('p', ch);
        if (!c && this.profile.generic) c = this._learn('pb', ch);
        if (c) this._fromBend(c, d1 | (d2 << 7), data, virtual);
      } else if (type === 0xA0 || type === 0xD0) {
        const c = type === 0xA0 ? (this._lookup('n', ch, d1) || (this.profile.keyboard && this._keyForHeld(d1))) : null;
        this.hub._event(this, c, 'pressure', { value: (type === 0xA0 ? d2 : d1) / 127 }, data, virtual);
      }
    }

    _keyFor(note, on, ch) {
      const kb = this.profile.keyboard;
      if (kb.ch && kb.ch !== ch) return null;
      if (!on) { const held = this._activeNotes.get(note); this._activeNotes.delete(note); if (held !== undefined) return this.controls.get('key' + held); }
      if (kb.trackOctave !== false) {
        let moved = false;
        while (note < this.keyboardBase) { this.keyboardBase -= 12; moved = true; }
        while (note >= this.keyboardBase + kb.count) { this.keyboardBase += 12; moved = true; }
        if (moved) this.emit('octave', this.octave);
      }
      const idx = note - this.keyboardBase;
      if (idx < 0 || idx >= kb.count) return null;
      if (on) this._activeNotes.set(note, idx);
      return this.controls.get('key' + idx);
    }
    _keyForHeld(note) { const i = this._activeNotes.get(note); return i === undefined ? null : this.controls.get('key' + i); }

    _fromCC(c, v, data, virtual) {
      const mode = (c.in && c.in.mode) || 'absolute';
      if (mode === 'momentary') return this._apply(c, v >= 64 ? 'press' : 'release', { velocity: v / 127 }, data, virtual);
      if (mode === 'relative-mackie' || mode === 'relative-signed' || mode === 'relative-twos') {
        let d;
        if (mode === 'relative-mackie' || mode === 'relative-signed') d = (v & 0x40) ? -(v & 0x3F) : (v & 0x3F);
        else d = v >= 64 ? v - 128 : v;
        return this._apply(c, 'change', { delta: d }, data, virtual);
      }
      this._apply(c, 'change', { value: v / 127 }, data, virtual);
    }
    _fromBend(c, pb, data, virtual) {
      const i = c.in || {}, min = i.min ?? 0, max = i.max ?? 16383;
      if (c.type === 'bender') {
        const ctr = i.center ?? 8192;
        const v = pb >= ctr ? (pb - ctr) / Math.max(1, max - ctr) : -(ctr - pb) / Math.max(1, ctr - min);
        return this._apply(c, 'change', { value: clamp(v, -1, 1) }, data, virtual);
      }
      this._apply(c, 'change', { value: clamp((pb - min) / Math.max(1, max - min), 0, 1) }, data, virtual);
    }

    _apply(c, action, info, data, virtual) {
      const s = this.state[c.id];
      const ev = { action, velocity: info.velocity, note: info.note };
      if (action === 'press') { s.pressed = true; s.value = 1; s.velocity = info.velocity; }
      else if (action === 'release') { s.pressed = false; s.value = 0; }
      else if (info.delta !== undefined) {
        s.value = clamp(s.value + info.delta * this.encoderStep, 0, 1);
        ev.delta = info.delta;
        if (this.autoRing && c.led && c.led.kind && c.led.kind.startsWith('ring')) this.setLight(c.id, s.value);
      } else s.value = info.value;
      ev.value = s.value;
      this.hub._event(this, c, action, ev, data, virtual);
    }

    _learn(kind, ch, num) {
      const id = kind === 'pb' ? `ch${ch}.pb` : `ch${ch}.${kind}${num}`;
      if (this.controls.has(id)) return this.controls.get(id);
      const n = this.controls.size, col = n % 12, row = Math.floor(n / 12);
      const c = { id, type: kind === 'note' ? 'pad' : kind === 'cc' ? 'knob' : 'fader', shape: kind === 'cc' ? 'knob' : 'rect',
        label: kind === 'pb' ? `PB${ch}` : `${kind === 'note' ? 'N' : 'CC'}${num}`,
        x: 12 + col * 17, y: 12 + row * 17, w: 14, h: 14, r: 6,
        in: kind === 'note' ? { note: num, ch } : kind === 'cc' ? { cc: num, ch } : { pitchbend: true, ch } };
      if (kind === 'pb') { c.shape = 'rect'; }
      this.profile.controls.push(c);
      this.profile.size = { w: 12 * 17 + 7, h: Math.max(1, Math.ceil((n + 1) / 12)) * 17 + 7, d: 14 };
      this._addControl(c);
      this.emit('profilechange', this);
      this.hub.emit('profilechange', this);
      return c;
    }

    /** Draft profile JSON for a generic (unknown) device: save it into profiles/ and edit. */
    exportProfile() {
      const p = JSON.parse(JSON.stringify(this.profile));
      delete p.generic;
      p.schema = 'ct45.device/1';
      p.id = p.id === 'generic' ? String(this.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : p.id;
      return p;
    }

    // ------------------------------------------------ simulation / virtual input
    /**
     * Operate a control as if on the hardware: builds the MIDI message the device
     * would send and runs it through the same parser, so events are identical.
     *   inject('pad.0.0', 'press')  inject('pad.0.0', 'release')
     *   inject('enc1', {delta: 2})  inject('fader', {value: .5})  inject('key3', {velocity: .8})
     */
    inject(id, how) {
      const c = this.controls.get(id);
      if (!c) return false;
      if (typeof how === 'string') how = { action: how };
      how = how || { action: 'press' };
      const i = c.in, ch0 = ((i && i.ch) || 1) - 1;
      const on = how.action !== 'release';
      if (!i) {                                         // local-only control (e.g. nanoKEY2 OCT)
        if (on && c.local === 'octave-up') this.shiftOctave(1);
        if (on && c.local === 'octave-down') this.shiftOctave(-1);
        const s = this.state[c.id]; s.pressed = on; s.value = on ? 1 : 0;
        this.hub._event(this, c, on ? 'press' : 'release', { value: s.value }, [], true);
        return true;
      }
      let msg;
      const vel = Math.max(1, Math.round(clamp(how.velocity ?? how.value ?? 1, 0, 1) * 127));
      if (i.key !== undefined) {
        const kb = this.profile.keyboard, note = this.keyboardBase + i.key, kch = ((kb.ch) || 1) - 1;
        msg = on ? [0x90 | kch, note, vel] : [0x80 | kch, note, 0];
      } else if (i.note !== undefined) msg = on ? [0x90 | ch0, i.note, vel] : [0x80 | ch0, i.note, 0];
      else if (i.cc !== undefined) {
        const mode = i.mode || 'absolute';
        if (mode === 'momentary') msg = [0xB0 | ch0, i.cc, on ? 127 : 0];
        else if (mode.startsWith('relative')) {
          const d = Math.round(how.delta || 0); if (!d) return false;
          const m = Math.min(Math.abs(d), 63);
          msg = [0xB0 | ch0, i.cc, mode === 'relative-twos' ? (d > 0 ? m : 128 - m) : (d > 0 ? m : 0x40 | m)];
        } else msg = [0xB0 | ch0, i.cc, Math.round(clamp(how.value ?? 0, 0, 1) * 127)];
      } else if (i.pitchbend) {
        const min = i.min ?? 0, max = i.max ?? 16383, v = how.value ?? 0;
        let pb;
        if (c.type === 'bender') { const ctr = i.center ?? 8192; pb = v >= 0 ? ctr + v * (max - ctr) : ctr + v * (ctr - min); }
        else pb = min + clamp(v, 0, 1) * (max - min);
        pb = Math.round(clamp(pb, 0, 16383));
        msg = [0xE0 | ch0, pb & 0x7F, pb >> 7];
      }
      if (!msg) return false;
      this._receive(Uint8Array.from(msg), null, true);
      return true;
    }

    shiftOctave(n) {
      const kb = this.profile.keyboard; if (!kb) return;
      this.keyboardBase = clamp(this.keyboardBase + 12 * n, 0, 127 - kb.count + 1);
      this.emit('octave', this.octave);
      this.hub.emit('octave', { device: this, octave: this.octave });
    }

    // ------------------------------------------------------------- output path
    /**
     * Light a control's LED.
     *   mono LED (X-Touch)   : true | false | 'blink'
     *   RGB (Launchpad MK3)  : '#ff8000' | {r,g,b} | [r,g,b] | 0..1 grey ; opts {mode:'flash'|'pulse'}
     *   red/green (LP Mini)  : any colour, reduced to 4 levels of red and green
     *   ring (X-Touch enc)   : 0..1 position ; opts {style:'dot'|'fan'|'spread'|'boost'}
     * Works on simulated devices too (state only), so the 3D model shows it.
     */
    setLight(id, value, opts = {}) {
      const c = this.controls.get(id);
      if (!c || !c.led) return false;
      const led = c.led, s = this.state[id], look = this.profile.look || {};
      let msg = null;
      if (led.kind === 'mono') {
        const on = !!value && value !== 'off', blink = value === 'blink' || opts.blink;
        s.light = on ? { on: true, blink: !!blink, color: parseColor(look.led || '#ff3a1c') } : null;
        msg = [0x90 | (led.ch - 1), led.note, on ? (blink ? led.blink : led.on) : led.off];
      } else if (led.kind === 'ring-mackie') {
        const v = value === true ? 1 : clamp(Number(value) || 0, 0, 1);
        const style = opts.style || s.ringStyle || 'fan';
        s.ringStyle = style;
        const pos = v <= 0 ? 0 : 1 + Math.round(v * (led.positions - 1));
        const off = { dot: 0, boost: 16, fan: 32, spread: 48 }[style] ?? 32;
        s.light = v > 0 || style === 'boost' ? { ring: v, style, color: parseColor(look.led || '#ff3a1c') } : null;
        msg = [0xB0 | (led.ch - 1), led.cc, pos ? off + pos : 0];
      } else if (led.kind === 'rgb-lpmk3') {
        const col = parseColor(value, '#ffffff');
        s.light = col ? { color: col, mode: opts.mode || 'static' } : null;
        return this._queueRGB(id, led, col, opts.mode), this._lightChanged(id), true;
      } else if (led.kind === 'rg-lp') {
        const col = parseColor(value, '#ff9020');
        const r = col ? Math.round(col.r * 3) : 0, g = col ? Math.round(col.g * 3) : 0;
        s.light = r || g ? { color: { r: r / 3, g: g / 3, b: 0 } } : null;
        const vel = 16 * g + r + 12;
        msg = led.note !== undefined ? [0x90, led.note, vel] : [0xB0, led.cc, vel];
      }
      if (msg) this._sendDedup(id, msg, this.ledOutputs);
      this._lightChanged(id);
      return true;
    }
    _lightChanged(id) { this.emit('light', id, this.state[id].light); this.hub.emit('light', { device: this, control: id, light: this.state[id].light }); }

    _queueRGB(id, led, col, mode) {
      if (!this.hasOutput) return;
      this._rgbQueue.set(led.index, { led, col, mode: mode || 'static' });
      if (!this._rgbTimer) this._rgbTimer = setTimeout(() => this._flushRGB(), 0);
    }
    _flushRGB() {
      this._rgbTimer = null;
      const items = [...this._rgbQueue.values()];
      this._rgbQueue.clear();
      if (!items.length) return;
      const outs = this.ledOutputs;
      if (this.hub.sysex) {
        const specs = items.map(({ led, col, mode }) =>
          mode === 'flash' ? [1, led.index, 0, nearestPalette(col)] :
          mode === 'pulse' ? [2, led.index, nearestPalette(col)] :
          [3, led.index, ...(col ? [col.r, col.g, col.b].map(x => Math.round(x * 127)) : [0, 0, 0])]);
        for (let i = 0; i < specs.length; i += 81)                    // whole specs per message; 81 = every LED
          this.send([0xF0, 0x00, 0x20, 0x29, 0x02, 0x0D, 0x03, ...specs.slice(i, i + 81).flat(), 0xF7], outs);
      } else {                                                         // no sysex: palette via note/CC
        for (const { led, col, mode } of items) {
          const chn = mode === 'flash' ? 1 : mode === 'pulse' ? 2 : 0;
          const idx = nearestPalette(col);
          this.send(led.note !== undefined ? [0x90 | chn, led.note, idx] : [0xB0 | chn, led.cc, idx], outs);
        }
      }
    }
    _sendDedup(id, msg, outs) {
      const k = msg.join(',');
      if (this._lastSent.get(id) === k) return;
      this._lastSent.set(id, k);
      this.send(msg, outs);
    }
    /** Turn every LED off (and rings to 0). */
    clearLights() {
      this._lastSent.clear();
      for (const c of this.controls.values()) if (c.led) this.setLight(c.id, 0);
    }
    /** Raw MIDI out: to every output port of this device (or the given ports). */
    send(bytes, ports) {
      const outs = ports || this.outputs;
      for (const o of outs) {
        try { o.send(bytes); } catch (e) { if (!this._warned) { console.warn(`${this.id}: send failed`, e.message); this._warned = true; } }
      }
      if (outs.length) this.hub.emit('sent', { device: this, deviceId: this.id, data: Array.from(bytes), hex: toHex(bytes) });
    }

    _init() {
      for (const m of this.profile.init || []) {
        if (m[0] === 0xF0 && !this.hub.sysex) { this.hub.emit('warning', `${this.name}: needs sysex permission for setup (${this.profile.notes || ''})`); continue; }
        this.send(m);
      }
      if (this.hasOutput) setTimeout(() => this.clearLights(), 60);
    }
    _exit() {
      for (const m of this.profile.exit || []) if (m[0] !== 0xF0 || this.hub.sysex) this.send(m);
    }
  }

  // ------------------------------------------------------------------- MidiHub
  class MidiHub extends Emitter {
    constructor(opts = {}) {
      super();
      this.version = VERSION;
      this.profiles = new Map();
      for (const p of opts.profiles || global.CT45_PROFILES || []) this.addProfile(p);
      this.generic = opts.generic !== false;
      this.devices = new Map();
      this.access = null;
      this.sysex = false;
      this.status = (global.navigator && navigator.requestMIDIAccess) ? 'idle' : 'unsupported';
    }
    addProfile(p) { this.profiles.set(p.id, p); }
    get supported() { return this.status !== 'unsupported'; }
    list() { return [...this.devices.values()]; }
    find(profileId) { return this.list().filter(d => d.profile.id === profileId); }

    /** Ask for Web MIDI. Tries with sysex first (Launchpad MK3 needs it), then without. */
    async start({ sysex = true } = {}) {
      if (!this.supported) { this.emit('status', this.status); return { ok: false, error: 'Web MIDI not available (use Chrome or Edge)' }; }
      let err = null;
      for (const sx of sysex ? [true, false] : [false]) {
        try { this.access = await navigator.requestMIDIAccess({ sysex: sx }); this.sysex = sx; break; }
        catch (e) { err = e; }
      }
      if (!this.access) { this.status = 'denied'; this.emit('status', this.status); return { ok: false, error: String(err && err.message || err) }; }
      this.status = 'running';
      this.access.onstatechange = () => { clearTimeout(this._scanT); this._scanT = setTimeout(() => this.rescan(), 150); };
      this.rescan();
      this._unload = () => this.stop();
      global.addEventListener && global.addEventListener('beforeunload', this._unload);
      this.emit('status', this.status);
      return { ok: true, sysex: this.sysex };
    }

    stop() {
      for (const d of this.list()) if (!d.simulated) { d._exit(); this._detach(d); }
      if (this.access) this.access.onstatechange = null;
      this.status = this.supported ? 'idle' : 'unsupported';
    }

    /** A device that exists only in software -- behaves exactly like the hardware. */
    addSimulated(profileId) {
      const p = this.profiles.get(profileId);
      if (!p) throw new Error('unknown profile ' + profileId);
      const d = new Device(this, JSON.parse(JSON.stringify(p)), { simulated: true, instance: this._nextInstance(p.id, true) });
      d.id = `${p.id}#sim${d.instance}`;
      this.devices.set(d.id, d);
      this.emit('connect', d);
      return d;
    }
    removeDevice(d) { if (this.devices.delete(d.id)) { d.connected = false; this.emit('disconnect', d); } }

    _nextInstance(pid, sim) {
      const used = new Set(this.list().filter(d => d.profile.id === pid && d.simulated === !!sim).map(d => d.instance));
      let i = 1; while (used.has(i)) i++; return i;
    }

    _matches(p, name) {
      const n = String(name || '').toLowerCase(), m = p.match || {};
      if (!(m.portName || []).some(s => n.includes(s.toLowerCase()))) return false;
      return !(m.exclude || []).some(s => n.includes(s.toLowerCase()));
    }

    rescan() {
      if (!this.access) return;
      const ins = [...this.access.inputs.values()].filter(p => p.state !== 'disconnected' && !IGNORE_PORTS.test(p.name));
      const outs = [...this.access.outputs.values()].filter(p => p.state !== 'disconnected' && !IGNORE_PORTS.test(p.name));
      const wanted = new Map();   // key -> {profile, inputs, outputs, name}
      const usedIn = new Set(), usedOut = new Set();
      const profs = [...this.profiles.values()].sort((a, b) => (b.match?.portName || [''])[0].length - (a.match?.portName || [''])[0].length);
      for (const p of profs) {
        const pin = ins.filter(i => !usedIn.has(i.id) && this._matches(p, i.name)).sort((a, b) => a.name.localeCompare(b.name));
        const pout = outs.filter(o => !usedOut.has(o.id) && this._matches(p, o.name)).sort((a, b) => a.name.localeCompare(b.name));
        const per = Math.max(1, p.portsPerDevice || 1);
        const groups = Math.max(Math.ceil(pin.length / per), Math.ceil(pout.length / per));
        for (let g = 0; g < groups; g++) {
          const gi = pin.slice(g * per, g * per + per);
          const keys = new Set(gi.map(i => portKey(i.name)));
          let go = pout.filter(o => keys.has(portKey(o.name)) && !usedOut.has(o.id));
          if (!go.length) go = pout.slice(g * per, g * per + per).filter(o => !usedOut.has(o.id));
          gi.forEach(i => usedIn.add(i.id)); go.forEach(o => usedOut.add(o.id));
          const key = p.id + '|' + [...gi, ...go].map(x => x.id).sort().join(',');
          wanted.set(key, { profile: p, inputs: gi, outputs: go, name: (gi[0] || go[0]).name });
        }
      }
      if (this.generic) {
        for (const i of ins) if (!usedIn.has(i.id)) {
          const o = outs.find(x => !usedOut.has(x.id) && portKey(x.name) === portKey(i.name));
          if (o) usedOut.add(o.id);
          const gp = { schema: 'ct45.device/1', id: 'generic', name: i.name, maker: i.manufacturer || '', generic: true,
            notes: 'Unknown device: controls are created as they are used. Export a draft profile to make it permanent.',
            match: { portName: [i.name] }, size: { w: 60, h: 30, d: 14 },
            look: { body: '#2a2d33', panel: '#1b1d21', led: '#34c3ff', cap: '#4a4f58', text: '#cfd3da' }, controls: [] };
          wanted.set('generic|' + [i, o].filter(Boolean).map(x => x.id).sort().join(','), { profile: gp, inputs: [i], outputs: o ? [o] : [], name: i.name });
        }
      }
      for (const d of this.list()) if (!d.simulated && !wanted.has(d.key)) this._detach(d);
      for (const [key, w] of wanted) {
        if ([...this.devices.values()].some(d => d.key === key)) continue;
        const prof = w.profile.generic ? w.profile : JSON.parse(JSON.stringify(w.profile));
        const d = new Device(this, prof, { inputs: w.inputs, outputs: w.outputs, key, name: w.name, instance: this._nextInstance(prof.id, false) });
        this.devices.set(d.id, d);
        for (const inp of w.inputs) {
          const h = e => d._receive(e.data, inp, false);
          inp.addEventListener('midimessage', h);
          (d._handlers = d._handlers || []).push([inp, h]);
          if (inp.open) inp.open().catch(() => {});
        }
        d._init();
        this.emit('connect', d);
      }
    }

    _detach(d) {
      for (const [inp, h] of d._handlers || []) inp.removeEventListener('midimessage', h);
      d._handlers = [];
      this.removeDevice(d);
    }

    _event(dev, c, action, info, raw, virtual) {
      const ev = {
        deviceId: dev.id, profile: dev.profile.id, device: dev,
        control: c ? c.id : null, type: c ? c.type : 'unknown', action,
        value: info.value, delta: info.delta, velocity: info.velocity, note: info.note,
        raw: Array.from(raw || []), time: performance.now(), virtual: !!virtual,
      };
      dev.emit('input', ev);
      this.emit('input', ev);
    }
  }

  global.CT45 = Object.assign(global.CT45 || {}, { VERSION, MidiHub, Device, parseColor, colorHex, toHex, LP_PALETTE, nearestPalette });
})(typeof window !== 'undefined' ? window : globalThis);
