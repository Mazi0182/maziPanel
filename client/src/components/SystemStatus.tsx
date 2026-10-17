import React, { useState } from 'react';
import { 
  Cpu, 
  HardDrive, 
  Activity, 
  Network, 
  Layers, 
  Server, 
  CheckCircle2, 
  Clock, 
  Zap, 
  RefreshCw,
  Gauge,
  AlertTriangle,
  Info
} from 'lucide-react';
import { HostMetrics } from '../types';
import { ConfirmModal } from './ConfirmModal';
import { EnergyHistory } from './EnergyHistory';
import { formatRam } from '../utils/format';

interface SystemStatusProps {
  hostMetrics?: HostMetrics | null;
  onRefresh?: () => void;
  onShowToast?: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
}

export const SystemStatus: React.FC<SystemStatusProps> = ({ 
  hostMetrics: propMetrics, 
  onRefresh,
  onShowToast 
}) => {
  const [localMetrics, setLocalMetrics] = useState<HostMetrics | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [energyRefreshKey, setEnergyRefreshKey] = useState(0);

  // Energy Reset Confirm Modal State
  const [showResetEnergyModal, setShowResetEnergyModal] = useState(false);
  const [isResettingEnergy, setIsResettingEnergy] = useState(false);
  const [isRefreshingTariff, setIsRefreshingTariff] = useState(false);

  const metrics = propMetrics || localMetrics;

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      if (onRefresh) {
        onRefresh();
      }
      await fetch('/api/metrics/energy/refresh-tariff', { method: 'POST' }).catch(() => {});
      const res = await fetch('/api/metrics/host');
      if (res.ok) {
        const data = await res.json();
        setLocalMetrics(data);
      }
      setEnergyRefreshKey((k) => k + 1);
    } catch (e) {
      console.warn('Failed to load host metrics:', e);
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  };

  const handleRefreshTariff = async () => {
    if (isRefreshingTariff) return;
    setIsRefreshingTariff(true);
    try {
      const res = await fetch('/api/metrics/energy/refresh-tariff', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'EPDK tarife verisi güncellenemedi.');
      }
      const hostRes = await fetch('/api/metrics/host');
      if (hostRes.ok) {
        const hostData = await hostRes.json();
        setLocalMetrics(hostData);
      }
      if (onRefresh) onRefresh();
      setEnergyRefreshKey((k) => k + 1);
      const t = data.tariff;
      onShowToast?.(
        'EPDK Tarifesi Güncellendi',
        t ? `${t.source}: ${t.lowRate} / ${t.highRate} / ${t.sktRate} TL/kWh` : 'Güncel tarife verileri uygulandı.',
        'success'
      );
    } catch (err: any) {
      onShowToast?.('Tarife Güncelleme Hatası', err.message, 'error');
    } finally {
      setTimeout(() => setIsRefreshingTariff(false), 350);
    }
  };

  const handleResetEnergy = async () => {
    setIsResettingEnergy(true);
    setShowResetEnergyModal(false);

    try {
      const res = await fetch('/api/metrics/energy/reset', {
        method: 'POST',
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Enerji sayacı sıfırlanamadı.');
      }
      onShowToast?.('Enerji Sıfırlandı', 'Mevcut sayaç arşive aktarıldı ve yeni dönem başlatıldı.', 'success');
      handleRefresh();
      setEnergyRefreshKey((k) => k + 1);
    } catch (err: any) {
      onShowToast?.('Sıfırlama Hatası', err.message, 'error');
    } finally {
      setIsResettingEnergy(false);
    }
  };

  const toGB = (bytes?: number) => {
    if (bytes === undefined || bytes === null) return null;
    return (bytes / 1024 / 1024 / 1024).toFixed(1);
  };

  const formatUptime = (seconds?: number) => {
    if (seconds === undefined || seconds === null) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const p = [];
    if (d > 0) p.push(`${d} gün`);
    if (h > 0) p.push(`${h} saat`);
    if (m > 0 || p.length === 0) p.push(`${m} dakika`);
    return p.join(' ');
  };

  const totalRamBytes = metrics?.memory?.totalBytes;
  const usedRamBytes = metrics?.memory?.usedBytes;
  const freeRamBytes = metrics?.memory?.freeBytes;

  const totalRamDisplay = totalRamBytes ? formatRam(Math.round(totalRamBytes / (1024 * 1024))) : '—';
  const usedRamDisplay = usedRamBytes ? formatRam(Math.round(usedRamBytes / (1024 * 1024))) : '—';
  const freeRamDisplay = freeRamBytes ? formatRam(Math.round(freeRamBytes / (1024 * 1024))) : '—';

  const ramPercent = metrics?.memory?.usagePercent !== undefined
    ? Math.round(metrics.memory.usagePercent)
    : (totalRamBytes && usedRamBytes ? Math.min(100, Math.round((usedRamBytes / totalRamBytes) * 100)) : undefined);

  const totalDiskGB = toGB(metrics?.disk?.totalBytes);
  const usedDiskGB = toGB(metrics?.disk?.usedBytes);
  const diskPct = metrics?.disk?.usagePct !== undefined
    ? metrics.disk.usagePct
    : (totalDiskGB && usedDiskGB ? Math.min(100, Math.round((Number(usedDiskGB) / (Number(totalDiskGB) || 1)) * 100)) : undefined);

  const cpuPercent = metrics?.cpu?.usagePercent;
  const cpuModel = metrics?.cpu?.model;
  const cpuCores = metrics?.cpu?.cores;
  const cpuLoad = metrics?.cpu?.loadAverage ? metrics.cpu.loadAverage.map((l) => l.toFixed(2)).join(', ') : null;

  // Real Network Info
  const netInterface = metrics?.network?.interface;
  const netSpeed = metrics?.network?.speedMbps 
    ? `${metrics.network.speedMbps} Mbps` 
    : (metrics?.network?.speed || null);
  const netDuplex = metrics?.network?.duplex 
    ? (metrics.network.duplex.toLowerCase().includes('full') ? 'Tam Çift Yönlü' : metrics.network.duplex)
    : null;
  const netDesc = netInterface 
    ? `${netInterface} • Durum: ${metrics?.network?.status === 'up' ? 'Bağlı (Up)' : (metrics?.network?.status || 'Aktif')}`
    : 'Düşük Gecikmeli Yerel Ağ';

  // Hardware metrics list with strictly real values
  const hardwareMetrics = [
    {
      label: 'İşlemci Kullanımı',
      value: cpuPercent !== undefined && cpuModel ? `%${cpuPercent} • ${cpuModel}` : (cpuPercent !== undefined ? `%${cpuPercent}` : '—'),
      desc: cpuCores ? `Çekirdek: ${cpuCores} vCPU • Ortalama Yük: ${cpuLoad || '—'}` : '—',
      icon: Cpu,
      percent: cpuPercent,
      bar: cpuPercent !== undefined,
    },
    {
      label: 'Sistem Belleği',
      value: usedRamBytes && totalRamBytes ? `${usedRamDisplay} / ${totalRamDisplay}` : '—',
      desc: ramPercent !== undefined ? `Kullanım: %${ramPercent} • Boş Alan: ${freeRamDisplay}` : '—',
      icon: HardDrive,
      percent: ramPercent,
      bar: ramPercent !== undefined,
    },
    {
      label: 'Depolama Alanı',
      value: usedDiskGB && totalDiskGB ? `${usedDiskGB} GB / ${totalDiskGB} GB` : '—',
      desc: diskPct !== undefined ? `Kullanım: %${diskPct} • Birincil Disk / SSD` : '—',
      icon: Layers,
      percent: diskPct,
      bar: diskPct !== undefined,
    },
    {
      label: 'İşletim Sistemi',
      value: metrics?.system?.osName || (metrics?.system?.release ? `Linux ${metrics.system.release}` : '—'),
      desc: metrics?.system?.release ? `Linux Çekirdeği ${metrics.system.release}` : '—',
      icon: Server,
      bar: false,
    },
    {
      label: 'Ağ Arayüzü',
      value: netSpeed ? `${netSpeed} ${netDuplex ? `(${netDuplex})` : ''}`.trim() : '—',
      desc: netDesc,
      icon: Network,
      bar: false,
    },
    {
      label: 'Çalışma Süresi',
      value: formatUptime(metrics?.system?.uptimeSeconds),
      desc: 'Kesintisiz Güvenli Sunucu Süreci',
      icon: Clock,
      bar: false,
    },
  ];

  // Power & Electricity contract
  const power = metrics?.power;
  const estimateReady = power?.estimateReady === true;
  const tariff = power?.tariff;
  const tariffText = tariff 
    ? `${tariff.source || 'EPDK'}: ${tariff.lowRate} / ${tariff.highRate} / ${tariff.sktRate} TL/kWh`
    : 'EPDK 04.04.2026 Mesken: 3,24 / 4,32 / 4,86 TL/kWh';

  const softwareList = metrics?.software && metrics.software.length > 0 ? metrics.software : null;

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="p-3.5 rounded-2xl bg-white/10 border border-white/20 text-white shadow-lg">
            <Activity className="w-7 h-7" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white tracking-wide">Sistem Durumu</h2>
            <p className="text-xs text-silver-400 font-sans mt-0.5">
              Canlı Donanım, Güç Tüketimi ve Enerji Analizi
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-sans text-silver-300 hover:text-white transition-all disabled:opacity-40 active:scale-95"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-white' : ''}`} />
            <span>Yenile</span>
          </button>

          <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 text-xs font-sans text-silver-300">
            <span className="w-2 h-2 rounded-full bg-white shadow-[0_0_8px_#ffffff]" />
            Donanım Aktif
          </span>
        </div>
      </div>

      {/* Electricity & Power Consumption Card */}
      <div className="rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-white/10 mb-5 gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-white/10 border border-white/20 text-white">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h3 className="text-sm font-bold text-white tracking-wide">Güç Tüketimi ve Enerji Analizi</h3>
                {estimateReady && power?.tier && (
                  <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono border ${
                    power.tier === 'low'
                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                      : power.tier === 'high'
                      ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                      : 'bg-rose-500/10 text-rose-300 border-rose-500/20'
                  }`}>
                    {power.tier === 'low'
                      ? `Düşük Kademe (≤${tariff?.lowTierLimitKwh || 240} kWh)`
                      : power.tier === 'high'
                      ? `Yüksek Kademe (>${tariff?.lowTierLimitKwh || 240} kWh)`
                      : 'Destek Dışı (SKTT)'}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-silver-400 font-sans mt-0.5">
                {tariffText}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {power?.effectiveRateTL !== null && power?.effectiveRateTL !== undefined && (
              <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-mono text-silver-300">
                Birim: {power.effectiveRateTL.toFixed(2)} TL/kWh
              </span>
            )}
            <span className="px-3 py-1 rounded-full bg-white/10 border border-white/15 text-xs font-mono text-silver-200">
              {power?.watts !== undefined ? `${power.watts} W Anlık` : '—'}
            </span>

            {/* EPDK Tarifesini Güncelle Button */}
            <button
              onClick={handleRefreshTariff}
              disabled={isRefreshingTariff}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 hover:bg-white/15 border border-white/10 text-xs font-sans text-silver-300 hover:text-white transition-all disabled:opacity-40 cursor-pointer active:scale-95"
              title="Güncel EPDK elektrik tarifesini sorgula ve uygula"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingTariff ? 'animate-spin text-white' : ''}`} />
              <span>Tarifeyi Güncelle</span>
            </button>

            {/* Enerji Sıfırla Button */}
            <button
              onClick={() => setShowResetEnergyModal(true)}
              disabled={isResettingEnergy}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 hover:bg-white/15 border border-white/10 text-xs font-sans text-silver-300 hover:text-white transition-all disabled:opacity-40 cursor-pointer active:scale-95"
              title="Mevcut dönemi arşivle ve sayaçları sıfırla"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Sıfırla</span>
            </button>
          </div>
        </div>

        {/* Warning if Annual Limit Exceeded */}
        {power?.exceedsAnnualLimit && (
          <div className="mb-5 p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center gap-3 text-amber-200 text-xs font-sans">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
            <span>
              <strong>Yıllık Tüketim Uyarısı:</strong> Yıllık tahmini tüketim {tariff?.annualLimitKwh || 4000} kWh sınırını aşıyor. Son Kaynak Tedarik Tarifesi (SKTT) kapsamında sübvansiyon dışı kalabilir.
            </span>
          </div>
        )}

        {/* Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Box 1: Anlık Güç */}
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 flex flex-col justify-between">
            <span className="text-[11px] font-sans text-silver-400 uppercase tracking-wider">
              Anlık Güç Tüketimi
            </span>
            <div className="mt-3">
              <div className="text-2xl font-bold font-mono text-white flex items-baseline gap-1">
                {power?.watts !== undefined ? power.watts : '—'}
                <span className="text-xs font-normal text-silver-400">Watt</span>
              </div>
              <p className="text-[11px] text-silver-500 font-sans mt-1">
                {estimateReady && power?.avgWatts !== undefined && power?.avgWatts !== null
                  ? `Ortalama: ${power.avgWatts} W`
                  : 'İşlemci ve bellek yüküne göre anlık'}
              </p>
            </div>
          </div>

          {/* Box 2: Tüketim (Günlük / Aylık kWh) */}
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 flex flex-col justify-between">
            <span className="text-[11px] font-sans text-silver-400 uppercase tracking-wider">
              Tahmini Enerji (kWh)
            </span>
            <div className="mt-3">
              {estimateReady ? (
                <>
                  <div className="text-2xl font-bold font-mono text-white flex items-baseline gap-1">
                    {power?.kwhPerDay !== undefined && power?.kwhPerDay !== null ? power.kwhPerDay : '—'}
                    <span className="text-xs font-normal text-silver-400">kWh / Gün</span>
                  </div>
                  <p className="text-[11px] text-silver-500 font-sans mt-1">
                    {power?.kwhPerMonth !== undefined && power?.kwhPerMonth !== null
                      ? `Aylık: ${power.kwhPerMonth} kWh`
                      : '24 saatlik çalışma projeksiyonu'}
                  </p>
                </>
              ) : (
                <div>
                  <div className="flex items-center justify-between text-xs font-sans text-silver-300 mb-1.5">
                    <span className="flex items-center gap-1.5 text-silver-400">
                      <Info className="w-3.5 h-3.5" />
                      Veri toplanıyor
                    </span>
                    <span className="font-mono text-[11px]">
                      {power?.collection?.hoursCollected ?? 0} / {power?.collection?.requiredHours ?? 24} saat
                    </span>
                  </div>
                  <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden border border-white/10">
                    <div 
                      className="h-full bg-white transition-all duration-500 rounded-full"
                      style={{ width: `${Math.max(4, Math.min(100, power?.collection?.progressPct ?? 0))}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-silver-500 font-sans mt-1.5">
                    Sağlıklı tahmin için arka plan verisi birikiyor
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Box 3: Günlük Tutar */}
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 flex flex-col justify-between">
            <span className="text-[11px] font-sans text-silver-400 uppercase tracking-wider">
              Günlük Elektrik Tutarı
            </span>
            <div className="mt-3">
              {estimateReady ? (
                <>
                  <div className="text-2xl font-bold font-mono text-white flex items-baseline gap-1">
                    {power?.dailyCostTL !== undefined && power?.dailyCostTL !== null ? `₺${power.dailyCostTL}` : '—'}
                    <span className="text-xs font-normal text-silver-400">/ Gün</span>
                  </div>
                  <p className="text-[11px] text-silver-500 font-sans mt-1">
                    {power?.idleAvgWatts !== undefined && power?.activeAvgWatts !== undefined
                      ? `${power.idleAvgWatts} W boşta • ${power.activeAvgWatts} W aktif`
                      : 'Kademeli EPDK birim fiyatı'}
                  </p>
                </>
              ) : (
                <div className="text-sm font-sans text-silver-500 py-1">
                  Yeterli veri toplandıktan sonra hesaplanacaktır
                </div>
              )}
            </div>
          </div>

          {/* Box 4: Aylık Fatura Tutarı */}
          <div className="p-4 rounded-2xl bg-white/[0.04] border border-white/20 flex flex-col justify-between shadow-lg">
            <span className="text-[11px] font-sans text-white uppercase tracking-wider font-semibold">
              Aylık Tahmini Tutar
            </span>
            <div className="mt-3 flex-1 flex flex-col justify-center">
              {estimateReady ? (
                <>
                  <div className="text-2xl font-extrabold font-mono text-white flex items-baseline gap-1">
                    {power?.monthlyCostTL !== undefined && power?.monthlyCostTL !== null ? `₺${power.monthlyCostTL}` : '—'}
                    <span className="text-xs font-normal text-silver-300">/ Ay</span>
                  </div>
                  <p className="text-[11px] text-silver-400 font-sans mt-1">
                    {power?.yearlyCostTL !== undefined && power?.yearlyCostTL !== null
                      ? `Yıllık: ₺${power.yearlyCostTL}`
                      : `${power?.kwhPerMonth ?? '—'} kWh ortalama aylık tüketim`}
                  </p>
                </>
              ) : (
                <div className="text-sm font-sans text-silver-500 py-1">
                  Tahmin verisi bekleniyor
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Extended Stats when estimateReady */}
        {estimateReady && (power?.idleAvgWatts !== undefined || power?.activeTimePct !== undefined) && (
          <div className="mt-4 pt-4 border-t border-white/5 flex flex-wrap items-center justify-between gap-3 text-xs text-silver-400 font-mono">
            <div className="flex items-center gap-4 flex-wrap">
              {power?.idleAvgWatts !== undefined && power?.idleAvgWatts !== null && (
                <span>Boşta Güç: <strong className="text-white">{power.idleAvgWatts} W</strong></span>
              )}
              {power?.activeAvgWatts !== undefined && power?.activeAvgWatts !== null && (
                <span>Oyunculu Güç: <strong className="text-white">{power.activeAvgWatts} W</strong></span>
              )}
              {power?.activeTimePct !== undefined && power?.activeTimePct !== null && (
                <span>Aktif Süre Oranı: <strong className="text-white">%{Math.round(power.activeTimePct)}</strong></span>
              )}
            </div>
            {power?.avgPlayers !== undefined && power?.avgPlayers !== null && (
              <span>Ortalama Oyuncu: <strong className="text-white">{power.avgPlayers}</strong></span>
            )}
          </div>
        )}
      </div>

      {/* Energy History Graph & Archives Component */}
      <EnergyHistory
        onShowToast={onShowToast || (() => {})}
        refreshKey={energyRefreshKey}
      />

      {/* Hardware Specs Grid (6 Equal-Height Vertically-Centered Cards) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
        {hardwareMetrics.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className="p-5 rounded-3xl glass-panel bg-white/[0.02] border border-white/10 hover:border-white/20 transition-all shadow-xl flex flex-col justify-between group h-full min-h-[165px]"
            >
              {/* Top row: Label & Icon */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-sans uppercase text-silver-400 tracking-wider">
                  {item.label}
                </span>
                <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10 text-silver-300 group-hover:text-white transition-colors">
                  <Icon className="w-5 h-5" />
                </div>
              </div>

              {/* Value and Description: Vertically centered in remaining space */}
              <div className="flex-1 flex flex-col justify-center my-1">
                <div className="text-sm font-bold text-white tracking-wide truncate">
                  {item.value}
                </div>
                <div className="text-xs text-silver-400 font-sans mt-1">
                  {item.desc}
                </div>

                {/* Progress bar or spacer to keep all 6 cards strictly aligned */}
                {item.bar && item.percent !== undefined ? (
                  <div className="mt-3">
                    <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden border border-white/10">
                      <div
                        className="h-full bg-white transition-all duration-500 rounded-full"
                        style={{ width: `${Math.max(4, Math.min(100, item.percent))}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 h-1.5" aria-hidden="true" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Software Runtime Stack Table (Real backend items) */}
      <div className="rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-6">
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-4">
          <div className="flex items-center gap-2.5">
            <Gauge className="w-4 h-4 text-white" />
            <h3 className="text-sm font-bold text-white tracking-wide">Yazılım Çalışma Zamanı ve Servisler</h3>
          </div>
          <span className="text-xs text-silver-400 font-sans">
            {softwareList ? `${softwareList.length} Servis Listelendi` : 'Yazılım Servisleri'}
          </span>
        </div>

        <div className="overflow-x-auto">
          {softwareList && softwareList.length > 0 ? (
            <table className="w-full text-left text-xs font-sans">
              <thead>
                <tr className="border-b border-white/5 text-silver-500 text-[11px] uppercase">
                  <th className="pb-3 font-semibold">Servis Adı</th>
                  <th className="pb-3 font-semibold">Sürüm</th>
                  <th className="pb-3 font-semibold">Rol ve Açıklama</th>
                  <th className="pb-3 font-semibold text-right">Durum</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {softwareList.map((sw) => {
                  const isActive = sw.status === 'active';
                  const isInactive = sw.status === 'inactive';
                  const statusLabel = isActive ? 'Aktif' : isInactive ? 'Devre Dışı' : 'Eksik';

                  return (
                    <tr key={sw.name} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 font-bold text-white">{sw.name}</td>
                      <td className="py-3 text-silver-300 font-mono text-[11px]">{sw.version || '—'}</td>
                      <td className="py-3 text-silver-400 font-sans">{sw.role || '—'}</td>
                      <td className="py-3 text-right">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[10px] font-sans ${
                          isActive 
                            ? 'bg-white/10 text-white border-white/15'
                            : isInactive
                            ? 'bg-zinc-800 text-silver-400 border-white/5'
                            : 'bg-rose-500/10 text-rose-300 border-rose-500/20'
                        }`}>
                          <CheckCircle2 className="w-3 h-3" />
                          <span>{statusLabel}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="py-8 text-center text-xs text-silver-500 font-sans">
              {metrics ? 'Servis listesi backend tarafından bekleniyor...' : 'Donanım ve yazılım verisi yükleniyor...'}
            </div>
          )}
        </div>
      </div>

      {/* Energy Reset Confirm Modal */}
      <ConfirmModal
        isOpen={showResetEnergyModal}
        title="Enerji Sayaçlarını Sıfırla"
        message="Mevcut elektrik tüketim sayaçları sıfırlanacak ve bu dönemin verileri arşive kaydedilecektir. Devam etmek istiyor musunuz?"
        confirmText="Sıfırla ve Arşivle"
        cancelText="Vazgeç"
        variant="warning"
        onConfirm={handleResetEnergy}
        onCancel={() => setShowResetEnergyModal(false)}
      />
    </div>
  );
};
