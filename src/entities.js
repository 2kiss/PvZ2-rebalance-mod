// Plants, zombies, projectiles, suns, plant food, mowers. Positions are in game units.
import { PAM_SCALE, CELL_W, CELL_H, COLS, ROWS, LAWN_X, LAWN_Y, LAWN_RIGHT, HOUSE_X, cellCenter, rowGround, rnd, rndRange } from './board.js';

const ZOMBIE_HIDE_ALWAYS = /ground_swatch|(^|\|)ink$|(^|\|)ink\||butter|particle|_particles|_board_drop|board_chunk|dust_cloud/;
const PLANT_HIDE_BASE = /custom|gatlingpea|water|crableg/;
const PLANT_HIDE_PF = /plantfood|_armor_states/;
const COLD_PLANTS = new Set(['iceburg', 'snowpea', 'coldsnapdragon', 'wintermelon']);

export function drawPam(ctx, cam, player, x, y, art, flip = false, alpha = 1, scale = 1) {
  if (!player) return;
  const s = cam.s * PAM_SCALE * scale;
  const tx = cam.x(x) - (flip ? -art.x : art.x) * cam.s * scale;
  const ty = cam.y(y) - art.y * cam.s * scale;
  player.draw(ctx, [flip ? -s : s, 0, 0, s, tx, ty], alpha);
}

// Fires animation commands crossed between two frames of the current label.
function crossCommands(player, label, from, to, cb) {
  const cmds = player.doc.commands;
  const [s, e] = player.doc.range(label);
  let f = from;
  let guard = 0;
  while (f !== to && guard++ < 400) {
    f += 1;
    if (f >= e) f = s;
    const list = cmds[f];
    if (list) for (const [name, arg] of list) cb(name, arg);
  }
}

// ================================================================ plants

export class Plant {
  constructor(game, id, col, row) {
    this.game = game;
    this.kind = 'plant';
    this.id = id;
    this.def = game.data.plant(id);
    this.props = this.def.props;
    this.col = col;
    this.row = row;
    const c = cellCenter(col, row);
    this.x = c.x;
    this.y = rowGround(row);
    this.maxHp = this.props.Hitpoints || 300;
    this.hp = this.maxHp;
    this.shield = 0;
    this.art = { x: this.props.ArtCenter?.x ?? 99, y: this.props.ArtCenter?.y ?? 115 };
    this.pfActive = false;
    this.player = game.assets.player(this.def.type.PopAnim, n => PLANT_HIDE_BASE.test(n) || (!this.pfActive && PLANT_HIDE_PF.test(n)));
    this.state = 'idle';
    this.actions = (this.props.Actions || []).filter(a => !a.SecondaryAction);
    this.secondary = (this.props.Actions || []).filter(a => a.SecondaryAction);
    this.timers = this.actions.map(a => (a.InitialMinCooldownTime != null ? a.InitialMinCooldownTime + rnd(0, 0.6) : rnd(a.CooldownTimeMin ?? 0, a.CooldownTimeMax ?? 0)));
    this.dead = false;
    this.age = 0;
    this.armedAt = this.props.TimeUntilArmed ?? 0;
    this.sunAmount = this.def.powers.SunProducer ? this.def.powers.SunProducer.Amount : 50;
    this.behavior = Plant.behaviorFor(this);
    this.behavior.init?.(this);
    if (this.state === 'idle') this.play(this.idleLabel());
  }

  static behaviorFor(p) {
    const types = p.actions.map(a => a.Type);
    const special = { potatomine: 'mine', iceburg: 'iceburg', gravebuster: 'gravebuster', bonkchoy: 'melee', wasabiwhip: 'melee',
      chomper: 'chomper', squash: 'squash', jalapeno: 'jalapeno', torchwood: 'passive', hypnoshroom: 'hypno',
      coldsnapdragon: 'breath', wallnut: 'wall', peanut: 'shooter' }[p.id];
    if (special) return Behaviors[special];
    if (types.includes('sun')) return Behaviors.sun;
    if (types.includes('projectile')) return Behaviors.shooter;
    return Behaviors.passive;
  }

  // Damaged plants (wall-nut, peanut) switch to their cracked idle labels.
  idleLabel() {
    if (this.behavior.idleLabel) return this.behavior.idleLabel;
    const f = this.hp / this.maxHp;
    if (this.id === 'wallnut') return f > 2 / 3 ? 'idle' : f > 1 / 3 ? 'damage' : 'damage2';
    if (this.id === 'peanut') return f > 2 / 3 ? 'idle' : f > 1 / 3 ? 'idle_damage1' : 'idle_damage2';
    return 'idle';
  }

  play(label, loop = true) {
    if (!this.player) return;
    if (!this.player.has(label)) label = this.player.has('idle') ? 'idle' : Object.keys(this.player.doc.labels)[0];
    this.player.play(label, loop, true);
    this.label = label;
  }

  update(dt) {
    this.age += dt;
    if (this.player) {
      const before = this.player.frame;
      this.player.update(dt);
      const after = this.player.frame;
      if (after !== before) crossCommands(this.player, this.label, before, after, (n, a) => this.onCommand(n, a));
      if (this.player.done) this.onAnimEnd();
    }
    // Wall-nut/peanut keep pfActive after plant food (armor layers stay shown) but act normally.
    if (this.pfActive && this.pf) this.updatePlantFood(dt); else this.behavior.update(this, dt);
  }

  onCommand(name, arg) {
    if (this.pfActive && this.pf && this.pf.onCommand) this.pf.onCommand(this, name, arg);
    else this.behavior.onCommand?.(this, name, arg);
  }

  onAnimEnd() {
    if (this.pfActive && this.pf) { this.pfAnimEnd(); return; }
    this.behavior.onAnimEnd?.(this);
  }

  damage(amount, src) {
    if (this.dead) return;
    if (this.shield > 0) {
      const t = Math.min(this.shield, amount);
      this.shield -= t;
      amount -= t;
      if (this.shield <= 0) this.pfActive = false;
    }
    const was = this.idleLabel();
    this.hp -= amount;
    if (this.hp <= 0) { this.die(); return; }
    if (this.state === 'idle' && this.idleLabel() !== was) this.play(this.idleLabel());
  }

  die(burnt = false) {
    if (this.dead) return;
    this.dead = true;
    if (burnt) this.game.effect('POPANIM_EFFECTS_PLANT_BURNT', this.x, this.y);
    this.game.removePlant(this);
  }

  draw(ctx, cam) {
    drawPam(ctx, cam, this.player, this.x, this.y, this.art);
  }

  targetAhead(range = Infinity) {
    let best = null;
    for (const z of this.game.zombies) {
      if (!z.inRow(this.row) || !z.targetable || z.x < this.x - 10 || z.x > LAWN_RIGHT + 20 || z.x - this.x > range) continue;
      if (!best || z.x < best.x) best = z;
    }
    return best;
  }

  zombiesInRect(rect) {
    // Trigger rects are relative to the plant's cell centre; they reach into nearby rows by height.
    const cy = this.y - CELL_H * 0.5;
    const x0 = this.x + rect.mX, x1 = x0 + rect.mWidth;
    const y0 = cy + rect.mY, y1 = y0 + rect.mHeight;
    return this.game.zombies.filter(z => {
      if (!z.targetable) return false;
      const zy = z.y - CELL_H * 0.5;
      const top = z.boss ? zy - CELL_H : zy;
      return z.x + 14 > x0 && z.x - 14 < x1 && zy + 20 > y0 && top - 20 < y1;
    });
  }

  // ---------------------------------------------------------------- plant food

  plantFood() {
    if (this.dead) return;
    this.hp = this.maxHp;
    const pf = PlantFood[this.behavior.pf || this.id] || PlantFood.generic;
    this.pf = pf;
    this.pfActive = true;
    this.pfTime = 0;
    this.pfPlays = 0;
    pf.start(this);
  }

  updatePlantFood(dt) {
    this.pfTime += dt;
    this.pf.update?.(this, dt);
  }

  pfAnimEnd() {
    if (this.pf.onAnimEnd && this.pf.onAnimEnd(this) !== false) return;
    this.endPlantFood();
  }

  endPlantFood() {
    if (this.id !== 'wallnut' && this.id !== 'peanut') this.pfActive = false;
    this.pf = null;
    this.state = 'idle';
    this.play(this.idleLabel());
  }

  // Plays the plant food intro/loop/outro labels the animation has.
  pfSequence(labels) {
    this.pfQueue = labels.filter(l => this.player && this.player.has(l));
    this.nextPf();
  }

  nextPf() {
    const l = this.pfQueue.shift();
    if (!l) return false;
    this.play(l, false);
    return true;
  }
}

const shotAction = p => p.actions.find(a => a.Type === 'projectile');

const Behaviors = {
  passive: { update() {} },

  wall: { update() {}, pf: 'wallnut' },

  shooter: {
    init(p) {
      p.shots = p.actions.filter(a => a.Type === 'projectile');
      p.shotIndex = 0;
    },
    update(p, dt) {
      if (p.state !== 'idle') return;
      p.timers[0] -= dt;
      const target = p.id === 'starfruit' ? p.game.zombies.find(z => z.targetable && z.x < LAWN_RIGHT + 20) : p.targetAhead();
      if (p.timers[0] <= 0 && target) {
        p.state = 'attack';
        p.target = target;
        const dmg = p.id === 'peanut' ? p.idleLabel().replace('idle', 'attack') : 'attack';
        p.play(p.player && p.player.has(dmg) ? dmg : 'attack', false);
        if (!p.player || !p.player.has('attack')) { this.onCommand(p, 'use_action'); this.onAnimEnd(p); }
      }
    },
    onCommand(p, name) {
      if (name !== 'use_action' && name !== 'shoot') return;
      // Kernel-pult lobs butter instead of a kernel at ButterChance.
      const a = p.props.ButterChance != null && p.shots.length > 1
        ? p.shots[Math.random() < p.props.ButterChance ? 1 : 0]
        : p.shots[p.shotIndex % p.shots.length];
      p.shotIndex += 1;
      p.game.spawnProjectile(p, a, p.target);
    },
    onAnimEnd(p) {
      if (p.state !== 'attack') return;
      p.state = 'idle';
      const a = shotAction(p);
      p.timers[0] = rnd(a.CooldownTimeMin ?? 1.4, a.CooldownTimeMax ?? 1.5);
      p.play(p.idleLabel());
    },
  },

  sun: {
    init(p) { p.timers[0] = rnd(5, 9); },
    update(p, dt) {
      if (p.state !== 'idle') return;
      p.timers[0] -= dt;
      if (p.timers[0] <= 0) {
        p.state = 'special';
        p.given = false;
        p.play('special', false);
      }
    },
    onCommand(p, name) {
      if ((name !== 'use_action' && name !== 'use_special') || p.given) return;
      p.given = true;
      const a = p.actions.find(x => x.Type === 'sun') || {};
      const n = p.id === 'twinsunflower' ? 2 : 1;
      for (let i = 0; i < n; i++) p.game.spawnSun(p.x + (a.SpawnOffset?.x || 0) + (i - (n - 1) / 2) * 18, p.y + (a.SpawnOffset?.y || -52) - 24, p.sunAmount, 'plant');
    },
    onAnimEnd(p) {
      if (p.state !== 'special') return;
      if (!p.given) this.onCommand(p, 'use_action');
      p.state = 'idle';
      const a = p.actions.find(x => x.Type === 'sun') || {};
      p.timers[0] = rnd(a.CooldownTimeMin ?? 24, a.CooldownTimeMax ?? 24);
      p.play('idle');
    },
  },

  mine: {
    init(p) { p.state = 'unarmed'; p.play('plant_idle'); },
    update(p) {
      if (p.state === 'unarmed' && p.age >= p.armedAt) { p.state = 'arming'; p.play('recover', false); }
      if (p.state === 'armed' && p.zombiesInRect(p.actions[0].RectTriggerRange).length) this.boom(p);
    },
    boom(p) {
      p.state = 'boom';
      const r = p.def.powers.DamageRadius?.DamageRadius;
      p.game.explode(p.x, p.y - 30, (r?.RadiusInGridSquareWidths || 0.88) * CELL_W, r?.DamageProps?.BaseDamage || 1800);
      p.game.sfx('play_potato_mine');
      p.game.effect('POPANIM_EFFECTS_POTATOMINE_EXPLOSION', p.x, p.y - 20);
      p.die();
    },
    onAnimEnd(p) { if (p.state === 'arming') { p.state = 'armed'; p.play('idle'); } },
  },

  iceburg: {
    update(p) {
      if (p.state !== 'idle') return;
      const hit = p.zombiesInRect(p.actions[0].RectTriggerRange);
      if (hit.length) { p.state = 'attack'; p.victims = hit; p.play('attack', false); }
    },
    onCommand(p, name) {
      if (name !== 'freeze') return;
      p.game.sfx('play_iceberglettuce_freeze');
      for (const z of p.victims || []) z.freeze(p.actions[0].FreezeDuration || 10);
    },
    onAnimEnd(p) { if (p.state === 'attack') { if (!p.victims?.some(z => z.freezeT > 0)) this.onCommand(p, 'freeze'); p.die(); } },
  },

  gravebuster: {
    init(p) { p.state = 'eat'; p.play('attack'); },
    update(p) {
      if (p.age > (p.props.GraveBusterEatTime || 4)) {
        const g = p.game.gridItemAt(p.col, p.row);
        if (g) p.game.destroyGridItem(g, true);
        p.die();
      }
    },
  },

  melee: {
    update(p, dt) {
      p.timers[0] -= dt;
      if (p.state !== 'idle') return;
      const a = p.actions[p.actions.length - 1];
      if (p.timers[0] <= 0 && p.zombiesInRect(a.RectTriggerRange).length) {
        p.state = 'attack';
        p.combo = ((p.combo || 0) + 1) % 3;
        p.play(['attack', 'attack2', 'attack3'][p.combo], false);
      }
    },
    onCommand(p, name) {
      if (name !== 'use_special' && name !== 'use_action') return;
      const a = p.actions[p.actions.length - 1];
      for (const z of p.zombiesInRect(a.RectTriggerRange)) z.damage(a.Damage || 60, p);
    },
    onAnimEnd(p) { if (p.state === 'attack') { p.state = 'idle'; p.timers[0] = 0.05; p.play('idle'); } },
  },

  chomper: {
    update(p, dt) {
      if (p.state === 'chew') {
        p.chew -= dt;
        if (p.chew <= 0) { p.state = 'swallow'; p.play('special_end', false); }
        return;
      }
      if (p.state !== 'idle') return;
      const z = p.targetAhead(CELL_W * 1.4);
      if (z) { p.state = 'bite'; p.victim = z; p.play('bite', false); }
    },
    onCommand(p, name) {
      if (name !== 'swallow' || !p.victim) return;
      if (p.victim.heavy) p.victim.damage(40, p); else p.victim.vanish();
      p.victim = null;
    },
    onAnimEnd(p) {
      if (p.state === 'bite') { if (p.victim) this.onCommand(p, 'swallow'); p.state = 'chew'; p.chew = p.props.ChewTime || 40; p.play('special_idle'); }
      else if (p.state === 'swallow') { p.state = 'idle'; p.play('idle'); }
    },
  },

  squash: {
    update(p) {
      if (p.state !== 'idle') return;
      const z = p.game.zombies.find(q => q.inRow(p.row) && q.targetable && Math.abs(q.x - p.x) < CELL_W * 1.1);
      if (z) { p.state = 'jump'; p.jumpX = z.x; p.play(z.x >= p.x ? 'jump_up_right' : 'jump_up_left', false); }
    },
    onAnimEnd(p) {
      if (p.state === 'jump') {
        const right = p.jumpX >= p.x;
        p.state = 'land';
        p.x = p.jumpX;
        p.play(right ? 'jump_down_right' : 'jump_down_left', false);
      } else if (p.state === 'land') {
        for (const z of p.game.zombies) if (z.inRow(p.row) && z.targetable && Math.abs(z.x - p.x) < CELL_W * 0.7) z.damage(1800, p);
        p.die();
      }
    },
  },

  jalapeno: {
    init(p) { p.state = 'attack'; p.play('attack', false); },
    update() {},
    onAnimEnd(p) {
      for (const z of p.game.zombies) if (z.inRow(p.row) && z.targetable && z.x > LAWN_X - 20 && z.x < LAWN_RIGHT + 40) z.burn(1800);
      p.game.laneFire(p.row);
      p.die();
    },
  },

  hypno: {
    update() {},
    onEaten(p, z) { z.hypnotize(); p.die(); },
  },

  breath: {
    update(p, dt) {
      p.timers[0] -= dt;
      if (p.state !== 'idle') return;
      if (p.targetAhead(CELL_W * 3.2) && p.timers[0] <= 0) { p.state = 'attack'; p.play('attack', false); }
    },
    onCommand(p, name) {
      if (name !== 'deal_damage') return;
      for (const z of p.game.zombies) if (z.targetable && Math.abs(z.row - p.row) <= 1 && z.x > p.x && z.x - p.x < CELL_W * 3.2) { z.damage(20, p); z.chill(4); }
    },
    onAnimEnd(p) { if (p.state === 'attack') { p.state = 'idle'; p.timers[0] = 1.5; p.play('idle'); } },
  },
};

// ---------------------------------------------------------------- plant food powers (values from each plant's props)

const PlantFood = {
  generic: {
    start(p) { p.pfSequence(['plantfood_on', 'plantfood', 'plantfood_off']); if (!p.pfQueue.length) p.endPlantFood(); },
    onAnimEnd(p) { return p.nextPf(); },
  },

  // Shooters: a fast barrage of N projectiles over D seconds.
  barrage: {
    start(p) {
      const P = p.props;
      p.pfShots = P.PlantFoodProjectileCount || 60;
      p.pfDur = P.PlantFoodDurationSeconds || 2;
      p.pfAcc = 0;
      p.pfFired = 0;
      p.play(p.player?.has('plantfood_loop') ? 'plantfood_loop' : 'plantfood');
    },
    update(p, dt) {
      p.pfAcc += dt * p.pfShots / p.pfDur;
      const a = p.shots?.[0] || shotAction(p);
      while (p.pfAcc >= 1 && p.pfFired < p.pfShots) {
        p.pfAcc -= 1;
        p.pfFired += 1;
        const pr = p.game.spawnProjectile(p, a, p.targetAhead());
        if (pr) pr.y += rnd(-6, 6);
      }
      if (p.pfFired >= p.pfShots) p.endPlantFood();
    },
    onAnimEnd() { return true; },
  },

  sunflower: {
    start(p) {
      const n = (p.props.PlantFoodSunCount || 3) * (p.id === 'twinsunflower' ? 1 : 1);
      for (let i = 0; i < n; i++) p.game.spawnSun(p.x + rnd(-30, 30), p.y - 70, p.sunAmount, 'plant');
      PlantFood.generic.start(p);
    },
    onAnimEnd(p) { return p.nextPf(); },
  },

  wallnut: {
    start(p) {
      p.shield = p.def.powers.Shield?.Hitpoints || p.props.PlantFoodShieldHitpoints || 8000;
      p.pfSequence(['plantfood_on', 'plantfood']);
    },
    onAnimEnd(p) { if (!p.nextPf()) { p.state = 'idle'; p.pf = null; p.play(p.idleLabel()); } return true; },
  },

  potatomine: {
    start(p) {
      // Arm instantly and plant two armed copies on empty cells.
      p.state = 'armed'; p.pfActive = false; p.pf = null; p.play('idle');
      for (let k = 0; k < 2; k++) {
        const free = [];
        for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (!p.game.cellBlocked(c, r)) free.push([c, r]);
        if (!free.length) break;
        const [c, r] = free[Math.floor(Math.random() * free.length)];
        const m = p.game.addPlant('potatomine', c, r);
        if (m) { m.state = 'armed'; m.play('idle'); }
      }
    },
  },

  cabbagepult: {
    start(p) {
      const a = p.secondary[0] || shotAction(p);
      for (const z of p.game.zombies.filter(z => z.targetable && z.x < LAWN_RIGHT + 30)) p.game.spawnProjectile(p, a, z, true);
      PlantFood.generic.start(p);
    },
    onAnimEnd(p) { return p.nextPf(); },
  },

  bloomerang: {
    start(p) {
      const a = shotAction(p);
      const n = p.props.PlantFoodProjectileCount || 16;
      for (let i = 0; i < n; i++) {
        const pr = p.game.spawnProjectile(p, a, null);
        if (pr) { pr.free = { vx: Math.cos(i / n * Math.PI * 2) * 300, vy: Math.sin(i / n * Math.PI * 2) * 300 }; pr.boomerang = false; }
      }
      PlantFood.generic.start(p);
    },
    onAnimEnd(p) { return p.nextPf(); },
  },

  iceburg: {
    start(p) { for (const z of p.game.zombies) if (z.targetable) z.freeze(10); PlantFood.generic.start(p); },
    onAnimEnd(p) { return p.nextPf(); },
  },

  bonkchoy: {
    start(p) { p.pfPunches = (p.props.PlantFoodPlayCount || 3) * 6; p.play('plantfood'); },
    onCommand(p, name) {
      if (name !== 'use_special') return;
      for (const z of p.game.zombies) if (z.targetable && Math.abs(z.row - p.row) <= 1 && Math.abs(z.x - p.x) < CELL_W * 1.6) z.damage(60, p);
    },
    onAnimEnd(p) {
      p.pfPlays += 1;
      if (p.pfPlays < (p.props.PlantFoodPlayCount || 3)) { p.play('plantfood', false); return true; }
      return false;
    },
  },

  chomper: {
    start(p) {
      const n = p.props.NumberOfPlantfoodTargets || 3;
      const ts = p.game.zombies.filter(z => z.targetable && !z.heavy && Math.abs(z.row - p.row) <= 1 && z.x > p.x - 20).sort((a, b) => a.x - b.x).slice(0, n);
      for (const z of ts) z.vanish();
      PlantFood.generic.start(p);
    },
    onAnimEnd(p) { return p.nextPf(); },
  },

  squash: {
    start(p) {
      const ts = p.game.zombies.filter(z => z.targetable).sort((a, b) => b.hp - a.hp).slice(0, p.props.PlantfoodZombiesToTarget || 2);
      for (const z of ts) { z.damage(1800, p); p.game.effect('POPANIM_EFFECTS_GENERIC_EXPLOSION_FRONT', z.x, z.y - 30); }
      p.endPlantFood();
    },
  },

  jalapeno: { start(p) { p.pfActive = false; p.pf = null; } },
};
for (const k of ['peashooter', 'repeater', 'snowpea', 'firepeashooter', 'starfruit', 'peanut', 'homingthistle']) PlantFood[k] = PlantFood.barrage;
PlantFood.twinsunflower = PlantFood.sunflower;

// ================================================================ zombies

export class Zombie {
  constructor(game, typeId, row, x, opts = {}) {
    this.game = game;
    this.kind = 'zombie';
    this.typeId = typeId;
    this.def = game.data.zombie(typeId);
    const P = this.def.props;
    this.props = P;
    this.cls = this.def.type.ZombieClass || 'ZombieBasic';
    this.row = row;
    this.x = x;
    this.y = rowGround(row);
    this.hp = P.Hitpoints || 190;
    this.maxHp = this.hp;
    this.baseSpeed = P.Speed || 0.185;           // grid squares per second
    this.eatDps = P.EatDPS ?? 100;
    this.art = { x: P.ArtCenter?.x ?? 90, y: P.ArtCenter?.y ?? 125 };
    this.armor = (P.ZombieArmorProps || []).map(ref => {
      const a = game.data.armor(ref);
      return a ? { def: a, hp: a.BaseHealth, max: a.BaseHealth, layers: a.ArmorLayers || [], thresholds: a.ArmorLayerHealth || [] } : null;
    }).filter(Boolean);
    this.armorLayerNames = new Set(this.armor.flatMap(a => a.layers));
    this.heavy = this.cls === 'ZombieGargantuar';
    this.labels = { walk: 'walk', eat: 'eat', idle: 'idle', die: 'die' };
    this.hiddenExtra = new Set();
    this.special = ZombieSpecials[this.cls] || null;
    this.carriesPlantFood = !!opts.plantFood;
    this.player = game.assets.player(this.def.type.PopAnim, n => this.hidden(n));
    this.state = 'walk';
    this.chillT = 0;
    this.freezeT = 0;
    this.dead = false;
    this.fade = 1;
    this.targetable = true;
    this.hypno = false;
    this.eating = null;
    this.special?.init?.(this, opts);
    this.track = trackFor(this.player, this.labels.walk);
    this.setAnim(this.labels.walk);
    if (this.player) this.player.t = Math.random() * 1.5;
  }

  get speed() { return this.baseSpeed * CELL_W; }

  inRow(r) { return this.row === r; }

  setAnim(label, loop = true) {
    if (!this.player) return;
    if (!this.player.has(label)) label = this.player.has(this.labels.walk) ? this.labels.walk : 'idle';
    if (this.player.label === label && this.player.loop === loop && !this.player.done) return;
    this.player.play(label, loop, true);
    this.label = label;
    if (label === this.labels.walk) this.track = trackFor(this.player, label);
  }

  hidden(name) {
    if (ZOMBIE_HIDE_ALWAYS.test(name)) return true;
    const leaf = name.slice(name.lastIndexOf('|') + 1);
    if (this.hiddenExtra.has(leaf)) return true;
    if (this.special?.hide && this.special.hide(this, leaf)) return true;
    if (/(^|_)armor|brick|sarcophagus_(norm|damage)/.test(leaf) && !/_states$/.test(leaf)) {
      // Show only the current damage layer of each armor piece still on.
      for (const a of this.armor) {
        if (!a.layers.includes(leaf)) continue;
        if (a.hp <= 0) return true;
        const frac = a.hp / a.max;
        let idx = 0;
        a.thresholds.forEach((t, i) => { if (frac < t) idx = i + 1; });
        return a.layers[Math.min(idx, a.layers.length - 1)] !== leaf;
      }
      return true;  // armor layers of armor this zombie does not wear
    }
    return false;
  }

  get rate() {
    if (this.freezeT > 0) return 0;
    return this.chillT > 0 ? 0.5 : 1;
  }

  update(dt) {
    if (this.chillT > 0) this.chillT -= dt;
    if (this.dead) {
      if (this.player) this.player.update(dt);
      if (!this.player || this.player.done || !this.player.has(this.labels.die)) this.fade -= dt * 1.6;
      if (this.fade <= 0) this.removed = true;
      return;
    }
    if (this.freezeT > 0) { this.freezeT -= dt; if (this.butterT > 0) this.butterT -= dt; return; }
    const r = this.rate;
    if (this.special?.update && this.special.update(this, dt * r) === true) return;
    if (this.state === 'walk') {
      const target = this.hypno ? this.game.zombieAhead(this) : this.game.plantBlocking(this);
      if (target) { this.eating = target; this.state = 'eat'; this.setAnim(this.labels.eat); }
      else this.walk(dt * r);
    } else if (this.state === 'eat') {
      const t = this.eating;
      const still = this.hypno ? this.game.zombieAhead(this) : this.game.plantBlocking(this);
      if (!t || t.dead || still !== t) {
        this.eating = null; this.state = 'walk'; this.setAnim(this.labels.walk);
      } else {
        if (this.special?.bite && this.special.bite(this, t) === true) return;
        if (!this.hypno && t.behavior?.onEaten) { t.behavior.onEaten(t, this); return; }
        t.damage(this.eatDps * dt * r, this);
        this.chompT = (this.chompT || 0) - dt * r;
        if (this.chompT <= 0) { this.chompT = 0.45; this.game.sfx('play_chomp', 0.55); }
        if (t.dead) this.game.sfx('play_gulp');
        this.player?.update(dt * r);
      }
    } else if (this.player) {
      this.player.update(dt * r);
    }
    if (!this.hypno && this.x < HOUSE_X) this.game.zombieReachedHouse(this);
    if (this.hypno && this.x > LAWN_RIGHT + 80) this.removed = true;
  }

  walk(dt) {
    const dir = this.hypno ? -1 : 1;
    if (!this.player || !this.track) { this.x -= dir * this.speed * dt; this.player?.update(dt); return; }
    // Ground track: advance by the animation's ground_swatch travel so feet never slide,
    // with playback scaled so the average matches the data speed.
    const tr = this.track;
    const scale = tr.speed > 0 ? this.speed / tr.speed : 1;
    const before = tr.at(this.player);
    this.player.update(dt * scale);
    let d = tr.at(this.player) - before;
    if (d < -1) d += tr.loop;
    this.x -= dir * Math.max(0, d) * PAM_SCALE;
  }

  damage(amount, src, flags = {}) {
    if (this.dead || this.hypno && !flags.any) return;
    let left = amount;
    if (!flags.bypassArmor) {
      for (const a of this.armor) {
        if (a.hp <= 0) continue;
        const take = Math.min(a.hp, left);
        a.hp -= take;
        left = (a.def.ArmorFlags || []).includes('absorboverflow') && a.hp <= 0 ? 0 : left - take;
        if (a.hp <= 0) this.special?.armorLost?.(this, a);
        if (left <= 0) break;
      }
    }
    this.hp -= left;
    this.special?.onDamage?.(this);
    if (flags.cold) this.special?.onCold?.(this);
    if (this.hp <= 0) this.die(flags.fire);
  }

  burn(amount) { this.damage(amount, null, { bypassArmor: true, fire: true }); }

  chill(t) { this.chillT = Math.max(this.chillT, t); this.special?.onCold?.(this); }

  freeze(t) { this.freezeT = Math.max(this.freezeT, t); this.chill(t + 6); }

  // Buttered: stops in place without the chill tint.
  stun(t) { if (this.heavy) t *= 0.5; this.freezeT = Math.max(this.freezeT, t); this.butterT = Math.max(this.butterT || 0, t); }

  hypnotize() {
    this.hypno = true;
    this.state = 'walk';
    this.eating = null;
    this.setAnim(this.labels.walk);
  }

  vanish() { if (this.dead) return; this.dead = true; this.targetable = false; this.removed = true; this.game.onZombieKilled(this); }

  die(ash = false) {
    if (this.dead) return;
    this.dead = true;
    this.targetable = false;
    this.game.sfx('play_limbs_pop', 0.6);
    this.special?.onDie?.(this);
    if (ash) {
      this.game.effect(this.heavy ? 'POPANIM_EFFECTS_ZOMBIE_GARGANTUAR_ASH' : this.cls === 'ZombieImp' ? 'POPANIM_EFFECTS_ZOMBIE_IMP_ASH' : 'POPANIM_EFFECTS_ZOMBIE_ASH', this.x, this.y);
      this.removed = true;
    } else if (this.player && this.player.has(this.labels.die)) this.setAnim(this.labels.die, false);
    else this.fade = 0.6;
    this.game.onZombieKilled(this);
  }

  draw(ctx, cam) {
    const alpha = Math.max(0, Math.min(1, this.fade));
    drawPam(ctx, cam, this.player, this.x, this.y, this.art, this.hypno, alpha);
    const tint = this.butterT > 0 ? 'rgba(255,220,70,0.35)' : this.freezeT > 0 ? 'rgba(170,225,255,0.45)' : this.chillT > 0 ? 'rgba(110,180,255,0.28)' : this.carriesPlantFood && !this.dead ? 'rgba(90,255,90,0.25)' : this.hypno ? 'rgba(220,90,255,0.25)' : null;
    if (tint) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.ellipse(cam.x(this.x), cam.y(this.y - 52), 26 * cam.s, 58 * cam.s, 0, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

// Ground-track sampler for a zombie walk cycle.
function trackFor(player, label) {
  if (!player || !player.has(label)) return null;
  const doc = player.doc;
  const swIdx = doc.sprites.findIndex(s => s.name === 'ground_swatch');
  if (swIdx < 0) return null;
  const [s, e] = doc.range(label);
  const xs = [];
  for (let f = s; f < e; f++) {
    const o = doc.main.states[f].find(q => q.isSprite && q.res === swIdx);
    xs.push(o ? o.m[4] : (xs.length ? xs[xs.length - 1] : 0));
  }
  const loop = xs[xs.length - 1] - xs[0];
  if (!(loop > 1)) return null;
  const n = e - s;
  return {
    loop,
    speed: loop / (n / doc.fps) * PAM_SCALE,
    at(p) {
      const k = (((p.t * doc.fps) % n) + n) % n;
      const i = Math.floor(k), fr = k - i;
      const a = xs[i], b = xs[Math.min(i + 1, n - 1)];
      return a + (b - a) * fr;
    },
  };
}

// Per-class zombie behaviour, keyed by ZombieClass from ZombieTypes.
const ZombieSpecials = {
  ZombieRa: {
    init(z) { z.stolen = 0; z.cool = rnd(2, 4); },
    update(z, dt) {
      if (z.state === 'power') {
        z.player?.update(dt);
        const suns = z.game.suns.filter(s => !s.collecting && !s.stolenBy);
        for (const s of suns) { s.stolenBy = z; }
        if (z.player?.done) {
          if (z.label === 'power_up') z.setAnim('power');
          else if (z.label === 'power_down') { z.state = 'walk'; z.setAnim(z.labels.walk); z.cool = rnd(5, 8); }
        }
        if (z.label === 'power' && !z.game.suns.some(s => s.stolenBy === z)) z.setAnim('power_down', false);
        return true;
      }
      z.cool -= dt;
      if (z.cool <= 0 && z.state === 'walk' && z.stolen < (z.props.MaxClaimedSunCurrency || 250) && z.x < LAWN_RIGHT && z.game.suns.some(s => !s.collecting && !s.stolenBy)) {
        z.state = 'power';
        z.setAnim('power_up', false);
        return true;
      }
      return false;
    },
    onDie(z) {
      for (const s of z.game.suns) if (s.stolenBy === z) s.stolenBy = null;
      let left = z.stolen;
      while (left > 0) { const v = Math.min(50, left); z.game.spawnSun(z.x + rnd(-20, 20), z.y - 60, v, 'plant'); left -= v; }
    },
  },

  ZombieExplorer: {
    init(z) { z.torch = true; },
    hide(z, leaf) { return !z.torch && /torch_fire|torch_end_lit/.test(leaf); },
    onCold(z) { z.torch = false; },
    bite(z, plant) {
      if (!z.torch) return false;
      if (COLD_PLANTS.has(plant.id)) { z.torch = false; return false; }
      plant.die(true);
      return true;
    },
  },

  ZombieTombRaiser: {
    init(z) { z.ammo = z.props.Ammo ?? 5; z.cool = (z.props.TimeBetweenRaisings || 6) * 0.6; },
    update(z, dt) {
      if (z.state === 'throw') {
        const before = z.player.frame;
        z.player.update(dt);
        crossCommands(z.player, z.label, before, z.player.frame, n => { if (n === 'throw') this.raise(z); });
        if (z.player.done) { if (!z.raised) this.raise(z); z.state = 'walk'; z.setAnim(z.labels.walk); }
        return true;
      }
      z.cool -= dt;
      if (z.cool <= 0 && z.ammo > 0 && z.state === 'walk' && z.x < LAWN_RIGHT - 10) {
        z.cool = z.props.TimeBetweenRaisings || 6;
        z.state = 'throw';
        z.raised = false;
        z.setAnim('power', false);
        return true;
      }
      return false;
    },
    raise(z) {
      if (z.raised) return;
      z.raised = true;
      // Ammo counts bones: each throw lobs NumberOfTombsToSpawn of them, one gravestone per bone.
      const n = Math.min(z.ammo, z.props.NumberOfTombsToSpawn || 2);
      z.ammo -= n;
      const zc = Math.floor((z.x - LAWN_X) / CELL_W);
      for (let k = 0; k < n; k++) {
        for (let tries = 0; tries < 12; tries++) {
          const c = Math.max(2, Math.min(COLS - 1, zc - 1 - Math.floor(Math.random() * 4)));
          const r = Math.floor(Math.random() * ROWS);
          if (!z.game.cellBlocked(c, r)) { z.game.addGridItem('gravestone_egypt', c, r, true); break; }
        }
      }
    },
  },

  ZombiePharaoh: {
    init(z) { z.labels = { walk: 'walk', eat: 'eat', idle: 'idle', die: 'die' }; },
    armorLost(z) {
      z.labels = { walk: 'walk_norm', eat: 'eat_norm', idle: 'idle_norm', die: 'die' };
      z.state = 'break';
      z.setAnim('break_power', false);
    },
    update(z, dt) {
      if (z.state !== 'break') return false;
      z.player.update(dt);
      if (z.player.done) { z.baseSpeed = z.props.RunSpeed || 0.5; z.state = 'walk'; z.setAnim(z.labels.walk); }
      return true;
    },
  },

  ZombieGargantuar: {
    init(z) {
      const t = (z.props.HealthThresholdToImpAmmoLayers || [])[0];
      z.impAt = t ? t.HealthPercentThrowImp : 0.5;
      z.impLayers = t ? t.ProjectileLayersToHide : [];
      z.impThrown = false;
    },
    hide(z, leaf) { return /ground_swatch_plane|Gargantuar_Head_Particle/.test(leaf); },
    update(z, dt) {
      if (z.state === 'smash' || z.state === 'throw') {
        const before = z.player.frame;
        z.player.update(dt);
        crossCommands(z.player, z.label, before, z.player.frame, n => {
          if (n === 'smash_left') this.smash(z);
          if (n === 'cannon_fire' || n === 'fire') this.throwImp(z);
        });
        if (z.player.done) {
          if (z.state === 'smash' && !z.smashed) this.smash(z);
          if (z.state === 'throw' && !z.impThrown) this.throwImp(z);
          z.state = 'walk'; z.setAnim(z.labels.walk);
        }
        return true;
      }
      if (!z.impThrown && z.hp / z.maxHp <= z.impAt && z.x > LAWN_X + CELL_W * 3) {
        z.state = 'throw';
        z.setAnim(z.player.has('cannon_fire') ? 'cannon_fire' : 'fire', false);
        return true;
      }
      const p = z.game.plantBlocking(z);
      if (p) { z.state = 'smash'; z.smashed = false; z.setAnim('smash_left', false); return true; }
      return false;
    },
    smash(z) {
      if (z.smashed) return;
      z.smashed = true;
      const p = z.game.plantBlocking(z);
      if (p) p.die();
    },
    throwImp(z) {
      if (z.impThrown) return;
      z.impThrown = true;
      for (const l of z.impLayers) z.hiddenExtra.add(l);
      const tx = Math.max(LAWN_X + CELL_W * 0.5, z.x - CELL_W * rnd(3.5, 5));
      const imp = z.game.addZombie('egypt_imp', z.row, tx);
      if (imp) imp.landFrom(z.x, z.y - 150);
    },
  },

  ZombieImp: {
    init(z) { z.flying = 0; },
    update(z, dt) {
      if (z.flying > 0) {
        z.flying -= dt;
        const k = 1 - Math.max(0, z.flying) / z.flyTime;
        z.x = z.fx + (z.tx - z.fx) * k;
        z.yOff = -Math.sin(Math.PI * k) * 120;
        z.player?.update(dt);
        if (z.flying <= 0) { z.yOff = 0; z.state = 'land'; z.setAnim('land', false); }
        return true;
      }
      if (z.state === 'land') { z.player?.update(dt); if (!z.player || z.player.done) { z.state = 'walk'; z.setAnim(z.labels.walk); } return true; }
      return false;
    },
  },

  ZombieCamel: {
    init(z, opts) { z.segment = opts.segment || 'head'; },
    hide(z, leaf) {
      const m = leaf.match(/^_zombie_camel_board_(head|hump|tail)_(norm|damage1|damage2|states)$/) || leaf.match(/^zombie_camel_board_(head|hump|tail)_etching/);
      if (!m) return false;
      if (m[1] !== z.segment) return true;
      if (!m[2] || m[2] === 'states') return false;
      const f = z.hp / z.maxHp;
      const want = f > 2 / 3 ? 'norm' : f > 1 / 3 ? 'damage1' : 'damage2';
      return m[2] !== want;
    },
  },
};

// Thrown imps fly over plants before landing.
Zombie.prototype.landFrom = function (fx, fy) {
  this.fx = fx; this.tx = this.x; this.x = fx;
  this.flyTime = 1.1;
  this.flying = this.flyTime;
  this.setAnim(this.player?.has('fly') ? 'fly' : this.labels.walk);
};

const _zdraw = Zombie.prototype.draw;
Zombie.prototype.draw = function (ctx, cam) {
  if (this.yOff) { const y = this.y; this.y += this.yOff; _zdraw.call(this, ctx, cam); this.y = y; } else _zdraw.call(this, ctx, cam);
};

// ================================================================ projectiles

const IMPACT_SOUND = [[/Fire/, 'play_firepeashooter_impact'], [/Cabbage/, 'play_cabbagepult_impact'], [/Melon/, 'play_plant_melonpult_impact'],
  [/Bloomerang/, 'play_plant_bloomerange_impact'], [/Thistle/, 'play_plant_thistle_impact'], [/Kernel|Butter/, 'play_cabbagepult_impact'], [/./, 'play_splat']];

export class Projectile {
  constructor(game, owner, action, target, opts = {}) {
    this.game = game;
    this.ref = action.Projectile;
    this.def = game.data.projectile(action.Projectile) || {};
    this.row = owner.row;
    this.owner = owner;
    this.x = owner.x + (action.SpawnOffset?.x || 0);
    this.y = owner.y + (action.SpawnOffset?.y || -32);
    this.ground = rowGround(this.row);
    this.damage = this.def.BaseDamage || 20;
    const v = this.def.InitialVelocity || [];
    this.vx = rndRange(v[0]) || 333;
    const flags = this.def.DamageFlags || [];
    this.boomerang = this.def.ClassName === 'BloomerangProjectile';
    this.lob = flags.includes('lobbed') && !this.boomerang;
    this.hostile = !!opts.hostile;
    this.hits = 0;
    this.hitSet = new Set();
    this.dir = 1;
    this.fire = /Fire/.test(this.ref);
    this.cold = /Snow|Ice/.test(this.ref);
    this.homing = /Thistle/.test(this.ref);
    this.target = target;
    if (this.lob) {
      const lp = (opts.pf ? owner.props.PlantfoodLaunchProps : owner.props.NormalLaunchProps) || {};
      this.t = 0;
      this.tof = (lp.TimeOfFlight || 1.2) * (1 + rnd(-1, 1) * (lp.TimeOfFlightVariance || 0));
      this.x0 = this.x; this.y0 = this.y;
      this.tx = target ? target.x - 8 : this.x + CELL_W * 4;
      this.h = (lp.LobHeight || 350) * 0.5;
    }
    this.setPam(this.def.AttachedPAM, this.def.AttachedPAMAnimationToPlay);
    this.dead = false;
  }

  setPam(id, labels) {
    this.player = id ? this.game.assets.player(id, () => false) : null;
    if (this.player) {
      const l = (labels || []).find(a => this.player.has(a)) || Object.keys(this.player.doc.labels)[0];
      this.player.play(l);
    }
    this.offset = this.def.AttachedPAMOffset || { x: -112, y: -112 };
  }

  update(dt) {
    this.player?.update(dt);
    if (this.free) {
      this.x += this.free.vx * dt; this.y += this.free.vy * dt;
      if (this.x < LAWN_X - 60 || this.x > LAWN_RIGHT + 80 || this.y < LAWN_Y - 80 || this.y > LAWN_Y + ROWS * CELL_H + 40) { this.dead = true; return; }
      for (const z of this.game.zombies) if (z.targetable && !z.hypno && Math.abs(z.x - this.x) < 22 && Math.abs((z.y - 45) - this.y) < 40) { this.hit(z); return; }
      return;
    }
    if (this.lob) {
      this.t += dt;
      const k = Math.min(1, this.t / this.tof);
      if (this.target && this.target.targetable) this.tx = this.target.x - 6;
      this.x = this.x0 + (this.tx - this.x0) * k;
      this.y = this.y0 + (this.ground - 46 - this.y0) * k - Math.sin(Math.PI * k) * this.h;
      if (k >= 1) {
        const z = this.game.zombies.find(q => q.inRow(this.row) && q.targetable && !q.hypno && Math.abs(q.x - this.x) < 42);
        if (z) this.hit(z); else this.dead = true;
      }
      return;
    }
    if (this.homing) {
      if (!this.target || !this.target.targetable) this.target = this.game.zombies.find(z => z.targetable && !z.hypno && z.x < LAWN_RIGHT + 20);
      if (this.target) {
        const dx = this.target.x - this.x, dy = (this.target.y - 50) - this.y;
        const d = Math.hypot(dx, dy) || 1;
        this.x += dx / d * this.vx * dt; this.y += dy / d * this.vx * dt;
        if (d < 22) this.hit(this.target);
        return;
      }
    }
    this.x += this.vx * this.dir * dt;
    if (this.boomerang) {
      if (this.dir > 0 && this.x > LAWN_RIGHT + 10) this.dir = -1;
      if (this.dir < 0 && this.x < this.owner.x) { this.dead = true; return; }
    } else if (this.x > LAWN_RIGHT + 70) { this.dead = true; return; }
    // Straight shots hit gravestones in their lane.
    if (!this.boomerang) {
      const g = this.game.gridItems.find(q => q.row === this.row && q.blocksShots && Math.abs(q.x - this.x) < 18);
      if (g) { this.game.damageGridItem(g, this.damage); this.impact(); this.dead = true; return; }
    }
    // Torchwood lights peas passing through it.
    if (!this.fire && !this.boomerang && /^RTID\(Pea/.test(this.ref)) {
      const t = this.game.plants.find(p => p.id === 'torchwood' && p.row === this.row && Math.abs(p.x - this.x) < 16);
      if (t) {
        this.fire = true; this.cold = false; this.damage *= 2;
        const fp = this.game.data.projectile('RTID(FirePeaDefault@ProjectileTypes)');
        if (fp) { this.def = fp; this.setPam(fp.AttachedPAM, fp.AttachedPAMAnimationToPlay); }
      }
    }
    for (const z of this.game.zombies) {
      if (!z.inRow(this.row) || !z.targetable || z.hypno || this.hitSet.has(z)) continue;
      if (Math.abs(z.x - this.x) < 18) { this.hit(z); if (this.dead) return; }
    }
  }

  impact() {
    this.game.sfx(IMPACT_SOUND.find(([re]) => re.test(this.ref))?.[1] || 'play_splat', 0.7);
    const imp = this.def.ImpactPAM;
    if (imp) this.game.effect(imp, this.x, this.y, this.def.ImpactPAMAnimationToPlay);
  }

  hit(z) {
    z.damage(this.damage, this.owner, { fire: false, cold: this.cold });
    for (const c of this.def.Conditions || []) if (c.Condition === 'butter') z.stun?.(rndRange(c.Duration) || 4);
    if (this.def.SplashDamage) {
      const r = Math.sqrt(this.def.SplashRadius || 1) * CELL_W;
      for (const o of this.game.zombies) if (o !== z && o.targetable && !o.hypno && Math.abs(o.row - z.row) <= 1 && Math.abs(o.x - z.x) <= r) o.damage(this.def.SplashDamage, this.owner);
    }
    if (this.cold) z.chill(10);
    if (this.fire) z.chillT = 0;
    this.impact();
    if (this.boomerang) {
      this.hitSet.add(z);
      if (++this.hits >= (this.owner.props.BoomerangHitCount || 3)) this.dir = -1;
      return;
    }
    this.dead = true;
  }

  draw(ctx, cam) {
    if (!this.player) {
      const spr = this.def.RenderImage && this.game.assets.sprite(this.def.RenderImage);
      if (spr && spr.img.complete) {
        const w = spr.w * PAM_SCALE * 0.5 * cam.s, h = spr.h * PAM_SCALE * 0.5 * cam.s;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(spr.img, spr.x, spr.y, spr.w, spr.h, cam.x(this.x) - w / 2, cam.y(this.y) - h / 2, w, h);
      }
      return;
    }
    drawPam(ctx, cam, this.player, this.x, this.y, { x: -this.offset.x * PAM_SCALE, y: -this.offset.y * PAM_SCALE });
  }
}

// ================================================================ effects, sun, plant food pickups, mowers

export class Effect {
  constructor(game, id, x, y, labels) {
    this.player = game.assets.player(id, () => false);
    this.x = x; this.y = y;
    this.dead = !this.player;
    if (this.player) {
      const l = (labels || []).find(n => this.player.has(n)) || Object.keys(this.player.doc.labels)[0];
      this.player.play(l, false);
    }
    this.life = 4;
  }

  update(dt) {
    if (!this.player) return;
    this.player.update(dt);
    this.life -= dt;
    if (this.player.done || this.life <= 0) this.dead = true;
  }

  draw(ctx, cam) { drawPam(ctx, cam, this.player, this.x, this.y, { x: 0, y: 0 }); }
}

export class Sun {
  constructor(game, x, y, amount, source) {
    this.game = game;
    this.x = x; this.y = y;
    this.amount = amount;
    this.source = source;
    this.player = game.assets.player('POPANIM_EFFECTS_SUN', () => false);
    this.player?.play(Object.keys(this.player.doc.labels)[0]);
    this.vy = source === 'sky' ? 45 : -140;
    this.vx = source === 'sky' ? 0 : rnd(-35, 35);
    this.groundY = source === 'sky' ? rnd(LAWN_Y + 60, LAWN_Y + ROWS * CELL_H - 20) : y + rnd(36, 56);
    this.life = 9.5;
    this.collecting = false;
    this.stolenBy = null;
    this.dead = false;
    this.scale = amount >= 50 ? 1 : 0.7;
  }

  update(dt) {
    this.player?.update(dt);
    const fly = (tx, ty, onArrive) => {
      const dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy);
      const step = Math.max(420, d * 3.5) * dt;
      if (d <= step) { onArrive(); return; }
      this.x += dx / d * step; this.y += dy / d * step;
    };
    if (this.collecting) { fly(this.game.hud.sunTarget.x, this.game.hud.sunTarget.y, () => { this.dead = true; this.game.sun += this.amount; }); return; }
    if (this.stolenBy) {
      const z = this.stolenBy;
      if (z.dead) { this.stolenBy = null; return; }
      fly(z.x - 10, z.y - 120, () => { this.dead = true; z.stolen += this.amount; });
      return;
    }
    if (this.source === 'sky') {
      if (this.y < this.groundY) this.y += this.vy * dt; else this.life -= dt;
    } else {
      this.vy += 420 * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (this.y >= this.groundY && this.vy > 0) { this.y = this.groundY; this.vy = 0; this.vx = 0; this.source = 'landed'; }
      if (this.source === 'landed') this.life -= dt;
    }
    if (this.life <= 0) this.dead = true;
  }

  hitTest(x, y) { return Math.hypot(x - this.x, y - this.y) < 40 * this.scale + 6; }

  draw(ctx, cam) {
    const a = this.life < 1.5 && !this.collecting ? Math.max(0.2, this.life / 1.5) : 1;
    drawPam(ctx, cam, this.player, this.x, this.y, { x: 0, y: 0 }, false, a, this.scale);
  }
}

export class PlantFoodPickup {
  constructor(game, x, y) {
    this.game = game;
    this.x = x; this.y = y;
    this.player = game.assets.player('POPANIM_EFFECTS_PLANTFOOD_PICKUP', () => false);
    this.player?.play(Object.keys(this.player.doc.labels)[0]);
    this.life = 12;
    this.collecting = false;
    this.dead = false;
  }

  update(dt) {
    this.player?.update(dt);
    if (this.collecting) {
      const t = this.game.hud.pfTarget || this.game.hud.sunTarget;
      const dx = t.x - this.x, dy = t.y - this.y, d = Math.hypot(dx, dy), step = Math.max(420, d * 3.5) * dt;
      if (d <= step) { this.dead = true; this.game.plantFood = Math.min(3, this.game.plantFood + 1); return; }
      this.x += dx / d * step; this.y += dy / d * step;
      return;
    }
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }

  hitTest(x, y) { return Math.hypot(x - this.x, y - (this.y - 20)) < 44; }

  draw(ctx, cam) {
    const a = this.life < 2 && !this.collecting ? Math.max(0.25, this.life / 2) : 1;
    if (this.player) { drawPam(ctx, cam, this.player, this.x, this.y, { x: 0, y: 0 }, false, a); return; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = a; ctx.fillStyle = '#3fd13a';
    ctx.beginPath(); ctx.arc(cam.x(this.x), cam.y(this.y - 20), 18 * cam.s, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export class Mower {
  constructor(game, row) {
    this.game = game;
    this.row = row;
    this.x = LAWN_X - 52;
    this.y = rowGround(row);
    this.player = game.assets.player('POPANIM_MOWERS_MOWER_EGYPT', () => false);
    this.player?.play('idle');
    this.active = false;
    this.dead = false;
  }

  trigger() {
    if (this.active) return;
    this.active = true;
    this.game.sfx('play_ui_game_mower_appear_single');
    if (this.player?.has('attack')) this.player.play('attack');
  }

  update(dt) {
    this.player?.update(dt);
    if (!this.active) return;
    this.x += 330 * dt;
    for (const z of this.game.zombies) if (!z.boss && z.row === this.row && z.targetable && !z.hypno && Math.abs(z.x - this.x) < 40) z.damage(99999, this, { bypassArmor: true });
    if (this.x > LAWN_RIGHT + 140) this.dead = true;
  }

  draw(ctx, cam) { drawPam(ctx, cam, this.player, this.x, this.y, { x: 22, y: 118 }); }
}
