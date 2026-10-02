import {
  renderPreparedMountainExportTile,
  type PreparedMountainExportTile,
} from "./mountainExportRenderer";
import type { MountainDetailImageData } from "./mountainDetailRenderer";
import { createMountainProfiler } from "./mountainProfiler";

/**
 * Renders camera texture tiles prepared by the export worker. A prepared tile
 * is tile-sized data only, so this worker never holds the export context.
 */
type TileMessage = {
  type: "tile";
  id: number;
  prepared: PreparedMountainExportTile;
  profileEnabled: boolean;
};

self.onmessage = (event: MessageEvent<TileMessage>) => {
  const message = event.data;
  const startedAt = performance.now();
  try {
    const profiler = createMountainProfiler(message.profileEnabled, {
      layer: "camera source tile",
    });
    const image = renderPreparedMountainExportTile(
      message.prepared,
      { profiler },
    ) as MountainDetailImageData;
    const computeMs = performance.now() - startedAt;
    const externalStages = profiler?.finish("completed", false)?.stages.map(stage => ({
      stage: stage.stage,
      durationMs: stage.durationMs,
      calls: stage.calls,
    })) ?? [];
    const data = image.data;
    const foregroundData = image.foregroundPropsRGBA;
    const transfer: Transferable[] = [data.buffer];
    if (foregroundData) transfer.push(foregroundData.buffer);
    self.postMessage({
      type: "tile",
      id: message.id,
      width: image.width,
      height: image.height,
      data: data.buffer,
      foregroundData: foregroundData?.buffer,
      computeMs,
      externalStages,
    }, { transfer });
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

self.postMessage({ type: "ready" });
