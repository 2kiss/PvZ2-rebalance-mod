// Battle: level runtime (modules, waves, sun dropper), entities, camera, input, HUD.
import { Plant, Zombie, Projectile, Sun, Mower, Effect, PlantFoodPickup, drawPam } from './entities.js';
import { Zomboss } from './zomboss.js';
import { COLS, ROWS, CELL_W, CELL_H, LAWN_X, LAWN_Y, ZOMBIE_SPAWN_X, cellAt, cellCenter, rowGround, rnd } from './board.js';

const VIEW = { y0: 70, y1: 580 };

export class Battle {
  constructor(app, levelName, seeds) {
    this.app = app;
    this.data = app.data;
    this.assets = app.assets;
    this.level = this.data.level(levelName);
    this.levelName = levelName;
    this.plants = [];
    this.zombies = [];
    this.projectiles = [];
    this.effects = [];
    this.suns = [];
    this.pickups = [];
    this.mowers = [];
    this.gridItems = [];
    this.mold = new Set();
    this.time = 0;
    this.sun = 50;
    this.plantFood = 0;
    this.pfSelected = false;
    this.state = 'play';
    this.seedIds = [...seeds];
    this.seeds = seeds.map(id => this.makeSeed(id));
    this.selected = null;
    this.shovel = false;
    this.hud = { sunTarget: { x: 0, y: 0 } };
    this.killed = 0;
    this.coinsEarned = 0;
    this.messages = [];
    this.protect = [];
    this.conveyor = null;
    this.lastStand = false;
    this.paused = false;
    this.speed = 1;
    this.timers = [];
    this.boss = null;
    this.reservedCols = 0;
    this.setupModules();
  }

  makeSeed(id) { return { id, def: this.data.plant(id), cooldown: 0, max: 1 }; }

  // ---------------------------------------------------------------- level modules

  setupModules() {
    const def = this.level.def;
    const local = this.level.local;
    if (def.StartingSun != null) this.sun = def.StartingSun;
    for (const ref of def.Modules || []) {
      const m = this.data.resolve(ref, local);
      if (!m) continue;
      switch (m.objclass) {
        case 'SunDropperProperties':
          this.sunDropper = { props: m, t: m.InitialSunDropDelay ?? 2, dropped: 0 };
          break;
        case 'LawnMowerProperties':
          for (let r = 0; r < ROWS; r++) this.mowers.push(new Mower(this, r));
          break;
        case 'InitialPlantProperties':
          for (const ip of m.InitialPlantPlacements || []) this.addPlant(ip.TypeName, ip.GridX, ip.GridY, true);
          break;
        case 'GravestoneProperties': {
          const type = this.data.resolve(m.GravestoneType)?.TypeName || 'gravestone_egypt';
          for (const g of m.ForceSpawnData || []) this.addGridItem(type, g.GridX, g.GridY);
          for (let n = 0, guard = 0; n < (m.GravestoneCount || 0) && guard < 60; guard++) {
            const c = Math.floor(rnd(m.SpawnColumnStart ?? 4, (m.SpawnColumnEnd ?? 6) + 0.99)), r = Math.floor(Math.random() * ROWS);
            if (!this.cellBlocked(c, r)) { this.addGridItem(type, c, r); n++; }
          }
          break;
        }
        case 'ZombossBattleModuleProperties':
          this.reservedCols = m.ReservedColumnCount || 0;
          if (this.data.zombie(m.ZombossMechType)) { this.boss = new Zomboss(this, m.ZombossMechType, m); this.zombies.push(this.boss); }
          break;
        case 'WaveManagerModuleProperties': {
          const wm = this.data.resolve(m.WaveManagerProps, local);
          if (wm) this.setupWaves(wm);
          break;
        }
        case 'StandardLevelIntroProperties':
          this.sun += m.AdditionalStartingSun || 0;
          break;
        case 'ConveyorSeedBankProperties':
          this.conveyor = { props: m, t: 1.5, dropped: 0, list: (m.InitialPlantList || []).map(e => ({ ...e })) };
          this.seeds = [];
          break;
        case 'LastStandMinigameProperties':
          this.lastStand = true;
          this.sun = m.StartingSun ?? this.sun;
          this.plantFood = m.StartingPlantfood || 0;
          break;
        case 'ProtectThePlantChallengeProperties':
          for (const p of m.Plants || []) {
            const pl = this.addPlant(p.PlantType, p.GridX, p.GridY, true);
            if (pl) { pl.protected = true; this.protect.push(pl); }
          }
          break;
        case 'StarChallengeModuleProperties':
          for (const list of m.Challenges || []) for (const ref2 of list) {
            const c = this.data.resolve(ref2, local);
            if (c && c.objclass === 'MoldColonyChallengeProps') this.applyMold(this.data.resolve(c.Locations));
          }
          break;
        default:
          break;
      }
    }
    if (this.lastStand && this.waves) this.waves.timer = Infinity;
  }

  applyMold(map) {
    const grid = map && (map.Values || map.Map || map.Grid);
    if (!Array.isArray(grid)) return;
    grid.forEach((row, r) => (Array.isArray(row) ? row : String(row).split('')).forEach((v, c) => {
      if (v === true || v === 1 || v === '1') this.mold.add(c + ',' + r);
    }));
  }

  setupWaves(wm) {
    const local = this.level.local;
    const waves = (wm.Waves || []).map(list => list.map(ref => this.data.resolve(ref, local)).filter(Boolean));
    this.waves = {
      props: wm,
      list: waves,
      count: wm.WaveCount || waves.length,
      index: 0,
      timer: (wm.ZombieCountdownFirstWaveSecs ?? 2) + 18,
      current: [],
      flagInterval: wm.FlagWaveInterval || 10,
      done: false,
      pending: [],
      thresholdPct: 0.6,
      startHp: 0,
    };
  }

  isFlagWave(i) {
    const w = this.waves;
    return (i + 1) % w.flagInterval === 0 || i + 1 === w.count;
  }

  zombieTypeOf(ref) {
    const r = this.data.resolve(ref);
    return r ? r.TypeName : null;
  }

  spawnWave() {
    const w = this.waves;
    const i = w.index;
    const actions = w.list[i] || [];
    w.current = [];
    const flag = this.isFlagWave(i);
    const fresh = [];
    const push = p => { w.pending.push(p); fresh.push(p); };
    if (flag) {
      this.message(i + 1 === w.count ? 'FINAL WAVE' : 'A HUGE WAVE OF ZOMBIES IS APPROACHING!', 3.5);
      this.sfx('play_siren');
      push({ t: 0.2, type: 'mummy_flag', row: Math.floor(Math.random() * ROWS) });
    }
    const delay = flag ? 0.8 : 0;
    let pf = 0;
    for (const a of actions) {
      pf += a.AdditionalPlantfood || 0;
      const zs = a.Zombies || [];
      if (a.objclass === 'SpawnZombiesJitteredWaveActionProps') {
        for (const z of zs) {
          const type = this.zombieTypeOf(z.Type);
          if (!type) continue;
          const row = z.Row ? Math.max(0, Math.min(ROWS - 1, parseInt(z.Row, 10) - 1)) : Math.floor(Math.random() * ROWS);
          push({ t: delay + rnd(0, 1.4), type, row });
        }
      } else if (a.objclass === 'SpawnZombiesFromGroundSpawnerProps') {
        for (const z of zs) {
          const type = this.zombieTypeOf(z.Type);
          if (type) push({ t: delay + rnd(0, 1.5), type, row: z.Row ? parseInt(z.Row, 10) - 1 : Math.floor(Math.random() * ROWS), col: Math.floor(rnd(a.ColumnStart ?? 6, (a.ColumnEnd ?? 8) + 0.99)), ground: true });
        }
      } else if (a.objclass === 'StormZombieSpawnerProps') {
        const group = a.GroupSize || 1, gap = a.TimeBetweenGroups || 2;
        zs.forEach((z, k) => {
          const type = this.zombieTypeOf(z.Type);
          if (type) push({ t: delay + Math.floor(k / group) * gap + rnd(0, 0.4), type, row: Math.floor(Math.random() * ROWS), col: Math.floor(rnd(a.ColumnStart ?? 5, (a.ColumnEnd ?? 8) + 0.99)), storm: true });
        });
        this.message('SANDSTORM!', 2);
        this.sfx('play_zomb_egypt_sandstorm_start');
      } else if (a.objclass === 'SpawnGravestonesWaveActionProps') {
        const pool = a.SpawnPositionsPool || [];
        const n = (a.GravestonePool || []).reduce((s, g) => s + (g.Count || 1), 0) || 2;
        for (const p of [...pool].sort(() => Math.random() - 0.5).slice(0, n)) this.addGridItem('gravestone_egypt', p.mX, p.mY, true);
      }
    }
    if (!actions.length) this.spendPoints(w, i, delay, push);
    for (let k = 0; k < pf && fresh.length; k++) fresh[Math.floor(Math.random() * fresh.length)].plantFood = true;
    w.index += 1;
    w.timer = 30;
    w.thresholdPct = rnd(w.props.MinNextWaveHealthPercentage ?? 0.5, w.props.MaxNextWaveHealthPercentage ?? 0.65);
  }

  // Waves past the scripted list: spend wave points on the level's zombie pool.
  spendPoints(w, i, delay, push) {
    const pool = this.levelPool();
    let points = (w.props.WaveSpendingPoints || 100) + (w.props.WaveSpendingPointIncrement || 30) * i;
    if (this.isFlagWave(i)) points *= 2.5;
    for (let guard = 0; points > 0 && guard < 40; guard++) {
      const type = pool[Math.floor(Math.random() * pool.length)];
      const cost = this.data.zombie(type)?.props.WavePointCost || 100;
      if (cost > points && guard > 3) break;
      points -= cost;
      push({ t: delay + rnd(0, 2), type, row: Math.floor(Math.random() * ROWS) });
    }
  }

  levelPool() {
    if (!this._pool) {
      const set = new Set();
      for (const list of this.waves.list) for (const a of list) for (const z of a.Zombies || []) {
        const t = this.zombieTypeOf(z.Type);
        if (t && !/flag/.test(t)) set.add(t);
      }
      this._pool = [...set].filter(t => this.data.zombie(t));
      if (!this._pool.length) this._pool = ['mummy'];
    }
    return this._pool;
  }

  waveHealth(list) {
    return list.reduce((s, z) => s + (z.dead ? 0 : Math.max(0, z.hp) + z.armor.reduce((a, b) => a + Math.max(0, b.hp), 0)), 0);
  }

  updateWaves(dt) {
    const w = this.waves;
    if (!w) return;
    for (const p of w.pending) p.t -= dt;
    const ready = w.pending.filter(p => p.t <= 0);
    w.pending = w.pending.filter(p => p.t > 0);
    for (const p of ready) {
      const row = Math.max(0, Math.min(ROWS - 1, p.row));
      const x = p.col != null ? LAWN_X + (p.col + 0.6) * CELL_W : ZOMBIE_SPAWN_X + rnd(0, 40);
      const zs = this.spawnZombie(p.type, row, x, { plantFood: p.plantFood });
      for (const z of zs) { w.current.push(z); w.startHp += z.maxHp + z.armor.reduce((a, b) => a + b.max, 0); }
      if (p.ground && zs[0]) this.effect('POPANIM_EFFECTS_DIRT_SPAWN_DIRT', x, rowGround(row));
    }
    if (w.index >= w.count) { w.done = !w.pending.length; return; }
    if (w.timer === Infinity) return;
    w.timer -= dt;
    if (w.index > 0 && !w.pending.length && w.timer > 6 && this.waveHealth(w.current) / (w.startHp || 1) <= w.thresholdPct) {
      w.timer = this.isFlagWave(w.index) ? 6 : 2;
    }
    if (w.timer <= 0) { w.startHp = 0; this.spawnWave(); }
  }

  // ---------------------------------------------------------------- entities

  addPlant(id, col, row, initial = false) {
    const d = this.data.plant(id);
    if (!d || !this.assets.doc(d.type.PopAnim)) return null;
    const p = new Plant(this, id, col, row);
    this.plants.push(p);
    if (!initial) this.effect('POPANIM_EFFECTS_PLANT_PLANTED', p.x, p.y);
    return p;
  }

  removePlant(p) {
    this.plants = this.plants.filter(q => q !== p);
    if (p.protected && this.state === 'play') this.lose('A protected plant was eaten!');
  }

  spawnZombie(type, row, x, opts = {}) {
    const z0 = this.data.zombie(type);
    if (!z0 || !this.assets.doc(z0.type.PopAnim)) return [];
    if (z0.type.ZombieClass === 'ZombieCamel') {
      // Camels walk in a line: a head with its sign, humps, then a tail.
      const n = /manyhump/.test(type) ? 4 : /twohump/.test(type) ? 2 : 1;
      const gap = z0.props.CamelSegmentOffset || 50;
      const parts = n === 1 ? ['head'] : ['head', ...Array(n - 2).fill('hump'), 'tail'];
      return parts.map((seg, k) => this.addZombie(k === 0 ? type : (this.data.zombie('camel_segment') ? 'camel_segment' : type), row, x + k * gap, { segment: seg, plantFood: k === 0 && opts.plantFood })).filter(Boolean);
    }
    const z = this.addZombie(type, row, x, opts);
    return z ? [z] : [];
  }

  addZombie(type, row, x, opts = {}) {
    const d = this.data.zombie(type);
    if (!d || !this.assets.doc(d.type.PopAnim)) return null;
    const z = new Zombie(this, type, row, x, opts);
    this.zombies.push(z);
    return z;
  }

  zombieAhead(z) {
    let best = null;
    for (const o of this.zombies) {
      if (o === z || o.row !== z.row || !o.targetable || o.hypno) continue;
      const d = o.x - z.x;
      if (d > 0 && d < 40 && (!best || o.x < best.x)) best = o;
    }
    return best;
  }

  cellBlocked(c, r) {
    return this.plants.some(p => p.col === c && p.row === r) || this.gridItems.some(g => g.col === c && g.row === r) || this.mold.has(c + ',' + r);
  }

  gridItemAt(c, r) { return this.gridItems.find(g => g.col === c && g.row === r) || null; }

  addGridItem(type, col, row, animate = false) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS || this.gridItemAt(col, row) || this.plants.some(p => p.col === col && p.row === row)) return;
    const t = this.data.sheets.GridItemTypes[type] || this.data.sheets.GridItemTypes.gravestone_egypt;
    const props = this.data.resolve(t.Properties) || {};
    const c = cellCenter(col, row);
    const hp = props.Hitpoints || 700;
    const g = { type, col, row, x: c.x, y: rowGround(row), hp, max: hp, props, blocksShots: true };
    g.player = this.assets.player(props.PopAnim || 'POPANIM_GRAVESTONES_EGYPT_HIEROGLYPH', () => false);
    this.setGraveState(g);
    this.gridItems.push(g);
    if (animate) { this.effect('POPANIM_EFFECTS_DIRT_SPAWN_DIRT', g.x, g.y); this.sfx('play_zomb_egypt_tombraiser_grave_rise'); }
  }

  setGraveState(g) {
    if (!g.player) return;
    const labels = Object.keys(g.player.doc.labels);
    const k = Math.min(labels.length - 1, Math.floor((1 - g.hp / g.max) * labels.length));
    if (g.state !== k) { g.state = k; g.player.play(labels[Math.max(0, k)], false, true); }
  }

  damageGridItem(g, amount) {
    g.hp -= amount;
    if (g.hp <= 0) this.destroyGridItem(g); else this.setGraveState(g);
  }

  destroyGridItem(g) {
    this.sfx('play_zomb_egypt_grave_crumble');
    this.gridItems = this.gridItems.filter(q => q !== g);
    if (g.props.BreakEffect) this.effect(g.props.BreakEffect, g.x, g.y);
  }

  spawnProjectile(plant, action, target, pf = false) {
    if (!action) return null;
    const p = new Projectile(this, plant, action, target, { pf });
    this.projectiles.push(p);
    this.sfx(p.lob ? 'play_cabbagepult_throw' : /Fire/.test(p.ref) ? 'play_firepea' : 'play_throw', 0.6);
    if (plant.id === 'starfruit') {
      for (const [vx, vy] of [[-1, 0], [0.75, -0.66], [0.75, 0.66], [0, -1], [0, 1]]) {
        const q = new Projectile(this, plant, action, null);
        q.free = { vx: vx * 333, vy: vy * 333 };
        this.projectiles.push(q);
      }
      p.dead = true;
    }
    return p;
  }

  sfx(name, volume = 1) { this.app.audio?.play(name, { volume }); }

  spawnSun(x, y, amount, source) { this.suns.push(new Sun(this, x, y, amount, source)); }

  effect(id, x, y, labels) { if (id && this.assets.doc(id)) this.effects.push(new Effect(this, id, x, y, labels)); }

  explode(x, y, radius, damage) {
    if (radius > CELL_W) this.sfx('play_cherrybomb');
    for (const z of this.zombies) {
      if (!z.targetable || z.hypno) continue;
      const near = z.boss
        ? Math.hypot(Math.max(0, z.x - 20 - x, x - z.x - 150), Math.max(0, (z.y - CELL_H * 2) - y, y - z.y)) <= radius
        : Math.hypot(z.x - x, (z.y - 40) - y) <= radius + 22;
      if (near) z.burn(damage);
    }
  }

  laneFire(row) {
    this.sfx('play_cherrybomb');
    for (let c = 0; c < COLS; c += 1) { const cc = cellCenter(c, row); this.effect('POPANIM_EFFECTS_JALAPENO_FIRE', cc.x, rowGround(row)); }
    for (const g of this.gridItems.filter(q => q.row === row)) this.destroyGridItem(g);
  }

  plantBlocking(z) {
    let best = null;
    for (const p of this.plants) {
      if (p.row !== z.row || p.dead) continue;
      if (p.id === 'potatomine' && p.state === 'armed') continue;
      const front = z.x - 20;
      if (front < p.x + 22 && front > p.x - 30 && (!best || p.x > best.x)) best = p;
    }
    return best;
  }

  zombieReachedHouse(z) {
    const m = this.mowers.find(q => q.row === z.row && !q.active && !q.dead);
    if (m) { m.trigger(); return; }
    const winX = LAWN_X + (this.data.sheets.LevelModules?.DefaultZombieWinCondition?.ZombieWinPositionX ?? -80);
    if (z.x < winX && this.state === 'play') this.lose();
  }

  onZombieKilled(z) {
    this.killed += 1;
    if (z.carriesPlantFood) this.pickups.push(new PlantFoodPickup(this, z.x, z.y - 20));
    if (Math.random() < 0.1) this.dropCoin(z.x, z.y - 40, Math.random() < 0.12 ? 'gold' : 'silver');
  }

  dropCoin(x, y, kind) {
    const value = kind === 'gold' ? this.app.economy.goldCoin : this.app.economy.silverCoin;
    this.coinsEarned += value;
    this.sfx('play_coin');
    this.effect(kind === 'gold' ? 'POPANIM_EFFECTS_COIN_GOLD' : 'POPANIM_EFFECTS_COIN_SILVER', x, y);
    this.message('+' + value, 0.9, x, y - 30);
  }

  message(text, t = 2, x = null, y = null) { this.messages.push({ text, t, max: t, x, y }); }

  // ---------------------------------------------------------------- loop

  update(dt) {
    if (this.paused) return;
    dt *= this.speed;
    if (this.state !== 'play') { this.endTimer = (this.endTimer || 0) + dt; this.updateEffects(dt); return; }
    if (this.time === 0) this.sfx('play_readysetplant');
    this.time += dt;
    for (const t of this.timers) { t.t -= dt; if (t.t <= 0) t.fn(); }
    this.timers = this.timers.filter(t => t.t > 0);
    for (const s of this.seeds) if (s.cooldown > 0) s.cooldown -= dt;
    if (this.sunDropper && !this.conveyor) {
      const d = this.sunDropper;
      d.t -= dt;
      if (d.t <= 0) {
        this.spawnSun(LAWN_X + rnd(0.5, COLS - 0.5) * CELL_W, LAWN_Y - 60, 50, 'sky');
        d.dropped += 1;
        const p = d.props;
        d.t = Math.min(p.SunCountdownMax ?? 12, (p.SunCountdownBase ?? 6) + rnd(0, p.SunCountdownRange ?? 3) + (p.SunCountdownIncreasePerSun ?? 0.1) * d.dropped);
      }
    }
    if (this.conveyor) this.updateConveyor(dt);
    this.updateWaves(dt);
    for (const p of [...this.plants]) p.update(dt);
    for (const z of [...this.zombies]) z.update(dt);
    for (const p of this.projectiles) p.update(dt);
    for (const m of this.mowers) m.update(dt);
    for (const s of this.suns) s.update(dt);
    for (const s of this.pickups) s.update(dt);
    this.updateEffects(dt);
    this.zombies = this.zombies.filter(z => !z.removed);
    this.projectiles = this.projectiles.filter(p => !p.dead);
    this.suns = this.suns.filter(s => !s.dead);
    this.pickups = this.pickups.filter(s => !s.dead);
    this.mowers = this.mowers.filter(m => !m.dead);
    if (this.boss) { if (this.boss.finished && this.state === 'play') this.win(); }
    else if (this.waves && this.waves.done && !this.zombies.some(z => !z.dead && !z.hypno) && this.state === 'play') this.win();
  }

  updateConveyor(dt) {
    const c = this.conveyor;
    c.t -= dt;
    if (c.t > 0 || this.seeds.length >= 8) return;
    let delay = 4;
    for (const d of c.props.DropDelayConditions || []) if (c.dropped >= (d.MaxPackets || 0)) delay = d.Delay;
    c.t = delay;
    const list = c.list.filter(e => !e.MaxCount || (e.given || 0) < e.MaxCount);
    const total = list.reduce((s, e) => s + (e.Weight || 1), 0);
    let r = Math.random() * total;
    for (const e of list) {
      r -= e.Weight || 1;
      if (r <= 0) { e.given = (e.given || 0) + 1; this.seeds.push(this.makeSeed(e.PlantType)); c.dropped += 1; break; }
    }
  }

  updateEffects(dt) {
    for (const e of this.effects) e.update(dt);
    this.effects = this.effects.filter(e => !e.dead);
    for (const m of this.messages) m.t -= dt;
    this.messages = this.messages.filter(m => m.t > 0);
  }

  win() {
    this.state = 'won';
    this.sfx('play_ui_reward_pvz_music_theme');
    this.app.onBattleEnd(this, true);
  }

  lose(reason) {
    if (this.state !== 'play') return;
    this.state = 'lost';
    this.sfx('play_scream');
    this.loseReason = reason;
    this.app.onBattleEnd(this, false);
  }

  // ---------------------------------------------------------------- input

  tap(gx, gy, sx, sy) {
    if (this.state !== 'play') return;
    const b = this.bankLayout();
    if (inRect(sx, sy, b.pause)) { this.paused = !this.paused; return; }
    if (this.paused) {
      const m = this.pauseMenu();
      if (inRect(sx, sy, m.resume)) this.paused = false;
      else if (inRect(sx, sy, m.restart)) this.app.startLevel(this.levelName, this.seedIds);
      else if (inRect(sx, sy, m.map)) this.app.openScreen('map');
      return;
    }
    if (inRect(sx, sy, b.speedBtn)) { this.speed = this.speed === 1 ? 2 : 1; return; }
    if (this.lastStand && this.waves && this.waves.timer === Infinity && inRect(sx, sy, b.go)) { this.waves.timer = 0; return; }
    if (inRect(sx, sy, b.shovel)) { this.shovel = !this.shovel; this.selected = null; this.pfSelected = false; return; }
    if (inRect(sx, sy, b.pf)) { if (this.plantFood > 0) { this.pfSelected = !this.pfSelected; this.selected = null; this.shovel = false; } return; }
    for (const r of b.rects) if (inRect(sx, sy, r)) {
      const s = r.s;
      if (s.cooldown > 0 || this.sun < this.cost(s)) { this.selected = null; return; }
      this.selected = this.selected === s ? null : s;
      if (this.selected) this.sfx('play_seedlift');
      this.shovel = false; this.pfSelected = false;
      return;
    }
    for (const s of this.pickups) if (!s.collecting && s.hitTest(gx, gy)) { s.collecting = true; this.sfx('play_foodpickup'); return; }
    for (const s of this.suns) if (!s.collecting && !s.stolenBy && s.hitTest(gx, gy)) { s.collecting = true; this.sfx('play_prizepickup', 0.6); return; }
    const cell = cellAt(gx, gy);
    if (!cell) return;
    const plant = this.plants.find(q => q.col === cell.col && q.row === cell.row);
    if (this.pfSelected) {
      if (plant) { plant.plantFood(); this.plantFood -= 1; this.effect('POPANIM_EFFECTS_PLANTFOOD_FX', plant.x, plant.y); this.sfx('play_foodapply'); }
      this.pfSelected = false;
      return;
    }
    if (this.shovel) {
      if (plant) { plant.die(); this.effect('POPANIM_EFFECTS_PLANT_UNPLANTED', plant.x, plant.y); this.sfx('play_shovel'); }
      this.shovel = false;
      return;
    }
    if (this.selected) {
      const s = this.selected;
      const grave = this.gridItemAt(cell.col, cell.row);
      const ok = cell.col < COLS - this.reservedCols && (s.id === 'gravebuster' ? grave && !plant : !plant && !grave && !this.mold.has(cell.col + ',' + cell.row));
      if (ok && this.sun >= this.cost(s)) {
        this.addPlant(s.id, cell.col, cell.row);
        this.sfx('play_plant');
        this.sun -= this.cost(s);
        if (this.conveyor) this.seeds = this.seeds.filter(q => q !== s);
        else { s.cooldown = s.def.props.PacketCooldown || 5; s.max = s.cooldown; }
        this.selected = null;
      }
    }
  }

  cost(s) { return this.conveyor ? 0 : (s.def.props.Cost ?? 100); }

  // ---------------------------------------------------------------- layout

  layout(w, h) {
    this.screen = { w, h };
    const bank = this.bankLayout();
    const s = h / (VIEW.y1 - VIEW.y0);
    const ox = bank.right + 26 - (LAWN_X - 40) * s;
    const oy = -VIEW.y0 * s;
    this.cam = { s, ox, oy, x: v => ox + v * s, y: v => oy + v * s };
    return this.cam;
  }

  toGame(sx, sy) { return { x: (sx - this.cam.ox) / this.cam.s, y: (sy - this.cam.oy) / this.cam.s }; }

  bankLayout() {
    const { w, h } = this.screen;
    // Fixed slot count per level so the lawn never shifts while a conveyor fills up.
    const n = this.conveyor ? 8 : Math.max(this.slotCount || (this.slotCount = this.seeds.length), 1);
    const sunH = this.conveyor ? 0 : Math.min(58, h * 0.15);
    const top = this.conveyor ? 6 : sunH + 10;
    const ph = Math.min(64, (h - top - 4 - 4 * n) / n);
    const pw = ph * 238 / 150;
    const sw = Math.max(pw, 96);
    const x = 6;
    const rects = this.seeds.map((s, i) => ({ s, x, y: top + i * (ph + 4), w: pw, h: ph }));
    const k = Math.max(0.75, Math.min(1.2, h / 420));
    const bs = 48 * k;
    return {
      rects, k, sun: { x, y: 4, w: sw, h: sunH }, right: x + (this.conveyor ? pw : sw),
      pause: { x: w - bs - 6, y: 6, w: bs, h: bs },
      speedBtn: { x: w - bs * 2 - 12, y: 6, w: bs, h: bs },
      shovel: { x: w - bs - 6, y: h - bs - 30 * k, w: bs, h: bs },
      pf: { x: w - bs * 2 - 12, y: h - bs - 30 * k, w: bs, h: bs },
      go: { x: w / 2 - 70 * k, y: h - 64 * k, w: 140 * k, h: 46 * k },
    };
  }

  pauseMenu() {
    const { w, h } = this.screen;
    const k = this.bankLayout().k, bw = 150 * k, bh = 50 * k, y = h / 2 - 20 * k;
    return {
      resume: { x: w / 2 - bw * 1.5 - 12 * k, y, w: bw, h: bh },
      restart: { x: w / 2 - bw / 2, y, w: bw, h: bh },
      map: { x: w / 2 + bw / 2 + 12 * k, y, w: bw, h: bh },
    };
  }

  // ---------------------------------------------------------------- drawing

  draw(ctx) {
    const cam = this.cam;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2b1d0e';
    ctx.fillRect(0, 0, this.screen.w, this.screen.h);
    const bg = (id, gx, gw) => {
      const s = this.assets.sprite(id);
      if (s && s.img.complete) ctx.drawImage(s.img, s.x, s.y, s.w, s.h, cam.x(gx), cam.y(0), gw * cam.s, 600 * cam.s);
    };
    bg('IMAGE_BACKGROUNDS_EGYPT_TEXTURE_LEFT', -217, 217.2);
    bg('IMAGE_BACKGROUNDS_EGYPT_TEXTURE', 0, 800);
    bg('IMAGE_BACKGROUNDS_EGYPT_TEXTURE_RIGHT', 800, 525.4);

    for (let c = COLS - this.reservedCols; c < COLS; c++) {
      const c0 = cellCenter(c, 0);
      ctx.fillStyle = 'rgba(60,20,0,0.18)';
      ctx.fillRect(cam.x(c0.x - CELL_W / 2), cam.y(LAWN_Y), CELL_W * cam.s, ROWS * CELL_H * cam.s);
    }
    for (const key of this.mold) {
      const [c, r] = key.split(',').map(Number);
      const cc = cellCenter(c, r);
      ctx.fillStyle = 'rgba(70,90,40,0.55)';
      ctx.fillRect(cam.x(cc.x - CELL_W / 2 + 3), cam.y(cc.y - CELL_H / 2 + 3), (CELL_W - 6) * cam.s, (CELL_H - 6) * cam.s);
    }
    if ((this.selected || this.pfSelected || this.shovel) && this.hover) {
      const cell = cellAt(this.hover.x, this.hover.y);
      if (cell) {
        const c = cellCenter(cell.col, cell.row);
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(cam.x(c.x - CELL_W / 2), cam.y(c.y - CELL_H / 2), CELL_W * cam.s, CELL_H * cam.s);
      }
    }

    const list = [];
    for (const g of this.gridItems) list.push({ y: g.y - 1, d: () => drawPam(ctx, cam, g.player, g.x, g.y, { x: g.props.ArtCenter?.x ?? 98, y: g.props.ArtCenter?.y ?? 127 }) });
    for (const p of this.plants) list.push({ y: p.y, d: () => p.draw(ctx, cam) });
    for (const z of this.zombies) list.push({ y: z.y + 0.5 + z.x * 1e-4, d: () => z.draw(ctx, cam) });
    for (const m of this.mowers) list.push({ y: m.y - 0.5, d: () => m.draw(ctx, cam) });
    list.sort((a, b) => a.y - b.y);
    for (const d of list) d.d();
    for (const p of this.projectiles) p.draw(ctx, cam);
    for (const e of this.effects) e.draw(ctx, cam);
    for (const s of this.pickups) s.draw(ctx, cam);
    for (const s of this.suns) s.draw(ctx, cam);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    this.drawHud(ctx);
  }

  drawHud(ctx) {
    const b = this.bankLayout();
    const k = b.k;
    const A = this.assets;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const sb = b.sun;
    if (this.conveyor) {
      // Conveyor levels have no sun: a belt column instead of the sun counter.
      ctx.fillStyle = 'rgba(40, 24, 8, 0.6)';
      roundRect(ctx, 2, 2, b.right + 2, this.screen.h - 4, 10); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(40, 24, 8, 0.82)';
      roundRect(ctx, sb.x, sb.y, sb.w, sb.h, 10); ctx.fill();
      A.drawSprite(ctx, 'IMAGE_EFFECTS_SUN_SUN_78X78', sb.x + 4, sb.y + sb.h * 0.07, sb.h * 0.86, sb.h * 0.86);
      ctx.fillStyle = '#fff6c8';
      ctx.font = `bold ${Math.round(sb.h * 0.42)}px "Trebuchet MS", sans-serif`;
      ctx.fillText(String(Math.floor(this.sun)), sb.x + sb.w * 0.62, sb.y + sb.h * 0.66);
    }
    this.hud.sunTarget = this.toGame(sb.x + sb.h * 0.45, sb.y + sb.h / 2);
    for (const r of b.rects) this.drawPacket(ctx, r);

    const btn = (r, label, on, sub) => {
      ctx.fillStyle = on ? 'rgba(220,180,90,0.95)' : 'rgba(50,30,10,0.82)';
      roundRect(ctx, r.x, r.y, r.w, r.h, 12 * k); ctx.fill();
      ctx.fillStyle = on ? '#3a2508' : '#f5e6b8';
      ctx.font = `bold ${Math.round(r.h * 0.4)}px "Trebuchet MS", sans-serif`;
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h * 0.64);
      if (sub) { ctx.fillStyle = '#f5e6b8'; ctx.font = `bold ${Math.round(r.h * 0.24)}px sans-serif`; ctx.fillText(sub, r.x + r.w / 2, r.y + r.h + 13 * k); }
    };
    btn(b.pause, this.paused ? '▶' : 'II', this.paused);
    btn(b.speedBtn, this.speed === 2 ? '2x' : '1x', this.speed === 2);
    btn(b.shovel, '⛏', this.shovel, 'SHOVEL');
    ctx.fillStyle = this.pfSelected ? 'rgba(120,230,90,0.95)' : 'rgba(30,70,20,0.85)';
    roundRect(ctx, b.pf.x, b.pf.y, b.pf.w, b.pf.h, 12 * k); ctx.fill();
    ctx.fillStyle = this.pfSelected ? '#143a06' : '#d6ffbe';
    ctx.font = `bold ${Math.round(b.pf.h * 0.26)}px sans-serif`;
    ctx.fillText('PLANT', b.pf.x + b.pf.w / 2, b.pf.y + b.pf.h * 0.44);
    ctx.fillText('FOOD', b.pf.x + b.pf.w / 2, b.pf.y + b.pf.h * 0.74);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i < this.plantFood ? '#6bff4a' : 'rgba(255,255,255,0.2)';
      ctx.beginPath(); ctx.arc(b.pf.x + b.pf.w * (0.25 + i * 0.25), b.pf.y + b.pf.h + 9 * k, 5 * k, 0, 7); ctx.fill();
    }
    this.hud.pfTarget = this.toGame(b.pf.x + b.pf.w / 2, b.pf.y + b.pf.h / 2);
    if (this.lastStand && this.waves && this.waves.timer === Infinity) btn(b.go, "LET'S ROCK!", true);

    if (this.boss && this.boss.targetable) {
      const B = this.boss;
      const bw = 220 * k, bh = 14 * k, bx = b.right + (this.screen.w - b.right) / 2 - bw / 2, by = this.screen.h - bh - 10;
      ctx.fillStyle = 'rgba(30,18,6,0.85)'; roundRect(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
      ctx.fillStyle = '#d8402a'; roundRect(ctx, bx + 2, by + 2, Math.max(bh - 4, (bw - 4) * Math.max(0, B.hp / B.maxHp)), bh - 4, (bh - 4) / 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(10 * k)}px sans-serif`;
      ctx.fillText(`DR. ZOMBOSS  ·  PHASE ${B.stage + 1} / ${B.stages.length}`, bx + bw / 2, by + bh - 3.5 * k);
    } else if (this.waves && this.waves.count) {
      const w = this.waves;
      const bw = 170 * k, bh = 16 * k, bx = b.right + (this.screen.w - b.right) / 2 - bw / 2, by = this.screen.h - bh - 8;
      ctx.fillStyle = 'rgba(30,18,6,0.8)'; roundRect(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
      ctx.fillStyle = '#9ccf3a'; roundRect(ctx, bx + 2, by + 2, Math.max(bh - 4, (bw - 4) * Math.min(1, w.index / w.count)), bh - 4, (bh - 4) / 2); ctx.fill();
      for (let i = 0; i < w.count; i++) if (this.isFlagWave(i)) { ctx.fillStyle = i < w.index ? '#f0c040' : '#d33'; ctx.fillRect(bx + (bw - 4) * ((i + 1) / w.count) - 1, by - 9 * k, 3 * k, 11 * k); }
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(11 * k)}px sans-serif`;
      ctx.fillText(`WAVE ${Math.min(w.index, w.count)} / ${w.count}`, bx + bw / 2, by + bh - 4 * k);
    }
    const cx = b.right + (this.screen.w - b.right) / 2;
    for (const m of this.messages) {
      ctx.globalAlpha = Math.min(1, m.t / 0.4);
      if (m.x != null) {
        ctx.fillStyle = '#ffe36b'; ctx.font = `bold ${Math.round(16 * k)}px sans-serif`;
        ctx.fillText(m.text, this.cam.x(m.x), this.cam.y(m.y) - (m.max - m.t) * 30);
      } else {
        ctx.fillStyle = '#ffeb7a'; ctx.strokeStyle = '#5a1a00'; ctx.lineWidth = 6 * k;
        ctx.font = `bold ${Math.round(28 * k)}px "Trebuchet MS", sans-serif`;
        ctx.strokeText(m.text, cx, this.screen.h / 2);
        ctx.fillText(m.text, cx, this.screen.h / 2);
      }
      ctx.globalAlpha = 1;
    }
    if (this.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, this.screen.w, this.screen.h);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(34 * k)}px "Trebuchet MS", sans-serif`;
      ctx.fillText('PAUSED', this.screen.w / 2, this.screen.h / 2 - 70 * k);
      const m = this.pauseMenu();
      btn(m.resume, 'RESUME', true);
      btn(m.restart, 'RESTART', false);
      btn(m.map, 'MAP', false);
      btn(b.pause, '▶', true);
    }
  }

  drawPacket(ctx, r) {
    const A = this.assets;
    const s = r.s;
    const hw = s.def.type.HomeWorld;
    const world = hw && hw !== 'tutorial' && hw !== 'modern' ? hw.toUpperCase() : null;
    const premium = this.app.isPremium ? this.app.isPremium(s.id) : false;
    if (!(world && A.drawSprite(ctx, 'IMAGE_UI_PACKETS_' + world, r.x, r.y, r.w, r.h))) A.drawSprite(ctx, premium ? 'IMAGE_UI_PACKETS_READY_PREMIUM' : 'IMAGE_UI_PACKETS_READY', r.x, r.y, r.w, r.h);
    const spr = A.sprite('IMAGE_UI_PACKETS_' + s.id.toUpperCase());
    if (spr && spr.img.complete) {
      const sc = Math.min((r.h * 0.94) / spr.h, (r.w * 0.66) / spr.w);
      ctx.drawImage(spr.img, spr.x, spr.y, spr.w, spr.h, r.x + r.w * 0.05, r.y + r.h - spr.h * sc - r.h * 0.04, spr.w * sc, spr.h * sc);
    }
    if (!this.conveyor) {
      const tw = r.w * 101 / 238, th = r.h * 71 / 150;
      const tx = r.x + r.w - tw - r.w * 0.03, ty = r.y + r.h - th - r.h * 0.04;
      A.drawSprite(ctx, premium ? 'IMAGE_UI_PACKETS_PRICE_TAB_PREMIUM' : 'IMAGE_UI_PACKETS_PRICE_TAB', tx, ty, tw, th);
      ctx.fillStyle = '#3a2508';
      ctx.font = `bold ${Math.round(th * 0.62)}px "Trebuchet MS", sans-serif`;
      ctx.fillText(String(this.cost(s)), tx + tw * 0.5, ty + th * 0.72);
    }
    if (s.cooldown > 0 || this.sun < this.cost(s)) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      const f = s.cooldown > 0 ? s.cooldown / s.max : 1;
      roundRect(ctx, r.x + 2, r.y + 2, r.w - 4, (r.h - 4) * f, 6); ctx.fill();
    }
    if (this.selected === s) A.drawSprite(ctx, 'IMAGE_UI_PACKETS_SELECTED', r.x, r.y, r.w, r.h);
  }
}

function inRect(x, y, r) { return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
