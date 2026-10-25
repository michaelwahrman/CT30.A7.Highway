/* CT30.A7.Highways -- the movie recorder (the CT55.A7 one, carried over from CT54.A6, which fixed every movie problem CT54 had).
 *
 * The CT54 lessons, all applied here:
 *  1. No ffmpeg, no server, no batch file: the browser's own WebCodecs encoder makes the MP4 (mp4-muxer 5.2.1, MIT,
 *     bundled) and it is DOWNLOADED when you stop recording.
 *  2. Right speed: the movie has a CONSTANT frame rate; frame i is stamped exactly i/fps. The frame loop
 *     (main.js tick()) advances the scene by exactly 1/fps per recorded frame, so the movie plays at the speed the
 *     screen shows when not recording, even if recording makes the screen itself run slower.
 *  3. Full resolution: the movie is the canvas at its real device-pixel size (what you see), up to 3840x2160.
 *  4. Sharp: constant-quality software H.264 first (some hardware encoders ignore the bit rate and smear detail),
 *     then high-bit-rate H.264 profiles, then VP9. Every candidate must really encode a test frame first.
 *  5. Sound: the same software synth the speakers use renders each frame's 48000/fps samples -> AAC (else Opus),
 *     locked to the picture.
 *  6. The page never waits on the recorder: everything has a time limit.
 *  URL options: ?q=18 (quality, lower = sharper), ?mbps=, ?encoder=hw (hardware encoder first).
 */
(function (global) {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const QUALITY = Math.max(0, Math.min(51, parseFloat(qs.get('q') ?? '18')));
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  const mbpsFor = (w, h, fps) => (w * h > 2560 * 1440 ? 120 : w * h > 1920 * 1080 ? 80 : w * h > 1280 * 720 ? 50 : 25) * Math.max(1, fps / 30) * 0.75;
  // H.264 level from the macroblocks per frame and per second
  function avcLevel(w, h, fps) {
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16), rate = mbs * fps;
    for (const [code, maxFs, maxRate] of [['2a', 8704, 522240], ['32', 22080, 589824], ['33', 36864, 983040], ['34', 36864, 2073600]])
      if (mbs <= maxFs && rate <= maxRate) return code;
    return '34';
  }
  const vp9Level = (w, h, fps) => (w * h <= 2228224 && w * h * fps <= 133693440 ? '41' : '51');

  function candidates(w, h, fps) {
    const L = avcLevel(w, h, fps), V = vp9Level(w, h, fps), sw = 'prefer-software', any = 'no-preference', hw = 'prefer-hardware';
    const list = [
      { codec: 'avc1.42E0' + L, mux: 'avc', accel: sw, mode: 'quantizer', name: 'H.264 (software, constant quality q' + QUALITY + ')' },
      { codec: 'avc1.42E0' + L, mux: 'avc', accel: sw, mode: 'variable', name: 'H.264 (software)' },
      { codec: 'avc1.6400' + L, mux: 'avc', accel: any, mode: 'variable', name: 'H.264 (high profile)' },
      { codec: 'avc1.4d00' + L, mux: 'avc', accel: any, mode: 'variable', name: 'H.264 (main profile)' },
      { codec: 'avc1.42E0' + L, mux: 'avc', accel: any, mode: 'variable', name: 'H.264 (baseline)' },
      { codec: 'vp09.00.' + V + '.08', mux: 'vp9', accel: any, mode: 'quantizer', name: 'VP9 (constant quality)' },
      { codec: 'vp09.00.' + V + '.08', mux: 'vp9', accel: any, mode: 'variable', name: 'VP9' },
    ];
    if (qs.get('encoder') === 'hw') return list.filter(c => c.accel !== sw).map(c => Object.assign({}, c, { accel: hw })).concat(list);
    return list;
  }
  function config(c, w, h, fps) {
    const o = { codec: c.codec, width: w, height: h, framerate: fps, hardwareAcceleration: c.accel, latencyMode: 'quality', bitrateMode: c.mode };
    if (c.mode !== 'quantizer') o.bitrate = Math.max(1e6, parseFloat(qs.get('mbps') ?? mbpsFor(w, h, fps)) * 1e6);
    if (c.mux === 'avc') o.avc = { format: 'avc' };
    return o;
  }
  function encodeOpts(c) {
    if (c.mode !== 'quantizer') return {};
    return c.mux === 'avc' ? { avc: { quantizer: QUALITY } } : { vp9: { quantizer: Math.round(QUALITY * 63 / 51) } };
  }
  async function probe(c, w, h, fps) {
    let ok = false, bad = false, e1 = null;
    try {
      e1 = new VideoEncoder({ output: () => { ok = true; }, error: () => { bad = true; } });
      e1.configure(config(c, w, h, fps));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d'); g.fillStyle = '#eee'; g.fillRect(0, 0, w, h); g.fillStyle = '#f9c'; g.fillRect(w / 4, h / 4, w / 2, h / 2);
      const f = new VideoFrame(cv, { timestamp: 0, duration: Math.round(1e6 / fps) });
      e1.encode(f, Object.assign({ keyFrame: true }, encodeOpts(c))); f.close();
      const done = await withTimeout(e1.flush().then(() => true, () => { bad = true; return true; }), 10000);
      if (!done && !bad) ok = true;
    } catch { bad = true; }
    try { if (e1 && e1.state !== 'closed') e1.close(); } catch { /* */ }
    return ok && !bad;
  }

  const cache = new Map();          // "w x h @ fps" -> chosen codec
  let audioPick = undefined;
  const tried = [];
  async function choose(w, h, fps) {
    const key = `${w}x${h}@${fps}`;
    if (cache.has(key)) return cache.get(key);
    let pick = null;
    for (const c of candidates(w, h, fps)) {
      const s = await withTimeout(VideoEncoder.isConfigSupported(config(c, w, h, fps)).catch(() => null), 2500);
      if (!(s && s.supported)) { tried.push(`${key} ${c.name}: not offered`); continue; }
      if (await probe(c, w, h, fps)) { tried.push(`${key} ${c.name}: OK`); pick = c; break; }
      tried.push(`${key} ${c.name}: failed on a test frame`);
    }
    cache.set(key, pick);
    return pick;
  }
  async function chooseAudio(SR) {
    if (audioPick !== undefined) return audioPick;
    audioPick = null;
    if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
      for (const [codec, m] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
        const s = await withTimeout(AudioEncoder.isConfigSupported({ codec, sampleRate: SR, numberOfChannels: 2, bitrate: 192000 }).catch(() => null), 2500);
        if (s && s.supported) { audioPick = { codec, mux: m }; break; }
      }
    }
    return audioPick;
  }
  const supported = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && !!global.Mp4Muxer;

  /** Get the encoders ready for this size (in the background; safe to call often). */
  async function prepare(w, h, fps, SR) {
    if (!supported()) return null;
    const v = await withTimeout(choose(w, h, fps), 60000);
    await withTimeout(chooseAudio(SR), 6000);
    return v || null;
  }

  /** One take. */
  function Take(canvas, w, h, fps, SR, pick, apick) {
    let enc = null, aenc = null, mux = null, failed = '', bytes = 0, frames = 0, aSamples = 0;
    const parts = [];
    mux = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.StreamTarget({ chunked: true, chunkSize: 8 << 20,
        onData: (data, position) => parts.push({ pos: position, len: data.byteLength, blob: new Blob([data]) }) }),
      fastStart: false, firstTimestampBehavior: 'offset',
      video: { codec: pick.mux, width: w, height: h, frameRate: fps },
      ...(apick ? { audio: { codec: apick.mux, numberOfChannels: 2, sampleRate: SR } } : {}) });
    enc = new VideoEncoder({ output: (c, m) => { bytes += c.byteLength; mux.addVideoChunk(c, m); }, error: (e) => { failed = 'video: ' + (e && e.message || e); } });
    enc.configure(config(pick, w, h, fps));
    if (apick) {
      aenc = new AudioEncoder({ output: (c, m) => mux.addAudioChunk(c, m), error: (e) => { failed = 'sound: ' + (e && e.message || e); } });
      aenc.configure({ codec: apick.codec, sampleRate: SR, numberOfChannels: 2, bitrate: 192000 });
    }
    return {
      /** how many audio samples the next frame needs (exactly 48000/fps on average) */
      samplesForNextFrame() { return Math.round((frames + 1) * SR / fps) - aSamples; },
      /** the canvas as it is now = frame i; audio = that frame's samples (planar stereo Float32Array) */
      add(audio) {
        if (failed) return;
        try {
          const i = frames++, ts = Math.round(i * 1e6 / fps), dur = Math.round((i + 1) * 1e6 / fps) - ts;
          const f = new VideoFrame(canvas, { timestamp: ts, duration: dur });
          enc.encode(f, Object.assign({ keyFrame: i % (fps * 2) === 0 }, encodeOpts(pick))); f.close();
          if (aenc && audio) {
            const n = audio.length / 2;
            const a = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2,
              timestamp: Math.round(aSamples / SR * 1e6), data: audio });
            aenc.encode(a); a.close(); aSamples += n;
          }
        } catch (e) { failed = String(e && e.message || e); }
      },
      busy() { return enc.encodeQueueSize > 3 || (!!aenc && aenc.encodeQueueSize > 30); },
      async finish() {
        if (failed) throw new Error(failed);
        await enc.flush(); if (aenc) await aenc.flush();
        enc.close(); if (aenc) aenc.close();
        mux.finalize();
        let out = new Blob([]), end = 0;
        for (const p of parts) {
          if (p.pos >= end) out = new Blob(p.pos > end ? [out, new Uint8Array(p.pos - end), p.blob] : [out, p.blob]);
          else out = new Blob([out.slice(0, p.pos), p.blob, out.slice(Math.min(end, p.pos + p.len), end)]);
          end = Math.max(end, p.pos + p.len);
        }
        return new Blob([out], { type: 'video/mp4' });
      },
      abort() { try { enc.close(); } catch { /* */ } try { aenc && aenc.close(); } catch { /* */ } },
      get frames() { return frames; }, get seconds() { return frames / fps; }, get failed() { return failed; },
      get mbps() { return frames ? bytes * 8 / (frames / fps) / 1e6 : 0; },
      get codec() { return pick.name; }, get audio() { return apick ? (apick.mux === 'aac' ? 'AAC' : 'Opus') : 'none'; },
      w, h, fps,
    };
  }

  global.CT30Rec = { supported, prepare, Take, get tried() { return tried.slice(); }, get audioPick() { return audioPick; },
    cached: (w, h, fps) => cache.get(`${w}x${h}@${fps}`) };
})(window);
