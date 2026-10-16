import { describe, expect, it } from "vitest";
import type { Analysis } from "../analysis";
import { describeWalk, estimatePair, findings, outcomes, seconds, unplaced, walkedFrom, walkFocus } from "../game";
import type { PathingResult, PathingWalk } from "../vendor/scm-sim";

/** A walk between two start locations (player slots), with the fields the findings read. */
function walk(fromStart: number, toStart: number, outcome: PathingWalk["outcome"], travelled: number, more: Partial<PathingWalk> = {}): PathingWalk {
  return {
    unit: 66, from: { x: 0, y: 0 }, to: { x: 1000, y: 0 }, fromStart, toStart, outcome, frames: 480, travelled, distance: outcome === "arrived" ? 80 : 2000, regions: 9,
    every: 8, x: Int16Array.of(0, 500, 900), y: Int16Array.of(0, 10, 20), ...more,
  };
}
const result = (walks: PathingWalk[]) => ({ version: 1, map: { width: 64, height: 64 }, starts: [], regions: null, walks }) as PathingResult;
/** The estimate: three starts (slots 0, 1, 5), ground routes 0–1 of 1,000 px and 0–5 of 2,000 px, none 1–5. */
const estimate = {
  starts: [{ owner: 0 }, { owner: 1 }, { owner: 5 }],
  pairs: [{ a: 0, b: 1, ground: 1000 }, { a: 0, b: 2, ground: 2000 }, { a: 1, b: 2, ground: null }],
} as unknown as Analysis;

describe("what Walkability makes of the game's walks", () => {
  it("finds the estimate's pair either way round", () => {
    expect(estimatePair(estimate, 1, 0)?.ground).toBe(1000);
    expect(estimatePair(estimate, 5, 0)?.ground).toBe(2000);
    expect(estimatePair(estimate, 3, 0)).toBeNull();
  });

  it("reports walks that went wrong, worst first, then detours", () => {
    const r = result([
      walk(0, 1, "arrived", 1100), // close to the estimate: nothing
      walk(0, 1, "arrived", 1400), // 40 % and 400 px more: a detour
      walk(0, 5, "stopped", 3000),
      walk(1, 0, "stuck", 300),
      walk(0, 5, "limit", 9000),
    ]);
    expect(findings(r, estimate).map((f) => [f.kind, f.walk])).toEqual([["stuck", 3], ["stopped", 2], ["limit", 4], ["detour", 1]]);
    expect(findings(r, estimate).find((f) => f.kind === "detour")?.extra).toBe(400);
  });

  it("calls nothing a detour on a short route, or without an estimate", () => {
    const short = { ...estimate, pairs: [{ a: 0, b: 1, ground: 400 }] } as unknown as Analysis;
    // 60 % more, but only 240 px: within what short routes vary by.
    expect(findings(result([walk(0, 1, "arrived", 640)]), short)).toEqual([]);
    expect(findings(result([walk(0, 1, "arrived", 5000)]), null)).toEqual([]);
  });

  it("says when the game finds no ground where the estimate does", () => {
    const r = result([walk(0, 1, "apart", 0), walk(1, 5, "apart", 0)]);
    expect(findings(r, estimate).map((f) => [f.walk, f.estimateHasRoute])).toEqual([[0, true], [1, false]]);
  });

  it("counts the outcomes", () => {
    expect(outcomes([walk(0, 1, "arrived", 1), walk(0, 1, "arrived", 1), walk(0, 1, "stuck", 1)])).toEqual({ arrived: 2, stuck: 1 });
  });

  it("puts a walk in words and seconds at Fastest", () => {
    expect(seconds(24)).toBe("1.0");
    expect(seconds(882)).toBe("37.0");
    expect(describeWalk(walk(0, 1, "arrived", 1))).toBe("20.2 s");
    expect(describeWalk(walk(0, 1, "stopped", 1, { distance: 4800 }))).toBe("stopped 150 tiles short");
    expect(describeWalk(walk(0, 1, "apart", 0))).toBe("no ground between");
  });

  it("looks at where a walk that went wrong ended, else at its middle", () => {
    expect(walkFocus(walk(0, 1, "stopped", 1))).toEqual({ x: 900, y: 20 });
    expect(walkFocus(walk(0, 1, "arrived", 1))).toEqual({ x: 500, y: 10 });
  });

  it("names the units the game did not place, per point walked from", () => {
    const walks = [walk(0, 1, "arrived", 1, { unit: 64 }), walk(0, 5, "arrived", 1, { unit: 64 }), walk(1, 5, "arrived", 1, { unit: 66 })];
    expect(unplaced(walks, [64, 66], [0, 1])).toEqual([{ unit: 66, fromStart: 0 }, { unit: 64, fromStart: 1 }]);
    const own = [{ ...walk(0, 1, "arrived", 1, { unit: 37 }), fromStart: undefined, toStart: undefined }];
    expect(unplaced(own, [37, 66], [undefined])).toEqual([{ unit: 66 }]);
  });

  it("walks from every start but the last, or from all of them both ways", () => {
    const r = { ...result([]), starts: [{ owner: 0, x: 0, y: 0 }, { owner: 3, x: 0, y: 0 }, { owner: 5, x: 0, y: 0 }] } as PathingResult;
    expect(walkedFrom(r, false)).toEqual([0, 3]);
    expect(walkedFrom(r, true)).toEqual([0, 3, 5]);
  });
});
