/**
 * The game's own pathing, as the scm-sim plugin's engine answers it (`vendor/scm-sim.d.ts`,
 * `pathing()`): what Walkability makes of the answer. The engine walks real units between the
 * start locations with the game's own code; here the walks are matched with Walkability's
 * own estimate of each route and turned into findings for the panels and the report. Pure,
 * with its own tests; the editor side is in `plugin.ts`.
 */
import type { MeasureBaseResult, MeasureGroupResult, PathingResult, PathingWalk } from "./vendor/scm-sim";
import { CELL_PX, type Analysis, type Choke } from "./analysis";
import { t } from "./i18n";

/** The units the game can walk here (units.dat ids): Probe, Zergling, Dragoon, Siege Tank, Ultralisk. Their names come from the editor. */
export const GAME_UNITS: readonly number[] = [64, 37, 66, 5, 39];

/** Frames a second at Fastest, the speed games are played at (42 ms a frame). */
export const FASTEST = 1000 / 42;

/** A walk's time at Fastest, in seconds with one decimal. */
export function seconds(frames: number): string {
  return (frames / FASTEST).toFixed(1);
}

/** A route the game walks at least this much longer than Walkability's shortest ground route is called a detour. */
export const DETOUR_RATIO = 1.3;
/** …and only when the difference is at least this many pixels (ten tiles): short routes vary by more than a ratio says. */
export const DETOUR_MIN_PX = 320;

export type FindingKind = "stopped" | "stuck" | "limit" | "detour" | "apart";

/** Something about a walk worth a map maker's attention. `walk` indexes `PathingResult.walks`. */
export interface Finding {
  kind: FindingKind;
  walk: number;
  /** For a detour: the pixels the game walked over the estimate's shortest ground route. */
  extra?: number;
  /** For `apart`: whether Walkability's estimate found a ground route all the same (the two disagree). */
  estimateHasRoute?: boolean;
}

/** The estimate's pair between the two start locations of player slots `a` and `b`, either way round. */
export function estimatePair(a: Analysis, ownerA: number, ownerB: number) {
  return a.pairs.find((p) => {
    const x = a.starts[p.a].owner, y = a.starts[p.b].owner;
    return (x === ownerA && y === ownerB) || (x === ownerB && y === ownerA);
  }) ?? null;
}

/**
 * The findings, worst first: walks that stopped short, got stuck or ran out of time, starts
 * the game finds no ground between, and routes the game walks much longer than the shortest
 * ground route Walkability estimates (`analysis`, when there is one).
 */
export function findings(result: PathingResult, analysis: Analysis | null): Finding[] {
  const out: Finding[] = [];
  result.walks.forEach((w, i) => {
    if (w.outcome === "stopped" || w.outcome === "stuck" || w.outcome === "limit") { out.push({ kind: w.outcome, walk: i }); return; }
    if (w.outcome === "apart") {
      const pair = analysis && w.fromStart !== undefined && w.toStart !== undefined ? estimatePair(analysis, w.fromStart, w.toStart) : null;
      out.push({ kind: "apart", walk: i, estimateHasRoute: pair ? pair.ground !== null : undefined });
      return;
    }
    if (w.outcome !== "arrived" || !analysis || w.fromStart === undefined || w.toStart === undefined) return;
    const pair = estimatePair(analysis, w.fromStart, w.toStart);
    if (!pair || pair.ground === null) return;
    const extra = w.travelled - pair.ground;
    if (w.travelled >= pair.ground * DETOUR_RATIO && extra >= DETOUR_MIN_PX) out.push({ kind: "detour", walk: i, extra });
  });
  const rank: Record<FindingKind, number> = { stuck: 0, stopped: 1, limit: 2, apart: 3, detour: 4 };
  return out.sort((x, y) => rank[x.kind] - rank[y.kind] || x.walk - y.walk);
}

/** How many walks ended each way. */
export function outcomes(walks: readonly PathingWalk[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of walks) out[w.outcome] = (out[w.outcome] ?? 0) + 1;
  return out;
}

/** A walk's outcome in words, for a list's hint. */
export function describeWalk(w: PathingWalk): string {
  const tilesOff = Math.round(w.distance / 32);
  switch (w.outcome) {
    case "arrived": return t("{s} s", { s: seconds(w.frames) });
    case "stopped": return t("stopped {n} tiles short", { n: tilesOff });
    case "stuck": return t("stuck {n} tiles short", { n: tilesOff });
    case "limit": return t("still walking after {s} s", { s: seconds(w.frames) });
    case "apart": return t("no ground between");
    case "unmoved": return t("did not move");
  }
}

/** Where to look at a walk: where it ended when it went wrong, else its middle. */
export function walkFocus(w: PathingWalk): { x: number; y: number } {
  if (w.outcome !== "arrived" && w.x.length) return { x: w.x[w.x.length - 1], y: w.y[w.y.length - 1] };
  const mid = Math.floor(w.x.length / 2);
  return w.x.length ? { x: w.x[mid], y: w.y[mid] } : w.from;
}

/**
 * The units the game did not place: the engine stands the test units near each point walked
 * from, and the game leaves out a unit whose spot it would not take (a cliff edge, too tight
 * for its size), so it has no walks from there. `froms` are the start locations walked from
 * (their player slots), or `undefined` for the person's own point.
 */
export function unplaced(walks: readonly PathingWalk[], asked: readonly number[], froms: readonly (number | undefined)[]): { unit: number; fromStart?: number }[] {
  const out: { unit: number; fromStart?: number }[] = [];
  for (const from of froms) {
    const there = new Set(walks.filter((w) => w.fromStart === from).map((w) => w.unit));
    for (const unit of asked) if (!there.has(unit)) out.push(from === undefined ? { unit } : { unit, fromStart: from });
  }
  return out;
}

/** The start locations a walk of the map goes from: each but the last, or every one when walked both ways. */
export function walkedFrom(result: PathingResult, bothWays: boolean): number[] {
  const slots = result.starts.map((s) => s.owner);
  return bothWays ? slots : slots.slice(0, -1);
}

/* ── Measures: groups through chokes, and each base's mining ── */

/**
 * Two points a group walks between to cross a choke: `reach` cells out on each side, along a straight line through
 * its middle that stays on open ground, ending in the two areas the choke joins (from area `a` to area `b`). Of the
 * lines that do, the one ending furthest from walls. Shorter reaches are tried when none does; null when nothing fits.
 * Map pixels.
 */
export function chokeEnds(a: Analysis, c: Choke, reach = 32): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
  const px = (p: { x: number; y: number }) => ({ x: p.x * CELL_PX + CELL_PX / 2, y: p.y * CELL_PX + CELL_PX / 2 });
  for (const r of [reach, reach * 0.75, reach * 0.5, reach * 0.35].map(Math.round)) {
    let best: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null, score = -1;
    for (let k = 0; k < 32; k++) {
      const dx = Math.cos((k * Math.PI) / 16), dy = Math.sin((k * Math.PI) / 16);
      const end = (sign: number) => {
        for (let step = 1; step <= r; step++) {
          const x = Math.round(c.x + dx * step * sign), y = Math.round(c.y + dy * step * sign);
          if (x < 0 || y < 0 || x >= a.w || y >= a.h || !a.open[y * a.w + x]) return null;
        }
        return { x: Math.round(c.x + dx * r * sign), y: Math.round(c.y + dy * r * sign) };
      };
      const p = end(1), q = end(-1);
      if (!p || !q) continue;
      const ap = a.area[p.y * a.w + p.x], aq = a.area[q.y * a.w + q.x];
      const pair = ap === c.a && aq === c.b ? { from: p, to: q } : ap === c.b && aq === c.a ? { from: q, to: p } : null;
      if (!pair) continue;
      const room = a.alt[p.y * a.w + p.x] + a.alt[q.y * a.w + q.x];
      if (room > score) { score = room; best = { from: px(pair.from), to: px(pair.to) }; }
    }
    if (best) return best;
  }
  return null;
}

/** The share of a group whose time stands for it: a few stragglers go round or wait, and would decide the last. */
export const MOST = 10 / 12;

/**
 * How a group got through a choke: the frames for most of it (`MOST`, ten of twelve) against one alone, the time it
 * spent queueing (the difference), and the stragglers (those through after twice that, or not at all). Null when one
 * alone or most of the group did not get through.
 */
export function groupThrough(g: MeasureGroupResult): { most: number; queue: number; stragglers: number; count: number } | null {
  const count = g.made, need = Math.max(1, Math.ceil(count * MOST));
  if (g.alone === null || g.times.length < need) return null;
  const most = g.times[need - 1];
  return { most, queue: Math.max(0, most - g.alone), stragglers: count - g.times.filter((f) => f <= 2 * most).length, count: need };
}

/** The frames a group spent queueing (`groupThrough`); null when it did not get through. */
export function queueFrames(g: MeasureGroupResult): number | null {
  return groupThrough(g)?.queue ?? null;
}

/**
 * The widest gap in mining between the bases of two start locations (their `id` a player slot), at the worker count
 * where it is widest, when it is at least `least` (a share: 0.05 is five per cent). Null when the starts mine alike.
 */
export function miningGap(bases: readonly MeasureBaseResult[], least = 0.05): { slow: number; fast: number; workers: number; share: number } | null {
  const starts = bases.filter((b) => b.id !== undefined && b.rates.length);
  let best: { slow: number; fast: number; workers: number; share: number } | null = null;
  const counts = [...new Set(starts.flatMap((b) => b.rates.map((r) => r.workers)))];
  for (const workers of counts) {
    const at = starts.map((b) => ({ id: b.id!, rate: b.rates.find((r) => r.workers === workers)?.perMinute ?? 0 })).filter((x) => x.rate > 0);
    if (at.length < 2) continue;
    const fast = at.reduce((x, y) => (y.rate > x.rate ? y : x)), slow = at.reduce((x, y) => (y.rate < x.rate ? y : x));
    const share = (fast.rate - slow.rate) / fast.rate;
    if (share >= least && (!best || share > best.share)) best = { slow: slow.id, fast: fast.id, workers, share };
  }
  return best;
}
