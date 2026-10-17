import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  Play, 
  RotateCcw, 
  Square, 
  Power, 
  Loader2, 
  AlertCircle, 
  CheckCircle2, 
  Clock 
} from 'lucide-react';
import { ServerInstance, ServerStatus } from '../types';
import { ConfirmModal } from './ConfirmModal';
import { Tooltip } from './Tooltip';

interface PowerControlsProps {
  server: ServerInstance | null;
  status: ServerStatus;
  uptime: string;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void | Promise<any>;
  onKill: () => void;
}

export const PowerControls: React.FC<PowerControlsProps> = ({
  server,
  status,
  uptime,
  onStart,
  onStop,
  onRestart,
  onKill,
}) => {
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);
  const [confirmKillOpen, setConfirmKillOpen] = useState(false);
  const [restartingServerId, setRestartingServerId] = useState<string | null>(null);
  const [hasLeftOnline, setHasLeftOnline] = useState(false);

  const currentServerId = server?.id || null;
  const isRestartingThisServer = !!(currentServerId && restartingServerId === currentServerId);

  // Restart lifecycle tracking: persist stop -> offline -> starting until terminal online/crashed
  useEffect(() => {
    if (!restartingServerId || !currentServerId || restartingServerId !== currentServerId) {
      return;
    }

    if (status !== 'online') {
      setHasLeftOnline(true);
    }

    // Terminal completion: reached online after stopping/starting cycle, or crashed
    if (hasLeftOnline && status === 'online') {
      setRestartingServerId(null);
      setHasLeftOnline(false);
    } else if (status === 'crashed') {
      setRestartingServerId(null);
      setHasLeftOnline(false);
    }
  }, [status, restartingServerId, currentServerId, hasLeftOnline]);

  // Timeout guard: If restart was rejected and status never leaves 'online', reset reliably
  useEffect(() => {
    if (!restartingServerId || hasLeftOnline) return;
    const timer = setTimeout(() => {
      setRestartingServerId(null);
      setHasLeftOnline(false);
    }, 6000);
    return () => clearTimeout(timer);
  }, [restartingServerId, hasLeftOnline]);

  const handleRestart = async () => {
    if (!currentServerId) return;
    setRestartingServerId(currentServerId);
    setHasLeftOnline(false);

    try {
      const res = onRestart() as any;
      if (res && typeof res.catch === 'function') {
        await res.catch(() => {
          setRestartingServerId(null);
          setHasLeftOnline(false);
        });
      }
    } catch {
      setRestartingServerId(null);
      setHasLeftOnline(false);
    }
  };

  const isOnline = status === 'online';
  const isStarting = status === 'starting';
  const isStopping = status === 'stopping';
  const isOffline = status === 'offline';
  const isCrashed = status === 'crashed';
  const isTransitioning = isStarting || isStopping;
  const isRestartTransition = (status as any) === 'restarting' || isRestartingThisServer;

  // Durum rozeti bilgisi
  const getStatusBadge = () => {
    switch (status) {
      case 'online':
        return {
          title: 'Çalışıyor',
          code: 'AKTİF',
          desc: uptime && uptime !== 'Sunucu Kapalı' ? `Açık • ${uptime}` : 'Sunucu Aktif ve Çalışıyor',
          dotClass: 'bg-emerald-400 shadow-[0_0_12px_#34d399]',
          pulseColor: 'bg-emerald-400',
          borderClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
        };
      case 'starting':
        return {
          title: 'Başlatılıyor...',
          code: 'BAŞLATILIYOR',
          desc: 'Sunucu bileşenleri yükleniyor',
          dotClass: 'bg-amber-400 shadow-[0_0_12px_#fbbf24] animate-pulse',
          pulseColor: 'bg-amber-400',
          borderClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
        };
      case 'stopping':
        return {
          title: 'Durduruluyor...',
          code: 'DURDURULUYOR',
          desc: 'Dünyalar ve veriler kaydediliyor',
          dotClass: 'bg-amber-400 shadow-[0_0_12px_#fbbf24] animate-pulse',
          pulseColor: 'bg-amber-400',
          borderClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
        };
      case 'crashed':
        return {
          title: 'Çöktü',
          code: 'ÇÖKTÜ',
          desc: 'Sunucu beklenmedik biçimde sonlandı',
          dotClass: 'bg-rose-500 shadow-[0_0_12px_#f43f5e]',
          pulseColor: 'bg-rose-500',
          borderClass: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
        };
      case 'offline':
      default:
        return {
          title: 'Kapalı',
          code: 'KAPALI',
          desc: 'Sunucu çevrimdışı durumda',
          dotClass: 'bg-zinc-600',
          pulseColor: 'bg-zinc-600',
          borderClass: 'border-white/10 bg-white/5 text-silver-400',
        };
    }
  };

  const badge = getStatusBadge();

  return (
    <div className="w-full p-4 sm:p-5 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
      {/* SOL: BÜYÜK VE NET DURUM GÖSTERGESİ */}
      <div className="flex items-center gap-4">
        {/* Durum Işığı */}
        <div className="relative flex items-center justify-center w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/10 shrink-0">
          {isOnline && (
            <span className="animate-ping absolute inline-flex h-6 w-6 rounded-full bg-emerald-400 opacity-30" />
          )}
          {isTransitioning && (
            <span className="animate-ping absolute inline-flex h-6 w-6 rounded-full bg-amber-400 opacity-30" />
          )}
          <span className={`relative inline-flex rounded-full h-4 w-4 ${badge.dotClass}`} />
        </div>

        {/* Durum Metinleri */}
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-base sm:text-lg font-bold text-white tracking-wide">
              {badge.title}
            </span>
            <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full border ${badge.borderClass}`}>
              {badge.code}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-silver-400 font-mono mt-0.5">
            <Clock className="w-3.5 h-3.5 text-silver-500 shrink-0" />
            <span className="truncate">{badge.desc}</span>
          </div>
        </div>
      </div>

      {/* SAĞ: GÜÇ KONTROL BUTONLARI */}
      <div className="flex items-center gap-2 sm:gap-2.5 flex-wrap justify-end">
        {/* Başlat Butonu */}
        <button
          type="button"
          onClick={onStart}
          disabled={isOnline || isTransitioning}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-semibold transition-all active:scale-95 ${
            isOnline || isTransitioning
              ? 'bg-white/5 text-silver-600 border border-white/5 opacity-50 cursor-not-allowed'
              : 'bg-white text-black hover:bg-silver-200 border border-white shadow-[0_0_20px_rgba(255,255,255,0.3)] hover:shadow-[0_0_25px_rgba(255,255,255,0.45)]'
          }`}
        >
          {isStarting ? (
            <Loader2 className="w-4 h-4 animate-spin text-black" />
          ) : (
            <Play className="w-4 h-4 fill-current" />
          )}
          <span>Başlat</span>
        </button>

        {/* Yeniden Başlat Butonu */}
        <Tooltip content={isOffline ? 'Sunucu kapalıyken yeniden başlatılamaz' : 'Sunucuyu Yeniden Başlat'}>
          <button
            type="button"
            onClick={handleRestart}
            disabled={isOffline || isTransitioning}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-200 hover:text-white border border-white/10 text-xs font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw className={`w-4 h-4 ${isRestartTransition ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Yeniden Başlat</span>
          </button>
        </Tooltip>

        {/* Durdur Butonu */}
        <Tooltip content={isOffline ? 'Sunucu zaten kapalı' : 'Sunucuyu Güvenli Durdur'}>
          <button
            type="button"
            onClick={() => setConfirmStopOpen(true)}
            disabled={isOffline || isStopping}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-200 hover:text-white border border-white/10 text-xs font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isStopping ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Square className="w-4 h-4" />
            )}
            <span>Durdur</span>
          </button>
        </Tooltip>

        {/* Zorla Kapat Butonu */}
        <Tooltip content={isOffline ? 'Sunucu zaten kapalı' : 'İşlemi Zorla Sonlandır'}>
          <button
            type="button"
            onClick={() => setConfirmKillOpen(true)}
            disabled={isOffline}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-2xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 border border-rose-500/25 text-xs font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Power className="w-4 h-4" />
            <span className="hidden sm:inline">Zorla Kapat</span>
          </button>
        </Tooltip>
      </div>

      {/* Durdur Onay Modalı */}
      <ConfirmModal
        isOpen={confirmStopOpen}
        title="Sunucuyu Durdur"
        message={`"${server?.name || 'Sunucu'}" sunucusuna güvenli durdurma sinyali iletilecektir. Dünyalar ve oyuncu verileri kaydedilecektir.`}
        confirmText="Sunucuyu Durdur"
        cancelText="Vazgeç"
        variant="warning"
        onConfirm={() => {
          onStop();
          setConfirmStopOpen(false);
        }}
        onCancel={() => setConfirmStopOpen(false)}
      />

      {/* Zorla Kapat Onay Modalı */}
      <ConfirmModal
        isOpen={confirmKillOpen}
        title="Zorla Kapat"
        message={`"${server?.name || 'Sunucu'}" işlemi derhal ve zorla sonlandırılacaktır. Kaydedilmemiş veriler kaybolabilir. Emin misiniz?`}
        confirmText="Zorla Kapat"
        cancelText="Vazgeç"
        variant="danger"
        onConfirm={() => {
          onKill();
          setConfirmKillOpen(false);
        }}
        onCancel={() => setConfirmKillOpen(false)}
      />
    </div>
  );
};
