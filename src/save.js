// Player progress, kept in localStorage (private to this browser). Everything is earned in-game:
// coins come from levels, plants from the world map or the Night Carnival.

const KEY = 'pvz2web.save.v1';
export const STARTER_PLANTS = ['sunflower', 'peashooter', 'wallnut', 'potatomine', 'cabbagepult'];

const DEFAULTS = () => ({
  coins: 0,
  done: {},            // level name -> times won
  bought: [],          // Night Carnival plants
  slots: 6,            // seed slots (7th and 8th can be bought)
  lastSeeds: [],
  upgrades: {},        // starting_sun_lvl1, pf_slots_lvl1 ... from the map
});

export class Save {
  constructor() {
    this.data = DEFAULTS();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* private mode or blocked storage: play without saving */ }
  }

  get coins() { return this.data.coins; }
  get done() { return this.data.done; }

  write() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
  }

  addCoins(n) { this.data.coins = Math.max(0, Math.round(this.data.coins + n)); this.write(); }

  spend(n) {
    if (this.data.coins < n) return false;
    this.data.coins -= n;
    this.write();
    return true;
  }

  // Plants owned: starters, world-map rewards for cleared levels, and carnival purchases.
  ownedPlants(map) {
    const set = new Set(STARTER_PLANTS);
    for (const e of map.m_eventList) {
      if (e.m_eventType !== 'plant' || !e.m_parentEvent) continue;
      const parent = map.m_eventList.find(p => p.m_name === e.m_parentEvent);
      if (parent && this.data.done[parent.m_dataString]) set.add(e.m_dataString);
    }
    for (const p of this.data.bought) set.add(p);
    return [...set];
  }

  winLevel(level, coins) {
    const first = !this.data.done[level];
    this.data.done[level] = (this.data.done[level] || 0) + 1;
    this.data.coins += coins;
    this.write();
    return first;
  }
}
