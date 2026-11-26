// Animated pipeline figure: Generate -> Filter L1..L5 -> task profile -> Collect. Inline SVG, no dependencies.
// The picture is a pure function of time: draw(t). Play = advance t, replay = t from 0, reduced motion = draw(END) (a static diagram:
// broken arms stay parked and greyed at the layer that stopped them).
// Two layouts from the same code: landscape (flow left -> right) and portrait (flow top -> bottom, for phones).
//
// initPipeline(host, { sprites: "assets/sprites/sprites.json", spriteIds: ["id1","id2","id3"] })

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const GATES = [
  { id: "L1", name: "Kinematics", why: ["parallel axes"] },
  { id: "L2", name: "Mount & home", why: ["self-collision", "at home"] },
  { id: "L3", name: "Reach", why: ["links too short"] },
  { id: "L4", name: "Actuators", why: ["heavy hand /", "weak motors"] },
  { id: "L5", name: "Grasp in sim", why: ["weak grip"] },
];
// lane order: failing layer index (-1 = passes everything)
const FAILS = [0, 1, -1, 2, 3, -1, 4, -1];
const PROFILE = [[1, 1], [1, 0], [1, 1]]; // survivors: [T1 ok, T2 ok]
const T_GEN = 3.2; // generation phase ends
const SPEED = 175; // layout units per second
const END = 14;

// ---- arm icon (flat), built from parts so it can snap together -----------------------------------------------------------------------
function iconParts(k) {
  const n = 2 + (k % 2); // 2 or 3 links
  const grip = k % 3;
  const P = [];
  P.push({ tag: "rect", a: { x: -13, y: 11, width: 26, height: 6, rx: 2 }, role: "dark" });
  P.push({ tag: "line", a: { x1: 0, y1: 11, x2: 0, y2: -4 }, role: "main", w: 6 });
  P.push({ tag: "circle", a: { cx: 0, cy: -4, r: 4.2 }, role: "dark" });
  const e1 = [12 + (k % 3) * 2, -14 - (k % 2) * 2];
  P.push({ tag: "line", a: { x1: 0, y1: -4, x2: e1[0], y2: e1[1] }, role: "main", w: 5 });
  P.push({ tag: "circle", a: { cx: e1[0], cy: e1[1], r: 3.6 }, role: "dark" });
  let e = e1;
  if (n === 3) {
    e = [e1[0] + 5, e1[1] + 13];
    P.push({ tag: "line", a: { x1: e1[0], y1: e1[1], x2: e[0], y2: e[1] }, role: "main", w: 4 });
    P.push({ tag: "circle", a: { cx: e[0], cy: e[1], r: 3 }, role: "dark" });
  }
  const gx = e[0], gy = e[1] + 3;
  const g = [
    ["M", gx - 3.5, gy, "l", 0, 6],
    ["M", gx + 3.5, gy, "l", 0, 6],
    ["M", gx - 4, gy, "l", 0, 4, "m", 0, -4, "l", 8, 0, "m", 0, 0, "l", 0, 4],
  ][grip];
  P.push({ tag: "path", a: { d: g.map((v) => v).join(" "), fill: "none" }, role: "stroke", w: 2.6 });
  return P;
}

function rnd(seed) {
  let x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x);
}


function makeIcon(parent, i, anim) {
  const col = `var(--tok${i % 8})`;
  return iconParts(i).map((p, pi) => {
    const e = el(p.tag, p.a, parent);
    e.setAttribute("class", "p-" + p.role);
    if (p.role === "main") { e.setAttribute("stroke", col); e.setAttribute("stroke-width", p.w); e.setAttribute("stroke-linecap", "round"); }
    if (p.role === "dark") e.setAttribute("fill", "var(--ink2)");
    if (p.role === "stroke") { e.setAttribute("stroke", "var(--ink2)"); e.setAttribute("stroke-width", p.w); e.setAttribute("stroke-linecap", "round"); e.setAttribute("stroke-linejoin", "round"); }
    const a = rnd(i * 13 + pi * 7 + 1) * 6.283, r = 40 + rnd(i * 5 + pi * 3 + 2) * 70;
    return { e, dx: Math.cos(a) * r, dy: Math.sin(a) * r, rot: (rnd(pi + i * 3) - 0.5) * 240, delay: pi * 0.11 };
  });
}

export async function initPipeline(host, opts = {}) {
  let man = null;
  if (opts.sprites) {
    try {
      const url = new URL(opts.sprites, document.baseURI);
      man = { url, ...(await (await fetch(url)).json()) };
    } catch (e) {
      console.warn("pipeline: sprites unavailable, using icons", e);
    }
  }
  const spriteIds = (opts.spriteIds || []).filter((id) => man && man.sprites[id]);

  host.classList.add("pipeline");
  host.innerHTML = "";
  const svg = el("svg", { role: "img", "aria-label": "Pipeline: generate arms, filter them through five layers L1 to L5, build a per-arm task profile, collect demonstrations." }, host);
  const bar = document.createElement("div");
  bar.className = "pipe-bar";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Replay";
  btn.className = "pipe-replay";
  bar.appendChild(btn);
  host.appendChild(bar);

  let L = null, tokens = [], gateEls = [], t = 0, playing = false, last = 0, started = false, visible = false;

  const layoutFor = (portrait) => {
    if (!portrait) {
      const W = 1280, H = 560, lanes = FAILS.map((_, i) => 96 + i * 53);
      return { portrait, W, H, gates: [310, 424, 538, 652, 766], gen: [20, 232], prof: [850, 960], col: [1000, 1260], lanes, s0: 126, slot: 1196, icon: 1.35, head: 28, stopOff: 34 };
    }
    const W = 390, H = 1010, lanes = FAILS.map((_, i) => 34 + i * 44.5);
    return { portrait, W, H, gates: [290, 370, 450, 530, 610], gen: [40, 220], prof: [655, 735], col: [760, 990], lanes, s0: 130, slot: 880, icon: 0.95, head: 20, stopOff: 46 };
  };
  const pt = (s, c) => (L.portrait ? [c, s] : [s, c]);

  function build() {
    svg.innerHTML = "";
    L = layoutFor(host.clientWidth < 640);
    svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`);
    const gBack = el("g", {}, svg);
    const gGate = el("g", {}, svg);
    const gGhost = el("g", {}, svg);
    const gTok = el("g", {}, svg);
    const gTop = el("g", {}, svg);
    const txt = (s, c, str, cls, anchor = "middle", parent = gBack) => {
      const [x, y] = pt(s, c);
      const e = el("text", { x, y, class: cls, "text-anchor": anchor }, parent);
      e.textContent = str;
      return e;
    };
    // stage zones
    const zone = (a0, a1, cls) => {
      const [x, y] = pt(a0, L.portrait ? 4 : 44);
      const w = L.portrait ? L.W - 8 : a1 - a0, h = L.portrait ? a1 - a0 : L.H - 52;
      el("rect", { x, y, width: w, height: h, rx: 14, class: "zone " + cls }, gBack);
    };
    zone(L.gen[0], L.gen[1], "z-gen");
    zone(L.prof[0], L.prof[1], "z-prof");
    zone(L.col[0], L.col[1], "z-col");
    const hd = (a0, a1, label, sub) => {
      const mid = (a0 + a1) / 2;
      if (L.portrait) {
        const e = txt(a0 + 22, 18, label, "head", "start");
        if (sub) { const s2 = txt(a0 + 22, L.W - 18, sub, "sub", "end"); }
        return e;
      }
      txt(mid, 24, label, "head");
      if (sub) txt(mid, L.H - 12, sub, "sub");
    };
    hd(L.gen[0], L.gen[1], "Generate", "new arms from parts");
    hd(L.prof[0], L.prof[1], "Task profile", "which tasks it can do");
    hd(L.col[0], L.col[1], "Collect", "T1 pick-place · T2 drawer");
    // profile legend and task pictograms (static)
    const chipAt = (parent, x, y, label, ok) => {
      const gg = el("g", { transform: `translate(${x},${y})` }, parent);
      el("rect", { x: 0, y: 0, width: 22, height: 14, rx: 4, class: ok ? "chip ok" : "chip no" }, gg);
      const tt = el("text", { x: 11, y: 10.5, class: "chip-t", "text-anchor": "middle" }, gg);
      tt.textContent = label;
    };
    if (L.portrait) {
      chipAt(gBack, 40, 692, "T1", 1);
      const a = el("text", { x: 68, y: 703, class: "sub" }, gBack); a.textContent = "can do";
      chipAt(gBack, 150, 692, "T2", 0);
      const b = el("text", { x: 178, y: 703, class: "sub" }, gBack); b.textContent = "cannot";
    } else {
      const mid = (L.prof[0] + L.prof[1]) / 2;
      chipAt(gBack, mid - 44, 300, "T1", 1);
      const a = el("text", { x: mid - 16, y: 311, class: "sub" }, gBack); a.textContent = "can do";
      chipAt(gBack, mid - 44, 326, "T2", 0);
      const b = el("text", { x: mid - 16, y: 337, class: "sub" }, gBack); b.textContent = "cannot";
    }
    const task = (cx, cy, kind) => {
      const g = el("g", { transform: `translate(${cx},${cy})`, class: "task" }, gBack);
      if (kind === 1) {
        el("ellipse", { cx: 12, cy: 14, rx: 14, ry: 6, class: "t-bowl" }, g);
        el("rect", { x: -16, y: 2, width: 9, height: 9, rx: 1.5, class: "t-cube" }, g);
        el("path", { d: "M-8 0 Q4 -14 12 6", class: "t-arc", fill: "none" }, g);
      } else {
        el("rect", { x: -14, y: -4, width: 36, height: 26, rx: 3, class: "t-cab" }, g);
        el("rect", { x: -9, y: 3, width: 26, height: 12, rx: 2, class: "t-drw" }, g);
        el("line", { x1: -2, y1: 9, x2: 10, y2: 9, class: "t-handle" }, g);
      }
      const lab = el("text", { x: 4, y: 40, class: "sub", "text-anchor": "middle" }, g);
      lab.textContent = kind === 1 ? "T1" : "T2";
    };
    if (L.portrait) { task(100, 950, 1); task(290, 950, 2); } else { task(1072, 250, 1); task(1072, 410, 2); }
    // gates
    gateEls = GATES.map((g, k) => {
      const s = L.gates[k];
      const grp = el("g", {}, gGate);
      const [x, y] = pt(s, 0);
      if (L.portrait) {
        el("line", { x1: 12, x2: L.W - 12, y1: s, y2: s, class: "gate" }, grp);
        const glow = el("line", { x1: 12, x2: L.W - 12, y1: s, y2: s, class: "gate-glow" }, grp);
        const ttl = el("text", { x: 14, y: s - 12, class: "gt" }, grp);
        ttl.innerHTML = `<tspan class="gid">${g.id}</tspan> ${g.name}`;
        const why = el("text", { x: L.W - 14, y: s - 12, class: "why", "text-anchor": "end" }, grp);
        why.textContent = "✕ " + g.why.join(" ");
        return { glow, why, grp };
      }
      el("line", { x1: s, x2: s, y1: 46, y2: L.H - 52, class: "gate" }, grp);
      const glow = el("line", { x1: s, x2: s, y1: 46, y2: L.H - 52, class: "gate-glow" }, grp);
      const ttl = el("text", { x: s, y: 24, class: "gt", "text-anchor": "middle" }, grp);
      ttl.innerHTML = `<tspan class="gid">${g.id}</tspan> <tspan>${g.name}</tspan>`;
      const why = el("text", { x: s, y: L.H - 32, class: "why", "text-anchor": "middle" }, grp);
      g.why.forEach((ln, i) => {
        const ts = el("tspan", { x: s, dy: i ? 15 : 0 }, why);
        ts.textContent = (i ? "" : "✕ ") + ln;
      });
      return { glow, why, grp };
    });
    // tokens
    tokens = FAILS.map((f, i) => {
      const lane = L.lanes[i];
      const surv = f < 0 ? FAILS.slice(0, i).filter((x) => x < 0).length : -1;
      const [gx, gy] = pt(L.s0, lane);
      const ghost = el("g", { transform: `translate(${gx} ${gy}) scale(${L.icon})`, opacity: 0 }, gGhost);
      makeIcon(ghost, i, false);
      const grp = el("g", { class: "tok" }, gTok);
      const inner = el("g", {}, grp);
      const col = `var(--tok${i % 8})`;
      const parts = makeIcon(inner, i, true);
      const cross = el("g", { class: "cross", opacity: 0 }, grp);
      el("line", { x1: -9, y1: -9, x2: 9, y2: 9 }, cross);
      el("line", { x1: -9, y1: 9, x2: 9, y2: -9 }, cross);
      // survivors: pixel sprite + profile chips
      let spr = null, chips = null;
      if (surv >= 0) {
        chips = el("g", { opacity: 0 }, gTop);
        const mk = (label, ok, dy) => {
          const gg = el("g", { transform: L.portrait ? `translate(${dy * 24 - 23},-46)` : `translate(30,${dy * 17 - 8})` }, chips);
          el("rect", { x: 0, y: 0, width: 22, height: 14, rx: 4, class: ok ? "chip ok" : "chip no" }, gg);
          const tt = el("text", { x: 11, y: 10.5, class: "chip-t", "text-anchor": "middle" }, gg);
          tt.textContent = label + (ok ? "" : "–");
        };
        mk("T1", PROFILE[surv][0], 0);
        mk("T2", PROFILE[surv][1], 1);
        const id = spriteIds[surv % Math.max(1, spriteIds.length)];
        if (id) {
          const m = man.sprites[id], fr = man.frame, sz = 52;
          const cp = el("clipPath", { id: `pc${i}` }, svg);
          el("rect", { x: -sz / 2, y: -sz / 2, width: sz, height: sz }, cp);
          const g2 = el("g", { "clip-path": `url(#pc${i})`, opacity: 0 }, grp);
          const im = el("image", { href: new URL(m.sheet, man.url).href, x: -sz / 2, y: -sz / 2, width: (m.frames * sz), height: sz, preserveAspectRatio: "none", class: "px" }, g2);
          spr = { g2, im, m, sz };
        }
      }
      const sEnd = 0;
      return { i, f, lane, ghost, grp, inner, parts, cross, spr, chips, surv, sEnd, tDep: T_GEN + 0.15 * i };
    });
    // gate events
    for (const k of tokens) {
      const sStart = L.s0;
      const stop = k.f >= 0 ? L.gates[k.f] - L.stopOff : L.slot;
      k.stop = stop;
      k.tStop = k.tDep + (stop - sStart) / SPEED;
      k.cross_t = k.f >= 0 ? k.tStop : null;
    }
    draw(t);
  }

  function sPos(k, tt) {
    const d = Math.max(0, tt - k.tDep);
    return Math.min(L.s0 + SPEED * d, k.stop);
  }

  function draw(tt) {
    t = tt;
    const ev = GATES.map(() => ({ pass: -9, fail: -9, failed: false }));
    for (const k of tokens) {
      const [x0, y0] = pt(L.s0, k.lane);
      const s = sPos(k, tt);
      // assembly
      const asm = tt / T_GEN;
      for (const p of k.parts) {
        const u = ease((tt - 0.12 * k.i - p.delay) / 1.2);
        const dx = p.dx * (1 - u), dy = p.dy * (1 - u), rot = p.rot * (1 - u);
        p.e.setAttribute("transform", `translate(${dx.toFixed(1)} ${dy.toFixed(1)}) rotate(${rot.toFixed(1)})`);
        p.e.setAttribute("opacity", clamp01(u * 1.6).toFixed(2));
      }
      const [x, y] = pt(s, k.lane);
      let sc = L.icon, shake = 0, dead = 0;
      if (k.f >= 0 && tt >= k.tStop) {
        const a = tt - k.tStop;
        shake = a < 0.4 ? Math.sin(a * 50) * 2.2 * (1 - a / 0.4) : 0;
        dead = ease(a / 0.7);
        ev[k.f].fail = Math.max(ev[k.f].fail, k.tStop);
        ev[k.f].failed = true;
      }
      // gates crossed by this token
      if (k.f < 0 || true) {
        const lim = k.f >= 0 ? k.f : GATES.length;
        for (let g = 0; g < lim; g++) {
          const tc = k.tDep + (L.gates[g] - L.s0) / SPEED;
          if (tt >= tc) ev[g].pass = Math.max(ev[g].pass, tc);
        }
      }
      const [sx, sy] = L.portrait ? [shake, 0] : [0, shake];
      k.grp.setAttribute("transform", `translate(${(x + sx).toFixed(1)} ${(y + sy).toFixed(1)}) scale(${sc})`);
      k.grp.setAttribute("opacity", (1 - 0.62 * dead).toFixed(2));
      k.inner.setAttribute("class", dead > 0.3 ? "dead" : "");
      k.cross.setAttribute("opacity", dead.toFixed(2));
      k.ghost.setAttribute("opacity", (0.2 * ease((tt - 0.12 * k.i - 1.4) / 0.8)).toFixed(2));
      // survivors: icon -> pixel sprite once in the collect zone, chips once past the profile start
      if (k.surv >= 0) {
        const enter = ease((s - L.col[0]) / 60);
        if (k.spr) {
          k.spr.g2.setAttribute("opacity", enter.toFixed(2));
          const fps = man.fps || 12, n = k.spr.m.frames;
          const kk = Math.floor(Math.max(0, tt) * fps + k.i * 5);
          const Lp = 2 * n - 2, m2 = kk % Lp, idx = reduce() ? (k.spr.m.still ?? 0) : m2 < n ? m2 : Lp - m2;
          k.spr.im.setAttribute("x", (-k.spr.sz / 2 - idx * k.spr.sz).toString());
          k.inner.setAttribute("opacity", (1 - enter).toFixed(2));
        }
        const cp = ease((s - L.prof[0]) / 50);
        const [cx, cy] = pt(s, k.lane);
        k.chips.setAttribute("transform", `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`);
        k.chips.setAttribute("opacity", (cp * (1 - enter * 0)).toFixed(2));
      }
    }
    GATES.forEach((g, k) => {
      const passG = Math.exp(-(tt - ev[k].pass) / 0.35) * (tt >= ev[k].pass ? 1 : 0);
      const failG = Math.exp(-(tt - ev[k].fail) / 0.5) * (tt >= ev[k].fail ? 1 : 0);
      const ge = gateEls[k];
      ge.glow.setAttribute("class", failG > passG ? "gate-glow bad" : "gate-glow ok");
      ge.glow.setAttribute("opacity", Math.max(passG * 0.55, failG).toFixed(2));
      ge.why.setAttribute("opacity", ev[k].failed ? "1" : "0");
    });
  }

  function loop(now) {
    if (!playing) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    draw(t + dt);
    if (t >= END) { playing = false; host.classList.add("done"); return; }
    requestAnimationFrame(loop);
  }
  function play() {
    host.classList.remove("done");
    t = 0;
    playing = true;
    last = performance.now();
    requestAnimationFrame(loop);
  }
  function showFinal() { playing = false; draw(END); host.classList.add("done"); }

  btn.addEventListener("click", () => (reduce() ? showFinal() : play()));
  let w0 = host.clientWidth;
  new ResizeObserver(() => {
    const w = host.clientWidth;
    if ((w < 640) !== (w0 < 640)) { w0 = w; build(); }
  }).observe(host);
  build();
  new IntersectionObserver(
    (es) => {
      visible = es[0].isIntersecting;
      if (visible && !started) { started = true; reduce() ? showFinal() : play(); }
    },
    { threshold: 0.35 }
  ).observe(host);
  if (reduce()) showFinal();
  return { play, showFinal, draw: (x) => draw(x), END };
}
