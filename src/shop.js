// Night Carnival store screen: four rotating discounted premium plants, the full-price catalog,
// and extra seed slots. Coins only — nothing here costs real money.
import { roundRect } from './game.js';
import { btn, inRect } from './chooser.js';
import { currentDeals, PREMIUM, PRICE, SLOT_PRICES, tierOf } from './carnival.js';

export class Shop {
  constructor(app, opts = {}) {
    this.app = app;
    this.back = opts.back || null;
    this.tab = 'deals';
    this.players = new Map();
    this.flash = null;
    this.t = 0;
  }

  static assets(data) {
    return Object.values(PREMIUM).flat().map(id => data.plant(id)?.type.PopAnim).filter(Boolean);
  }

  owned() { return this.app.save.ownedPlants(this.app.data.worldmap.egypt); }

  player(id) {
    if (!this.players.has(id)) {
      const pl = this.app.assets.player(this.app.data.plant(id).type.PopAnim, n => /custom|plantfood|_armor_states|gatlingpea|water/.test(n));
      pl?.play(pl.has('idle') ? 'idle' : Object.keys(pl.doc.labels)[0]);
      this.players.set(id, pl);
    }
    return this.players.get(id);
  }

  layout(w, h) { this.screen = { w, h }; this.k = Math.max(0.75, Math.min(1.25, h / 420)); }

  items() {
    const owned = this.owned();
    if (this.tab === 'deals') return currentDeals(owned).deals.map(d => ({ ...d, owned: owned.includes(d.plant) }));
    return Object.values(PREMIUM).flat().map(p => ({ plant: p, tier: tierOf(p), pct: 0, old: PRICE[tierOf(p)], price: PRICE[tierOf(p)], owned: owned.includes(p) }));
  }

  geometry() {
    const { w, h } = this.screen, k = this.k;
    const items = this.items();
    const perRow = this.tab === 'deals' ? 4 : 6;
    const top = 58 * k, bottom = h - 62 * k;
    const rows = Math.ceil(items.length / perRow);
    const gap = 8 * k;
    const cw = (w - 20 - gap * (perRow - 1)) / perRow;
    const ch = (bottom - top - gap * (rows - 1)) / rows;
    const cards = items.map((it, i) => {
      const x = 10 + (i % perRow) * (cw + gap), y = top + Math.floor(i / perRow) * (ch + gap);
      return { ...it, x, y, w: cw, h: ch, buy: { x: x + cw * 0.12, y: y + ch - 34 * k, w: cw * 0.76, h: 28 * k } };
    });
    return {
      cards,
      back: { x: 10, y: h - 54 * k, w: 110 * k, h: 46 * k },
      tabDeals: { x: w / 2 - 170 * k, y: h - 54 * k, w: 160 * k, h: 46 * k },
      tabAll: { x: w / 2 + 10 * k, y: h - 54 * k, w: 160 * k, h: 46 * k },
      slot: { x: w - 190 * k, y: h - 54 * k, w: 180 * k, h: 46 * k },
    };
  }

  pointer(kind, sx, sy) { if (kind === 'down') this.tap(sx, sy); }

  tap(sx, sy) {
    const g = this.geometry();
    if (inRect(sx, sy, g.back)) { if (this.back) this.app.openChooser(this.back); else this.app.openScreen('map'); return; }
    if (inRect(sx, sy, g.tabDeals)) { this.tab = 'deals'; return; }
    if (inRect(sx, sy, g.tabAll)) { this.tab = 'all'; return; }
    if (inRect(sx, sy, g.slot)) {
      const save = this.app.save;
      const n = save.data.slots - 6;
      if (n < SLOT_PRICES.length && save.spend(SLOT_PRICES[n])) { save.data.slots += 1; save.write(); this.say('Seed slot added!'); }
      else if (n < SLOT_PRICES.length) this.say('Not enough coins — play levels to earn more');
      return;
    }
    for (const c of g.cards) if (inRect(sx, sy, c.buy) && !c.owned) {
      if (this.app.save.spend(c.price)) {
        this.app.save.data.bought.push(c.plant);
        this.app.save.write();
        this.say(this.app.data.plant(c.plant).name + ' is yours!');
      } else this.say('Not enough coins — play levels to earn more');
      return;
    }
  }

  say(text) { this.flash = { text, t: 2.2 }; }

  update(dt) {
    this.t += dt;
    for (const p of this.players.values()) p?.update(dt);
    if (this.flash && (this.flash.t -= dt) <= 0) this.flash = null;
  }

  draw(ctx) {
    const { w, h } = this.screen, k = this.k, A = this.app.assets;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#1b0b3a'); bg.addColorStop(1, '#3d1259');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    // String lights
    for (let i = 0; i < 26; i++) {
      const x = (i + 0.5) * w / 26, y = 8 + Math.sin(i * 0.9) * 3;
      ctx.fillStyle = ['#ffd34d', '#ff5fa2', '#5fe0ff', '#9dff5f'][i % 4];
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(this.t * 3 + i);
      ctx.beginPath(); ctx.arc(x, y, 3.2 * k, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd34d';
    ctx.font = `bold ${Math.round(24 * k)}px "Trebuchet MS", sans-serif`;
    ctx.fillText('NIGHT CARNIVAL', 12, 42 * k);
    ctx.font = `${Math.round(12 * k)}px sans-serif`;
    ctx.fillStyle = '#e8d6ff';
    const { endsAt } = currentDeals(this.owned());
    const left = Math.max(0, endsAt - Date.now());
    const hh = Math.floor(left / 3600000), mm = Math.floor(left % 3600000 / 60000);
    ctx.fillText(this.tab === 'deals' ? `Prices drop every 8 hours — new deals in ${hh}h ${mm}m` : 'Every premium plant at full price', 210 * k, 40 * k);
    ctx.textAlign = 'right';
    A.drawSprite(ctx, 'IMAGE_EFFECTS_COIN_GOLD_COIN_GOLD_59X59', w - 150 * k, 18 * k, 28 * k, 28 * k);
    ctx.fillStyle = '#ffe680';
    ctx.font = `bold ${Math.round(20 * k)}px "Trebuchet MS", sans-serif`;
    ctx.fillText(this.app.save.coins.toLocaleString('en-US'), w - 12, 40 * k);

    const g = this.geometry();
    for (const c of g.cards) this.card(ctx, c);
    btn(ctx, g.back, '◀ BACK', false, k);
    btn(ctx, g.tabDeals, 'TODAY\'S DEALS', this.tab === 'deals', k);
    btn(ctx, g.tabAll, 'ALL PLANTS', this.tab === 'all', k);
    const n = this.app.save.data.slots - 6;
    btn(ctx, g.slot, n < SLOT_PRICES.length ? `+1 SLOT  ${SLOT_PRICES[n] / 1000}k` : 'SLOTS MAXED', n < SLOT_PRICES.length, k);
    if (this.flash) {
      ctx.globalAlpha = Math.min(1, this.flash.t * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      roundRect(ctx, w / 2 - 200 * k, h / 2 - 26 * k, 400 * k, 52 * k, 14); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(17 * k)}px "Trebuchet MS", sans-serif`;
      ctx.fillText(this.flash.text, w / 2, h / 2 + 6 * k);
      ctx.globalAlpha = 1;
    }
  }

  card(ctx, c) {
    const k = this.k, A = this.app.assets;
    const d = this.app.data.plant(c.plant);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createLinearGradient(0, c.y, 0, c.y + c.h);
    g.addColorStop(0, c.tier === 'rare' ? '#5a2a8a' : '#2f3f8a'); g.addColorStop(1, '#170a2c');
    ctx.fillStyle = g;
    roundRect(ctx, c.x, c.y, c.w, c.h, 12 * k); ctx.fill();
    ctx.strokeStyle = c.pct ? '#ffd34d' : 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2 * k; ctx.stroke();
    // Plant on its own little stage
    const pl = this.player(c.plant);
    const art = d.props.ArtCenter || { x: 99, y: 115 };
    const sc = Math.min(c.w / 130, (c.h - 90 * k) / 120) * 0.5;
    const footY = c.y + c.h - 78 * k;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(c.x + c.w / 2, footY, 30 * sc * 2, 8 * sc * 2, 0, 0, 7); ctx.fill();
    if (pl) pl.draw(ctx, [sc, 0, 0, sc, c.x + c.w / 2 - art.x * sc * 2, footY - art.y * sc * 2]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(Math.min(14 * k, c.w / 9))}px "Trebuchet MS", sans-serif`;
    ctx.fillText(d.name, c.x + c.w / 2, c.y + c.h - 60 * k);
    if (c.pct) {
      ctx.fillStyle = '#ff3d6e';
      roundRect(ctx, c.x + c.w - 52 * k, c.y + 6 * k, 46 * k, 24 * k, 8 * k); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(13 * k)}px sans-serif`;
      ctx.fillText(`-${c.pct}%`, c.x + c.w - 29 * k, c.y + 23 * k);
      // old price, struck through
      ctx.fillStyle = '#c9b7e6'; ctx.font = `${Math.round(12 * k)}px sans-serif`;
      const ot = c.old.toLocaleString('en-US');
      const ox = c.x + c.w / 2, oy = c.y + c.h - 42 * k;
      ctx.fillText(ot, ox, oy);
      const tw = ctx.measureText(ot).width;
      ctx.strokeStyle = '#ff3d6e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ox - tw / 2 - 2, oy - 4 * k); ctx.lineTo(ox + tw / 2 + 2, oy - 4 * k); ctx.stroke();
    }
    const b = c.buy;
    if (c.owned) {
      ctx.fillStyle = 'rgba(120,255,140,0.9)'; ctx.font = `bold ${Math.round(14 * k)}px sans-serif`;
      ctx.fillText('✔ OWNED', b.x + b.w / 2, b.y + b.h * 0.7);
    } else {
      const can = this.app.save.coins >= c.price;
      const bg = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      bg.addColorStop(0, can ? '#ffd34d' : '#8a7a5a'); bg.addColorStop(1, can ? '#d18a12' : '#5a4a2a');
      ctx.fillStyle = bg; roundRect(ctx, b.x, b.y, b.w, b.h, 9 * k); ctx.fill();
      A.drawSprite(ctx, 'IMAGE_EFFECTS_COIN_GOLD_COIN_GOLD_59X59', b.x + 6 * k, b.y + 4 * k, b.h - 8 * k, b.h - 8 * k);
      ctx.fillStyle = '#3a2208'; ctx.font = `bold ${Math.round(14 * k)}px "Trebuchet MS", sans-serif`;
      ctx.fillText(c.price.toLocaleString('en-US'), b.x + b.w / 2 + 8 * k, b.y + b.h * 0.7);
    }
  }
}
