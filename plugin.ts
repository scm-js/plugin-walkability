/**
 * Walkability — a plugin for the scmJS map editor (https://github.com/jeany55/scm-js).
 *
 * Tools ▸ Walkability… reads the VF4 minitile flags of every tile on the map through
 * `api.tileset.raw()`, marks the ground under buildings and resources, and works out
 * what a ground unit can reach: the islands (regions no ground path joins), the areas
 * a map divides into and the chokes between them with their widths, pockets no start
 * location can reach, cliff seams a unit can walk over without a ramp, and the ground
 * distance and narrowest passage between every pair of start locations. The result is
 * an overlay (`api.ui.overlay`): a picture over the map that the user switches on and
 * off from the View menu, the Layers panel, `Ctrl+Shift+W` or the panel, and that stays
 * up while they place units and doodads on it — an overlay never takes the pointer —
 * following every edit. Hovering the map reads out the cell under the pointer; the
 * panel holds the settings and the problems, and a second panel the full lists.
 *
 * Where the scm-sim plugin's engine is beside the editor (scmjs.dev), the panel can also
 * have the game itself walk the map (`game.ts`): its own regions, and real units walked
 * between the start locations with its own pathfinding, matched against the estimate.
 *
 * `analysis.ts` is the pure part — the grid, the clearance transform, the components,
 * the watershed segmentation, the seams and the start-to-start routes — with its own
 * tests. This file is the editor side: building the grid from the open map, the
 * overlay bitmap per view mode, the overlay and the panels. It reads the map and never
 * writes to it. `@scm-js/plugin-api` is the editor's type declarations, a devDependency
 * generated from its own `src/plugins/api.ts`; the host erases the type-only import.
 */
import type { BusyHandle, MapPointer, MapView, OverlayHandle, PanelHandle, PluginApi } from "@scm-js/plugin-api";
import {
  analyse, blockBoxes, CELL_PX, CELLS_PER_TILE, Cell, componentsAround, gridFromTiles, pxTiles, report, tiles,
  type Analysis, type PixelBox, type StartInput,
} from "./analysis";
import { chokeEnds, describeWalk, findings, GAME_UNITS, groupThrough, miningGap, outcomes, queueFrames, seconds, unplaced, walkedFrom, walkFocus, type Finding } from "./game";
import { bindLanguage, msg, t, translate } from "./i18n";
import { KO } from "./ko";
import type { MeasureBaseResult, MeasureGroupResult, PathingResult, PathingWalk, ScmSimService } from "./vendor/scm-sim";

/* ── DOM helpers ────────────────────────────────────────── */

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") el.className = String(v);
      else if (k === "style") el.setAttribute("style", String(v));
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

const STYLE = `
.wlk { display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
.wlk .wlk-top { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.wlk .wlk-top > label { margin-right: 2px; }
.wlk .wlk-status { color: var(--text-dim, #99a2b3); line-height: 1.35; }
.wlk .wlk-row { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 6px; min-height: 22px; }
.wlk .wlk-row > label { color: var(--text-dim, #99a2b3); }
.wlk .wlk-row .wlk-in { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wlk .wlk-row select { flex: 1; min-width: 0; }
.wlk .wlk-row input[type=range] { flex: 1; min-width: 0; margin: 0; }
.wlk .wlk-row input[type=number] { width: 58px; }
.wlk .wlk-ticks { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.wlk .wlk-under { padding: 5px 8px; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-0, #0f1115); min-height: 34px; line-height: 1.4; }
.wlk .wlk-under b { color: var(--gold, #e6b95c); }
.wlk .wlk-under .wlk-dim { color: var(--text-dim, #99a2b3); }
.wlk details { border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-1, #14171d); }
.wlk details > summary { cursor: pointer; padding: 4px 8px; color: var(--text, #e6e9ef); user-select: none; }
.wlk details > summary .wlk-n { color: var(--text-dim, #99a2b3); margin-left: 4px; }
.wlk details > summary .wlk-warn { color: #ff9f7a; margin-left: 4px; }
.wlk .wlk-list { display: flex; flex-direction: column; max-height: 168px; overflow: auto; border-top: 1px solid var(--border, #333); }
.wlk .wlk-item { display: flex; align-items: center; gap: 6px; padding: 3px 8px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.04); }
.wlk .wlk-item:hover { background: var(--bg-3, #232833); }
.wlk .wlk-item.on { background: var(--teal-dim, #2c8a83); color: #fff; }
.wlk .wlk-item .wlk-sw { flex: none; width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(0,0,0,.5); }
.wlk .wlk-item .wlk-grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wlk .wlk-item .wlk-hint { color: var(--text-dim, #99a2b3); white-space: nowrap; }
.wlk .wlk-item.bad .wlk-hint { color: #ff9f7a; }
.wlk .wlk-empty { padding: 4px 8px; color: var(--text-faint, #6b7382); }
.wlk .wlk-keys { color: var(--text-faint, #6b7382); font-size: 11px; line-height: 1.4; }
.wlk .wlk-keys kbd { font-family: inherit; color: var(--text-dim, #99a2b3); }
.wlk .wlk-game { display: flex; flex-direction: column; gap: 6px; }
.wlk .wlk-game:empty { display: none; }
.wlk .wlk-dim { color: var(--text-dim, #99a2b3); }
.wlk .wlk-h { font-weight: 600; color: var(--text, #e6e9ef); border-top: 1px solid var(--border, #333); padding-top: 7px; }
`;

/* ── Settings ───────────────────────────────────────────── */

type Mode = "areas" | "islands" | "clearance" | "height" | "walk" | "game";

const MODES: { id: Mode; label: string }[] = [
  { id: "areas", label: msg("Areas and chokes") },
  { id: "islands", label: msg("Islands and pockets") },
  { id: "clearance", label: msg("Clearance (room to move)") },
  { id: "height", label: msg("Ground height and seams") },
  { id: "walk", label: msg("Walkable ground") },
  { id: "game", label: msg("The game's regions and walks") },
];

/** Cells of clearance a unit needs; a Marine is 23 px across, three cells. */
const UNIT_SIZES: { radius: number; label: string }[] = [
  { radius: 0, label: msg("Ground as flagged") },
  { radius: 1, label: msg("Small units (Marine, Zergling)") },
  { radius: 2, label: msg("Medium units (Dragoon, Hydralisk)") },
  { radius: 3, label: msg("Large units (Siege Tank, Ultralisk)") },
];

interface Settings {
  mode: Mode;
  chokes: boolean;
  seams: boolean;
  starts: boolean;
  labels: boolean;
  /** 0.1 … 1. */
  opacity: number;
  unitRadius: number;
  buildingsBlock: boolean;
  /** Tiles: an area smaller than this is folded into its neighbour. */
  minArea: number;
  /** Tiles: a pocket smaller than this is only counted, not listed. */
  minPocket: number;
  /** Tiles: a passage wider than this is not a choke worth showing. */
  maxChoke: number;
  /** units.dat ids the game walks (`GAME_UNITS`). */
  gameUnits: number[];
  /** Walk both ways between two start locations. */
  gameBothWays: boolean;
  /** units.dat id of the group of twelve put through the chokes. */
  chokeUnit: number;
}

const DEFAULTS: Settings = { mode: "areas", chokes: true, seams: true, starts: true, labels: true, opacity: 0.45, unitRadius: 1, buildingsBlock: true, minArea: 24, minPocket: 2, maxChoke: 12, gameUnits: [...GAME_UNITS], gameBothWays: false, chokeUnit: 66 };

function loadSettings(api: PluginApi): Settings {
  const stored = api.storage.get<Partial<Settings>>("settings", {});
  const s = { ...DEFAULTS, ...stored };
  if (!MODES.some((m) => m.id === s.mode)) s.mode = DEFAULTS.mode;
  if (!Array.isArray(s.gameUnits)) s.gameUnits = [...DEFAULTS.gameUnits];
  s.gameUnits = s.gameUnits.filter((u) => GAME_UNITS.includes(u));
  if (!GAME_UNITS.includes(s.chokeUnit)) s.chokeUnit = DEFAULTS.chokeUnit;
  return s;
}

/* ── Colours ────────────────────────────────────────────── */

function hsl(hue: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** A distinct colour per id: the golden angle around the hue wheel. */
function idColor(id: number, s = 0.75, l = 0.55): [number, number, number] {
  return hsl((id * 137.508) % 360, s, l);
}

const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** `Player 3`, in the reader's language (`api.names.player` is the English trigger vocabulary). */
const playerName = (slot: number): string => t("Player {n}", { n: slot + 1 });

const RED: [number, number, number] = [255, 80, 70];
const GREY: [number, number, number] = [40, 40, 48];
const LEVELS: [number, number, number][] = [[70, 120, 255], [80, 200, 120], [250, 210, 90]];

/* ── The session ────────────────────────────────────────── */

type Pick =
  | { kind: "area"; id: number }
  | { kind: "island"; id: number }
  | { kind: "choke"; id: number }
  | { kind: "seam"; id: number }
  | { kind: "start"; id: number }
  | { kind: "pair"; id: number }
  /** A walk of the game's: `PathingResult.walks[id]`, or `customWalks[id]`. */
  | { kind: "walk"; id: number }
  | { kind: "custom"; id: number }
  /** A base whose mining was measured: `GameState.mining[id]`. */
  | { kind: "base"; id: number }
  | null;

/** A colour per unit the game walks, by its place in `GAME_UNITS`. */
const UNIT_COLORS: [number, number, number][] = [[240, 240, 240], [255, 214, 10], [40, 200, 255], [255, 140, 30], [255, 70, 210]];
const unitColor = (unit: number): [number, number, number] => UNIT_COLORS[GAME_UNITS.indexOf(unit)] ?? [240, 240, 240];

/** Where the game's own pathing stands: the scm-sim plugin's engine, and what it said last. */
interface GameState {
  service: ScmSimService | null;
  /** Whether it can walk a map here; null until asked. `reason` says why not, for the person. */
  usable: boolean | null;
  reason: string | null;
  result: PathingResult | null;
  /** The map the result is of (`document.id()`), and whether it was edited since. */
  doc: number | null;
  stale: boolean;
  findings: Finding[];
  /** Walks between two points the person picked. */
  custom: PathingWalk[];
  /** Whether the engine can measure (scm-sim 0.8.0 and a page that answers it); null until asked. */
  canMeasure: boolean | null;
  /** A group of twelve through each choke measured (`id` is the choke's), and each base's mining; the halls the person added. */
  chokes: MeasureGroupResult[] | null;
  mining: MeasureBaseResult[] | null;
  halls: { x: number; y: number }[];
  /** Units the game left out (no spot it would take near the point walked from): of the map's walks, and of the person's. */
  unplaced: { unit: number; fromStart?: number }[];
  customUnplaced: number[];
  running: { done: number; total: number; stop: AbortController; what: "map" | "points" | "chokes" | "mining" } | null;
  error: string | null;
}

/** Resources on an island no start location shares: an island expansion, or a mistake. */
interface Stranded {
  index: number;
  name: string;
  x: number;
  y: number;
  /** The island the resource stands on, or -1 when no ground at all touches it. */
  island: number;
  geyser: boolean;
}

class Session {
  settings: Settings;
  panel: PanelHandle | null = null;
  details: PanelHandle | null = null;
  /** The overlay, registered at activation; visibility lives in the editor. */
  view: OverlayHandle | null = null;
  analysis: Analysis | null = null;
  /** An edit arrived while nothing was showing; re-run before showing again. */
  stale = false;
  /** Start locations whose town hall spot the terrain refuses, by index into `analysis.starts`. */
  badHalls = new Set<number>();
  stranded: Stranded[] = [];
  overlay: HTMLCanvasElement | null = null;
  highlight: HTMLCanvasElement | null = null;
  pick: Pick = null;
  hover: { x: number; y: number } | null = null;
  refresh: (() => void)[] = [];
  underText: ((html: string) => void) | null = null;
  /** Set by `activate`: opens the details panel. */
  openDetails: () => void = () => {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A run is under way: the panels show it (a ring in the status, the last results dimmed under a note). */
  running = false;
  game: GameState = { service: null, usable: null, reason: null, result: null, doc: null, stale: false, findings: [], custom: [], canMeasure: null, chokes: null, mining: null, halls: [], unplaced: [], customUnplaced: [], running: null, error: null };
  /** The game's regions as a picture, a pixel a minitile. */
  regions: HTMLCanvasElement | null = null;

  readonly api: PluginApi;

  constructor(api: PluginApi) {
    this.api = api;
    this.settings = loadSettings(api);
  }

  save() { this.api.storage.set("settings", this.settings); }
  notify() { for (const r of this.refresh) r(); }
  get active() { return this.view?.isVisible() ?? false; }
  get listening() { return this.active || (this.panel?.isOpen() ?? false) || (this.details?.isOpen() ?? false); }
  redraw() { this.view?.redraw(); }

  /** The chokes narrow enough to matter, narrowest first. */
  chokes() {
    const a = this.analysis;
    if (!a) return [];
    const max = this.settings.maxChoke * CELLS_PER_TILE;
    return a.chokes.filter((c) => c.width <= max);
  }

  /** Re-run soon: edits arrive in bursts. With nothing showing, just remember to. */
  schedule() {
    if (!this.listening) { this.stale = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, 250);
  }

  /** Read the map. `show` switches the overlay on afterwards (Analyse, the menu); a scheduled re-run leaves it as it is. */
  async run(show = false): Promise<void> {
    if (this.running) { this.schedule(); return; }
    const api = this.api;
    const info = api.document.info();
    const scn = api.document.scenario();
    if (!info || !scn) { this.clear(); this.api.ui.status(t("Walkability: open a map first")); return; }
    this.running = true;
    this.notify();
    try {
      if (!api.tileset.isLoaded()) {
        api.ui.status(t("Walkability: loading the tileset…"));
        await api.tileset.load();
      }
      if (!api.data.ready()) await api.data.load();
      const raw = api.tileset.raw();
      if (!raw) { this.clear(); api.ui.status(t("Walkability: the tileset graphics are not available, so there are no minitile flags to read")); return; }
      const ts = raw.tileset;
      const grid = gridFromTiles(info.width, info.height, scn.tiles, (id) => {
        const group = ts.groups[id >> 4];
        if (!group) return null;
        const megatile = group.megatiles[id & 15];
        if (!megatile || megatile >= ts.megatileCount) return null;
        return ts.megatileFlags.subarray(megatile * 16, megatile * 16 + 16);
      });
      const units = api.data.units();
      const boxOf = (unitId: number, x: number, y: number): PixelBox => {
        if (units) {
          return { left: x - units.extentLeft[unitId], top: y - units.extentUp[unitId], right: x + units.extentRight[unitId] + 1, bottom: y + units.extentDown[unitId] + 1 };
        }
        const size = api.palette.unitSize(unitId);
        return { left: x - size.width / 2, top: y - size.height / 2, right: x + size.width / 2, bottom: y + size.height / 2 };
      };
      if (this.settings.buildingsBlock) {
        const boxes: PixelBox[] = [];
        scn.units.forEach((u) => {
          if (u.unitId === START_LOCATION) return;
          const size = api.palette.unitSize(u.unitId);
          if (!size.building || size.flyer) return;
          boxes.push(boxOf(u.unitId, u.x, u.y));
        });
        blockBoxes(grid, boxes);
      }
      const starts: StartInput[] = api.query.startLocations().map((s) => ({ index: s.index, owner: s.owner, x: s.x, y: s.y }));
      const a = analyse(grid, {
        starts,
        unitRadius: this.settings.unitRadius,
        minAreaCells: Math.max(1, this.settings.minArea) * CELLS_PER_TILE * CELLS_PER_TILE,
      });
      this.analysis = a;
      this.badHalls.clear();
      a.starts.forEach((s, i) => {
        if (api.query.placement(COMMAND_CENTER, s.x, s.y)?.problem === "terrain") this.badHalls.add(i);
      });
      this.stranded = [];
      if (a.starts.length) {
        const reached = new Set<number>();
        for (const c of a.components) if (c.starts.length) reached.add(c.id);
        scn.units.forEach((u, index) => {
          if (!RESOURCES.has(u.unitId)) return;
          const comps = componentsAround(a, boxOf(u.unitId, u.x, u.y), this.settings.unitRadius + 1);
          if (comps.some((c) => reached.has(c))) return;
          const island = comps.length ? Math.min(...comps) : -1;
          this.stranded.push({ index, name: api.palette.unitName(u.unitId), x: u.x, y: u.y, island, geyser: u.unitId === GEYSER });
        });
      }
      if (this.game.result) this.game.findings = findings(this.game.result, a);
      if (this.pick && !this.pickStillValid()) this.pick = null;
      this.overlay = null;
      this.highlight = null;
      api.ui.status(t("Walkability: {islands, plural, one {# island} other {# islands}}, {areas, plural, one {# area} other {# areas}}, {chokes, plural, one {# choke} other {# chokes}}, {seams, plural, one {# height seam} other {# height seams}} in {ms} ms",
        { islands: a.components.length, areas: a.areas.length, chokes: this.chokes().length, seams: a.seams.length, ms: a.took.toFixed(0) }));
      this.stale = false;
      if (show && !this.active) this.show();
      this.redraw();
    } catch (err) {
      api.log("analysis failed", err);
      api.ui.status(t("Walkability: {error}", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      // The panels repaint once the run is over, whichever way it ended.
      this.running = false;
      this.notify();
    }
  }

  private pickStillValid(): boolean {
    const a = this.analysis;
    const p = this.pick;
    if (!a || !p) return false;
    switch (p.kind) {
      case "area": return p.id < a.areas.length;
      case "island": return p.id < a.components.length;
      case "choke": return p.id < a.chokes.length;
      case "seam": return p.id < a.seams.length;
      case "start": return p.id < a.starts.length;
      case "pair": return p.id < a.pairs.length;
      case "walk": return p.id < (this.game.result?.walks.length ?? 0);
      case "custom": return p.id < this.game.custom.length;
      case "base": return p.id < (this.game.mining?.length ?? 0);
    }
  }

  clear() {
    this.analysis = null;
    this.overlay = null;
    this.highlight = null;
    this.pick = null;
    this.stranded = [];
    this.badHalls.clear();
    this.stale = false;
    this.redraw();
    this.notify();
  }

  /* ── the game's own pathing (the scm-sim plugin's engine) ── */

  /** The engine came or went (the scm-sim plugin was switched on or off, or updated). */
  setService(service: ScmSimService | null) {
    this.game.service = service;
    this.game.usable = null;
    this.game.reason = null;
    if (this.panel?.isOpen()) void this.checkGame();
    this.notify();
  }

  /** Ask the engine whether it can walk a map here. */
  async checkGame() {
    const sim = this.game.service;
    if (!sim || !sim.present) { this.game.usable = false; this.game.reason = null; this.notify(); return; }
    if (typeof sim.pathing !== "function") {
      this.game.usable = false;
      this.game.reason = t("This needs version 0.7.0 or later of the scm-sim plugin.");
      this.notify();
      return;
    }
    const status = await sim.status();
    this.game.usable = status.available && status.pathing !== null;
    this.game.canMeasure = this.game.usable && typeof sim.measure === "function" && (status as { measure?: number | null }).measure != null;
    this.game.reason = !status.available ? status.reason : status.pathing === null ? t("The engine's page cannot work out a map's pathing yet. Reload the editor and try again.") : null;
    this.notify();
  }

  /** A unit's name as the editor gives it. */
  unitName(unit: number): string { return this.api.palette.unitName(unit); }

  /** Where a walk went between, in words: the two start locations' players, or two tiles. */
  walkLabel(w: PathingWalk): string {
    const end = (slot: number | undefined, p: { x: number; y: number }) => (slot !== undefined ? playerName(slot) : t("{x}, {y}", { x: pxTiles(p.x), y: pxTiles(p.y) }));
    return t("{unit}: {from} → {to}", { unit: this.unitName(w.unit), from: end(w.fromStart, w.from), to: end(w.toStart, w.to) });
  }

  /** Have the game walk the map: the ticked units between every pair of start locations. */
  async walkMap() {
    await this.walkGame("map");
  }

  /** Have the game walk the ticked units between two tiles the person clicks. */
  async walkPoints() {
    const from = await this.api.ui.pickTile({ prompt: t("Click where the units start") });
    if (!from) return;
    const to = await this.api.ui.pickTile({ prompt: t("Click where they should walk to") });
    if (!to) return;
    const centre = (p: { x: number; y: number }) => ({ x: p.x * 32 + 16, y: p.y * 32 + 16 });
    await this.walkGame("points", centre(from), centre(to));
  }

  private async walkGame(what: "map" | "points", from?: { x: number; y: number }, to?: { x: number; y: number }) {
    const sim = this.game.service;
    if (!sim?.pathing || this.game.running) return;
    if (!this.api.document.isOpen()) { this.api.ui.status(t("Walkability: open a map first")); return; }
    const units = this.settings.gameUnits.length ? this.settings.gameUnits : [...GAME_UNITS];
    const stop = new AbortController();
    const running = { done: 0, total: 0, stop, what };
    this.game.running = running;
    this.game.error = null;
    this.notify();
    try {
      const options = { units, signal: stop.signal, onProgress: (p: { done: number; total: number }) => { running.done = p.done; running.total = p.total; this.notify(); } };
      if (what === "map") {
        // The estimate first, so the game's routes are matched with it.
        if (!this.analysis || this.stale) await this.run();
        const result = await sim.pathing(undefined, { ...options, directed: this.settings.gameBothWays });
        this.game.result = result;
        this.game.doc = this.api.document.id();
        this.game.stale = false;
        this.game.findings = findings(result, this.analysis);
        this.game.unplaced = unplaced(result.walks, units, walkedFrom(result, this.settings.gameBothWays));
        this.regions = null;
        if (this.pick?.kind === "walk") this.pick = null;
        const n = outcomes(result.walks);
        this.api.ui.status(t("Walkability: the game walked {n, plural, one {# route} other {# routes}}, {arrived} arrived, {problems, plural, =0 {no problems} one {# problem} other {# problems}}",
          { n: result.walks.length, arrived: n.arrived ?? 0, problems: this.game.findings.length }));
        if (this.settings.mode !== "game") { this.settings.mode = "game"; this.save(); this.overlay = null; }
        if (!this.active) this.show();
      } else {
        const result = await sim.pathing(undefined, { ...options, from, to: [to!], regions: false });
        this.game.custom = result.walks;
        this.game.customUnplaced = unplaced(result.walks, units, [undefined]).map((u) => u.unit);
        if (this.game.doc === null) this.game.doc = this.api.document.id();
        this.select(result.walks.length ? { kind: "custom", id: 0 } : null);
        if (!this.active) this.show();
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") this.api.ui.status(t("Walkability: the game's walk was stopped"));
      else this.game.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.game.running = null;
      this.redraw();
      this.notify();
    }
  }

  stopGame() { this.game.running?.stop.abort(); }

  /** A measure run: the engine asked through `ask`, with progress, a stop, and a word when it fails. */
  private async measureRun(what: "chokes" | "mining", ask: (sim: ScmSimService, options: { signal: AbortSignal; onProgress: (p: { done: number; total: number }) => void }) => Promise<void>) {
    const sim = this.game.service;
    if (!sim?.measure || this.game.running) return;
    if (!this.api.document.isOpen()) { this.api.ui.status(t("Walkability: open a map first")); return; }
    const stop = new AbortController();
    const running = { done: 0, total: 0, stop, what };
    this.game.running = running;
    this.game.error = null;
    this.notify();
    try {
      await ask(sim, { signal: stop.signal, onProgress: (p) => { running.done = p.done; running.total = p.total; this.notify(); } });
      if (this.game.doc === null) this.game.doc = this.api.document.id();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") this.api.ui.status(t("Walkability: the measuring was stopped"));
      else this.game.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.game.running = null;
      this.redraw();
      this.notify();
    }
  }

  /** Put a group of twelve through every choke listed (those up to the width set), each against one alone. */
  async measureChokes() {
    if (!this.analysis || this.stale) await this.run();
    const a = this.analysis;
    if (!a) return;
    const unit = this.settings.chokeUnit;
    const groups = this.chokes().flatMap((c) => { const ends = chokeEnds(a, c); return ends ? [{ id: c.id, unit, count: 12, ...ends }] : []; });
    if (!groups.length) { this.api.ui.status(t("Walkability: no choke to measure")); return; }
    await this.measureRun("chokes", async (sim, options) => {
      const r = await sim.measure!(undefined, { ...options, groups });
      this.game.chokes = r.groups;
      this.game.stale = false;
      const worst = r.groups.map(queueFrames).filter((q): q is number => q !== null).reduce((x, y) => Math.max(x, y), 0);
      this.api.ui.status(t("Walkability: {n, plural, one {# choke} other {# chokes}} measured, the slowest queueing {s} s", { n: r.groups.length, s: seconds(worst) }));
      if (!this.active) this.show();
    });
  }

  /** Measure every start location's mining, and the halls added. */
  async measureMining() {
    await this.measureRun("mining", async (sim, options) => {
      const r = await sim.measure!(undefined, { ...options, starts: true, bases: this.game.halls.map((hall) => ({ hall })) });
      this.game.mining = r.bases;
      this.game.stale = false;
      this.api.ui.status(t("Walkability: {n, plural, one {# base} other {# bases}} measured", { n: r.bases.length }));
      if (!this.active) this.show();
    });
  }

  /** Add a base by its hall's spot (one click: the hall's middle tile) and measure the mining again. */
  async addBase() {
    const tile = await this.api.ui.pickTile({ prompt: t("Click the middle of where the town hall would stand") });
    if (!tile) return;
    this.game.halls.push({ x: tile.x * 32 + 16, y: tile.y * 32 + 16 });
    await this.measureMining();
  }

  /** How a group got through a choke, in words: short for a list's hint, long for the report. */
  throughText(g: MeasureGroupResult, long = false): string {
    const r = groupThrough(g);
    if (!r) return t("did not get through");
    const stragglers = r.stragglers ? t(", {n, plural, one {# straggler} other {# stragglers}}", { n: r.stragglers }) : "";
    return long
      ? t("{alone} s alone, {most} s for {n} of {count}: {q} s queueing", { alone: seconds(g.alone!), most: seconds(r.most), n: r.count, count: g.made, q: seconds(r.queue) }) + stragglers
      : t("+{q} s ({alone} s alone)", { q: seconds(r.queue), alone: seconds(g.alone!) }) + stragglers;
  }

  /** A base in words: the start location's player, or where its hall is. */
  baseName(b: MeasureBaseResult): string {
    return b.id !== undefined ? t("{player}'s start location", { player: playerName(b.id) }) : t("The base at {x}, {y}", { x: pxTiles(b.hall.x), y: pxTiles(b.hall.y) });
  }

  /** A base's rates in a line: `8: 512 · 16: 848 · 24: 1,112`. */
  rateLine(b: MeasureBaseResult): string {
    if (!b.hallMade) return t("no town hall fits here");
    if (!b.fields) return t("no mineral fields nearby");
    return b.rates.map((r) => `${r.workers}: ${r.perMinute}`).join(" · ");
  }

  /** The widest mining gap between start locations, in words; null when they mine alike. */
  miningGapText(): string | null {
    const gap = this.game.mining ? miningGap(this.game.mining) : null;
    return gap ? t("{slow}'s start location mines {pct} % less than {fast}'s with {n} workers", { slow: playerName(gap.slow), fast: playerName(gap.fast), pct: Math.round(gap.share * 100), n: gap.workers }) : null;
  }

  /** The map was edited: the game's walks are of the map as it was. */
  gameEdited() {
    if (!this.game.result && !this.game.custom.length && !this.game.chokes && !this.game.mining) return;
    if (!this.game.stale) { this.game.stale = true; this.notify(); }
  }

  /** Another map is in front, or none: the walks were of the one before. */
  clearGame() {
    this.game.running?.stop.abort();
    this.game.result = null;
    this.game.custom = [];
    this.game.chokes = null;
    this.game.mining = null;
    this.game.halls = [];
    this.game.findings = [];
    this.game.unplaced = [];
    this.game.customUnplaced = [];
    this.game.doc = null;
    this.game.stale = false;
    this.game.error = null;
    this.regions = null;
    if (this.pick?.kind === "walk" || this.pick?.kind === "custom" || this.pick?.kind === "base") this.pick = null;
    if (this.settings.mode === "game") this.overlay = null;
    this.redraw();
    this.notify();
  }

  /** A finding in words, for the panel's list and the report. */
  findingText(f: Finding): { label: string; hint: string } {
    const w = this.game.result!.walks[f.walk];
    const between = { unit: this.unitName(w.unit), from: w.fromStart !== undefined ? playerName(w.fromStart) : "?", to: w.toStart !== undefined ? playerName(w.toStart) : "?" };
    switch (f.kind) {
      case "stopped": return { label: t("{unit} from {from} to {to} stops short", between), hint: describeWalk(w) };
      case "stuck": return { label: t("{unit} from {from} to {to} gets stuck", between), hint: describeWalk(w) };
      case "limit": return { label: t("{unit} from {from} to {to} is still walking when the time runs out", between), hint: describeWalk(w) };
      case "apart": return {
        label: f.estimateHasRoute ? t("The game finds no ground between {from} and {to}, though the estimate does", between) : t("No ground between {from} and {to}", between),
        hint: this.unitName(w.unit),
      };
      case "detour": return { label: t("{unit} from {from} to {to} walks {n} tiles more than the shortest ground route", { ...between, n: Math.round((f.extra ?? 0) / 32) }), hint: describeWalk(w) };
    }
  }

  /** A unit the game left out of the walks from a start location, in words. */
  unplacedText(u: { unit: number; fromStart?: number }): string {
    return t("The game could not place a {unit} near {from}'s start location, so it walked nothing from there", { unit: this.unitName(u.unit), from: playerName(u.fromStart ?? 0) });
  }

  /** The game's walks as lines of text, for the report. */
  gameReport(): string[] {
    const g = this.game.result;
    if (!g && !this.game.custom.length && !this.game.chokes && !this.game.mining) return [];
    const lines: string[] = ["", t("The game's own pathing")];
    if (g) {
      if (g.regions) lines.push(`  ${t("{n, plural, one {# walkable region} other {# walkable regions}} of {all}", { n: g.regions.walkable.reduce((n, w) => n + w, 0), all: g.regions.count })}`);
      for (const w of g.walks) lines.push(`  ${this.walkLabel(w)}: ${describeWalk(w)}`);
      if (this.game.findings.length || this.game.unplaced.length) {
        lines.push("", t("What the game found"));
        for (const u of this.game.unplaced) lines.push(`  ${this.unplacedText(u)}`);
        for (const f of this.game.findings) lines.push(`  ${this.findingText(f).label}`);
      }
    }
    for (const w of this.game.custom) lines.push(`  ${this.walkLabel(w)}: ${describeWalk(w)}`);
    const a = this.analysis;
    if (this.game.chokes?.length) {
      lines.push("", t("Chokes, a group of twelve {unit} against one alone, timed till ten of them are through", { unit: this.unitName(this.game.chokes[0].unit) }));
      for (const g of this.game.chokes) {
        const c = a?.chokes[g.id ?? -1];
        lines.push(`  ${c ? t("{width} tiles wide at {x}, {y}", { width: tiles(c.width), x: tiles(c.x), y: tiles(c.y) }) : "?"}: ${this.throughText(g, true)}`);
      }
    }
    if (this.game.mining?.length) {
      lines.push("", t("Mining per game minute (8, 16 and 24 workers)"));
      for (const b of this.game.mining) lines.push(`  ${this.baseName(b)}: ${this.rateLine(b)}`);
      const gap = this.miningGapText();
      if (gap) lines.push(`  ${gap}`);
    }
    for (const u of this.game.customUnplaced) lines.push(`  ${t("The game could not place a {unit} at the point picked", { unit: this.unitName(u) })}`);
    if (this.game.stale) lines.push(`  (${t("the map was edited after the game walked it")})`);
    return lines;
  }

  /** The walk a pick names. */
  walkOf(pick: Pick): PathingWalk | null {
    if (pick?.kind === "walk") return this.game.result?.walks[pick.id] ?? null;
    if (pick?.kind === "custom") return this.game.custom[pick.id] ?? null;
    return null;
  }

  /* ── the overlay: the picture and the readout ── */

  show() { this.view?.show(); }
  hide() { this.view?.hide(); }

  /** The overlay was switched, by whichever hand: read the map if there is nothing (current) to draw. */
  onToggle(visible: boolean) {
    if (visible) {
      if ((!this.analysis || this.stale) && this.api.document.isOpen()) void this.run();
    } else {
      this.hover = null;
      this.underText?.(`<span class="wlk-dim">${t("The overlay is off.")}</span>`);
    }
    this.notify();
  }

  private cellAt(p: MapPointer): { x: number; y: number } | null {
    const a = this.analysis;
    if (!a || !p.inMap) return null;
    const x = Math.floor(p.px / CELL_PX);
    const y = Math.floor(p.py / CELL_PX);
    if (x < 0 || y < 0 || x >= a.w || y >= a.h) return null;
    return { x, y };
  }

  /** The pointer over the map (any layer, any tool), or null once when it leaves. */
  onHover(p: MapPointer | null) {
    const c = p ? this.cellAt(p) : null;
    if (!c && !this.hover) return;
    this.hover = c;
    this.underText?.(c ? this.describe(c.x, c.y) : `<span class="wlk-dim">${t("Move the pointer over the map.")}</span>`);
    this.redraw();
  }

  /** Let the user click an area (or, in the islands view, an island) on the map. */
  async pickOnMap() {
    if (!this.analysis) await this.run(true);
    const tile = await this.api.ui.pickTile({ prompt: this.settings.mode === "islands" ? t("Click an island") : t("Click an area") });
    const a = this.analysis;
    if (!tile || !a) return;
    // The tile's centre minitile, else the first cell of the tile that belongs somewhere.
    const labels = this.settings.mode === "islands" ? a.component : a.area;
    const cells = [{ x: 2, y: 2 }];
    for (let y = 0; y < CELLS_PER_TILE; y++) for (let x = 0; x < CELLS_PER_TILE; x++) cells.push({ x, y });
    let id = -1;
    for (const c of cells) {
      const cx = tile.x * CELLS_PER_TILE + c.x, cy = tile.y * CELLS_PER_TILE + c.y;
      if (cx >= a.w || cy >= a.h) continue;
      id = labels[cy * a.w + cx];
      if (id >= 0) break;
    }
    this.select(id >= 0 ? { kind: this.settings.mode === "islands" ? "island" : "area", id } : null);
    if (!this.active) this.show();
  }

  select(pick: Pick) {
    this.pick = pick;
    this.highlight = null;
    this.redraw();
    this.notify();
  }

  /** Scroll to a pick and select it. */
  goTo(pick: Pick) {
    const a = this.analysis;
    if (!a || !pick) return;
    const centre = (x: number, y: number) => this.api.view.center(Math.floor(x / CELLS_PER_TILE), Math.floor(y / CELLS_PER_TILE));
    switch (pick.kind) {
      case "area": { const ar = a.areas[pick.id]; centre(ar.top.x, ar.top.y); break; }
      case "island": { const c = a.components[pick.id]; centre(c.centre.x, c.centre.y); break; }
      case "choke": { const c = a.chokes[pick.id]; centre(c.x, c.y); break; }
      case "seam": { const s = a.seams[pick.id]; centre(s.centre.x, s.centre.y); break; }
      case "start": { const s = a.starts[pick.id]; this.api.view.goTo({ kind: "unit", index: s.index }); break; }
      case "pair": { const p = a.pairs[pick.id]; if (p.chokeAt) centre(p.chokeAt.x, p.chokeAt.y); else this.api.view.goTo({ kind: "unit", index: a.starts[p.a].index }); break; }
      case "base": { const b = this.game.mining?.[pick.id]; if (b) this.api.view.center(Math.floor(b.hall.x / 32), Math.floor(b.hall.y / 32)); break; }
      case "walk": case "custom": { const w = this.walkOf(pick); if (w) { const f = walkFocus(w); this.api.view.center(Math.floor(f.x / 32), Math.floor(f.y / 32)); } break; }
    }
    if (!this.active) this.show();
    this.select(pick);
  }

  private describe(x: number, y: number): string {
    const a = this.analysis!;
    const at = y * a.w + x;
    const tx = Math.floor(x / CELLS_PER_TILE);
    const ty = Math.floor(y / CELLS_PER_TILE);
    const parts: string[] = [`<b>${tx}, ${ty}</b> <span class="wlk-dim">${t("(minitile {x}, {y})", { x: x % 4, y: y % 4 })}</span>`];
    const cell = a.grid.cell[at];
    if (cell === Cell.Wall) parts.push(t("unwalkable"));
    else if (cell === Cell.Building) parts.push(t("under a building"));
    else if (!a.passable[at]) parts.push(t("walkable, but too tight for the chosen unit size ({n} tiles from a wall)", { n: tiles(a.alt[at]) }));
    else parts.push(t("walkable, {n} tiles from the nearest wall", { n: tiles(a.alt[at]) }));
    parts.push(a.grid.ramp[at] ? t("height {n}, ramp", { n: a.grid.level[at] }) : t("height {n}", { n: a.grid.level[at] }));
    if (a.seamMask[at]) parts.push(`<span style="color:#ff9f7a">${t("height seam: no ramp here")}</span>`);
    const comp = a.component[at];
    const area = a.area[at];
    if (comp >= 0) {
      const c = a.components[comp];
      const who = c.starts.length ? c.starts.map((i) => playerName(a.starts[i].owner)).join(", ") : a.starts.length ? t("no start location reaches it") : "";
      parts.push(`${t("Island {n}", { n: comp + 1 })}${who ? ` <span class="wlk-dim">(${who})</span>` : ""}`);
    }
    if (area >= 0) {
      const ar = a.areas[area];
      parts.push(`${t("Area {n}", { n: area + 1 })} <span class="wlk-dim">(${t("{size} tiles, {chokes, plural, one {# choke} other {# chokes}}", { size: tiles(ar.size / CELLS_PER_TILE), chokes: ar.chokes.length })})</span>`);
    }
    // The game's own region here, in its view (the grids are both a cell a minitile).
    const g = this.game.result?.regions;
    if (g && this.settings.mode === "game" && x < g.width && y < g.height) {
      const r = g.grid[y * g.width + x];
      parts.push(g.walkable[r] ? t("the game's region {r}, ground group {g}", { r, g: g.group[r] }) : t("the game's region {r}, unwalkable", { r }));
    }
    return parts.join(" · ");
  }

  /* ── drawing ── */

  private buildOverlay(): HTMLCanvasElement {
    const a = this.analysis!;
    const canvas = document.createElement("canvas");
    canvas.width = a.w;
    canvas.height = a.h;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(a.w, a.h);
    const d = img.data;
    const mode = this.settings.mode;
    const n = a.w * a.h;
    const put = (i: number, c: [number, number, number], alpha: number) => {
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = Math.round(alpha * 255);
    };
    const areaColors = a.areas.map((ar) => idColor(ar.id));
    const islandColors = a.components.map((c) => (c.starts.length ? idColor(c.id, 0.8, 0.5) : hsl(20 + ((c.id * 47) % 30), 0.9, 0.5)));
    const specks = this.settings.minPocket * CELLS_PER_TILE * CELLS_PER_TILE;
    for (let i = 0; i < n; i++) {
      const cell = a.grid.cell[i];
      if (cell === Cell.Building) { put(i, GREY, 0.75); continue; }
      if (cell === Cell.Wall) { if (mode === "walk") put(i, RED, 0.5); continue; }
      if (!a.passable[i]) {
        // Open, but too narrow for the unit size: show as a wall's fringe.
        if (mode === "walk") put(i, [250, 200, 70], 0.55);
        else put(i, [0, 0, 0], 0.3);
        continue;
      }
      switch (mode) {
        case "areas": {
          const id = a.area[i];
          if (id >= 0) put(i, areaColors[id], a.grid.ramp[i] ? 0.95 : 0.7);
          break;
        }
        case "islands": {
          const id = a.component[i];
          if (id < 0) break;
          const c = a.components[id];
          if (!c.starts.length && c.size < specks) put(i, [255, 0, 255], 0.9);
          else put(i, islandColors[id], 0.7);
          break;
        }
        case "clearance": {
          const t = Math.min(1, a.alt[i] / Math.max(1, Math.min(a.maxAlt, 24)));
          // Narrow is red, roomy is blue, through yellow and green.
          put(i, hsl(t * 240, 0.85, 0.5), 0.75);
          break;
        }
        case "height": {
          if (a.grid.ramp[i]) put(i, [255, 255, 255], 0.85);
          else put(i, LEVELS[a.grid.level[i]] ?? LEVELS[0], 0.6);
          break;
        }
        case "walk":
          put(i, [70, 220, 110], 0.4);
          break;
      }
    }
    if (this.settings.seams) {
      for (let i = 0; i < n; i++) if (a.seamMask[i]) put(i, [255, 40, 40], 1);
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** The game's regions, a pixel a minitile: each walkable region its own colour, darker at its edges; unwalkable ground clear. */
  private buildRegions(): HTMLCanvasElement | null {
    const g = this.game.result?.regions;
    if (!g) return null;
    const canvas = document.createElement("canvas");
    canvas.width = g.width;
    canvas.height = g.height;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(g.width, g.height);
    const d = img.data;
    const colors = new Map<number, [number, number, number]>();
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const i = y * g.width + x, r = g.grid[i];
        if (!g.walkable[r]) continue;
        let c = colors.get(r);
        if (!c) { c = idColor(r, 0.6, 0.5); colors.set(r, c); }
        const edge = (x > 0 && g.grid[i - 1] !== r) || (y > 0 && g.grid[i - g.width] !== r) || (x + 1 < g.width && g.grid[i + 1] !== r) || (y + 1 < g.height && g.grid[i + g.width] !== r);
        const k = edge ? 0.45 : 1;
        d[i * 4] = c[0] * k; d[i * 4 + 1] = c[1] * k; d[i * 4 + 2] = c[2] * k; d[i * 4 + 3] = edge ? 235 : 150;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  private buildHighlight(): HTMLCanvasElement | null {
    const a = this.analysis;
    const p = this.pick;
    if (!a || !p || (p.kind !== "area" && p.kind !== "island")) return null;
    const canvas = document.createElement("canvas");
    canvas.width = a.w;
    canvas.height = a.h;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(a.w, a.h);
    const d = img.data;
    const labels = p.kind === "area" ? a.area : a.component;
    const n = a.w * a.h;
    for (let i = 0; i < n; i++) {
      if (labels[i] !== p.id) continue;
      d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; d[i * 4 + 3] = 110;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  draw(ctx: CanvasRenderingContext2D, view: MapView) {
    const a = this.analysis;
    if (!a) return;
    const cellPx = view.tilePx / CELLS_PER_TILE;
    const vis = view.visible;
    const x0 = Math.max(0, vis.x0 * CELLS_PER_TILE);
    const y0 = Math.max(0, vis.y0 * CELLS_PER_TILE);
    const x1 = Math.min(a.w, vis.x1 * CELLS_PER_TILE);
    const y1 = Math.min(a.h, vis.y1 * CELLS_PER_TILE);
    if (x1 <= x0 || y1 <= y0) return;
    const dx = view.x(x0 * CELL_PX);
    const dy = view.y(y0 * CELL_PX);
    const picture = this.settings.mode === "game" ? (this.regions ??= this.buildRegions()) : (this.overlay ??= this.buildOverlay());
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = this.settings.opacity;
    if (picture) ctx.drawImage(picture, x0, y0, x1 - x0, y1 - y0, dx, dy, (x1 - x0) * cellPx, (y1 - y0) * cellPx);
    if (this.pick) {
      this.highlight ??= this.buildHighlight();
      if (this.highlight) {
        ctx.globalAlpha = 1;
        ctx.drawImage(this.highlight, x0, y0, x1 - x0, y1 - y0, dx, dy, (x1 - x0) * cellPx, (y1 - y0) * cellPx);
      }
    }
    ctx.restore();

    const cx = (x: number) => view.x((x + 0.5) * CELL_PX);
    const cy = (y: number) => view.y((y + 0.5) * CELL_PX);
    const showLabels = this.settings.labels && view.tilePx >= 6;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = (text: string, x: number, y: number, color: string) => {
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = "rgba(0,0,0,.7)";
      ctx.fillRect(x - w / 2, y - 8, w, 16);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    };

    // Chokes: a ring the width of the passage, and the width in tiles.
    if (this.settings.chokes && (this.settings.mode === "areas" || this.settings.mode === "clearance")) {
      for (const c of this.chokes()) {
        if (c.x < x0 - 40 || c.y < y0 - 40 || c.x >= x1 + 40 || c.y >= y1 + 40) continue;
        const picked = this.pick?.kind === "choke" && this.pick.id === c.id;
        const r = Math.max(3, (c.width / 2) * cellPx);
        ctx.strokeStyle = picked ? "#fff" : "#ffd166";
        ctx.lineWidth = picked ? 3 : 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(cx(c.x), cy(c.y), r, 0, Math.PI * 2);
        ctx.stroke();
        const measured = this.game.chokes?.find((g) => g.id === c.id), q = measured ? queueFrames(measured) : null;
        if (showLabels) label(measured ? `${tiles(c.width)} · ${q === null ? "✕" : `+${seconds(q)} s`}` : `${tiles(c.width)}`, cx(c.x), cy(c.y) - r - 10, measured && (q === null || q > 72) ? "#ff8a7a" : "#ffd166");
      }
    }
    // Seams: a marker per cluster so a two-minitile seam is not lost at far zoom.
    if (this.settings.seams) {
      for (let i = 0; i < a.seams.length; i++) {
        const s = a.seams[i];
        if (s.centre.x < x0 - 40 || s.centre.y < y0 - 40 || s.centre.x >= x1 + 40 || s.centre.y >= y1 + 40) continue;
        const picked = this.pick?.kind === "seam" && this.pick.id === i;
        ctx.strokeStyle = picked ? "#fff" : "#ff5a4a";
        ctx.lineWidth = picked ? 3 : 1.5;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(view.x(s.bounds.x0 * CELL_PX) - 3, view.y(s.bounds.y0 * CELL_PX) - 3, (s.bounds.x1 - s.bounds.x0) * cellPx + 6, (s.bounds.y1 - s.bounds.y0) * cellPx + 6);
        ctx.setLineDash([]);
        if (showLabels) label(t("no ramp"), cx(s.centre.x), view.y(s.bounds.y0 * CELL_PX) - 12, "#ff8a7a");
      }
    }
    // Start locations: the player and the island, and a warning when the hall cannot be built.
    if (this.settings.starts) {
      a.starts.forEach((s, i) => {
        const x = view.x(s.x);
        const y = view.y(s.y);
        const bad = this.badHalls.has(i) || s.component < 0;
        const picked = this.pick?.kind === "start" && this.pick.id === i;
        ctx.strokeStyle = picked ? "#fff" : bad ? "#ff5a4a" : this.api.palette.playerColor(s.owner);
        ctx.lineWidth = picked ? 3 : 2;
        ctx.strokeRect(x - 2 * view.tilePx, y - 1.5 * view.tilePx, 4 * view.tilePx, 3 * view.tilePx);
        if (showLabels) {
          const text = bad ? (s.component < 0 ? t("not on walkable ground") : t("hall spot not buildable")) : t("island {n}", { n: s.component + 1 });
          label(`${playerName(s.owner)} · ${text}`, x, y + 1.5 * view.tilePx + 10, bad ? "#ff8a7a" : "#e6e9ef");
        }
      });
    }
    // A picked pair: the route's narrowest point.
    if (this.pick?.kind === "pair") {
      const p = a.pairs[this.pick.id];
      const sa = a.starts[p.a];
      const sb = a.starts[p.b];
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(view.x(sa.x), view.y(sa.y));
      ctx.lineTo(view.x(sb.x), view.y(sb.y));
      ctx.stroke();
      ctx.setLineDash([]);
      if (p.chokeAt) {
        const r = Math.max(4, (p.bottleneck / 2) * cellPx);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx(p.chokeAt.x), cy(p.chokeAt.y), r, 0, Math.PI * 2);
        ctx.stroke();
        if (showLabels) label(t("narrowest: {n} tiles", { n: tiles(p.bottleneck) }), cx(p.chokeAt.x), cy(p.chokeAt.y) - r - 10, "#fff");
      }
    }
    // Stranded resources.
    for (const s of this.stranded) {
      ctx.strokeStyle = "#ff5a4a";
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(view.x(s.x), view.y(s.y), view.tilePx * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.drawWalks(ctx, view, showLabels, label);
    // Each base's mining, under its hall.
    if (showLabels) {
      this.game.mining?.forEach((b, i) => {
        const picked = this.pick?.kind === "base" && this.pick.id === i;
        label(`${this.rateLine(b)}${b.hallMade && b.fields ? ` ${t("/min")}` : ""}`, view.x(b.hall.x), view.y(b.hall.y) + 1.5 * view.tilePx + 28, picked ? "#fff" : b.hallMade && b.fields ? "#9fe6a0" : "#ff8a7a");
      });
    }
    // The hovered cell.
    if (this.hover) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(view.x(this.hover.x * CELL_PX)) + 0.5, Math.round(view.y(this.hover.y * CELL_PX)) + 0.5, Math.max(1, Math.round(cellPx) - 1), Math.max(1, Math.round(cellPx) - 1));
    }
  }

  /**
   * The game's walks: all of them in the game's view, else only a picked one; the person's own
   * walks always. A route in its unit's colour, a picked one on top in a white casing, and a
   * cross where a walk that went wrong ended.
   */
  private drawWalks(ctx: CanvasRenderingContext2D, view: MapView, showLabels: boolean, label: (text: string, x: number, y: number, color: string) => void) {
    const walks: { w: PathingWalk; picked: boolean }[] = [];
    const isPicked = (kind: "walk" | "custom", i: number) => this.pick?.kind === kind && this.pick.id === i;
    if (this.settings.mode === "game") (this.game.result?.walks ?? []).forEach((w, i) => walks.push({ w, picked: isPicked("walk", i) }));
    else if (this.pick?.kind === "walk") { const w = this.walkOf(this.pick); if (w) walks.push({ w, picked: true }); }
    this.game.custom.forEach((w, i) => walks.push({ w, picked: isPicked("custom", i) }));
    if (!walks.length) return;
    walks.sort((p, q) => Number(p.picked) - Number(q.picked));
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const { w, picked } of walks) {
      if (w.x.length < 2) continue;
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(view.x(w.x[0]), view.y(w.y[0]));
        for (let k = 1; k < w.x.length; k++) ctx.lineTo(view.x(w.x[k]), view.y(w.y[k]));
      };
      if (picked) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 6; path(); ctx.stroke(); }
      ctx.strokeStyle = rgb(unitColor(w.unit));
      ctx.lineWidth = picked ? 3 : 1.5;
      ctx.globalAlpha = picked || walks.length < 12 ? 1 : 0.8;
      path();
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (w.outcome !== "arrived") {
        const ex = view.x(w.x[w.x.length - 1]), ey = view.y(w.y[w.y.length - 1]), r = Math.max(5, view.tilePx * 0.6);
        ctx.strokeStyle = "#ff5a4a";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(ex - r, ey - r); ctx.lineTo(ex + r, ey + r);
        ctx.moveTo(ex + r, ey - r); ctx.lineTo(ex - r, ey + r);
        ctx.stroke();
        if (showLabels && picked) label(`${this.unitName(w.unit)}: ${describeWalk(w)}`, ex, ey - r - 10, "#ff8a7a");
      }
    }
    ctx.restore();
  }

  /** Stranded resources grouped by island, largest island first (-1 last). */
  strandedByIsland(): [number, { patches: number; geysers: number; first: Stranded }][] {
    const groups = new Map<number, { patches: number; geysers: number; first: Stranded }>();
    for (const s of this.stranded) {
      const g = groups.get(s.island) ?? { patches: 0, geysers: 0, first: s };
      if (s.geyser) g.geysers++; else g.patches++;
      groups.set(s.island, g);
    }
    return [...groups].sort((p, q) => (p[0] < 0 ? 1 : q[0] < 0 ? -1 : p[0] - q[0]));
  }

  copyReport() {
    const a = this.analysis;
    if (!a) return;
    const text = report({ ...a, chokes: this.chokes() }, { player: (o) => playerName(o) });
    const extra: string[] = [];
    for (const i of this.badHalls) extra.push(`  ${t("{player}: the town hall spot is not buildable", { player: playerName(a.starts[i].owner) })}`);
    for (const [island, group] of this.strandedByIsland()) {
      const counts = { patches: group.patches, geysers: group.geysers };
      extra.push(`  ${island < 0
        ? t("{patches, plural, one {# mineral field} other {# mineral fields}} and {geysers, plural, one {# geyser} other {# geysers}} with no walkable ground around them: no start location reaches them by ground", counts)
        : t("{patches, plural, one {# mineral field} other {# mineral fields}} and {geysers, plural, one {# geyser} other {# geysers}} on island {n}: no start location reaches them by ground", { ...counts, n: island + 1 })}`);
    }
    const full = (extra.length ? `${text}\n\n${t("Problems")}\n${extra.join("\n")}` : text) + this.gameReport().map((l) => `\n${l}`).join("");
    void navigator.clipboard?.writeText(full).then(
      () => this.api.ui.status(t("Walkability: report copied")),
      () => this.api.ui.status(t("Walkability: the browser refused the clipboard")),
    );
  }
}

const START_LOCATION = 214;
const COMMAND_CENTER = 106;
const GEYSER = 188;
const RESOURCES: ReadonlySet<number> = new Set([176, 177, 178, GEYSER]);

/* ── The panels ─────────────────────────────────────────── */

type Row = { label: string; hint?: string; color?: string; bad?: boolean; on?: boolean; pick: Pick };

/** A collapsible list of rows, each a click from its spot on the map. */
function section(session: Session, openSections: Set<string>, key: string, title: string, count: number, items: Row[], empty: string, warn?: string): HTMLElement {
  const det = h("details", { open: openSections.has(key) }) as HTMLDetailsElement;
  det.addEventListener("toggle", () => { if (det.open) openSections.add(key); else openSections.delete(key); });
  det.append(h("summary", null, title, h("span", { className: "wlk-n" }, String(count)), warn ? h("span", { className: "wlk-warn" }, warn) : null));
  const list = h("div", { className: "wlk-list" });
  if (!items.length) list.append(h("div", { className: "wlk-empty" }, empty));
  for (const it of items) {
    const el = h("div", { className: `wlk-item${it.on ? " on" : ""}${it.bad ? " bad" : ""}`, title: t("Click to go there"), onClick: () => session.goTo(it.pick) },
      it.color ? h("span", { className: "wlk-sw", style: `background:${it.color}` }) : null,
      h("span", { className: "wlk-grow" }, it.label),
      it.hint ? h("span", { className: "wlk-hint" }, it.hint) : null,
    );
    list.append(el);
  }
  det.append(list);
  return det;
}

/** What the panels say when there is nothing to list. */
function idleText(session: Session): string {
  return session.api.document.isOpen() ? t("Press Analyse, or switch the overlay on, to read the map.") : t("Open a map first.");
}

/** The settings, the readout of the cell under the pointer, and the problems. */
function mountPanel(session: Session, body: HTMLElement): () => void {
  const api = session.api;
  const s = session.settings;
  const W = api.ui.widgets;
  body.append(h("style", null, STYLE));
  const root = h("div", { className: "wlk" });
  body.append(root);

  const status = h("div", { className: "wlk-status" });
  const runBtn = W.button(t("Analyse"), { primary: true, onClick: () => void session.run(true) });
  const shown = W.checkbox(t("Overlay"), { value: session.active, onChange: (v) => { if (v) session.show(); else session.hide(); } });
  const detailsBtn = W.button(t("Details…"), { title: t("Every start location, pair, island, area and choke in a panel of its own"), onClick: () => session.openDetails() });
  root.append(h("div", { className: "wlk-top" }, runBtn, shown, h("span", { style: "flex:1" }), detailsBtn));
  root.append(status);

  const row = (label: string, ...children: Child[]) => h("div", { className: "wlk-row" }, h("label", null, label), h("div", { className: "wlk-in" }, ...children));
  const redraw = () => { session.overlay = null; session.redraw(); };

  const modeSel = W.select(MODES.map((m) => ({ value: m.id, label: translate(m.label) })), { value: s.mode, onChange: (v) => { s.mode = v as Mode; session.save(); redraw(); session.notify(); } });
  root.append(row(t("Overlay"), modeSel));
  const tick = (label: string, key: "chokes" | "seams" | "starts" | "labels") => W.checkbox(label, { value: s[key], onChange: (v) => { s[key] = v; session.save(); redraw(); } });
  root.append(h("div", { className: "wlk-ticks" }, tick(t("Chokes"), "chokes"), tick(t("Seams"), "seams"), tick(t("Start locations"), "starts"), tick(t("Labels"), "labels")));
  const opacity = h("input", { type: "range", min: 10, max: 100, value: Math.round(s.opacity * 100) });
  opacity.addEventListener("input", () => { s.opacity = Number(opacity.value) / 100; session.save(); session.redraw(); });
  root.append(row(t("Opacity"), opacity));

  const sizeSel = W.select(UNIT_SIZES.map((u) => ({ value: u.radius, label: translate(u.label) })), { value: s.unitRadius, onChange: (v) => { s.unitRadius = Number(v); session.save(); void session.run(); } });
  root.append(row(t("Unit size"), sizeSel));
  const minArea = W.number({ value: s.minArea, min: 1, max: 999, step: 1, onChange: (v) => { s.minArea = Math.max(1, Math.round(v)); session.save(); void session.run(); } });
  const maxChoke = W.number({ value: s.maxChoke, min: 1, max: 64, step: 1, onChange: (v) => { s.maxChoke = Math.max(1, Math.round(v)); session.save(); redraw(); session.notify(); } });
  root.append(row(t("Min. area"), minArea, h("span", { style: "color:var(--text-dim,#99a2b3)" }, t("tiles"))));
  root.append(row(t("Chokes up to"), maxChoke, h("span", { style: "color:var(--text-dim,#99a2b3)" }, t("tiles wide"))));
  root.append(W.checkbox(t("Buildings and resources block the way"), { value: s.buildingsBlock, onChange: (v) => { s.buildingsBlock = v; session.save(); void session.run(); } }));

  const under = h("div", { className: "wlk-under" });
  under.innerHTML = `<span class="wlk-dim">${session.active ? t("Move the pointer over the map.") : t("The overlay is off.")}</span>`;
  session.underText = (html) => { under.innerHTML = html; };
  root.append(under);
  const pickBtn = W.button(t("Pick an area on the map"), { ghost: true, onClick: () => void session.pickOnMap() });
  root.append(h("div", { className: "wlk-top" }, pickBtn));

  const results = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  root.append(results);
  const gameBox = h("div", { className: "wlk-game" });
  root.append(gameBox);
  const keys = t("The overlay stays on while you work on any layer and follows every edit; View ▸ Walkability, the Layers panel or {key} switch it off and on.").split("{key}");
  root.append(h("div", { className: "wlk-keys" }, keys[0], h("kbd", null, "Ctrl+Shift+W"), keys[1] ?? ""));

  const openSections = new Set<string>(["problems", "game", "chokes-measured", "mining"]);
  let cover: BusyHandle | null = null;
  if (session.game.service && session.game.usable === null) void session.checkGame();

  /** The game's own pathing: only where the scm-sim plugin's engine is beside the editor. */
  function renderGame() {
    const g = session.game;
    gameBox.replaceChildren();
    if (!g.service?.present) return;
    gameBox.append(h("div", { className: "wlk-h" }, t("The game's own pathing")));
    if (g.usable === false) { gameBox.append(h("div", { className: "wlk-status" }, g.reason ?? t("The game's engine is not available here."))); return; }
    if (g.usable === null) { gameBox.append(W.spinner({ size: "sm", label: t("Asking the game's engine…") })); return; }
    gameBox.append(h("div", { className: "wlk-status" }, t("The game itself walks units between the start locations, with its own regions and pathfinding. Each start location walked from takes a few seconds.")));
    const ticks = h("div", { className: "wlk-ticks" });
    for (const unit of GAME_UNITS) {
      ticks.append(W.checkbox(session.unitName(unit), {
        value: s.gameUnits.includes(unit),
        onChange: (v) => { s.gameUnits = GAME_UNITS.filter((u) => (u === unit ? v : s.gameUnits.includes(u))); session.save(); },
      }));
    }
    ticks.append(W.checkbox(t("Both ways"), { value: s.gameBothWays, title: t("Walk from each start location to each other one, not each pair once"), onChange: (v) => { s.gameBothWays = v; session.save(); } }));
    gameBox.append(ticks);
    const running = g.running;
    const walkBtn = W.button(t("Walk the map"), { primary: true, disabled: running !== null, onClick: () => void session.walkMap() });
    const pointsBtn = W.button(t("Walk between two points"), { ghost: true, disabled: running !== null, onClick: () => void session.walkPoints() });
    gameBox.append(h("div", { className: "wlk-top" }, walkBtn, pointsBtn, running ? W.button(t("Stop"), { ghost: true, onClick: () => session.stopGame() }) : null));
    if (g.canMeasure) {
      const unitSel = W.select(GAME_UNITS.map((u) => ({ value: u, label: session.unitName(u) })), { value: s.chokeUnit, onChange: (v) => { s.chokeUnit = Number(v); session.save(); } });
      gameBox.append(h("div", { className: "wlk-row" }, h("label", null, t("Chokes")), h("div", { className: "wlk-in" },
        W.button(t("Measure"), { disabled: running !== null, title: t("Put a group of twelve through every choke listed, and one alone, and time them"), onClick: () => void session.measureChokes() }),
        h("span", { className: "wlk-dim" }, t("12 ×")), unitSel)));
      gameBox.append(h("div", { className: "wlk-row" }, h("label", null, t("Mining")), h("div", { className: "wlk-in" },
        W.button(t("Measure"), { disabled: running !== null, title: t("Mine at every start location with 8, 16 and 24 workers, and count the minerals per minute"), onClick: () => void session.measureMining() }),
        W.button(t("Add a base…"), { ghost: true, disabled: running !== null, title: t("Click where a town hall would stand, and measure the mining there too"), onClick: () => void session.addBase() }))));
    }
    if (running) {
      const measuring = running.what === "chokes" || running.what === "mining";
      gameBox.append(W.spinner({ size: "sm", label: !running.total ? t("Starting the game…") : measuring ? t("Measuring {done} of {total}…", { done: running.done, total: running.total }) : t("Walking {done} of {total}…", { done: running.done, total: running.total }) }));
      return;
    }
    if (g.error) gameBox.append(h("div", { className: "wlk-status", style: "color:#ff9f7a" }, g.error));
    const r = g.result;
    if (r) {
      const n = outcomes(r.walks);
      const regions = r.regions ? r.regions.walkable.reduce((k, w) => k + w, 0) : null;
      const line = [
        regions !== null ? t("{n, plural, one {# walkable region} other {# walkable regions}}", { n: regions }) : null,
        t("{n, plural, one {# walk} other {# walks}}, {arrived} arrived", { n: r.walks.length, arrived: n.arrived ?? 0 }),
        g.stale ? t("out of date") : null,
      ].filter(Boolean).join(" · ");
      const showBtn = s.mode === "game" ? null : W.button(t("Show"), { ghost: true, title: t("Show the game's regions and walks on the map"), onClick: () => { s.mode = "game"; session.save(); session.overlay = null; session.show(); session.redraw(); session.notify(); } });
      gameBox.append(h("div", { className: "wlk-top" }, h("span", { className: "wlk-status", style: "flex:1" }, line), showBtn));
      const is = (i: number) => session.pick?.kind === "walk" && session.pick.id === i;
      const startPick = (slot: number | undefined): Pick => {
        const i = session.analysis?.starts.findIndex((st) => st.owner === slot) ?? -1;
        return i >= 0 ? { kind: "start", id: i } : null;
      };
      const rows: Row[] = [
        ...g.unplaced.map((u) => ({ label: session.unplacedText(u), hint: t("not placed"), bad: true, color: rgb(unitColor(u.unit)), pick: startPick(u.fromStart) })),
        ...g.findings.map((f) => ({ ...session.findingText(f), bad: f.kind !== "detour", color: rgb(unitColor(r.walks[f.walk].unit)), on: is(f.walk), pick: { kind: "walk", id: f.walk } as Pick })),
      ];
      gameBox.append(section(session, openSections, "game", t("What the game found"), rows.length, rows, t("Every walk arrived, by routes close to the shortest."), undefined));
    }
    g.custom.forEach((w, i) => {
      const on = session.pick?.kind === "custom" && session.pick.id === i;
      gameBox.append(h("div", { className: `wlk-item${on ? " on" : ""}${w.outcome !== "arrived" ? " bad" : ""}`, onClick: () => session.goTo({ kind: "custom", id: i }) },
        h("span", { className: "wlk-sw", style: `background:${rgb(unitColor(w.unit))}` }),
        h("span", { className: "wlk-grow" }, session.walkLabel(w)),
        h("span", { className: "wlk-hint" }, describeWalk(w))));
    });
    for (const u of g.customUnplaced) {
      gameBox.append(h("div", { className: "wlk-status", style: "color:#ff9f7a" }, t("The game could not place a {unit} at the point picked", { unit: session.unitName(u) })));
    }
    const a = session.analysis;
    if (g.chokes?.length) {
      const queue = (x: MeasureGroupResult) => queueFrames(x) ?? Infinity;
      const rows: Row[] = [...g.chokes].sort((x, y) => queue(y) - queue(x)).map((m) => {
        const c = a?.chokes[m.id ?? -1], q = queueFrames(m);
        return {
          label: c ? t("{width} tiles wide at {x}, {y}", { width: tiles(c.width), x: tiles(c.x), y: tiles(c.y) }) : "?",
          hint: session.throughText(m),
          bad: q === null || q > 72 || (groupThrough(m)?.stragglers ?? 0) > 1,
          on: session.pick?.kind === "choke" && session.pick.id === m.id,
          pick: m.id !== undefined && c ? { kind: "choke", id: m.id } : null,
        };
      });
      gameBox.append(section(session, openSections, "chokes-measured", t("Chokes, twelve {unit} at once", { unit: session.unitName(g.chokes[0].unit) }), rows.length, rows, "", g.stale ? t("out of date") : undefined));
    }
    if (g.mining?.length) {
      const rows: Row[] = g.mining.map((b, i) => ({
        label: session.baseName(b),
        hint: session.rateLine(b),
        bad: !b.hallMade || !b.fields,
        color: b.id !== undefined ? api.palette.playerColor(b.id) : undefined,
        on: session.pick?.kind === "base" && session.pick.id === i,
        pick: { kind: "base", id: i } as Pick,
      }));
      const gap = session.miningGapText();
      if (gap) rows.unshift({ label: gap, bad: true, pick: null });
      gameBox.append(section(session, openSections, "mining", t("Minerals per minute with 8, 16 and 24 workers"), g.mining.length, rows, "", g.stale ? t("out of date") : undefined));
    }
  }

  function render() {
    renderGame();
    const a = session.analysis;
    shown.input.checked = session.active;
    // The mode is also set from elsewhere (a walk of the map shows the game's view).
    modeSel.value = s.mode;
    if (session.running) {
      // The last readout stays, dimmed under a note, until the new one replaces it.
      status.replaceChildren(W.spinner({ size: "sm", label: a ? t("Reading the map again…") : t("Reading the map…") }));
      if (results.childElementCount) cover ??= W.busy(results, t("Reading…"));
      runBtn.setBusy(true);
      return;
    }
    cover?.done();
    cover = null;
    runBtn.setBusy(false);
    results.replaceChildren();
    if (!a) {
      status.textContent = idleText(session);
      return;
    }
    const chokes = session.chokes();
    status.textContent = `${t("{islands, plural, one {# island} other {# islands}}, {areas, plural, one {# area} other {# areas}}, {chokes, plural, one {# choke} other {# chokes}}, {seams, plural, one {# height seam} other {# height seams}}",
      { islands: a.components.length, areas: a.areas.length, chokes: chokes.length, seams: a.seams.length })} · ${a.took.toFixed(0)} ms${session.stale ? ` · ${t("out of date")}` : ""}`;
    const is = (kind: NonNullable<Pick>["kind"], id: number) => session.pick?.kind === kind && session.pick.id === id;
    const player = (o: number) => playerName(o);

    const problems: Row[] = [];
    a.starts.forEach((st, i) => {
      if (st.component < 0) problems.push({ label: t("{player}'s start location is not on walkable ground", { player: player(st.owner) }), bad: true, pick: { kind: "start", id: i }, on: is("start", i) });
      else if (session.badHalls.has(i)) problems.push({ label: t("{player}'s town hall spot is not buildable", { player: player(st.owner) }), bad: true, pick: { kind: "start", id: i }, on: is("start", i) });
    });
    if (a.starts.length > 1) {
      const groups = a.components.filter((c) => c.starts.length);
      if (groups.length > 1) problems.push({ label: t("Start locations are on {n} different islands", { n: groups.length }), hint: t("no ground route"), bad: true, pick: { kind: "island", id: groups[1].id } });
    }
    a.seams.forEach((sm, i) => problems.push({ label: t("Height seam at {x}, {y}: height {from} meets {to} with no ramp", { x: tiles(sm.centre.x), y: tiles(sm.centre.y), from: sm.levels[0], to: sm.levels[1] }), hint: t("{n} minitiles", { n: sm.size }), bad: true, pick: { kind: "seam", id: i }, on: is("seam", i) }));
    for (const [island, g] of session.strandedByIsland()) {
      if (island >= 0) continue;
      problems.push({ label: t("{n, plural, one {# resource} other {# resources}} with no walkable ground around them (first: {name} at {x}, {y})", { n: g.patches + g.geysers, name: g.first.name, x: pxTiles(g.first.x), y: pxTiles(g.first.y) }), bad: true, pick: null });
    }
    results.append(section(session, openSections, "problems", t("Problems"), problems.length, problems, t("None found."), undefined));
  }

  session.refresh.push(render);
  render();
  return () => {
    cover?.done();
    session.refresh = session.refresh.filter((r) => r !== render);
    session.underText = null;
  };
}

/** Every start location, pair, island, area and choke, each a click from its spot. */
function mountDetails(session: Session, body: HTMLElement): () => void {
  const api = session.api;
  const s = session.settings;
  body.append(h("style", null, STYLE));
  const root = h("div", { className: "wlk" });
  body.append(root);
  const status = h("div", { className: "wlk-status" });
  root.append(h("div", { className: "wlk-top" }, status, h("span", { style: "flex:1" }), api.ui.widgets.button(t("Copy report"), { ghost: true, title: t("Copy a text summary to the clipboard"), onClick: () => session.copyReport() })));
  const results = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  root.append(results);
  const openSections = new Set<string>(["starts", "pairs", "stranded"]);
  let cover: BusyHandle | null = null;

  function render() {
    const a = session.analysis;
    if (session.running) {
      status.replaceChildren(api.ui.widgets.spinner({ size: "sm", label: t("Reading the map…") }));
      if (results.childElementCount) cover ??= api.ui.widgets.busy(results, t("Reading…"));
      return;
    }
    cover?.done();
    cover = null;
    results.replaceChildren();
    if (!a) {
      status.textContent = idleText(session);
      return;
    }
    const mode = MODES.find((m) => m.id === s.mode);
    status.textContent = `${mode ? translate(mode.label) : ""} · ${a.took.toFixed(0)} ms${session.stale ? ` · ${t("out of date")}` : ""}`;
    const chokes = session.chokes();
    const is = (kind: NonNullable<Pick>["kind"], id: number) => session.pick?.kind === kind && session.pick.id === id;
    const player = (o: number) => playerName(o);
    const list = (key: string, title: string, count: number, items: Row[], empty: string, warn?: string) => results.append(section(session, openSections, key, title, count, items, empty, warn));

    list("starts", t("Start locations"), a.starts.length, a.starts.map((st, i) => ({
      label: t("{player} at {x}, {y}", { player: player(st.owner), x: pxTiles(st.x), y: pxTiles(st.y) }),
      hint: st.component < 0 ? t("off the ground") : t("island {island} · area {area}", { island: st.component + 1, area: st.area + 1 }),
      color: api.palette.playerColor(st.owner),
      bad: st.component < 0 || session.badHalls.has(i),
      on: is("start", i),
      pick: { kind: "start", id: i },
    })), t("The map has no start locations."));

    if (a.starts.length > 1) {
      list("pairs", t("Between start locations"), a.pairs.length, a.pairs.map((p, i) => ({
        label: `${player(a.starts[p.a].owner)} – ${player(a.starts[p.b].owner)}`,
        hint: p.ground === null ? t("air {air} · no ground route", { air: pxTiles(p.air) }) : t("air {air} · ground {ground} · {width} wide", { air: pxTiles(p.air), ground: pxTiles(p.ground), width: tiles(p.bottleneck) }),
        bad: p.ground === null,
        on: is("pair", i),
        pick: { kind: "pair", id: i },
      })), "");
    }

    // Resources no start location reaches by ground: island expansions, or a mistake.
    const offGround = session.strandedByIsland().filter(([island]) => island >= 0);
    if (offGround.length) {
      list("stranded", t("Resources off the main ground"), offGround.length, offGround.map(([island, g]) => ({
        label: t("Island {n}: {patches, plural, one {# patch} other {# patches}}, {geysers, plural, one {# geyser} other {# geysers}}", { n: island + 1, patches: g.patches, geysers: g.geysers }),
        hint: t("no ground route from a start"),
        color: rgb(hsl(20 + ((island * 47) % 30), 0.9, 0.5)),
        pick: { kind: "island", id: island } as Pick,
      })), "");
    }

    const specks = s.minPocket * CELLS_PER_TILE * CELLS_PER_TILE;
    const listed = a.components.filter((c) => c.starts.length || c.size >= specks);
    const hidden = a.components.length - listed.length;
    list("islands", t("Islands and pockets"), a.components.length, listed.map((c) => ({
      label: t("Island {n}: {size} tiles", { n: c.id + 1, size: tiles(c.size / CELLS_PER_TILE) }),
      hint: c.starts.length ? c.starts.map((i) => player(a.starts[i].owner)).join(", ") : a.starts.length ? t("unreachable") : "",
      color: rgb(c.starts.length ? idColor(c.id, 0.8, 0.5) : hsl(20 + ((c.id * 47) % 30), 0.9, 0.5)),
      bad: !c.starts.length && a.starts.length > 0,
      on: is("island", c.id),
      pick: { kind: "island", id: c.id },
    })), t("No walkable ground."), hidden ? t("+ {n} under {size} tiles", { n: hidden, size: s.minPocket }) : undefined);

    list("areas", t("Areas"), a.areas.length, a.areas.map((ar) => ({
      label: t("Area {n}: {size} tiles", { n: ar.id + 1, size: tiles(ar.size / CELLS_PER_TILE) }),
      hint: `${ar.starts.length ? `${ar.starts.map((i) => player(a.starts[i].owner)).join(", ")} · ` : ""}${t("{n, plural, one {# choke} other {# chokes}}", { n: ar.chokes.length })}`,
      color: rgb(idColor(ar.id)),
      on: is("area", ar.id),
      pick: { kind: "area", id: ar.id },
    })), t("No areas."));

    const game = session.game.result;
    if (game?.walks.length) {
      list("walks", t("The game's walks"), game.walks.length, game.walks.map((w, i) => ({
        label: session.walkLabel(w),
        hint: `${describeWalk(w)}${w.outcome === "arrived" ? ` · ${t("{n} tiles", { n: Math.round(w.travelled / 32) })}` : ""}`,
        color: rgb(unitColor(w.unit)),
        bad: w.outcome !== "arrived",
        on: is("walk", i),
        pick: { kind: "walk", id: i },
      })), "", session.game.stale ? t("out of date") : undefined);
    }

    list("chokes", t("Chokes"), chokes.length, chokes.map((c) => ({
      label: t("{width} tiles wide at {x}, {y}", { width: tiles(c.width), x: tiles(c.x), y: tiles(c.y) }),
      hint: t("area {a} ↔ {b}", { a: c.a + 1, b: c.b + 1 }),
      color: "#ffd166",
      on: is("choke", c.id),
      pick: { kind: "choke", id: c.id },
    })), t("No passage up to {n} tiles wide between areas.", { n: s.maxChoke }), a.chokes.length > chokes.length ? t("+ {n} wider", { n: a.chokes.length - chokes.length }) : undefined);
  }

  session.refresh.push(render);
  render();
  return () => { cover?.done(); session.refresh = session.refresh.filter((r) => r !== render); };
}

/* ── activate ───────────────────────────────────────────── */

export default function activate(api: PluginApi) {
  api.i18n.register({ ko: KO });
  bindLanguage(api);
  const session = new Session(api);

  // The overlay is registered once and lives in the editor's chrome: View ▸ Walkability,
  // the Layers panel. Off to begin with — switching it on reads the map.
  session.view = api.ui.overlay({
    // The name is the overlay's identity (the editor remembers its visibility by it), so it stays English.
    name: msg("Walkability"),
    visible: false,
    above: "objects",
    draw: (ctx, view) => session.draw(ctx, view),
    onHover: (p) => session.onHover(p),
    onToggle: (v) => session.onToggle(v),
  });

  const openPanel = () => {
    session.panel = api.ui.panel({
      title: t("Walkability"),
      width: 320,
      mount: (body) => mountPanel(session, body),
      onClose: () => { session.panel = null; },
    });
  };
  const open = () => {
    if (!session.panel?.isOpen()) openPanel();
    void session.run(true);
  };
  session.openDetails = () => {
    if (session.details?.isOpen()) return;
    session.details = api.ui.panel({
      title: t("Walkability details"),
      width: 340,
      mount: (body) => mountDetails(session, body),
      onClose: () => { session.details = null; },
    });
    if (!session.analysis || session.stale) void session.run();
  };
  const toggle = () => {
    if (!api.document.isOpen()) { api.ui.status(t("Walkability: open a map first")); return; }
    session.view?.toggle();
  };

  // Menu labels and command titles go to the editor in English; it shows them in the reader's language.
  api.commands.register({ id: "open", title: msg("Walkability…"), enabled: () => api.document.isOpen(), run: open });
  api.commands.register({ id: "toggle", title: msg("Walkability overlay"), enabled: () => api.document.isOpen(), run: toggle });
  api.commands.register({ id: "details", title: msg("Walkability details"), enabled: () => api.document.isOpen(), run: () => session.openDetails() });
  api.commands.register({ id: "analyse", title: msg("Analyse walkability"), enabled: () => api.document.isOpen(), run: async () => { await session.run(true); return session.analysis; } });
  api.commands.register({ id: "copy-report", title: msg("Copy walkability report"), enabled: () => session.analysis !== null, run: () => session.copyReport() });
  api.menu.add("Tools", { label: msg("Walkability…"), enabled: () => api.document.isOpen(), command: "open" });
  api.contextMenu.add("viewport", { label: msg("Walkability overlay"), command: "toggle" });
  api.hotkeys.add("Ctrl+Shift+W", { command: "toggle" });

  // The game's own pathing, where the scm-sim plugin provides its engine (and it answers `pathing`).
  api.services.watch<ScmSimService>("scm-sim.engine", (service) => session.setService(service));

  for (const event of ["terrain", "units", "doodads", "settings"] as const) api.events.on(event, () => { session.schedule(); session.gameEdited(); });
  api.events.on("document", () => {
    if (!api.document.isOpen()) session.clear();
    else session.schedule();
    // The game's walks belong to the map they were made on.
    if (session.game.doc !== null && session.game.doc !== api.document.id()) session.clearGame();
  });
  // A new language: the panels are built again in it, and the picture's labels follow on the next draw.
  api.events.on("language", () => {
    const reopen = (handle: PanelHandle | null, openIt: () => void) => { if (handle?.isOpen()) { handle.close(); openIt(); } };
    reopen(session.panel, openPanel);
    reopen(session.details, session.openDetails);
    session.redraw();
  });
}
