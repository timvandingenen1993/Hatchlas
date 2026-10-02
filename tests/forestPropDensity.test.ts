import { describe, expect, it } from "vitest";
import {
  buildForestPropStandGeometry,
  DEFAULT_FOREST_PROP_INK_REMOVAL_DEPTH,
  findForestPropOverlapFlags,
  forestPropInkReductionStartDepth,
  forestPropInkRetentionAtDepth,
  padForestPropBounds,
  thinForestInkRuns,
  type ForestPropCrown,
} from "../src/rendering/forestPropDensity";

function square(
  centerX: number,
  centerY: number,
  placementIndex: number,
  size = 40,
): ForestPropCrown {
  const half = size * 0.5;
  return {
    placementIndex,
    points: [
      { x: centerX - half, y: centerY - half },
      { x: centerX + half, y: centerY - half },
      { x: centerX + half, y: centerY + half },
      { x: centerX - half, y: centerY + half },
    ],
  };
}

function cluster(
  centerX: number,
  centerY: number,
  columns = 5,
  rows = 5,
  firstPlacementIndex = 0,
  spacing = 27,
): ForestPropCrown[] {
  return Array.from({ length: columns * rows }, (_, index) =>
    square(
      centerX + (index % columns) * spacing,
      centerY + Math.floor(index / columns) * spacing,
      firstPlacementIndex + index,
    ),
  );
}

function seededCluster(seed: number): ForestPropCrown[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return cluster(80, 80, 7, 7).map((crown) => {
    const offsetX = (random() - 0.5) * 8;
    const offsetY = (random() - 0.5) * 8;
    return {
      ...crown,
      points: crown.points.map((point) => ({
        x: point.x + offsetX,
        y: point.y + offsetY,
      })),
    };
  });
}

describe("buildForestPropStandGeometry", () => {
  it("keeps edge ink and removes most linework toward the canopy center", () => {
    expect(forestPropInkRetentionAtDepth(0)).toBe(1);
    expect(forestPropInkRetentionAtDepth(0.18)).toBeLessThan(0.6);
    expect(forestPropInkRetentionAtDepth(0.18)).toBeGreaterThan(0.5);
    expect(forestPropInkRetentionAtDepth(0.32)).toBeLessThan(0.09);
    expect(forestPropInkRetentionAtDepth(0.36)).toBe(0);
    expect(forestPropInkRetentionAtDepth(0.32)).toBeLessThan(
      forestPropInkRetentionAtDepth(0.3),
    );
  });

  it("moves the center cutoff and debug transition with its configured threshold", () => {
    expect(DEFAULT_FOREST_PROP_INK_REMOVAL_DEPTH).toBe(0.36);
    expect(forestPropInkReductionStartDepth(0.5)).toBeCloseTo(0.05);
    expect(forestPropInkRetentionAtDepth(0.36, 0.5)).toBeGreaterThan(0);
    expect(forestPropInkRetentionAtDepth(0.5, 0.5)).toBe(0);
    expect(forestPropInkRetentionAtDepth(0.2, 0.2)).toBe(0);
  });

  it("progressively removes whole ink segments without shortening surviving marks", () => {
    const runs = Array.from({ length: 100 }, (_, index) => ({ start: index * 3, end: index * 3 + 2 }));
    const sample = (retention: number) => thinForestInkRuns(runs, retention, 23817);
    const outer = sample(0.8);
    const inner = sample(0.3);
    const inkLength = (segments: typeof runs) =>
      segments.reduce((sum, run) => sum + run.end - run.start, 0);
    expect(sample(1)).toEqual(runs);
    expect(sample(0)).toEqual([]);
    expect(inner).toEqual(sample(0.3));
    expect(inner.length).toBeGreaterThan(1);
    expect(inkLength(inner)).toBeGreaterThan(0);
    expect(inkLength(inner)).toBeLessThan(inkLength(outer));
    expect(inkLength(outer)).toBeLessThan(200);
    for (const segment of [...outer, ...inner]) {
      expect(runs).toContainEqual(segment);
    }
    for (const segment of inner) {
      expect(outer.some((run) => run.start <= segment.start && run.end >= segment.end)).toBe(true);
    }
  });

  it("keeps thinning inside the original ink runs", () => {
    const runs = [{ start: 0.3, end: 11.7 }, { start: 15.2, end: 28.1 }];
    for (const segment of thinForestInkRuns(runs, 0.7, 7)) {
      expect(runs.some((run) => run.start <= segment.start && run.end >= segment.end)).toBe(true);
    }
  });

  it("leaves sparse props separate and requires at least five trees", () => {
    const twoTrees = [square(60, 60, 0), square(82, 60, 1)];
    const fourTrees = cluster(40, 40, 2, 2);

    expect(buildForestPropStandGeometry(twoTrees, 180, 140).canopyPath).toBe("");
    expect(buildForestPropStandGeometry(fourTrees, 180, 140).canopyPath).toBe("");
  });

  it("creates a fill and interruption weights for an eligible five-tree stand", () => {
    const fiveTrees = Array.from({ length: 5 }, (_, index) =>
      square(40 + index * 27, 60, index),
    );
    const geometry = buildForestPropStandGeometry(fiveTrees, 220, 140);

    expect(geometry.canopyPath).toContain("Q");
    expect(geometry.canopyRegions).toHaveLength(1);
    expect(Math.max(...geometry.interiorWeights)).toBeGreaterThan(0);
  });

  it("keeps the canopy boundary close to the outside crowns", () => {
    const crowns = cluster(50, 50, 5, 5);
    const geometry = buildForestPropStandGeometry(crowns, 300, 280, 65, 23817);
    const crownPoints = crowns.flatMap((crown) => crown.points);
    const crownLeft = Math.min(...crownPoints.map((point) => point.x));
    const crownRight = Math.max(...crownPoints.map((point) => point.x));
    const region = geometry.canopyRegions[0];
    const canopyLeft = region.centerX - region.width * 0.5;
    const canopyRight = region.centerX + region.width * 0.5;

    expect(canopyLeft).toBeGreaterThan(crownLeft - 8);
    expect(canopyLeft).toBeLessThan(crownLeft + 3);
    expect(canopyRight).toBeLessThan(crownRight + 8);
    expect(canopyRight).toBeGreaterThan(crownRight - 3);
  });

  it("adds small deterministic edge noise in simulation coordinates", () => {
    const crowns = cluster(60, 60, 5, 5);
    const first = buildForestPropStandGeometry(crowns, 320, 300, 65, 23817);

    expect(buildForestPropStandGeometry(crowns, 320, 300, 65, 23817)).toEqual(first);
    expect(buildForestPropStandGeometry(crowns, 320, 300, 65, 23818).canopyPath).not.toBe(
      first.canopyPath,
    );
  });

  it("changes canopy edge noise wavelength without changing stand placement geometry", () => {
    const crowns = cluster(60, 60, 5, 5);
    const ordinary = buildForestPropStandGeometry(crowns, 320, 300, 65, 23817);
    const broadNoise = buildForestPropStandGeometry(crowns, 320, 300, 65, 23817, -2, -2, 2);

    expect(broadNoise.canopyPath).not.toBe(ordinary.canopyPath);
    expect(broadNoise.regionIds).toEqual(ordinary.regionIds);
    expect(broadNoise.interiorWeights).toEqual(ordinary.interiorWeights);
  });

  it("increases interruption weight toward the middle of a dense stand", () => {
    const crowns = cluster(60, 60, 7, 7);
    const geometry = buildForestPropStandGeometry(crowns, 400, 400);
    const weights = geometry.interiorWeights;
    const edgeWeight = weights[0];
    const centerWeight = weights[24];

    expect(geometry.canopyPath).toContain("Z");
    expect(geometry.canopyPath.match(/M/g)).toHaveLength(1);
    expect(centerWeight).toBeGreaterThan(edgeWeight);
    expect(centerWeight).toBeGreaterThan(0.25);
    expect(weights.every((weight) => weight >= 0 && weight <= 1)).toBe(true);
  });

  it("weights two dense stands independently and leaves the gap unchanged", () => {
    const firstStand = cluster(40, 40, 3, 2, 0);
    const secondStand = cluster(390, 40, 3, 2, firstStand.length);
    const isolatedProp = square(250, 210, firstStand.length + secondStand.length);
    const geometry = buildForestPropStandGeometry(
      [...firstStand, ...secondStand, isolatedProp],
      520,
      280,
    );
    const weights = geometry.interiorWeights;

    expect(geometry.canopyPath.match(/M/g)).toHaveLength(2);
    expect(geometry.canopyRegions).toHaveLength(2);
    expect(Math.max(...weights.slice(0, firstStand.length))).toBeGreaterThan(0);
    expect(Math.max(...weights.slice(firstStand.length, firstStand.length * 2))).toBeGreaterThan(0);
    expect(weights[weights.length - 1]).toBe(0);
  });

  it("does not extend interruption weighting across a clearing", () => {
    const ring = Array.from({ length: 16 }, (_, index) => {
      const angle = (index / 16) * Math.PI * 2;
      return square(
        180 + Math.cos(angle) * 96,
        180 + Math.sin(angle) * 96,
        index,
      );
    });
    const isolatedCenterTree = square(180, 180, ring.length);
    const geometry = buildForestPropStandGeometry(
      [...ring, isolatedCenterTree],
      360,
      360,
    );

    expect(geometry.canopyPath.match(/M/g)?.length).toBeGreaterThanOrEqual(2);
    const weights = geometry.interiorWeights;
    expect(weights[ring.length]).toBe(0);
    expect(Math.max(...weights.slice(0, ring.length))).toBeLessThan(0.4);
  });

  it("is deterministic for a seeded layout and changes with the seed", () => {
    const firstSeed = seededCluster(23817);
    const secondSeed = seededCluster(7351);
    const firstGeometry = buildForestPropStandGeometry(firstSeed, 400, 400);

    expect(buildForestPropStandGeometry(firstSeed, 400, 400)).toEqual(firstGeometry);
    expect(buildForestPropStandGeometry(secondSeed, 400, 400)).not.toEqual(firstGeometry);
  });

  it("keeps weights aligned with placement indices when some props lack a crown", () => {
    const crowns = cluster(50, 50, 3, 2).filter((crown) => crown.placementIndex !== 2);
    const weights = buildForestPropStandGeometry(crowns, 200, 160).interiorWeights;

    expect(weights).toHaveLength(6);
    expect(weights[2]).toBe(0);
  });

  it("disables canopy fills and interior interruptions at zero merging", () => {
    const geometry = buildForestPropStandGeometry(cluster(50, 50), 220, 220, 0);

    expect(geometry.canopyPath).toBe("");
    expect(geometry.canopyRegions).toHaveLength(0);
    expect(geometry.interiorWeights.every((weight) => weight === 0)).toBe(true);
  });
});

describe("findForestPropOverlapFlags", () => {
  it("matches exhaustive overlap checks for deterministic mixed bounds", () => {
    let state = 0x51a7;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let sample = 0; sample < 20; sample++) {
      const bounds = Array.from({ length: 160 }, (_, index) => {
        if (index % 19 === 0) return null;
        const minX = random() * 900 - 450;
        const minY = random() * 700 - 350;
        const width = 8 + random() * 100;
        const height = 8 + random() * 100;
        return { minX, minY, maxX: minX + width, maxY: minY + height };
      });
      const expected = bounds.map((bound, index) => Boolean(
        bound && bounds.some((other, otherIndex) =>
          otherIndex !== index && other !== null &&
          bound.minX < other.maxX && bound.maxX > other.minX &&
          bound.minY < other.maxY && bound.maxY > other.minY,
        ),
      ));

      expect(findForestPropOverlapFlags(bounds)).toEqual(expected);
    }
  });

  it("keeps stand geometry aligned to global coordinates for padded render tiles", () => {
    const sourceCrowns = cluster(60, 60, 5, 5, 0, 27);
    const source = buildForestPropStandGeometry(sourceCrowns, 250, 250, 65, 23817, -2, -2);
    const offsetX = 340;
    const offsetY = 220;
    const shiftedCrowns = sourceCrowns.map((crown) => ({
      ...crown,
      points: crown.points.map((point) => ({ x: point.x + offsetX, y: point.y + offsetY })),
    }));
    const shifted = buildForestPropStandGeometry(
      shiftedCrowns,
      250,
      250,
      65,
      23817,
      offsetX - 2,
      offsetY - 2,
    );

    expect(shifted.interiorWeights).toEqual(source.interiorWeights);
    expect(shifted.canopyRegions).toHaveLength(source.canopyRegions.length);
    expect(shifted.canopyRegions[0].centerX - source.canopyRegions[0].centerX).toBeCloseTo(offsetX);
    expect(shifted.canopyRegions[0].centerY - source.canopyRegions[0].centerY).toBeCloseTo(offsetY);
  });
});

describe("forest prop filter bounds", () => {
  it("keeps transformed tree bounds inside the maximum blur and shadow extents", () => {
    const treeBounds = { minX: 18, minY: 42, maxX: 74, maxY: 123 };
    const maximumInsetPadding = 3 * 8 + 8 * 0.6 + 2;
    const padded = padForestPropBounds(treeBounds, maximumInsetPadding);

    expect(padded.minX).toBeLessThanOrEqual(treeBounds.minX - maximumInsetPadding);
    expect(padded.minY).toBeLessThanOrEqual(treeBounds.minY - maximumInsetPadding);
    expect(padded.maxX).toBeGreaterThanOrEqual(treeBounds.maxX + maximumInsetPadding);
    expect(padded.maxY).toBeGreaterThanOrEqual(treeBounds.maxY + maximumInsetPadding);
  });
});
