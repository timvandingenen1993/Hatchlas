# Notices

## License

The source code of this project is licensed under the
[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later),
with the additional permission below.

### Additional permission under AGPL section 7: your exports are yours

Images, heightmaps, `.world2` project files and any other files that you
generate with this software are not covered by the AGPL. You may use, modify,
sell and redistribute them for any purpose, including commercial use, without
attribution and without having to publish any source code.

This includes the bundled artwork (SVG trees, shrubs, reeds, boulders and
similar props) as it appears in those exports. It does **not** allow you to
extract the artwork files from this repository and sell or redistribute them on
their own, or to redistribute the software itself outside the AGPL.

Running a modified version of this software as a network service is covered by
section 13 of the AGPL: you must offer your users the corresponding source code
of your modified version.

## Third-party data

### Elevation data (New Zealand)

`src/assets/nz-linz-dem.tif` and `src/assets/Heightmap2.png` are derived from
digital elevation models published by Land Information New Zealand (LINZ).

> Contains elevation data sourced from the LINZ Data Service, licensed for
> reuse under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The data has been cleaned, cropped and resampled for this project. LINZ does
not endorse this project.

## Third-party code and algorithms

- **Simplex noise** in `src/core/noise.ts` follows Stefan Gustavson's
  public-domain reference implementation.
- **Mulberry32** random number generator (public domain), by Tommy Ettinger.
- **Equal Earth projection** in `src/projections/equalEarth.ts` implements the
  published formulas from Šavrič, Patterson and Jenny (2019).
- The simulation methods are described in the papers listed in the
  [README](README.md#scientific-background). Only the published ideas are used;
  no code was copied from those works.

## Dependencies

Runtime dependencies and their licenses:

| Package | License |
| --- | --- |
| react, react-dom | MIT |
| tailwind-merge | MIT |
| clsx | MIT |
| lucide-react | ISC |
| canvas-confetti | ISC |

Build and test tooling (Vite, Vitest, TypeScript, Tailwind CSS, oxlint) is
not distributed with the app. All of the above are compatible with the AGPL.

## Inspiration

The hand-drawn look of the forest and mountain renderers is inspired by
published fantasy regional maps. No artwork from those maps is included, and
this project is not affiliated with or endorsed by any of their authors or
publishers.
