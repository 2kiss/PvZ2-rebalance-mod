// Egypt world map, laid out from the game's WORLDMAPDATA (map pieces + level/reward events).
// Drag to scroll; tap a level node to play it.
import { roundRect } from './game.js';
import { offline } from './offline.js';

const NODE_ANIM = {
  normal: 'POPANIM_WORLDMAP_LEVEL_NODE',
  minigame: 'POPANIM_WORLDMAP_LEVEL_NODE_MINIGAME',
  miniboss: 'POPANIM_WORLDMAP_LEVEL_NODE_GARGANTUAR',
  boss: 'POPANIM_WORLDMAP_ZOMBOSS_NODE_EGYPT',
};
const PIECE_ANIM_BASE = 100;
// Where each node animation's pad sits inside its PopAnim canvas (map units), measured from the art.
const NODE_CENTER = { normal: [97, 98], minigame: [97, 97], miniboss: [97, 98], boss: [86, 106], gift: [99, 80] };   // m_imageID 100.. are POPANIM_WORLDMAP_EGYPT_ANIM1..

export function mapAssets(map) {
  const anims = new Set([...Object.values(NODE_ANIM), 'POPANIM_WORLDMAP_GIFTBOX_WORLD_MAP']);
  const images = [];
  for (const p of [...map.m_mapPieces, ...map.m_eventList]) {
    if (p.m_imageID == null) continue;
    if (p.m_imageID >= PIECE_ANIM_BASE) anims.add('POPANIM_WORLDMAP_EGYPT_ANIM' + (p.m_imageID - PIECE_ANIM_BASE + 1));
    else images.push('IMAGE_WORLDMAP_EGYPT_ISLAND' + p.m_imageID);
  }
  return { anims: [...anims], images };
}

export class WorldMap {
  constructor(app) {
    this.app = app;
    this.assets = app.assets;
    this.map = app.data.worldmap.egypt;
    this.rect = this.map.m_boundingRect;
    this.events = this.map.m_eventList;
    this.byName = new Map(this.events.filter(e => e.m_name).map(e => [e.m_name, e]));
    this.pieces = this.map.m_mapPieces.map((p, i) => ({ ...p, i, player: this.pieceAnim(p) }))
      .sort((a, b) => (a.m_drawLayer || 0) - (b.m_drawLayer || 0) || a.i - b.i);
    this.nodes = this.events.filter(e => e.m_eventType === 'level' && app.data.levels[e.m_dataString]).map(e => ({ e, player: this.assets.player(NODE_ANIM[e.m_levelNodeType] || NODE_ANIM.normal, n => this.hideNode(n)) }));
    this.rewards = this.events.filter(e => ['plant', 'pinata', 'upgrade'].includes(e.m_eventType));
    this.doodads = this.events.filter(e => e.m_eventType === 'doodad').map(e => ({ ...e, player: this.pieceAnim(e) }));
    this.t = 0;
    this.drag = null;
    this.vx = 0;
    const next = this.nextLevel();
    this.focus = next ? next.m_position : { x: 0, y: 300 };
    this.cx = null;
  }

  pieceAnim(p) {
    if (p.m_imageID == null || p.m_imageID < PIECE_ANIM_BASE) return null;
    const pl = this.assets.player('POPANIM_WORLDMAP_EGYPT_ANIM' + (p.m_imageID - PIECE_ANIM_BASE + 1), () => false);
    if (pl) { pl.play(Object.keys(pl.doc.labels)[0]); pl.t = Math.random() * 3; }
    return pl;
  }

  hideNode(name) { return /glow|rays|particle|sparkle|flash_column/.test(name); }

  // ---------------------------------------------------------------- progression

  status(e) {
    const save = this.app.save;
    if (save.done[e.m_dataString]) return 'finished';
    return this.unlocked(e) ? 'unlocked' : 'locked';
  }

  unlocked(e) {
    if (!e.m_parentEvent) return true;
    const p = this.byName.get(e.m_parentEvent);
    if (!p) return true;
    if (p.m_eventType === 'level') return !!this.app.save.done[p.m_dataString];
    return this.unlocked(p) && (p.m_eventType !== 'level');
  }

  rewardUnlocked(e) {
    const p = this.byName.get(e.m_parentEvent);
    return !p || (p.m_eventType === 'level' ? !!this.app.save.done[p.m_dataString] : this.rewardUnlocked(p));
  }

  nextLevel() {
    const lv = this.events.filter(e => e.m_eventType === 'level').sort((a, b) => +a.m_displayText - +b.m_displayText);
    return lv.find(e => this.status(e) === 'unlocked') || lv[lv.length - 1];
  }

  // ---------------------------------------------------------------- layout & input

  layout(w, h) {
    this.screen = { w, h };
    this.s = h / 600;
    if (this.cx == null) { this.cx = this.focus.x - w / 2 / this.s; this.cy = this.focus.y - h * 0.55 / this.s; }
    this.clamp();
  }

  clamp() {
    const { w, h } = this.screen;
    const r = this.rect;
    this.cx = Math.max(r.mX, Math.min(r.mX + r.mWidth - w / this.s, this.cx));
    this.cy = Math.max(r.mY, Math.min(r.mY + r.mHeight - h / this.s, this.cy));
  }

  toGame(sx, sy) { return { x: this.cx + sx / this.s, y: this.cy + sy / this.s }; }

  pointer(kind, sx, sy) {
    if (kind === 'down') { this.drag = { sx, sy, cx: this.cx, cy: this.cy, moved: 0, t: performance.now(), lx: sx }; this.vx = 0; return; }
    if (!this.drag) return;
    if (kind === 'move') {
      const d = this.drag;
      d.moved = Math.max(d.moved, Math.hypot(sx - d.sx, sy - d.sy));
      this.cx = d.cx - (sx - d.sx) / this.s;
      this.cy = d.cy - (sy - d.sy) / this.s;
      const now = performance.now();
      this.vx = (d.lx - sx) / this.s / Math.max(1, now - d.t) * 1000;
      d.t = now; d.lx = sx;
      this.clamp();
      return;
    }
    if (kind === 'up') {
      const d = this.drag;
      this.drag = null;
      if (d.moved < 10) { this.vx = 0; this.tap(sx, sy); }
    }
  }

  tap(sx, sy) {
    const b = this.buttons();
    if (inRect(sx, sy, b.mute)) { this.app.audio.toggleMute(); return; }
    if (inRect(sx, sy, b.shop)) { this.app.audio.play('play_ui_button_click_release'); this.app.openScreen('shop'); return; }
    const g = this.toGame(sx, sy);
    for (const n of this.nodes) {
      const p = n.e.m_position;
      if (Math.hypot(g.x - p.x, g.y - p.y) < 60 && this.status(n.e) !== 'locked') { this.app.openChooser(n.e.m_dataString); return; }
    }
  }

  buttons() {
    const { w, h } = this.screen;
    const k = Math.max(0.75, Math.min(1.2, h / 420));
    return {
      shop: { x: w - 172 * k, y: h - 62 * k, w: 162 * k, h: 52 * k },
      mute: { x: w - 54 * k, y: 8, w: 46 * k, h: 40 * k },
    };
  }

  update(dt) {
    this.t += dt;
    if (!this.drag && Math.abs(this.vx) > 5) { this.cx += this.vx * dt; this.vx *= Math.pow(0.04, dt); this.clamp(); }
    for (const p of this.pieces) p.player?.update(dt);
    for (const d of this.doodads) d.player?.update(dt);
    for (const n of this.nodes) {
      const st = this.status(n.e);
      const label = n.e.m_levelNodeType === 'boss' ? (st === 'finished' ? 'defeated' : 'active') : st === 'locked' ? 'locked_idle' : st;
      if (n.player) { n.player.play(label, true); n.player.update(dt); }
    }
  }

  // ---------------------------------------------------------------- drawing

  draw(ctx) {
    const { w, h } = this.screen;
    const s = this.s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#d9b26a';
    ctx.fillRect(0, 0, w, h);
    const X = x => (x - this.cx) * s, Y = y => (y - this.cy) * s;
    for (const p of this.pieces) this.drawPiece(ctx, p, X, Y);
    for (const d of this.doodads) this.drawPiece(ctx, d, X, Y);
    this.drawPaths(ctx, X, Y);
    for (const r of this.rewards) this.drawReward(ctx, r, X, Y);
    for (const n of this.nodes) this.drawNode(ctx, n, X, Y);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawHud(ctx);
  }

  drawPiece(ctx, p, X, Y) {
    const pos = p.m_position;
    const sx = (p.m_scaleX ?? 1) * this.s, sy = (p.m_scaleY ?? 1) * this.s;
    const flip = p.m_isArtFlipped === true || p.m_isArtFlipped === 'true';
    const rot = ((p.m_rotationAngle || 0) + (p.m_rotationRate || 0) * this.t) * Math.PI / 180;
    const c = Math.cos(rot), sn = Math.sin(rot);
    const fx = flip ? -1 : 1;
    const M = [c * sx * fx, sn * sx * fx, -sn * sy, c * sy, X(pos.x), Y(pos.y)];
    if (p.player) { p.player.draw(ctx, [M[0] * 0.5, M[1] * 0.5, M[2] * 0.5, M[3] * 0.5, M[4], M[5]]); return; }
    const spr = this.assets.sprite('IMAGE_WORLDMAP_EGYPT_ISLAND' + p.m_imageID);
    if (!spr || !spr.img.complete) return;
    const vw = M[4], vh = M[5];
    if (vw < -2000 * this.s || vw > this.screen.w + 400 * this.s) return;
    void vh;
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.drawImage(spr.img, spr.x, spr.y, spr.w, spr.h, 0, 0, spr.w / 2, spr.h / 2);
  }

  drawPaths(ctx, X, Y) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const e of this.events) {
      if (!e.m_parentEvent || !['level', 'plant', 'pinata', 'upgrade'].includes(e.m_eventType)) continue;
      const p = this.byName.get(e.m_parentEvent);
      if (!p || (e.m_eventType === 'level' && !this.app.data.levels[e.m_dataString])) continue;
      const open = e.m_eventType === 'level' ? this.status(e) !== 'locked' : this.rewardUnlocked(e);
      const a = p.m_position, b = e.m_position;
      const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(2, Math.floor(d / 34));
      for (let i = 1; i < n; i++) {
        const k = i / n;
        ctx.fillStyle = open ? 'rgba(255,236,150,0.95)' : 'rgba(90,60,30,0.45)';
        ctx.beginPath();
        ctx.arc(X(a.x + (b.x - a.x) * k), Y(a.y + (b.y - a.y) * k), 5 * this.s, 0, 7);
        ctx.fill();
      }
    }
  }

  drawNode(ctx, n, X, Y) {
    const p = n.e.m_position;
    const [ox, oy] = NODE_CENTER[n.e.m_levelNodeType] || NODE_CENTER.normal;
    if (n.player) n.player.draw(ctx, [this.s * 0.5, 0, 0, this.s * 0.5, X(p.x - ox), Y(p.y - oy)]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (n.e.m_levelNodeType !== 'boss') {
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(30 * this.s)}px "Trebuchet MS", sans-serif`;
      ctx.lineWidth = 5 * this.s;
      ctx.strokeStyle = '#3a2208';
      ctx.fillStyle = this.status(n.e) === 'locked' ? '#bbb' : '#fff3c0';
      ctx.strokeText(n.e.m_displayText, X(p.x), Y(p.y - 26));
      ctx.fillText(n.e.m_displayText, X(p.x), Y(p.y - 26));
    }
  }

  drawReward(ctx, e, X, Y) {
    const p = e.m_position;
    const got = this.rewardUnlocked(e);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = got ? 1 : 0.55;
    if (e.m_eventType === 'plant') {
      const spr = this.assets.sprite('IMAGE_UI_PACKETS_' + e.m_dataString.toUpperCase());
      if (spr && spr.img.complete) {
        const hh = 80 * this.s, ww = hh * spr.w / spr.h;
        ctx.drawImage(spr.img, spr.x, spr.y, spr.w, spr.h, X(p.x) - ww / 2, Y(p.y) - hh, ww, hh);
      }
    } else if (e.m_eventType === 'pinata') {
      const pl = this.gift || (this.gift = this.assets.player('POPANIM_WORLDMAP_GIFTBOX_WORLD_MAP', () => false));
      if (pl) { pl.play(got ? 'open_idle' : 'idle'); pl.draw(ctx, [this.s * 0.5, 0, 0, this.s * 0.5, X(p.x - NODE_CENTER.gift[0]), Y(p.y - NODE_CENTER.gift[1])]); }
    } else if (e.m_eventType === 'upgrade') {
      const id = /starting_sun/.test(e.m_dataString) ? 'IMAGE_WORLDMAP_COMMON_UPGRADE_STARTING_SUN' : 'IMAGE_WORLDMAP_COMMON_UPGRADE_PLANTFOOD_SLOT';
      const spr = this.assets.sprite(id);
      if (spr && spr.img.complete) { const z = 0.45 * this.s; ctx.drawImage(spr.img, spr.x, spr.y, spr.w, spr.h, X(p.x) - spr.w * z / 2, Y(p.y) - spr.h * z, spr.w * z, spr.h * z); }
    }
    ctx.globalAlpha = 1;
  }

  drawHud(ctx) {
    const { w, h } = this.screen;
    const k = Math.max(0.75, Math.min(1.2, h / 420));
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(40,24,8,0.82)';
    roundRect(ctx, 8, 8, 170 * k, 40 * k, 10); ctx.fill();
    this.assets.drawSprite(ctx, 'IMAGE_EFFECTS_COIN_GOLD_COIN_GOLD_59X59', 14, 12 * k, 32 * k, 32 * k);
    ctx.fillStyle = '#ffe680';
    ctx.font = `bold ${Math.round(22 * k)}px "Trebuchet MS", sans-serif`;
    ctx.fillText(this.app.save.coins.toLocaleString('en-US'), 52 * k, 37 * k);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,240,200,0.9)';
    ctx.font = `bold ${Math.round(20 * k)}px "Trebuchet MS", sans-serif`;
    ctx.strokeStyle = 'rgba(60,30,0,0.8)'; ctx.lineWidth = 4;
    ctx.strokeText('ANCIENT EGYPT', w / 2, 34 * k); ctx.fillText('ANCIENT EGYPT', w / 2, 34 * k);
    if (offline.total) {
      ctx.textAlign = 'left';
      ctx.font = `bold ${Math.round(12 * k)}px sans-serif`;
      ctx.fillStyle = offline.ready ? '#b6ff9a' : '#fff3c0';
      ctx.fillText(offline.ready ? '✓ Works offline' : `Saving for offline… ${Math.floor(100 * offline.done / offline.total)}%`, 12, h - 14);
      ctx.textAlign = 'center';
    }
    const mb = this.buttons().mute;
    ctx.fillStyle = 'rgba(40,24,8,0.82)';
    roundRect(ctx, mb.x, mb.y, mb.w, mb.h, 10); ctx.fill();
    ctx.fillStyle = '#fff3c0'; ctx.font = `${Math.round(20 * k)}px sans-serif`;
    ctx.fillText(this.app.audio.muted ? '🔇' : '🔊', mb.x + mb.w / 2, mb.y + mb.h * 0.7);
    const b = this.buttons().shop;
    const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    g.addColorStop(0, '#7b3fd0'); g.addColorStop(1, '#3b1670');
    ctx.fillStyle = g;
    roundRect(ctx, b.x, b.y, b.w, b.h, 14 * k); ctx.fill();
    ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 3 * k; ctx.stroke();
    ctx.fillStyle = '#ffe680';
    ctx.font = `bold ${Math.round(15 * k)}px "Trebuchet MS", sans-serif`;
    ctx.fillText('🎪 NIGHT CARNIVAL', b.x + b.w / 2, b.y + b.h * 0.45);
    ctx.font = `bold ${Math.round(11 * k)}px sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText('plant sale — tap to open', b.x + b.w / 2, b.y + b.h * 0.78);
  }
}

function inRect(x, y, r) { return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
