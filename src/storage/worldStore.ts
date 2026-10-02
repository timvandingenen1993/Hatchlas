import type { WorldV2 } from '../types/worldV2';
import type { CubedSphereGrid } from '../geometry/cubedSphere';
import type { TectonicSimulationTimeline, TectonicTimeSnapshot } from '../tectonics/plateEngine/types';

/**
 * WorldStore: Stores heavy 3D planetary mesh TypedArrays outside of React Component Props.
 * 
 * In React 19, storing the active WorldV2, CubedSphereGrid, and Tectonic Timeline in WorldStore
 * and passing a lightweight integer version counter through React props completely bypasses
 * Structured Clone overhead.
 */
class WorldStoreSingleton {
  private world: WorldV2 | null = null;
  private grid: CubedSphereGrid | null = null;
  private timeline: TectonicSimulationTimeline | null = null;
  private activeSnapshotIndex: number = 0;
  private version: number = 0;

  public set(world: WorldV2, grid: CubedSphereGrid): number {
    this.world = world;
    this.grid = grid;
    this.timeline = world.timeline ?? null;
    this.activeSnapshotIndex = this.timeline ? this.timeline.snapshots.length - 1 : 0;
    this.version++;
    return this.version;
  }

  public getWorld(): WorldV2 | null {
    return this.world;
  }

  public getGrid(): CubedSphereGrid | null {
    return this.grid;
  }

  public getTimeline(): TectonicSimulationTimeline | null {
    return this.timeline;
  }

  public getActiveSnapshotIndex(): number {
    return this.activeSnapshotIndex;
  }

  public getActiveSnapshot(): TectonicTimeSnapshot | null {
    if (!this.timeline || !this.timeline.snapshots.length) return null;
    const idx = Math.max(0, Math.min(this.timeline.snapshots.length - 1, this.activeSnapshotIndex));
    return this.timeline.snapshots[idx];
  }

  public setSnapshotIndex(index: number): number {
    if (!this.timeline || !this.world) return this.version;
    const clamped = Math.max(0, Math.min(this.timeline.snapshots.length - 1, index));
    this.activeSnapshotIndex = clamped;
    const snap = this.timeline.snapshots[clamped];

    if (snap) {
      // Snapshots are immutable display buffers. Point the active geology view
      // at them directly so timeline scrubbing performs no planet-sized clones.
      this.world.geology.plateIds = snap.dominantPlateId;
      this.world.geology.boundaryType = snap.boundaryClass;
      this.world.geology.tectonicUpliftRate = snap.normalVelocityMmYr;
      this.world.geology.ownershipClosure = snap.closureResidual;
      this.world.geology.dominanceConfidence = snap.dominanceConfidence;
      if (snap.continentalThicknessM) {
        this.world.geology.continentalThicknessM = snap.continentalThicknessM;
      }
    }


    this.version++;
    return this.version;
  }

  public getVersion(): number {
    return this.version;
  }

  public clear(): void {
    this.world = null;
    this.grid = null;
    this.timeline = null;
    this.activeSnapshotIndex = 0;
    this.version++;
  }
}

export const WorldStore = new WorldStoreSingleton();
