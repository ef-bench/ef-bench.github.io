// Pixel sprites: crisp at integer device-pixel scale, pop in one by one, animate only while visible,
// hold a still frame for prefers-reduced-motion. No dependencies. Own implementation (technique only).
//
// <canvas class="sprite" data-sprite="panda" data-size="128"></canvas>
// initSprites({ manifest: "assets/sprites/sprites.json", root: document })
//
// sprites.json: { "frame": 64, "fps": 12, "sprites": { "panda": { "sheet": "panda.png", "frames": 24, "pingpong": true, "still": 12 } } }

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("sprite sheet failed: " + src));
    im.src = src;
  });
}

// CSS size so that one sprite pixel is a whole number of device pixels.
export function crispCssSize(frame, wantCss) {
  const dpr = window.devicePixelRatio || 1;
  const k = Math.max(1, Math.round((wantCss * dpr) / frame));
  return (frame * k) / dpr;
}

class Sprite {
  constructor(canvas, img, meta, frame, fps) {
    this.c = canvas;
    this.img = img;
    this.n = meta.frames;
    this.frame = frame;
    this.fps = meta.fps || fps;
    this.pp = meta.pingpong !== false;
    this.still = meta.still ?? 0;
    this.t = Math.random() * 3; // desynchronise neighbours
    this.visible = false;
    this.shown = false;
    canvas.width = frame;
    canvas.height = frame;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.last = -1;
    this.fit();
    this.draw(this.still);
  }
  fit() {
    const k = innerWidth < 640 ? 0.62 : 1; // phones: smaller sprites, same crisp integer scaling
    const want = parseFloat(this.c.dataset.size || "128") * k;
    const css = crispCssSize(this.frame, want);
    this.c.style.width = css + "px";
    this.c.style.height = css + "px";
  }
  index(t) {
    const k = Math.floor(t * this.fps);
    if (!this.pp) return k % this.n;
    const L = 2 * this.n - 2;
    const m = k % L;
    return m < this.n ? m : L - m;
  }
  draw(i) {
    if (i === this.last) return;
    this.last = i;
    this.ctx.clearRect(0, 0, this.frame, this.frame);
    this.ctx.drawImage(this.img, i * this.frame, 0, this.frame, this.frame, 0, 0, this.frame, this.frame);
  }
}

export async function initSprites({ manifest = "assets/sprites/sprites.json", root = document, popDelay = 140 } = {}) {
  const base = new URL(manifest, document.baseURI);
  const man = await (await fetch(base)).json();
  const sheets = new Map();
  const list = [];
  for (const c of root.querySelectorAll("canvas.sprite[data-sprite]")) {
    const id = c.dataset.sprite;
    const meta = man.sprites[id];
    if (!meta) continue;
    if (!sheets.has(id)) sheets.set(id, loadImage(new URL(meta.sheet, base).href));
    try {
      const img = await sheets.get(id);
      list.push(new Sprite(c, img, meta, man.frame, man.fps));
    } catch (e) {
      console.warn(e);
    }
  }
  const still = reduce();
  // pop in one by one when the group scrolls into view; animate only while visible
  const io = new IntersectionObserver(
    (es) => {
      for (const e of es) {
        const s = list.find((x) => x.c === e.target);
        if (!s) continue;
        s.visible = e.isIntersecting;
        if (e.isIntersecting && !s.shown) {
          s.shown = true;
          const order = list.indexOf(s);
          setTimeout(() => s.c.classList.add("pop"), still ? 0 : order * popDelay);
        }
      }
    },
    { threshold: 0.15 }
  );
  list.forEach((s) => io.observe(s.c));
  if (still) {
    list.forEach((s) => s.draw(s.still));
    return list;
  }
  let prev = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    for (const s of list) {
      if (!s.visible || !s.shown) continue;
      s.t += dt;
      s.draw(s.index(s.t));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  addEventListener("resize", () => list.forEach((s) => s.fit()));
  document.addEventListener("visibilitychange", () => (prev = performance.now()));
  return list;
}
