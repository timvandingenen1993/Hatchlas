import { getMountainFieldFingerprint } from './mountainPatternRenderer';

/**
 * The raster fields that sit between mountain geometry and illustration
 * painting. Keeping this small interface separate lets the WebGPU path
 * prepare the same inputs without changing the synchronous renderer
 * contract.
 */
export interface MountainIllustrationPreparedFields {
  width: number;
  height: number;
  lightingElevation: Float32Array;
  reliefReference: Float32Array;
  ribField: Float32Array;
  creaseField: Float32Array;
  footprint: Float32Array;
  lineworkFootprint: Float32Array;
  snowRidgeField: Float32Array;
}

export interface MountainIllustrationFieldRadii {
  lighting: number;
  relief: number;
  rib: number;
  crease: number;
  footprint: number;
  lineworkFootprint: number;
  snowRidge: number;
}

/** Shared source bundle consumed by both CPU and GPU preparation. */
export interface MountainIllustrationFieldInputs {
  width: number;
  height: number;
  cellSizeX: number;
  cellSizeY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  faceField: Float32Array;
  reliefElevation: Float32Array;
  ridgeInk: ArrayLike<number>;
  ink: ArrayLike<number>;
  coverage: ArrayLike<number>;
  lineworkCoverage: ArrayLike<number>;
  radii: MountainIllustrationFieldRadii;
}

/** A prepared set plus the exact source dependency signature that produced it. */
export interface MountainIllustrationPreparedFieldSet {
  fields: MountainIllustrationPreparedFields;
  dependencySignature: string;
  retainedBytes: number;
}

export function getMountainIllustrationFieldDependencySignature(
  inputs: MountainIllustrationFieldInputs,
): string {
  const sourceFingerprints = [
    inputs.faceField,
    inputs.reliefElevation,
    inputs.ridgeInk,
    inputs.ink,
    inputs.coverage,
    inputs.lineworkCoverage,
  ].map(source => getMountainFieldFingerprint(source));
  return JSON.stringify([
    inputs.width,
    inputs.height,
    inputs.cellSizeX,
    inputs.cellSizeY,
    inputs.scale,
    inputs.offsetX,
    inputs.offsetY,
    inputs.radii,
    sourceFingerprints,
  ]);
}

export function getMountainIllustrationPreparedFieldsByteLength(
  fields: MountainIllustrationPreparedFields,
): number {
  return fields.lightingElevation.byteLength
    + fields.reliefReference.byteLength
    + fields.ribField.byteLength
    + fields.creaseField.byteLength
    + fields.footprint.byteLength
    + fields.lineworkFootprint.byteLength
    + fields.snowRidgeField.byteLength;
}

export function isMountainIllustrationPreparedFieldsCompatible(
  fields: MountainIllustrationPreparedFields | undefined,
  width: number,
  height: number,
): fields is MountainIllustrationPreparedFields {
  if (!fields || fields.width !== width || fields.height !== height) return false;
  const length = width * height;
  return fields.lightingElevation.length === length
    && fields.reliefReference.length === length
    && fields.ribField.length === length
    && fields.creaseField.length === length
    && fields.footprint.length === length
    && fields.lineworkFootprint.length === length
    && fields.snowRidgeField.length === length;
}
