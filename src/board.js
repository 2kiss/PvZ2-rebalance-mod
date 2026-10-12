// Board geometry in game units (PvZ2 logic units; animations are authored at 2x).
export const PAM_SCALE = 0.5;          // PopAnim px -> game units
export const COLS = 9;
export const ROWS = 5;
export const CELL_W = 64;
export const CELL_H = 76;
export const LAWN_X = 199;             // left edge of column 0 on the Egypt background
export const LAWN_Y = 156;             // top edge of row 0
export const LAWN_RIGHT = LAWN_X + COLS * CELL_W;
export const ZOMBIE_SPAWN_X = LAWN_RIGHT + 40;
export const HOUSE_X = LAWN_X - 40;    // zombies past this point reach the house

export function cellCenter(col, row) {
  return { x: LAWN_X + (col + 0.5) * CELL_W, y: LAWN_Y + (row + 0.5) * CELL_H };
}

// Ground line of a row: where plants and zombies stand.
export function rowGround(row) {
  return LAWN_Y + (row + 1) * CELL_H - 10;
}

export function cellAt(x, y) {
  const col = Math.floor((x - LAWN_X) / CELL_W);
  const row = Math.floor((y - LAWN_Y) / CELL_H);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return { col, row };
}

export function rnd(min, max) {
  return min + Math.random() * (max - min);
}

export function rndRange(r) {
  if (r == null) return 0;
  if (typeof r === 'number') return r;
  return rnd(r.Min ?? 0, r.Max ?? r.Min ?? 0);
}
