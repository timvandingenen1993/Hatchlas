/**
 * Viewer and controls for the high-resolution mountain simulator.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { simulateHighResMountainLandscape, type HighResMountainConfig, type HighResMountainData } from '../terrain/highResMountainSimulator';
import { renderHighResLandscape, type RenderOptions } from '../rendering/highResRenderer';
import { generateGeomorphicLandscape, type GeomorphicLandscapeData } from '../terrain/geomorphicLandscapeEngine';
import { renderGeomorphicDEM, type ReliefShadingMode, type GeomorphicPalette } from '../rendering/geomorphicRenderer';
import { WebGLDEMRenderer } from '../rendering/webglDEMRenderer';

export type HighResViewMode = 'scientific_orography' | 'exact_geomorphic_dem';
export type HighResLayer = 'elevation' | 'composite' | 'rivers' | 'precipitation' | 'biomes' | 'erosion';

export function HighResMountainViewer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglDEMRendererRef = useRef<WebGLDEMRenderer | null>(null);
  const [, startTransition] = useTransition();

  // Mode: Scientific Multi-Physics vs Exact DEM
  const [viewMode, setViewMode] = useState<HighResViewMode>('exact_geomorphic_dem');
  const [currentLayer, setCurrentLayer] = useState<HighResLayer>('composite');

  // Core Simulation Parameters
  const [seed, setSeed] = useState<number>(4242);
  const [resolution, setResolution] = useState<number>(512); // 512, 1024, 2048
  const [domainSizeKm, setDomainSizeKm] = useState<number>(150);
  const [tectonicUpliftM, setTectonicUpliftM] = useState<number>(2600);

  // Geomorphic Structural Detail Parameters
  const [erosionStrength, setErosionStrength] = useState<number>(1.2);
  const [drainageDensity, setDrainageDensity] = useState<number>(1.2);
  const [spurRoughness, setSpurRoughness] = useState<number>(1.0);
  const [alluvialDeposition, setAlluvialDeposition] = useState<number>(0.8);
  const [gorgeDepthM, setGorgeDepthM] = useState<number>(750);
  const [meanderSinuosity, setMeanderSinuosity] = useState<number>(1.2);

  // Scientific Orography Physics Parameters
  const [windAngleDeg, setWindAngleDeg] = useState<number>(45);
  const [windSpeedMs, setWindSpeedMs] = useState<number>(16);
  const [precipitationMmYr, setPrecipitationMmYr] = useState<number>(1600);
  const [geologicalAgeMyr, setGeologicalAgeMyr] = useState<number>(8);

  // Shading & Cartographic Rendering Parameters
  const [shadingMode, setShadingMode] = useState<ReliefShadingMode>('swiss_multidirectional');
  const [palette, setPalette] = useState<GeomorphicPalette>('european_topo');
  const [verticalExagg, setVerticalExagg] = useState<number>(3.8);
  const [aoStrength, setAoStrength] = useState<number>(0.45);
  const [sunAzimuthDeg, setSunAzimuthDeg] = useState<number>(315);
  const [sunAltitudeDeg, setSunAltitudeDeg] = useState<number>(45);

  // Cached Simulation Data in State
  const [scientificData, setScientificData] = useState<HighResMountainData | null>(null);
  const [geomorphicData, setGeomorphicData] = useState<GeomorphicLandscapeData | null>(null);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);

  // Tooltip Hover Info
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    elevM: number;
    precipMm?: number;
    tempC?: number;
    areaKm2?: number;
    strahler?: number;
  } | null>(null);

  // 1. Trigger Simulation when any physical parameter or seed changes
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsSimulating(true);
      startTransition(() => {
        if (viewMode === 'exact_geomorphic_dem') {
          const landscape = generateGeomorphicLandscape({
            resolution,
            domainSizeKm,
            seed,
            maxElevationM: tectonicUpliftM,
            baseLevelM: 80,
            erosionStrength,
            drainageDensity,
            spurRoughness,
            alluvialDeposition,
            gorgeDepthM,
            meanderSinuosity,
          });
          setGeomorphicData(landscape);
        } else {
          const config: HighResMountainConfig = {
            resolution,
            domainSizeKm,
            seed,
            tectonicUpliftM,
            windSpeedMs,
            windAngleRad: (windAngleDeg * Math.PI) / 180.0,
            precipitationMmYr,
            rockHardness: 1.0,
            geologicalAgeMyr,
            criticalSlope: 0.68,
          };
          const data = simulateHighResMountainLandscape(config);
          setScientificData(data);
        }
        setIsSimulating(false);
      });
    }, 20);

    return () => clearTimeout(timer);
  }, [
    seed,
    resolution,
    domainSizeKm,
    tectonicUpliftM,
    erosionStrength,
    drainageDensity,
    spurRoughness,
    alluvialDeposition,
    gorgeDepthM,
    meanderSinuosity,
    windAngleDeg,
    windSpeedMs,
    precipitationMmYr,
    geologicalAgeMyr,
    viewMode,
  ]);

  // 2. Render to Canvas whenever simulation data, layer, lighting, or mode changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (canvas.width !== resolution || canvas.height !== resolution) {
      canvas.width = resolution;
      canvas.height = resolution;
      if (webglDEMRendererRef.current) {
        webglDEMRendererRef.current.destroy();
        webglDEMRendererRef.current = null;
      }
    }

    if (!webglDEMRendererRef.current) {
      const renderer = new WebGLDEMRenderer(canvas);
      if (renderer.isSupported()) {
        webglDEMRendererRef.current = renderer;
      }
    }

    const glRenderer = webglDEMRendererRef.current;

    if (viewMode === 'exact_geomorphic_dem' && geomorphicData) {
      if (glRenderer && glRenderer.isSupported()) {
        glRenderer.render(geomorphicData, {
          verticalExaggeration: verticalExagg,
          sunAzimuthDeg,
          sunAltitudeDeg,
          shadingMode,
          palette,
          ambientOcclusionStrength: aoStrength,
        });
      } else {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const showRivers = currentLayer === 'composite' || currentLayer === 'rivers';
          const rawImg = renderGeomorphicDEM(geomorphicData, {
            showRivers,
            verticalExaggeration: verticalExagg,
            sunAzimuthDeg,
            sunAltitudeDeg,
            shadingMode,
            palette,
            ambientOcclusionStrength: aoStrength,
          });

          const imgData =
            typeof ImageData !== 'undefined' && rawImg instanceof ImageData
              ? rawImg
              : new ImageData(new Uint8ClampedArray((rawImg as any).data), resolution, resolution);
          ctx.putImageData(imgData, 0, 0);
        }
      }
    } else if (viewMode === 'scientific_orography' && scientificData) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const renderOpts: RenderOptions = {
          layer: currentLayer as any,
          showHillshade: true,
          sunAzimuthDeg,
          sunAltitudeDeg,
        };
        const rawImg = renderHighResLandscape(scientificData, renderOpts);
        const imgData =
          typeof ImageData !== 'undefined' && rawImg instanceof ImageData
            ? rawImg
            : new ImageData(new Uint8ClampedArray((rawImg as any).data), resolution, resolution);
        ctx.putImageData(imgData, 0, 0);
      }
    }
  }, [
    geomorphicData,
    scientificData,
    currentLayer,
    verticalExagg,
    sunAzimuthDeg,
    sunAltitudeDeg,
    shadingMode,
    palette,
    aoStrength,
    viewMode,
    resolution,
  ]);

  function handleCanvasMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;

    const px = Math.max(0, Math.min(resolution - 1, Math.floor(xRatio * resolution)));
    const py = Math.max(0, Math.min(resolution - 1, Math.floor(yRatio * resolution)));
    const idx = py * resolution + px;

    if (viewMode === 'scientific_orography' && scientificData) {
      setHoverInfo({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        elevM: scientificData.elevation[idx],
        precipMm: scientificData.precipitation[idx],
        tempC: scientificData.temperatureC[idx],
        areaKm2: scientificData.drainageAreaKm2[idx],
        strahler: scientificData.strahlerOrder[idx],
      });
    } else if (viewMode === 'exact_geomorphic_dem' && geomorphicData) {
      setHoverInfo({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        elevM: geomorphicData.elevation[idx],
        areaKm2: geomorphicData.drainageAreaKm2[idx],
      });
    }
  }

  function handleDownload() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `mountain_detail_${viewMode}_${currentLayer}_seed${seed}_${resolution}p.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  return (
    <div className="flex h-full w-full bg-slate-950 text-slate-100 overflow-hidden">
      {/* Sidebar Controls */}
      <aside className="w-84 lg:w-92 h-full overflow-y-auto p-4 border-r border-slate-800 bg-slate-900/90 shrink-0 flex flex-col gap-4 z-10 text-xs">
        <div>
          <h2 className="text-sm font-bold text-cyan-400 flex items-center gap-1.5 mb-1">
            <span>🏔️</span> High-Res Mountain & Fluvial Detail
          </h2>
          <p className="text-[11px] text-slate-400">
            Sub-kilometer geomorphic landscape simulator matching real European DEM relief maps.
          </p>
        </div>

        {/* Mode Selector */}
        <div className="flex flex-col gap-1.5 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800">
          <label className="text-[11px] font-semibold text-slate-300">Rendering Engine Mode</label>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => setViewMode('exact_geomorphic_dem')}
              className={`py-1.5 px-2 rounded-lg font-bold text-center transition cursor-pointer ${
                viewMode === 'exact_geomorphic_dem'
                  ? 'bg-amber-600 text-white shadow-md'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              🏔️ European DEM
            </button>
            <button
              onClick={() => setViewMode('scientific_orography')}
              className={`py-1.5 px-2 rounded-lg font-bold text-center transition cursor-pointer ${
                viewMode === 'scientific_orography'
                  ? 'bg-cyan-600 text-white shadow-md'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              🌧️ Orography Physics
            </button>
          </div>
        </div>

        {/* Layer Selector */}
        <div className="flex flex-col gap-1.5 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800">
          <label className="text-[11px] font-semibold text-slate-300">Active View Layer</label>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => setCurrentLayer('composite')}
              className={`py-1 px-2 rounded-lg font-semibold text-left transition cursor-pointer ${
                currentLayer === 'composite' ? 'bg-blue-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              🗺️ Topo + Rivers
            </button>
            <button
              onClick={() => setCurrentLayer('elevation')}
              className={`py-1 px-2 rounded-lg font-semibold text-left transition cursor-pointer ${
                currentLayer === 'elevation' ? 'bg-blue-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              🏔️ 3D Relief DEM
            </button>
            {viewMode === 'scientific_orography' && (
              <>
                <button
                  onClick={() => setCurrentLayer('precipitation')}
                  className={`py-1 px-2 rounded-lg font-semibold text-left transition cursor-pointer ${
                    currentLayer === 'precipitation' ? 'bg-blue-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                  }`}
                >
                  🌧️ Orographic Rain
                </button>
                <button
                  onClick={() => setCurrentLayer('biomes')}
                  className={`py-1 px-2 rounded-lg font-semibold text-left transition cursor-pointer ${
                    currentLayer === 'biomes' ? 'bg-blue-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                  }`}
                >
                  🌿 Forest & Tundra
                </button>
              </>
            )}
            <button
              onClick={() => setCurrentLayer('rivers')}
              className={`py-1 px-2 rounded-lg font-semibold text-left transition cursor-pointer ${
                currentLayer === 'rivers' ? 'bg-blue-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              🌊 River Network
            </button>
          </div>
        </div>

        {/* Resolution Selector */}
        <div className="flex flex-col gap-1.5 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800">
          <div className="flex justify-between items-center">
            <span className="font-semibold text-slate-300">Detail Grid Resolution</span>
            <span className="font-mono text-cyan-300 font-bold">{resolution}×{resolution}</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={() => setResolution(512)}
              className={`py-1 rounded font-mono text-center transition cursor-pointer ${
                resolution === 512 ? 'bg-cyan-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              512 (Fast)
            </button>
            <button
              onClick={() => setResolution(1024)}
              className={`py-1 rounded font-mono text-center transition cursor-pointer ${
                resolution === 1024 ? 'bg-cyan-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              1024 (HD)
            </button>
            <button
              onClick={() => setResolution(2048)}
              className={`py-1 rounded font-mono text-center transition cursor-pointer ${
                resolution === 2048 ? 'bg-gradient-to-r from-amber-600 to-orange-600 text-white font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              2048 (4.2M)
            </button>
          </div>
        </div>

        {/* Geomorphic Parameters */}
        <div className="flex flex-col gap-3 bg-slate-950/80 p-3 rounded-xl border border-slate-800">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-300">Random Seed</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value))}
                className="w-20 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-right font-mono"
              />
              <button
                onClick={() => setSeed(Math.floor(Math.random() * 999999))}
                className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-200 cursor-pointer"
                title="Randomize Seed"
              >
                🎲
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span>Domain Extent</span>
              <span className="font-mono text-cyan-300">{domainSizeKm} km</span>
            </div>
            <input
              type="range"
              min="80"
              max="600"
              step="20"
              value={domainSizeKm}
              onChange={(e) => setDomainSizeKm(Number(e.target.value))}
              className="accent-cyan-500 cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span>Peak Elevation</span>
              <span className="font-mono text-cyan-300">{tectonicUpliftM} m</span>
            </div>
            <input
              type="range"
              min="1500"
              max="5500"
              step="100"
              value={tectonicUpliftM}
              onChange={(e) => setTectonicUpliftM(Number(e.target.value))}
              className="accent-cyan-500 cursor-pointer"
            />
          </div>

          {viewMode === 'exact_geomorphic_dem' ? (
            <>
              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Drainage Network Density</span>
                  <span className="font-mono text-cyan-300">{drainageDensity.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.5"
                  step="0.1"
                  value={drainageDensity}
                  onChange={(e) => setDrainageDensity(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                  title="Montgomery-Dietrich channel initiation threshold: controls dendritic headwater branching"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Chevron Spur Prominence</span>
                  <span className="font-mono text-cyan-300">{spurRoughness.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={spurRoughness}
                  onChange={(e) => setSpurRoughness(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                  title="Controls lateral transverse spur ridges branching off main mountain spines"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Valley Alluviation / Flatness</span>
                  <span className="font-mono text-cyan-300">{alluvialDeposition.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.5"
                  step="0.1"
                  value={alluvialDeposition}
                  onChange={(e) => setAlluvialDeposition(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                  title="Controls sediment filling & flat floodplain formation in valleys"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Gorge Water-Gap Depth</span>
                  <span className="font-mono text-cyan-300">{gorgeDepthM} m</span>
                </div>
                <input
                  type="range"
                  min="200"
                  max="1200"
                  step="50"
                  value={gorgeDepthM}
                  onChange={(e) => setGorgeDepthM(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                  title="Controls depth of antecedent river pass carved through the mountain range"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Meander Sinuosity</span>
                  <span className="font-mono text-cyan-300">{meanderSinuosity.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.6"
                  max="1.8"
                  step="0.1"
                  value={meanderSinuosity}
                  onChange={(e) => setMeanderSinuosity(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                  title="Controls river meander loops and oxbow complexity in plains"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Fluvial Stream Power</span>
                  <span className="font-mono text-cyan-300">{erosionStrength.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.5"
                  step="0.1"
                  value={erosionStrength}
                  onChange={(e) => setErosionStrength(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Geological Age (Incision)</span>
                  <span className="font-mono text-cyan-300">{geologicalAgeMyr} Myr</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="20"
                  step="1"
                  value={geologicalAgeMyr}
                  onChange={(e) => setGeologicalAgeMyr(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Wind Direction (Flank Angle)</span>
                  <span className="font-mono text-cyan-300">{windAngleDeg}°</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="360"
                  step="5"
                  value={windAngleDeg}
                  onChange={(e) => setWindAngleDeg(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Wind Speed</span>
                  <span className="font-mono text-cyan-300">{windSpeedMs} m/s</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="35"
                  step="1"
                  value={windSpeedMs}
                  onChange={(e) => setWindSpeedMs(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span>Precipitation (Deluge)</span>
                  <span className="font-mono text-cyan-300">{precipitationMmYr} mm/yr</span>
                </div>
                <input
                  type="range"
                  min="600"
                  max="3500"
                  step="100"
                  value={precipitationMmYr}
                  onChange={(e) => setPrecipitationMmYr(Number(e.target.value))}
                  className="accent-cyan-500 cursor-pointer"
                />
              </div>
            </>
          )}
        </div>

        {/* Shading & Cartography Controls */}
        <div className="flex flex-col gap-2.5 bg-slate-950/80 p-3 rounded-xl border border-slate-800">
          <label className="text-[11px] font-semibold text-slate-300">Cartography & Relief Shading</label>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">Shading Algorithm</span>
            <div className="grid grid-cols-3 gap-1">
              <button
                onClick={() => setShadingMode('swiss_multidirectional')}
                className={`py-1 rounded text-[10px] font-bold text-center transition cursor-pointer ${
                  shadingMode === 'swiss_multidirectional' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                🇨🇭 Swiss 3-Way
              </button>
              <button
                onClick={() => setShadingMode('ambient_occlusion')}
                className={`py-1 rounded text-[10px] font-bold text-center transition cursor-pointer ${
                  shadingMode === 'ambient_occlusion' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                🌗 Soft AO
              </button>
              <button
                onClick={() => setShadingMode('classic')}
                className={`py-1 rounded text-[10px] font-bold text-center transition cursor-pointer ${
                  shadingMode === 'classic' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                ☀️ Classic
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">Color Hypsometric Palette</span>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => setPalette('european_topo')}
                className={`py-1 rounded text-[10px] font-bold text-center transition cursor-pointer ${
                  palette === 'european_topo' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                🗺️ European DEM
              </button>
              <button
                onClick={() => setPalette('swiss_alpine')}
                className={`py-1 rounded text-[10px] font-bold text-center transition cursor-pointer ${
                  palette === 'swiss_alpine' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                ⛰️ Swiss Alpine
              </button>
              <button
                onClick={() => setPalette('physical_satellite')}
                className={`py-1 rounded text-[10px] font-bold text-center transition cursor-pointer ${
                  palette === 'physical_satellite' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                🛰️ Satellite
              </button>
              <button
                onClick={() => setPalette('high_contrast')}
                className={`py-1 rounded text-[10px] font-bold text-center transition cursor-pointer ${
                  palette === 'high_contrast' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300'
                }`}
              >
                🔥 High Contrast
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span>Sun Lighting Azimuth</span>
              <span className="font-mono text-cyan-300">{sunAzimuthDeg}°</span>
            </div>
            <input
              type="range"
              min="0"
              max="360"
              step="15"
              value={sunAzimuthDeg}
              onChange={(e) => setSunAzimuthDeg(Number(e.target.value))}
              className="accent-cyan-500 cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span>Sun Altitude</span>
              <span className="font-mono text-cyan-300">{sunAltitudeDeg}°</span>
            </div>
            <input
              type="range"
              min="15"
              max="80"
              step="5"
              value={sunAltitudeDeg}
              onChange={(e) => setSunAltitudeDeg(Number(e.target.value))}
              className="accent-cyan-500 cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span>Vertical 3D Exaggeration</span>
              <span className="font-mono text-cyan-300">{verticalExagg.toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min="1.0"
              max="7.0"
              step="0.2"
              value={verticalExagg}
              onChange={(e) => setVerticalExagg(Number(e.target.value))}
              className="accent-cyan-500 cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span>Valley Ambient Occlusion</span>
              <span className="font-mono text-cyan-300">{aoStrength.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.0"
              max="1.0"
              step="0.05"
              value={aoStrength}
              onChange={(e) => setAoStrength(Number(e.target.value))}
              className="accent-cyan-500 cursor-pointer"
            />
          </div>
        </div>

        <button
          onClick={handleDownload}
          className="w-full py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 font-bold rounded-xl text-white shadow-lg transition flex items-center justify-center gap-2 cursor-pointer"
        >
          <span>💾</span> Download High-Res PNG ({resolution}×{resolution})
        </button>
      </aside>

      {/* Main Interactive Canvas Area */}
      <main className="flex-1 relative flex items-center justify-center bg-slate-950 p-4 overflow-hidden">
        {isSimulating && (
          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-xs z-30 flex flex-col items-center justify-center gap-2 pointer-events-none">
            <div className="w-7 h-7 border-3 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[11px] font-bold text-cyan-300">Simulating Geomorphology...</span>
          </div>
        )}

        <div className="relative max-h-full max-w-full aspect-square shadow-2xl rounded-xl overflow-hidden border border-slate-800 bg-black">
          <canvas
            ref={canvasRef}
            onMouseMove={handleCanvasMouseMove}
            onMouseLeave={() => setHoverInfo(null)}
            className="w-full h-full object-contain cursor-crosshair"
          />

          {/* Inspect Tooltip */}
          {hoverInfo && (
            <div
              className="absolute pointer-events-none bg-slate-900/90 border border-slate-700 text-white px-2.5 py-1.5 rounded-lg text-[11px] shadow-xl backdrop-blur flex flex-col gap-0.5 z-20"
              style={{
                left: Math.min(window.innerWidth - 240, hoverInfo.x + 15),
                top: Math.min(window.innerHeight - 160, hoverInfo.y + 15),
              }}
            >
              <div className="font-bold text-cyan-300">🏔️ Elevation: {hoverInfo.elevM.toFixed(0)} m</div>
              {hoverInfo.precipMm !== undefined && (
                <div className="text-blue-300">🌧️ Rainfall: {hoverInfo.precipMm.toFixed(0)} mm/yr</div>
              )}
              {hoverInfo.tempC !== undefined && (
                <div className="text-amber-300">🌡️ Temp: {hoverInfo.tempC.toFixed(1)} °C</div>
              )}
              {hoverInfo.areaKm2 !== undefined && hoverInfo.areaKm2 > 1.0 && (
                <div className="text-emerald-300">
                  🌊 Catchment: {hoverInfo.areaKm2.toFixed(1)} km² {hoverInfo.strahler ? `(Order ${hoverInfo.strahler})` : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

