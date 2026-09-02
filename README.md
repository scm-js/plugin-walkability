# Walkability

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
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

## Install

In scmJS: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-walkability
```

and press **Add**. It is normally already in that list, marked *default* and switched off:
tick it to turn it on. To pin a version, add a ref: `github:scm-js/plugin-walkability@v1.0.0`.

## Use

**Tools ▸ Walkability…** (also `Ctrl+Shift+W`, or *Walkability…* on the map's right-click
menu) opens the panel and analyses the open map. A 128 × 128 map takes well under a tenth
of a second. The panel floats over the map and follows every edit while it is open.

The overlay is drawn by a map tool, so while it shows, the map's own tools are paused:
move the pointer over the map to read the cell under it (walkable or not, how far from
the nearest wall, ground height, ramp, island, area), click to pick the area or island
there. `Esc` or a right-click hides the overlay and hands the map back; **Show overlay**
brings it back.

| Overlay | What it shows |
| --- | --- |
| Areas and chokes | One colour per area, ramps brighter; a ring at every choke, as wide as the passage, with its width in tiles. |
| Islands and pockets | One colour per island that holds a start location; unreachable ground in orange, specks under two tiles in magenta. |
| Clearance | How much room there is: red against walls, through yellow and green to blue in the open. |
| Ground height and seams | Low, mid and high ground, ramps in white, seams in red. |
| Walkable ground | Green where a unit can stand, red where it cannot, yellow where the ground is walkable but too tight for the chosen unit size, grey under buildings. |

The lists below the overlay all go somewhere: click a start location, a pair, an island,
an area or a choke to scroll to it and highlight it. **Copy report** puts a text summary
on the clipboard.

Options:

- **Unit size** keeps a unit's own radius off every wall: *Ground as flagged* is the raw
  minitile data; *Small* (Marine, Zergling), *Medium* (Dragoon, Hydralisk) and *Large*
  (Siege Tank, Ultralisk) close the passages those units do not fit through. Widths are
  always the real passage widths, whatever size is chosen.
- **Min. area** folds an area smaller than this many tiles into its neighbour, so a
  doodad's shadow is not an area of its own.
- **Buildings and resources block the way** treats every building and mineral field or
  geyser as a wall, as the game does. Untick it to see the terrain alone.

## Layout

| | |
| --- | --- |
| `plugin.json` | the manifest the editor reads (name, version, `entry`, `icon`, the API version it needs) |
| `plugin.ts` | `activate(api)`: building the grid from the open map, the overlay bitmaps, the panel, the map tool |
| `analysis.ts` | the pure part: the minitile grid, clearance (an exact Euclidean distance transform), islands, the watershed into areas and chokes, seams, the start-to-start routes, the text report |
| `plugin-api/` | the editor's emitted type declarations, vendored so this repository type-checks alone |
| `tests/` | vitest over `analysis.ts` |

`plugin-api/` is generated in the editor's repository by `npm run build:plugin-types`; refresh it
from there when the plugin API moves.

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

The editor loads plugins straight from source, so there is no build step. To try local
changes, serve this directory with CORS enabled (`npx serve --cors .`) and add
`http://localhost:3000/` in Manage Plugins, then use **Reload** after each edit.

A plugin runs with the editor's own privileges. There is no sandbox.

See [`docs/plugins.md`](https://github.com/jeany55/scm-js/blob/main/docs/plugins.md) in the editor
for the API tour; this plugin is the worked example for a read-only analysis drawn with
`api.ui.mapTool`'s `draw` over `api.tileset.raw()`.

## Licence

MIT — see [LICENSE](LICENSE).
