/**
 * Message types exchanged between the UI and the simulation worker (request, progress, result, error).
 */
import type { SimulationConfig } from './config';
import type { WorldV2 } from './worldV2';

export type WorkerRequest =
  | { type: 'GENERATE_WORLD'; config: SimulationConfig }
  | { type: 'CANCEL_SIMULATION' };

export interface ProgressMessage {
  type: 'PROGRESS';
  stageName: string;
  stageIndex: number;
  totalStages: number;
  stageProgress: number;   // 0.0 to 1.0
  overallProgress: number; // 0.0 to 1.0
  elapsedMs: number;
  memoryMB: number;
}

export interface SuccessMessage {
  type: 'SUCCESS';
  world: WorldV2;
  simDurationMs: number;
  transferBufferCount?: number;
}

export interface ErrorMessage {
  type: 'ERROR';
  error: string;
  stageName?: string;
}

export interface CancelledMessage {
  type: 'CANCELLED';
}

export type WorkerResponse = ProgressMessage | SuccessMessage | ErrorMessage | CancelledMessage;
