import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  Zap, 
  Trash2, 
  Calendar, 
  Clock, 
  RefreshCw, 
  ChevronRight, 
  X, 
  Layers, 
  Users, 
  Cpu, 
  TrendingUp,
  History
} from 'lucide-react';
import { EnergyBucket, EnergyArchive, EnergyHistoryResponse, EnergyArchiveDetail } from '../types/energy';
import { ConfirmModal } from './ConfirmModal';

export interface EnergyHistoryProps {
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
  refreshKey?: number;
}

type RangeOption = '24h' | '7d' | '30d' | 'all';

export const EnergyHistory: React.FC<EnergyHistoryProps> = ({ onShowToast, refreshKey = 0 }) => {
  const [range, setRange] = useState<RangeOption>('24h');
  const [buckets, setBuckets] = useState<EnergyBucket[]>([]);
  const [archives, setArchives] = useState<EnergyArchive[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Hover Tooltip state for SVG chart
  const [hoveredPoint, setHoveredPoint] = useState<{
    bucket: EnergyBucket;
    x: number;
    y: number;
    index: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  // Archive inspection modal state
  const [selectedArchive, setSelectedArchive] = useState<{
    open: boolean;
    data: EnergyArchiveDetail | null;
    isLoading: boolean;
  }>({
    open: false,
    data: null,
    isLoading: false,
  });

  // Archive deletion modal state
  const [deleteArchiveModal, setDeleteArchiveModal] = useState<{
    open: boolean;
    archiveId: string | null;
  }>({
    open: false,
    archiveId: null,
  });

  const historyReqIdRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);
  const archiveReqIdRef = useRef(0);
  const archiveAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      historyAbortRef.current?.abort();
      archiveAbortRef.current?.abort();
    };
  }, []);

  // Fetch energy history for chosen range
  const fetchHistory = useCallback(async () => {
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    const reqId = ++historyReqIdRef.current;

    setIsLoading(true);
    try {
      const res = await fetch(`/api/metrics/energy/history?range=${range}`, { signal: controller.signal });
      if (reqId !== historyReqIdRef.current) return;
      if (res.ok) {
        const data: EnergyHistoryResponse = await res.json();
        if (reqId !== historyReqIdRef.current) return;
        setBuckets(Array.isArray(data.buckets) ? data.buckets : []);
        setArchives(Array.isArray(data.archives) ? data.archives : []);
      }
    } catch (err: any) {
      if (reqId !== historyReqIdRef.current || err?.name === 'AbortError') return;
      console.warn('Failed to fetch energy history:', err);
    } finally {
      if (reqId === historyReqIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [range]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory, refreshKey]);

  // Dismiss tooltip on scroll or resize to prevent detached coordinates
  useEffect(() => {
    if (!hoveredPoint) return;
    const handleDismiss = () => {
      setHoveredPoint(null);
    };

    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, [hoveredPoint]);

  // Inspect Archive
  const handleOpenArchive = async (archive: EnergyArchive) => {
    archiveAbortRef.current?.abort();
    const controller = new AbortController();
    archiveAbortRef.current = controller;
    const reqId = ++archiveReqIdRef.current;

    setSelectedArchive({ open: true, data: null, isLoading: true });
    try {
      const res = await fetch(`/api/metrics/energy/archives/${archive.id}`, { signal: controller.signal });
      if (reqId !== archiveReqIdRef.current) return;
      if (!res.ok) throw new Error('Arşiv verisi alınamadı.');
      const data: EnergyArchiveDetail = await res.json();
      if (reqId !== archiveReqIdRef.current) return;
      setSelectedArchive({ open: true, data, isLoading: false });
    } catch (err: any) {
      if (reqId !== archiveReqIdRef.current || err?.name === 'AbortError') return;
      onShowToast('Arşiv Yüklenemedi', err.message, 'error');
      setSelectedArchive({ open: false, data: null, isLoading: false });
    }
  };

  // Delete Archive
  const handleDeleteArchiveConfirm = async () => {
    const id = deleteArchiveModal.archiveId;
    if (!id) return;
    setDeleteArchiveModal({ open: false, archiveId: null });

    try {
      const res = await fetch(`/api/metrics/energy/archives/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Arşiv silinemedi.');
      onShowToast('Arşiv Silindi', 'Geçmiş dönem enerji kaydı diskten kaldırıldı.', 'info');
      if (selectedArchive.open && selectedArchive.data?.summary.id === id) {
        setSelectedArchive({ open: false, data: null, isLoading: false });
      }
      fetchHistory();
    } catch (err: any) {
      onShowToast('Silme Hatası', err.message, 'error');
    }
  };

  // SVG Chart Geometry Calculations
  const chartData = useMemo(() => {
    if (buckets.length === 0) return null;

    const values = buckets.map((b) => b.avgWatts || 0);
    const minVal = Math.max(0, Math.min(...values) * 0.85);
    const maxVal = Math.max(10, Math.max(...values) * 1.15);
    const rangeVal = maxVal - minVal || 1;

    const width = 800;
    const height = 200;
    const paddingLeft = 45;
    const paddingRight = 15;
    const paddingTop = 20;
    const paddingBottom = 30;

    const plotW = width - paddingLeft - paddingRight;
    const plotH = height - paddingTop - paddingBottom;

    const points = buckets.map((b, i) => {
      const x = paddingLeft + (i / Math.max(1, buckets.length - 1)) * plotW;
      const y = paddingTop + plotH - (((b.avgWatts || 0) - minVal) / rangeVal) * plotH;
      return { x, y, bucket: b };
    });

    const pathD = points.reduce((acc, p, idx) => {
      return idx === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`;
    }, '');

    const areaD = `${pathD} L ${points[points.length - 1].x} ${paddingTop + plotH} L ${points[0].x} ${paddingTop + plotH} Z`;

    return {
      width,
      height,
      points,
      pathD,
      areaD,
      minVal: Math.round(minVal),
      maxVal: Math.round(maxVal),
      plotW,
      plotH,
      paddingLeft,
      paddingTop,
      paddingBottom,
    };
  }, [buckets]);

  // Transform Screen/Client coordinates -> SVG viewBox coordinates using inverse getScreenCTM
  const getSvgCoordinates = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }, []);

  // Transform SVG viewBox coordinates -> Screen/Client coordinates using getScreenCTM
  const getScreenCoordinates = useCallback((svgX: number, svgY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = svgX;
    pt.y = svgY;
    const transformed = pt.matrixTransform(ctm);
    return { x: transformed.x, y: transformed.y };
  }, []);

  const handlePointerAt = useCallback((clientX: number, clientY: number) => {
    if (!chartData || chartData.points.length === 0) return;
    const svgPt = getSvgCoordinates(clientX, clientY);
    if (!svgPt) return;

    let nearestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < chartData.points.length; i++) {
      const diff = Math.abs(chartData.points[i].x - svgPt.x);
      if (diff < minDiff) {
        minDiff = diff;
        nearestIdx = i;
      }
    }
    const pt = chartData.points[nearestIdx];
    setHoveredPoint({ bucket: pt.bucket, x: pt.x, y: pt.y, index: nearestIdx });
  }, [chartData, getSvgCoordinates]);

  return (
    <div className="space-y-6">
      {/* Energy History & Watt Chart Card */}
      <div className="rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b border-white/10 gap-3 mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-white/10 border border-white/20 text-white">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-wide">Watt Tüketim Geçmişi</h3>
              <p className="text-[11px] text-silver-400 font-sans mt-0.5">
                Zaman aralığına göre ortalama güç ve kwh tüketim eğrisi
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center p-1 rounded-2xl bg-white/[0.04] border border-white/10">
              {[
                { id: '24h', label: '24 Saat' },
                { id: '7d', label: '7 Gün' },
                { id: '30d', label: '30 Gün' },
                { id: 'all', label: 'Tümü' },
              ].map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRange(r.id as RangeOption)}
                  className={`px-3 py-1 rounded-xl text-xs font-semibold transition-all ${
                    range === r.id
                      ? 'bg-white text-black shadow-md'
                      : 'text-silver-400 hover:text-white'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <button
              onClick={fetchHistory}
              disabled={isLoading}
              className="p-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-silver-300 hover:text-white transition-all"
              title="Yenile"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-white' : ''}`} />
            </button>
          </div>
        </div>

        {/* Lightweight SVG Line / Area Chart */}
        <div className="relative w-full select-none">
          {isLoading ? (
            <div className="h-52 flex flex-col items-center justify-center gap-2 text-xs text-silver-500 font-mono">
              <RefreshCw className="w-5 h-5 animate-spin text-white" />
              <span>Enerji verisi yükleniyor...</span>
            </div>
          ) : !chartData || buckets.length < 2 ? (
            <div className="h-52 flex flex-col items-center justify-center gap-2 text-xs text-silver-500 font-mono">
              <Zap className="w-6 h-6 opacity-30 text-white" />
              <span>Bu zaman aralığında yeterli veri noktası bulunmuyor.</span>
              <span className="text-[11px] text-silver-600">Arka plan enerji sayaçları periyodik olarak toplanmaktadır.</span>
            </div>
          ) : (
            <div className="relative">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${chartData.width} ${chartData.height}`}
                className="w-full h-52 overflow-visible cursor-crosshair outline-none focus:ring-1 focus:ring-white/20 rounded-2xl"
                tabIndex={0}
                role="region"
                aria-label="Watt Tüketim Geçmişi Grafiği"
                onPointerMove={(e) => handlePointerAt(e.clientX, e.clientY)}
                onPointerLeave={() => setHoveredPoint(null)}
                onTouchStart={(e) => {
                  if (e.touches.length > 0) {
                    handlePointerAt(e.touches[0].clientX, e.touches[0].clientY);
                  }
                }}
                onTouchMove={(e) => {
                  if (e.touches.length > 0) {
                    handlePointerAt(e.touches[0].clientX, e.touches[0].clientY);
                  }
                }}
                onTouchEnd={() => setHoveredPoint(null)}
                onKeyDown={(e) => {
                  if (!chartData || chartData.points.length === 0) return;
                  const cur = hoveredPoint ? hoveredPoint.index : 0;
                  if (e.key === 'ArrowRight') {
                    const next = Math.min(chartData.points.length - 1, cur + 1);
                    const pt = chartData.points[next];
                    setHoveredPoint({ bucket: pt.bucket, x: pt.x, y: pt.y, index: next });
                  } else if (e.key === 'ArrowLeft') {
                    const prev = Math.max(0, cur - 1);
                    const pt = chartData.points[prev];
                    setHoveredPoint({ bucket: pt.bucket, x: pt.x, y: pt.y, index: prev });
                  } else if (e.key === 'Escape') {
                    setHoveredPoint(null);
                  }
                }}
              >
                <defs>
                  <linearGradient id="energyFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Y Axis Grid lines */}
                <line
                  x1={chartData.paddingLeft}
                  y1={chartData.paddingTop}
                  x2={chartData.width - 15}
                  y2={chartData.paddingTop}
                  stroke="rgba(255,255,255,0.08)"
                  strokeDasharray="3 3"
                />
                <text
                  x={chartData.paddingLeft - 8}
                  y={chartData.paddingTop + 4}
                  fill="#71717a"
                  fontSize="10"
                  fontFamily="monospace"
                  textAnchor="end"
                >
                  {chartData.maxVal}W
                </text>

                <line
                  x1={chartData.paddingLeft}
                  y1={chartData.paddingTop + chartData.plotH / 2}
                  x2={chartData.width - 15}
                  y2={chartData.paddingTop + chartData.plotH / 2}
                  stroke="rgba(255,255,255,0.05)"
                  strokeDasharray="3 3"
                />
                <text
                  x={chartData.paddingLeft - 8}
                  y={chartData.paddingTop + chartData.plotH / 2 + 4}
                  fill="#71717a"
                  fontSize="10"
                  fontFamily="monospace"
                  textAnchor="end"
                >
                  {Math.round((chartData.maxVal + chartData.minVal) / 2)}W
                </text>

                <line
                  x1={chartData.paddingLeft}
                  y1={chartData.paddingTop + chartData.plotH}
                  x2={chartData.width - 15}
                  y2={chartData.paddingTop + chartData.plotH}
                  stroke="rgba(255,255,255,0.12)"
                />
                <text
                  x={chartData.paddingLeft - 8}
                  y={chartData.paddingTop + chartData.plotH + 4}
                  fill="#71717a"
                  fontSize="10"
                  fontFamily="monospace"
                  textAnchor="end"
                >
                  {chartData.minVal}W
                </text>

                {/* Filled Gradient Area */}
                <path d={chartData.areaD} fill="url(#energyFill)" />

                {/* Trend Stroke Line */}
                <path
                  d={chartData.pathD}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />

                {/* Subtle static points without expensive per-point animations */}
                {chartData.points.map((pt, idx) => (
                  <circle
                    key={idx}
                    cx={pt.x}
                    cy={pt.y}
                    r={1.5}
                    fill="rgba(255,255,255,0.4)"
                    className="pointer-events-none"
                  />
                ))}

                {/* Single active indicator on hover with guide line */}
                {hoveredPoint && (
                  <g className="pointer-events-none">
                    <line
                      x1={hoveredPoint.x}
                      y1={chartData.paddingTop}
                      x2={hoveredPoint.x}
                      y2={chartData.paddingTop + chartData.plotH}
                      stroke="rgba(255,255,255,0.25)"
                      strokeDasharray="2 2"
                    />
                    <circle
                      cx={hoveredPoint.x}
                      cy={hoveredPoint.y}
                      r={5}
                      fill="#ffffff"
                      stroke="rgba(18,19,22,0.9)"
                      strokeWidth={2}
                    />
                  </g>
                )}
              </svg>

              {/* Floating Clamped Tooltip via Portal with exact SVG getScreenCTM mapping */}
              {typeof document !== 'undefined' && hoveredPoint && svgRef.current && createPortal(
                (() => {
                  const screenPt = getScreenCoordinates(hoveredPoint.x, hoveredPoint.y);
                  if (!screenPt) return null;

                  const tooltipWidth = Math.min(260, window.innerWidth - 24);
                  const tooltipHeight = 85;

                  // Clamp X axis strictly within window boundaries
                  let left = screenPt.x - tooltipWidth / 2;
                  left = Math.max(12, Math.min(window.innerWidth - tooltipWidth - 12, left));

                  // Position Y axis: prefer placing above the point; flip below if close to top
                  let top = screenPt.y - tooltipHeight - 14;
                  if (top < 12) {
                    top = screenPt.y + 16;
                  }
                  // Clamp bottom edge too so it never overflows viewport
                  top = Math.max(12, Math.min(window.innerHeight - tooltipHeight - 12, top));

                  return (
                    <div
                      role="tooltip"
                      aria-live="polite"
                      className="fixed z-[99999] pointer-events-none p-3 rounded-2xl bg-zinc-900/95 border border-white/20 shadow-2xl backdrop-blur-md text-xs font-mono space-y-1"
                      style={{
                        left: `${left}px`,
                        top: `${top}px`,
                        width: `${tooltipWidth}px`,
                      }}
                    >
                      <div className="text-white font-bold flex items-center justify-between gap-2">
                        <span className="truncate">{new Date(hoveredPoint.bucket.start).toLocaleString('tr-TR')}</span>
                        <span className="text-emerald-300 font-mono shrink-0">{hoveredPoint.bucket.avgWatts} W</span>
                      </div>
                      <div className="flex items-center gap-3 text-silver-400 text-[11px] pt-1 border-t border-white/10 flex-wrap">
                        <span>Tüketim: {hoveredPoint.bucket.kwh.toFixed(3)} kWh</span>
                        {hoveredPoint.bucket.avgPlayers !== undefined && (
                          <span>Oyuncu: {hoveredPoint.bucket.avgPlayers}</span>
                        )}
                        {hoveredPoint.bucket.avgCpu !== undefined && (
                          <span>CPU: %{hoveredPoint.bucket.avgCpu}</span>
                        )}
                      </div>
                    </div>
                  );
                })(),
                document.body
              )}
            </div>
          )}
        </div>
      </div>

      {/* Energy Archives (Geçmiş Dönemler) List */}
      <div className="rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-6">
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-4">
          <div className="flex items-center gap-2.5">
            <History className="w-4 h-4 text-white" />
            <h3 className="text-sm font-bold text-white tracking-wide">Geçmiş Dönemler ve Arşivler</h3>
          </div>
          <span className="text-xs text-silver-400 font-sans">
            {archives.length} Kayıtlı Dönem
          </span>
        </div>

        {archives.length === 0 ? (
          <div className="py-8 text-center text-xs text-silver-500 font-mono">
            Henüz arşivlenmiş geçmiş bir sayaç dönemi bulunmuyor. Sayaç sıfırlandığında önceki dönem buraya arşivlenir.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-sans">
              <thead>
                <tr className="border-b border-white/5 text-silver-500 text-[11px] uppercase">
                  <th className="pb-3 font-semibold">Sayaç Dönemi</th>
                  <th className="pb-3 font-semibold">Süre</th>
                  <th className="pb-3 font-semibold">Ort. Güç</th>
                  <th className="pb-3 font-semibold">Toplam Enerji</th>
                  <th className="pb-3 font-semibold">Tutar (TL)</th>
                  <th className="pb-3 font-semibold text-right">İşlemler</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {archives.map((arc) => (
                  <tr
                    key={arc.id}
                    onClick={() => handleOpenArchive(arc)}
                    className="hover:bg-white/[0.02] transition-colors cursor-pointer group"
                  >
                    <td className="py-3 font-mono text-white">
                      <div className="font-semibold text-xs">
                        {new Date(arc.from).toLocaleDateString('tr-TR')} — {new Date(arc.to).toLocaleDateString('tr-TR')}
                      </div>
                      <div className="text-[10px] text-silver-500 mt-0.5">
                        {arc.id}
                      </div>
                    </td>

                    <td className="py-3 text-silver-400 font-mono">
                      {arc.hours ? `${arc.hours} saat` : '—'}
                    </td>

                    <td className="py-3 font-mono text-silver-300">
                      {arc.avgWatts} W
                    </td>

                    <td className="py-3 font-mono text-white font-bold">
                      {arc.totalKwh.toFixed(2)} kWh
                    </td>

                    <td className="py-3 font-mono text-emerald-400 font-bold">
                      ₺{arc.costTL.toFixed(2)}
                    </td>

                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleOpenArchive(arc)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-white/15 text-silver-300 hover:text-white border border-white/10 text-[11px] transition-all"
                        >
                          <span>İncele</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => setDeleteArchiveModal({ open: true, archiveId: arc.id })}
                          className="p-1.5 rounded-xl bg-white/5 hover:bg-rose-500/20 text-silver-400 hover:text-rose-300 border border-white/10 transition-all"
                          title="Arşivi Sil"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Archive Detail Inspection Modal */}
      {selectedArchive.open && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedArchive({ open: false, data: null, isLoading: false });
          }}
          className="fixed inset-0 z-[220] flex items-center justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={() => setSelectedArchive({ open: false, data: null, isLoading: false })}
            className="fixed inset-0 bg-black/80 backdrop-blur-xl"
          />

          <div
            role="dialog"
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-2xl rounded-3xl bg-zinc-950 border border-white/10 shadow-2xl p-6 z-10 space-y-4 my-auto"
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-2xl bg-white/10 border border-white/15 text-white">
                  <History className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white tracking-wide">Dönem Enerji Özeti</h3>
                  <p className="text-xs text-silver-400 font-mono mt-0.5">
                    {selectedArchive.data
                      ? `${new Date(selectedArchive.data.summary.from).toLocaleString('tr-TR')} — ${new Date(
                          selectedArchive.data.summary.to
                        ).toLocaleString('tr-TR')}`
                      : 'Arşiv ayrıntıları yükleniyor...'}
                  </p>
                </div>
              </div>

              <button
                onClick={() => setSelectedArchive({ open: false, data: null, isLoading: false })}
                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-silver-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {selectedArchive.isLoading || !selectedArchive.data ? (
              <div className="py-12 text-center text-xs text-silver-500 font-mono flex flex-col items-center justify-center gap-2">
                <RefreshCw className="w-5 h-5 animate-spin text-white" />
                <span>Arşiv verileri yükleniyor...</span>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 rounded-2xl bg-white/[0.02] border border-white/10">
                    <span className="text-[10px] uppercase font-sans text-silver-500 block">Toplam Enerji</span>
                    <span className="text-lg font-bold font-mono text-white mt-0.5 block">
                      {selectedArchive.data.summary.totalKwh.toFixed(2)} kWh
                    </span>
                  </div>
                  <div className="p-3 rounded-2xl bg-white/[0.02] border border-white/10">
                    <span className="text-[10px] uppercase font-sans text-silver-500 block">Ortalama Güç</span>
                    <span className="text-lg font-bold font-mono text-white mt-0.5 block">
                      {selectedArchive.data.summary.avgWatts} W
                    </span>
                  </div>
                  <div className="p-3 rounded-2xl bg-white/[0.02] border border-white/10">
                    <span className="text-[10px] uppercase font-sans text-silver-500 block">Toplam Süre</span>
                    <span className="text-lg font-bold font-mono text-white mt-0.5 block">
                      {selectedArchive.data.summary.hours} Saat
                    </span>
                  </div>
                  <div className="p-3 rounded-2xl bg-white/[0.02] border border-white/10">
                    <span className="text-[10px] uppercase font-sans text-silver-500 block">Elektrik Tutarı</span>
                    <span className="text-lg font-bold font-mono text-emerald-400 mt-0.5 block">
                      ₺{selectedArchive.data.summary.costTL.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 text-xs font-mono text-silver-400">
                  <div className="flex items-center justify-between mb-2 pb-2 border-b border-white/5">
                    <span>Arşiv Kimliği: {selectedArchive.data.summary.id}</span>
                    <span>{selectedArchive.data.buckets.length} Veri Noktası</span>
                  </div>
                  <p className="text-[11px] text-silver-500 font-sans">
                    Bu kayıt dönemi başarıyla arşivlenmiştir ve geçmiş elektrik faturalandırma raporlarını incelemenize olanak tanır.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete Archive Confirm Modal */}
      <ConfirmModal
        isOpen={deleteArchiveModal.open}
        title="Enerji Arşivini Sil"
        message="Bu geçmiş dönem enerji kaydını kalıcı olarak silmek istediğinize emin misiniz? Bu işlem geri alınamaz."
        confirmText="Arşivi Sil"
        cancelText="Vazgeç"
        variant="danger"
        onConfirm={handleDeleteArchiveConfirm}
        onCancel={() => setDeleteArchiveModal({ open: false, archiveId: null })}
      />
    </div>
  );
};
