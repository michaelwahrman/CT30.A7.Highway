/* CT30.A7.Highways -- a traffic helicopter over a jammed freeway network.
 *
 * A7: the cars are the top-down car photos (atlas in CT30.A7.Highways_cars.js, made by tools/make_car_atlas.py): each
 * car is a textured quad facing its direction of travel, with a soft shadow, sized to the real car, and painted: the
 * atlas holds only brightness with the body at mid grey, and the shader multiplies it by the car's paint colour
 * (realistic colours on every other road; your 8 lanes in their lane colours unless "Lane colours" is off).
 * Boxes (K) brings back the A1-A6 wire boxes.
 *
 * A6: starts at 1,500 ft; 348 lanes and six interchanges (see the roads file); MAD traffic (on at start): every lane,
 * yours included, lurches between a dead stop and up to 2.6x its speed (90 mph at most) every 1.5-6 s, with hard
 * acceleration and braking. Mad off = the calmer A5 traffic.
 *
 * A5: an Info button (and I / H) hides the text in the corners; the suburbs fade to dark green at the freeways and
 * round the interchanges; the helicopter starts at 3,000 ft (START_FT), where the photos are sharp.
 *
 * A4: the ground is suburbia, tiled from the "suburb N.webp" aerial photos (atlas in CT30.A7.Highways_suburbs.js):
 * every 420 m cell takes one of the 16 tiles, turned 0/90/180/270° and maybe mirrored, with the seams blended over a
 * noisy band. Freeways get dry-grass verges and each interchange sits in open ground. Three diagonal freeways cross
 * the network on overpasses (see CT30.A7.Highways_roads.js).
 *
 * A3: everything moves smoothly. The helicopter's position, height, tilt and heading follow their targets through
 * critically damped springs (ease in, ease out, never overshoot); lane and helicopter speeds change with limited
 * jerk as well as limited acceleration. Next / Prev glide to an interchange keeping your tilt; Approach (hold W / S,
 * Q / E, or the buttons) flies toward what you are looking at.
 *
 * A2: many more lanes and three freeway-to-freeway interchanges (cloverleaf, a six-level stack, a cloverstack) on by
 * default; every ramp is a lane of traffic of its own; the corridor's right-hand traffic now runs NB on the east side.
 *
 * Traffic model (A1): complete congestion, no lane changes. Every lane is a rigid queue of cars at jam spacing
 * (2-3 m gaps) that moves at the lane's own speed; a lane speeds up, slows down or stops without touching any other.
 * Speeds change smoothly (2 m/s² up, 4 m/s² down). Cars are wire boxes (length / width / height of a car, van or truck).
 *
 * Clock (as CT55):
 *   not recording: the scene advances by the real time since the last frame;
 *   recording:     every drawn frame is exactly one movie frame of 1/fps s, then it is encoded with its sound.
 */
(function () {
  'use strict';
  const LABEL = 'CT30.A7.Highways';
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const R = window.CT30Roads, LW = R.LW;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const MPH = 0.44704, FT = 0.3048;
  const fmtFt = (m) => { const f = m / FT; return f >= 1000 ? (Math.round(f / 50) * 50).toLocaleString('en-US') : String(Math.round(f / 5) * 5); };

  // ------------------------------------------------------------------ renderer, scene, camera
  const stage = $('stage'), canvas = $('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0d1014, 1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0d1014, 4000, 16000);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 40000);

  // ------------------------------------------------------------------ state
  const DEFAULT_MPH = [35, 30, 25, 20, 15, 10, 6, 3];           // lane 1 (left) fast ... lane 8 slow
  const LANE_COL = ['#ff9aa8', '#ffc08a', '#f3e48a', '#a9ec9a', '#8fe6d8', '#98c4ff', '#b8a4ff', '#f2a6ec'];
  const LANE_SRGB = LANE_COL.map(srgb);                          // A7: the same colours as car paint (sRGB)
  const OTHER_MPH = { SB: 18, NBX: 22, PF: 38, XF: 26, RAMP: 16, DG: 34, EXP: 45 };
  const OTHER_COL = { SB: '#c3cede', NBX: '#d0d8e2', PF: '#b0bccb', XF: '#d6cbe6', RAMP: '#c9d6e3', DG: '#e6d3b0', EXP: '#d9cf98' };
  const S = {
    playing: true, time: 0, recording: false, hud: true, bar: true,
    laneMph: DEFAULT_MPH.slice(), laneStop: Array(8).fill(false), allStop: false, auto: false, others: 1,
    mad: qs.get('mad') !== '0',
    boxes: qs.get('boxes') === '1' || !(window.CT30_CARS && window.CT30_CARS.cars), laneTint: qs.get('lanecolours') !== '0',
    follow: true, heliMph: 0, layout: 'network', u0: 0, sound: false, suburbs: qs.get('suburbs') !== '0',
  };
  // the helicopter: x = where it is, xT = where it is going, xV = its rate of change (for the springs)
  const START_FT = parseFloat(qs.get('ft') || '1500');           // A6: half of A5's 3,000 ft
  const heli = { u: 0, v: 0, uT: 0, vT: 0, uV: 0, vV: 0, posW: 2.2, h: START_FT * FT, hT: START_FT * FT, hV: 0, tilt: 90, tiltT: 90, tiltV: 0,
    yaw: 0, yawT: 0, yawV: 0, speed: 0, acc: 0, fly: null };
  /** critically damped spring: moves o[k] toward target with no overshoot; w = stiffness (1/s); exact for any dt */
  function spring(o, k, kv, target, w, dt) {
    const x = o[k] - target, v = o[kv], e = Math.exp(-w * dt), t = (v + w * x) * dt;
    o[k] = target + (x + t) * e; o[kv] = (v - w * t) * e;
  }
  /** speed with limited acceleration AND limited jerk (smooth starts and stops): a second-order follower */
  function smoothSpeed(o, target, w, aUp, aDown, dt) {
    o.acc += (w * w * (target - o.v) - 2 * w * o.acc) * dt;
    o.acc = clamp(o.acc, -aDown, aUp);
    o.v += o.acc * dt;
    if (target <= 0 && o.v < 0) { o.v = 0; o.acc = 0; }
  }
  const HOME_V = 0;
  const START_U = -1400;                                       // between the cloverleaf (south) and the stack, over your 8 lanes
  const TILTS = [90, 55, 25];
  const O = { u: 0, v: 0 };                                     // moving origin for the GPU (precision)

  // ------------------------------------------------------------------ deterministic random
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
  function rng(seed) { let x = seed || 1; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }

  // ------------------------------------------------------------------ lanes
  const BLOCK = 64;                                             // the car pattern of a lane repeats every 64 cars
  // A7: the car photos (CT30_CARS from the atlas file): which car, how common, how tall (for Boxes mode)
  const CARS = (window.CT30_CARS && window.CT30_CARS.cars) || [];
  const TYPE_W = { suv: 0.34, sedan: 0.16, pickup: 0.14, station: 0.1, electric: 0.1, van: 0.08, sports: 0.08 };
  const TYPE_H = { suv: 1.75, sedan: 1.45, pickup: 1.9, station: 1.5, electric: 1.3, van: 2.0, sports: 1.2 };
  const carPick = [];                                           // cumulative weights over the photos (a type's weight shared by its photos)
  { let acc = 0; for (let i = 0; i < CARS.length; i++) { const t = CARS[i].type, n = CARS.filter(c => c.type === t).length; acc += (TYPE_W[t] || 0.05) / n; carPick.push(acc); }
    for (let i = 0; i < carPick.length; i++) carPick[i] /= acc; }
  /** a hex colour as plain sRGB numbers (THREE.Color would convert to linear; the car shader writes colours straight out) */
  function srgb(hex) { const v = parseInt(hex.slice(1), 16); return { r: (v >> 16 & 255) / 255, g: (v >> 8 & 255) / 255, b: (v & 255) / 255 }; }
  // realistic paint (sRGB) and how common it is on American roads
  const PAINTS = [['#f2f2ef', 0.23], ['#141518', 0.2], ['#6d7075', 0.17], ['#b8bcc2', 0.14], ['#1f4e9c', 0.08], ['#a3191f', 0.08],
    ['#24402f', 0.02], ['#c8b48a', 0.02], ['#e0a21a', 0.015], ['#3d5f8a', 0.02], ['#5a1c24', 0.015], ['#e8e4d6', 0.03]].map(([c, w]) => [srgb(c), w]);
  function makePattern(key, hw) {
    const r = rng(hashStr(key)), len = new Float32Array(BLOCK), wid = new Float32Array(BLOCK), hgt = new Float32Array(BLOCK), off = new Float64Array(BLOCK);
    const tex = new Float32Array(BLOCK), paint = new Float32Array(BLOCK * 3);
    let acc = 0;
    for (let i = 0; i < BLOCK; i++) {
      if (CARS.length) {
        const x = r(); let k = carPick.findIndex(c => x <= c); if (k < 0) k = CARS.length - 1;
        const c = CARS[k], sc = 0.97 + 0.06 * r();
        tex[i] = k; len[i] = c.length * sc; wid[i] = c.width * sc; hgt[i] = TYPE_H[c.type] || 1.5;
        let y = r(), q = 0; while (q < PAINTS.length - 1 && (y -= PAINTS[q][1]) > 0) q++;
        const pc = PAINTS[q][0], v = 0.92 + 0.16 * r();
        paint[i * 3] = Math.min(1, pc.r * v); paint[i * 3 + 1] = Math.min(1, pc.g * v); paint[i * 3 + 2] = Math.min(1, pc.b * v);
      } else { len[i] = 4.2 + r() * 0.8; wid[i] = 1.8; hgt[i] = 1.45; }
      const gap = 1.8 + r() * 1.4;
      off[i] = acc + len[i] / 2; acc += len[i] + gap;
    }
    return { len, wid, hgt, off, tex, paint, blockLen: acc };
  }
  const lanes = new Map();                                      // key -> lane (kept across layouts)
  let active = [];                                              // lanes of the current layout
  function laneFor(spec) {
    let L = lanes.get(spec.key);
    if (!L) {
      const pat = makePattern(spec.key, spec.hw), r = rng(hashStr(spec.key + '#'));
      const ours = spec.ours !== undefined;
      // ramp lanes: each chain its own soft hue, so you can follow one through two interchanges
      const col = ours ? new THREE.Color(LANE_COL[spec.ours]) : spec.hw === 'RAMP' ? new THREE.Color().setHSL(r(), 0.38, 0.66) : new THREE.Color(OTHER_COL[spec.hw] || '#999999');
      L = { key: spec.key, hw: spec.hw, ours: ours ? spec.ours : -1, pat, D: r() * pat.blockLen, D0: 0, v: 0, target: 0,
        mult: 1, nextChange: S.mad ? r() * 1.5 : 4 + r() * 10, rnd: r, col };
      L.D0 = L.D;
      L.v = targetSpeed(L);
      lanes.set(spec.key, L);
    }
    L.path = spec.path; L.ramp = spec.ramp || '';
    return L;
  }
  function targetSpeed(L) {
    if (L.ours >= 0) {
      if (S.allStop || S.laneStop[L.ours]) return 0;
      return Math.min(90, S.laneMph[L.ours] * (S.auto || S.mad ? L.mult : 1)) * MPH;
    }
    return Math.min(90, OTHER_MPH[L.hw] * S.others * L.mult) * MPH;
  }
  let NET = null;                                               // the interchange network (when on)
  function setLayout(kind, Ub) {
    S.layout = kind; S.u0 = Ub || 0;
    let specs;
    if (kind === 'network') { NET = R.buildNetwork(S.u0); specs = NET.lanes; }
    else { NET = null; specs = R.straightLanes(); }
    active = specs.map(laneFor);
    buildInterchangeMeshes();
    notify();
  }
  const PERIOD_NET = 9600;                                     // the network repeats ahead of you every 9.6 km

  // ------------------------------------------------------------------ cars: instanced wire boxes
  const MAXCARS = 260000;
  const boxGeo = new THREE.InstancedBufferGeometry();
  {
    const c = []; const P = (x, y, z) => c.push(x, y, z);
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const V = [[-.5, 0, -.5], [.5, 0, -.5], [.5, 0, .5], [-.5, 0, .5], [-.5, 1, -.5], [.5, 1, -.5], [.5, 1, .5], [-.5, 1, .5]];
    for (const [a, b] of E) { P(...V[a]); P(...V[b]); }
    // a short line across the front of the roof, so you can see which way a car faces
    P(-.5, 1, .38); P(.5, 1, .38);
    boxGeo.setAttribute('position', new THREE.Float32BufferAttribute(c, 3));
  }
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAXCARS * 3), 3);
  const iFwd = new THREE.InstancedBufferAttribute(new Float32Array(MAXCARS * 3), 3);
  const iSize = new THREE.InstancedBufferAttribute(new Float32Array(MAXCARS * 3), 3);
  const iCol = new THREE.InstancedBufferAttribute(new Float32Array(MAXCARS * 3), 3);
  for (const a of [iPos, iFwd, iSize, iCol]) a.setUsage(THREE.DynamicDrawUsage);
  const iTex = new THREE.InstancedBufferAttribute(new Float32Array(MAXCARS), 1); iTex.setUsage(THREE.DynamicDrawUsage);
  boxGeo.setAttribute('iPos', iPos); boxGeo.setAttribute('iFwd', iFwd); boxGeo.setAttribute('iSize', iSize); boxGeo.setAttribute('iCol', iCol);
  boxGeo.instanceCount = 0;
  const FOG_DARK = new THREE.Color(0x0d1014), FOG_HAZE = new THREE.Color('#a7b2bb');
  const carMat = new THREE.ShaderMaterial({
    uniforms: { uFog: { value: FOG_HAZE.clone() }, uFogNear: { value: 4000 }, uFogFar: { value: 16000 } },
    vertexShader: `
      attribute vec3 iPos; attribute vec3 iFwd; attribute vec3 iSize; attribute vec3 iCol;
      varying vec3 vCol; varying float vFog; uniform float uFogNear; uniform float uFogFar;
      void main() {
        vec3 f = normalize(iFwd);
        vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
        vec3 u = cross(r, f);
        vec3 p = iPos + r * position.x * iSize.y + u * position.y * iSize.z + f * position.z * iSize.x;
        vCol = iCol;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vFog = smoothstep(uFogNear, uFogFar, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vCol; varying float vFog; uniform vec3 uFog;
      void main() { gl_FragColor = vec4(mix(vCol, uFog, vFog), 1.0); }`,
  });
  const cars = new THREE.LineSegments(boxGeo, carMat);
  cars.frustumCulled = false;
  scene.add(cars);

  // ------------------------------------------------------------------ A7: the car photos as textured quads (+ soft shadows)
  const carTex = new THREE.Texture();
  carTex.generateMipmaps = true; carTex.minFilter = THREE.LinearMipmapLinearFilter; carTex.magFilter = THREE.LinearFilter;
  carTex.anisotropy = renderer.capabilities.getMaxAnisotropy(); carTex.colorSpace = THREE.NoColorSpace;
  const UVS = new Array(16).fill(0).map(() => new THREE.Vector4(0, 0, 1, 1));
  CARS.forEach((c, i) => UVS[i].set(c.uv[0], c.uv[1], c.uv[2], c.uv[3]));
  const carUniforms = { uAtlas: { value: carTex }, uUV: { value: UVS }, uReady: { value: 0 },
    uFog: { value: new THREE.Color(0xa7b2bb) }, uFogNear: { value: 4000 }, uFogFar: { value: 16000 } };
  if (window.CT30_CARS) { const im = new Image(); im.onload = () => { carTex.image = im; carTex.needsUpdate = true; carUniforms.uReady.value = 1; }; im.src = window.CT30_CARS.url; }
  const quadGeo = new THREE.InstancedBufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 3));
  quadGeo.setIndex([0, 2, 1, 0, 3, 2]);
  quadGeo.setAttribute('iPos', iPos); quadGeo.setAttribute('iFwd', iFwd); quadGeo.setAttribute('iSize', iSize); quadGeo.setAttribute('iCol', iCol); quadGeo.setAttribute('iTex', iTex);
  quadGeo.instanceCount = 0;
  const QUAD_VS = (lift, grow, shift) => `
      attribute vec3 iPos; attribute vec3 iFwd; attribute vec3 iSize; attribute vec3 iCol; attribute float iTex;
      uniform vec4 uUV[16];
      varying vec2 vUV; varying vec2 vQ; varying vec3 vCol; varying float vDepth;
      void main() {
        vec3 f = normalize(iFwd);
        vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
        vec3 u = cross(r, f);
        vec3 p = iPos + r * (position.x * iSize.y * ${grow}) + f * (position.z * iSize.x * ${grow}) + u * ${lift} + vec3(${shift}, 0.0, ${shift});
        vec4 b = uUV[int(iTex + 0.5)];
        // front of the car (+z here) = right end of its atlas slot; its right side (+x) = the bottom of the slot
        vUV = vec2(mix(b.x, b.z, position.z + 0.5), mix(b.y, b.w, 0.5 - position.x));
        vQ = position.xz * 2.0; vCol = iCol;
        vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`;
  const carQuadMat = new THREE.ShaderMaterial({
    uniforms: carUniforms, side: THREE.DoubleSide,
    vertexShader: QUAD_VS('0.25', '1.0', '0.0'),
    fragmentShader: `
      uniform sampler2D uAtlas; uniform float uReady; uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
      varying vec2 vUV; varying vec2 vQ; varying vec3 vCol; varying float vDepth;
      vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
      void main() {
        vec4 s = texture2D(uAtlas, vUV);
        if (uReady < 0.5) s = vec4(0.62, 0.62, 0.62, step(max(abs(vQ.x), abs(vQ.y)), 0.9));
        if (s.a < 0.5) discard;
        float L = s.r;
        // paint: body (mid grey 0.62) takes the paint colour; windows (dark) stay dark; highlights go to white
        vec3 c = vCol * (L / 0.62);
        c = mix(c, vec3(1.0), smoothstep(0.8, 1.0, L) * 0.7);
        c = mix(c, vec3(0.03), smoothstep(0.25, 0.05, L) * 0.6);
        gl_FragColor = vec4(mix(clamp(c, 0.0, 1.0), uFog, smoothstep(uFogNear, uFogFar, vDepth)), 1.0);
      }`,
  });
  const carShadowMat = new THREE.ShaderMaterial({
    uniforms: carUniforms, transparent: true, depthWrite: false,
    vertexShader: QUAD_VS('0.12', '1.12', '0.35'),
    fragmentShader: `
      varying vec2 vQ; varying float vDepth; uniform float uFogFar;
      void main() {
        vec2 q = abs(vQ); float d = length(max(q - vec2(0.62, 0.8), 0.0)) / 0.3;   // a rounded rectangle, soft edge
        float a = 0.42 * (1.0 - smoothstep(0.0, 1.0, d)) * (1.0 - smoothstep(0.0, uFogFar * 0.4, vDepth));
        if (a < 0.01) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }`,
  });
  const carQuads = new THREE.Mesh(quadGeo, carQuadMat), carShadows = new THREE.Mesh(quadGeo, carShadowMat);
  carQuads.frustumCulled = carShadows.frustumCulled = false;
  carShadows.renderOrder = 2; carQuads.renderOrder = 3;
  scene.add(carShadows, carQuads);

  const tmp = { u: 0, v: 0, y: 0, tu: 0, tv: 0, ty: 0 };
  let carCount = 0, viewR = 0;
  function writeCars() {
    // how far to place cars: the visible ground, plus the distance seen ahead when tilted
    const h = heli.h, t = heli.tilt * Math.PI / 180;
    const behind = h * 1.35 + 80;
    const ahead = heli.tilt >= 72 ? behind : Math.min(14000, h / Math.tan(Math.max(0.035, t - 0.44)) + behind);
    viewR = ahead;
    const fu = Math.cos(heli.yaw), fv = Math.sin(heli.yaw);
    const P = iPos.array, F = iFwd.array, Z = iSize.array, C = iCol.array, T = iTex.array;
    let n = 0;
    for (const L of active) {
      const sc = L.path.nearestS(heli.u, heli.v);
      // along-lane window: generous both ways for curved ramps (cheap to over-cover)
      const s0 = sc - Math.max(behind, ahead * 0.35), s1 = sc + ahead;
      const pat = L.pat, BL = pat.blockLen;
      const b0 = Math.floor((s0 - L.D) / BL), b1 = Math.floor((s1 - L.D) / BL);
      for (let b = b0; b <= b1 && n < MAXCARS; b++) {
        const base = L.D + b * BL;
        for (let i = 0; i < BLOCK; i++) {
          const s = base + pat.off[i];
          if (s < s0 || s > s1) continue;
          L.path.at(s, tmp);
          // skip cars well outside the view cone (cheap plan-view test)
          const du = tmp.u - heli.u, dv = tmp.v - heli.v;
          if (heli.tilt < 72) { const fwd = du * fu + dv * fv; if (fwd < -behind) continue; const side = Math.abs(-du * fv + dv * fu); if (side > behind + Math.max(0, fwd) * 1.05) continue; }
          else if (du * du + dv * dv > behind * behind * 1.4) continue;
          // far away cars are a pixel or less: draw every 2nd beyond 3 km and every 4th beyond 6 km (by their place in
          // the lane's pattern, so the same cars are always the ones drawn - nothing flickers)
          const d2 = du * du + dv * dv;
          if (d2 > 9e6 && (i & (d2 > 3.6e7 ? 3 : 1))) continue;
          const k = n * 3;
          P[k] = tmp.v - O.v; P[k + 1] = tmp.y + 0.12; P[k + 2] = -(tmp.u - O.u);
          F[k] = tmp.tv; F[k + 1] = tmp.ty; F[k + 2] = -tmp.tu;
          Z[k] = pat.len[i]; Z[k + 1] = pat.wid[i]; Z[k + 2] = pat.hgt[i];
          T[n] = pat.tex[i];
          if (S.boxes) { const c = L.col; C[k] = c.r; C[k + 1] = c.g; C[k + 2] = c.b; }
          else if (L.ours >= 0 && S.laneTint) { const c = LANE_SRGB[L.ours]; C[k] = c.r; C[k + 1] = c.g; C[k + 2] = c.b; }
          else { C[k] = pat.paint[i * 3]; C[k + 1] = pat.paint[i * 3 + 1]; C[k + 2] = pat.paint[i * 3 + 2]; }
          n++;
        }
      }
    }
    carCount = n;
    boxGeo.instanceCount = n;
    for (const a of [iPos, iFwd, iSize, iCol]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 3); a.needsUpdate = true; }
    iTex.clearUpdateRanges(); iTex.addUpdateRange(0, n); iTex.needsUpdate = true;
    quadGeo.instanceCount = n;
    cars.visible = S.boxes; carQuads.visible = carShadows.visible = !S.boxes;
  }

  // ------------------------------------------------------------------ roads: straight strips (periodic along u)
  const PERIOD = 12;                                            // lane-line dash period (3 m dash, 9 m gap)
  const HALF = 18000;                                           // straight meshes reach this far each way
  const roadMat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
  const ASPH = new THREE.Color('#34383f');
  function deckColor(y) { return y > 0.5 ? ASPH.clone().lerp(new THREE.Color('#737a86'), Math.min(1, y / 18)) : y < -0.5 ? ASPH.clone().lerp(new THREE.Color('#15171b'), Math.min(1, -y / 8)) : ASPH.clone(); }

  function stripsGeometry(strips) {
    const pos = [], col = [], idx = [];
    const lpos = [], lcol = [];
    const edgeW = new THREE.Color('#c8ccd3'), edgeY = new THREE.Color('#c9a640'), dash = new THREE.Color('#9da3ad');
    for (const st of strips) {
      const a = st.v - st.w / 2, b = st.v + st.w / 2, k = pos.length / 3;
      pos.push(a, 0, HALF, b, 0, HALF, b, 0, -HALF, a, 0, -HALF);
      for (let i = 0; i < 4; i++) col.push(ASPH.r, ASPH.g, ASPH.b);
      idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
      // edges (solid) and lane lines (dashed)
      const left = st.v - st.lanes * LW / 2, right = st.v + st.lanes * LW / 2;
      const east = st.left === 'east';
      for (const [v, c] of [[left, east ? edgeW : edgeY], [right, east ? edgeY : edgeW]]) { lpos.push(v, 0.05, HALF, v, 0.05, -HALF); lcol.push(c.r, c.g, c.b, c.r, c.g, c.b); }
      for (let j = 1; j < st.lanes; j++) {
        const v = left + j * LW;
        for (let z = -HALF; z < HALF; z += PERIOD) { lpos.push(v, 0.05, z, v, 0.05, z + 3); lcol.push(dash.r, dash.g, dash.b, dash.r, dash.g, dash.b); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(lcol, 3));
    return [g, lg];
  }
  // the corridor's through lanes are drawn as periodic strips in both layouts; the parallel freeway too when the network is off
  const STRIPS_STRAIGHT = R.STRIPS.concat(R.PF_STRIPS);
  const STRIPS_CORE = R.STRIPS;
  const straight = new THREE.Group(); scene.add(straight);
  let straightKind = '';
  function setStraightMeshes(kind) {
    if (kind === straightKind) return;
    straightKind = kind;
    for (const c of [...straight.children]) { straight.remove(c); c.geometry.dispose(); }
    if (kind === 'none') return;                                     // A4: the corridor is drawn as lane ribbons (it bridges over D2)
    const [g, lg] = stripsGeometry(kind === 'core' ? STRIPS_CORE : STRIPS_STRAIGHT);
    straight.add(new THREE.Mesh(g, roadMat), new THREE.LineSegments(lg, lineMat));
  }

  // ------------------------------------------------------------------ roads: the interchange (built once per press)
  const inter = new THREE.Group(); scene.add(inter);
  function ribbon(path, s0, s1, width, pos, col, idx, lpos, lcol, edgeCol) {
    // adaptive: a vertex every 4 m on curves and slopes, every 24 m on straight level road
    let first = true, pl = null, pr = null, lastS = -1e9, lastTu = 0, lastTv = 0, lastY = 0;
    for (let s = s0; s <= s1 + 3.9; s += 4) {
      path.at(Math.min(s, s1), tmp);
      const bend = Math.abs(tmp.tu * lastTv - tmp.tv * lastTu), dy = Math.abs(tmp.y - lastY);
      if (!first && s < s1 && s - lastS < 24 && bend < 0.004 && dy < 0.15) continue;
      lastS = s; lastTu = tmp.tu; lastTv = tmp.tv; lastY = tmp.y;
      const ru = -tmp.tv, rv = tmp.tu, hl = width / 2;                 // right-hand normal in plan
      const lu = tmp.u - ru * hl, lv = tmp.v - rv * hl, uu = tmp.u + ru * hl, uv = tmp.v + rv * hl;
      const L = [lv, tmp.y, -(lu - S.u0)], Rr = [uv, tmp.y, -(uu - S.u0)];
      const c = deckColor(tmp.y);
      const k = pos.length / 3;
      pos.push(...L, ...Rr); col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (!first) { idx.push(k - 2, k - 1, k + 1, k - 2, k + 1, k); lpos.push(...pl, L[0], L[1] + 0.05, L[2], ...pr, Rr[0], Rr[1] + 0.05, Rr[2]); for (let q = 0; q < 4; q++) lcol.push(edgeCol.r, edgeCol.g, edgeCol.b); }
      pl = [L[0], L[1] + 0.05, L[2]]; pr = [Rr[0], Rr[1] + 0.05, Rr[2]]; first = false;
    }
  }
  function buildInterchangeMeshes() {
    for (const c of [...inter.children]) { inter.remove(c); c.geometry.dispose(); }
    if (S.layout !== 'network') { setStraightMeshes('full'); return; }
    setStraightMeshes('none');
    const pos = [], col = [], idx = [], lpos = [], lcol = [], ppos = [];
    const gpos = [], gcol = [], gidx = [];                            // verges on the ground
    const edge = new THREE.Color('#aeb4bd');
    for (const L of active) {
      if (!(L.path instanceof R.SampledPath)) continue;
      const p = L.path;
      ribbon(p, p.s0, p.sEnd, L.hw === 'RAMP' ? LW - 0.35 : LW + 0.25, pos, col, idx, lpos, lcol, edge);
      verge(p, p.s0, p.sEnd, gpos, gcol, gidx);
      // piers under the decks, every 32 m where the deck is more than 3 m up; trench walls where it is below ground
      // A6: wide viaducts (express, diagonals) get piers under two of their lanes only, not under every lane
      if ((L.hw === 'EXP' || L.hw === 'DG') && !/[ab]?1$|n12$|s12$|a6$|b6$/.test(L.key)) continue;
      for (let s = p.s0; s <= p.sEnd; s += 30) {
        p.at(s, tmp);
        if (tmp.y > 3.5) { const x = tmp.v, z = -(tmp.u - S.u0); ppos.push(x, 0, z, x, tmp.y - 0.4, z); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(lcol, 3));
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
    inter.add(new THREE.Mesh(g, roadMat), new THREE.LineSegments(lg, lineMat), new THREE.LineSegments(pg, new THREE.LineBasicMaterial({ color: 0x6d737d })));
    // open ground round each interchange (no houses inside the loops), fading out at the edge
    for (const x of NET.X) {
      const R0 = x.kind === 'stack' ? 470 : 560, R1 = R0 + 160, N = 96, k0 = gpos.length / 3, z = -(x.U - S.u0), cx = -17;
      gpos.push(cx, 0, z); gcol.push(...VERGE_RGB, 1);
      for (let i = 0; i <= N; i++) { const a = i / N * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a), w = 0.86 + 0.14 * Math.sin(a * 7 + x.index);
        gpos.push(cx + c * R0 * w, 0, z + sn * R0 * w, cx + c * R1 * w, 0, z + sn * R1 * w); gcol.push(...VERGE_RGB, 1, ...VERGE_RGB, 0); }
      for (let i = 0; i < N; i++) { const a = k0 + 1 + i * 2, b = a + 2; gidx.push(k0, a, b, a, a + 1, b + 1, a, b + 1, b); }
    }
    const vg = new THREE.BufferGeometry();
    vg.setAttribute('position', new THREE.Float32BufferAttribute(gpos, 3)); vg.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 4)); vg.setIndex(gidx);
    const vm = new THREE.Mesh(vg, vergeMat); vm.renderOrder = 1; inter.add(vm);
  }
  // A4: verges -- a dry-grass band on the ground along every road (also under viaducts), soft at its edges
  const VERGE_RGB = [0.0045, 0.013, 0.0055];                        // A5: dark green (#0f1e11 on screen: vertex colours are linear), fading into the suburbs
  const vergeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 });
  function verge(path, s0, s1, pos, col, idx) {
    const W1 = LW / 2 + 6, W2 = W1 + 18;                              // A5: a wider, softer fade into the suburbs
    let first = true, lastS = -1e9, lastTu = 0, lastTv = 0;
    for (let s = s0; s <= s1 + 7.9; s += 8) {
      path.at(Math.min(s, s1), tmp);
      const bend = Math.abs(tmp.tu * lastTv - tmp.tv * lastTu);
      if (!first && s < s1 && s - lastS < 48 && bend < 0.01) continue;
      lastS = s; lastTu = tmp.tu; lastTv = tmp.tv;
      const ru = -tmp.tv, rv = tmp.tu, k = pos.length / 3;
      for (const [o, a] of [[-W2, 0], [-W1, 1], [W1, 1], [W2, 0]]) { pos.push(tmp.v + rv * o, 0, -(tmp.u + ru * o - S.u0)); col.push(...VERGE_RGB, a); }
      if (!first) for (let q = 0; q < 3; q++) { const a = k - 4 + q, b = k + q; idx.push(a, a + 1, b + 1, a, b + 1, b); }
      first = false;
    }
  }

  // ------------------------------------------------------------------ A4: the suburbs (the ground)
  const TILE = parseFloat(qs.get('tile') || '210');                // metres per tile (A7 fix: was 420 -- houses were twice too big next to the true-size cars)
  const groundTex = new THREE.Texture();
  groundTex.colorSpace = THREE.NoColorSpace; groundTex.generateMipmaps = true;
  groundTex.minFilter = THREE.LinearMipmapLinearFilter; groundTex.magFilter = THREE.LinearFilter;
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (window.CT30_SUBURBS) { const im = new Image(); im.onload = () => { groundTex.image = im; groundTex.needsUpdate = true; groundMat.uniforms.uReady.value = 1; }; im.src = window.CT30_SUBURBS.url; }
  const groundMat = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: groundTex }, uReady: { value: 0 }, uTile: { value: TILE }, uOff: { value: new THREE.Vector2() },
      uFog: { value: FOG_HAZE.clone() }, uFogNear: { value: 4000 }, uFogFar: { value: 16000 }, uGrid: { value: 4 } },
    polygonOffset: true, polygonOffsetFactor: 8, polygonOffsetUnits: 8,
    vertexShader: `
      uniform vec2 uOff; varying vec2 vW; varying float vDepth;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = vec2(wp.x, -wp.z) + uOff;                 // (east, north) metres, modulo a long period
        vec4 mv = viewMatrix * wp; vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uAtlas; uniform float uReady; uniform float uTile; uniform float uGrid;
      uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
      varying vec2 vW; varying float vDepth;
      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      // one cell's tile at local coordinates q (0..1 inside the cell; mirrored outside, so a neighbour can be read
      // continuously just across the seam)
      vec3 cellTex(vec2 cell, vec2 q, vec2 gx, vec2 gy) {
        float h = h21(cell), h2 = h21(cell + 17.7);
        float idx = floor(h * 16.0); int rot = int(floor(h2 * 4.0)); bool flip = fract(h2 * 7.31) > 0.5;
        q = abs(q); q = 1.0 - abs(1.0 - mod(q, 2.0));          // mirror outside 0..1
        if (flip) q.x = 1.0 - q.x;
        if (rot == 1) q = vec2(q.y, 1.0 - q.x); else if (rot == 2) q = 1.0 - q; else if (rot == 3) q = vec2(1.0 - q.y, q.x);
        q = clamp(q, 0.004, 0.996);
        vec2 slot = vec2(mod(idx, uGrid), floor(idx / uGrid));
        return textureGrad(uAtlas, (slot + q) / uGrid, gx, gy).rgb;
      }
      void main() {
        vec2 p = vW / uTile, cell = floor(p), f = p - cell;
        vec2 gx = dFdx(p) / uGrid, gy = dFdy(p) / uGrid;
        vec3 c = cellTex(cell, f, gx, gy);
        // blend across the seams over a noisy band (about 8% of a tile)
        float n = noise(vW / 37.0) * 0.06, b = 0.05 + n;
        if (f.x < b) c = mix(c, cellTex(cell - vec2(1, 0), vec2(1.0 + f.x, f.y), gx, gy), 0.5 * (1.0 - f.x / b));
        else if (f.x > 1.0 - b) c = mix(c, cellTex(cell + vec2(1, 0), vec2(f.x - 1.0, f.y), gx, gy), 0.5 * (1.0 - (1.0 - f.x) / b));
        if (f.y < b) c = mix(c, cellTex(cell - vec2(0, 1), vec2(f.x, 1.0 + f.y), gx, gy), 0.5 * (1.0 - f.y / b));
        else if (f.y > 1.0 - b) c = mix(c, cellTex(cell + vec2(0, 1), vec2(f.x, f.y - 1.0), gx, gy), 0.5 * (1.0 - (1.0 - f.y) / b));
        if (uReady < 0.5) c = vec3(0.42, 0.42, 0.36);
        c *= 0.92 + 0.12 * noise(vW / 260.0);                   // a little large-scale variation
        gl_FragColor = vec4(mix(c, uFog, smoothstep(uFogNear, uFogFar, vDepth)), 1.0);
      }`,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; ground.renderOrder = -1; ground.frustumCulled = false;
  scene.add(ground);
  const PERIOD_G = TILE * 64;                                       // the tile pattern repeats every 64 cells

  // ------------------------------------------------------------------ ground grid (so you can see the helicopter move over the ground)
  const grid = new THREE.Group(); scene.add(grid);
  function gridMesh(step, half, color) {
    const p = [];
    for (let x = -half; x <= half; x += step) p.push(x, -0.3, -half, x, -0.3, half, -half, -0.3, x, half, -0.3, x);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false }));
    m.userData.step = step; return m;
  }
  const grid50 = gridMesh(50, 3000, 0x1f262e), grid500 = gridMesh(500, 30000, 0x26303a);
  grid.add(grid50, grid500);

  function placeStatic() {
    // the moving origin: a whole kilometre near the helicopter
    if (Math.abs(heli.u - O.u) > 1000 || Math.abs(heli.v - O.v) > 1000) { O.u = Math.round(heli.u / 1000) * 1000; O.v = Math.round(heli.v / 1000) * 1000; }
    const uc = Math.round(heli.u / PERIOD) * PERIOD;
    straight.position.set(-O.v, 0, -(uc - O.u));
    inter.position.set(-O.v, 0, -(S.u0 - O.u));
    for (const m of [grid50, grid500]) {
      const st = m.userData.step, gu = Math.round(heli.u / st) * st, gv = Math.round(heli.v / st) * st;
      m.position.set(gv - O.v, 0, -(gu - O.u));
    }
    // the suburbs follow the helicopter; the grid only when the suburbs are off
    ground.visible = S.suburbs; grid.visible = !S.suburbs;
    const GR = clamp(heli.h * 40, 8000, 60000);
    ground.scale.set(GR * 2, GR * 2, 1); ground.position.set(heli.v - O.v, -0.05, -(heli.u - O.u));
    const md = (a, m) => ((a % m) + m) % m;
    groundMat.uniforms.uOff.value.set(md(O.v, PERIOD_G), md(O.u, PERIOD_G));
    const fc = S.suburbs ? FOG_HAZE : FOG_DARK;
    renderer.setClearColor(fc, 1); scene.fog.color.copy(fc); carMat.uniforms.uFog.value.copy(fc);
    for (const m of [groundMat, carMat]) { m.uniforms.uFogNear.value = scene.fog.near; m.uniforms.uFogFar.value = scene.fog.far; }
    carUniforms.uFog.value.set(S.suburbs ? 0xa7b2bb : 0x0d1014); carUniforms.uFogNear.value = scene.fog.near; carUniforms.uFogFar.value = scene.fog.far;
    grid50.material.opacity = 0.55 * clamp(1 - (heli.h - 300) / 900, 0, 1);
    grid500.material.opacity = 0.5 * clamp((heli.h - 150) / 400, 0, 1);
  }

  // ------------------------------------------------------------------ simulation step
  function step(dt) {
    if (!S.playing) return;
    S.time += dt;
    let sum = 0;
    for (const L of active) {
      // stop-and-go for other roads (always) and for yours when Auto is on
      if (L.ours < 0 || S.auto || S.mad) {
        L.nextChange -= dt;
        if (L.nextChange <= 0) {
          const r = L.rnd();
          if (S.mad) { L.mult = r < 0.18 ? 0 : 0.1 + 2.5 * L.rnd() * L.rnd() + (L.rnd() < 0.2 ? 1.2 : 0); L.nextChange = 1.5 + L.rnd() * 4.5; }
          else { L.mult = r < 0.22 ? 0 : 0.25 + 0.75 * L.rnd(); L.nextChange = 6 + L.rnd() * 14; }
        }
      }
      if (L.acc === undefined) L.acc = 0;
      if (S.mad) smoothSpeed(L, targetSpeed(L), 1.8, 6, 9, dt);
      else smoothSpeed(L, targetSpeed(L), 1.1, 2, 4, dt);
      L.D += L.v * dt;
      if (L.ours >= 0) sum += L.v;
    }
    const mean = sum / 8;
    const want = S.follow ? mean : S.heliMph * MPH;
    const hs = { v: heli.speed, acc: heli.acc }; smoothSpeed(hs, heli.fly ? 0 : want, 0.8, 3, 3, dt); heli.speed = hs.v; heli.acc = hs.acc;
    // travel moves both where the helicopter is and where it is going (the springs only shape the rest)
    const mu = heli.speed * dt * Math.cos(heli.yaw), mv = heli.speed * dt * Math.sin(heli.yaw);
    heli.u += mu; heli.v += mv; heli.uT += mu; heli.vT += mv;
    if (NET && Math.abs(heli.u - S.u0) > PERIOD_NET * 0.62) setLayout('network', Math.round(heli.u / PERIOD_NET) * PERIOD_NET);
    synth.setScene(mean, heli.h);
  }
  function updateCamera(dt) {
    // Approach (held): the target runs ahead / sideways at a speed that suits the height; the springs smooth it
    if (hold.f || hold.s) {
      const sp = (20 + heli.h * 0.3) * (hold.boost ? 3 : 1);          // m/s: about 60 at 400 ft, 250 at 2,500 ft
      approachV.x += ((hold.f * sp) - approachV.x) * (1 - Math.exp(-dt * 2.2));
      approachV.y += ((hold.s * sp) - approachV.y) * (1 - Math.exp(-dt * 2.2));
    } else { approachV.x *= Math.exp(-dt * 2.2); approachV.y *= Math.exp(-dt * 2.2); }
    if (Math.abs(approachV.x) + Math.abs(approachV.y) > 0.01) {
      const fu = Math.cos(heli.yaw), fv = Math.sin(heli.yaw);
      heli.uT += (approachV.x * fu - approachV.y * fv) * dt; heli.vT += (approachV.x * fv + approachV.y * fu) * dt;
    }
    spring(heli, 'u', 'uV', heli.uT, heli.posW, dt); spring(heli, 'v', 'vV', heli.vT, heli.posW, dt);
    if (heli.fly && Math.hypot(heli.u - heli.uT, heli.v - heli.vT) < 2 && Math.hypot(heli.uV, heli.vV) < 1) { heli.fly = null; heli.posW = 2.2; }
    spring(heli, 'h', 'hV', heli.hT, heli.fly ? heli.flyW : 1.6, dt);
    spring(heli, 'tilt', 'tiltV', heli.tiltT, 1.5, dt);
    spring(heli, 'yaw', 'yawV', heli.yawT, 1.8, dt);
    const t = heli.tilt * Math.PI / 180;
    const fx = Math.sin(heli.yaw), fz = -Math.cos(heli.yaw);
    camera.position.set(heli.v - O.v, heli.h, -(heli.u - O.u));
    const dir = new THREE.Vector3(fx * Math.cos(t), -Math.sin(t), fz * Math.cos(t));
    camera.up.set(fx * Math.sin(t), Math.cos(t), fz * Math.sin(t));
    camera.lookAt(camera.position.clone().add(dir));
    camera.near = Math.max(0.5, heli.h * 0.02); camera.far = Math.max(20000, heli.h * 40);
    scene.fog.near = Math.max(3000, heli.h * 6); scene.fog.far = Math.max(16000, heli.h * 30);
    camera.updateProjectionMatrix();
  }
  function draw() { placeStatic(); writeCars(); renderer.render(scene, camera); }

  // ------------------------------------------------------------------ sound
  const synth = new CT30Sound.Synth(), speaker = new CT30Sound.Speaker(synth);

  // ------------------------------------------------------------------ mouse
  {
    let drag = null;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, mode: e.button === 2 || e.shiftKey ? 'turn' : 'move' };
      canvas.setPointerCapture(e.pointerId); canvas.classList.add('drag');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.mode === 'turn') { heli.yawT += dx * 0.004; heli.tiltT = clamp(heli.tiltT + dy * 0.15, 8, 90); notify(); return; }
      // move: the ground under the pointer follows it
      const k = 2 * heli.h * Math.tan(25 * Math.PI / 180) / Math.max(200, canvas.clientHeight);
      const fu = Math.cos(heli.yaw), fv = Math.sin(heli.yaw);
      const side = -dx * k, fwd = dy * k;                     // right-hand vector of the heading in plan = (-fv, fu)
      heli.uT += fwd * fu - side * fv; heli.vT += fwd * fv + side * fu;
      heli.fly = null; heli.posW = 5;                               // a drag follows the hand closely, but still eases
      notify();
    });
    const up = (e) => { drag = null; heli.posW = 2.2; canvas.classList.remove('drag'); try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ } };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); heli.hT = clamp(heli.hT * Math.exp(e.deltaY * 0.0012), 50 * FT, 15000 * FT); notify(); }, { passive: false });
    canvas.addEventListener('dblclick', () => homeView());
  }
  function homeView() { flyTo(heli.uT, HOME_V, heli.hT, 90, 0); notify(); }
  /** a smooth flight: position, height, tilt and heading all ease in and out; long flights get softer springs so the
   *  top speed stays sensible (peak speed of a critically damped move = distance x stiffness / e) */
  function flyTo(u, v, h, tilt, yaw) {
    const d = Math.hypot(u - heli.u, v - heli.v);
    heli.uT = u; heli.vT = v; heli.hT = h; heli.tiltT = tilt; heli.yawT = yaw;
    heli.posW = clamp(160 * Math.E / Math.max(1, d), 0.45, 2.2); heli.flyW = Math.min(1.6, heli.posW * 1.4);
    heli.fly = { u, v };
    S.follow = false; S.heliMph = 0;
  }
  const hold = { f: 0, s: 0, boost: false };
  /** glide to the next / previous interchange, keeping the tilt you have (top-down: right over it; tilted: far enough
   *  back that it sits in the middle of the picture); below 1,500 ft it climbs to 2,500 ft */
  function goX(dir) {
    if (S.layout !== 'network') setLayout('network', Math.round(heli.u / PERIOD_NET) * PERIOD_NET);
    const X = NET.X.slice().sort((a, b) => a.U - b.U);
    const h = heli.hT < 1500 * FT ? 2500 * FT : heli.hT, t = heli.tiltT;
    const back = t >= 85 ? 0 : h / Math.tan(t * Math.PI / 180);
    const here = heli.uT + back;                                   // the point now in the middle of the view
    let x = dir > 0 ? X.find(q => q.U > here + 60) : X.slice().reverse().find(q => q.U < here - 60);
    if (!x) x = dir > 0 ? X[0] : X[X.length - 1];
    flyTo(x.U - back, -17, h, t, 0);
    toast(`${dir > 0 ? 'On to' : 'Back to'} the ${x.label} interchange: ${x.name}`);
  }
  const approachV = { x: 0, y: 0 };

  // ------------------------------------------------------------------ picture size = the canvas's real device pixels (as CT55)
  let PW = 0, PH = 0, resizeT = 0;
  function pictureSize() {
    if (qs.has('w') && qs.has('h')) return [Math.max(320, parseInt(qs.get('w'), 10) & ~1), Math.max(180, parseInt(qs.get('h'), 10) & ~1)];
    const dpr = window.devicePixelRatio || 1;
    let w = Math.max(320, stage.clientWidth * dpr), h = Math.max(180, stage.clientHeight * dpr);
    const s = Math.min(1, Math.sqrt(3840 * 2160 / (w * h)), 4096 / w, 2304 / h);
    return [Math.max(320, Math.floor(w * s / 2) * 2), Math.max(180, Math.floor(h * s / 2) * 2)];
  }
  function fit() {
    if (S.recording) return;
    const [w, h] = pictureSize();
    if (w === PW && h === PH) return;
    PW = w; PH = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    clearTimeout(resizeT); resizeT = setTimeout(prepareRecorder, 900);
  }
  addEventListener('resize', fit);

  // ------------------------------------------------------------------ recording (the CT55.A7 recorder: WebCodecs H.264 + AAC, constant frame rate)
  const FPS_KEY = 'CT30.fps';
  let FPS = parseInt(qs.get('fps') || (() => { try { return localStorage.getItem(FPS_KEY); } catch { return null; } })() || '60', 10) === 30 ? 30 : 60;
  let take = null, recBusy = false, recReady = '', lastMovie = null;
  async function prepareRecorder() {
    if (!CT30Rec.supported()) { recReady = 'this browser cannot make movies (use Chrome or Edge)'; return; }
    recReady = 'preparing…';
    const w = PW, h = PH, f = FPS;
    const pick = await CT30Rec.prepare(w, h, f, CT30Sound.SR);
    if (w === PW && h === PH && f === FPS) recReady = pick ? `${pick.name}${CT30Rec.audioPick ? ' + ' + (CT30Rec.audioPick.mux === 'aac' ? 'AAC' : 'Opus') + ' sound' : ' (no sound encoder)'}` : 'no video encoder works at this size';
  }
  async function startRecording() {
    if (recBusy || S.recording) return;
    if (!CT30Rec.supported()) { toast('This browser cannot make movies — use Chrome or Edge. Everything else works.'); return; }
    recBusy = true; fit();
    toast('Starting the recorder…');
    const w = PW, h = PH;
    let pick = CT30Rec.cached(w, h, FPS);
    if (pick === undefined) pick = await CT30Rec.prepare(w, h, FPS, CT30Sound.SR);
    recBusy = false;
    if (!pick) { toast('No video encoder works at ' + w + '×' + h + ' here. (' + CT30Rec.tried.slice(-3).join('; ') + ')'); return; }
    try { take = CT30Rec.Take(canvas, w, h, FPS, CT30Sound.SR, pick, CT30Rec.audioPick); }
    catch (e) { toast('The recorder could not start: ' + (e && e.message || e)); return; }
    S.recording = true; speaker.setMode('film'); document.body.classList.add('recording');
    toast(`● Recording ${w}×${h}, ${FPS} fps, ${pick.name}, sound ${take.audio}${S.sound ? '' : ' (Sound is off: silent track)'}. Press Record again to stop and download the MP4.`, 5000);
    notify();
  }
  async function stopRecording() {
    if (!S.recording || !take) return;
    const t = take; take = null; S.recording = false; speaker.setMode('live'); document.body.classList.remove('recording'); notify();
    if (t.frames === 0) { t.abort(); toast('Nothing was recorded.'); fit(); return; }
    toast(`Finishing the movie (${t.frames} frames)…`, 60000);
    let blob;
    try { blob = await t.finish(); } catch (e) { toast('The movie failed in the browser encoder: ' + (e && e.message || e), 12000); fit(); return; }
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const name = `${LABEL}_movie_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.mp4`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    lastMovie = { name, bytes: blob.size, frames: t.frames, seconds: t.seconds, w: t.w, h: t.h, fps: t.fps, codec: t.codec, audio: t.audio, mbps: t.mbps };
    $('toast').innerHTML = `Movie downloaded: <b>${name}</b> — ${t.seconds.toFixed(1)} s, ${t.w}×${t.h}, ${t.fps} fps, ${(blob.size / 1048576).toFixed(1)} MB (in your Downloads folder) · <a href="${url}" download="${name}">save another copy</a>`;
    $('toast').classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => $('toast').classList.remove('on'), 12000);
    fit();
  }

  // ------------------------------------------------------------------ actions (buttons, keys and MIDI all come here)
  const listeners = [];
  function notify() { refreshUI(); for (const f of listeners) try { f(); } catch { /* */ } }
  function reset() {
    S.time = 0;
    for (const L of lanes.values()) { L.D = L.D0; L.mult = 1; L.nextChange = S.mad ? L.rnd() * 1.5 : 4 + L.rnd() * 10; L.v = targetSpeed(L); }
    heli.hT = START_FT * FT; heli.tiltT = 90;
    Object.assign(heli, { u: START_U, v: HOME_V, uT: START_U, vT: HOME_V, uV: 0, vV: 0, speed: 0, acc: 0, yaw: 0, yawT: 0, yawV: 0, fly: null, posW: 2.2 });
    if (S.layout === 'network' && S.u0 !== 0) setLayout('network', 0);
    toast('Reset');
  }
  const laneAct = {};
  for (let i = 0; i < 8; i++) {
    laneAct['lane' + (i + 1) + 'Up'] = () => { S.laneMph[i] = clamp(S.laneMph[i] + 5, 0, 80); S.laneStop[i] = false; };
    laneAct['lane' + (i + 1) + 'Down'] = () => { S.laneMph[i] = clamp(S.laneMph[i] - 5, 0, 80); };
    laneAct['lane' + (i + 1) + 'Stop'] = () => { S.laneStop[i] = !S.laneStop[i]; };
    for (const [k, mph] of [['60', 60], ['45', 45], ['30', 30], ['15', 15], ['5', 5], ['0', 0]])
      laneAct['lane' + (i + 1) + 'At' + k] = () => { if (mph === 0) S.laneStop[i] = true; else { S.laneMph[i] = mph; S.laneStop[i] = false; } };
  }
  const ACT = Object.assign({
    reset,
    forward() { S.playing = true; },
    pause() { S.playing = false; },
    playPause() { S.playing = !S.playing; },
    record() { if (S.recording) stopRecording(); else startRecording(); },
    up() { heli.hT = clamp(heli.hT * 1.4, 50 * FT, 15000 * FT); },
    down() { heli.hT = clamp(heli.hT / 1.4, 50 * FT, 15000 * FT); },
    tilt() { const i = TILTS.findIndex(t => Math.abs(t - heli.tiltT) < 1); heli.tiltT = TILTS[(i + 1) % TILTS.length]; },
    follow() { S.follow = !S.follow; if (!S.follow) S.heliMph = Math.round(heli.speed / MPH); },
    hover() { S.follow = false; S.heliMph = 0; },
    heliFaster() { S.follow = false; S.heliMph = clamp(Math.round(S.heliMph) + 5, 0, 120); },
    heliSlower() { S.follow = false; S.heliMph = clamp(Math.round(S.heliMph) - 5, 0, 120); },
    allStop() { S.allStop = !S.allStop; if (!S.allStop) for (let i = 0; i < 8; i++) S.laneStop[i] = false; },
    auto() { S.auto = !S.auto; if (S.auto) for (const L of active) if (L.ours >= 0) L.nextChange = L.rnd() * 3; },
    boxes() { S.boxes = !S.boxes; if (!S.boxes && !CARS.length) { S.boxes = true; toast('No car atlas loaded'); } },
    laneTint() { S.laneTint = !S.laneTint; toast(S.laneTint ? 'Your 8 lanes: cars in the lane colours' : 'Your 8 lanes: cars in ordinary colours'); },
    mad() { S.mad = !S.mad; for (const L of active) { L.nextChange = L.rnd() * (S.mad ? 1 : 4); if (!S.mad) L.mult = 1; } toast(S.mad ? 'Traffic gone mad' : 'Traffic calmed down'); },
    othersFaster() { S.others = clamp(Math.round((S.others + 0.25) * 4) / 4, 0, 3); },
    othersSlower() { S.others = clamp(Math.round((S.others - 0.25) * 4) / 4, 0, 3); },
    interchange() {
      if (S.layout === 'network') { setLayout('straight', 0); toast('Interchanges off: the plain corridor'); return; }
      setLayout('network', Math.round(heli.u / PERIOD_NET) * PERIOD_NET);
      toast('Interchanges on: cloverleaf, six-level stack and cloverstack, every 3.2 km');
    },
    nextX() { goX(+1); },
    prevX() { goX(-1); },
    suburbs() { S.suburbs = !S.suburbs; },
    sound() { S.sound = !S.sound; synth.muted = !S.sound; if (S.sound) speaker.start(); },
    display() { S.bar = !S.bar; document.body.classList.toggle('nobar', !S.bar); setTimeout(fit, 30); },
    hud() { S.hud = !S.hud; document.body.classList.toggle('nohud', !S.hud); },
    home() { homeView(); },
  }, laneAct);
  // hold-to-fly actions (buttons, MIDI pads / keys): pressed = flying, released = easing to a stop
  const HOLD_ACT = { approach: ['f', 1], retreat: ['f', -1], strafeLeft: ['s', -1], strafeRight: ['s', 1] };
  function act(name, phase = 'press') {
    if (HOLD_ACT[name]) { const [k, d] = HOLD_ACT[name]; hold[k] = phase === 'release' ? 0 : d; if (phase !== 'release') { heli.fly = null; heli.posW = 2.2; } notify(); return; }
    const f = ACT[name]; if (!f || phase === 'release') return;
    f(); flash(name); notify();
  }
  /** value controls from encoders / knobs / faders: {delta} in detents or {value} 0..1 */
  function setValue(name, how) {
    let m;
    if ((m = /^lane(\d)$/.exec(name))) {
      const i = +m[1] - 1;
      if (how.value !== undefined) S.laneMph[i] = Math.round(clamp(how.value, 0, 1) * 80);
      else S.laneMph[i] = clamp(S.laneMph[i] + Math.sign(how.delta) * Math.max(1, Math.round(Math.abs(how.delta))), 0, 80);
      if (S.laneMph[i] > 0) S.laneStop[i] = false;
    } else if (name === 'heliSpeed') {
      S.follow = false;
      S.heliMph = how.value !== undefined ? Math.round(clamp(how.value, 0, 1) * 80) : clamp(S.heliMph + Math.sign(how.delta), 0, 120);
    } else if (name === 'altitude') {
      heli.hT = how.value !== undefined ? 50 * FT * Math.pow(300, clamp(how.value, 0, 1)) : clamp(heli.hT * Math.pow(1.06, how.delta), 50 * FT, 15000 * FT);
    } else if (name === 'others') {
      S.others = how.value !== undefined ? clamp(how.value, 0, 1) * 3 : clamp(S.others + 0.05 * how.delta, 0, 3);
    } else return;
    notify();
  }
  const isOn = (name) => {
    let m;
    if ((m = /^lane(\d)Stop$/.exec(name))) return S.laneStop[+m[1] - 1] || S.allStop;
    return ({ forward: S.playing, pause: !S.playing, record: S.recording, follow: S.follow, allStop: S.allStop, auto: S.auto, mad: S.mad, boxes: S.boxes, laneTint: S.laneTint,
      interchange: S.layout === 'network', suburbs: S.suburbs, sound: S.sound, approach: hold.f > 0, retreat: hold.f < 0, display: S.bar, hud: S.hud, hover: !S.follow && S.heliMph === 0 })[name];
  };

  // ------------------------------------------------------------------ the lane controls in the bar
  {
    const g = $('laneGrp');
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div'); d.className = 'lane';
      d.innerHTML = `<span class="v" id="v_lane${i + 1}" data-stop="${i + 1}" style="--lc:${LANE_COL[i]}" title="lane ${i + 1}: click = stop / go">${DEFAULT_MPH[i]}</span>
        <div class="pm"><button data-action="lane${i + 1}Down" class="small"><span class="t">−</span><span class="m"></span></button><button data-action="lane${i + 1}Up" class="small"><span class="t">+</span><span class="m"></span></button></div>
        <span class="u">lane ${i + 1}</span>`;
      g.appendChild(d);
    }
    for (const el of g.querySelectorAll('[data-stop]')) el.addEventListener('click', () => act('lane' + el.dataset.stop + 'Stop'));
  }

  // ------------------------------------------------------------------ on-screen buttons and keys
  const btns = [...document.querySelectorAll('#bar button[data-action]')];
  let learnHook = null;                                      // set by midi.js: right-click = learn
  for (const b of btns) {
    const name = b.dataset.action;
    b.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; b.setPointerCapture(e.pointerId); act(name, 'press'); });
    const rel = () => { if (HOLD_ACT[name]) act(name, 'release'); };
    b.addEventListener('pointerup', rel); b.addEventListener('pointercancel', rel); b.addEventListener('lostpointercapture', rel);
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (learnHook) learnHook(name, b); });
    b.addEventListener('click', (e) => e.preventDefault());
  }
  function flash(name) { const b = btns.find(x => x.dataset.action === name); if (b) { b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 120); } }
  const KEYS = { Backspace: 'reset', Enter: 'forward', p: 'pause', ' ': 'playPause', r: 'record', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'up', PageDown: 'down',
    t: 'tilt', g: 'follow', '0': 'hover', '-': 'heliSlower', '_': 'heliSlower', '=': 'heliFaster', '+': 'heliFaster', x: 'allStop', z: 'auto', j: 'mad', k: 'boxes', l: 'laneTint',
    ',': 'othersSlower', '.': 'othersFaster', n: 'interchange', v: 'nextX', b: 'prevX', u: 'suburbs', i: 'hud', m: 'sound', d: 'display', h: 'hud', Home: 'home' };
  // lanes: 1-8 = stop / go that lane, Shift+1-8 = 5 mph faster, Ctrl (or Alt)+1-8 = 5 mph slower
  const REPEATS = new Set(['up', 'down', 'heliFaster', 'heliSlower', 'othersFaster', 'othersSlower']);
  const HOLD = { w: ['f', 1], s: ['f', -1], q: ['s', -1], e: ['s', 1] };
  addEventListener('keyup', (e) => { const k = HOLD[e.key.toLowerCase()]; if (k) hold[k[0]] = 0; hold.boost = e.shiftKey; });
  addEventListener('blur', () => { hold.f = hold.s = 0; });
  addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const hk = HOLD[e.key.toLowerCase()];
    if (hk && !e.ctrlKey && !e.altKey) { e.preventDefault(); hold[hk[0]] = hk[1]; hold.boost = e.shiftKey; heli.fly = null; heli.posW = 2.2; return; }
    if (e.key === 'Escape') { for (const p of document.querySelectorAll('.panel.on')) p.classList.remove('on'); return; }
    if (e.key === '?' || e.key === '/') { $('helpPanel').classList.toggle('on'); return; }
    let name = null;
    const dg = /^Digit([1-8])$/.exec(e.code);
    if (dg) name = 'lane' + dg[1] + (e.shiftKey ? 'Up' : e.ctrlKey || e.altKey ? 'Down' : 'Stop');
    else name = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!name) return;
    e.preventDefault();
    if (e.repeat && !REPEATS.has(name) && !/^lane\dUp$|^lane\dDown$/.test(name)) return;
    act(name, 'press');
  });
  $('b_help').onclick = () => $('helpPanel').classList.toggle('on');
  for (const x of document.querySelectorAll('[data-close]')) x.onclick = () => x.closest('.panel').classList.remove('on');
  $('fpsSel').value = String(FPS);
  $('fpsSel').onchange = () => { if (S.recording) { $('fpsSel').value = String(FPS); toast('Stop recording first'); return; } FPS = parseInt($('fpsSel').value, 10); try { localStorage.setItem(FPS_KEY, String(FPS)); } catch { /* */ } prepareRecorder(); };

  const fmtTime = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`; };
  function refreshUI() {
    for (const b of btns) { const on = isOn(b.dataset.action); if (on !== undefined) b.classList.toggle('on', !!on); }
    for (let i = 0; i < 8; i++) { const el = $('v_lane' + (i + 1)); el.textContent = S.laneMph[i]; el.classList.toggle('stopped', S.laneStop[i] || S.allStop); }
    $('v_others').textContent = Math.round(S.others * 100) + '%';
    $('v_alt').textContent = fmtFt(heli.hT);
    $('v_heli').textContent = S.follow ? 'follow' : String(Math.round(S.heliMph));
    $('t_tilt').textContent = heli.tiltT >= 89 ? 'Tilt ⤢ (down)' : `Tilt ⤢ (${heli.tiltT}°)`;
  }
  let toastT = 0;
  function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }

  // ------------------------------------------------------------------ HUD text
  const perf = { n: 0, t0: 0, fps: 0 };
  let midiLine = '';
  function hud(now) {
    perf.n++; if (now - perf.t0 > 500) { perf.fps = perf.n * 1000 / (now - perf.t0); perf.n = 0; perf.t0 = now; }
    $('v_timer').textContent = fmtTime(S.time);
    if (S.recording && take) $('recTime').textContent = `${Math.floor(take.seconds / 60)}:${String(Math.floor(take.seconds) % 60).padStart(2, '0')}`;
    if (!S.hud || perf.n % 6) return;
    const lines = [];
    lines.push(`<b>${LABEL}</b>  ${S.playing ? '▶' : '❚❚ paused'}  ${fmtTime(S.time)}`);
    for (const L of active) if (L.ours >= 0) {
      const i = L.ours, st = S.allStop || S.laneStop[i];
      lines.push(`<span class="sw" style="background:${LANE_COL[i]}"></span>lane ${i + 1}  ${(L.v / MPH).toFixed(0).padStart(2)} mph${st ? '  stopped' : S.mad ? `  (mad, set ${S.laneMph[i]})` : S.auto ? `  (auto, max ${S.laneMph[i]})` : (Math.abs(L.v / MPH - S.laneMph[i]) > 0.6 ? `  → ${S.laneMph[i]}` : '')}${L.ramp ? '  · ' + L.ramp : ''}`);
    }
    lines.push(`helicopter ${fmtFt(heli.h)} ft · ${(heli.speed / MPH).toFixed(0)} mph${S.follow ? ' (following your lanes)' : ''} · ${heli.tilt >= 89 ? 'looking straight down' : 'tilted ' + heli.tilt.toFixed(0) + '°'}`);
    let where = 'plain corridor (interchanges off)';
    if (NET) {
      // A3: name the interchange nearest the middle of the picture (where a tilted view is looking), not under the helicopter
      const back = heli.tilt >= 85 ? 0 : heli.h / Math.tan(heli.tilt * Math.PI / 180), lu = heli.u + back * Math.cos(heli.yaw);
      const x = NET.X.reduce((b, q) => Math.abs(q.U - lu) < Math.abs(b.U - lu) ? q : b, NET.X[0]), d = x.U - lu;
      where = `looking at the ${x.name.toLowerCase()} (${x.label})${Math.abs(d) < 150 ? '' : ', ' + Math.round(Math.abs(d)) + ' m ' + (d > 0 ? 'beyond' : 'short of') + ' the middle of the view'}`;
    }
    lines.push(`${where} · ${active.length} lanes · ${carCount.toLocaleString('en-US')} cars drawn · other roads ${Math.round(S.others * 100)}%`);
    lines.push(S.recording && take ? `<b>● REC</b> ${take.seconds.toFixed(1)} s · ${take.frames} frames · ${take.w}×${take.h} @ ${take.fps} · ${take.codec} · ${take.mbps.toFixed(0)} Mbit/s${take.failed ? ' · ERROR ' + take.failed : ''}`
      : `movie: ${PW}×${PH} @ ${FPS} fps · ${recReady}`);
    lines.push(`${perf.fps.toFixed(0)} fps · ${midiLine}`);
    $('hud').innerHTML = lines.join('\n');
  }

  // ------------------------------------------------------------------ the frame loop (one clock for screen and movie, as CT55)
  let lastTick = 0, frozen = false;
  function tick(now) {
    requestAnimationFrame(tick);
    if (frozen) { lastTick = 0; return; }
    const filming = S.recording && take;
    if (filming) {
      if (now - lastTick < 1000 / FPS - 2) return;
      if (take.busy()) return;
      lastTick = now;
      const dt = 1 / FPS;
      step(dt); updateCamera(dt); draw();
      if (!take) return;
      const audio = synth.render(take.samplesForNextFrame());
      take.add(audio); speaker.feed(audio);
    } else {
      const dt = lastTick ? Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000)) : 1 / 60;
      lastTick = now;
      step(dt); updateCamera(dt); draw();
    }
    hud(now);
  }

  // ------------------------------------------------------------------ public handle (midi.js, tests)
  window.CT30 = {
    LABEL, S, heli, act, setValue, isOn, onChange: (f) => listeners.push(f), toast, synth, speaker, notify,
    setMidiLine(t) { midiLine = t; }, setLearnHook(f) { learnHook = f; }, buttons: btns, LANE_COL,
    get lanes() { return active; }, get carCount() { return carCount; }, get picture() { return [PW, PH]; }, get fps() { return FPS; },
    get take() { return take; }, get lastMovie() { return lastMovie; }, get recReady() { return recReady; },
    renderer, scene, camera, step, updateCamera, draw, freeze(v) { frozen = !!v; },
    stepTo(sec, dt = 1 / 60) { for (let t = 0; t < sec; t += dt) { step(dt); updateCamera(dt); } draw(); },
  };

  setLayout(qs.get('interchanges') === '0' ? 'straight' : 'network', 0);
  heli.u = heli.uT = START_U;
  fit(); refreshUI(); updateCamera(1); requestAnimationFrame(tick);
  setTimeout(prepareRecorder, 400);
  window.addEventListener('error', (e) => toast('Error: ' + (e.message || e), 15000));
  window.addEventListener('unhandledrejection', (e) => toast('Error: ' + (e.reason && e.reason.message || e.reason), 15000));
})();
