# Forest prop performance baseline

Open `/forest-props?forestProfile=1` and keep the browser, viewport, device scale,
and hardware fixed between runs. The profiler uses the same collapsed console
groups and stage tables as the mountain render pipeline. It is disabled unless
`forestProfile=1` or `forestProfile=2` is present.

The first full forest report includes route-mount-to-commit time, worker request
and compute time, placement count, React render time, SVG node/path/filter/image
counts, encoded lighting bytes, heap size when Chrome exposes it, and long tasks.
Lighting has its own worker report with silhouette/noise field preparation,
field cache hits and misses, pixel rendering and PNG encoding, worker roundtrip,
and main-thread texture publication. Its compact reusable fields are bounded
to 128 MiB. The next animation frame after the first complete forest commit is
recorded as a paint proxy. Navigation prints p95 latency and frame interval
after each batch of twenty pan/zoom updates.

Lighting texture changes publish directly into the existing SVG images. The
forest SVG subtree is memoized independently from controls that only affect
lighting texture pixels, and tree shadow/inset passes share two conservative
filters. Compare SVG filter/node counts and React render time after a cold route
open and after twenty lighting updates.

For a comparable manual run:

1. Set the seed to `23817`; record the default density and maximum density as
   separate cases. Run each framing option at 1x, 4x, and 16x zoom.
2. Capture five cold route openings and twenty warm updates per case. For warm
   updates, record density, canopy merging, charcoal, wash, and lighting changes
   separately; run twenty pan and twenty zoom interactions for navigation.
3. Save the console tables and screenshots for sparse/dense stands and close
   zoom. Keep saved controls and the browser cache policy consistent between
   before/after captures.

These logs provide the measurement points; actual browser timings and screenshots
must be captured on the reference machine because this workspace has no browser
automation runtime.
