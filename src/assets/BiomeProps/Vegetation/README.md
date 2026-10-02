# Vegetation prop generation guide

These props are used on a large map, but the source artwork must remain clean
when the map is zoomed in. Review the supplied vector source at native size and
the reduced map result.

## Shared visual rules

- Use a compact cartographic symbol, not a botanical illustration.
- Keep the background genuinely transparent. Do not bake in a checkerboard,
  ground patch, water, shadow, label, or scenery.
- Use a small number of broad, readable color masses. No needles, bark, veins,
  noisy texture, or fine branch detail.
- Keep the source artwork high resolution and inspect it at native size before
  judging the reduced map result.

## Alpine tree rules

The supplied alpine forest reference is the source of truth. The active alpine
asset is `BiomeProps/Alpine/trees/alpineTree75.svg`. It is viewed from the
renderer's oblique 75 deg above-ground camera convention, not as a front-facing
Christmas-tree drawing.

- Keep the supplied path as the source of truth: one broad, irregular closed
  silhouette plus simple internal marks.
- Use the enclosed region for the muted alpine-green fill. The SVG has no baked
  outline; the renderer adds one charcoal contour per prop after the canopy is
  composited. Draw order is depth-sorted from each prop's visual bottom so a
  foreground canopy can cover a background contour cleanly.
- Per-placement variation is deterministic: low-frequency seeded displacement,
  slight scale variation, and a restrained lean. Rotation stays at zero so the
  oblique source orientation remains consistent.
- No trunk, roots, branch network, individual needles, cast shadow, or terrain
  island.

## Placement and envelope contract

- Every active alpine SVG uses a canonical `512x512` source viewBox. The path's
  occupied area inside that square controls its relative authored scale.
- Alpine placement uses a compact one-cell ground reservation for biome, water,
  boundary, and habitat validation; it no longer reserves a fixed 5x5 grid.
- The rendered canopy has its own visual envelope and bottom-center ground
  anchor. Visual canopy overlap is allowed inside a forest stand.
- `outlineMode: "alpha-dilation"` and `outlineGroup: "alpine-forest"` cause
  one charcoal ring to be generated for each prop; the group name selects the
  treatment family but does not create a global forest silhouette.
- The old broadleaf `tree-prop-01` is preserved on disk as legacy artwork but is
  not an active alpine forest candidate.

## Output contract

- Keep the high-resolution SVG source in the matching prop directory.
- Inspect the source at native size, with the test route's source zoom, and at
  reduced map scale. A tree must read as a simple, low-detail map mark at the
  reduced scale while retaining clean edges when enlarged.

## Alpine source direction

> Use the supplied alpine tree path exactly. Fill its enclosed silhouette with
> a muted alpine green on a transparent background. Keep every path available
> to the charcoal renderer; do not bake an outline into the source. The active
> tree is a simple oblique 75-degree cartographic prop, not a front-facing
> Christmas tree. Forest variation is applied deterministically by the renderer
> with broad seeded displacement, no random rotation, no trunk, no scenery, and
> no fine botanical detail.
