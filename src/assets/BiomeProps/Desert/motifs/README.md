# Desert flow-line motifs

Sand Desert & Dunes (15) is normally drawn by the procedural dune renderer
(`src/rendering/desertDunes.ts`, the "Desert dunes" inspector section), not by
these motifs. They apply to Rocky Desert & Hamada (16), and to sand desert
only when "Desert dunes" is switched off.

Every `.svg` in this folder is registered automatically as an `arid` motif,
named `arid-<file name>`. While the folder holds no SVGs, those biomes use the
plain `line` and `dots` marks instead.

Author them like `src/assets/vegetation/line01.svg`:

- Small landscape viewBox, around `64x40`. The renderer stretches the mark
  along the flow direction, so draw it lying horizontally.
- Charcoal strokes only (`stroke="#000"`, `fill="none"`, round caps and
  joins). No fills, backgrounds, shadows or text. Use `<path>` elements only;
  other shapes are not parsed.
- Keep it sparse: ripples, pebbles and dry tufts, not bushes. Grass and
  shrub biomes already use the bushier marks.

## Sand-ripple sweeps (removed)

Long tapered "sweep" marks were tried here as dunes and removed: sand desert
is now the procedural dune renderer, and in rocky desert the sweeps read as
stray dune strokes next to it. Keep marks for this folder small and sparse:
pebbles, gravel and dry tufts.

## Lee side

A mark may be asymmetric, with detail such as a thin companion line on one
side. Draw that side **below** the main line (larger SVG `y`). The
renderer mirrors each placed mark so that this side always faces away from the
sun. Symmetric marks are unaffected.
