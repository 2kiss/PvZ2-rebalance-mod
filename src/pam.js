// PopAnim player for canvas 2D. Plays the compact JSON written by
// tools/export_web_anims.py, drawing image parts from decoded atlases.

function mul(A, B) {
  // affine [a, b, c, d, tx, ty]: x' = a*x + c*y + tx, y' = b*x + d*y + ty
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

// Replays a timeline once and keeps the object list of every frame.
function bakeTimeline(sp) {
  const live = new Map();
  const states = new Array(sp.frames.length);
  sp.frames.forEach((f, k) => {
    if (f.r) for (const id of f.r) live.delete(id);
    if (f.a) for (const [id, isSprite, res, name] of f.a) {
      live.set(id, { id, isSprite: !!isSprite, res, name: name || '', m: [1, 0, 0, 1, 0, 0], alpha: 1, frame: -1, born: k });
    }
    if (f.c) for (const [id, a, b, c, d, tx, ty, alpha, frame] of f.c) {
      const o = live.get(id);
      if (!o) continue;
      const m = a === null ? o.m.slice(0, 4) : [a, b, c, d];
      live.set(id, { ...o, m: [m[0], m[1], m[2], m[3], tx, ty], alpha: alpha >= 0 ? alpha : o.alpha, frame: frame >= 0 ? frame : o.frame });
    }
    states[k] = [...live.values()].sort((x, y) => x.id - y.id);
  });
  return states;
}

export class PamDoc {
  constructor(doc) {
    this.fps = doc.fps;
    this.images = doc.images;
    this.labels = doc.labels;
    this.sprites = doc.sprites.map(s => ({ name: s.name, fps: s.fps, n: s.frames.length, states: bakeTimeline(s) }));
    this.main = { name: '', fps: doc.main.fps || doc.fps, n: doc.main.frames.length, states: bakeTimeline(doc.main) };
    this.commands = doc.main.frames.map(f => f.k || null);
    this.hasSamples = this.commands.some(c => c && c.some(x => x[0] === 'PlaySample'));
  }

  range(label) {
    return this.labels[label] || [0, this.main.n];
  }
}

export class PamPlayer {
  static sound = null;   // (eventName, player) => void, set by the app
  // sprites: (imageId) => {img, x, y, w, h} | null ; hide: (layerName) => bool
  constructor(doc, spriteLookup, hide = () => false) {
    this.doc = doc;
    this.lookup = spriteLookup;
    this.hide = hide;
    this.label = null;
    this.loop = true;
    this.t = 0;          // seconds into the current label
    this.speed = 1;
    this.done = false;
  }

  play(label, loop = true, restart = false) {
    if (!restart && this.label === label && this.loop === loop) return;
    this.label = label;
    this.loop = loop;
    this.t = 0;
    this.done = false;
  }

  has(label) { return !!this.doc.labels[label]; }

  update(dt) {
    if (this.done) return;
    const before = PamPlayer.sound && this.doc.hasSamples ? this.frame : -1;
    this.t += dt * this.speed;
    if (before >= 0) this.samples(before);
    const [s, e] = this.doc.range(this.label);
    const n = e - s;
    if (!this.loop && this.t * this.doc.fps >= n) {
      this.done = true;
      this.t = (n - 0.001) / this.doc.fps;
    }
  }

  // Fire PlaySample commands on frames crossed since `from` (sound effects authored in the animation).
  samples(from) {
    const to = this.frame;
    if (to === from) return;
    const [s, e] = this.doc.range(this.label);
    let f = from, guard = 0;
    while (f !== to && guard++ < 200) {
      f += 1;
      if (f >= e) f = s;
      const list = this.doc.commands[f];
      if (list) for (const [name, arg] of list) if (name === 'PlaySample') PamPlayer.sound(arg, this);
    }
  }

  get frame() {
    const [s, e] = this.doc.range(this.label);
    const n = Math.max(1, e - s);
    const k = Math.floor(this.t * this.doc.fps);
    return s + (this.loop ? k % n : Math.min(k, n - 1));
  }

  // Draw with the animation origin mapped through matrix M (an affine array).
  draw(ctx, M, alpha = 1) {
    this._drawSprite(ctx, this.doc.main, this.frame, M, alpha, this.doc.fps);
  }

  _drawSprite(ctx, sp, t, M, alpha, parentFps) {
    const objs = sp.states[t];
    if (!objs) return;
    for (const o of objs) {
      const a = alpha * o.alpha;
      if (a <= 0.003) continue;
      if (o.isSprite) {
        const child = this.doc.sprites[o.res];
        if (this.hide(o.name + '|' + child.name)) continue;
        let ft = o.frame >= 0 ? o.frame : Math.floor((t - o.born) * child.fps / parentFps);
        ft = ((ft % child.n) + child.n) % child.n;
        this._drawSprite(ctx, child, ft, mul(M, o.m), a, child.fps);
      } else {
        const im = this.doc.images[o.res];
        const spr = this.lookup(im[0]);
        if (!spr || !spr.img) continue;
        const IM = mul(mul(M, o.m), [im[3], im[4], im[5], im[6], im[7], im[8]]);
        ctx.globalAlpha = a;
        ctx.setTransform(IM[0], IM[1], IM[2], IM[3], IM[4], IM[5]);
        ctx.drawImage(spr.img, spr.x, spr.y, spr.w, spr.h, 0, 0, im[1], im[2]);
      }
    }
  }
}
