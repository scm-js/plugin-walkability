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
`;

/* ── Settings ───────────────────────────────────────────── */

type Mode = "areas" | "islands" | "clearance" | "height" | "walk";

const MODES: { id: Mode; label: string }[] = [
  { id: "areas", label: "Areas and chokes" },
  { id: "islands", label: "Islands and pockets" },
  { id: "clearance", label: "Clearance (room to move)" },
  { id: "height", label: "Ground height and seams" },
  { id: "walk", label: "Walkable ground" },
];

/** Cells of clearance a unit needs; a Marine is 23 px across, three cells. */
const UNIT_SIZES: { radius: number; label: string }[] = [
  { radius: 0, label: "Ground as flagged" },
  { radius: 1, label: "Small units (Marine, Zergling)" },
  { radius: 2, label: "Medium units (Dragoon, Hydralisk)" },
  { radius: 3, label: "Large units (Siege Tank, Ultralisk)" },
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
}

const DEFAULTS: Settings = { mode: "areas", chokes: true, seams: true, starts: true, labels: true, opacity: 0.45, unitRadius: 1, buildingsBlock: true, minArea: 24, minPocket: 2, maxChoke: 12 };

function loadSettings(api: PluginApi): Settings {
  const stored = api.storage.get<Partial<Settings>>("settings", {});
  const s = { ...DEFAULTS, ...stored };
  if (!MODES.some((m) => m.id === s.mode)) s.mode = DEFAULTS.mode;
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
  | null;

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
    if (!info || !scn) { this.clear(); this.api.ui.status("Walkability: open a map first"); return; }
    this.running = true;
    this.notify();
    try {
      if (!api.tileset.isLoaded()) {
        api.ui.status("Walkability: loading the tileset…");
        await api.tileset.load();
      }
      if (!api.data.ready()) await api.data.load();
      const raw = api.tileset.raw();
      if (!raw) { this.clear(); api.ui.status("Walkability: the tileset graphics are not available, so there are no minitile flags to read"); return; }
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
      if (this.pick && !this.pickStillValid()) this.pick = null;
      this.overlay = null;
      this.highlight = null;
      const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
      api.ui.status(`Walkability: ${n(a.components.length, "island")}, ${n(a.areas.length, "area")}, ${n(this.chokes().length, "choke")}, ${n(a.seams.length, "height seam")} in ${a.took.toFixed(0)} ms`);
      this.stale = false;
      if (show && !this.active) this.show();
      this.redraw();
    } catch (err) {
      api.log("analysis failed", err);
      api.ui.status(`Walkability: ${err instanceof Error ? err.message : String(err)}`);
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

  /* ── the overlay: the picture and the readout ── */

  show() { this.view?.show(); }
  hide() { this.view?.hide(); }

  /** The overlay was switched, by whichever hand: read the map if there is nothing (current) to draw. */
  onToggle(visible: boolean) {
    if (visible) {
      if ((!this.analysis || this.stale) && this.api.document.isOpen()) void this.run();
    } else {
      this.hover = null;
      this.underText?.(`<span class="wlk-dim">The overlay is off.</span>`);
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
    this.underText?.(c ? this.describe(c.x, c.y) : `<span class="wlk-dim">Move the pointer over the map.</span>`);
    this.redraw();
  }

  /** Let the user click an area (or, in the islands view, an island) on the map. */
  async pickOnMap() {
    if (!this.analysis) await this.run(true);
    const t = await this.api.ui.pickTile({ prompt: this.settings.mode === "islands" ? "Click an island" : "Click an area" });
    const a = this.analysis;
    if (!t || !a) return;
    // The tile's centre minitile, else the first cell of the tile that belongs somewhere.
    const labels = this.settings.mode === "islands" ? a.component : a.area;
    const cells = [{ x: 2, y: 2 }];
    for (let y = 0; y < CELLS_PER_TILE; y++) for (let x = 0; x < CELLS_PER_TILE; x++) cells.push({ x, y });
    let id = -1;
    for (const c of cells) {
      const cx = t.x * CELLS_PER_TILE + c.x, cy = t.y * CELLS_PER_TILE + c.y;
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
    }
    if (!this.active) this.show();
    this.select(pick);
  }

  private describe(x: number, y: number): string {
    const a = this.analysis!;
    const at = y * a.w + x;
    const tx = Math.floor(x / CELLS_PER_TILE);
    const ty = Math.floor(y / CELLS_PER_TILE);
    const parts: string[] = [`<b>${tx}, ${ty}</b> <span class="wlk-dim">(minitile ${x % 4}, ${y % 4})</span>`];
    const cell = a.grid.cell[at];
    if (cell === Cell.Wall) parts.push("unwalkable");
    else if (cell === Cell.Building) parts.push("under a building");
    else if (!a.passable[at]) parts.push(`walkable, but too tight for the chosen unit size (${tiles(a.alt[at])} tiles from a wall)`);
    else parts.push(`walkable, ${tiles(a.alt[at])} tiles from the nearest wall`);
    parts.push(`height ${a.grid.level[at]}${a.grid.ramp[at] ? ", ramp" : ""}`);
    if (a.seamMask[at]) parts.push(`<span style="color:#ff9f7a">height seam: no ramp here</span>`);
    const comp = a.component[at];
    const area = a.area[at];
    if (comp >= 0) {
      const c = a.components[comp];
      const who = c.starts.length ? c.starts.map((i) => this.api.names.player(a.starts[i].owner)).join(", ") : a.starts.length ? "no start location reaches it" : "";
      parts.push(`Island ${comp + 1}${who ? ` <span class="wlk-dim">(${who})</span>` : ""}`);
    }
    if (area >= 0) {
      const ar = a.areas[area];
      parts.push(`Area ${area + 1} <span class="wlk-dim">(${tiles(ar.size / CELLS_PER_TILE)} tiles, ${ar.chokes.length} choke${ar.chokes.length === 1 ? "" : "s"})</span>`);
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
    this.overlay ??= this.buildOverlay();
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = this.settings.opacity;
    ctx.drawImage(this.overlay, x0, y0, x1 - x0, y1 - y0, dx, dy, (x1 - x0) * cellPx, (y1 - y0) * cellPx);
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
        if (showLabels) label(`${tiles(c.width)}`, cx(c.x), cy(c.y) - r - 10, "#ffd166");
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
        if (showLabels) label("no ramp", cx(s.centre.x), view.y(s.bounds.y0 * CELL_PX) - 12, "#ff8a7a");
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
          const text = bad ? (s.component < 0 ? "not on walkable ground" : "hall spot not buildable") : `island ${s.component + 1}`;
          label(`${this.api.names.player(s.owner)} · ${text}`, x, y + 1.5 * view.tilePx + 10, bad ? "#ff8a7a" : "#e6e9ef");
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
        if (showLabels) label(`narrowest: ${tiles(p.bottleneck)} tiles`, cx(p.chokeAt.x), cy(p.chokeAt.y) - r - 10, "#fff");
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
    // The hovered cell.
    if (this.hover) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(view.x(this.hover.x * CELL_PX)) + 0.5, Math.round(view.y(this.hover.y * CELL_PX)) + 0.5, Math.max(1, Math.round(cellPx) - 1), Math.max(1, Math.round(cellPx) - 1));
    }
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
    const text = report({ ...a, chokes: this.chokes() }, { player: (o) => this.api.names.player(o) });
    const extra: string[] = [];
    for (const i of this.badHalls) extra.push(`  ${this.api.names.player(a.starts[i].owner)}: the town hall spot is not buildable`);
    for (const [island, group] of this.strandedByIsland()) {
      const where = island < 0 ? "with no walkable ground around them" : `on island ${island + 1}`;
      extra.push(`  ${group.patches} mineral field${group.patches === 1 ? "" : "s"} and ${group.geysers} geyser${group.geysers === 1 ? "" : "s"} ${where}: no start location reaches them by ground`);
    }
    const full = extra.length ? `${text}\n\nProblems\n${extra.join("\n")}` : text;
    void navigator.clipboard?.writeText(full).then(
      () => this.api.ui.status("Walkability: report copied"),
      () => this.api.ui.status("Walkability: the browser refused the clipboard"),
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
    const el = h("div", { className: `wlk-item${it.on ? " on" : ""}${it.bad ? " bad" : ""}`, title: "Click to go there", onClick: () => session.goTo(it.pick) },
      it.color ? h("span", { className: "wlk-sw", style: `background:${it.color}` }) : null,
      h("span", { className: "wlk-grow" }, it.label),
      it.hint ? h("span", { className: "wlk-hint" }, it.hint) : null,
    );
    list.append(el);
  }
  det.append(list);
  return det;
}

const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** What the panels say when there is nothing to list. */
function idleText(session: Session): string {
  return session.api.document.isOpen() ? "Press Analyse, or switch the overlay on, to read the map." : "Open a map first.";
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
  const runBtn = W.button("Analyse", { primary: true, onClick: () => void session.run(true) });
  const shown = W.checkbox("Overlay", { value: session.active, onChange: (v) => { if (v) session.show(); else session.hide(); } });
  const detailsBtn = W.button("Details…", { title: "Every start location, pair, island, area and choke in a panel of its own", onClick: () => session.openDetails() });
  root.append(h("div", { className: "wlk-top" }, runBtn, shown, h("span", { style: "flex:1" }), detailsBtn));
  root.append(status);

  const row = (label: string, ...children: Child[]) => h("div", { className: "wlk-row" }, h("label", null, label), h("div", { className: "wlk-in" }, ...children));
  const redraw = () => { session.overlay = null; session.redraw(); };

  const modeSel = W.select(MODES.map((m) => ({ value: m.id, label: m.label })), { value: s.mode, onChange: (v) => { s.mode = v as Mode; session.save(); redraw(); session.notify(); } });
  root.append(row("Overlay", modeSel));
  const tick = (label: string, key: "chokes" | "seams" | "starts" | "labels") => W.checkbox(label, { value: s[key], onChange: (v) => { s[key] = v; session.save(); redraw(); } });
  root.append(h("div", { className: "wlk-ticks" }, tick("Chokes", "chokes"), tick("Seams", "seams"), tick("Start locations", "starts"), tick("Labels", "labels")));
  const opacity = h("input", { type: "range", min: 10, max: 100, value: Math.round(s.opacity * 100) });
  opacity.addEventListener("input", () => { s.opacity = Number(opacity.value) / 100; session.save(); session.redraw(); });
  root.append(row("Opacity", opacity));

  const sizeSel = W.select(UNIT_SIZES.map((u) => ({ value: u.radius, label: u.label })), { value: s.unitRadius, onChange: (v) => { s.unitRadius = Number(v); session.save(); void session.run(); } });
  root.append(row("Unit size", sizeSel));
  const minArea = W.number({ value: s.minArea, min: 1, max: 999, step: 1, onChange: (v) => { s.minArea = Math.max(1, Math.round(v)); session.save(); void session.run(); } });
  const maxChoke = W.number({ value: s.maxChoke, min: 1, max: 64, step: 1, onChange: (v) => { s.maxChoke = Math.max(1, Math.round(v)); session.save(); redraw(); session.notify(); } });
  root.append(row("Min. area", minArea, h("span", { style: "color:var(--text-dim,#99a2b3)" }, "tiles")));
  root.append(row("Chokes up to", maxChoke, h("span", { style: "color:var(--text-dim,#99a2b3)" }, "tiles wide")));
  root.append(W.checkbox("Buildings and resources block the way", { value: s.buildingsBlock, onChange: (v) => { s.buildingsBlock = v; session.save(); void session.run(); } }));

  const under = h("div", { className: "wlk-under" });
  under.innerHTML = `<span class="wlk-dim">${session.active ? "Move the pointer over the map." : "The overlay is off."}</span>`;
  session.underText = (html) => { under.innerHTML = html; };
  root.append(under);
  const pickBtn = W.button("Pick an area on the map", { ghost: true, onClick: () => void session.pickOnMap() });
  root.append(h("div", { className: "wlk-top" }, pickBtn));

  const results = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  root.append(results);
  root.append(h("div", { className: "wlk-keys" }, "The overlay stays on while you work on any layer and follows every edit; View ▸ Walkability, the Layers panel or ", h("kbd", null, "Ctrl+Shift+W"), " switch it off and on."));

  const openSections = new Set<string>(["problems"]);
  let cover: BusyHandle | null = null;

  function render() {
    const a = session.analysis;
    shown.input.checked = session.active;
    if (session.running) {
      // The last readout stays, dimmed under a note, until the new one replaces it.
      status.replaceChildren(W.spinner({ size: "sm", label: a ? "Reading the map again…" : "Reading the map…" }));
      if (results.childElementCount) cover ??= W.busy(results, "Reading…");
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
    status.textContent = `${plural(a.components.length, "island")}, ${plural(a.areas.length, "area")}, ${plural(chokes.length, "choke")}, ${plural(a.seams.length, "height seam")} · ${a.took.toFixed(0)} ms${session.stale ? " · out of date" : ""}`;
    const is = (kind: NonNullable<Pick>["kind"], id: number) => session.pick?.kind === kind && session.pick.id === id;
    const player = (o: number) => api.names.player(o);

    const problems: Row[] = [];
    a.starts.forEach((st, i) => {
      if (st.component < 0) problems.push({ label: `${player(st.owner)}'s start location is not on walkable ground`, bad: true, pick: { kind: "start", id: i }, on: is("start", i) });
      else if (session.badHalls.has(i)) problems.push({ label: `${player(st.owner)}'s town hall spot is not buildable`, bad: true, pick: { kind: "start", id: i }, on: is("start", i) });
    });
    if (a.starts.length > 1) {
      const groups = a.components.filter((c) => c.starts.length);
      if (groups.length > 1) problems.push({ label: `Start locations are on ${groups.length} different islands`, hint: "no ground route", bad: true, pick: { kind: "island", id: groups[1].id } });
    }
    a.seams.forEach((sm, i) => problems.push({ label: `Height seam at ${tiles(sm.centre.x)}, ${tiles(sm.centre.y)}: height ${sm.levels[0]} meets ${sm.levels[1]} with no ramp`, hint: `${sm.size} minitiles`, bad: true, pick: { kind: "seam", id: i }, on: is("seam", i) }));
    for (const [island, g] of session.strandedByIsland()) {
      if (island >= 0) continue;
      problems.push({ label: `${g.patches + g.geysers} resource${g.patches + g.geysers === 1 ? "" : "s"} with no walkable ground around them (first: ${g.first.name} at ${pxTiles(g.first.x)}, ${pxTiles(g.first.y)})`, bad: true, pick: null });
    }
    results.append(section(session, openSections, "problems", "Problems", problems.length, problems, "None found.", undefined));
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
  root.append(h("div", { className: "wlk-top" }, status, h("span", { style: "flex:1" }), api.ui.widgets.button("Copy report", { ghost: true, title: "Copy a text summary to the clipboard", onClick: () => session.copyReport() })));
  const results = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  root.append(results);
  const openSections = new Set<string>(["starts", "pairs", "stranded"]);
  let cover: BusyHandle | null = null;

  function render() {
    const a = session.analysis;
    if (session.running) {
      status.replaceChildren(api.ui.widgets.spinner({ size: "sm", label: "Reading the map…" }));
      if (results.childElementCount) cover ??= api.ui.widgets.busy(results, "Reading…");
      return;
    }
    cover?.done();
    cover = null;
    results.replaceChildren();
    if (!a) {
      status.textContent = idleText(session);
      return;
    }
    status.textContent = `${MODES.find((m) => m.id === s.mode)?.label ?? ""} · ${a.took.toFixed(0)} ms${session.stale ? " · out of date" : ""}`;
    const chokes = session.chokes();
    const is = (kind: NonNullable<Pick>["kind"], id: number) => session.pick?.kind === kind && session.pick.id === id;
    const player = (o: number) => api.names.player(o);
    const list = (key: string, title: string, count: number, items: Row[], empty: string, warn?: string) => results.append(section(session, openSections, key, title, count, items, empty, warn));

    list("starts", "Start locations", a.starts.length, a.starts.map((st, i) => ({
      label: `${player(st.owner)} at ${pxTiles(st.x)}, ${pxTiles(st.y)}`,
      hint: st.component < 0 ? "off the ground" : `island ${st.component + 1} · area ${st.area + 1}`,
      color: api.palette.playerColor(st.owner),
      bad: st.component < 0 || session.badHalls.has(i),
      on: is("start", i),
      pick: { kind: "start", id: i },
    })), "The map has no start locations.");

    if (a.starts.length > 1) {
      list("pairs", "Between start locations", a.pairs.length, a.pairs.map((p, i) => ({
        label: `${player(a.starts[p.a].owner)} – ${player(a.starts[p.b].owner)}`,
        hint: p.ground === null ? `air ${pxTiles(p.air)} · no ground route` : `air ${pxTiles(p.air)} · ground ${pxTiles(p.ground)} · ${tiles(p.bottleneck)} wide`,
        bad: p.ground === null,
        on: is("pair", i),
        pick: { kind: "pair", id: i },
      })), "");
    }

    // Resources no start location reaches by ground: island expansions, or a mistake.
    const offGround = session.strandedByIsland().filter(([island]) => island >= 0);
    if (offGround.length) {
      list("stranded", "Resources off the main ground", offGround.length, offGround.map(([island, g]) => ({
        label: `Island ${island + 1}: ${g.patches} patch${g.patches === 1 ? "" : "es"}, ${g.geysers} geyser${g.geysers === 1 ? "" : "s"}`,
        hint: "no ground route from a start",
        color: rgb(hsl(20 + ((island * 47) % 30), 0.9, 0.5)),
        pick: { kind: "island", id: island } as Pick,
      })), "");
    }

    const specks = s.minPocket * CELLS_PER_TILE * CELLS_PER_TILE;
    const listed = a.components.filter((c) => c.starts.length || c.size >= specks);
    const hidden = a.components.length - listed.length;
    list("islands", "Islands and pockets", a.components.length, listed.map((c) => ({
      label: `Island ${c.id + 1}: ${tiles(c.size / CELLS_PER_TILE)} tiles`,
      hint: c.starts.length ? c.starts.map((i) => player(a.starts[i].owner)).join(", ") : a.starts.length ? "unreachable" : "",
      color: rgb(c.starts.length ? idColor(c.id, 0.8, 0.5) : hsl(20 + ((c.id * 47) % 30), 0.9, 0.5)),
      bad: !c.starts.length && a.starts.length > 0,
      on: is("island", c.id),
      pick: { kind: "island", id: c.id },
    })), "No walkable ground.", hidden ? `+ ${hidden} under ${s.minPocket} tiles` : undefined);

    list("areas", "Areas", a.areas.length, a.areas.map((ar) => ({
      label: `Area ${ar.id + 1}: ${tiles(ar.size / CELLS_PER_TILE)} tiles`,
      hint: `${ar.starts.length ? `${ar.starts.map((i) => player(a.starts[i].owner)).join(", ")} · ` : ""}${ar.chokes.length} choke${ar.chokes.length === 1 ? "" : "s"}`,
      color: rgb(idColor(ar.id)),
      on: is("area", ar.id),
      pick: { kind: "area", id: ar.id },
    })), "No areas.");

    list("chokes", "Chokes", chokes.length, chokes.map((c) => ({
      label: `${tiles(c.width)} tiles wide at ${tiles(c.x)}, ${tiles(c.y)}`,
      hint: `area ${c.a + 1} ↔ ${c.b + 1}`,
      color: "#ffd166",
      on: is("choke", c.id),
      pick: { kind: "choke", id: c.id },
    })), `No passage up to ${s.maxChoke} tiles wide between areas.`, a.chokes.length > chokes.length ? `+ ${a.chokes.length - chokes.length} wider` : undefined);
  }

  session.refresh.push(render);
  render();
  return () => { cover?.done(); session.refresh = session.refresh.filter((r) => r !== render); };
}

/* ── activate ───────────────────────────────────────────── */

export default function activate(api: PluginApi) {
  const session = new Session(api);

  // The overlay is registered once and lives in the editor's chrome: View ▸ Walkability,
  // the Layers panel. Off to begin with — switching it on reads the map.
  session.view = api.ui.overlay({
    name: "Walkability",
    visible: false,
    above: "objects",
    draw: (ctx, view) => session.draw(ctx, view),
    onHover: (p) => session.onHover(p),
    onToggle: (v) => session.onToggle(v),
  });

  const open = () => {
    if (session.panel?.isOpen()) { void session.run(true); return; }
    session.panel = api.ui.panel({
      title: "Walkability",
      width: 320,
      mount: (body) => mountPanel(session, body),
      onClose: () => { session.panel = null; },
    });
    void session.run(true);
  };
  session.openDetails = () => {
    if (session.details?.isOpen()) return;
    session.details = api.ui.panel({
      title: "Walkability details",
      width: 340,
      mount: (body) => mountDetails(session, body),
      onClose: () => { session.details = null; },
    });
    if (!session.analysis || session.stale) void session.run();
  };
  const toggle = () => {
    if (!api.document.isOpen()) { api.ui.status("Walkability: open a map first"); return; }
    session.view?.toggle();
  };

  api.commands.register({ id: "open", title: "Walkability…", enabled: () => api.document.isOpen(), run: open });
  api.commands.register({ id: "toggle", title: "Walkability overlay", enabled: () => api.document.isOpen(), run: toggle });
  api.commands.register({ id: "details", title: "Walkability details", enabled: () => api.document.isOpen(), run: () => session.openDetails() });
  api.commands.register({ id: "analyse", title: "Analyse walkability", enabled: () => api.document.isOpen(), run: async () => { await session.run(true); return session.analysis; } });
  api.commands.register({ id: "copy-report", title: "Copy walkability report", enabled: () => session.analysis !== null, run: () => session.copyReport() });
  api.menu.add("Tools", { label: "Walkability…", enabled: () => api.document.isOpen(), command: "open" });
  api.contextMenu.add("viewport", { label: "Walkability overlay", command: "toggle" });
  api.hotkeys.add("Ctrl+Shift+W", { command: "toggle" });

  for (const event of ["terrain", "units", "doodads", "settings"] as const) api.events.on(event, () => session.schedule());
  api.events.on("document", () => {
    if (!api.document.isOpen()) session.clear();
    else session.schedule();
  });
}
