/**
 * Hardware Acceleration & Offscreen Rendering Feature Detection
 */

export interface RenderCapabilities {
  hasWebGL: boolean;
  hasWebGL2: boolean;
  hasOffscreenCanvas: boolean;
  hasTransferControl: boolean;
  recommendedBackend: 'webgl' | 'offscreen_worker' | 'canvas2d';
}

export function detectRenderCapabilities(): RenderCapabilities {
  let hasWebGL = false;
  let hasWebGL2 = false;
  let hasOffscreenCanvas = false;
  let hasTransferControl = false;

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      const testCanvas = document.createElement('canvas');
      hasWebGL = !!(
        window.WebGLRenderingContext &&
        (testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl'))
      );
      hasWebGL2 = !!(window.WebGL2RenderingContext && testCanvas.getContext('webgl2'));
      hasTransferControl = typeof (testCanvas as any).transferControlToOffscreen === 'function';
    } catch {
      hasWebGL = false;
      hasWebGL2 = false;
    }
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    hasOffscreenCanvas = true;
  }

  let recommendedBackend: 'webgl' | 'offscreen_worker' | 'canvas2d' = 'canvas2d';
  if (hasWebGL || hasWebGL2) {
    recommendedBackend = 'webgl';
  } else if (hasOffscreenCanvas && hasTransferControl) {
    recommendedBackend = 'offscreen_worker';
  }

  return {
    hasWebGL,
    hasWebGL2,
    hasOffscreenCanvas,
    hasTransferControl,
    recommendedBackend,
  };
}
