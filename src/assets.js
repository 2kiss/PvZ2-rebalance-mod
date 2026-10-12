// Loads sprites.json, atlas images and PopAnim documents (all from web/assets).
import { PamDoc, PamPlayer } from './pam.js';

export class Assets {
  constructor(base = 'assets/') {
    this.base = base;
    this.sprites = {};
    this.images = new Map();   // atlas path -> HTMLImageElement
    this.docs = new Map();     // popanim id -> PamDoc
    this.pending = new Map();
  }

  async init() {
    this.sprites = await (await fetch(this.base + 'sprites.json')).json();
  }

  image(path) {
    let img = this.images.get(path);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = this.base + path;
      this.images.set(path, img);
    }
    return img;
  }

  // Sprite lookup used by the PopAnim player: {img, x, y, w, h}
  sprite(id) {
    const s = this.sprites[id];
    if (!s) return null;
    if (!s._img) s._img = this.image(s.atlas);
    return { img: s._img, x: s.x, y: s.y, w: s.w, h: s.h };
  }

  async loadAnim(id) {
    if (this.docs.has(id)) return this.docs.get(id);
    if (!this.pending.has(id)) {
      this.pending.set(id, (async () => {
        const res = await fetch(this.base + 'anims/' + id + '.json');
        if (!res.ok) throw new Error('missing animation ' + id);
        const doc = new PamDoc(await res.json());
        // Touch every image so its atlas starts loading.
        for (const im of doc.images) this.sprite(im[0]);
        this.docs.set(id, doc);
        return doc;
      })());
    }
    return this.pending.get(id);
  }

  doc(id) { return this.docs.get(id) || null; }

  player(id, hide) {
    const doc = this.doc(id);
    return doc ? new PamPlayer(doc, sid => this.sprite(sid), hide) : null;
  }

  // Loads animations and the atlases they (and extraSprites) use; onProgress(done, total).
  async preload(animIds, extraSprites = [], onProgress = null) {
    let done = 0;
    const total = animIds.length + 1;
    const tick = () => onProgress && onProgress(++done, total + this.pendingImages().length);
    await Promise.all(animIds.map(id => this.loadAnim(id).catch(e => console.warn(e.message)).finally(tick)));
    for (const s of extraSprites) this.sprite(s);
    const imgs = this.pendingImages();
    const all = done + imgs.length;
    await Promise.all(imgs.map(img => img.decode().catch(() => {}).finally(() => onProgress && onProgress(++done, all))));
  }

  // iOS keeps every decoded atlas in memory; drop the ones the current screen doesn't use.
  // They come back from the service-worker cache if needed again.
  trim(animIds, spriteIds = []) {
    const keep = new Set();
    for (const id of animIds) for (const im of this.docs.get(id)?.images || []) { const s = this.sprites[im[0]]; if (s) keep.add(s.atlas); }
    for (const id of spriteIds) { const s = this.sprites[id]; if (s) keep.add(s.atlas); }
    for (const [path, img] of this.images) if (!keep.has(path)) { img.src = ''; this.images.delete(path); }
    for (const s of Object.values(this.sprites)) if (s._img && !keep.has(s.atlas)) s._img = null;
  }

  pendingImages() { return [...this.images.values()].filter(img => !img.complete); }

  // Starts loading without waiting (things the next screens will want).
  prefetch(animIds, extraSprites = []) {
    for (const id of animIds) this.loadAnim(id).catch(() => {});
    for (const s of extraSprites) this.sprite(s);
  }

  // Draw one sprite with its top-left at (x, y), size (w, h) in the current transform.
  drawSprite(ctx, id, x, y, w, h) {
    const s = this.sprite(id);
    if (!s || !s.img.complete) return false;
    ctx.drawImage(s.img, s.x, s.y, s.w, s.h, x, y, w ?? s.w, h ?? s.h);
    return true;
  }
}
