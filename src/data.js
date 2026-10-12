// Game data access with RTID resolution, mirroring how PvZ2 links its tables.

const RTID = /^RTID\(([^@()]+)@([^()]+)\)$/;

export class GameData {
  constructor(json) {
    this.sheets = json.sheets;
    this.levels = json.levels;
    this.strings = json.strings;
    this._plants = new Map();
    this._zombies = new Map();
  }

  static parseRtid(s) {
    const m = typeof s === 'string' && s.match(RTID);
    return m ? { alias: m[1], sheet: m[2] } : null;
  }

  // Resolve an RTID string. `local` maps aliases for RTID(x@CurrentLevel).
  resolve(ref, local = null) {
    const r = GameData.parseRtid(ref);
    if (!r) return null;
    if (r.sheet === 'CurrentLevel' || r.sheet === '.') return local ? local.get(r.alias) || null : null;
    const sheet = this.sheets[r.sheet];
    return sheet ? sheet[r.alias] || null : null;
  }

  text(key) {
    if (!key) return '';
    const k = key.replace(/^\[|\]$/g, '');
    return this.strings[k] || k;
  }

  plant(id) {
    if (!this._plants.has(id)) {
      const type = this.sheets.PlantTypes[id];
      if (!type) return null;
      const props = this.resolve(type.Properties) || {};
      const levels = this.sheets.PlantLevels[id] || null;
      const powers = {};
      for (const p of (props.Powers && props.Powers.List) || []) {
        const sheet = this.sheets.Powers[p.Props];
        if (sheet) powers[p.Type] = sheet;
      }
      this._plants.set(id, { id, type, props, levels, powers, name: this.text(`[${id.toUpperCase()}]`) || id });
    }
    return this._plants.get(id);
  }

  zombie(id) {
    if (!this._zombies.has(id)) {
      const type = this.sheets.ZombieTypes[id];
      if (!type) return null;
      const props = this.resolve(type.Properties) || {};
      this._zombies.set(id, { id, type, props });
    }
    return this._zombies.get(id);
  }

  projectile(ref) {
    return this.resolve(ref) || this.sheets.ProjectileTypes[ref] || null;
  }

  armor(ref) {
    return this.resolve(ref) || this.sheets.ArmorTypes[ref] || null;
  }

  // A level as { objects: Map(alias -> objdata + objclass), def: LevelDefinition }.
  level(name) {
    const objs = this.levels[name];
    if (!objs) return null;
    const local = new Map();
    let def = null;
    for (const o of objs) {
      const rec = Object.assign({ objclass: o.objclass }, o.objdata);
      if (o.objclass === 'LevelDefinition') def = rec;
      for (const a of o.aliases || []) local.set(a, rec);
    }
    return { name, def, local };
  }
}
