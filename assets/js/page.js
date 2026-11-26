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
  const f = $("#viewer");
  f.src = "arms/?arm=" + encodeURIComponent(id);
  lb.close();
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

// ---- 3D browser iframe loads when near ---------------------------------------------------------------------------------------------
{
  const f = $("#viewer");
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { if (!f.src) f.src = f.dataset.src; io.disconnect(); } }, { rootMargin: "400px" });
  io.observe(f);
}

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
    `<button type="button" class="card" data-id="${w.id}"><video muted loop playsinline preload="none" aria-label="${esc(w.name)}"></video><div class="cap"><b>${esc(w.name)}</b><span>${esc(w.sub)} · ${w.dof} DoF</span></div></button>`).join("");
  const cards = $$(".card", grid);
  const apply = () => cards.forEach((c, i) => {
    const w = D.arms[i], v = $("video", c);
    v.dataset.src = src(w);
    v.poster = st.cam === "tp3" ? poster(w) : "";
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

gallery().catch((e) => { console.warn(e); $("#galGrid").textContent = "The gallery could not be loaded."; });
wall().catch((e) => { console.warn(e); $("#wallGrid").textContent = "The data wall could not be loaded."; });
