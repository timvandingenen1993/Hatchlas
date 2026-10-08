/**
 * Top-level app shell. Renders Mountain Studio, and routes the dev-only lab pages
 * (/forest-lab, /forest-props, /pool-lab, /structure-lab).
 */
import { useState } from 'react';
import { Coffee, Download, Heart, Mountain } from 'lucide-react';
import { MountainDetailStudio } from './components/MountainDetailStudio';
import { ForestPropTestRoute } from './components/ForestPropTestRoute';
import { PoolLabRoute } from './components/PoolLabRoute';
import { ForestLabRoute } from './components/ForestLabRoute';
import { StructureLabRoute } from './components/StructureLabRoute';
import type { MountainPreviewBackendStatus } from './rendering/mountainPreviewTypes';

// Fun fact: there is a whole planet-scale world generator in this repo (plate
// tectonics, erosion, climate, Equal Earth projection: src/core, src/tectonics,
// src/pipeline and friends). It has tests, and nothing in the UI
// calls it. Maybe when I have time and get a bit smarter I will tackle this...

interface MountainBackendState {
  backend: MountainPreviewBackendStatus;
  reason?: string;
}

const headerLinkClass =
  'flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white/5 hover:text-slate-100';

/** GitHub mark (lucide-react no longer ships brand icons). */
function GitHubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
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

  if (typeof window !== 'undefined' && window.location.pathname === '/structure-lab') {
    return <StructureLabRoute />;
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

        <nav className="ml-auto flex items-center gap-0.5 sm:ml-2" aria-label="Project links">
          <a href="https://github.com/timvandingenen1993/Hatchlas" target="_blank" rel="noopener noreferrer"
            className={headerLinkClass} title="Source code on GitHub" aria-label="Source code on GitHub">
            <GitHubIcon />
          </a>
          <a href="https://github.com/sponsors/timvandingenen1993" target="_blank" rel="noopener noreferrer"
            className={headerLinkClass} title="Sponsor on GitHub" aria-label="Sponsor on GitHub">
            <Heart size={14} />
          </a>
          <a href="https://ko-fi.com/timvandingenen1993" target="_blank" rel="noopener noreferrer"
            className={headerLinkClass} title="Buy me a coffee on Ko-fi" aria-label="Buy me a coffee on Ko-fi">
            <Coffee size={14} />
          </a>
        </nav>

        <button
          type="button"
          onClick={() => setIsExportOpen(true)}
          className="ml-1 flex items-center gap-1.5 rounded bg-sky-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-sky-500"
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
