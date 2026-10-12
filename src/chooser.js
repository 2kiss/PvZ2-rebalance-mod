// Seed chooser shown before a level: pick plants for the seed bank, honouring the level's
// SeedBankProperties (preset plants, exclude lists, no sun producers).
import { roundRect } from './game.js';
import { isPremium } from './carnival.js';

export class SeedChooser {
  constructor(app, levelName) {
    this.app = app;
    this.levelName = levelName;
    this.level = app.data.level(levelName);
    const sb = (this.level.def.Modules || []).map(r => app.data.resolve(r, this.level.local)).find(o => o?.objclass === 'SeedBankProperties') || {};
    this.bank = sb;
    const exclude = new Set(sb.PlantExcludeList || []);
    const noSun = sb.ExcludeListSunProducers === true || sb.ExcludeListSunProducers === 'true';
    this.presets = (sb.PresetPlantList || []).map(p => p.PlantType).filter(id => app.data.plant(id) && app.assets.sprite('IMAGE_UI_PACKETS_' + id.toUpperCase()));
    const owned = app.save.ownedPlants(app.data.worldmap.egypt);
    this.allowed = id => !exclude.has(id) && !(noSun && app.data.plant(id)?.props.Actions?.some(a => a.Type === 'sun'));
    // Owned plants first, then premium plants still to buy (shown locked, they open the carnival).
    const all = [...owned, ...Object.keys(app.data.sheets.PlantTypes).filter(id => isPremium(id) && !owned.includes(id))];
    this.cards = [...new Set(all)].filter(id => app.data.plant(id) && app.assets.sprite('IMAGE_UI_PACKETS_' + id.toUpperCase()))
      .map(id => ({ id, owned: owned.includes(id), allowed: this.allowed(id) }));
    this.slots = Math.max(app.save.data.slots, this.presets.length);
    this.fixed = sb.SelectionMethod === 'preset';
    this.picked = [...this.presets];
    if (!this.fixed) for (const id of app.save.data.lastSeeds || []) {
      if (this.picked.length < this.slots && !this.picked.includes(id) && this.cards.some(c => c.id === id && c.owned && c.allowed)) this.picked.push(id);
    }
    this.scroll = 0;
    this.drag = null;
  }

  layout(w, h) { this.screen = { w, h }; this.k = Math.max(0.75, Math.min(1.25, h / 420)); }

  geometry() {
    const { w, h } = this.screen, k = this.k;
    const ph = Math.min(52 * k, (h - 70 * k) / this.slots - 4);
    const pw = ph * 238 / 150;
    const bank = this.picked.map((id, i) => ({ id, x: 10, y: 54 * k + i * (ph + 4), w: pw, h: ph }));
    const empty = [];
    for (let i = this.picked.length; i < this.slots; i++) empty.push({ x: 10, y: 54 * k + i * (ph + 4), w: pw, h: ph });
    const gx = pw + 34, gw = w - gx - 10;
    const cw = 78 * k, ch = cw * 150 / 238 * 1.25;
    const cols = Math.max(3, Math.floor(gw / (cw + 8)));
    const grid = this.cards.map((c, i) => ({ ...c, x: gx + (i % cols) * (cw + 8), y: 54 * k + Math.floor(i / cols) * (ch + 8) - this.scroll, w: cw, h: cw * 150 / 238 }));
    return {
      bank, empty, grid, gx,
      go: { x: w - 170 * k, y: h - 56 * k, w: 160 * k, h: 48 * k },
      back: { x: gx, y: h - 56 * k, w: 110 * k, h: 48 * k },
      contentH: Math.ceil(this.cards.length / cols) * (ch + 8),
    };
  }

  pointer(kind, sx, sy) {
    if (kind === 'down') { this.drag = { sy, scroll: this.scroll, moved: 0 }; return; }
    if (kind === 'move' && this.drag) {
      this.drag.moved = Math.max(this.drag.moved, Math.abs(sy - this.drag.sy));
      const g = this.geometry();
      this.scroll = Math.max(0, Math.min(Math.max(0, g.contentH - (this.screen.h - 130 * this.k)), this.drag.scroll - (sy - this.drag.sy)));
      return;
    }
    if (kind === 'up' && this.drag) { const moved = this.drag.moved; this.drag = null; if (moved < 8) this.tap(sx, sy); }
  }

  tap(sx, sy) {
    const g = this.geometry();
    if (inRect(sx, sy, g.go)) { if (this.picked.length) this.start(); return; }
    if (inRect(sx, sy, g.back)) { this.app.openScreen('map'); return; }
    if (this.fixed) return;
    for (const r of g.bank) if (inRect(sx, sy, r)) {
      if (this.presets.includes(r.id)) return;
      this.picked = this.picked.filter(p => p !== r.id);
      return;
    }
    for (const c of g.grid) if (inRect(sx, sy, c)) {
      if (!c.owned) { this.app.openScreen('shop', { back: this.levelName }); return; }
      if (!c.allowed || this.picked.includes(c.id) || this.picked.length >= this.slots) return;
      this.picked.push(c.id);
      return;
    }
  }

  start() {
    this.app.save.data.lastSeeds = this.picked.filter(id => !this.presets.includes(id));
    this.app.save.write();
    this.app.startLevel(this.levelName, this.picked);
  }

  update() {}

  draw(ctx) {
    const { w, h } = this.screen, k = this.k, A = this.app.assets;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = A.sprite('IMAGE_BACKGROUNDS_EGYPT_TEXTURE');
    if (bg && bg.img.complete) ctx.drawImage(bg.img, bg.x, bg.y, bg.w, bg.h, 0, 0, w, w * bg.h / bg.w);
    ctx.fillStyle = 'rgba(30,18,6,0.55)'; ctx.fillRect(0, 0, w, h);
    const g = this.geometry();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffe9a8';
    ctx.font = `bold ${Math.round(20 * k)}px "Trebuchet MS", sans-serif`;
    const def = this.level.def;
    ctx.fillText(`Ancient Egypt — Day ${def.LevelNumber}`, 12, 34 * k);
    ctx.font = `${Math.round(13 * k)}px sans-serif`;
    ctx.fillStyle = '#f3dcae';
    ctx.textAlign = 'right';
    ctx.fillText(this.fixed ? 'This level gives you a fixed set of plants.' : `Choose up to ${this.slots} plants`, w - 14, 34 * k);

    ctx.fillStyle = 'rgba(40,24,8,0.75)';
    roundRect(ctx, 4, 48 * k, g.bank[0]?.w + 12 || 120, h - 54 * k, 10); ctx.fill();
    for (const r of g.empty) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; roundRect(ctx, r.x, r.y, r.w, r.h, 6); ctx.fill(); }
    for (const r of g.bank) this.packet(ctx, r.id, r, true, false);

    ctx.save();
    ctx.beginPath(); ctx.rect(g.gx - 4, 46 * k, w - g.gx, h - 110 * k); ctx.clip();
    for (const c of g.grid) {
      const dim = this.picked.includes(c.id) || !c.allowed;
      this.packet(ctx, c.id, c, c.owned, dim);
      if (!c.owned) {
        ctx.fillStyle = 'rgba(30,0,50,0.55)'; roundRect(ctx, c.x, c.y, c.w, c.h, 6); ctx.fill();
        ctx.fillStyle = '#ffd34d'; ctx.textAlign = 'center';
        ctx.font = `bold ${Math.round(10 * k)}px sans-serif`;
        ctx.fillText('🎪 CARNIVAL', c.x + c.w / 2, c.y + c.h / 2 + 4 * k);
      }
    }
    ctx.restore();
    btn(ctx, g.back, '◀ MAP', false, k);
    btn(ctx, g.go, "LET'S ROCK!", this.picked.length > 0, k);
  }

  packet(ctx, id, r, colored, dim) {
    const A = this.app.assets;
    const d = this.app.data.plant(id);
    const premium = isPremium(id);
    A.drawSprite(ctx, premium ? 'IMAGE_UI_PACKETS_READY_PREMIUM' : 'IMAGE_UI_PACKETS_READY', r.x, r.y, r.w, r.h);
    const spr = A.sprite('IMAGE_UI_PACKETS_' + id.toUpperCase());
    if (spr && spr.img.complete) {
      const sc = Math.min((r.h * 0.94) / spr.h, (r.w * 0.66) / spr.w);
      ctx.drawImage(spr.img, spr.x, spr.y, spr.w, spr.h, r.x + r.w * 0.05, r.y + r.h - spr.h * sc - r.h * 0.04, spr.w * sc, spr.h * sc);
    }
    const tw = r.w * 101 / 238, th = r.h * 71 / 150, tx = r.x + r.w - tw - r.w * 0.03, ty = r.y + r.h - th - r.h * 0.04;
    A.drawSprite(ctx, premium ? 'IMAGE_UI_PACKETS_PRICE_TAB_PREMIUM' : 'IMAGE_UI_PACKETS_PRICE_TAB', tx, ty, tw, th);
    ctx.fillStyle = '#3a2508'; ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(th * 0.62)}px "Trebuchet MS", sans-serif`;
    ctx.fillText(String(d.props.Cost ?? 100), tx + tw / 2, ty + th * 0.72);
    if (dim || !colored) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(ctx, r.x, r.y, r.w, r.h, 6); ctx.fill(); }
  }
}

export function btn(ctx, r, label, on, k) {
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  g.addColorStop(0, on ? '#8bd34a' : '#8a6a3a'); g.addColorStop(1, on ? '#3f8a18' : '#4d3518');
  ctx.fillStyle = g;
  roundRect(ctx, r.x, r.y, r.w, r.h, 12 * k); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.font = `bold ${Math.round(r.h * 0.4)}px "Trebuchet MS", sans-serif`;
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h * 0.64);
}

export function inRect(x, y, r) { return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
