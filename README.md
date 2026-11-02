# Walkability

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It reads the ground the way a unit does and draws the result over the
map.

The editor shows terrain as pictures. Units move over the *minitiles* under those pictures:
sixteen per tile, each walkable or not, each at a ground height, some of them ramps. A map
that looks fine can still have a cliff a unit walks straight up, or a mineral line no worker
can reach. This plugin finds those in one pass:

- **Islands**: regions of ground that no path joins. Which start locations share one, which
  are cut off, and the pockets no start location can reach.
- **Areas and chokes**: the map divided into open areas, as the BWEM library does for bots,
  and the passages between them with their widths in tiles. The narrowest come first.
- **Between start locations**: for every pair, the straight-line distance, the walking
  distance, and the width of the narrowest point on the widest route.
- **Height seams**: places where a unit can step between ground heights with no ramp. This
  is nearly always a tile placed wrong.
- **Problems**: a start location off walkable ground, a town hall spot the terrain refuses,
  resources no start location reaches, start locations on different islands.

Buildings and resources count as walls, as they do in the game. You can also see the ground
as a small, medium or large unit sees it, since a Siege Tank does not fit where a Zergling
does.

All of this is an estimate worked out from the minitiles. In the editor at
[scmjs.dev/editor](https://scmjs.dev/editor/), the plugin can also have the game itself walk
the map (see [The game's own pathing](#the-games-own-pathing)).

The plugin only reads the map. It never changes it.

## Install

Walkability comes with scmJS. It is in the plugin list from the start, marked *default* and
turned on.

To add it by hand, open **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-walkability
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-walkability@v1.4.0`.

## Use

**View ▸ Walkability** turns the overlay on and off. So do `Ctrl+Shift+W`, the eye in the
Layers panel, and **Walkability overlay** on the map's right-click menu. A 128 × 128 map
takes well under a tenth of a second to read.

The overlay only draws. The editor's tools keep working underneath it, so you can place units
and doodads while it is showing, and it updates after every edit.

**Tools ▸ Walkability…** opens the panel. It has:

- the overlay to show, and its opacity
- the unit size and the other options below
- a readout of the cell under the pointer: walkable or not, distance to the nearest wall,
  ground height, ramp, island and area
- the problems found
- **Pick an area on the map**, which highlights the area (or island) you click
- **Details…**, which opens a second panel listing every start location, pair, island, area
  and choke. Click a row to go to it. **Copy report** there puts a text summary on the
  clipboard.

### Overlays

| Overlay | What it shows |
| --- | --- |
| Areas and chokes | One colour per area, ramps brighter. A ring at every choke, as wide as the passage, with its width in tiles. |
| Islands and pockets | One colour per island that holds a start location. Unreachable ground in orange, specks under two tiles in magenta. |
| Clearance (room to move) | Red against walls, through yellow and green, to blue in open ground. |
| Ground height and seams | Low, mid and high ground. Ramps in white, seams in red. |
| Walkable ground | Green where a unit can stand, red where it cannot, yellow where the ground is too tight for the chosen unit size, grey under buildings. |

### Options

- **Unit size** keeps a unit's radius clear of every wall. *Ground as flagged* is the raw
  minitile data. *Small* (Marine, Zergling), *Medium* (Dragoon, Hydralisk) and *Large*
  (Siege Tank, Ultralisk) close the passages those units do not fit through. Widths shown
  are always the real passage widths.
- **Min. area** merges an area smaller than this many tiles into its neighbour, so a doodad's
  shadow does not become an area of its own.
- **Buildings and resources block the way** treats every building, mineral field and geyser
  as a wall. Untick it to see the terrain alone.

## The game's own pathing

This part works only in the editor at [scmjs.dev/editor](https://scmjs.dev/editor/). It needs
the [scm-sim](https://github.com/scm-js/plugin-scm-sim) plugin (0.7.0 or later for walks,
0.8.0 or later for the measures), which comes with the editor. Elsewhere, for example in the
desktop app, the panel does not show this section.

### Walk the map

**Walk the map**, in the panel's *The game's own pathing* section, starts the map in the
game out of sight. It walks the ticked units (Probe, Zergling, Dragoon, Siege Tank and
Ultralisk at first) from each start location to every other one.

Each start location takes a few seconds: about ten seconds for a 4-player map and about
forty for an 8-player map. The game runs on a copy of the map with a neutral Nexus on every
start location and no triggers. Your map is not changed.

The overlay then shows *The game's regions and walks*:

- **Regions**: the areas the game plans ground routes over, one colour each. Point at the map
  to see a region's name and its ground group (ground in one group is connected).
- **Walks**: each unit's route in its own colour. A walk that went wrong ends in a red cross.

*What the game found* lists:

- a walk that stops short, because the game found no route or gave up on a long one (on
  Bridge to Bridge '98, every unit sent between two of the start locations stops about 150
  tiles away)
- a walk that gets stuck, or is still walking after seven minutes
- two start locations the game finds no ground between, and whether the estimate disagrees
- a route much longer than the shortest ground route (30 % and ten tiles longer)
- a unit the game could not place near a start location, so nothing was walked from there

Click a row to go to it. Tick *Both ways* to walk each pair in both directions, since a route
is not always the same backwards. **Walk between two points** asks for two clicks and walks
the ticked units between them.

The details panel lists every walk with its time at Fastest, and **Copy report** includes
them. Editing the map marks the walks out of date. Walk the map again to refresh them.

### Chokes and mining

These two measures need scm-sim 0.8.0 or later. Measuring the same map twice gives the same
numbers.

**Chokes ▸ Measure** times a group of twelve units through every listed choke up to the
*Chokes up to* width. The units are Dragoons unless you pick another type from the list
beside the button. For each choke, one unit walks through alone, then all twelve walk through
together. The result is how long the group spends queueing: the time for ten of the twelve
minus the time for the one alone. Units that take more than twice as long, or never get
through, are counted as stragglers.

On Lost Civilization, twelve Dragoons queue 5 to 17 seconds at the 2.5-tile passages and 2 to
4 seconds at chokes 4 to 8 tiles wide. The list is sorted by queueing time. The map shows the
time beside each choke's width, in red past three seconds.

**Mining ▸ Measure** mines at every start location with 8, 16 and then 24 Probes, nearest
mineral fields first. After 25 seconds to settle, it counts two game minutes and reports
minerals per minute. **Add a base…** asks you to click the middle of where a town hall would
stand, and measures that base too.

The panel warns when one start location mines 5 % or more less than another at any worker
count. On Lost Civilization, Player 4's start mines 10 % less than Player 1's with 24
workers. Gas is not measured, since the game cannot be made to build an Assimilator for the
test.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build      # dist/plugin.js
npm run dev        # rebuild on change
```

| File | What it holds |
| --- | --- |
| `plugin.ts` | The editor side: reading the map, the overlay and the two panels. |
| `analysis.ts` | The minitile grid and everything worked out from it. Pure, tested. |
| `game.ts` | The game's own pathing and measures, compared with the estimate. Pure, tested. |
| `vendor/scm-sim.d.ts` | A copy of the scm-sim plugin's service types (v0.8.0). |
| `i18n.ts`, `ko.ts` | Translation helpers and the Korean strings. |
| `dist/plugin.js` | The bundle the editor loads. CI commits it on every push to `main`. |

The analysis reads each tile's minitile flags through `api.tileset.raw()`. It works out:

1. clearance, the exact distance from each open cell to the nearest wall
2. islands, the connected regions a unit of the chosen size can stand on
3. areas and chokes, by a watershed over the clearance map (the method BWEM uses)
4. seams, open neighbours at different heights with no ramp
5. routes, the walking distance and widest route from each start location

To try local changes, serve this folder with CORS (`npx serve --cors .`), add
`http://localhost:3000/` in **Manage Plugins…**, and press **Reload** after each edit. A
plugin runs with the editor's own privileges. There is no sandbox.

Types come from [`@scm-js/plugin-api`](https://github.com/scm-js/plugin-api), a devDependency
generated from the editor's plugin contract. `npm update @scm-js/plugin-api` picks up the
newest version. This plugin is the worked example for `api.ui.overlay` in the
[plugin guide](https://docs.scmjs.dev/plugins/).

## Licence

MIT. See [LICENSE](LICENSE).
