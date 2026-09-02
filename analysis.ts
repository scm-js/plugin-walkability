/**
 * The pure part of the Walkability plugin: a grid of minitiles, and everything the panel
 * reports about it. Nothing here touches the editor; `plugin.ts` builds the grid from
 * the open map's tiles and the tileset's VF4 flags and draws what comes back.
 *
 * Units of measure: a *cell* is one minitile, 8 × 8 map pixels, four to a tile edge.
 * Every array here is `w * h` cells, row-major, `y * w + x`.
 *
 * What is computed, in order:
 *
 *   1. `clearance` — for every passable cell, how far it is from the nearest wall
 *      (Chebyshev distance in cells; the map edge counts as a wall). A cell in the
 *      middle of a passage 4 cells wide has clearance 2. BWEM calls this altitude.
 *   2. Components — 4-connected regions of passable ground. Two start locations in
 *      different components can never meet by ground: those are islands.
 *   3. Areas and chokes — a watershed over the clearance map, the way BWEM segments a
 *      map: cells are visited from the widest open ground downwards, each joining the
 *      area of a neighbour already visited or founding a new one; where two areas
 *      first touch is the widest point of the narrowest passage between them, which is
 *      a choke, unless one of the areas is too small or the meeting point is nearly as
 *      wide as the area itself, in which case they were one area all along.
 *   4. Seams — passable cells next to passable cells at another ground height where
 *      neither is a ramp: a unit can walk a cliff there, which is nearly always a
 *      terrain mistake.
 *   5. Start-to-start figures — the ground distance between every pair of start
 *      locations and the width of the narrowest passage on the widest route between
 *      them (a maximin path over the clearance map).
 */

export const CELL_PX = 8;
export const CELLS_PER_TILE = 4;

/** VF4 minitile flags. */
export const Flag = { Walkable: 0x0001, MidGround: 0x0002, HighGround: 0x0004, BlocksView: 0x0008, Ramp: 0x0010 } as const;

/** What a cell is: wall (unwalkable terrain), open ground, or ground under a building. */
export const Cell = { Wall: 0, Open: 1, Building: 2 } as const;

export interface Grid {
  /** In cells. */
  w: number;
  h: number;
  /** `Cell.*` per cell. */
  cell: Uint8Array;
  /** Ground height 0 / 1 / 2 per cell. */
  level: Uint8Array;
  /** 1 on ramp cells. */
  ramp: Uint8Array;
}

/** A box in map pixels, edges exclusive. */
export interface PixelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Build the grid from a map's MTXM tiles. `flagsOf(tileId)` answers the sixteen VF4
 * words of the tile's megatile (row-major, four per row) or null for a tile the
 * tileset has no picture for, which is a wall — the game's pathfinder treats a null
 * megatile as unwalkable too.
 */
export function gridFromTiles(width: number, height: number, tiles: ArrayLike<number>, flagsOf: (tileId: number) => ArrayLike<number> | null): Grid {
  const w = width * CELLS_PER_TILE;
  const h = height * CELLS_PER_TILE;
  const cell = new Uint8Array(w * h);
  const level = new Uint8Array(w * h);
  const ramp = new Uint8Array(w * h);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const flags = flagsOf(tiles[ty * width + tx] ?? 0);
      if (!flags) continue;
      for (let m = 0; m < 16; m++) {
        const f = flags[m] ?? 0;
        const at = (ty * CELLS_PER_TILE + (m >> 2)) * w + tx * CELLS_PER_TILE + (m & 3);
        cell[at] = f & Flag.Walkable ? Cell.Open : Cell.Wall;
        level[at] = f & Flag.HighGround ? 2 : f & Flag.MidGround ? 1 : 0;
        ramp[at] = f & Flag.Ramp ? 1 : 0;
      }
    }
  }
  return { w, h, cell, level, ramp };
}

/** Mark the open cells under each box as `Cell.Building`; returns how many cells changed. */
export function blockBoxes(grid: Grid, boxes: Iterable<PixelBox>): number {
  let n = 0;
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.left / CELL_PX));
    const y0 = Math.max(0, Math.floor(b.top / CELL_PX));
    const x1 = Math.min(grid.w, Math.ceil(b.right / CELL_PX));
    const y1 = Math.min(grid.h, Math.ceil(b.bottom / CELL_PX));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const at = y * grid.w + x;
        if (grid.cell[at] === Cell.Open) { grid.cell[at] = Cell.Building; n++; }
      }
    }
  }
  return n;
}

/* ── Clearance ──────────────────────────────────────────── */

/** Cells of clearance per quarter-cell key: the sort keys the floods bucket by. */
const KEY_PER_CELL = 4;
const keyOf = (cells: number) => Math.round(cells * KEY_PER_CELL);

/**
 * Euclidean distance from every open cell to the nearest wall, building or map edge,
 * in cells (0 on walls and buildings; 1 when a wall is directly beside, √2 when it is
 * diagonally beside). An exact distance transform (Felzenszwalb & Huttenlocher), so a
 * corridor's middle is lower than the room it opens into and the watershed meets areas
 * inside the corridor rather than somewhere on a plateau of equal Chebyshev distance.
 */
export function clearance(grid: Grid): Float32Array {
  const { w, h, cell } = grid;
  // Pad with a ring of walls so the map edge counts as one.
  const W = w + 2;
  const H = h + 2;
  const INF = 1e20;
  const f = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= 1 && y >= 1 && x <= w && y <= h;
      f[y * W + x] = inside && cell[(y - 1) * w + (x - 1)] === Cell.Open ? INF : 0;
    }
  }
  const len = Math.max(W, H);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  const tmp = new Float64Array(len);
  const line = (offset: number, stride: number, count: number) => {
    for (let i = 0; i < count; i++) tmp[i] = f[offset + i * stride];
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < count; q++) {
      let s = ((tmp[q] + q * q) - (tmp[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((tmp[q] + q * q) - (tmp[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < count; q++) {
      while (z[k + 1] < q) k++;
      f[offset + q * stride] = (q - v[k]) * (q - v[k]) + tmp[v[k]];
    }
  };
  for (let x = 0; x < W; x++) line(x, W, H);
  for (let y = 0; y < H; y++) line(y * W, 1, W);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * w + x;
      out[at] = cell[at] === Cell.Open ? Math.sqrt(f[(y + 1) * W + x + 1]) : 0;
    }
  }
  return out;
}

/**
 * How wide the passage through a cell is, in cells: the shortest straight line through
 * it between two walls, tried along the two axes and the two diagonals.
 */
export function passageWidth(passable: Uint8Array, w: number, h: number, x: number, y: number): number {
  if (!passable[y * w + x]) return 0;
  const run = (dx: number, dy: number) => {
    let n = 0;
    let cx = x + dx;
    let cy = y + dy;
    while (cx >= 0 && cy >= 0 && cx < w && cy < h && passable[cy * w + cx]) { n++; cx += dx; cy += dy; }
    return n;
  };
  const straight = Math.min(run(1, 0) + run(-1, 0), run(0, 1) + run(0, -1)) + 1;
  // A diagonal line crosses √2 cells per step.
  const diagonal = (Math.min(run(1, 1) + run(-1, -1), run(1, -1) + run(-1, 1)) + 1) * Math.SQRT2;
  return Math.min(straight, Math.round(diagonal));
}

/* ── Components ─────────────────────────────────────────── */

export interface Bounds {
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  y1: number;
}

export interface Component {
  id: number;
  /** Cells. */
  size: number;
  bounds: Bounds;
  /** A cell inside it, near the middle. */
  centre: Point;
  /** Indices into `Analysis.starts`. */
  starts: number[];
}

/** 4-connected regions of passable cells; `label[i]` is -1 off the passable ground. Components are numbered largest first. */
export function components(passable: Uint8Array, w: number, h: number): { label: Int32Array; list: Component[] } {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const raw: Component[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (!passable[seed] || label[seed] >= 0) continue;
    const id = raw.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    label[seed] = id;
    let size = 0;
    let sx = 0;
    let sy = 0;
    const b: Bounds = { x0: w, y0: h, x1: 0, y1: 0 };
    while (head < tail) {
      const at = queue[head++];
      const x = at % w;
      const y = (at - x) / w;
      size++;
      sx += x;
      sy += y;
      if (x < b.x0) b.x0 = x;
      if (y < b.y0) b.y0 = y;
      if (x + 1 > b.x1) b.x1 = x + 1;
      if (y + 1 > b.y1) b.y1 = y + 1;
      if (x > 0 && passable[at - 1] && label[at - 1] < 0) { label[at - 1] = id; queue[tail++] = at - 1; }
      if (x < w - 1 && passable[at + 1] && label[at + 1] < 0) { label[at + 1] = id; queue[tail++] = at + 1; }
      if (y > 0 && passable[at - w] && label[at - w] < 0) { label[at - w] = id; queue[tail++] = at - w; }
      if (y < h - 1 && passable[at + w] && label[at + w] < 0) { label[at + w] = id; queue[tail++] = at + w; }
    }
    raw.push({ id, size, bounds: b, centre: nearestPassable(passable, w, h, Math.round(sx / size), Math.round(sy / size), label, id), starts: [] });
  }
  // Largest first, and relabel to match.
  const order = raw.map((_, i) => i).sort((a, b) => raw[b].size - raw[a].size);
  const remap = new Int32Array(raw.length);
  order.forEach((old, fresh) => { remap[old] = fresh; });
  for (let i = 0; i < n; i++) if (label[i] >= 0) label[i] = remap[label[i]];
  const list = order.map((old, fresh) => ({ ...raw[old], id: fresh }));
  return { label, list };
}

/** The passable cell of `id` nearest to (x, y) — the centroid of a ring is not on the ring. */
function nearestPassable(passable: Uint8Array, w: number, h: number, x: number, y: number, label: Int32Array, id: number): Point {
  const ok = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < w && cy < h && passable[cy * w + cx] === 1 && label[cy * w + cx] === id;
  if (ok(x, y)) return { x, y };
  for (let r = 1; r < Math.max(w, h); r++) {
    for (let i = -r; i <= r; i++) {
      if (ok(x + i, y - r)) return { x: x + i, y: y - r };
      if (ok(x + i, y + r)) return { x: x + i, y: y + r };
      if (ok(x - r, y + i)) return { x: x - r, y: y + i };
      if (ok(x + r, y + i)) return { x: x + r, y: y + i };
    }
  }
  return { x, y };
}

/* ── Areas and chokes ───────────────────────────────────── */

export interface Area {
  id: number;
  size: number;
  /** The widest point's clearance, in cells. */
  peak: number;
  /** Where that is. */
  top: Point;
  bounds: Bounds;
  component: number;
  starts: number[];
  /** Indices into `Analysis.chokes`. */
  chokes: number[];
}

export interface Choke {
  id: number;
  /** The cell where the two areas meet: the middle of the passage. */
  x: number;
  y: number;
  /** Clearance there. */
  clearance: number;
  /** The passage's width in cells, measured through the meeting cell. */
  width: number;
  a: number;
  b: number;
}

export interface AreaOptions {
  /** An area smaller than this many cells is absorbed by the neighbour it meets. */
  minAreaCells: number;
  /** An area whose widest point has less clearance than this many cells is absorbed. */
  minPeak: number;
  /** Two areas meeting at a point at least this share of either one's peak clearance were one area. */
  mergeRatio: number;
}

export const DEFAULT_AREA_OPTIONS: AreaOptions = { minAreaCells: 24 * 16, minPeak: 5, mergeRatio: 0.9 };

interface Watershed {
  label: Int32Array;
  areas: Area[];
  chokes: Choke[];
}

/**
 * Segment the passable ground into areas at its chokes. Cells are taken from the highest
 * clearance downwards; each joins a neighbouring area or founds one; where two areas
 * first touch, they either merge (`AreaOptions`) or that cell becomes their choke. The
 * first touch is the highest one, so the choke sits at the widest point of the passage.
 */
export function watershed(passable: Uint8Array, clear: Float32Array, w: number, h: number, options: AreaOptions = DEFAULT_AREA_OPTIONS, widthMask: Uint8Array = passable): Watershed {
  const n = w * h;
  const alt = new Uint16Array(n);
  let maxAlt = 0;
  for (let i = 0; i < n; i++) { alt[i] = keyOf(clear[i]); if (passable[i] && alt[i] > maxAlt) maxAlt = alt[i]; }
  const minPeak = keyOf(options.minPeak);
  // Counting sort by clearance, descending.
  const counts = new Int32Array(maxAlt + 2);
  for (let i = 0; i < n; i++) if (passable[i]) counts[alt[i]]++;
  const starts = new Int32Array(maxAlt + 2);
  let acc = 0;
  for (let a = maxAlt; a >= 0; a--) { starts[a] = acc; acc += counts[a]; }
  const order = new Int32Array(acc);
  const fill = starts.slice();
  for (let i = 0; i < n; i++) if (passable[i]) order[fill[alt[i]]++] = i;

  const label = new Int32Array(n).fill(-1);
  const parent: number[] = [];
  const size: number[] = [];
  const peak: number[] = [];
  const topX: number[] = [];
  const topY: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  interface RawChoke { x: number; y: number; alt: number; a: number; b: number; dead: boolean }
  const chokes: RawChoke[] = [];
  const chokeOf = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const merge = (loser: number, winner: number) => {
    parent[loser] = winner;
    size[winner] += size[loser];
    if (peak[loser] > peak[winner]) { peak[winner] = peak[loser]; topX[winner] = topX[loser]; topY[winner] = topY[loser]; }
    // Chokes the loser had now belong to the winner; one with the winner itself vanishes.
    for (let i = 0; i < chokes.length; i++) {
      const c = chokes[i];
      if (c.dead) continue;
      if (c.a !== loser && c.b !== loser) continue;
      chokeOf.delete(key(c.a, c.b));
      const other = c.a === loser ? c.b : c.a;
      if (other === winner) { c.dead = true; continue; }
      const k = key(winner, other);
      const existing = chokeOf.get(k);
      if (existing !== undefined && chokes[existing].alt >= c.alt) { c.dead = true; continue; }
      if (existing !== undefined) chokes[existing].dead = true;
      c.a = winner;
      c.b = other;
      chokeOf.set(k, i);
    }
  };

  const seen: number[] = [];
  for (let k = 0; k < order.length; k++) {
    const at = order[k];
    const x = at % w;
    const y = (at - x) / w;
    const a = alt[at];
    seen.length = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w || (!dx && !dy)) continue;
        const l = label[ny * w + nx];
        if (l < 0) continue;
        const r = find(l);
        if (!seen.includes(r)) seen.push(r);
      }
    }
    if (seen.length === 0) {
      const id = parent.length;
      parent.push(id);
      size.push(1);
      peak.push(a);
      topX.push(x);
      topY.push(y);
      label[at] = id;
      continue;
    }
    // Join the biggest; settle with each of the others.
    let main = seen[0];
    for (const r of seen) if (size[r] > size[main]) main = r;
    label[at] = main;
    size[main]++;
    for (const other of seen) {
      if (other === main) continue;
      const small = size[other] < options.minAreaCells || peak[other] < minPeak;
      const open = a >= options.mergeRatio * peak[other] || a >= options.mergeRatio * peak[main];
      if (small || open) {
        merge(other, main);
      } else if (!chokeOf.has(key(main, other))) {
        chokeOf.set(key(main, other), chokes.length);
        chokes.push({ x, y, alt: a, a: main, b: other, dead: false });
      }
    }
  }

  // Resolve labels to roots, number the survivors largest first.
  const roots: number[] = [];
  const fresh = new Int32Array(parent.length).fill(-1);
  for (let i = 0; i < parent.length; i++) if (find(i) === i) roots.push(i);
  roots.sort((p, q) => size[q] - size[p]);
  roots.forEach((r, i) => { fresh[r] = i; });
  const bounds: Bounds[] = roots.map(() => ({ x0: w, y0: h, x1: 0, y1: 0 }));
  for (let i = 0; i < n; i++) {
    if (label[i] < 0) continue;
    const id = fresh[find(label[i])];
    label[i] = id;
    const x = i % w;
    const y = (i - x) / w;
    const b = bounds[id];
    if (x < b.x0) b.x0 = x;
    if (y < b.y0) b.y0 = y;
    if (x + 1 > b.x1) b.x1 = x + 1;
    if (y + 1 > b.y1) b.y1 = y + 1;
  }
  const areas: Area[] = roots.map((r, i) => ({ id: i, size: size[r], peak: peak[r] / KEY_PER_CELL, top: { x: topX[r], y: topY[r] }, bounds: bounds[i], component: -1, starts: [], chokes: [] }));
  const out: Choke[] = [];
  for (const c of chokes) {
    if (c.dead) continue;
    const a = fresh[find(c.a)];
    const b = fresh[find(c.b)];
    if (a === b || a < 0 || b < 0) continue;
    const id = out.length;
    out.push({ id, x: c.x, y: c.y, clearance: c.alt / KEY_PER_CELL, width: passageWidth(widthMask, w, h, c.x, c.y), a, b });
    areas[a].chokes.push(id);
    areas[b].chokes.push(id);
  }
  out.sort((p, q) => p.width - q.width);
  out.forEach((c, i) => { c.id = i; });
  for (const area of areas) area.chokes = out.filter((c) => c.a === area.id || c.b === area.id).map((c) => c.id);
  return { label, areas, chokes: out };
}

/* ── Seams ──────────────────────────────────────────────── */

export interface Seam {
  /** Cells on the seam. */
  size: number;
  centre: Point;
  bounds: Bounds;
  /** The two ground heights that meet there. */
  levels: [number, number];
}

/**
 * Passable cells whose 4-neighbour is passable at another ground height, neither being
 * a ramp. Returns the mask and the seams as 8-connected clusters, largest first.
 */
export function seams(grid: Grid, passable: Uint8Array): { mask: Uint8Array; list: Seam[] } {
  const { w, h, level, ramp } = grid;
  const n = w * h;
  const mask = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * w + x;
      if (!passable[at] || ramp[at]) continue;
      if (x < w - 1 && passable[at + 1] && !ramp[at + 1] && level[at + 1] !== level[at]) { mask[at] = 1; mask[at + 1] = 1; }
      if (y < h - 1 && passable[at + w] && !ramp[at + w] && level[at + w] !== level[at]) { mask[at] = 1; mask[at + w] = 1; }
    }
  }
  const label = new Int32Array(n).fill(-1);
  const list: Seam[] = [];
  const queue: number[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (!mask[seed] || label[seed] >= 0) continue;
    const id = list.length;
    label[seed] = id;
    queue.length = 0;
    queue.push(seed);
    let size = 0;
    let sx = 0;
    let sy = 0;
    const b: Bounds = { x0: w, y0: h, x1: 0, y1: 0 };
    const levels = new Set<number>();
    while (queue.length) {
      const at = queue.pop()!;
      const x = at % w;
      const y = (at - x) / w;
      size++;
      sx += x;
      sy += y;
      levels.add(level[at]);
      if (x < b.x0) b.x0 = x;
      if (y < b.y0) b.y0 = y;
      if (x + 1 > b.x1) b.x1 = x + 1;
      if (y + 1 > b.y1) b.y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nb = ny * w + nx;
          if (mask[nb] && label[nb] < 0) { label[nb] = id; queue.push(nb); }
        }
      }
    }
    const sorted = [...levels].sort((p, q) => p - q);
    list.push({ size, centre: { x: Math.round(sx / size), y: Math.round(sy / size) }, bounds: b, levels: [sorted[0], sorted[sorted.length - 1]] });
  }
  list.sort((p, q) => q.size - p.size);
  return { mask, list };
}

/* ── Paths between start locations ──────────────────────── */

/** Ground distance from a cell to every passable cell, in map pixels (`Infinity` where unreachable): Dial's algorithm with 5 / 7 step costs. */
export function groundDistances(passable: Uint8Array, w: number, h: number, from: number): Float32Array {
  const n = w * h;
  const STRAIGHT = 5;
  const DIAG = 7;
  const dist = new Int32Array(n).fill(-1);
  const buckets: Int32Array[] = Array.from({ length: DIAG + 1 }, () => new Int32Array(0));
  const lengths = new Int32Array(DIAG + 1);
  const push = (b: number, at: number) => {
    let arr = buckets[b];
    if (lengths[b] === arr.length) {
      const grown = new Int32Array(Math.max(64, arr.length * 2));
      grown.set(arr);
      buckets[b] = grown;
      arr = grown;
    }
    arr[lengths[b]++] = at;
  };
  if (!passable[from]) return new Float32Array(n).fill(Infinity);
  dist[from] = 0;
  push(0, from);
  let pending = 1;
  let d = 0;
  while (pending > 0) {
    const b = d % (DIAG + 1);
    const arr = buckets[b];
    const count = lengths[b];
    lengths[b] = 0;
    for (let i = 0; i < count; i++) {
      const at = arr[i];
      pending--;
      if (dist[at] !== d) continue;
      const x = at % w;
      const y = (at - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || (!dx && !dy)) continue;
          const nb = ny * w + nx;
          if (!passable[nb]) continue;
          // No cutting corners: a diagonal step needs both orthogonal neighbours open.
          if (dx && dy && (!passable[y * w + nx] || !passable[ny * w + x])) continue;
          const nd = d + (dx && dy ? DIAG : STRAIGHT);
          if (dist[nb] < 0 || nd < dist[nb]) { dist[nb] = nd; push(nd % (DIAG + 1), nb); pending++; }
        }
      }
    }
    d++;
    // Buckets can be empty for a while between costs; the loop ends once nothing is pending.
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dist[i] < 0 ? Infinity : (dist[i] / STRAIGHT) * CELL_PX;
  return out;
}

/**
 * The widest route from a cell: for every passable cell, the largest clearance a path
 * from `from` can keep all the way (0 where unreachable), and the parent pointers of
 * those routes. A flood by descending bottleneck value, so it is linear in the grid.
 */
export function widestRoutes(passable: Uint8Array, clear: Float32Array, w: number, h: number, from: number): { best: Float32Array; parent: Int32Array } {
  const n = w * h;
  const best = new Uint16Array(n);
  const parent = new Int32Array(n).fill(-1);
  const alt = new Uint16Array(n);
  let maxAlt = 0;
  for (let i = 0; i < n; i++) { alt[i] = keyOf(clear[i]); if (alt[i] > maxAlt) maxAlt = alt[i]; }
  const toCells = () => { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = best[i] / KEY_PER_CELL; return out; };
  if (!passable[from]) return { best: toCells(), parent };
  const stacks: number[][] = Array.from({ length: maxAlt + 1 }, () => []);
  best[from] = alt[from];
  stacks[alt[from]].push(from);
  for (let v = maxAlt; v >= 1; v--) {
    const stack = stacks[v];
    while (stack.length) {
      const at = stack.pop()!;
      if (best[at] !== v) continue;
      const x = at % w;
      const y = (at - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || (!dx && !dy)) continue;
          const nb = ny * w + nx;
          if (!passable[nb]) continue;
          const nv = Math.min(v, alt[nb]);
          if (nv > best[nb]) { best[nb] = nv; parent[nb] = at; stacks[nv].push(nb); }
        }
      }
    }
  }
  return { best: toCells(), parent };
}

/* ── The whole analysis ─────────────────────────────────── */

export interface StartInput {
  /** The unit record's index. */
  index: number;
  owner: number;
  /** Map pixels. */
  x: number;
  y: number;
}

export interface StartInfo extends StartInput {
  /** The cell under it. */
  cx: number;
  cy: number;
  component: number;
  area: number;
}

export interface Pair {
  /** Indices into `starts`. */
  a: number;
  b: number;
  /** Straight-line distance in map pixels. */
  air: number;
  /** Ground distance in map pixels, or null when no ground route exists. */
  ground: number | null;
  /** The width of the narrowest point on the widest route, in cells; 0 when there is no route. */
  bottleneck: number;
  /** Where that point is. */
  chokeAt: Point | null;
}

export interface AnalysisOptions extends AreaOptions {
  /** Cells of clearance a unit needs: 0 takes the ground as it is, 1 keeps a cell off every wall, and so on. */
  unitRadius: number;
  starts: StartInput[];
}

export const DEFAULT_OPTIONS: AnalysisOptions = { ...DEFAULT_AREA_OPTIONS, unitRadius: 0, starts: [] };

export interface Analysis {
  w: number;
  h: number;
  grid: Grid;
  /** 1 on walkable ground, as flagged. */
  open: Uint8Array;
  /** 1 where a unit of the chosen size can stand: `open` with `unitRadius` cells kept off every wall. */
  passable: Uint8Array;
  /** Clearance of the open ground in cells (before the unit radius is applied). */
  alt: Float32Array;
  maxAlt: number;
  component: Int32Array;
  components: Component[];
  area: Int32Array;
  areas: Area[];
  chokes: Choke[];
  seamMask: Uint8Array;
  seams: Seam[];
  starts: StartInfo[];
  pairs: Pair[];
  /** Milliseconds spent. */
  took: number;
}

export function analyse(grid: Grid, options: Partial<AnalysisOptions> = {}): Analysis {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const o = { ...DEFAULT_OPTIONS, ...options };
  const { w, h } = grid;
  const n = w * h;
  const alt = clearance(grid);
  let maxAlt = 0;
  for (let i = 0; i < n; i++) if (alt[i] > maxAlt) maxAlt = alt[i];
  // `open` is the ground as flagged; `passable` is what is left once the unit's own size is
  // kept off the walls. Connectivity is decided on the latter, widths measured on the former.
  const open = new Uint8Array(n);
  const passable = new Uint8Array(n);
  for (let i = 0; i < n; i++) { open[i] = alt[i] > 0 ? 1 : 0; passable[i] = alt[i] > o.unitRadius ? 1 : 0; }

  const comps = components(passable, w, h);
  const shed = watershed(passable, alt, w, h, o, open);
  for (const area of shed.areas) area.component = comps.label[area.top.y * w + area.top.x];
  const sm = seams(grid, passable);

  const starts: StartInfo[] = o.starts.map((s) => {
    const cx = Math.min(w - 1, Math.max(0, Math.floor(s.x / CELL_PX)));
    const cy = Math.min(h - 1, Math.max(0, Math.floor(s.y / CELL_PX)));
    const at = nearestOn(passable, w, h, cx, cy);
    return { ...s, cx: at.x, cy: at.y, component: comps.label[at.y * w + at.x], area: shed.label[at.y * w + at.x] };
  });
  starts.forEach((s, i) => {
    if (s.component >= 0) comps.list[s.component].starts.push(i);
    if (s.area >= 0) shed.areas[s.area].starts.push(i);
  });

  const pairs: Pair[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (s.component < 0) {
      for (let j = i + 1; j < starts.length; j++) pairs.push({ a: i, b: j, air: Math.hypot(starts[j].x - s.x, starts[j].y - s.y), ground: null, bottleneck: 0, chokeAt: null });
      continue;
    }
    const from = s.cy * w + s.cx;
    let dist: Float32Array | null = null;
    let routes: { best: Float32Array; parent: Int32Array } | null = null;
    for (let j = i + 1; j < starts.length; j++) {
      const t = starts[j];
      const air = Math.hypot(t.x - s.x, t.y - s.y);
      if (t.component !== s.component) { pairs.push({ a: i, b: j, air, ground: null, bottleneck: 0, chokeAt: null }); continue; }
      dist ??= groundDistances(passable, w, h, from);
      routes ??= widestRoutes(passable, alt, w, h, from);
      const to = t.cy * w + t.cx;
      const ground = dist[to];
      const bottleneck = routes.best[to];
      // Walk the route back; of the cells as narrow as the bottleneck, the one in the
      // tightest passage is the choke (a route may also brush a wall in an open room).
      let chokeAt: Point | null = null;
      let width = bottleneck * 2;
      let at = to;
      while (at >= 0) {
        if (keyOf(alt[at]) === keyOf(bottleneck)) {
          const x = at % w;
          const y = (at - x) / w;
          const here = passageWidth(open, w, h, x, y);
          if (!chokeAt || here < width) { chokeAt = { x, y }; width = here; }
        }
        at = routes.parent[at];
      }
      pairs.push({ a: i, b: j, air, ground: Number.isFinite(ground) ? ground : null, bottleneck: width, chokeAt });
    }
  }

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    w, h, grid, open, passable, alt, maxAlt,
    component: comps.label, components: comps.list,
    area: shed.label, areas: shed.areas, chokes: shed.chokes,
    seamMask: sm.mask, seams: sm.list,
    starts, pairs, took: t1 - t0,
  };
}

/** The nearest passable cell to (x, y), itself when it is one; (x, y) when there is none within 8 tiles. */
export function nearestOn(passable: Uint8Array, w: number, h: number, x: number, y: number): Point {
  const ok = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < w && cy < h && passable[cy * w + cx] === 1;
  if (ok(x, y)) return { x, y };
  for (let r = 1; r <= 32; r++) {
    for (let i = -r; i <= r; i++) {
      if (ok(x + i, y - r)) return { x: x + i, y: y - r };
      if (ok(x + i, y + r)) return { x: x + i, y: y + r };
      if (ok(x - r, y + i)) return { x: x - r, y: y + i };
      if (ok(x + r, y + i)) return { x: x + r, y: y + i };
    }
  }
  return { x, y };
}

/**
 * The components within `margin` cells outside a pixel box — where a unit standing next
 * to a building would be. A margin of `unitRadius + 1` reaches past the cells the unit's
 * own size keeps off the building's wall.
 */
export function componentsAround(a: Analysis, box: PixelBox, margin = 1): number[] {
  const bx0 = Math.floor(box.left / CELL_PX);
  const by0 = Math.floor(box.top / CELL_PX);
  const bx1 = Math.ceil(box.right / CELL_PX) - 1;
  const by1 = Math.ceil(box.bottom / CELL_PX) - 1;
  const out = new Set<number>();
  for (let y = by0 - margin; y <= by1 + margin; y++) {
    if (y < 0 || y >= a.h) continue;
    for (let x = bx0 - margin; x <= bx1 + margin; x++) {
      if (x < 0 || x >= a.w) continue;
      if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) continue;
      const c = a.component[y * a.w + x];
      if (c >= 0) out.add(c);
    }
  }
  return [...out];
}

/* ── Formatting ─────────────────────────────────────────── */

/** Cells as tiles, one decimal: 6 → "1.5". */
export function tiles(cells: number): string {
  const t = cells / CELLS_PER_TILE;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

/** Map pixels as tiles, rounded. */
export function pxTiles(px: number): string {
  return String(Math.round(px / (CELL_PX * CELLS_PER_TILE)));
}

/** A plain-text report of the analysis, for the clipboard. */
export function report(a: Analysis, names: { player(owner: number): string; area?(id: number): string }): string {
  const lines: string[] = [];
  const areaName = names.area ?? ((id: number) => `Area ${id + 1}`);
  lines.push(`Walkability: ${a.components.length} island${a.components.length === 1 ? "" : "s"}, ${a.areas.length} area${a.areas.length === 1 ? "" : "s"}, ${a.chokes.length} choke${a.chokes.length === 1 ? "" : "s"}, ${a.seams.length} height seam${a.seams.length === 1 ? "" : "s"} (${a.took.toFixed(0)} ms)`);
  lines.push("");
  lines.push("Start locations");
  for (const s of a.starts) {
    lines.push(`  ${names.player(s.owner)} at ${pxTiles(s.x)}, ${pxTiles(s.y)}: ${s.component < 0 ? "not on walkable ground" : `island ${s.component + 1}, ${areaName(s.area)}`}`);
  }
  if (a.pairs.length) {
    lines.push("");
    lines.push("Between start locations (tiles)");
    for (const p of a.pairs) {
      const sa = a.starts[p.a];
      const sb = a.starts[p.b];
      const ground = p.ground === null ? "no ground route" : `ground ${pxTiles(p.ground)}, narrowest ${tiles(p.bottleneck)} wide`;
      lines.push(`  ${names.player(sa.owner)} – ${names.player(sb.owner)}: air ${pxTiles(p.air)}, ${ground}`);
    }
  }
  lines.push("");
  lines.push("Islands (largest first)");
  for (const c of a.components) {
    const who = c.starts.length ? c.starts.map((i) => names.player(a.starts[i].owner)).join(", ") : "no start location";
    lines.push(`  Island ${c.id + 1}: ${tiles(c.size / CELLS_PER_TILE)} tiles, ${who}`);
  }
  lines.push("");
  lines.push("Chokes (narrowest first)");
  for (const c of a.chokes) {
    lines.push(`  ${tiles(c.width)} tiles wide at ${tiles(c.x)}, ${tiles(c.y)} between ${areaName(c.a)} and ${areaName(c.b)}`);
  }
  if (a.seams.length) {
    lines.push("");
    lines.push("Height seams (a unit can walk between ground heights with no ramp)");
    for (const s of a.seams) lines.push(`  ${s.size} minitiles at ${tiles(s.centre.x)}, ${tiles(s.centre.y)}: height ${s.levels[0]} meets ${s.levels[1]}`);
  }
  return lines.join("\n");
}
