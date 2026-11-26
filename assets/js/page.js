// Project page behaviour: theme, teaser, sprites, pipeline, gallery, data wall, 3D browser hand-off, lightbox. Plain ES modules, no build step.
import { initSprites } from "./sprites.js";
import { initPipeline } from "./pipeline.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const KIND = { real: "Real arm", variant: "Variant", generated: "Generated" };

// ---- theme --------------------------------------------------------------------------------------------------------------------------
$("#themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (e) {}
});

// ---- scroll reveal + nav highlight ---------------------------------------------------------------------------------------------------
const rio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); rio.unobserve(e.target); } }), { threshold: 0.06 });
$$(".reveal").forEach((s) => rio.observe(s));
const links = new Map($$(".nav a[href^='#']").map((a) => [a.getAttribute("href").slice(1), a]));
const nio = new IntersectionObserver((es) => es.forEach((e) => {
  const a = links.get(e.target.id);
  if (a && e.isIntersecting) { links.forEach((x) => x.classList.remove("on")); a.classList.add("on"); }
}), { rootMargin: "-40% 0px -55% 0px" });
$$("main section[id]").forEach((s) => nio.observe(s));

// ---- lazy video (play only while visible) -------------------------------------------------------------------------------------------
const vio = new IntersectionObserver((es) => es.forEach((e) => {
  const v = e.target;
  if (e.isIntersecting) {
    if (!v.src && v.dataset.src) v.src = v.dataset.src;
    if (!reduce) v.play().catch(() => {});
  } else v.pause();
}), { rootMargin: "120px" });
const watchVideo = (v) => vio.observe(v);

// teaser: 1080 p on wide screens, 720 p otherwise
const teaser = $("#teaser");
teaser.dataset.src = innerWidth >= 1000 && !(navigator.connection && navigator.connection.saveData) ? "media/teaser_1080.mp4" : "media/teaser_720.mp4";
watchVideo(teaser);
$$(".turn video, .xsim video").forEach(watchVideo);
// posters of the videos below the fold load only when they are near the screen, so the hero poster gets the bandwidth first
const pio = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  pio.unobserve(e.target);
  e.target.dataset.near = "1";
  if (e.target.dataset.poster) e.target.poster = e.target.dataset.poster;
}), { rootMargin: "1000px" });
$$("video[data-poster]").forEach((v) => pio.observe(v));
const lazyPoster = (v, url) => { if (v.dataset.near) { v.poster = url; return; } if (url) { v.dataset.poster = url; pio.observe(v); } else { delete v.dataset.poster; v.removeAttribute("poster"); } };

// ---- sprites -------------------------------------------------------------------------------------------------------------------------
initSprites({ manifest: "assets/sprites/sprites.json" }).catch((e) => console.warn(e));

// ---- pipeline (starts when it scrolls into view) -----------------------------------------------------------------------------------
{
  const host = $("#pipe");
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    initPipeline(host, { sprites: "assets/sprites/sprites.json", spriteIds: ["s01", "s03", "s05"] }).catch((e) => console.warn(e));
  }, { threshold: 0.25 });
  io.observe(host);
}

// ---- lightbox + hand-off to the 3D browser -----------------------------------------------------------------------------------------
const lb = $("#lb");
$("#lbX").addEventListener("click", () => lb.close());
lb.addEventListener("click", (e) => { if (e.target === lb) lb.close(); });
lb.addEventListener("close", () => { const v = $("video", lb); if (v) v.pause(); $("#lbBody").innerHTML = ""; });
function open3d(id) {
  lb.close();
  load3d(id);
  $("#browser").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
}
function dl(rows) { return "<dl>" + rows.filter((r) => r[1] != null && r[1] !== "").map((r) => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join("") + "</dl>"; }
function showArm(a) {
  $("#lbBody").innerHTML = `<img src="media/gallery/${a.id}_1024.jpg" alt="${esc(a.name)} in the task scene">
    <div class="info"><h3>${esc(a.name)}</h3><div class="count">${esc(a.sub)}</div>
    ${dl([["Type", KIND[a.kind]], ["Degrees of freedom", a.dof], ["Gripper", a.grip], ["Based on", a.parent_name]])}
    <button type="button" class="btn" id="to3d">Open in the 3D browser</button></div>`;
  $("#to3d").addEventListener("click", () => open3d(a.id));
  lb.showModal();
}
function showClip(w, task) {
  $("#lbBody").innerHTML = `<video src="media/wall/${w.id}_${task}_tp3_1280.mp4" poster="media/wall/${w.id}_${task}_poster_640.jpg" autoplay muted loop playsinline controls></video>
    <div class="info"><h3>${esc(w.name)}</h3><div class="count">${esc(w.sub)}</div>
    ${dl([["Task", task === "t1" ? "Pick and place" : "Open drawer"], ["Type", KIND[w.kind]], ["Degrees of freedom", w.dof], ["Gripper", w.grip]])}
    <button type="button" class="btn" id="to3d">Open in the 3D browser</button></div>`;
  $("#to3d").addEventListener("click", () => open3d(w.id));
  lb.showModal();
}

// ---- 3D browser: a Cycles still first, the viewer (three.js + GLB) loads behind it and fades in when ready -----------------------------------
const box3d = $("#frame3d"), view3d = $("#viewer"), still3d = $("#still3dImg"), txt3d = $("#still3dTxt");
let started3d = false, poll3d = 0;
const hasGL = (() => { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; } })();
const slowNet = !!(navigator.connection && (navigator.connection.saveData || /(^|-)(2g|3g)$/.test(navigator.connection.effectiveType || "")));
function note3d(t, busy) { txt3d.textContent = t; $("#still3dPill").classList.toggle("idle", !busy); }
function load3d(id) {
  if (!hasGL) { note3d("This browser has no WebGL, so the 3D viewer cannot start.", false); return; }
  if (started3d && !id) return;
  started3d = true;
  clearInterval(poll3d);
  box3d.classList.remove("ready");
  if (id) { still3d.src = `media/gallery/${encodeURIComponent(id)}_1024.jpg`; still3d.alt = "The selected arm in the task scene"; }
  note3d("Loading the 3D viewer…", true);
  // still first: the viewer download starts only after the still is on screen (or after 2.5 s), so the two do not fight for a slow link
  let go = false;
  const start = () => {
    if (go) return; go = true;
    view3d.src = "arms/" + (id ? "?arm=" + encodeURIComponent(id) : "");
    const t0 = performance.now();
    poll3d = setInterval(() => {
      let ok = false;
      try { const v = view3d.contentWindow && view3d.contentWindow.__viewer; ok = !!(v && v.ready()); } catch (e) {}
      if (ok) { clearInterval(poll3d); box3d.classList.add("ready"); view3d.removeAttribute("tabindex"); }
      else if (performance.now() - t0 > 40000) { clearInterval(poll3d); note3d("The 3D viewer is slow to start. Click to try again, or open it on its own page below.", false); started3d = false; }
    }, 150);
  };
  if (still3d.complete && still3d.naturalWidth) start();
  else { still3d.addEventListener("load", start, { once: true }); still3d.addEventListener("error", start, { once: true }); setTimeout(start, 2500); }
}
$("#still3d").addEventListener("click", () => load3d());
if (slowNet) note3d("Tap to explore this arm in 3D", false);
else new IntersectionObserver((es, io) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load3d(); } }, { rootMargin: "400px" }).observe(box3d);
if (!hasGL) note3d("This browser has no WebGL, so the 3D viewer cannot start.", false);

// ---- gallery -----------------------------------------------------------------------------------------------------------------------
async function gallery() {
  const D = await (await fetch("data/gallery.json")).json();
  const byId = new Map(D.arms.map((a) => [a.id, a]));
  D.arms.forEach((a) => { a.parent_name = a.parent && byId.get(a.parent) ? byId.get(a.parent).name : a.parent ? a.parent : ""; });
  const sel = { kind: new Set(), dof: new Set() };
  const PAGE = 24;
  let shown = PAGE, list = D.arms;
  const grid = $("#galGrid"), more = $("#galMore"), count = $("#galCount");
  const render = () => {
    list = D.arms.filter((a) => (!sel.kind.size || sel.kind.has(a.kind)) && (!sel.dof.size || sel.dof.has(String(a.dof))));
    grid.innerHTML = list.slice(0, shown).map((a) =>
      `<button type="button" class="card" data-id="${a.id}"><img loading="lazy" width="512" height="512" src="media/gallery/${a.id}_512.jpg" alt="${esc(a.name)}"><div class="cap"><b>${esc(a.name)}</b><span>${esc(a.sub)} · ${a.dof} DoF</span></div></button>`).join("");
    count.textContent = `${list.length} of ${D.arms.length} arms`;
    more.parentElement.hidden = shown >= list.length;
  };
  grid.addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) showArm(byId.get(c.dataset.id)); });
  more.addEventListener("click", () => { shown += 48; render(); });
  $$("#galFilters .chipset").forEach((set) => set.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const s = sel[set.dataset.key];
    s.has(b.dataset.v) ? s.delete(b.dataset.v) : s.add(b.dataset.v);
    b.classList.toggle("on", s.has(b.dataset.v));
    shown = PAGE; render();
  }));
  render();
}

// ---- data wall -----------------------------------------------------------------------------------------------------------------------
async function wall() {
  const D = await (await fetch("data/wall.json")).json();
  const st = { task: "t1", cam: "tp3" };
  const grid = $("#wallGrid");
  const src = (w) => `media/wall/${w.id}_${st.task}_${st.cam === "tp3" ? "tp3_640" : "wrist_640"}.mp4`;
  const poster = (w) => `media/wall/${w.id}_${st.task}_poster_640.jpg`;
  grid.innerHTML = D.arms.map((w) =>
    `<button type="button" class="card" data-id="${w.id}"><video muted loop playsinline preload="none" aria-label="${esc(w.name)}"></video><div class="cap"><b>${esc(w.name)}</b><span class="tier t${w.tier}">${esc(w.label)}</span><span>${w.dof} DoF · ${esc(w.grip)}</span></div></button>`).join("");
  const cards = $$(".card", grid);
  const apply = () => cards.forEach((c, i) => {
    const w = D.arms[i], v = $("video", c);
    v.dataset.src = src(w);
    lazyPoster(v, st.cam === "tp3" ? poster(w) : "");
    if (v.src) { v.src = v.dataset.src; if (!reduce) v.play().catch(() => {}); }
  });
  apply();
  cards.forEach((c) => watchVideo($("video", c)));
  grid.addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) showClip(D.arms[cards.indexOf(c)], st.task); });
  const bind = (id, key) => $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", $(id)).forEach((x) => x.classList.toggle("on", x === b));
    st[key] = b.dataset.v; apply();
  });
  bind("#wallTask", "task"); bind("#wallCam", "cam");
}

// ---- cross-simulator tabs ---------------------------------------------------------------------------------------------------------------
async function sims() {
  const D = await (await fetch("data/xsim.json")).json();
  const v = $(".xsim video"), bar = $("#simTab"), cap = $("#simCap");
  const T = { A: "Tier A · real arm", B: "Tier B · variant", C: "Tier C · generated" };
  const tabs = D.tabs.filter((t) => t.task === "t1");
  const t2 = D.tabs.find((t) => t.task === "t2");
  bar.innerHTML = tabs.map((t) => `<button type="button" data-k="${t.key}"${t.default ? ' class="on"' : ""}>${T[t.tier]}</button>`).join("");
  const show = (t) => {
    const tier = T[t.tier];
    v.dataset.src = t.src; v.dataset.poster = t.poster; v.poster = t.poster;
    if (v.src) { v.src = t.src; if (!reduce) v.play().catch(() => {}); }
    v.setAttribute("aria-label", `Three-panel replay of ${t.arm_name} in MuJoCo, Isaac Sim and Genesis`);
    cap.innerHTML = `<b>${esc(t.arm_name)}</b> (${esc(tier)}, ${t.dof} DoF). Left to right: ${D.panels.map(esc).join(" · ")}. Each simulator runs its own physics and draws with its own renderer, so the looks differ.`;
  };
  show(tabs.find((t) => t.default) || tabs[0]);
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", bar).forEach((x) => x.classList.toggle("on", x === b));
    show(tabs.find((t) => t.key === b.dataset.k));
  });
}

gallery().catch((e) => { console.warn(e); $("#galGrid").textContent = "The gallery could not be loaded."; });
sims().catch((e) => console.warn(e));
wall().catch((e) => { console.warn(e); $("#wallGrid").textContent = "The data wall could not be loaded."; });
