# Single-mountain visual review

Historical visual references are retained below. The standalone single-mountain
and regional gallery generators were removed during test cleanup. Review new
appearance changes in the application; use focused regression tests for behavior.

## Current renderer reference

We are explicitly using `tests\artifacts\mountain-structure-aware-streamlines\`
as the active mountain review/reference artifact. The perspective studio/study
is not used for the current renderer.

The linework method follows Kratt et al., *Structure-aware Stylization of
Mountainous Terrains* (VMV 2017):
<https://graphics.uni-konstanz.de/publikationen/Kratt2017AbstractTerrain/>.
In particular, the renderer keeps the paper's crest-oriented feature
importance, multi-scale terrain filtering, structure-aware streamlines, and
separate crest/silhouette lines with hatching.

## Explicit face geometry study

Open `artifacts/mountain-face-structure/index.html` for a separate, bare-rock
prototype using the same Heightmap2 crop. `planes.png` uses two flat values
without ink; `structure.png` adds the shared crest/rib edges; `lighting.png`
uses continuous lighting from triangle normals. `structure-2x.png` rasterizes
the identical geometry at twice the resolution. `geometry.json` records every
shared vertex and panel, and `settings.json` records the illustrative crown
deformation as well as the camera settings.

The mesh deliberately narrows the crown and compresses the crest's overhead
depth. These are illustrative deformations, not modifications to the DEM.
Its feet remain terrain anchored. This is one dominant camera-facing ridge,
not range partitioning, back faces, snow, hatching, or production integration.
The regular panel rhythm still needs art-direction review against Combined.png.

```powershell
$env:MOUNTAIN_FACE_REVIEW_DIR = 'tests/artifacts/mountain-face-structure'
npx vitest run --config vitest.config.ts tests/mountainFaceGeometry.test.ts
Remove-Item Env:MOUNTAIN_FACE_REVIEW_DIR
```

Six focused checks, including the real-heightmap artifact check, pass. They
cover shared topology, flat-terrain rejection, water protection, dry-face
coverage, deterministic construction, fixed feet, and reuse at two output
sizes. Focused lint passes. The full typecheck remains blocked by four errors
in the existing vegetation tests; no new type errors were reported. A full
build or regression suite is unnecessary for this isolated prototype.

## Mountain linework correction

The `artifacts/mountain-linework-single/index.html` review retains the warm
palette and 78-degree projection while separating visible depth silhouettes
from interior ridge strokes. It includes `depth-silhouettes.png`,
`interior-ridges.png`, and `face-strokes.png` to inspect each ink source.
The preceding `mountain-projection-single` images are retained for comparison.

Interior ridge strokes use globally indexed short runs to preserve their dash
phase across export tiles. Downhill strokes have restored density and length;
face shading retains more local terrain variation. Snow and footprint styling
still need separate visual work to match the reference.

Existing images remain in `tests/artifacts/single-mountain/`.

- Source: `src/assets/Heightmap2.png`, 4096 × 4096, 16-bit grayscale.
- Framing: a square around elevations above 22% of the source range, with 24% additional space. Exact crop coordinates are recorded in `settings.json`.
- Elevation: 800–4800 m over an 8 km domain; base temperature 18°C.
- Analysis: 1024 × 1024. Final export: 2048 × 2048, sampling the cropped original heightmap.
- Lighting: azimuth 315°, altitude 45°. Seed: 23817.

Review files:

- `mountain.png`: full production rendering at 2048 px.
- `preview.png`: the 1024 px preview.
- `isolated.png`: mountain layer on neutral paper, excluding surrounding vegetation.
- `materials.png`: mountain materials without ink, on neutral paper.
- `ink.png`: mountain silhouette and charcoal layers on white.
- `heightmap.png`: normalized, framed source.
- `settings.json`: exact source, framing, analysis, and rendering parameters.

Cache, snow, and tile-seam behavior remain covered by the focused renderer and
export tests. Passing those tests does not imply visual acceptance.

These are test-fixture settings; they do not change the application's height or climate defaults.

## Export fidelity review

`artifacts/default-mountain-export-review/index.html` compares native 8K export
crops of the default `src/assets/nz-linz-dem.tif` at 0–5650 m and the default 45 km
domain width. Exact analysis dimensions and crop coordinates are in its
`settings.json`. Drawing controls use defaults; this is not a capture of saved
browser settings. The original single-mountain reference remains unchanged;
`artifacts/single-mountain-export-review` contains the regenerated comparison.

Export now builds the mountain pattern once from the global analysis DEM and
maps its complete ridge/charcoal paths, snow, and smoothed surface into each
tile. This prevents higher-resolution ridge detection and tile-local crest
selection from changing the preview's drawing. The export still rasterizes
ink and material shading at its requested resolution.

Focused regression: `npx vitest run --config vitest.config.ts tests/mountainExportGeometry.test.ts`.
This checks 4x geometry preservation and exact rendered agreement across an
interior tile cut whose support excludes the outer map boundaries.

## Regional style review

`artifacts/mountain-scale-correction/index.html` is the current preview/export
review. The preceding `mountain-range-style-review` exposed a regression:
reducing the shared scale changed mesh sampling and cliff detection and
multiplied hatching density. That terrain scaling has been removed. Only
side-stroke length now varies with ground spacing; terrain sampling, snow,
ridge geometry, and seed density stay unchanged. Occluded crests stop at the
foreground face, and snow concentrates in sheltered gullies or flat areas.

Focused style regressions live in `mountainExportGeometry.test.ts` and
`mountainIllustrationCurvature.test.ts`; snowfield coverage also remains covered
by `mountainPatternRenderer.test.ts`. Full builds and full regression runs are
omitted for this renderer-only change.

Inspect both `preview-detail.png` and the native export `after.png`: the former
revealed the black cliff patches that were absent from the larger export crop.
