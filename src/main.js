// App shell: loads data and assets, runs the frame loop, switches screens
// (world map -> seed chooser -> battle -> results, plus the Night Carnival shop).
import { GameData } from './data.js';
import { Assets } from './assets.js';
import { Battle, roundRect } from './game.js';
import { WorldMap, mapAssets } from './map.js';
import { SeedChooser, btn, inRect } from './chooser.js';
import { Shop } from './shop.js';
import { Save } from './save.js';
import { isPremium } from './carnival.js';
import { registerWorker, setupOffline } from './offline.js';
import { packAvailable, showImportScreen, expectedPack, importedPack } from './pack.js';
import { Audio } from './audio.js';
import { PamPlayer } from './pam.js';

const params = new URLSearchParams(location.search);
const SPEED = parseFloat(params.get('speed') || '1');
const STEP = 1 / 60;
const COMMON_ANIMS = ['POPANIM_EFFECTS_SUN', 'POPANIM_MOWERS_MOWER_EGYPT', 'POPANIM_EFFECTS_PLANT_PLANTED',
  'POPANIM_EFFECTS_PLANT_UNPLANTED', 'POPANIM_GRAVESTONES_EGYPT_HIEROGLYPH', 'POPANIM_EFFECTS_COIN_SILVER',
  'POPANIM_EFFECTS_COIN_GOLD', 'POPANIM_EFFECTS_POTATOMINE_EXPLOSION', 'POPANIM_EFFECTS_JALAPENO_FIRE',
  'POPANIM_EFFECTS_T_FIRE_PEA', 'POPANIM_EFFECTS_DIRT_SPAWN_DIRT', 'POPANIM_EFFECTS_PLANTFOOD_PICKUP',
  'POPANIM_EFFECTS_PLANTFOOD_FX', 'POPANIM_EFFECTS_PLANT_BURNT', 'POPANIM_EFFECTS_ZOMBIE_ASH', 'POPANIM_EFFECTS_ZOMBIE_IMP_ASH',
  'POPANIM_EFFECTS_ZOMBIE_GARGANTUAR_ASH', 'POPANIM_EFFECTS_GENERIC_EXPLOSION_FRONT', 'POPANIM_EFFECTS_TOMBSTONE_EGYPT_HIEROGLYPH_DAMAGE'];
const UI_SPRITES = ['IMAGE_BACKGROUNDS_EGYPT_TEXTURE', 'IMAGE_BACKGROUNDS_EGYPT_TEXTURE_LEFT', 'IMAGE_BACKGROUNDS_EGYPT_TEXTURE_RIGHT',
  'IMAGE_EFFECTS_SUN_SUN_78X78', 'IMAGE_EFFECTS_COIN_GOLD_COIN_GOLD_59X59', 'IMAGE_UI_PACKETS_READY', 'IMAGE_UI_PACKETS_READY_PREMIUM',
  'IMAGE_UI_PACKETS_PRICE_TAB', 'IMAGE_UI_PACKETS_PRICE_TAB_PREMIUM', 'IMAGE_UI_PACKETS_SELECTED'];

export const ECONOMY = { silverCoin: 15, goldCoin: 150, firstWin: 1000, replayWin: 350, perKill: 5 };

class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.assets = new Assets('assets/');
    this.economy = ECONOMY;
    this.save = new Save();
    this.audio = new Audio('assets/audio/');
    PamPlayer.sound = (name) => this.audio.play(name, { volume: 0.7, gap: 0.08 });
    this.screen = null;
    this.result = null;
    this.acc = 0;
    this.last = 0;
    this.isPremium = isPremium;
    this.resize();
    addEventListener('resize', () => this.resize());
    canvas.addEventListener('pointerdown', e => this.pointer(e, 'down'));
    canvas.addEventListener('pointermove', e => this.pointer(e, 'move'));
    canvas.addEventListener('pointerup', e => this.pointer(e, 'up'));
    canvas.addEventListener('pointercancel', e => this.pointer(e, 'up'));
  }

  async init() {
    this.loading('Loading game data');
    const [json] = await Promise.all([fetch('data/game.json').then(r => r.json()), this.assets.init(), this.audio.init()]);
    this.data = new GameData(json);
    this.data.worldmap = json.worldmap;
  }

  plantIds() { return Object.keys(this.data.sheets.PlantTypes).filter(id => this.assets.sprites['IMAGE_UI_PACKETS_' + id.toUpperCase()]); }

  // Everything a level needs before it starts: characters, projectiles, effects, background.
  levelAssets(levelName, seeds) {
    const ids = new Set(COMMON_ANIMS);
    const plants = new Set(seeds);
    for (const o of this.data.levels[levelName]) {
      const s = JSON.stringify(o);
      for (const m of s.matchAll(/RTID\(([^@()]+)@ZombieTypes\)/g)) {
        const z = this.data.zombie(m[1]);
        if (z) ids.add(z.type.PopAnim);
      }
      for (const m of s.matchAll(/"(?:TypeName|PlantType)":"([a-z0-9_]+)"/g)) if (this.data.plant(m[1])) plants.add(m[1]);
    }
    // Zomboss fights: the mech, its rockets and every zombie its portal can spawn.
    for (const o of this.data.levels[levelName]) {
      const boss = o.objdata && o.objdata.ZombossMechType && this.data.zombie(o.objdata.ZombossMechType);
      if (!boss) continue;
      ids.add(boss.type.PopAnim);
      ids.add('POPANIM_EFFECTS_ZOMBOSS_MISSILE_EXPLOSION_EGYPT');
      for (const st of boss.props.Stages || []) for (const ref of st.Actions || []) {
        for (const t of this.data.resolve(ref)?.SpawnZombieTypes || []) { const z = this.data.zombie(t); if (z) ids.add(z.type.PopAnim); }
      }
    }
    ids.add(this.data.zombie('mummy_flag').type.PopAnim);
    if ([...ids].some(i => /GARGANTUAR/.test(i))) ids.add(this.data.zombie('egypt_imp').type.PopAnim);
    for (const z of Object.values(this.data.sheets.ZombieTypes)) {
      const p = this.data.resolve(z.Properties);
      if (p && p.Projectile && ids.has(z.PopAnim)) { const pr = this.data.projectile(p.Projectile); if (pr?.AttachedPAM) ids.add(pr.AttachedPAM); }
    }
    const sprites = [];
    for (const p of plants) {
      const d = this.data.plant(p);
      if (!d) continue;
      ids.add(d.type.PopAnim);
      sprites.push('IMAGE_UI_PACKETS_' + p.toUpperCase());
      for (const a of d.props.Actions || []) {
        const pr = a.Projectile && this.data.projectile(a.Projectile);
        if (pr) { if (pr.AttachedPAM) ids.add(pr.AttachedPAM); if (pr.ImpactPAM) ids.add(pr.ImpactPAM); if (pr.RenderImage) sprites.push(pr.RenderImage); }
      }
    }
    return { anims: [...ids], sprites };
  }

  // ---------------------------------------------------------------- screens

  async openScreen(name, opts = {}) {
    this.result = null;
    this.audio.playMusic('music_title');
    if (name === 'map') {
      this.loading('Ancient Egypt');
      const m = mapAssets(this.data.worldmap.egypt);
      const mapSprites = [...m.images, 'IMAGE_EFFECTS_COIN_GOLD_COIN_GOLD_59X59', 'IMAGE_WORLDMAP_COMMON_UPGRADE_STARTING_SUN', 'IMAGE_WORLDMAP_COMMON_UPGRADE_PLANTFOOD_SLOT'];
      this.assets.trim(m.anims, mapSprites);
      await this.assets.preload(m.anims, mapSprites, (d, t) => this.loading('Ancient Egypt', d / t));
      this.setScreen(new WorldMap(this));
      // Everything else the next screens need streams in while the player looks at the map.
      this.assets.prefetch([], [...UI_SPRITES, ...this.plantIds().map(p => 'IMAGE_UI_PACKETS_' + p.toUpperCase())]);
    } else if (name === 'shop') {
      this.loading('Night Carnival');
      this.assets.trim(Shop.assets(this.data), UI_SPRITES);
      await this.assets.preload(Shop.assets(this.data), UI_SPRITES, (d, t) => this.loading('Night Carnival', d / t));
      this.setScreen(new Shop(this, opts));
    }
  }

  async openChooser(levelName) {
    this.result = null;
    const lv = this.data.level(levelName);
    // Only modules the level actually lists count (some files carry unused objects).
    const conveyor = (lv.def.Modules || []).some(r => this.data.resolve(r, lv.local)?.objclass === 'ConveyorSeedBankProperties');
    if (conveyor) { await this.startLevel(levelName, []); return; }
    this.loading('Loading');
    const sprites = [...UI_SPRITES, ...this.plantIds().map(p => 'IMAGE_UI_PACKETS_' + p.toUpperCase())];
    this.assets.trim([], sprites);
    await this.assets.preload([], sprites, (d, t) => this.loading('Loading', d / t));
    this.setScreen(new SeedChooser(this, levelName));
  }

  async startLevel(levelName, seeds) {
    this.result = null;
    const title = 'Loading Day ' + (this.data.level(levelName)?.def.LevelNumber ?? '');
    this.loading(title);
    const need = this.levelAssets(levelName, seeds);
    this.assets.trim(need.anims, [...UI_SPRITES, ...need.sprites]);
    await this.assets.preload(need.anims, [...UI_SPRITES, ...need.sprites], (d, t) => this.loading(title, d / t));
    this.audio.stopMusic();
    const b = new Battle(this, levelName, seeds);
    if (this.save.data.upgrades.starting_sun_lvl1) b.sun += 25;
    this.setScreen(b);
  }

  setScreen(s) {
    this.screen = s;
    s.layout(this.w, this.h);
  }

  onBattleEnd(battle, won) {
    const level = battle.levelName;
    let coins = battle.coinsEarned;
    let first = false;
    if (won) {
      first = !this.save.done[level];
      coins += first ? ECONOMY.firstWin : ECONOMY.replayWin;
      coins += battle.killed * ECONOMY.perKill;
      this.save.winLevel(level, coins);
      const def = battle.level.def;
      if (first && def.FirstRewardType === 'upgrade') this.save.data.upgrades[String(def.FirstRewardParam).replace(/^upgrade_/, '')] = true;
      this.save.write();
    } else if (coins > 0) this.save.addCoins(coins);
    const map = this.data.worldmap.egypt;
    const reward = first && map.m_eventList.find(e => e.m_eventType === 'plant' && map.m_eventList.find(p => p.m_name === e.m_parentEvent)?.m_dataString === level);
    battle.message(won ? (battle.boss ? 'DR. ZOMBOSS DEFEATED!' : 'LEVEL COMPLETE!') : 'THE ZOMBIES ATE YOUR BRAINS!', 2.4);
    this.result = { won, coins, level, first, reward: reward ? reward.m_dataString : null, t: 0 };
  }

  resultButtons() {
    const k = Math.max(0.75, Math.min(1.25, this.h / 420));
    const cx = this.w / 2, y = this.h / 2 + 50 * k;
    return {
      map: { x: cx - 175 * k, y, w: 165 * k, h: 50 * k },
      again: { x: cx + 10 * k, y, w: 165 * k, h: 50 * k },
      k,
    };
  }

  drawResult(c) {
    const r = this.result;
    if (!r || r.t < 2.2) return;
    const { w, h } = this;
    const b = this.resultButtons(), k = b.k;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(50,30,10,0.95)';
    roundRect(c, w / 2 - 210 * k, h / 2 - 120 * k, 420 * k, 240 * k, 18 * k); c.fill();
    c.strokeStyle = '#e6b95a'; c.lineWidth = 3 * k; c.stroke();
    c.textAlign = 'center';
    c.fillStyle = r.won ? '#ffe680' : '#ff8a6a';
    c.font = `bold ${Math.round(28 * k)}px "Trebuchet MS", sans-serif`;
    c.fillText(r.won ? 'VICTORY!' : 'DEFEAT', w / 2, h / 2 - 78 * k);
    c.fillStyle = '#fff';
    c.font = `bold ${Math.round(18 * k)}px "Trebuchet MS", sans-serif`;
    this.assets.drawSprite(c, 'IMAGE_EFFECTS_COIN_GOLD_COIN_GOLD_59X59', w / 2 - 95 * k, h / 2 - 58 * k, 30 * k, 30 * k);
    c.textAlign = 'left';
    c.fillText(`+${r.coins.toLocaleString('en-US')} coins`, w / 2 - 58 * k, h / 2 - 36 * k);
    c.textAlign = 'center';
    c.font = `${Math.round(14 * k)}px sans-serif`;
    c.fillStyle = '#f3dcae';
    const line = r.reward ? `New plant unlocked: ${this.data.plant(r.reward)?.name || r.reward}!`
      : r.won && r.first ? 'First clear bonus included' : r.won ? 'Replay bonus' : 'Try a different lineup — or grab a Carnival plant';
    c.fillText(line, w / 2, h / 2 + 2 * k);
    c.fillText(`Total: ${this.save.coins.toLocaleString('en-US')} coins`, w / 2, h / 2 + 26 * k);
    btn(c, b.map, '◀ MAP', false, k);
    btn(c, b.again, r.won ? 'NEXT ▶' : 'TRY AGAIN', true, k);
  }

  // The game is landscape-only; in portrait show a prompt over everything.
  drawRotate(c) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#2b1d0e'; c.fillRect(0, 0, this.w, this.h);
    c.fillStyle = '#ffe680'; c.textAlign = 'center';
    c.font = 'bold 54px sans-serif';
    c.fillText('⟳', this.w / 2, this.h / 2 - 20);
    c.font = 'bold 20px "Trebuchet MS", sans-serif';
    c.fillText('Turn your phone sideways', this.w / 2, this.h / 2 + 30);
  }

  nextLevelName() {
    const n = this.data.level(this.result.level).def.LevelNumber + 1;
    return this.data.levels['egypt' + n] ? 'egypt' + n : null;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = innerWidth; this.h = innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.dpr = dpr;
    if (this.screen) this.screen.layout(this.w, this.h);
  }

  pointer(e, kind) {
    e.preventDefault();
    if (kind !== 'move') this.audio.unlock();   // iOS grants audio on touch end
    if (!this.screen) return;
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (this.result && this.result.t >= 2.2) {
      if (kind !== 'down') return;
      const b = this.resultButtons();
      if (inRect(sx, sy, b.map)) this.openScreen('map');
      else if (inRect(sx, sy, b.again)) {
        const next = this.result.won ? this.nextLevelName() : this.result.level;
        if (next) this.openChooser(next); else this.openScreen('map');
      }
      return;
    }
    if (this.screen.pointer) { this.screen.pointer(kind, sx, sy); return; }
    const g = this.screen.toGame(sx, sy);
    if (kind === 'down') this.screen.tap(g.x, g.y, sx, sy);
    this.screen.hover = g;
  }

  loading(text, progress = null) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#2b1d0e'; c.fillRect(0, 0, this.w, this.h);
    c.fillStyle = '#f4e2a0'; c.font = 'bold 22px "Trebuchet MS", sans-serif'; c.textAlign = 'center';
    c.fillText(text + '…', this.w / 2, this.h / 2);
    if (progress != null) {
      const bw = Math.min(320, this.w * 0.6), x = (this.w - bw) / 2, y = this.h / 2 + 22;
      c.fillStyle = 'rgba(255,255,255,0.15)'; roundRect(c, x, y, bw, 12, 6); c.fill();
      c.fillStyle = '#9ccf3a'; roundRect(c, x, y, Math.max(12, bw * Math.min(1, progress)), 12, 6); c.fill();
    }
  }

  frame(now) {
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    if (this.screen) {
      this.acc += dt * SPEED;
      let steps = 0;
      while (this.acc >= STEP && steps++ < 30 * Math.max(1, SPEED)) { this.screen.update(STEP); if (this.result) this.result.t += STEP; this.acc -= STEP; }
      const c = this.ctx;
      // Screens draw in CSS pixels; the device-pixel scale is folded into every transform.
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const orig = c.setTransform.bind(c);
      const dpr = this.dpr;
      c.setTransform = (a, b, cc, d, e, f) => orig(a * dpr, b * dpr, cc * dpr, d * dpr, e * dpr, f * dpr);
      this.screen.draw(c);
      this.drawResult(c);
      if (this.h > this.w) this.drawRotate(c);
      c.setTransform = orig;
      c.restore();
    }
    requestAnimationFrame(t => this.frame(t));
  }
}

const app = new App(document.getElementById('game'));
window.app = app;
const reg = await registerWorker();
if (!(await packAvailable())) {
  showImportScreen(app);
  window.needsPack = true;
  throw new Error('game files not loaded yet');   // stop here; the import screen reloads the page
}
// An imported pack older than this code: offer the update (playing on with old files is allowed).
const want = await expectedPack(), have = importedPack();
if (want && have && want !== have) {
  await new Promise(ok => { app.skipUpdate = ok; showImportScreen(app, true); });
}
await app.init();
setupOffline(reg);
if (params.get('level')) {
  const seeds = (params.get('seeds') || 'sunflower,peashooter,wallnut,potatomine,cabbagepult,bloomerang').split(',');
  await app.startLevel(params.get('level'), seeds);
} else {
  await app.openScreen('map');
}
requestAnimationFrame(t => app.frame(t));
window.ready = true;
