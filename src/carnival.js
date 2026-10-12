// Night Carnival: a permanent coin-only shop. Every 8 hours four booths roll a random premium
// plant each with a discount (old price struck through). Same idea as the IPA mod's store tab.

export const PREMIUM = {
  // Prices follow the plants' own Rarity in PlantTypes (uncommon / rare).
  uncommon: ['firepeashooter', 'chomper', 'squash', 'jalapeno', 'starfruit', 'hypnoshroom', 'homingthistle', 'peanut'],
  rare: ['snowpea', 'torchwood', 'coldsnapdragon', 'wasabiwhip'],
};
export const PRICE = { uncommon: 9000, rare: 15000 };
export const SLOT_PRICES = [12000, 25000];      // 7th and 8th seed slots
const BOOTHS = [
  { tiers: ['uncommon', 'rare'], discounts: [20, 25, 30] },
  { tiers: ['uncommon', 'rare'], discounts: [35, 40, 45] },
  { tiers: ['rare', 'uncommon'], discounts: [50, 55] },
  { tiers: ['rare'], discounts: [60, 65, 70] },
];
export const ROTATION_MS = 8 * 3600 * 1000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tierOf(id) {
  return Object.keys(PREMIUM).find(t => PREMIUM[t].includes(id)) || null;
}

export function isPremium(id) { return !!tierOf(id); }

// The current four deals. Plants the player owns are skipped while others remain.
export function currentDeals(owned, now = Date.now()) {
  const window = Math.floor(now / ROTATION_MS);
  const r = rng(window * 7919 + 17);
  const taken = new Set();
  const deals = [];
  for (const b of BOOTHS) {
    let pool = b.tiers.flatMap(t => PREMIUM[t]).filter(p => !taken.has(p));
    const fresh = pool.filter(p => !owned.includes(p));
    if (fresh.length) pool = fresh;
    if (!pool.length) continue;
    const plant = pool[Math.floor(r() * pool.length)];
    taken.add(plant);
    const tier = tierOf(plant);
    const pct = b.discounts[Math.floor(r() * b.discounts.length)];
    const old = PRICE[tier];
    deals.push({ plant, tier, pct, old, price: Math.round(old * (100 - pct) / 100 / 50) * 50 });
  }
  return { deals, endsAt: (window + 1) * ROTATION_MS };
}
