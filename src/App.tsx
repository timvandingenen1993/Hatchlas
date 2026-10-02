/**
 * Top-level app shell. Renders Mountain Studio, and routes the dev-only lab pages
 * (/forest-lab, /forest-props, /pool-lab).
 */
import { useState } from 'react';
import { Download, Mountain } from 'lucide-react';
import { MountainDetailStudio } from './components/MountainDetailStudio';
import { ForestPropTestRoute } from './components/ForestPropTestRoute';
import { PoolLabRoute } from './components/PoolLabRoute';
import { ForestLabRoute } from './components/ForestLabRoute';
import type { MountainPreviewBackendStatus } from './rendering/mountainPreviewTypes';

// Fun fact: there is a whole planet-scale world generator in this repo (plate
// tectonics, erosion, climate, Equal Earth projection: src/core, src/tectonics,
// src/pipeline and friends). It has tests, and nothing in the UI
// calls it. Maybe when I have time and get a bit smarter I will tackle this...

interface MountainBackendState {
  backend: MountainPreviewBackendStatus;
  reason?: string;
}

export function App() {
  const [isExportOpen, setIsExportOpen] = useState<boolean>(false);
  const [mountainBackend, setMountainBackend] =
    useState<MountainBackendState>({ backend: 'checking' });

  if (
    typeof window !== 'undefined' &&
    (window.location.pathname === '/forest-props' ||
      window.location.pathname === '/forest-prop')
  ) {
    return <ForestPropTestRoute />;
  }

  if (typeof window !== 'undefined' && window.location.pathname === '/pool-lab') {
    return <PoolLabRoute />;
  }

  if (typeof window !== 'undefined' && window.location.pathname === '/forest-lab') {
    return <ForestLabRoute />;
  }

  const backendLabel =
    mountainBackend.backend === 'webgpu'
      ? 'GPU active'
      : mountainBackend.backend === 'initializing'
        ? 'GPU starting'
        : mountainBackend.backend === 'cpu'
          ? 'CPU fields'
          : 'GPU checking';
  const backendTitle =
    mountainBackend.backend === 'webgpu'
      ? 'WebGPU is preparing mountain support fields. Final painting remains CPU-backed.'
      : mountainBackend.backend === 'cpu'
        ? `CPU is preparing mountain support fields.${mountainBackend.reason ? ` ${mountainBackend.reason}` : ''}`
        : mountainBackend.backend === 'initializing'
          ? 'Checking WebGPU and initializing the mountain-field backend…'
          : 'Waiting for the first mountain render to report its backend.';
  const backendDotClass =
    mountainBackend.backend === 'webgpu'
      ? 'bg-emerald-400'
      : mountainBackend.backend === 'initializing'
        ? 'bg-amber-400 animate-pulse'
        : mountainBackend.backend === 'cpu'
          ? 'bg-orange-400'
          : 'bg-slate-500';

  return (
    <div className="flex flex-col h-screen w-screen bg-[#12151a] text-slate-100 font-sans overflow-hidden">
      {/* Top Header */}
      <header className="z-30 flex h-10 shrink-0 items-center gap-3 border-b border-white/5 bg-[#16191f] px-3">
        <Mountain size={16} className="text-slate-300" aria-hidden="true" />
        <h1 className="text-[13px] font-semibold text-slate-100">Hatchlas</h1>

        <div className="ml-auto hidden items-center gap-1.5 text-[11px] text-slate-400 sm:flex"
          role="status" aria-live="polite" title={backendTitle}>
          <span className={`h-1.5 w-1.5 rounded-full ${backendDotClass}`} />
          {backendLabel}
        </div>

        <button
          type="button"
          onClick={() => setIsExportOpen(true)}
          className="ml-auto flex items-center gap-1.5 rounded bg-sky-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-sky-500 sm:ml-2"
        >
          <Download size={13} /> Export
        </button>
      </header>

      {/* Main Workspace */}
      <main className="flex flex-1 relative overflow-hidden">
        <MountainDetailStudio
          isExportOpen={isExportOpen}
          onCloseExport={() => setIsExportOpen(false)}
          onMountainBackendStatusChange={setMountainBackend}
        />
      </main>
    </div>
  );
}

export default App;
