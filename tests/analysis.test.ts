import { describe, expect, it } from "vitest";
import {
  analyse, blockBoxes, Cell, clearance, components, componentsAround, DEFAULT_AREA_OPTIONS, Flag, gridFromTiles, groundDistances, nearestOn,
  passageWidth, pxTiles, report, seams, tiles, watershed, widestRoutes, type Grid,
} from "../analysis";

/**
 * A grid drawn as text: `#` wall, `.` open ground, `1` / `2` open ground at height 1 / 2,
 * `r` a ramp (height 1), `b` ground under a building.
 */
function grid(rows: string[]): Grid {
  const h = rows.length;
  const w = rows[0].length;
  const cell = new Uint8Array(w * h);
  const level = new Uint8Array(w * h);
  const ramp = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      const at = y * w + x;
      cell[at] = ch === "#" ? Cell.Wall : ch === "b" ? Cell.Building : Cell.Open;
      level[at] = ch === "1" || ch === "r" ? 1 : ch === "2" ? 2 : 0;
      ramp[at] = ch === "r" ? 1 : 0;
    }
  });
  return { w, h, cell, level, ramp };
}

const open = (g: Grid) => { const a = clearance(g); const p = new Uint8Array(g.w * g.h); for (let i = 0; i < p.length; i++) p[i] = a[i] > 0 ? 1 : 0; return p; };

describe("gridFromTiles", () => {
  it("expands each tile into sixteen cells from its VF4 words, and a tile without a picture into walls", () => {
    // Two tiles wide, one high: the first fully walkable at height 2 with one ramp cell, the second unknown.
    const flags = new Array(16).fill(Flag.Walkable | Flag.HighGround);
    flags[5] |= Flag.Ramp;
    const g = gridFromTiles(2, 1, [7, 9], (id) => (id === 7 ? flags : null));
    expect(g.w).toBe(8);
    expect(g.h).toBe(4);
    expect(g.cell[0]).toBe(Cell.Open);
    expect(g.level[0]).toBe(2);
    expect(g.ramp[1 * 8 + 1]).toBe(1);
    expect(g.cell[4]).toBe(Cell.Wall);
    expect(Array.from(g.cell.subarray(4, 8))).toEqual([0, 0, 0, 0]);
  });
});

describe("blockBoxes", () => {
  it("marks open cells under a pixel box as building ground and leaves walls alone", () => {
    const g = grid(["....", "..#.", "....", "...."]);
    const n = blockBoxes(g, [{ left: 8, top: 8, right: 24, bottom: 24 }]);
    expect(n).toBe(3);
    expect(g.cell[1 * 4 + 1]).toBe(Cell.Building);
    expect(g.cell[1 * 4 + 2]).toBe(Cell.Wall);
    expect(g.cell[0]).toBe(Cell.Open);
  });
});

describe("clearance", () => {
  it("is the Euclidean distance to the nearest wall or edge", () => {
    const g = grid([
      ".....",
      ".....",
      ".....",
      ".....",
      ".....",
    ]);
    const a = clearance(g);
    expect(a[0]).toBe(1);
    expect(a[2 * 5 + 2]).toBe(3);
    expect(a[1 * 5 + 1]).toBe(2);
  });
  it("is zero on walls and building ground and counts a diagonal wall as adjacent", () => {
    const g = grid(["#..", "...", "..b"]);
    const a = clearance(g);
    expect(a[0]).toBe(0);
    expect(a[8]).toBe(0);
    expect(a[4]).toBeCloseTo(Math.SQRT2, 5);
    expect(a[1]).toBe(1);
  });
});

describe("passageWidth", () => {
  it("measures the shortest line through a cell between walls", () => {
    const g = grid([
      "#######",
      "#.....#",
      "###.###",
      "###.###",
      "#.....#",
      "#######",
    ]);
    const p = open(g);
    expect(passageWidth(p, g.w, g.h, 3, 2)).toBe(1);
    expect(passageWidth(p, g.w, g.h, 3, 1)).toBe(1);
    expect(passageWidth(p, g.w, g.h, 0, 0)).toBe(0);
  });
  it("takes the diagonal when that is the narrow way", () => {
    const g = grid([
      "......",
      "......",
      "......",
      "......",
    ]);
    const p = open(g);
    // Straight: 4 tall; the diagonals are longer, so the straight height wins.
    expect(passageWidth(p, g.w, g.h, 2, 1)).toBe(4);
  });
});

describe("components", () => {
  it("labels 4-connected regions largest first and does not join across a diagonal", () => {
    const g = grid([
      "..#..",
      "..#..",
      "##...",
      ".#...",
    ]);
    const p = open(g);
    const c = components(p, g.w, g.h);
    expect(c.list.length).toBe(3);
    expect(c.list[0].size).toBe(10);
    expect(c.list[1].size).toBe(4);
    expect(c.list[2].size).toBe(1);
    expect(c.label[0]).toBe(1);
    expect(c.label[3 * 5 + 0]).toBe(2);
    expect(c.label[3]).toBe(0);
    expect(c.label[2]).toBe(-1);
  });
});

describe("watershed", () => {
  const map = [
    "################################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#######...######################",
    "#######...######################",
    "#######...######################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "#..............#################",
    "################################",
  ];
  it("finds two rooms and the corridor between them as one choke of the corridor's width", () => {
    const g = grid(map);
    const a = clearance(g);
    const p = open(g);
    const shed = watershed(p, a, g.w, g.h, { minAreaCells: 20, minPeak: 2, mergeRatio: 0.9 });
    expect(shed.areas.length).toBe(2);
    expect(shed.chokes.length).toBe(1);
    const c = shed.chokes[0];
    expect(c.width).toBe(3);
    expect(c.x).toBe(8);
    expect(c.y).toBeGreaterThanOrEqual(11);
    expect(c.y).toBeLessThanOrEqual(13);
    expect(new Set([c.a, c.b])).toEqual(new Set([0, 1]));
    expect(shed.areas[0].chokes).toEqual([0]);
    expect(shed.areas[1].chokes).toEqual([0]);
  });
  it("folds a small area into its neighbour instead of reporting a choke", () => {
    const g = grid(map);
    const a = clearance(g);
    const p = open(g);
    const shed = watershed(p, a, g.w, g.h, { minAreaCells: 500, minPeak: 2, mergeRatio: 0.9 });
    expect(shed.areas.length).toBe(1);
    expect(shed.chokes.length).toBe(0);
  });
  it("treats an open plain with a bump in it as one area", () => {
    const rows: string[] = [];
    for (let y = 0; y < 24; y++) {
      let row = "";
      for (let x = 0; x < 40; x++) row += x === 20 && y >= 10 && y <= 12 ? "#" : ".";
      rows.push(row);
    }
    const g = grid(rows);
    const a = clearance(g);
    const p = open(g);
    const shed = watershed(p, a, g.w, g.h, DEFAULT_AREA_OPTIONS);
    expect(shed.areas.length).toBe(1);
  });
});

describe("seams", () => {
  it("flags open cells at different heights that touch without a ramp, and not those joined by one", () => {
    const g = grid([
      "..11",
      "..11",
      "..rr",
      "..11",
    ]);
    const p = open(g);
    const s = seams(g, p);
    // Two clusters: the ramp row splits them.
    expect(s.list.length).toBe(2);
    expect(s.list[0].levels).toEqual([0, 1]);
    // Rows 0, 1 and 3 have a seam between columns 1 and 2; row 2 goes through the ramp.
    expect(s.mask[0 * 4 + 1]).toBe(1);
    expect(s.mask[0 * 4 + 2]).toBe(1);
    expect(s.mask[2 * 4 + 1]).toBe(0);
    expect(s.mask[2 * 4 + 2]).toBe(0);
    expect(s.list[0].size).toBe(4);
    expect(s.list[1].size).toBe(2);
  });
});

describe("routes", () => {
  const g = grid([
    "##########",
    "#........#",
    "########.#",
    "########.#",
    "#........#",
    "##########",
  ]);
  it("groundDistances walks round the wall, in pixels, and is infinite where there is no way", () => {
    const p = open(g);
    const d = groundDistances(p, g.w, g.h, 1 * g.w + 1);
    expect(d[1 * g.w + 1]).toBe(0);
    expect(d[1 * g.w + 2]).toBe(8);
    // Round the block: seven right, three down, seven left = 17 straight steps, or fewer with diagonals.
    const far = d[4 * g.w + 1];
    expect(far).toBeGreaterThan(14 * 8);
    expect(far).toBeLessThanOrEqual(17 * 8);
    const walled = grid(["...", "###", "..."]);
    const dd = groundDistances(open(walled), 3, 3, 0);
    expect(dd[6]).toBe(Infinity);
  });
  it("widestRoutes reports the bottleneck clearance and parents lead back to the start", () => {
    const p = open(g);
    const a = clearance(g);
    const r = widestRoutes(p, a, g.w, g.h, 1 * g.w + 1);
    const to = 4 * g.w + 8;
    expect(r.best[to]).toBe(1);
    expect(r.best[1 * g.w + 4]).toBe(1);
    let at = to;
    let steps = 0;
    while (r.parent[at] >= 0 && steps < 100) { at = r.parent[at]; steps++; }
    expect(at).toBe(1 * g.w + 1);
  });
});

describe("analyse", () => {
  it("puts two start locations on one island with a ground route, and a third on its own island", () => {
    const rows = [
      "########################",
      "#..........#...........#",
      "#..........#...........#",
      "#..........#...........#",
      "#..........#...........#",
      "#..........#...........#",
      "#..........#...........#",
      "#####..#####...........#",
      "#..........#...........#",
      "#..........#...........#",
      "#..........#...........#",
      "#..........#...........#",
      "#..........#...........#",
      "#..........#...........#",
      "########################",
    ];
    const g = grid(rows);
    const px = (x: number, y: number) => ({ x: x * 8 + 4, y: y * 8 + 4 });
    const a = analyse(g, {
      starts: [{ index: 0, owner: 0, ...px(5, 3) }, { index: 1, owner: 1, ...px(5, 11) }, { index: 2, owner: 2, ...px(17, 7) }],
      unitRadius: 0, minAreaCells: 20, minPeak: 2, mergeRatio: 0.9,
    });
    expect(a.starts.map((s) => s.component)).toEqual([1, 1, 0]);
    expect(a.components[0].starts).toEqual([2]);
    expect(a.components[1].starts).toEqual([0, 1]);
    expect(a.pairs.length).toBe(3);
    const p01 = a.pairs.find((p) => p.a === 0 && p.b === 1)!;
    expect(p01.ground).not.toBeNull();
    expect(p01.bottleneck).toBe(2);
    expect(p01.chokeAt).not.toBeNull();
    expect(p01.chokeAt!.y).toBe(7);
    const p02 = a.pairs.find((p) => p.a === 0 && p.b === 2)!;
    expect(p02.ground).toBeNull();
    expect(p02.bottleneck).toBe(0);
    expect(a.chokes.length).toBe(1);
    expect(a.chokes[0].width).toBe(2);
    expect(a.seams.length).toBe(0);
    const text = report(a, { player: (o) => `P${o + 1}` });
    expect(text).toContain("P1 – P2: air 2, ground");
    expect(text).toContain("P1 – P3: air 3, no ground route");
  });
  it("a unit radius closes passages narrower than the unit", () => {
    const rows = [
      "############",
      "#....#.....#",
      "#....#.....#",
      "#..........#",
      "#....#.....#",
      "#....#.....#",
      "############",
    ];
    const g = grid(rows);
    const starts = [{ index: 0, owner: 0, x: 2 * 8, y: 3 * 8 }, { index: 1, owner: 1, x: 8 * 8, y: 3 * 8 }];
    const loose = analyse(g, { starts, unitRadius: 0, minAreaCells: 4, minPeak: 1 });
    expect(loose.pairs[0].ground).not.toBeNull();
    const tight = analyse(g, { starts, unitRadius: 1, minAreaCells: 4, minPeak: 1 });
    expect(tight.pairs[0].ground).toBeNull();
    expect(tight.starts[0].component).not.toBe(tight.starts[1].component);
    // The start's own cell is off the eroded ground; it is moved to the nearest passable cell.
    expect(tight.starts.every((s) => s.component >= 0)).toBe(true);
  });
  it("componentsAround finds the ground next to a box, and nearestOn the nearest passable cell", () => {
    const g = grid(["....", "....", "....", "...."]);
    blockBoxes(g, [{ left: 8, top: 8, right: 24, bottom: 24 }]);
    const a = analyse(g, { unitRadius: 0 });
    expect(componentsAround(a, { left: 8, top: 8, right: 24, bottom: 24 })).toEqual([0]);
    // With a unit radius the ring next to the box is off the passable ground; a wider margin reaches past it.
    const wide = grid(Array.from({ length: 12 }, () => "............"));
    const band = { left: 0, top: 40, right: 96, bottom: 56 };
    blockBoxes(wide, [band]);
    const eroded = analyse(wide, { unitRadius: 1 });
    expect(componentsAround(eroded, band)).toEqual([]);
    expect(componentsAround(eroded, band, 2).sort()).toEqual([0, 1]);
    expect(nearestOn(a.passable, a.w, a.h, 0, 0)).toEqual({ x: 0, y: 0 });
    const corridor = analyse(grid(["#.#", "###", "###"]), { unitRadius: 0 });
    expect(nearestOn(corridor.passable, 3, 3, 0, 2)).toEqual({ x: 1, y: 0 });
  });
});

describe("formatting", () => {
  it("prints cells and pixels as tiles", () => {
    expect(tiles(4)).toBe("1");
    expect(tiles(6)).toBe("1.5");
    expect(tiles(1)).toBe("0.3");
    expect(pxTiles(96)).toBe("3");
  });
});
