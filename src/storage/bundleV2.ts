/**
 * Reads and writes the .world2 container: a JSON manifest plus raw typed-array payloads.
 */
import type { WorldV2 } from '../types/worldV2';
import { buildCubedSphereGrid, type CubedSphereGrid } from '../geometry/cubedSphere';

const MAGIC_HEADER = new Uint8Array([0x57, 0x4f, 0x52, 0x4c, 0x44, 0x56, 0x32, 0x00]); // "WORLDV2\0"

/**
 * Serialize a WorldV2 instance into a portable binary Uint8Array bundle
 */
export function serializeWorldV2(world: WorldV2): Uint8Array {
  const totalCells = world.topology.totalCells;
  const timelineSnapshots = world.timeline?.snapshots.map((snapshot) => {
    const {
      dominantPlateId: _dominantPlateId,
      boundaryClass: _boundaryClass,
      normalVelocityMmYr: _normalVelocityMmYr,
      shearVelocityMmYr: _shearVelocityMmYr,
      closureResidual: _closureResidual,
      dominanceConfidence: _dominanceConfidence,
      continentalFraction: _continentalFraction,
      continentalThicknessM: _continentalThicknessM,
      ...metadata
    } = snapshot;
    return {
      ...metadata,
      hasShearVelocity: Boolean(snapshot.shearVelocityMmYr),
      hasContinentalFraction: Boolean(snapshot.continentalFraction),
      hasContinentalThickness: Boolean(snapshot.continentalThicknessM),
    };
  });

  // Manifest containing non-array metadata, config, plates, and lakes
  const manifest = {
    version: 2,
    bundleSchema: 2,
    seed: world.seed,
    config: world.config,
    radiusMeters: world.radiusMeters,
    seaLevelMeters: world.seaLevelMeters,
    resolution: world.topology.resolution,
    totalCells,
    geologyPlates: world.geology.plates,
    lakes: world.hydrology.lakes,
    axialTiltDeg: world.climate.axialTiltDeg,
    diagnostics: world.diagnostics,
    phase2Arrays: {
      hasContinentalThickness: Boolean(world.geology.continentalThicknessM),
      hasPlateAreaFraction: Boolean(world.geology.plateAreaFraction),
      hasContinentalVolumeByPlate: Boolean(world.geology.continentalVolumeByPlateM3),
      hasOwnershipClosure: Boolean(world.geology.ownershipClosure),
      hasDominanceConfidence: Boolean(world.geology.dominanceConfidence),
    },
    timeline: world.timeline ? {
      durationMyr: world.timeline.durationMyr,
      snapshotIntervalMyr: world.timeline.snapshotIntervalMyr,
      plates: world.timeline.plates,
      snapshots: timelineSnapshots,
    } : undefined,
  };

  const manifestJson = JSON.stringify(manifest);
  const manifestBytes = new TextEncoder().encode(manifestJson);

  // Calculate total payload byte size for all typed arrays
  const arrayPayloads: ArrayBufferView[] = [
    world.topology.cellAreas,
    world.geology.plateIds,
    world.geology.crustType,
    world.geology.crustThickness,
    world.geology.crustAge,
    world.geology.boundaryType,
    world.geology.tectonicUpliftRate,
    world.terrain.elevation,
    world.terrain.bedrockElevation,
    world.terrain.sedimentThickness,
    world.terrain.slope,
    world.terrain.rockHardness,
    world.hydrology.flowReceivers,
    world.hydrology.discharge,
    world.hydrology.strahlerOrder,
    world.hydrology.drainageBasin,
    world.hydrology.isLakeMask,
    ...world.climate.monthlyTemperature,
    ...world.climate.monthlyPrecipitation,
    world.climate.meanAnnualTemperature,
    world.climate.annualPrecipitation,
    world.climate.annualEvaporation,
    world.climate.temperatureSeasonality,
    world.climate.iceThickness,
    world.climate.seaIceFraction,
    world.ecology.biomes,
  ];
  if (world.geology.continentalThicknessM) arrayPayloads.push(world.geology.continentalThicknessM);
  if (world.geology.plateAreaFraction) arrayPayloads.push(world.geology.plateAreaFraction);
  if (world.geology.continentalVolumeByPlateM3) arrayPayloads.push(world.geology.continentalVolumeByPlateM3);
  if (world.geology.ownershipClosure) arrayPayloads.push(world.geology.ownershipClosure);
  if (world.geology.dominanceConfidence) arrayPayloads.push(world.geology.dominanceConfidence);
  for (const snapshot of world.timeline?.snapshots ?? []) {
    arrayPayloads.push(
      snapshot.dominantPlateId,
      snapshot.boundaryClass,
      snapshot.normalVelocityMmYr,
      snapshot.closureResidual,
      snapshot.dominanceConfidence,
    );
    if (snapshot.shearVelocityMmYr) arrayPayloads.push(snapshot.shearVelocityMmYr);
    if (snapshot.continentalFraction) arrayPayloads.push(snapshot.continentalFraction);
    if (snapshot.continentalThicknessM) arrayPayloads.push(snapshot.continentalThicknessM);
  }

  let payloadByteSize = 0;
  for (const arr of arrayPayloads) {
    payloadByteSize += arr.byteLength;
  }

  // Total container size: Header (8) + Manifest Length (4) + Manifest Bytes + Payload
  const totalSize = 8 + 4 + manifestBytes.byteLength + payloadByteSize;
  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);

  // Write Magic Header
  buffer.set(MAGIC_HEADER, 0);
  // Write Manifest Byte Length
  view.setUint32(8, manifestBytes.byteLength, true);
  // Write Manifest Bytes
  buffer.set(manifestBytes, 12);

  // Write Array Payloads
  let offset = 12 + manifestBytes.byteLength;
  for (const arr of arrayPayloads) {
    const srcBytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    buffer.set(srcBytes, offset);
    offset += arr.byteLength;
  }

  return buffer;
}

/**
 * Deserialize a binary Uint8Array bundle or validate JSON imports
 * Explicitly rejects Version-1 save files with clear error messages.
 */
export function deserializeWorldV2(buffer: Uint8Array): { world: WorldV2; grid: CubedSphereGrid } {
  // Check if user uploaded a Version-1 JSON file by mistake
  if (buffer[0] === 0x7b) { // '{' character in ASCII
    try {
      const text = new TextDecoder().decode(buffer.slice(0, 1024));
      const parsed = JSON.parse(text);
      if (parsed.version !== 2) {
        throw new Error(
          'Incompatible Version-1 Save File: Legacy planar maps from version 1 are not compatible with the spherical WorldV2 simulation. Please generate a new spherical world.'
        );
      }
    } catch (e: any) {
      throw new Error(
        'Incompatible Version-1 Save File: ' + (e.message || 'Legacy planar file format rejected.')
      );
    }
  }

  // Check Magic Header
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== MAGIC_HEADER[i]) {
      throw new Error(
        'Invalid WorldV2 File Format: Missing or corrupted WORLDV2 binary header.'
      );
    }
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const manifestLen = view.getUint32(8, true);
  const manifestBytes = buffer.slice(12, 12 + manifestLen);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

  if (manifest.version !== 2) {
    throw new Error('Unsupported world version: ' + manifest.version);
  }

  const resolution = manifest.resolution;
  const totalCells = manifest.totalCells;

  // Build grid topology
  const grid = buildCubedSphereGrid(resolution, manifest.radiusMeters);

  let offset = 12 + manifestLen;
  function readArray<T extends ArrayBufferView>(
    ctor: new (buffer: ArrayBuffer, byteOffset: number, length: number) => T,
    length: number,
    bytesPerElement: number
  ): T {
    const byteLen = length * bytesPerElement;
    const sub = buffer.slice(offset, offset + byteLen);
    const arr = new ctor(sub.buffer, sub.byteOffset, length);
    offset += byteLen;
    return arr;
  }

  const cellAreas = readArray(Float32Array, totalCells, 4);
  const plateIds = readArray(Uint8Array, totalCells, 1);
  const crustType = readArray(Uint8Array, totalCells, 1);
  const crustThickness = readArray(Float32Array, totalCells, 4);
  const crustAge = readArray(Float32Array, totalCells, 4);
  const boundaryType = readArray(Uint8Array, totalCells, 1);
  const tectonicUpliftRate = readArray(Float32Array, totalCells, 4);
  const elevation = readArray(Float32Array, totalCells, 4);
  const bedrockElevation = readArray(Float32Array, totalCells, 4);
  const sedimentThickness = readArray(Float32Array, totalCells, 4);
  const slope = readArray(Float32Array, totalCells, 4);
  const rockHardness = readArray(Float32Array, totalCells, 4);
  const flowReceivers = readArray(Int32Array, totalCells, 4);
  const discharge = readArray(Float32Array, totalCells, 4);
  const strahlerOrder = readArray(Uint8Array, totalCells, 1);
  const drainageBasin = readArray(Int32Array, totalCells, 4);
  const isLakeMask = readArray(Uint8Array, totalCells, 1);

  const monthlyTemperature: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    monthlyTemperature.push(readArray(Float32Array, totalCells, 4));
  }

  const monthlyPrecipitation: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    monthlyPrecipitation.push(readArray(Float32Array, totalCells, 4));
  }

  const meanAnnualTemperature = readArray(Float32Array, totalCells, 4);
  const annualPrecipitation = readArray(Float32Array, totalCells, 4);
  const annualEvaporation = readArray(Float32Array, totalCells, 4);
  const temperatureSeasonality = readArray(Float32Array, totalCells, 4);
  const iceThickness = readArray(Float32Array, totalCells, 4);
  const seaIceFraction = readArray(Float32Array, totalCells, 4);
  const biomes = readArray(Uint8Array, totalCells, 1);

  let continentalThicknessM: Float32Array | undefined;
  let plateAreaFraction: Float64Array | undefined;
  let continentalVolumeByPlateM3: Float64Array | undefined;
  let ownershipClosure: Float32Array | undefined;
  let dominanceConfidence: Float32Array | undefined;
  let timeline: WorldV2['timeline'];
  if ((manifest.bundleSchema ?? 1) >= 2) {
    const flags = manifest.phase2Arrays ?? {};
    const plateValueCount = totalCells * manifest.geologyPlates.length;
    if (flags.hasContinentalThickness) continentalThicknessM = readArray(Float32Array, totalCells, 4);
    if (flags.hasPlateAreaFraction) plateAreaFraction = readArray(Float64Array, plateValueCount, 8);
    if (flags.hasContinentalVolumeByPlate) continentalVolumeByPlateM3 = readArray(Float64Array, plateValueCount, 8);
    if (flags.hasOwnershipClosure) ownershipClosure = readArray(Float32Array, totalCells, 4);
    if (flags.hasDominanceConfidence) dominanceConfidence = readArray(Float32Array, totalCells, 4);
    if (manifest.timeline) {
      const snapshots = manifest.timeline.snapshots.map((metadata: any) => {
        const {
          hasShearVelocity,
          hasContinentalFraction,
          hasContinentalThickness,
          ...snapshotMetadata
        } = metadata;
        return {
          ...snapshotMetadata,
          dominantPlateId: readArray(Uint8Array, totalCells, 1),
          boundaryClass: readArray(Uint8Array, totalCells, 1),
          normalVelocityMmYr: readArray(Float32Array, totalCells, 4),
          closureResidual: readArray(Float32Array, totalCells, 4),
          dominanceConfidence: readArray(Float32Array, totalCells, 4),
          shearVelocityMmYr: hasShearVelocity ? readArray(Float32Array, totalCells, 4) : undefined,
          continentalFraction: hasContinentalFraction ? readArray(Float32Array, totalCells, 4) : undefined,
          continentalThicknessM: hasContinentalThickness ? readArray(Float32Array, totalCells, 4) : undefined,
        };
      });
      timeline = {
        durationMyr: manifest.timeline.durationMyr,
        snapshotIntervalMyr: manifest.timeline.snapshotIntervalMyr,
        plates: manifest.timeline.plates,
        snapshots,
      };
    }
  }

  const world: WorldV2 = {
    version: 2,
    seed: manifest.seed,
    config: {
      ...manifest.config,
      // Version-2 bundles written before active-orogen time was separated
      // from crustal age remain readable without changing the binary layout.
      landscapeEvolutionMyr: manifest.config.landscapeEvolutionMyr ?? 25,
      tectonicEvolutionMyr: manifest.config.tectonicEvolutionMyr ?? 50,
    },
    radiusMeters: manifest.radiusMeters,
    seaLevelMeters: manifest.seaLevelMeters,
    topology: {
      resolution,
      totalCells,
      cellAreas,
      faceOffsets: grid.faceOffsets,
      neighbors: grid.neighbors,
    },
    geology: {
      plateCount: manifest.geologyPlates.length,
      plates: manifest.geologyPlates,
      plateIds,
      crustType,
      crustThickness,
      crustAge,
      boundaryType,
      tectonicUpliftRate,
      continentalThicknessM,
      plateAreaFraction,
      continentalVolumeByPlateM3,
      ownershipClosure,
      dominanceConfidence,
    },
    terrain: {
      elevation,
      bedrockElevation,
      sedimentThickness,
      slope,
      rockHardness,
    },
    hydrology: {
      flowReceivers,
      discharge,
      strahlerOrder,
      drainageBasin,
      lakes: manifest.lakes,
      isLakeMask,
    },
    climate: {
      axialTiltDeg: manifest.axialTiltDeg,
      monthlyTemperature,
      monthlyPrecipitation,
      meanAnnualTemperature,
      annualPrecipitation,
      annualEvaporation,
      temperatureSeasonality,
      iceThickness,
      seaIceFraction,
    },
    ecology: {
      biomes,
    },
    diagnostics: manifest.diagnostics,
    timeline,
  };

  return { world, grid };
}
