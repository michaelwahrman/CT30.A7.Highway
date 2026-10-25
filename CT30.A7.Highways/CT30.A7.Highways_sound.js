/* CT30.A7.Highways -- sound (off until you press Sound or S).
 *
 * As in CT55: ONE software synthesizer makes every sample, for the speakers and for the movie, so a recording's
 * sound is exactly what you hear and is locked to the picture.
 *   * Not recording: a ScriptProcessor pulls Synth.render() in real time (48 kHz).
 *   * Recording: each movie frame renders exactly 48000/fps samples in the frame loop; they go to the movie's audio
 *     encoder and to a small queue the speakers play from.
 *
 * Voices:  road  - tyre / engine roar: band-passed noise whose loudness and pitch follow the traffic speed under
 *                  the helicopter and fall off with altitude
 *          rotor - the helicopter: a soft low thump at the blade rate (about 19 a second) with a little whine
 * Nothing is loaded from the internet; no sound files.
 */
(function (global) {
  'use strict';
  const SR = 48000;

  class Synth {
    constructor() {
      this.seed = 0x30a1;
      this.road = { level: 0, target: 0, fc: 300, fcT: 300, lpL: 0, bpL: 0, lpR: 0, bpR: 0 };
      this.rotor = { level: 0, target: 0, ph: 0, wph: 0 };
      this.master = 0.8; this.muted = true;            // off until the Sound button
    }
    rnd() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
    clear() { this.road.level = 0; this.rotor.level = 0; }
    /** speed: mean speed of the traffic in view, m/s; height: helicopter altitude, m */
    setScene(speed, height) {
      const near = 1 / (1 + height / 150);
      this.road.target = Math.min(1, 0.08 + speed / 25) * near;
      this.road.fcT = 160 + speed * 22;
      this.rotor.target = 0.55;
    }
    /** n stereo samples, planar [L0..Ln-1, R0..Rn-1] */
    render(n) {
      const out = new Float32Array(2 * n), dt = 1 / SR, Rd = this.road, Ro = this.rotor;
      const k = 1 - Math.exp(-dt / 0.4);
      for (let s = 0; s < n; s++) {
        Rd.level += (Rd.target - Rd.level) * k; Rd.fc += (Rd.fcT - Rd.fc) * k;
        Ro.level += (Ro.target - Ro.level) * k;
        // road: two decorrelated noise channels through a state-variable band-pass
        const F = 2 * Math.sin(Math.PI * Math.min(4000, Rd.fc) / SR), Q = 1.1;
        const nl = this.rnd() * 2 - 1, nr = this.rnd() * 2 - 1;
        Rd.lpL += F * Rd.bpL; const hpL = nl - Rd.lpL - Q * Rd.bpL; Rd.bpL += F * hpL;
        Rd.lpR += F * Rd.bpR; const hpR = nr - Rd.lpR - Q * Rd.bpR; Rd.bpR += F * hpR;
        let L = Rd.bpL * Rd.level * 0.35, R = Rd.bpR * Rd.level * 0.35;
        // rotor: blade-pass thump (19 Hz) shaping low noise, plus a faint turbine whine
        Ro.ph += 19 * dt; if (Ro.ph >= 1) Ro.ph -= 1;
        const env = Math.exp(-Ro.ph * 9);
        Ro.wph += 1150 * dt; if (Ro.wph >= 1) Ro.wph -= 1;
        const th = (Rd.lpL * 0.9 + Math.sin(2 * Math.PI * Ro.ph * 2) * 0.5) * env * Ro.level * 0.5 + Math.sin(2 * Math.PI * Ro.wph) * 0.012 * Ro.level;
        L += th; R += th;
        out[s] = L; out[n + s] = R;
      }
      const m = this.muted ? 0 : this.master;
      for (let i = 0; i < 2 * n; i++) out[i] = Math.tanh(out[i] * m * 1.4);
      return out;
    }
  }

  /** speakers: real-time pull when live; a queue fed by the movie frames while recording (from CT55.A7) */
  class Speaker {
    constructor(synth) { this.synth = synth; this.ctx = null; this.mode = 'live'; this.q = []; this.qLen = 0; this.qOff = 0; }
    get running() { return !!this.ctx && this.ctx.state === 'running'; }
    start() {
      if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
      const AC = global.AudioContext || global.webkitAudioContext; if (!AC) return;
      try { this.ctx = new AC({ sampleRate: SR }); } catch { this.ctx = new AC(); }
      const node = this.ctx.createScriptProcessor(1024, 0, 2);
      node.onaudioprocess = (e) => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1), n = L.length;
        if (this.mode === 'live') { const b = this.synth.render(n); L.set(b.subarray(0, n)); R.set(b.subarray(n)); return; }
        let w = 0;
        while (w < n && this.q.length) {
          const b = this.q[0], bn = b.length / 2, take = Math.min(n - w, bn - this.qOff);
          L.set(b.subarray(this.qOff, this.qOff + take), w); R.set(b.subarray(bn + this.qOff, bn + this.qOff + take), w);
          w += take; this.qOff += take; this.qLen -= take;
          if (this.qOff >= bn) { this.q.shift(); this.qOff = 0; }
        }
        for (; w < n; w++) { L[w] = 0; R[w] = 0; }
      };
      node.connect(this.ctx.destination);
      this.node = node;
      if (this.ctx.state !== 'running') this.ctx.resume();
    }
    setMode(m) { this.mode = m; this.q.length = 0; this.qLen = 0; this.qOff = 0; }
    feed(buf) {
      if (this.mode !== 'film' || !this.running) return;
      this.q.push(buf); this.qLen += buf.length / 2;
      while (this.qLen > SR * 0.35 && this.q.length > 1) { const b = this.q.shift(); this.qLen -= b.length / 2 - this.qOff; this.qOff = 0; }
    }
  }

  global.CT30Sound = { SR, Synth, Speaker };
})(window);
