// A copy of scm-js/plugin-scm-sim's contract.d.ts at v0.7.0: the `scm-sim.engine` service's types. Types only.
/**
 * The `scm-sim.engine` service, as other plugins see it. Types only: take this file with
 * `import type` and reach the object through `api.services.watch("scm-sim.engine", …)`.
 * The provider's `ServiceInfo.version` is 1 for this shape.
 *
 * The timeline types are the engine's own (scm-sim `src/analysis/timeline.ts`), copied
 * here; `ReplayTimeline.version` says which form a timeline has.
 */

/**
 * `born`: the unit is there for the first time (a building's site, a unit leaving its
 * factory, a larva). `done`: it is finished. `morph`: it is another type now (`from` the
 * type before): a larva an egg, an egg a zergling, a drone a hatchery, a hatchery a lair,
 * a geyser a refinery. `given`: another player's now (`from` the owner before); a player
 * who leaves gives everything to a neutral player. `died`: gone, at the place it was
 * last seen.
 */
export type UnitEventKind = "born" | "done" | "morph" | "given" | "died";

export interface UnitEvent {
  frame: number;
  kind: UnitEventKind;
  /** The unit's number in this timeline, from 0 in the order of appearing. */
  unit: number;
  /** units.dat id, after the event. */
  type: number;
  /** Player slot 0..11, after the event. */
  owner: number;
  /** Pixels, the unit's centre. */
  x: number;
  y: number;
  /** `morph`: the type before. `given`: the owner before. */
  from?: number;
  /** `born`: a hallucination. */
  hallucination?: true;
  /**
   * `died`, from timeline version 2: the unit the game credited with the kill, its type and
   * owner then, and where it stood. The game counts a kill to a unit's name (a reaver's for
   * its scarab's, a carrier's for its interceptors', a templar's for its storm's). A death
   * nobody is credited with has none of these: a unit used up (a scarab, a spider mine), a
   * spell running out, a building cancelled, and what a spider mine killed.
   */
  by?: number;
  byType?: number;
  byOwner?: number;
  byX?: number;
  byY?: number;
}

/** An upgrade's level reached or a technology researched, seen at a sample (so `frame` is late by up to `samples.every`). */
export interface ResearchEvent {
  frame: number;
  player: number;
  kind: "upgrade" | "tech";
  /** upgrades.dat or techdata.dat id. */
  id: number;
  /** An upgrade's level; 1 for a technology. */
  level: number;
}

/** One player's numbers, an entry per sample (`samples.frame`). */
export interface PlayerSeries {
  slot: number;
  minerals: number[];
  gas: number[];
  supplyUsed: number[];
  supplyMax: number[];
  /** Finished workers. */
  workers: number[];
  /** Finished units that are neither buildings nor workers (larvae, eggs and what a unit fires are not counted). */
  army: number[];
  /** What those cost, minerals and gas together. */
  armyValue: number[];
  /** Finished buildings. */
  buildings: number[];
  /**
   * From timeline version 4: everything gathered since the start, the game's own counts (its
   * score screen's "mined"). A melee game counts the 50 minerals it starts with; what a map's
   * triggers give is not counted. Income is the difference between two samples.
   */
  mineralsGathered?: number[];
  gasGathered?: number[];
}

/** Where the units stood at regular frames: sample `i` is rows `start[i]` to `start[i + 1]` of `unit`, `x`, `y`. Buildings and units inside something are left out. */
export interface Positions {
  every: number;
  frame: number[];
  start: Uint32Array;
  unit: Uint32Array;
  x: Uint16Array;
  y: Uint16Array;
}

/**
 * Whether the game played by the engine stayed the game the replay was recorded from. A
 * replay's commands name units by the game's own slots, so each name is held against the
 * game as it is played: a name of a unit the game had not made yet cannot come from the game
 * that was played.
 */
export interface ReplayCheck {
  /** Units the commands named, and of those: the unit had died before the command reached the game (no sign of anything). */
  named: number;
  gone: number;
  /** Names of a unit the game had not made. */
  ahead: number;
  /** The frame of the first of those: what the timeline says from there on is not what happened. null: none, the whole game stands. */
  parted: number | null;
}

export interface ReplayTimeline {
  /** 1: as first written. 2: a `died` event says who killed the unit. 3: `check`. 4: what each player gathered. */
  version: number;
  /** Frames played, and the replay's length. */
  frames: number;
  total: number;
  /** How the game stopped, in the engine's words, or null when the replay simply ran out. */
  ended: string | null;
  /** In tiles. */
  map: { width: number; height: number };
  /** Race: 0 zerg, 1 terran, 2 protoss. */
  players: { slot: number; name: string; race: number }[];
  events: UnitEvent[];
  research: ResearchEvent[];
  samples: { every: number; frame: number[]; players: PlayerSeries[] };
  /** Null when not asked for. */
  positions: Positions | null;
  /** From timeline version 3; absent in a timeline of an engine before that. */
  check?: ReplayCheck | null;
}

export interface AnalyseProgress {
  /** "starting": the engine is being fetched and the game started. "playing": `frame` of `frames`. */
  stage: "starting" | "playing";
  frame: number;
  frames: number;
}

export interface AnalyseOptions {
  /** Frames between samples of the players' numbers; 48 (two seconds at Fastest) when left out. */
  sampleEvery?: number;
  /** Frames between samples of where units stood; the same as `sampleEvery` when left out, 0 for none. */
  positionsEvery?: number;
  /** The file's name, for the engine's own messages. */
  name?: string;
  onProgress?(progress: AnalyseProgress): void;
  /** Aborting stops the game and rejects the promise with an `AbortError`. */
  signal?: AbortSignal;
}

export interface ScmSimStatus {
  /** Whether a replay or a map can be run here now. */
  available: boolean;
  /**
   * Where the engine reads the game from: the person's own 1.16.1 archives, a copy the
   * editor made (the Game Data page), a development server's files, or null when the
   * browser has none.
   */
  files: "archives" | "copy" | "server" | null;
  /** When not available: why, in words for the person. */
  reason: string | null;
  /** The `ReplayTimeline.version` the engine writes, or null when it could not be asked. */
  timeline: number | null;
  /**
   * The `PathingResult.version` the engine answers `pathing` with; null when it could not be
   * asked or its page is from before `pathing` (scm-sim 0.7.0).
   */
  pathing: number | null;
}

/* ── A map's pathing (`ScmSimService.pathing`) ── */

export interface PathingPoint { x: number; y: number }
/** A start location of the map: its player slot and where it is, in pixels. */
export interface PathingStart extends PathingPoint { owner: number }

/**
 * The game's regions for the map, a minitile (8 px) at a time. `grid` holds a region id for
 * every minitile, row by row, `width × height` of them (the map's size in tiles × 4). The
 * other arrays are a column per region, by id.
 */
export interface PathingRegions {
  width: number;
  height: number;
  grid: Uint16Array;
  count: number;
  /** 1 walkable, 0 not. */
  walkable: Uint8Array;
  /** Regions of one group are joined by ground; units cannot walk between two groups. */
  group: Uint16Array;
  /** The region's centre as the game keeps it, pixels. */
  x: Int32Array;
  y: Int32Array;
  /** Tiles in the region (a tile split between two regions counts for one of them). */
  tiles: Uint16Array;
  /** Neighbours of region r: `neighbours[neighbourAt[r]]` up to `neighbourAt[r + 1]`, walkable ones first. */
  neighbourAt: Uint32Array;
  neighbours: Uint16Array;
}

/**
 * `arrived`: it stopped within reach of where it was sent. `stopped`: it stopped short (the
 * game found no way all the way there, or gave up looking on a long route). `stuck`: it stood
 * still for ten seconds with its order still to move. `limit`: still walking when `limit` ran
 * out. `apart`: not walked, the two places being on ground that does not join. `unmoved`: the
 * order never took.
 */
export type PathingWalkOutcome = "arrived" | "stopped" | "stuck" | "limit" | "apart" | "unmoved";

export interface PathingWalk {
  /** units.dat id. */
  unit: number;
  from: PathingPoint;
  to: PathingPoint;
  /** The start locations (their player slots) walked between, when the walk was between two. */
  fromStart?: number;
  toStart?: number;
  outcome: PathingWalkOutcome;
  /** From the frame the unit took its order to the frame it stopped. 24 frames is a second at Fastest. */
  frames: number;
  /** Pixels walked, and how far from `to` it ended. */
  travelled: number;
  distance: number;
  /** Regions it stood in on the way. */
  regions: number;
  /** Where it was every `every` frames from the order on, ending where it stopped. */
  every: number;
  x: Int16Array;
  y: Int16Array;
}

export interface PathingResult {
  version: number;
  /** Tiles. */
  map: { width: number; height: number };
  starts: PathingStart[];
  /** Null when `regions: false` was asked. */
  regions: PathingRegions | null;
  walks: PathingWalk[];
}

/** `starting`: the engine and the first game; `walking`: `done` of `total` walks. */
export interface PathingProgress { stage: "starting" | "walking"; done: number; total: number }

export interface PathingOptions {
  /** units.dat ids of the ground units to walk; default Probe, Zergling, Dragoon, Siege Tank, Ultralisk. Air units and buildings are left out. */
  units?: number[];
  /** Walk both ways between two start locations (default: each pair once, from the lower slot). */
  directed?: boolean;
  /** Walk from this point to each of `to` in place of the start locations. */
  from?: PathingPoint;
  to?: PathingPoint[];
  /** Leave the regions out of the answer (default: in). */
  regions?: boolean;
  /** Frames a walk may take before it is given up (default 10,000). */
  limit?: number;
  /** Keep a walk's position every this many frames (default 8). */
  every?: number;
  signal?: AbortSignal;
  onProgress?: (progress: PathingProgress) => void;
}

export interface Disposable { dispose(): void }

/** What the view's page found when it loaded: where it reads the game from, or why it cannot play. */
export interface ViewReady {
  files: ScmSimStatus["files"];
  /** When `files` is null: why, in words for the person. */
  reason: string | null;
}

/** What the game is drawn with: what the person's copy of the game allows, and what is on. */
export interface ViewLooks {
  /** The copy has Remastered's pictures, and whether they are shown. */
  remastered: boolean;
  remasteredOn: boolean;
  /** The copy has the files for Remastered's real-time lighting (on a graphics card that can), and whether it is on. */
  lighting: boolean;
  lightingOn: boolean;
}

/** A replay the view has loaded. It stands paused at frame 0. */
export interface ViewedReplay {
  name: string;
  frames: number;
  players: { slot: number; name: string; race: number }[];
  /** In tiles. */
  map: { width: number; height: number };
  /** Whether a seek backwards is quick (the engine keeps moments of the game as it goes); otherwise it starts the game again. */
  rewinds: boolean;
  looks: ViewLooks;
  /** Whether the page plays a camera track (`ScmSimView.follow`); a page from before tracks ignores one. */
  follows: boolean;
}

/**
 * Where the camera looks at each moment of the game, for `ScmSimView.follow`: the middle of the view, in map pixels, at
 * every `every` frames. The page curves through the points by the frame it shows (a fraction of one too), and does not
 * bend across a cut.
 */
export interface ViewTrack {
  /** Frames between points: point `i` is at frame `i * every`. */
  every: number;
  x: Float32Array;
  y: Float32Array;
  /** 1 where the camera cuts to its point rather than moving to it from the point before. */
  cut: Uint8Array;
}

export interface ViewOptions {
  /** Fog of war through the eyes of `player` (off at first: a replay is watched seeing everything). */
  fog?: boolean;
  /** The game's sounds (on at first) and their volume, 0 to 1. */
  sound?: boolean;
  volume?: number;
  /**
   * The music of a race (0 zerg, 1 terran, 2 protoss), or none (null, as at first). Not remembered: the play page's own
   * Music box stays as it is. A page from before music ignores it.
   */
  music?: number | null;
  /** The sounds and the music turned down to this fraction (1 at first), eased there: under a voice of the plugin's own. */
  duck?: number;
  /** Remastered's pictures and its lighting, where the copy has them. The same choice as the play page's Options. */
  remastered?: boolean;
  lighting?: boolean;
  /** The game's console under the map (off at first: the editor has the controls, and the map gets the whole height). */
  console?: boolean;
}

/** The frame shown: at most ten times a second, and at once when playing or seeking changes. */
export interface ViewFrame {
  frame: number;
  playing: boolean;
  /** The frame a seek started from while it runs ahead, null otherwise. */
  seeking: number | null;
}

/** Where the view looks, after it moved: its middle and the map it shows, in pixels. */
export interface ViewCamera {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The person moved it (the minimap, the arrow keys), not `camera`. */
  byUser: boolean;
}

/**
 * What the game's minimap draws, for a minimap of your own: per square its middle and size in
 * map pixels (`boxes`, four numbers each) and its colour (`colours`, 0xRRGGBB) — the units seen
 * through the fog when it is on (all of them without it), and what is remembered under it,
 * dimmed; and the fog itself, to darken a minimap's ground the way the game's is. At most
 * eight times a second, when the frame, the fog or the eyes changed.
 */
export interface ViewUnits {
  frame: number;
  boxes: Float32Array;
  colours: Uint32Array;
  /**
   * Per tile, row by row, `wide` tiles a row: 0 never seen, 1 seen before (the game dims it), 2 seen
   * now. Null with the fog off, and from a game page before scm-sim 0.6.0.
   */
  fog: Uint8Array | null;
  wide: number;
}

/**
 * The unit under the pointer, as the game's console would show it — for a tooltip of your own, as
 * the view shows the game without its console. Only what the eyes the game is seen through can see.
 */
export interface ViewHoverUnit {
  /** The engine's slot for it: the same unit while it lives. */
  id: number;
  /** units.dat id. */
  type: number;
  /** The player it belongs to, 0–11. */
  owner: number;
  hp: number;
  hpMax: number;
  /** A unit that cannot be hurt (its hit points are not shown in the game). */
  invincible: boolean;
  /** -1 for a unit with no shields. */
  shields: number;
  shieldsMax: number;
  /** -1 for a unit that casts nothing. */
  energy: number;
  energyMax: number;
  /** False while it goes up, trains or is an egg. */
  completed: boolean;
  /** What it is busy with, and `workId` what: the unit type made or morphed into, a techdata.dat or upgrades.dat id. */
  work: "construction" | "train" | "research" | "upgrade" | "morph" | "addon" | "nuke" | null;
  workId: number;
  /** 0–100, how far that work (or its own building) has gone; -1 for none. */
  progress: number;
  /** The unit types in training, the first under way. */
  queue: number[];
  /** What is left in a mineral field, a geyser or a gas building; -1 for anything else. */
  resources: number;
}

/**
 * What the pointer is on over the view: a unit, and where the pointer is in the element's CSS
 * pixels; null once it is on nothing. At most thirty times a second, when it or the pointer moved.
 */
export interface ViewHover {
  unit: ViewHoverUnit;
  x: number;
  y: number;
}

/** A key pressed while the view had the keyboard that it does not use itself (all but the arrows, which scroll). */
export interface ViewKey {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * The game itself, drawn by the play page inside an element of yours (`ScmSimService.view`):
 * the replay played out with the game's own graphics, Remastered's where the person's copy
 * has them, and its console. You drive it; it says what it shows.
 */
export interface ScmSimView {
  /** Resolves once the page has looked for the game's files (never rejects: `files` is null and `reason` says why). */
  readonly ready: Promise<ViewReady>;
  /** Plays this replay (a whole .rep file) from the start, paused at frame 0. A load asked for before the last finished replaces it. */
  load(replay: Uint8Array, name?: string): Promise<ViewedReplay>;
  play(playing: boolean): void;
  /** 1 is Fastest, the game's own pace; 2, 4, 8, 16 faster. */
  speed(multiplier: number): void;
  /** Goes to `frame`, playing or paused as it was. */
  seek(frame: number): void;
  /**
   * Looks at this point of the map (pixels: the middle of the view). With `height`, shows that
   * much of the map top to bottom (pixels, 240 to 960; the game's own 480 at first), so the view
   * can match another's scale — without the console only.
   */
  camera(x: number, y: number, height?: number): void;
  /**
   * Moves the camera along `track` by the game's clock, in the page's own drawing (smooth however fast the game
   * plays, and in step with what it shows), until `camera`, another track or null, or the person moving the view
   * (said as a camera `byUser`). Only where the replay loaded says `follows`.
   */
  follow(track: ViewTrack | null): void;
  /** Whose eyes the fog is drawn through. */
  player(slot: number): void;
  options(options: ViewOptions): Promise<ViewLooks>;
  onFrame(listener: (frame: ViewFrame) => void): Disposable;
  onCamera(listener: (camera: ViewCamera) => void): Disposable;
  /** The squares for a minimap of your own, as the game's minimap draws them. */
  onUnits(listener: (units: ViewUnits) => void): Disposable;
  /** The unit under the pointer, for a tooltip; null once the pointer is on nothing (and when it leaves the view). From scm-sim 0.6.0. */
  onHover(listener: (hover: ViewHover | null) => void): Disposable;
  /**
   * A key the view handed back. It is also pressed again on the editor's window, so the
   * editor's hotkeys and every plugin's act on it as if it had been pressed there.
   */
  onKey(listener: (key: ViewKey) => void): Disposable;
  /** Takes the frame away and the engine with it. */
  dispose(): void;
}

export interface ScmSimService {
  /**
   * Whether this editor has the engine beside it at all: true at scmjs.dev and on a
   * stand-in for the site on one's own machine, false in the desktop app and an editor
   * hosted elsewhere. When false every other call rejects; offer what needs it only
   * when true.
   */
  readonly present: boolean;
  /** Asks the engine's page whether it can run a game now (it needs the person's copy of StarCraft). Asks again on every call. */
  status(): Promise<ScmSimStatus>;
  /**
   * Plays a replay to its end without showing it and resolves with what happened. A
   * twenty-minute game takes about ten to fifteen seconds; one replay runs at a time and
   * further calls wait their turn. Rejects with an `Error` worded for the person.
   */
  analyse(replay: Uint8Array, options?: AnalyseOptions): Promise<ReplayTimeline>;
  /**
   * Starts a map on the play page, in a tab of its own (one tab, used again by the next
   * call). `map` is a whole .scm / .scx file; left out, the open map as Save would write
   * it. Call it from the click that asks for it: a browser only lets a click open a tab.
   * It is played as the plugin's Preferences page says (the kind of game, the race, the
   * slot, melee computers). Resolves when the game is on the page, or, where the page says
   * to choose on the play page, when the map is on its setup screen.
   */
  play(map?: { bytes: Uint8Array; name: string }): Promise<void>;
  /**
   * The game drawn inside `element` (filling it), for watching a replay with its own
   * graphics: see `ScmSimView`. The engine is a gigabyte of memory, so keep one view and
   * load replays into it rather than one per replay. Added in 0.5.0: check that the
   * function is there before calling it.
   */
  view?(element: HTMLElement): ScmSimView;
  /**
   * The game's own pathing for a map: the regions the game builds when it loads it, and units
   * walked by the game between its start locations (or from one point to others), with how
   * long each walk took and the way it went. `scenario` is the bare scenario (`.chk` bytes);
   * left out, the open map. Nothing is shown and nobody plays. Each start location walked
   * from is a game of its own, a few seconds each: a 4-player map with the five default units
   * takes about eight seconds. One request runs at a time, replays included. Rejects with an
   * `Error` worded for the person. Added in 0.7.0, and needs a play page that answers it
   * (`status().pathing`): check both before offering it.
   */
  pathing?(scenario?: Uint8Array, options?: PathingOptions): Promise<PathingResult>;
}
