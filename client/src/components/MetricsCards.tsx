import React from 'react';
import { motion } from 'framer-motion';
import { Cpu, MemoryStick, Users, Gauge, Clock, Radio } from 'lucide-react';
import { ServerMetrics } from '../types';
import { formatRam } from '../utils/format';

interface MetricsCardsProps {
  metrics: ServerMetrics;
}

export const MetricsCards: React.FC<MetricsCardsProps> = ({ metrics }) => {
  const isOnline = metrics.status === 'online';
  const memMB = metrics.memoryMB || Math.round((metrics.ramUsed || 0) * 1024);
  const allocMB = Math.max(512, Math.round((metrics.ramMax || 2) * 1024));
  const ramPercent = Math.min(100, Math.round((memMB / allocMB) * 100));
  const playersPercent = Math.min(100, Math.round((metrics.onlinePlayers / (metrics.maxPlayers || 1)) * 100));

  const maxRamFormatted = formatRam(metrics.allocatedRam || metrics.ramMax);

  const cards = [
    {
      title: 'İşlemci',
      value: isOnline ? `${metrics.cpu}%` : '0%',
      subtitle: isOnline ? (metrics.cpu > 0 ? `${metrics.cpu}% Aktif Yük` : 'Boşta') : 'Durduruldu',
      icon: Cpu,
      percent: isOnline ? metrics.cpu : 0,
      bar: true,
    },
    {
      title: 'Bellek',
      value: isOnline ? `${memMB} MB` : '0 MB',
      subtitle: isOnline ? `Maks. ${maxRamFormatted}` : 'Kapalı',
      icon: MemoryStick,
      percent: isOnline ? ramPercent : 0,
      bar: true,
    },
    {
      title: 'TPS & Gecikme',
      value: isOnline ? metrics.tps.toFixed(1) : '0.0',
      subtitle: isOnline ? (metrics.ping <= 2 ? '< 1 ms (Yerel Ağ)' : `${metrics.ping} ms Gecikme`) : 'Çevrimdışı',
      icon: Gauge,
      percent: isOnline ? (metrics.tps / 20) * 100 : 0,
      bar: true,
    },
    {
      title: 'Oyuncular',
      value: `${metrics.onlinePlayers} / ${metrics.maxPlayers}`,
      subtitle: isOnline ? 'Aktif Oturum' : 'Sunucu Kapalı',
      icon: Users,
      percent: playersPercent,
      bar: true,
    },
    {
      title: 'Çalışma Süresi',
      value: metrics.uptime,
      subtitle: isOnline ? 'Kesintisiz Çalışma' : 'Başlatılmadı',
      icon: Clock,
      bar: false,
    },
    {
      title: 'Port',
      value: `${metrics.port}`,
      subtitle: isOnline ? 'Varsayılan Bağlantı' : 'Kapalı',
      icon: Radio,
      bar: false,
      isAddress: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 w-full">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.title}
            className="p-5 rounded-3xl glass-panel bg-white/[0.02] border border-white/10 hover:border-white/20 transition-all duration-300 flex flex-col justify-between group shadow-xl min-w-0"
          >
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <span className="text-[11px] font-semibold text-silver-400 uppercase tracking-wider truncate">
                {card.title}
              </span>
              <div className="p-2 rounded-xl bg-white/5 border border-white/10 text-silver-300 group-hover:text-white group-hover:bg-white/10 transition-colors shrink-0">
                <Icon className="w-3.5 h-3.5" />
              </div>
            </div>

            <div className="my-1 min-w-0">
              <div 
                className={`font-bold font-mono tracking-tight text-white group-hover:text-silver-100 truncate ${
                  card.isAddress ? 'text-base sm:text-lg' : 'text-xl'
                }`}
              >
                {card.value}
              </div>
              <div className="text-[11px] text-silver-500 font-mono mt-1 truncate whitespace-nowrap tabular-nums">
                {card.subtitle}
              </div>
            </div>

            {card.bar ? (
              <div className="mt-3.5">
                <div className="w-full bg-white/5 rounded-full h-1.5 overflow-hidden border border-white/5">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-silver-400 to-white shadow-[0_0_8px_rgba(255,255,255,0.4)]"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(100, Math.max(0, card.percent ?? 0))}%` }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                  />
                </div>
              </div>
            ) : (
              <div className="mt-3.5 h-1.5" />
            )}
          </div>
        );
      })}
    </div>
  );
};
