// Dr. Zomboss's Egypt mech (Egypt day 25). Driven by ZombieZombossMechEgyptProps:
// three stages, each with its own hit points, animation rate and weighted ZombieActions
// (walk + squash, zombie portal, rush, rocket barrage), stun when a rush is interrupted,
// and a retreat jump between stages.
import { CELL_W, COLS, ROWS, LAWN_X, cellCenter, rowGround, rnd } from './board.js';
import { drawPam } from './entities.js';

const FX = 'POPANIM_EFFECTS_ZOMBOSS_MISSILE_EXPLOSION_EGYPT';
const pickInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export class Zomboss {
  constructor(game, typeId, mod) {
    this.game = game;
    this.kind = 'zombie';
    this.boss = true;
    this.heavy = true;
    this.typeId = typeId;
    this.def = game.data.zombie(typeId);
    const P = this.def.props;
    this.props = P;
    this.stages = P.Stages || [{ HitPoints: 4000, Actions: [], AnimRateModifier: 1 }];
    this.stage = 0;
    this.maxHp = this.stages[0].HitPoints;
    this.hp = this.maxHp;
    this.armor = [];
    this.hypno = false;
    this.dead = false;
    this.removed = false;
    this.finished = false;
    this.targetable = false;
    this.carriesPlantFood = false;
    const sp = mod.ZombossSpawnGridPosition || { mX: 6, mY: 3 };
    this.home = { col: sp.mX, row: Math.max(1, Math.min(ROWS - 1, sp.mY)) };
    this.col = this.home.col;          // centre column of the 3-wide footprint
    this.row = this.home.row;          // front (lower) row of the 2-tall footprint
    this.minCol = P.MinColumn ?? 5;
    this.maxCol = Math.min(P.MaxColumn ?? 7, COLS - 2);
    this.art = { x: P.ArtCenter?.x ?? 30, y: P.ArtCenter?.y ?? 130 };
    this.dmgIndex = 0;
    this.player = game.assets.player(this.def.type.PopAnim, n => this.hidden(n));
    this.place();
    this.state = 'hidden';
    this.timer = 1.2;
    this.chillT = 0;
    this.freezeT = 0;
    this.flash = 0;
    this.rushDamage = 0;
    this.spawned = [];
    this.spawnedHp = 0;
  }

  get stageDef() { return this.stages[this.stage]; }
  get rate() { return (this.stageDef.AnimRateModifier || 1) * (this.chillT > 0 ? 0.5 : 1); }
  inRow(r) { return r === this.row || r === this.row - 1; }
  footprint(col = this.col, row = this.row) {
    const cells = [];
    for (let c = col - 1; c <= col + 1; c++) for (const r of [row - 1, row]) if (c >= 0 && c < COLS && r >= 0 && r < ROWS) cells.push([c, r]);
    return cells;
  }
  anchor(col, row) { return { x: cellCenter(col - 1, row).x, y: rowGround(row) }; }
  place() { const a = this.anchor(this.col, this.row); this.x = a.x; this.y = a.y; }

  hidden(name) {
    if (/ground_swatch/.test(name)) return true;
    const m = name.match(/_State_(\d)$/);
    if (m) return +m[1] !== this.dmgIndex;
    if (/White|Silhouette/.test(name)) return !/^die/.test(this.label || '');
    return false;
  }

  play(label, loop = true) {
    if (!this.player) return;
    this.player.play(label, loop, true);
    this.label = label;
  }

  // ---------------------------------------------------------------- damage

  damage(amount, src, flags = {}) {
    if (!this.targetable || this.dead) return;
    amount = Math.min(amount, 900);   // instant-kill plants only chip a boss
    if (this.state === 'stun') amount *= this.stageDef.StunDamageScale || 1.5;
    this.hp -= amount;
    this.flash = 0.12;
    if (this.state === 'rush_lead' || this.state === 'rush') {
      this.rushDamage += amount;
      if (this.rushDamage >= (this.action?.RushDamageToInterrupt ?? 100)) this.stagger();
    }
    if (flags.cold) this.chillT = Math.max(this.chillT, 3);
    if (this.hp <= 0) this.stageCleared();
  }

  burn(amount) { this.damage(amount, null, { fire: true }); }
  chill(t) { this.chillT = Math.max(this.chillT, Math.min(t, this.stageDef.ChilledDurationFromFrozen || 10)); }
  freeze(t) { this.freezeT = Math.max(this.freezeT, Math.min(t, 2.5)); this.chill(this.stageDef.ChilledDurationFromFrozen || 10); }
  stun(t) { this.freezeT = Math.max(this.freezeT, Math.min(t, 1.5)); }
  hypnotize() {}
  vanish() {}
  die() {}

  stageCleared() {
    if (this.stage + 1 < this.stages.length) {
      this.stage += 1;
      this.maxHp = this.stageDef.HitPoints;
      this.hp = this.maxHp;
      this.dmgIndex = this.stageDef.DamageIndexFull ?? this.stage * 3;
      this.game.message(this.stage + 1 === this.stages.length ? 'FINAL PHASE!' : 'PHASE ' + (this.stage + 1), 2.5);
      this.stagger(true);
      return;
    }
    this.hp = 0;
    this.dead = true;
    this.targetable = false;
    this.state = 'die';
    this.dieSeq = ['die', 'die_idle', 'die_exit'];
    this.play(this.dieSeq.shift(), false);
    for (const z of this.game.zombies) if (z !== this && !z.dead && !z.hypno) z.die(true);
  }

  // ---------------------------------------------------------------- actions

  stagger(retreat = false) {
    this.retreatAfter = retreat || this.state === 'rush';
    if (this.player) this.player.speed = 1;
    this.lift = 0;
    this.state = 'stun';
    this.stunLeft = this.stageDef.StunTime || 3;
    this.play('stun_start', false);
  }

  pickAction() {
    // The portal opens again only once most of the last batch is down (like the wave health threshold).
    const alive = this.spawned.filter(z => !z.dead && !z.removed);
    const left = alive.reduce((s, z) => s + Math.max(0, z.hp) + z.armor.reduce((a, b) => a + Math.max(0, b.hp), 0), 0);
    const canSpawn = !this.spawnedHp || left / this.spawnedHp < 0.35;
    const acts = (this.stageDef.Actions || []).map(r => this.game.data.resolve(r))
      .filter(a => a && (a.Weight || 0) > 0 && (canSpawn || a.objclass !== 'ZombossSpawnActionDefinition'));
    const total = acts.reduce((s, a) => s + a.Weight, 0);
    let k = Math.random() * total;
    for (const a of acts) { k -= a.Weight; if (k <= 0) return a; }
    return acts[0] || null;
  }

  startAction() {
    const a = this.pickAction();
    this.action = a;
    if (!a) { this.idle(); return; }
    const n = Math.max(1, pickInt(a.RepeatMin ?? 1, a.RepeatMax ?? 1));
    switch (a.objclass) {
      case 'ZombossWalkActionDefinition': this.steps = n; this.walkStep(); break;
      case 'ZombossSpawnActionDefinition': this.state = 'spawn'; this.play('zombie_portal_start', false); break;
      case 'ZombossRushActionDefinition': this.startRush(); break;
      case 'ZombossFireActionDefinition': this.volleys = n; this.gravesLeft = this.props.NumRocketGravestones ?? 2; this.state = 'fire'; this.play('missile_start', false); break;
      default: this.idle();
    }
  }

  idle() {
    this.state = 'idle';
    const t = this.stageDef.IdleTime || { Min: 0.5, Max: 1 };
    this.timer = rnd(t.Min, t.Max) + 1.8;
    this.play('idle');
  }

  walkStep() {
    const a = this.action;
    const moves = [];
    if (Math.random() < (a.WalkVerticalChance ?? 0.5)) {
      if (this.row - 1 >= 1) moves.push([this.col, this.row - 1, 'walk_up']);
      if (this.row + 1 < ROWS) moves.push([this.col, this.row + 1, 'walk_down']);
    }
    if (!moves.length) {
      if (this.col - 1 >= this.minCol) moves.push([this.col - 1, this.row, 'walk_forward']);
      if (this.col + 1 <= this.maxCol) moves.push([this.col + 1, this.row, 'walk_backwards']);
    }
    if (!moves.length) { this.idle(); return; }
    const squashing = moves.filter(([c, r]) => this.footprint(c, r).some(([x, y]) => this.game.plants.some(p => p.col === x && p.row === y)));
    const pool = squashing.length && Math.random() < (a.WalkPreferSquashChance ?? 0) ? squashing : moves;
    const [c, r, label] = pool[Math.floor(Math.random() * pool.length)];
    this.state = 'walk';
    this.from = { x: this.x, y: this.y };
    this.col = c; this.row = r;
    this.to = this.anchor(c, r);
    this.play(label, false);
  }

  startRush() {
    this.state = 'rush_lead';
    this.rushDamage = 0;
    this.timer = this.action.RushLeadupTime || 1.5;
    this.from = { x: this.x, y: this.y };
    this.play('walk_backwards');
  }

  squashFootprint() {
    for (const [c, r] of this.footprint()) {
      const p = this.game.plants.find(q => q.col === c && q.row === r);
      if (p) { p.die(); this.game.effect('POPANIM_EFFECTS_PLANT_UNPLANTED', p.x, p.y); }
    }
  }

  spawnZombies() {
    const a = this.action;
    const range = a.SpawnZombieWavePointRange || { Min: 300, Max: 900 };
    let points = rnd(range.Min, range.Max) * 0.6;
    const types = (a.SpawnZombieTypes || ['mummy']).filter(t => this.game.data.zombie(t));
    const out = [];
    this.spawned = [];
    this.spawnedHp = 0;
    for (let guard = 0; points > 0 && guard < 30 && types.length; guard++) {
      const t = types[Math.floor(Math.random() * types.length)];
      const cost = this.game.data.zombie(t).props.WavePointCost || 100;
      if (cost > points && guard > 2) continue;
      points -= cost;
      out.push(t);
    }
    out.forEach((t, k) => {
      setTimeoutGame(this.game, 0.35 * k, () => {
        if (this.dead) return;
        const row = Math.floor(Math.random() * ROWS);
        const x = LAWN_X + CELL_W * rnd(7.2, 8.6);
        const zs = this.game.spawnZombie(t, row, x, { plantFood: k === 0 });
        for (const z of zs) { this.spawned.push(z); this.spawnedHp += z.maxHp + z.armor.reduce((a, b) => a + b.max, 0); }
        if (zs.length) this.game.effect('POPANIM_EFFECTS_DIRT_SPAWN_DIRT', x, rowGround(row));
      });
    });
  }

  fireRockets() {
    const a = this.action;
    const n = pickInt(a.FireRocketCount?.Min ?? 1, a.FireRocketCount?.Max ?? 1);
    const rows = [];
    for (let r = 0; r < ROWS; r++) if (Math.abs(r - (this.row - 0.5)) <= (a.FireRowRange ?? 3)) rows.push(r);
    for (let i = 0; i < n; i++) {
      const cells = [];
      for (let c = a.FireMinColumn ?? 0; c <= (a.FireMaxColumn ?? 4); c++) for (const r of rows) {
        const plant = this.game.plants.some(p => p.col === c && p.row === r);
        const w = plant ? (a.FireTargetPlantWeight ?? 1) : this.game.gridItemAt(c, r) ? 0 : (a.FireTargetEmptyWeight ?? 1);
        if (w > 0) cells.push([c, r, w]);
      }
      const total = cells.reduce((s, q) => s + q[2], 0);
      let k = Math.random() * total;
      const pick = cells.find(q => (k -= q[2]) <= 0) || cells[0];
      if (pick) this.game.effects.push(new Rocket(this.game, pick[0], pick[1], a.FireRocketHitTime || 0.75, this));
    }
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    this.flash = Math.max(0, this.flash - dt);
    if (this.chillT > 0) this.chillT -= dt;
    if (this.freezeT > 0 && !this.dead) { this.freezeT -= dt; return; }
    const rdt = dt * this.rate;
    const p = this.player;
    if (this.state === 'hidden') {
      this.timer -= dt;
      if (this.timer <= 0) { this.state = 'intro'; this.play('intro', false); this.game.message('DR. ZOMBOSS!', 2.5); }
      return;
    }
    p?.update(this.state === 'die' ? dt : rdt);
    switch (this.state) {
      case 'intro':
        if (!p || p.done) { this.targetable = true; this.dmgIndex = this.stageDef.DamageIndexFull ?? 0; this.idle(); }
        break;
      case 'idle':
        this.timer -= rdt;
        if (this.timer <= 0) this.startAction();
        break;
      case 'walk': {
        const k = p ? Math.min(1, p.t * p.doc.fps / Math.max(1, p.doc.range(this.label)[1] - p.doc.range(this.label)[0])) : 1;
        this.x = this.from.x + (this.to.x - this.from.x) * k;
        this.y = this.from.y + (this.to.y - this.from.y) * k;
        if (!p || p.done) {
          this.place();
          this.squashFootprint();
          if (--this.steps > 0) this.walkStep(); else this.idle();
        }
        break;
      }
      case 'spawn':
        if (p.done) {
          if (this.label === 'zombie_portal_start') { this.play('zombie_portal_loop'); this.timer = (this.action.SpawnChargeTime || 0.5) + 1.2; this.spawnZombies(); }
          else if (this.label === 'zombie_portal_end') this.idle();
        }
        if (this.label === 'zombie_portal_loop') { this.timer -= rdt; if (this.timer <= 0) this.play('zombie_portal_end', false); }
        break;
      case 'rush_lead': {
        const a = this.action;
        this.timer -= dt;
        const k = 1 - Math.max(0, this.timer) / (a.RushLeadupTime || 1.5);
        this.x = this.from.x + (a.RushLeadupBackup || 60) * 0.5 * k;
        if (this.timer <= 0) {
          this.state = 'rush';
          this.rushT = 0;
          this.from = { x: this.x, y: this.y };
          this.rushTo = cellCenter(2, this.row).x - (a.RushOvershoot || 80) * 0.25;
          this.play('walk_forward');
        }
        break;
      }
      case 'rush': {
        const a = this.action;
        const T = a.RushTime || 1.6;
        this.rushT += dt;
        const k = Math.min(1, this.rushT / T);
        if (p) p.speed = (a.RushStartRate || 1.5) + ((a.RushEndRate || 4) - (a.RushStartRate || 1.5)) * k;
        this.x = this.from.x + (this.rushTo - this.from.x) * (k * k);
        for (const q of [...this.game.plants]) if (this.inRow(q.row) && q.x > this.x - 34 && q.x < this.from.x) { q.die(); this.game.effect('POPANIM_EFFECTS_PLANT_UNPLANTED', q.x, q.y); }
        if (k >= 1) { if (p) p.speed = 1; this.retreat(); }
        break;
      }
      case 'jump': {
        const J = this.jump;
        if (this.label === 'jump_start' && p.done) { this.play('jump_mid'); J.t = 0; }
        else if (this.label === 'jump_mid') {
          J.t += rdt;
          const k = Math.min(1, J.t / J.hang);
          this.x = J.from.x + (J.to.x - J.from.x) * k;
          this.y = J.from.y + (J.to.y - J.from.y) * k;
          this.lift = -Math.sin(Math.PI * k) * J.height;
          if (k >= 1) { this.lift = 0; this.place(); this.squashFootprint(); this.play('jump_land', false); }
        } else if (this.label === 'jump_land' && p.done) this.idle();
        break;
      }
      case 'fire':
        if (p.done) {
          if (this.label === 'missile_start') { this.play('rocket_launch', false); this.fireRockets(); }
          else if (--this.volleys > 0) { this.play('rocket_launch', false); this.fireRockets(); }
          else this.idle();
        }
        break;
      case 'stun':
        if (this.label === 'stun_start' && p.done) this.play('stun_loop');
        else if (this.label === 'stun_loop') { this.stunLeft -= dt; if (this.stunLeft <= 0) this.play('stun_end', false); }
        else if (this.label === 'stun_end' && p.done) { if (this.retreatAfter) this.retreat(); else this.idle(); }
        break;
      case 'die':
        if (p.done) {
          const next = this.dieSeq.shift();
          if (next) this.play(next, false);
          else { this.finished = true; this.removed = true; }
        }
        break;
      default:
        break;
    }
  }

  retreat() {
    const J = this.game.data.resolve(this.stageDef.RetreatAction) || { JumpHeight: 400, JumpHangTime: 0.8 };
    this.state = 'jump';
    this.col = this.home.col;
    this.row = this.home.row;
    this.jump = { from: { x: this.x, y: this.y }, to: this.anchor(this.col, this.row), hang: J.JumpHangTime || 0.8, height: (J.JumpHeight || 400) * 0.5, t: 0 };
    this.retreatAfter = false;
    this.play('jump_start', false);
  }

  draw(ctx, cam) {
    if (this.state === 'hidden' || !this.player) return;
    drawPam(ctx, cam, this.player, this.x, this.y + (this.lift || 0), this.art);
    const tint = this.freezeT > 0 ? 'rgba(170,225,255,0.4)' : this.chillT > 0 ? 'rgba(110,180,255,0.22)' : this.flash > 0 ? 'rgba(255,255,255,0.25)' : null;
    if (tint) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.ellipse(cam.x(this.x + 60), cam.y(this.y - 110 + (this.lift || 0)), 95 * cam.s, 125 * cam.s, 0, 0, 7);
      ctx.fill();
    }
  }
}

// A rocket: a lock-on reticle on the target tile, then the missile drops and explodes.
// It destroys the plant there; on an empty tile it leaves a gravestone.
class Rocket {
  constructor(game, col, row, hitTime, boss) {
    this.game = game;
    this.boss = boss;
    this.col = col; this.row = row;
    const c = cellCenter(col, row);
    this.x = c.x; this.y = rowGround(row) - 30;
    this.t = 0;
    this.hit = hitTime + 0.6;
    this.reticle = game.assets.player(FX, () => false);
    this.reticle?.play('missile_lock_reticle');
    this.missile = game.assets.player(FX, () => false);
    this.missile?.play('missile');
    this.dead = false;
  }

  update(dt) {
    this.t += dt;
    this.reticle?.update(dt);
    this.missile?.update(dt);
    if (this.t >= this.hit && !this.exploded) {
      this.exploded = true;
      const p = this.game.plants.find(q => q.col === this.col && q.row === this.row);
      if (p) p.die();
      else if (!this.game.gridItemAt(this.col, this.row) && this.boss.gravesLeft > 0) {
        this.boss.gravesLeft -= 1;
        this.game.addGridItem('gravestone_egypt', this.col, this.row, true);
      }
      this.game.effect(FX, this.x, this.y, ['missile_explosion']);
      this.dead = true;
    }
  }

  draw(ctx, cam) {
    drawPam(ctx, cam, this.reticle, this.x, this.y, { x: 0, y: 0 });
    const fall = this.hit - 0.45;
    if (this.t > fall) {
      const k = (this.t - fall) / 0.45;
      drawPam(ctx, cam, this.missile, this.x, this.y - (1 - k) * 420, { x: 0, y: 0 });
    }
  }
}

// Battle-time timers (pause- and speed-aware), kept on the battle object.
function setTimeoutGame(game, t, fn) {
  (game.timers || (game.timers = [])).push({ t, fn });
}
