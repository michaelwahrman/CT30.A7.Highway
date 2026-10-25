/* CT30.A7.Highways -- the road network: a 12-lane-each-way corridor, three freeway-to-freeway interchanges, three
 * cross freeways and a parallel freeway. Every lane is a path; every ramp is a lane of its own (no merging yet).
 *
 * Road coordinates (metres): u = north (the way YOUR 8 lanes flow), v = east, y = up.
 * Right-hand traffic (US): the northbound carriageway is the east one, every ramp leaves and joins on the right.
 *
 * Roads
 *   NB / SB   the corridor: 8 through lanes each way (NB lanes 1-8 are yours, lane 1 = left, next to the median)
 *             plus ramp lanes outside them between interchanges (up to 6 more each way)
 *   EB / WB   three east-west freeways, 6 through lanes each way plus their ramp lanes
 *   PF        a parallel 6+6-lane freeway 1.7 km west; it rises on bridges over each cross freeway
 *
 * Interchanges (every freeway-to-freeway movement has its own 2-lane ramp: 8 ramps, 16 ramp lanes each)
 *   south  CLOVERLEAF     cross freeway on an 8 m bridge; left turns by 270° loops inside the four right-turn ramps
 *   middle SIX-LEVEL STACK  corridor at 0 m, cross freeway at 9 m, left turns on flyovers at 16, 21, 26 and 31 m
 *   north  CLOVERSTACK    corridor left turns on flyovers (16 and 21 m), cross-freeway left turns on loops
 *
 * A6 (traffic beyond all realism): the corridor has 16 lanes each way (yours are NB 1-8, by the median), every cross
 *   freeway 12 each way, the parallel freeway 10 each way; two 12+12-lane EXPRESS viaducts run beside the corridor at
 *   40 m (west) and 46 m (east), over every ramp; SIX interchanges per 9.6 km (every 1.6 km: cloverleaf, stack,
 *   cloverstack, stack, cloverleaf, cloverstack); four 6+6-lane diagonals on viaducts at 56-80 m, over everything.
 *   Ramp slots start right outside the through lanes (NS_T, NS_T + 1, ...).
 *
 * A4: three DIAGONAL freeways (4 + 4 lanes) cross the network at angles with no ramps -- overpasses, not interchanges:
 *   D1 (60° east of north, across the corridor 1.6 km south of the stack) and D3 (35°, 4.8 km north) on 14 m viaducts
 *   over everything; D2 (40° west of north, 1.6 km north of the stack) at ground level, with every road it meets
 *   (the corridor, the cross freeways, the parallel freeway) lifted on a bridge over it. Heights at every crossing are
 *   worked out from the roads' centre lines, so no two roads meet at the same level.
 *
 * Ramp lanes are chained: a lane that joins the corridor at one interchange rides it to the next one and leaves there,
 * so a lane can go: cross freeway -> ramp -> corridor -> ramp -> next cross freeway. Its slot (lateral position) is kept
 * between interchanges; where a loop would join in front of the lanes leaving by the same slot (the cloverleaf weave)
 * the joining lanes take the next slots out instead.
 */
(function (global) {
  'use strict';
  const LW = 3.66, DS = 2;
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // ------------------------------------------------------------------ paths (as A1)
  class LinePath {
    constructor(axis, c, y, dir) { this.axis = axis; this.c = c; this.y = y; this.dir = dir; }
    at(s, o) {
      if (this.axis === 'u') { o.u = s * this.dir; o.v = this.c; } else { o.v = s * this.dir; o.u = this.c; }
      o.y = this.y; o.tu = this.axis === 'u' ? this.dir : 0; o.tv = this.axis === 'v' ? this.dir : 0; o.ty = 0; return o;
    }
    nearestS(u, v) { return (this.axis === 'u' ? u : v) * this.dir; }
  }
  class SampledPath {
    constructor(pts, s0) {
      const U = [], V = [], Y = [];
      let acc = 0, need = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        while (need <= acc + L) { const f = L > 0 ? (need - acc) / L : 0; U.push(a[0] + (b[0] - a[0]) * f); V.push(a[1] + (b[1] - a[1]) * f); Y.push(a[2] + (b[2] - a[2]) * f); need += DS; }
        acc += L;
      }
      this.U = Float64Array.from(U); this.V = Float64Array.from(V); this.Y = Float64Array.from(Y);
      this.n = U.length; this.s0 = s0;
      const n = this.n;
      this.TU = new Float64Array(n); this.TV = new Float64Array(n); this.TY = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        const du = this.U[b] - this.U[a], dv = this.V[b] - this.V[a], dy = this.Y[b] - this.Y[a];
        const l = Math.hypot(du, dv, dy) || 1; this.TU[i] = du / l; this.TV[i] = dv / l; this.TY[i] = dy / l;
      }
    }
    get sEnd() { return this.s0 + (this.n - 1) * DS; }
    at(s, o) {
      const f = (s - this.s0) / DS;
      if (f <= 0) { const d = s - this.s0; o.u = this.U[0] + this.TU[0] * d; o.v = this.V[0] + this.TV[0] * d; o.y = this.Y[0]; o.tu = this.TU[0]; o.tv = this.TV[0]; o.ty = 0; return o; }
      if (f >= this.n - 1) { const k = this.n - 1, d = s - this.sEnd; o.u = this.U[k] + this.TU[k] * d; o.v = this.V[k] + this.TV[k] * d; o.y = this.Y[k]; o.tu = this.TU[k]; o.tv = this.TV[k]; o.ty = 0; return o; }
      const i = f | 0, t = f - i;
      o.u = this.U[i] + (this.U[i + 1] - this.U[i]) * t; o.v = this.V[i] + (this.V[i + 1] - this.V[i]) * t; o.y = this.Y[i] + (this.Y[i + 1] - this.Y[i]) * t;
      o.tu = this.TU[i] + (this.TU[i + 1] - this.TU[i]) * t; o.tv = this.TV[i] + (this.TV[i + 1] - this.TV[i]) * t; o.ty = this.TY[i] + (this.TY[i + 1] - this.TY[i]) * t;
      return o;
    }
    nearestS(u, v) {
      let best = 1e30, bi = 0;
      for (let i = 0; i < this.n; i += 16) { const d = (this.U[i] - u) ** 2 + (this.V[i] - v) ** 2; if (d < best) { best = d; bi = i; } }
      for (let i = Math.max(0, bi - 16); i <= Math.min(this.n - 1, bi + 16); i++) { const d = (this.U[i] - u) ** 2 + (this.V[i] - v) ** 2; if (d < best) { best = d; bi = i; } }
      if (bi === 0) { const d = (u - this.U[0]) * this.TU[0] + (v - this.V[0]) * this.TV[0]; if (d < 0) return this.s0 + d; }
      if (bi === this.n - 1) { const k = this.n - 1, d = (u - this.U[k]) * this.TU[k] + (v - this.V[k]) * this.TV[k]; if (d > 0) return this.sEnd + d; }
      return this.s0 + bi * DS;
    }
  }

  // ------------------------------------------------------------------ geometry of the roads
  const H = { N: [1, 0], S: [-1, 0], E: [0, 1], W: [0, -1] };
  const right = (h) => [-h[1], h[0]], left = (h) => [h[1], -h[0]];
  const rotCW = (h, a) => [h[0] * Math.cos(a) - h[1] * Math.sin(a), h[0] * Math.sin(a) + h[1] * Math.cos(a)];
  const rotCCW = (h, a) => rotCW(h, -a);
  const NS_T = 16, EW_T = 12;                                   // through lanes (A2-A5: 8 and 6)
  const V_SB = -35;                                             // centre of the southbound carriageway
  const EWC = 13.95;                                            // EB / WB carriageway centres are U -/+ this
  const NB_V = (j) => (j - 3.5) * LW;                           // NB slot j: 0..7 through (0 = left, by the median), 8.. ramp lanes (east)
  const SB_V = (j) => V_SB - (j - 3.5) * LW;                    // SB slot j: increasing to the west
  const EB_U = (U, j) => U - EWC - (j - 2.5) * LW;              // EB slot j: 0..5 through, increasing to the south
  const WB_U = (U, j) => U + EWC + (j - 2.5) * LW;              // WB slot j: increasing to the north
  /** the line a road's slot j runs along: [fixed coordinate index (0 = u fixed, 1 = v fixed), value] */
  function line(road, U, j) {
    if (road === 'NB') return [1, NB_V(j)];
    if (road === 'SB') return [1, SB_V(j)];
    if (road === 'EB') return [0, EB_U(U, j)];
    return [0, WB_U(U, j)];
  }
  const HEAD = { NB: 'N', SB: 'S', EB: 'E', WB: 'W' };

  const PF_V = -1700;
  const KINDS = {
    cloverleaf: { name: 'Cloverleaf', ew: 8, lefts: { NW: 'O', SE: 'O', EN: 'O', WS: 'O' } },
    stack: { name: 'Six-level stack', ew: 9, lefts: { NW: 'L', SE: 'L', EN: 'L', WS: 'L' }, fly: { NW: 16, SE: 21, EN: 26, WS: 31 } },
    cloverstack: { name: 'Cloverstack', ew: 8, lefts: { NW: 'L', SE: 'L', EN: 'O', WS: 'O' }, fly: { NW: 16, SE: 21 } },
  };

  function buildNetwork(Ub) {
    const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
    const X = ['cloverleaf', 'stack', 'cloverstack', 'stack', 'cloverleaf', 'cloverstack']
      .map((kind, i) => Object.assign({ kind, U: Ub - 4000 + 1600 * i }, KINDS[kind], { index: i, label: ORD[i] }));
    const xAt = (u) => X.reduce((b, x) => Math.abs(x.U - u) < Math.abs(b.U - u) ? x : b, X[0]);

    // ---- A4: the diagonal freeways and the bridges where they meet other roads
    // A6: all four cross the corridor half way between interchanges, on viaducts above everything (each at its own level)
    const DIAG = [
      { key: 'D1', name: 'diagonal freeway D1', theta: 60, u0: Ub, level: 56 },
      { key: 'D2', name: 'diagonal freeway D2', theta: -40, u0: Ub + 1600, level: 64 },
      { key: 'D3', name: 'diagonal freeway D3', theta: 35, u0: Ub - 3200, level: 72 },
      { key: 'D4', name: 'diagonal freeway D4', theta: -65, u0: Ub + 3200, level: 80 },
    ].map((d) => Object.assign(d, { du: Math.cos(d.theta * Math.PI / 180), dv: Math.sin(d.theta * Math.PI / 180), cu: d.u0, cv: V_SB / 2 }));
    const bumps = { NS: [], PF: [], EW: X.map(() => []), D: DIAG.map(() => []) };
    const bumpY = (list, t) => { let y = 0; for (const b of list) y = Math.max(y, b.h * (1 - smooth(b.w0, b.w0 + 380, Math.abs(t - b.t)))); return y; };
    // height of a road at a point (straight parts): its own profile, raised wherever it bridges another road
    function ewBase(x, v) { return x.ew * (1 - smooth(650, 1200, Math.abs(v - V_SB / 2))); }
    function pfBase(u) { let y = 0; for (const x of X) y = Math.max(y, 10 * (1 - smooth(320, 760, Math.abs(u - x.U)))); return y; }
    function dBase(d, sd) { return d.level * (1 - smooth(6500, 8500, Math.abs(sd))); }
    function ewY(x, v) { return Math.max(ewBase(x, v), bumpY(bumps.EW[x.index], v)); }
    function pfY(u) { return Math.max(pfBase(u), bumpY(bumps.PF, u)); }
    function nsY(u) { return bumpY(bumps.NS, u); }
    function dY(d, sd) { return Math.max(dBase(d, sd), bumpY(bumps.D[DIAG.indexOf(d)], sd)); }
    function roadY(road, x, p) { return road === 'NB' || road === 'SB' ? nsY(p[0]) : ewY(x, p[1]); }
    // crossings of the diagonals with the corridor (centre line v = V_SB / 2), each cross freeway (u = U) and the parallel freeway
    for (const d of DIAG) {
      const di = DIAG.indexOf(d);
      const meet = (yOther, other, t, sd, wOther) => {
        const yd = dBase(d, sd);
        if (Math.abs(yd - yOther) >= 6.5) return;                     // already clear
        if (d.level > 0) bumps.D[di].push({ t: sd, h: yOther + 7, w0: wOther + 40 });
        else other.push({ t, h: Math.max(yOther, 0) + 8, w0: 26 + 40 });
      };
      // corridor: v = V_SB/2 -> sd = 0
      meet(0, bumps.NS, d.cu, 0, 50);
      for (const x of X) {
        const sd = (x.U - d.cu) / d.du, v = d.cv + sd * d.dv;
        if (Math.abs(v - V_SB / 2) < 120) continue;                  // (never: diagonals cross between interchanges)
        meet(ewBase(x, v), bumps.EW[x.index], v, sd, 46);
      }
      const sdPF = (PF_V - d.cv) / d.dv, uPF = d.cu + sdPF * d.du;
      meet(pfBase(uPF), bumps.PF, uPF, sdPF, 24);
    }

    /** points of a whole lane: [pieces...] where a piece is a straight run on a road or a ramp; heights blended */
    function assemble(pieces) {
      // pieces: {type:'road', road, x, from:[u,v] or null (= far), to:[u,v] or null}, {type:'ramp', r}
      const out = [];
      const push = (u, v, y) => out.push([u, v, y]);
      // first pass: plan positions with the road heights, and remember the ramps' s ranges
      const plan = [];                                          // [u, v, yRoad, rampIndex or -1]
      const ramps = [];
      for (const pc of pieces) {
        if (pc.type === 'road') {
          const h = H[HEAD[pc.road]];
          const a = pc.from || [pc.to[0] - h[0] * 9000, pc.to[1] - h[1] * 9000];
          const b = pc.to || [pc.from[0] + h[0] * 9000, pc.from[1] + h[1] * 9000];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 8));
          for (let i = 0; i < n; i++) { const p = [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]; plan.push([p[0], p[1], roadY(pc.road, pc.x, p), -1]); }
        } else {
          const ri = ramps.length; ramps.push(pc.r);
          for (const p of pc.r.pts) plan.push([p[0], p[1], NaN, ri]);
        }
      }
      // arc-length along the plan
      const S = new Float64Array(plan.length);
      for (let i = 1; i < plan.length; i++) S[i] = S[i - 1] + Math.hypot(plan[i][0] - plan[i - 1][0], plan[i][1] - plan[i - 1][1]);
      // each ramp's height profile: leave road A's height 220 m before the curve, arrive on B's 160 m after it
      const profile = ramps.map((r, ri) => {
        let i0 = -1, i1 = -1;
        for (let i = 0; i < plan.length; i++) if (plan[i][3] === ri) { if (i0 < 0) i0 = i; i1 = i; }
        const yA = roadY(r.A, r.x, r.P), yB = roadY(r.B, r.x, r.E);
        return { sA: S[i0] - 220, sP: S[i0], sE: S[i1], sB: S[i1] + 160, yA, yB, fly: r.kind === 'L' ? r.fly : 0 };
      });
      for (let i = 0; i < plan.length; i++) {
        let y = plan[i][2];
        for (const pr of profile) {
          const s = S[i];
          if (s < pr.sA || s > pr.sB) continue;
          if (pr.fly) {
            const mid = (pr.sP + pr.sE) / 2;
            y = s < mid ? pr.yA + (pr.fly - pr.yA) * smooth(pr.sA, pr.sP + (pr.sE - pr.sP) * 0.3, s)
                        : pr.fly + (pr.yB - pr.fly) * smooth(pr.sE - (pr.sE - pr.sP) * 0.3, pr.sB, s);
          } else y = pr.yA + (pr.yB - pr.yA) * smooth(pr.sA, pr.sB, s);
        }
        if (Number.isNaN(y)) y = 0;
        push(plan[i][0], plan[i][1], y);
      }
      return out;
    }

    const lanes = [];
    // ---- through lanes
    // A4: the corridor's through lanes are sampled too, because the corridor bridges over D2
    for (let j = 0; j < NS_T; j++) { const pts = []; for (let u = Ub - 12000; u <= Ub + 12000; u += 8) pts.push([u, NB_V(j), nsY(u)]); lanes.push(Object.assign({ key: 'NB' + (j + 1), hw: j < 8 ? 'NB' : 'NBX', path: new SampledPath(pts, Ub - 12000) }, j < 8 ? { ours: j } : {})); }
    // A6: the express viaducts beside the corridor (west at 40 m, east at 46 m), 12 lanes each way
    for (const [vc, y, nm] of [[-160, 40, 'EXW'], [150, 46, 'EXE']]) for (const dir of [1, -1]) for (let j = 0; j < 12; j++) {
      const v = vc + dir * (2.5 + (j + 0.5) * LW), pts = [];
      for (let k = -12000; k <= 12000; k += 8) { const u = Ub + k * dir; pts.push([u, v, y * (1 - smooth(10500, 11800, Math.abs(k)))]); }
      lanes.push({ key: `${nm}${dir > 0 ? 'n' : 's'}${j + 1}`, hw: 'EXP', path: new SampledPath(pts, -12000) });
    }
    for (let j = 0; j < NS_T; j++) { const pts = []; for (let u = Ub + 12000; u >= Ub - 12000; u -= 8) pts.push([u, SB_V(j), nsY(u)]); lanes.push({ key: 'SB' + (j + 1), hw: 'SB', path: new SampledPath(pts, -(Ub + 12000)) }); }
    // the diagonal freeways: 4 lanes each way, 3 m median
    for (const d of DIAG) for (const dir of [1, -1]) for (let j = 0; j < 6; j++) {
      const off = dir * (2.4 + (j + 0.5) * LW), pu = -d.dv, pv = d.du;          // right of the forward heading = (-dv, du)
      const pts = [];
      for (let k = -9000; k <= 9000; k += 8) { const sd = k * dir; pts.push([d.cu + sd * d.du + off * pu, d.cv + sd * d.dv + off * pv, dY(d, sd)]); }
      lanes.push({ key: `${d.key}${dir > 0 ? 'a' : 'b'}${j + 1}`, hw: 'DG', path: new SampledPath(pts, -9000) });
    }
    for (const x of X) for (const road of ['EB', 'WB']) for (let j = 0; j < EW_T; j++) {
      const dir = road === 'EB' ? 1 : -1, u = road === 'EB' ? EB_U(x.U, j) : WB_U(x.U, j), pts = [];
      for (let v = -9000; v <= 9000; v += 8) { const vv = v * dir; pts.push([u, vv, ewY(x, vv)]); }
      lanes.push({ key: `${road}${x.index}_${j + 1}`, hw: 'XF', path: new SampledPath(pts, -9000) });
    }
    for (const [dir, base] of [[1, PF_V + 3], [-1, PF_V - 3]]) for (let j = 0; j < 10; j++) {
      const v = base + dir * j * LW, pts = [];
      for (let u = Ub - 12000; u <= Ub + 12000; u += 8) { const uu = dir > 0 ? u : 2 * Ub - u; pts.push([uu, v, pfY(uu)]); }
      lanes.push({ key: `PF${dir > 0 ? 'N' : 'S'}${j + 1}`, hw: 'PF', path: new SampledPath(pts, dir > 0 ? Ub - 12000 : -(Ub + 12000)) });
    }

    // ---- ramps, chained along the corridor
    // movement codes: first letter = from (heading), second = to; R right turn, lefts per interchange kind
    for (const dirNS of ['NB', 'SB']) {
      const north = dirNS === 'NB';
      const order = north ? X : X.slice().reverse();
      // corridor lanes arriving from far away use the base slots
      let cur = { R: [NS_T, NS_T + 1], L: [NS_T + 2, NS_T + 3] };
      let incoming = null;                                       // per class: the ramps that joined at the previous interchange
      for (let k = 0; k < order.length; k++) {
        const x = order[k];
        // exits from the corridor at x: right turn and left turn
        const toRight = north ? 'EB' : 'WB', toLeft = north ? 'WB' : 'EB';
        const leftCode = north ? 'NW' : 'SE', ex = {};
        const lk = x.lefts[leftCode];
        // cross-freeway slots: right-turn ramps 6-7, left 8-9; a joining loop would weave with the loop leaving: 10-11
        ex.R = [0, 1].map((q) => ramp2(x, dirNS, toRight, 'R', cur.R[q], EW_T + q, q, 0));
        ex.L = [0, 1].map((q) => ramp2(x, dirNS, toLeft, lk, cur.L[q], (lk === 'O' ? EW_T + 4 : EW_T + 2) + q, q, x.fly ? x.fly[leftCode] : 0));
        // join the incoming lanes (from the previous interchange) with these exits; first interchange: from far
        for (const cls of ['R', 'L']) for (let q = 0; q < 2; q++) {
          const e = ex[cls][q], pieces = [];
          if (incoming) { const inc = incoming[cls][q]; pieces.push({ type: 'ramp', r: inc.r }); pieces.push({ type: 'road', road: dirNS, x, from: inc.r.E.slice(), to: e.P.slice() }); }
          else pieces.push({ type: 'road', road: dirNS, x, from: null, to: e.P.slice() });
          pieces.push({ type: 'ramp', r: e });
          pieces.push({ type: 'road', road: e.B, x, from: e.E.slice(), to: null });
          if (incoming) pieces.unshift({ type: 'road', road: incoming[cls][q].r.A, x: incoming[cls][q].r.x, from: null, to: incoming[cls][q].r.P.slice() });
          const pts = assemble(pieces);
          lanes.push({ key: `${dirNS}r${x.index}${cls}${q}`, hw: 'RAMP', path: new SampledPath(pts, 0), ramp: rampLabel(incoming && incoming[cls][q].r, e) });
        }
        // entries onto the corridor at x: right turn from the cross road on the right, left turn from the other side
        const fromRight = north ? 'WB' : 'EB', fromLeft = north ? 'EB' : 'WB';
        const entLeftCode = north ? 'EN' : 'WS', ek = x.lefts[entLeftCode];
        // a loop joins BEFORE the crossing, in front of the lanes that leave by the same slot after it: use the next slots out
        const loopEntry = ek === 'O';
        const slotsL = loopEntry ? [NS_T + 4, NS_T + 5] : [NS_T + 2, NS_T + 3];
        const ent = {
          R: [0, 1].map((q) => ({ r: ramp2(x, fromRight, dirNS, 'R', EW_T + q, NS_T + q, q, 0) })),
          L: [0, 1].map((q) => ({ r: ramp2(x, fromLeft, dirNS, ek, EW_T + 2 + q, slotsL[q], q, x.fly ? x.fly[entLeftCode] : 0) })),
        };
        incoming = ent;
        cur = { R: [NS_T, NS_T + 1], L: slotsL };
        if (k === order.length - 1) {
          // the last interchange: the joining lanes ride the corridor away for good
          for (const cls of ['R', 'L']) for (let q = 0; q < 2; q++) {
            const inc = incoming[cls][q];
            const pts = assemble([{ type: 'road', road: inc.r.A, x: inc.r.x, from: null, to: inc.r.P.slice() }, { type: 'ramp', r: inc.r }, { type: 'road', road: dirNS, x, from: inc.r.E.slice(), to: null }]);
            lanes.push({ key: `${dirNS}r${x.index}${cls}${q}end`, hw: 'RAMP', path: new SampledPath(pts, 0), ramp: rampLabel(inc.r, null) });
          }
        }
      }
    }
    /** one ramp lane at interchange x: from road A's slot jA to road B's slot jB; q = 0 / 1 = left / right lane of the
     *  2-lane ramp (the right one is nearer the centre of a right turn, so the two arcs are concentric) */
    function ramp2(x, A, B, kind, jA, jB, q, fly) {
      const h1 = H[HEAD[A]], h2 = H[HEAD[B]], cw = kind !== 'L';
      // a right-turn ramp and a loop in the same quadrant both touch the same two roads: such circles stay clear of each
      // other only if the bigger one is ~6x the smaller, so where there are loops the right turns swing wide
      const hasLoops = Object.values(x.lefts).includes('O');
      const R0 = kind === 'R' ? (hasLoops ? 430 : 230) : kind === 'O' ? 72 : 330;
      const R = cw ? R0 - q * LW : R0 + q * LW;
      const D = cw ? [R * (right(h1)[0] - right(h2)[0]), R * (right(h1)[1] - right(h2)[1])] : [R * (left(h1)[0] - left(h2)[0]), R * (left(h1)[1] - left(h2)[1])];
      const [ia, ca] = line(A, x.U, jA), [ib, cb] = line(B, x.U, jB);
      const P = [0, 0]; P[ia] = ca; P[1 - ia] = cb - D[1 - ia];     // P on A's line; then E = P + D is on B's line
      const E = [P[0] + D[0], P[1] + D[1]];
      const side = cw ? right(h1) : left(h1), C = [P[0] + R * side[0], P[1] + R * side[1]];
      const total = kind === 'O' ? 1.5 * Math.PI : Math.PI / 2, pts = [];
      for (let a = 0; a <= total + 1e-9; a += DS / R) { const h = cw ? rotCW(h1, a) : rotCCW(h1, a), sd = cw ? right(h) : left(h); pts.push([C[0] - R * sd[0], C[1] - R * sd[1]]); }
      pts[pts.length - 1] = E.slice();
      return { P, E, pts, arcLen: R * total, kind, fly: fly || 0, x, A, B, h1, h2 };
    }
    function rampLabel(a, b) {
      const name = (r) => `${r.A}→${r.B} ${r.kind === 'R' ? 'ramp' : r.kind === 'O' ? 'loop' : 'flyover ' + r.fly + ' m'} at the ${r.x.label} ${r.x.name.toLowerCase()}`;
      return [a && name(a), b && name(b)].filter(Boolean).join(', then ');
    }
    // ---- the cross freeways' lanes that leave them by ramps, and those that join them, are part of the chains above;
    //      the cross freeways' right / left ramp slots for exits to the corridor use the EW slot numbers
    return { lanes, X, Ub, DIAG };
  }

  // straight layout (Interchanges off): the corridor and the parallel freeway only
  function straightLanes() {
    const L = [];
    for (let j = 0; j < NS_T; j++) L.push(Object.assign({ key: 'NB' + (j + 1), hw: j < 8 ? 'NB' : 'NBX', path: new LinePath('u', NB_V(j), 0, 1) }, j < 8 ? { ours: j } : {}));
    for (let j = 0; j < NS_T; j++) L.push({ key: 'SB' + (j + 1), hw: 'SB', path: new LinePath('u', SB_V(j), 0, -1) });
    for (let j = 0; j < 10; j++) L.push({ key: 'PFN' + (j + 1), hw: 'PF', path: new LinePath('u', PF_V + 3 + j * LW, 0, 1) });
    for (let j = 0; j < 10; j++) L.push({ key: 'PFS' + (j + 1), hw: 'PF', path: new LinePath('u', PF_V - 3 - j * LW, 0, -1) });
    return L;
  }
  const STRIPS = [
    { hw: 'NB', v: NB_V((NS_T - 1) / 2), w: NS_T * LW + 2, lanes: NS_T },
    { hw: 'SB', v: SB_V((NS_T - 1) / 2), w: NS_T * LW + 2, lanes: NS_T, left: 'east' },
  ];
  const PF_STRIPS = [{ hw: 'PF', v: PF_V + 3 + 4.5 * LW, w: 10 * LW + 2, lanes: 10 }, { hw: 'PF', v: PF_V - 3 - 4.5 * LW, w: 10 * LW + 2, lanes: 10, left: 'east' }];

  global.CT30Roads = { LW, DS, LinePath, SampledPath, buildNetwork, straightLanes, STRIPS, PF_STRIPS, NB_V, SB_V, V_SB, PF_V, KINDS, smooth };
})(window);
