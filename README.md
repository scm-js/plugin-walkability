# Walkability

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It reads the ground the way a unit does and draws what it finds
over the map.

The editor shows terrain as pictures. The game moves units over the *minitiles* under
those pictures — sixteen per tile, each walkable or not, each at a ground height, some
of them ramps — and a map that looks fine can still have a cliff a unit walks straight
up, a natural whose only entrance is two tiles wide, a mineral line no worker can
reach, or two start locations with no ground between them. This plugin answers those
questions in one pass:

- **Islands** — regions of ground no path joins. Which start locations share one,
  which are cut off, and the pockets no start location can reach at all.
- **Areas and chokes** — the map divided the way BWEM divides it for bots: open areas,
  and the passages between them with their widths in tiles. The narrowest ones come
  first.
- **Between start locations** — for every pair, the straight-line distance, the ground
  distance a unit walks, and the width of the narrowest point on the widest route.
- **Height seams** — places where a unit can step between ground heights with no ramp,
  which is nearly always a tile placed wrong.
- **Problems** — a start location off walkable ground, a town hall spot the terrain
  refuses, resources no start location reaches, starts on different islands.

Buildings and resources count as walls (they block the game's pathing too), and you can
ask for the ground as a small, medium or large unit sees it, since a Siege Tank does not
fit where a Zergling does.

All of that is an estimate worked out from the minitiles. In the editor at scmjs.dev, the
panel can also have **the game itself** walk the map (see below): the regions the game
plans ground routes over, and real units walked between the start locations by the
game's own pathfinding, with what went wrong on the way.

## Install

In scmJS: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-walkability
```

and press **Add**. It is normally already in that list, marked *default* and switched off:
tick it to turn it on. To pin a version, add a ref: `github:scm-js/plugin-walkability@v1.0.0`.

## Use

**View ▸ Walkability** (also `Ctrl+Shift+W`, the eye in the Layers panel, or *Walkability
overlay* on the map's right-click menu) switches the overlay on: it reads the open map — a
128 × 128 map takes well under a tenth of a second — and draws the result over it. The
overlay is a view, not a tool: the map's own tools keep working underneath, so you can
place units and doodads with it showing, and it follows every edit. Move the pointer over
the map to read the cell under it (walkable or not, how far from the nearest wall, ground
height, ramp, island, area) in the panel.

**Tools ▸ Walkability…** opens the panel: what the overlay shows, its opacity, the unit
size, the readout of the cell under the pointer, and the problems found. **Pick an area on
the map** asks for one click and highlights the area (in the islands view, the island)
there; **Details…** opens a second panel with every start location, pair, island, area and
choke, and **Copy report** there puts a text summary on the clipboard.

| Overlay | What it shows |
| --- | --- |
| Areas and chokes | One colour per area, ramps brighter; a ring at every choke, as wide as the passage, with its width in tiles. |
| Islands and pockets | One colour per island that holds a start location; unreachable ground in orange, specks under two tiles in magenta. |
| Clearance | How much room there is: red against walls, through yellow and green to blue in the open. |
| Ground height and seams | Low, mid and high ground, ramps in white, seams in red. |
| Walkable ground | Green where a unit can stand, red where it cannot, yellow where the ground is walkable but too tight for the chosen unit size, grey under buildings. |

The rows in the details panel all go somewhere: click a start location, a pair, an
island, an area or a choke to scroll to it and highlight it.

Options:

- **Unit size** keeps a unit's own radius off every wall: *Ground as flagged* is the raw
  minitile data; *Small* (Marine, Zergling), *Medium* (Dragoon, Hydralisk) and *Large*
  (Siege Tank, Ultralisk) close the passages those units do not fit through. Widths are
  always the real passage widths, whatever size is chosen.
- **Min. area** folds an area smaller than this many tiles into its neighbour, so a
  doodad's shadow is not an area of its own.
- **Buildings and resources block the way** treats every building and mineral field or
  geyser as a wall, as the game does. Untick it to see the terrain alone.

## The game's own pathing

Since 1.3.0. Only in the editor at scmjs.dev: it needs the
[scm-sim](https://github.com/scm-js/plugin-scm-sim) plugin, version 0.7.0 or later (0.8.0 for the measures), and
the game engine served beside the editor. A copy of the game from StarEdit's download is
enough. Elsewhere, for example in the desktop app, the section does not appear.

**Walk the map**, in the panel's *The game's own pathing* section, starts the map in the
game, out of sight, and walks the ticked units (Probe, Zergling, Dragoon, Siege Tank and
Ultralisk to begin with) from each start location to every other one. Each start
location walked from is a game of its own and takes a few seconds: a 4-player map takes
about ten seconds, an 8-player map about forty. Nobody plays and the map is not changed.
The game is started on a copy that has a neutral Nexus on every start location and none of
the map's triggers.

The overlay then shows *The game's regions and walks*:

- **Regions**: one colour per region of the game's, darker at its edges. These are what
  the game plans ground routes over. Pointing at the map names the region and its ground
  group (ground of one group is joined).
- **Walks**: each unit's route in its own colour. A walk that went wrong ends in a red
  cross.

*What the game found* lists:

- A walk that **stops short**. The game can find no way all the way, or gives up
  looking on a long route. On Bridge to Bridge '98, every unit sent between two of the
  start locations stops about 150 tiles away.
- A walk that **gets stuck**, or is **still walking** after seven minutes.
- Two start locations the game finds **no ground between**, and whether Walkability's
  estimate disagrees.
- A route the game walks **much longer than the shortest ground route** (30 % and ten
  tiles more).
- A unit the game **could not place** near a start location (its spot was a cliff edge
  or too tight for it), so it walked nothing from there.

Click a row to go to it. *Both ways* walks each pair in both directions, since a route is
not always the same backwards. **Walk between two points** asks for two clicks and walks
the ticked units between them.

The details panel lists every walk with its time at Fastest. *Copy report* includes them.
An edit to the map marks the walks out of date; walk the map again to bring them up to date.

### Chokes and mining

Since 1.4.0, with scm-sim 0.8.0 or later, the same section can have the game measure two
more things. Both are repeatable: measuring the same map twice gives the same numbers.

**Chokes ▸ Measure** puts a group of twelve units (Dragoons to begin with; the list beside
the button chooses) through every choke the panel lists, those up to *Chokes up to* wide.
For each choke the group stands about eight tiles before it, in one of the two areas it
joins. One of them walks to about eight tiles past it alone, then all twelve walk there
together, and each is timed as it gets through the choke. A choke is judged by the time
for ten of the twelve against the one alone: that is the time the group spends queueing.
The few that go round or wait come through much later, and are counted as stragglers. On
Lost Civilization, twelve Dragoons queue 5 to 17 seconds at the 2.5-tile passages and 2 to
4 seconds at chokes 4 to 8 tiles wide. The list is sorted by queueing time, and the map
shows it beside each choke's width, in red past three seconds.

**Mining ▸ Measure** mines at every start location. Each gets a Nexus on its spot and
Probes sent to its mineral fields, nearest first, as players split them: first 8, then
16, then 24. After 25 seconds to settle, two game minutes are counted, and the result is
minerals per minute at each count. *Add a base…* asks for one click on the middle of where
a town hall would stand and measures that base too. The panel warns when one start
location mines noticeably less than another (five per cent or more at some worker count):
on Lost Civilization, Player 4's start mines 10 % less than Player 1's with 24 workers.
Gas is not measured, since the game cannot be made to build an Assimilator for the
purpose.

## Layout

| | |
| --- | --- |
| `plugin.json` | the manifest the editor reads (name, version, `entry`, `icon`, the API version it needs) |
| `plugin.ts` | `activate(api)`: building the grid from the open map, the overlay bitmaps, the overlay (`api.ui.overlay`) and the two panels |
| `game.ts` | the game's own pathing and measures: the walks matched against the estimate, the findings, a choke's two ends, a group's queueing and stragglers, the mining gap between starts (pure, tested) |
| `vendor/scm-sim.d.ts` | a copy of the scm-sim plugin's service types (`contract.d.ts` at v0.8.0) |
| `analysis.ts` | the pure part: the minitile grid, clearance (an exact Euclidean distance transform), islands, the watershed into areas and chokes, seams, the start-to-start routes, the text report |
| `i18n.ts`, `ko.ts` | the plugin's words in the editor's language: `t()` / `msg()` and the Korean catalogue |
| `dist/plugin.js` | the bundle the editor loads; `npm run build` writes it, CI commits it |
| `tests/` | vitest over `analysis.ts` and `game.ts`, and a check that `ko.ts` has every string the plugin shows |

Types come from [`@scm-js/plugin-api`](https://github.com/scm-js/plugin-api), a devDependency
generated from the editor's own `src/plugins/api.ts`; `npm update @scm-js/plugin-api` takes the
newest contract.

## How it works

Every tile's sixteen VF4 words come from `api.tileset.raw()`; walkable minitiles are
open cells, everything else is a wall, and the ground under every building and resource
is marked too. From there:

1. **Clearance**: the Euclidean distance from each open cell to the nearest wall or map
   edge, computed exactly with the Felzenszwalb–Huttenlocher transform.
2. **Islands**: 4-connected regions of the cells a unit of the chosen size can stand on.
3. **Areas and chokes**: a watershed over the clearance map. Cells are visited from the
   widest open ground downwards; each joins a neighbouring area or founds a new one, and
   where two areas first touch is the widest point of the narrowest passage between them
   — a choke — unless one of the areas is too small or the meeting point is nearly as
   wide as the area itself, in which case they were one area all along. This is the
   segmentation BWEM uses.
4. **Seams**: open cells whose neighbour is open at another ground height, neither being
   a ramp.
5. **Routes**: for each start location, the ground distance to every cell (Dial's
   algorithm, with corner cutting refused) and the widest route to every cell (a flood
   by descending bottleneck), from which each pair's ground distance, narrowest width
   and the place of that narrowest point follow.

The plugin only reads the map. It never writes to it.

## Development

```sh
npm install
npm run typecheck
npm test
```

`dist/plugin.js` is what the editor loads (`build` in the manifest): `npm run build` writes
it with esbuild, and CI commits it on every push to `main` and checks at a tag that it is
what the source builds to. Run `npm run dev` while you work so the bundle follows your
edits. To try local changes, serve this directory with CORS enabled (`npx serve --cors .`)
and add `http://localhost:3000/` in Manage Plugins, then use **Reload** after each edit.

A plugin runs with the editor's own privileges. There is no sandbox.

See [`docs/plugins.md`](https://github.com/scm-js/scm-js/blob/main/docs/plugins.md) in the editor
for the API tour; this plugin is the worked example for `api.ui.overlay` — a read-only
analysis drawn over the map, switched from the View menu, over `api.tileset.raw()`.

## Licence

MIT — see [LICENSE](LICENSE).
