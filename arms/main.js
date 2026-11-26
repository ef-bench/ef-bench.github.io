// Arm browser: one FK path (fk.js) poses every arm body and scene body, for joint sliders and episode replay alike.
// Data (written by pack.py / build_index.py): data/index.json, data/arms/<id>/{arm.glb,kin.json,t1.json,t2.json},
// data/scene/<key>.{glb,json}, data/scene/wood.jpg. MuJoCo frame (z up) lives under `root`, rotated into three.js (y up).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { forward } from "./fk.js";

const $ = (id) => document.getElementById(id);
const P = new URLSearchParams(location.search);
const STILL = P.has("still");                       // headless checks: no idle motion, no autoplay
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ACCENT = new THREE.Color("#ffb347");
const TASK_LABEL = { t1: "Pick & place", t2: "Open drawer" };
const DEFAULT_ARM = "rs00499_heavy";
const GROUPS = [
  { key: "dof", label: "DoF", opts: [[4, "4"], [5, "5"], [6, "6"], [7, "7"]], get: (a) => a.dof },
  { key: "tier", label: "Type", opts: [["A", "Real"], ["B", "Variant"], ["C", "Generated"]], get: (a) => a.tier },
  { key: "gg", label: "Gripper", opts: [["native", "Native"], ["commercial", "Commercial"], ["procedural", "Procedural"]], get: (a) => a.gg },
];

const S = {
  index: null, byId: {}, filt: { dof: new Set(), tier: new Set(), gg: new Set() }, query: "",
  id: null, task: P.get("task") === "t2" ? "t2" : "t1", cam: ["tp", "wrist", "orbit"].includes(P.get("cam")) ? P.get("cam") : "orbit",
  A: null,          // current arm: {id, kin, nodes[], group, ep, scene, q (arm-local qpos), sq (scene-local qpos), aB, sB}
  cache: new Map(), sceneCache: new Map(), loadSeq: 0,
  playing: false, frame: 0, speed: 1, hold: 0, active: null, sliders: [], tween: null,
  lastInput: performance.now(), breath: 0, mode: "browse", fade: null, famIdx: 0, dirty: true,
};

// ---------------------------------------------------------------- renderer, lights, cameras
const canvas = $("canvas");
const stage = $("stage");
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: STILL }); }
catch (e) {
  $("loadTxt").textContent = "This browser has no WebGL, so the 3D viewer cannot start.";
  document.querySelector("#loading .spin").style.display = "none";
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const root = new THREE.Group();
root.rotation.x = -Math.PI / 2;
scene.add(root);
root.updateMatrixWorld();

const sun = new THREE.DirectionalLight(0xfff4e8, 2.1);   // warm key from above-behind, like the area light in the renders
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 7;
sun.shadow.blurSamples = 16;
Object.assign(sun.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 0.1, far: 8 });
scene.add(sun, sun.target);
const fill = new THREE.HemisphereLight(0xdfe6ff, 0x3a2c22, 0.35);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.minDistance = 0.2;
controls.maxDistance = 6;
controls.maxPolarAngle = Math.PI * 0.49;
controls.addEventListener("change", () => (S.dirty = true));
controls.addEventListener("start", () => {
  S.tween = null;
  S.lastInput = performance.now();
  $("hint").classList.add("gone");
  if (S.cam === "tp") setCamButtons("orbit"), (S.cam = "orbit"), syncURL();
});
const wristCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.005, 20);   // pose set in MuJoCo frame under root
root.add(wristCam);
if (window.matchMedia("(pointer: coarse)").matches) $("hint").textContent = "Drag to orbit · pinch to zoom";

const loader = new GLTFLoader();
const woodTex = new THREE.TextureLoader().load("data/scene/wood.jpg", () => (S.dirty = true));
woodTex.colorSpace = THREE.SRGBColorSpace;
woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
woodTex.anisotropy = 8;

const axisViz = makeAxisViz();
root.add(axisViz);

const mjQ = (q) => new THREE.Quaternion(q[1], q[2], q[3], q[0]);
const mjV = (p) => new THREE.Vector3(p[0], p[1], p[2]);
const toWorld = (p) => mjV(p).applyMatrix4(root.matrixWorld);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function makeAxisViz() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true, opacity: 0.95 });
  const L = 0.3;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0026, 0.0026, L, 12), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.01, 0.03, 20), mat);
  head.position.y = L / 2 + 0.015;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.002, 8, 64, Math.PI * 1.6), mat);
  ring.rotation.x = Math.PI / 2;
  g.add(shaft, head, ring);
  g.userData.ring = ring;
  g.traverse((o) => (o.renderOrder = 999));
  g.visible = false;
  return g;
}

// ---------------------------------------------------------------- data
const getJSON = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u}: ${r.status}`);
  return r.json();
};

function dequant(ch, n) {
  const o = new Float64Array(n);
  if ("c" in ch) return o.fill(ch.c);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += ch.d[i]; o[i] = ch.lo + ch.s * acc; }
  return o;
}

function crease(gltf) {
  // once per loaded file: the GLBs carry no normals, so compute creased ones (clones then share the geometry)
  gltf.scene.traverse((o) => {
    if (o.isMesh && !o.geometry.attributes.normal) o.geometry = toCreasedNormals(o.geometry, (32 * Math.PI) / 180);
  });
  return gltf;
}

function prepGLB(gltf, prefix) {
  // node "<prefix><k>" -> Group k; creased normals; materials cloned per mesh so tint / fade stay local
  const nodes = [];
  gltf.scene.traverse((o) => {
    if (o.isMesh) {
      const m = o.material.clone();
      if (m.name === "wood") {
        m.map = woodTex;
        m.color.set(0xffffff);
      }
      if (m.name === "ceramic") m.envMapIntensity = 1.3;
      o.material = m;
      o.castShadow = m.name !== "wood";
      o.receiveShadow = true;
    }
  });
  for (const ch of [...gltf.scene.children]) {
    const k = +ch.name.slice(prefix.length);
    if (ch.name.startsWith(prefix) && Number.isFinite(k)) {
      const g = new THREE.Group();
      ch.position.set(0, 0, 0);
      ch.quaternion.identity();
      g.add(ch);
      nodes[k] = g;
    }
  }
  return nodes;
}

async function fetchArm(id) {
  if (S.cache.has(id)) return S.cache.get(id);
  const p = (async () => {
    const [kin, gltf] = await Promise.all([getJSON(`data/arms/${id}/kin.json`), loader.loadAsync(`data/arms/${id}/arm.glb`).then(crease)]);
    return { kin, gltf, eps: {} };
  })();
  S.cache.set(id, p);
  if (S.cache.size > 10) S.cache.delete(S.cache.keys().next().value);
  p.catch(() => S.cache.delete(id));
  return p;
}

async function fetchEp(rec, id, task) {
  if (!rec.eps[task]) rec.eps[task] = getJSON(`data/arms/${id}/${task}.json`).then((ep) => {
    ep.AQ = ep.arm_q.map((c) => dequant(c, ep.n));
    ep.SQ = ep.scene_q.map((c) => dequant(c, ep.n));
    ep.phaseAt = new Uint8Array(ep.n);
    let i = 0;
    for (const [p, len] of ep.phase_runs) for (let k = 0; k < len && i < ep.n; k++) ep.phaseAt[i++] = p;
    return ep;
  });
  return rec.eps[task];
}

async function fetchScene(key) {
  if (!S.sceneCache.has(key)) {
    S.sceneCache.set(key, Promise.all([getJSON(`data/scene/${key}.json`), loader.loadAsync(`data/scene/${key}.glb`).then(crease)])
      .then(([sc, gltf]) => ({ sc, gltf })));
  }
  return S.sceneCache.get(key);
}

// ---------------------------------------------------------------- load an arm + task
async function show(id, task = S.task, { blendFrom = null } = {}) {
  const seq = ++S.loadSeq;
  const meta = S.byId[id];
  if (!meta) return;
  if (!meta.tasks[task]) task = Object.keys(meta.tasks)[0];
  // overlay only for slow loads, never over a family cross-fade (the old arm stays on screen)
  S.loading = true;
  clearTimeout(S.loadTimer);
  if (blendFrom === null) S.loadTimer = setTimeout(() => S.loading && $("loading").classList.remove("gone"), 250);
  $("loadTxt").textContent = `Loading ${meta.name}…`;
  let rec, ep, scn;
  try {
    rec = await fetchArm(id);
    ep = await fetchEp(rec, id, task);
    scn = await fetchScene(ep.scene);
  } catch (e) {
    console.error(e);
    clearTimeout(S.loadTimer);
    $("loading").classList.remove("gone");
    $("loadTxt").textContent = `Could not load ${meta.name}`;
    return;
  }
  if (seq !== S.loadSeq) return;
  const old = S.A;
  const kin = rec.kin;
  // arm tree with this task's root pose; scene tree with this episode's body poses
  const aB = kin.bodies.map((b, i) => (ep.root[i] ? { ...b, pos: ep.root[i][0], quat: ep.root[i][1] } : b));
  const sB = scn.sc.bodies.map((b, i) => (i === 0 ? b : { ...b, pos: ep.scene_pose[i - 1].slice(0, 3), quat: ep.scene_pose[i - 1].slice(3) }));
  const group = new THREE.Group();
  const nodes = prepGLB(cloneGLTF(rec.gltf), "b");
  nodes.forEach((n) => n && group.add(n));
  const sgroup = new THREE.Group();
  const snodes = prepGLB(cloneGLTF(scn.gltf), "s");
  snodes.forEach((n) => n && sgroup.add(n));
  const jinfo = {};
  kin.bodies.forEach((b, i) => b.joints.forEach((j) => (jinfo[j.name] = { ...j, body: i })));
  const A = { id, meta, kin, ep, task, group, nodes, sgroup, snodes, aB, sB, jinfo, q: Float64Array.from(kin.home), sq: new Float64Array(ep.SQ.length), fk: null };
  root.add(sgroup);
  root.add(group);
  S.A = A;
  S.task = task;
  S.active = null;
  axisViz.visible = false;
  if (old) {
    if (blendFrom !== null && S.mode === "family") startFade(old, A);
    else disposeArm(old);
  }
  S.frame = 0;
  S.hold = 0;
  setFrame(0);
  // a still pose for the family demo, else the episode
  if (S.mode === "family") {
    A.q = Float64Array.from(kin.home);
    if (blendFrom) blendPose(A, blendFrom);
    pause();
  }
  placeLight();
  buildPanel();
  syncUI();
  syncList();
  applyCam(S.cam, !!old && S.cam !== "wrist");
  S.loading = false;
  clearTimeout(S.loadTimer);
  $("loading").classList.add("gone");
  syncURL();
  if (S.mode === "browse" && !STILL && !REDUCED && !S.userPaused) play();
  S.dirty = true;
  // warm the other task of the same arm in the background
  const other = task === "t1" ? "t2" : "t1";
  if (meta.tasks[other]) fetchEp(rec, id, other).then((e2) => fetchScene(e2.scene)).catch(() => {});
}

function cloneGLTF(gltf) {
  // a deep clone that shares geometry (materials are cloned in prepGLB)
  return { scene: gltf.scene.clone(true) };
}

function disposeArm(A) {
  for (const g of [A.group, A.sgroup]) {
    g.traverse((o) => o.isMesh && o.material.dispose());
    g.removeFromParent();
  }
}

// ---------------------------------------------------------------- pose
function applyPose(A = S.A) {
  if (!A) return;
  const fk = forward({ bodies: A.aB }, A.q);
  A.fk = fk;
  for (let i = 1; i < A.nodes.length; i++) {
    const n = A.nodes[i];
    if (!n) continue;
    n.position.set(fk.xpos[i][0], fk.xpos[i][1], fk.xpos[i][2]);
    n.quaternion.set(fk.xquat[i][1], fk.xquat[i][2], fk.xquat[i][3], fk.xquat[i][0]);
  }
  if (A === S.A) {
    const sfk = forward({ bodies: A.sB }, A.sq);
    for (let i = 1; i < A.snodes.length; i++) {
      const n = A.snodes[i];
      if (!n) continue;
      n.position.set(sfk.xpos[i][0], sfk.xpos[i][1], sfk.xpos[i][2]);
      n.quaternion.set(sfk.xquat[i][1], sfk.xquat[i][2], sfk.xquat[i][3], sfk.xquat[i][0]);
    }
    if (S.active) placeAxis(fk);
    if (S.cam === "wrist") placeWrist(fk);
  }
  S.dirty = true;
}

function frameQ(ep, f, out, chans) {
  const i0 = Math.min(Math.floor(f), ep.n - 1), i1 = Math.min(i0 + 1, ep.n - 1), a = f - i0;
  for (let k = 0; k < chans.length; k++) out[k] = chans[k][i0] + a * (chans[k][i1] - chans[k][i0]);
}

function setFrame(f) {
  const A = S.A;
  if (!A) return;
  const ep = A.ep;
  S.frame = Math.max(0, Math.min(f, ep.n - 1));
  frameQ(ep, S.frame, A.q, ep.AQ);
  frameQ(ep, S.frame, A.sq, ep.SQ);
  applyPose();
  syncUI();
}

// gripper couplings: MuJoCo joint equality q1 - q1_0 = poly(q2 - q2_0); a one-joint equality pins q1 to q1_0 + c0
function applyEq(A) {
  for (let it = 0; it < 3; it++) for (const e of A.kin.eq) {
    const j1 = A.jinfo[e.j1];
    if (!j1) continue;
    const c = e.coef;
    let y = c[0];
    if (e.j2) {
      const j2 = A.jinfo[e.j2];
      if (!j2) continue;
      const x = A.q[j2.qadr] - j2.qpos0[0];
      y = c[0] + c[1] * x + c[2] * x * x + c[3] * x ** 3 + c[4] * x ** 4;
    }
    A.q[j1.qadr] = j1.qpos0[0] + y;
  }
}
function gripDrivers(A) {
  const followers = new Set(A.kin.eq.map((e) => e.j1));
  return A.kin.grip_joints.filter((n) => !followers.has(n) && A.jinfo[n]);
}

// ---------------------------------------------------------------- family demo: cross-fade + pose blend
function blendPose(A, fromQ) {
  // start the new arm in the old arm's pose (joint by joint, clamped to range), ease to its own home
  const target = Float64Array.from(A.kin.home);
  const start = Float64Array.from(target);
  A.kin.arm_joints.forEach((n, i) => {
    const j = A.jinfo[n];
    if (j && fromQ[i] !== undefined && j.range && j.range[0] < j.range[1]) start[j.qadr] = Math.min(j.range[1], Math.max(j.range[0], fromQ[i]));
  });
  A.blend = { start, target, t0: performance.now(), dur: 900 };
  A.q.set(start);
}
function startFade(old, nu) {
  if (S.fade) disposeArm(S.fade.old);
  const setOp = (A, o) => A.group.traverse((m) => {
    if (m.isMesh) { m.material.transparent = o < 1; m.material.opacity = o; m.material.depthWrite = o > 0.5; }
  });
  old.sgroup.visible = false;
  S.fade = { old, nu, t0: performance.now(), dur: 700, setOp };
  setOp(nu, 0);
}
function stepFade(now) {
  const F = S.fade;
  if (!F) return;
  const t = Math.min(1, (now - F.t0) / F.dur), e = ease(t);
  F.setOp(F.old, 1 - e);
  F.setOp(F.nu, e);
  if (t >= 1) {
    disposeArm(F.old);
    F.setOp(F.nu, 1);
    S.fade = null;
  }
  S.dirty = true;
}
function stepBlend(now) {
  const A = S.A;
  if (!A || !A.blend) return;
  const B = A.blend;
  const t = Math.min(1, (now - B.t0) / B.dur), e = ease(t);
  for (let k = 0; k < A.q.length; k++) A.q[k] = B.start[k] + e * (B.target[k] - B.start[k]);
  applyPose();
  syncUI();
  if (t >= 1) A.blend = null;
}

// ---------------------------------------------------------------- joint highlight
function placeAxis(fk) {
  const j = fk.joints[S.active.joint];
  if (!j || !j.axis) { axisViz.visible = false; return; }
  axisViz.visible = true;
  axisViz.position.set(...j.anchor);
  axisViz.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), mjV(j.axis).normalize());
  axisViz.userData.ring.visible = S.A.jinfo[S.active.joint].type === "hinge";
}
function subtreeOf(A, b) {
  const out = new Set([b]);
  A.kin.bodies.forEach((x, i) => { if (out.has(x.parent)) out.add(i); });
  return out;
}
function setActive(name) {
  const A = S.A;
  if ((S.active && S.active.joint) === name) return;
  if (S.active) tint(S.active.bodies, false);
  if (!name || !A.jinfo[name]) { S.active = null; axisViz.visible = false; S.dirty = true; return; }
  const bodies = subtreeOf(A, A.jinfo[name].body);
  S.active = { joint: name, bodies };
  tint(bodies, true);
  applyPose();
}
function tint(bodies, on) {
  for (const i of bodies) {
    const n = S.A.nodes[i];
    if (n) n.traverse((o) => {
      if (!o.isMesh) return;
      o.material.emissive.copy(on ? ACCENT : new THREE.Color(0));
      o.material.emissiveIntensity = on ? 0.22 : 1;
    });
  }
  S.dirty = true;
}

// ---------------------------------------------------------------- panel + list
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function fmtJ(j, v) {
  const s = j.type === "slide" ? `${(v * 1000).toFixed(0)} mm` : `${((v * 180) / Math.PI).toFixed(0)}°`;
  return s.replace("-", "−");
}
function buildPanel() {
  const A = S.A, m = A.meta;
  $("armName").textContent = m.name;
  $("nameTxt").textContent = m.name;
  $("tierTag").textContent = m.tl;
  $("tierTag").dataset.tier = m.tier;
  $("tierChip").textContent = m.tl;
  $("tierChip").dataset.tier = m.tier;
  const parent = m.parent && S.byId[m.parent];
  const rows = [
    ["Type", esc(m.sub)],
    ["DoF", m.dof],
    ["Gripper", esc(m.grip)],
    parent ? ["Parent", `<a href="?arm=${m.parent}" data-arm="${m.parent}">${esc(parent.name)}</a>`] : null,
    ["Source", esc(m.src)],
    ["Licence", esc(m.lic.join(", "))],
    ["Release", m.rel === "public" ? "public tier · mesh included" : "renders only"],
    ["Mesh", `${(m.faces / 1000).toFixed(0)}k tris · ${(m.kb / 1024).toFixed(1)} MB`],
  ].filter(Boolean);
  $("specGrid").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("specGrid").querySelectorAll("a[data-arm]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); show(a.dataset.arm); }));
  $("instr").innerHTML = `<span class="lbl">${TASK_LABEL[A.task]} · instruction</span>${esc(A.ep.instruction)}`;
  $("taskSeg").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.t === A.task);
    b.disabled = !m.tasks[b.dataset.t];
  });
  $("camSeg").querySelector('[data-cam="wrist"]').disabled = !A.kin.wrist;
  $("scrub").max = A.ep.n - 1;
  $("scrub").step = 0.01;
  // joint sliders
  S.sliders = [];
  const jbox = $("joints");
  jbox.innerHTML = "";
  A.kin.arm_joints.forEach((name, i) => {
    const j = A.jinfo[name];
    if (!j) return;
    const [lo, hi] = j.range && j.range[0] < j.range[1] ? j.range : j.type === "slide" ? [-0.1, 0.1] : [-Math.PI, Math.PI];
    jbox.appendChild(sliderRow(`J${i + 1}`, name, (v) => (S.A.q[j.qadr] = v), () => S.A.q[j.qadr], (v) => fmtJ(j, v), lo, hi));
  });
  const gbox = $("gripper");
  gbox.innerHTML = "";
  const drv = gripDrivers(A);
  if (drv.length) {
    const J = drv.map((n) => A.jinfo[n]);
    const g0 = J[0];
    const frac = () => (S.A.q[g0.qadr] - g0.range[0]) / Math.max(1e-9, g0.range[1] - g0.range[0]);
    gbox.appendChild(sliderRow("Grip", "", (f) => {
      for (const j of J) S.A.q[j.qadr] = j.range[0] + f * (j.range[1] - j.range[0]);
      applyEq(S.A);
    }, frac, (f) => `${Math.round(f * 100)}%`, 0, 1));
  } else {
    gbox.innerHTML = '<div class="lbl">No gripper joints</div>';
  }
}
function sliderRow(label, name, set, get, fmt, lo, hi) {
  const row = document.createElement("div");
  row.className = "jrow";
  row.innerHTML = `<div class="jtop"><span class="jname">${label}</span><span class="jval"></span></div>` +
    `<input type="range" min="${lo}" max="${hi}" step="${(hi - lo) / 1000}" aria-label="${label}">`;
  const inp = row.querySelector("input"), val = row.querySelector(".jval");
  const grab = () => { pause(true); S.lastInput = performance.now(); if (name) setActive(name); };
  inp.addEventListener("pointerdown", () => {
    grab();
    window.addEventListener("pointerup", () => setActive(null), { once: true });
  });
  row.addEventListener("pointerenter", () => name && !S.playing && setActive(name));
  row.addEventListener("pointerleave", (e) => e.buttons === 0 && setActive(null));
  inp.addEventListener("keydown", grab);
  inp.addEventListener("input", () => {
    if (S.playing) pause(true);
    S.lastInput = performance.now();
    S.breath = 0;
    if (S.A) S.A.blend = null;
    set(+inp.value);
    applyPose();
    val.textContent = fmt(get());
  });
  S.sliders.push({ inp, val, get, fmt });
  return row;
}
function syncUI() {
  const A = S.A;
  if (!A) return;
  for (const s of S.sliders) {
    const v = s.get();
    if (document.activeElement !== s.inp || S.playing) s.inp.value = v;
    s.val.textContent = s.fmt(v);
  }
  $("scrub").value = S.frame;
  $("scrub").style.setProperty("--p", `${(100 * S.frame) / Math.max(1, A.ep.n - 1)}%`);
  $("time").textContent = `${(S.frame / A.ep.hz).toFixed(1)} s`;
  const ph = A.ep.phases[A.ep.phaseAt[Math.round(S.frame)]] || "";
  $("phase").textContent = ph.replace(/_/g, " ");
}

function matches(a) {
  for (const g of GROUPS) if (S.filt[g.key].size && !S.filt[g.key].has(g.get(a))) return false;
  if (!S.query) return true;
  const hay = `${a.name} ${a.sub} ${a.id} ${a.grip} ${a.tl} ${a.dof}dof ${a.style || ""}`.toLowerCase();
  return S.query.split(/\s+/).every((w) => hay.includes(w));
}
function buildChips() {
  const box = $("chips");
  box.innerHTML = GROUPS.map((g) => `<div class="cgroup"><span class="clabel">${g.label}</span>` +
    g.opts.map(([v, l]) => `<button class="chip-btn" data-g="${g.key}" data-v="${v}" aria-pressed="false">${l}</button>`).join("") + "</div>").join("");
  box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const set = S.filt[b.dataset.g];
    const v = b.dataset.g === "dof" ? +b.dataset.v : b.dataset.v;
    set.has(v) ? set.delete(v) : set.add(v);
    b.setAttribute("aria-pressed", set.has(v));
    buildList();
  }));
}
function buildList() {
  const arms = S.index.arms.filter(matches);
  $("count").textContent = `${arms.length} of ${S.index.arms.length} arms`;
  const ul = $("list");
  ul.innerHTML = arms.map((a) => `<li role="option" data-id="${a.id}" tabindex="-1"><span class="dot" data-tier="${a.tier}"></span>` +
    `<span class="li-main"><span class="li-name">${esc(a.name)}</span><span class="li-sub">${esc(a.sub)}</span></span>` +
    `<span class="li-dof">${a.dof}</span></li>`).join("") || '<li class="empty">No arm matches</li>';
  syncList();
}
function syncList() {
  $("list").querySelectorAll("li[data-id]").forEach((li) => {
    const on = S.A && li.dataset.id === S.A.id;
    li.classList.toggle("on", on);
    li.setAttribute("aria-selected", on);
  });
}
$("list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) show(li.dataset.id);
});
$("list").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...$("list").querySelectorAll("li[data-id]")];
  const i = items.findIndex((li) => li.dataset.id === (S.A && S.A.id));
  const nx = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
  if (nx) { nx.focus({ preventScroll: true }); listScroll(nx); show(nx.dataset.id); }
});
$("list").tabIndex = 0;
$("q").addEventListener("input", (e) => { S.query = e.target.value.trim().toLowerCase(); buildList(); });

// ---------------------------------------------------------------- playback
function play() {
  const A = S.A;
  if (!A) return;
  if (S.frame >= A.ep.n - 1) S.frame = 0;
  S.playing = true;
  S.userPaused = false;
  S.hold = 0;
  A.blend = null;
  $("playBtn").classList.add("playing");
  $("playBtn").setAttribute("aria-label", "Pause");
}
function pause(user = false) {
  S.playing = false;
  if (user) S.userPaused = true;
  $("playBtn").classList.remove("playing");
  $("playBtn").setAttribute("aria-label", "Play");
}
$("playBtn").addEventListener("click", () => {
  S.lastInput = performance.now();
  if (S.playing) return pause(true);
  if (S.A && S.mode === "family") setFrame(S.frame);   // leave the still pose, resume the episode
  play();
});
$("scrub").addEventListener("input", (e) => { pause(true); S.lastInput = performance.now(); setFrame(+e.target.value); });
$("speedSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  S.speed = +b.dataset.s;
  $("speedSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
}));
$("taskSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  if (S.A && b.dataset.t !== S.A.task) { S.userPaused = false; show(S.A.id, b.dataset.t); }
}));

// ---------------------------------------------------------------- cameras
function setCamButtons(name) {
  $("camSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.cam === name));
  stage.dataset.cam = name;
}
function fitFov(fovy, aspect) {
  // dataset frames are 16:9: on a narrower canvas widen the vertical fov so the same horizontal extent stays in view
  const tanV = Math.tan((fovy * Math.PI) / 360);
  return Math.max(fovy, (360 / Math.PI) * Math.atan((tanV * 16) / 9 / aspect));
}
function armBox(A) {
  const box = new THREE.Box3();
  A.group.updateMatrixWorld(true);
  box.setFromObject(A.group);
  return box;
}
function camPose(name) {
  const A = S.A;
  const [sw, sh] = stageSize();
  const aspect = sw / Math.max(1, sh);
  const k = A.ep.cam;
  if (name === "tp" && k) {
    const pos = toWorld(k.pos);
    const quat = root.quaternion.clone().multiply(mjQ(k.quat));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const c = armBox(A).getCenter(new THREE.Vector3());
    const t = Math.max(0.3, c.clone().sub(pos).dot(fwd));
    return { pos, target: pos.clone().addScaledVector(fwd, t), fov: fitFov(k.fovy, aspect) };
  }
  // orbit default: the dataset camera's direction, pulled in or out so the whole arm fills about 70 % of the frame
  const box = armBox(A);
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(0.18, box.getSize(new THREE.Vector3()).length() / 2);
  let dir = new THREE.Vector3(0.75, 0.55, 0.9);
  if (k) dir = toWorld(k.pos).sub(c);
  dir.y = Math.max(dir.y, 0.35 * Math.hypot(dir.x, dir.z));
  dir.normalize();
  const fov = 34;
  const vfov = (fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.15;
  const target = c.clone();
  target.y = Math.max(0.05, c.y * 0.92);
  return { pos: target.clone().addScaledVector(dir, dist), target, fov };
}
function applyCam(name, animate = true) {
  if (!S.A) return;
  if (name === "wrist" && !S.A.kin.wrist) name = "orbit";
  S.cam = name;
  setCamButtons(name);
  controls.enabled = name !== "wrist";
  if (name === "wrist") {
    S.tween = null;
    wristCam.fov = S.A.kin.wrist.fovy;
    placeWrist(S.A.fk);
    S.dirty = true;
    syncURL();
    return;
  }
  const to = camPose(name);
  if (!animate || REDUCED || STILL) {
    camera.position.copy(to.pos);
    controls.target.copy(to.target);
    camera.fov = to.fov;
    camera.updateProjectionMatrix();
    controls.update();
  } else {
    S.tween = { t0: performance.now(), dur: 650, p0: camera.position.clone(), t0v: controls.target.clone(), f0: camera.fov, to };
  }
  S.dirty = true;
  syncURL();
}
function stepTween(now) {
  const T = S.tween;
  if (!T) return;
  const t = Math.min(1, (now - T.t0) / T.dur), e = ease(t);
  camera.position.lerpVectors(T.p0, T.to.pos, e);
  controls.target.lerpVectors(T.t0v, T.to.target, e);
  camera.fov = T.f0 + e * (T.to.fov - T.f0);
  camera.updateProjectionMatrix();
  if (t >= 1) S.tween = null;
  S.dirty = true;
}
function placeWrist(fk) {
  const A = S.A, w = A.kin.wrist;
  if (!w || !fk) return;
  const bp = fk.xpos[w.body], bq = fk.xquat[w.body];
  const qb = mjQ(bq);
  wristCam.position.copy(mjV(bp).add(mjV(w.pos).applyQuaternion(qb)));
  wristCam.quaternion.copy(qb.multiply(mjQ(w.quat)));
}
function placeLight() {
  const A = S.A;
  const box = new THREE.Box3().setFromObject(A.sgroup).union(armBox(A));
  const c = box.getCenter(new THREE.Vector3());
  c.y = 0;
  sun.target.position.copy(c);
  sun.position.copy(c).add(new THREE.Vector3(-0.9, 3.2, -1.1));
  sun.target.updateMatrixWorld();
  const s = Math.min(2.2, Math.max(1.0, box.getSize(new THREE.Vector3()).length() * 0.6));
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
  sun.shadow.camera.updateProjectionMatrix();
}
$("camSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { S.lastInput = performance.now(); applyCam(b.dataset.cam); }));
$("resetView").addEventListener("click", () => applyCam(S.cam === "wrist" ? "orbit" : S.cam));

// ---------------------------------------------------------------- modes: browse / family
function familyOf(id) {
  const m = S.byId[id];
  if (!m) return null;
  const par = m.tier === "B" ? m.parent : m.id;
  const kids = S.index.families[par];
  return kids ? { par, kids } : null;
}
function setMode(mode) {
  S.mode = mode;
  $("modeTabs").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === mode);
    b.setAttribute("aria-selected", b.dataset.mode === mode);
  });
  document.body.dataset.mode = mode;
  $("family").hidden = mode !== "family";
  if (mode === "family") {
    let f = S.A && familyOf(S.A.id);
    if (!f) {   // pick a parent with many children
      const par = Object.entries(S.index.families).sort((a, b) => b[1].length - a[1].length)[0][0];
      f = familyOf(par);
    }
    S.fam = f;
    S.famIdx = S.A && f.kids.includes(S.A.id) ? f.kids.indexOf(S.A.id) + 1 : 0;
    pause();
    buildFamily();
    const id = S.famIdx === 0 ? f.par : f.kids[S.famIdx - 1];
    if (!S.A || S.A.id !== id) show(id);
    else { S.A.q.set(S.A.kin.home); applyPose(); syncUI(); }
  } else if (S.A && !STILL && !REDUCED) {
    setFrame(0);
    play();
  }
  syncURL();
}
function buildFamily() {
  const f = S.fam;
  const all = [f.par, ...f.kids];
  $("famTitle").textContent = `${S.byId[f.par].name}: one real parent, ${f.kids.length} pool children`;
  $("famSub").textContent = "Each child changes link lengths, joint layout, gripper or finish, and still passes the feasibility filter.";
  $("famStrip").innerHTML = all.map((id, i) => {
    const a = S.byId[id];
    return `<button class="fam-chip ${i === S.famIdx ? "on" : ""}" data-i="${i}"><span class="dot" data-tier="${a.tier}"></span>` +
      `${i === 0 ? "Parent" : esc(a.sub.replace(/^variant · /, "").replace(/^variant /, "v"))}<span class="fam-dof">${a.dof}</span></button>`;
  }).join("");
  $("famStrip").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => famGo(+b.dataset.i)));
}
function famGo(i) {
  const f = S.fam, all = [f.par, ...f.kids];
  S.famIdx = (i + all.length) % all.length;
  $("famStrip").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.i === S.famIdx));
  const fromQ = S.A ? S.A.kin.arm_joints.map((n) => S.A.q[S.A.jinfo[n].qadr]) : null;
  show(all[S.famIdx], S.task, { blendFrom: fromQ });
}
$("genBtn").addEventListener("click", () => famGo(S.famIdx + 1));
$("modeTabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function syncURL() {
  if (!S.A) return;
  const u = new URLSearchParams(location.search);
  u.set("arm", S.A.id);
  u.set("task", S.task);
  S.cam === "orbit" ? u.delete("cam") : u.set("cam", S.cam);
  S.mode === "family" ? u.set("mode", "family") : u.delete("mode");
  history.replaceState(null, "", `${location.pathname}?${u}`);
}

// ---------------------------------------------------------------- loop
// S.fixed = [w, h] pins the drawing buffer (headless replay-vs-MuJoCo check), else the stage size
function stageSize() {
  return S.fixed || [stage.clientWidth, stage.clientHeight];
}
function resize() {
  const [w, h] = stageSize();
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  wristCam.aspect = w / h;
  wristCam.updateProjectionMatrix();
  S.dirty = true;
}
new ResizeObserver(() => {
  resize();
  if (S.cam === "tp" && S.A && !S.tween) applyCam("tp", false);
}).observe(stage);

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.25, (now - last) / 1000);  // slow devices play slower than real time only below 4 fps
  last = now;
  const A = S.A;
  if (A && S.playing) {
    if (S.frame >= A.ep.n - 1) {
      S.hold += dt;
      if (S.hold > 1.2) { S.hold = 0; setFrame(0); }
    } else {
      setFrame(S.frame + dt * A.ep.hz * S.speed);
    }
  }
  stepTween(now);
  stepFade(now);
  stepBlend(now);
  // idle breathing: after 5 s without input, a still arm sways a few degrees about its pose
  if (A && !S.playing && !A.blend && !STILL && !REDUCED && S.cam !== "wrist" && now - S.lastInput > 5000 && !S.active) {
    const w = Math.min(1, (now - S.lastInput - 5000) / 1500);
    const ph = now / 1000;
    const prev = S.breath;
    S.breath = w * Math.sin(ph * 1.3) * 0.035;
    const n = A.kin.arm_joints.length;
    for (let i = 0; i < Math.min(3, n); i++) {
      const j = A.jinfo[A.kin.arm_joints[i === 0 ? 0 : i]];
      if (j && j.type === "hinge") A.q[j.qadr] += (S.breath - prev) * (i === 0 ? 1 : i === 1 ? -0.5 : 0.7);
    }
    applyPose();
  }
  if (controls.enabled && controls.update()) S.dirty = true;
  if (S.dirty) {
    renderer.render(scene, S.cam === "wrist" ? wristCam : camera);
    S.dirty = false;
  }
}

// ---------------------------------------------------------------- start
async function start() {
  if (P.get("embed") === "1") document.body.classList.add("embed");
  resize();
  requestAnimationFrame(loop);
  try {
    S.index = await getJSON("data/index.json");
  } catch (e) {
    $("loadTxt").textContent = "Could not load the arm list";
    return;
  }
  S.index.arms.forEach((a) => (S.byId[a.id] = a));
  buildChips();
  buildList();
  const id = S.byId[P.get("arm")] ? P.get("arm") : S.byId[DEFAULT_ARM] ? DEFAULT_ARM : S.index.arms[0].id;
  await show(id, S.task);
  if (P.get("mode") === "family") setMode("family");
  const li = $("list").querySelector("li.on");
  if (li) listScroll(li, true);
}
// scroll only the list box (scrollIntoView would also scroll the page to the list on a phone)
function listScroll(li, center) {
  const L = $("list"), r = li.getBoundingClientRect(), b = L.getBoundingClientRect();
  if (center) L.scrollTop += r.top - b.top - L.clientHeight / 2 + r.height / 2;
  else if (r.top < b.top) L.scrollTop += r.top - b.top;
  else if (r.bottom > b.bottom) L.scrollTop += r.bottom - b.bottom;
}
start();

// silhouette render for the replay-vs-MuJoCo check: arm (100), scene (200) as flat grey levels on black
const grey = (v) => new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(v / 255, v / 255, v / 255, THREE.SRGBColorSpace), toneMapped: false });
const MASK = [grey(100), grey(200)];
function mask(on) {
  const A = S.A;
  [A.group, A.sgroup].forEach((g, gi) => g.traverse((o) => {
    if (!o.isMesh) return;
    if (on) { o.userData.mat = o.userData.mat || o.material; o.material = MASK[gi]; }
    else if (o.userData.mat) { o.material = o.userData.mat; delete o.userData.mat; }
  }));
  renderer.setClearColor(0x000000, on ? 1 : 0);
  renderer.toneMapping = on ? THREE.NoToneMapping : THREE.AgXToneMapping;
  S.dirty = true;
}

// headless checks
window.__viewer = {
  mask,
  S, show, setFrame, applyCam, play, pause, setMode, famGo, forward,
  ready: () => !!S.A && !S.loading && $("loading").classList.contains("gone") && !S.tween && !S.fade,
  render: () => { S.dirty = true; renderer.render(scene, S.cam === "wrist" ? wristCam : camera); },
  fix: (w, h) => { S.fixed = [w, h]; renderer.setPixelRatio(1); resize(); if (S.A) applyCam(S.cam, false); },
  grab: () => canvas.toDataURL("image/png"),
};
