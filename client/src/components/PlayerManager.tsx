import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Users, 
  ShieldCheck, 
  UserCheck,
  UserX, 
  Ban, 
  MessageSquare, 
  Search,
  Signal,
  Clock,
  X,
  Crown,
  Check
} from 'lucide-react';
import { Player } from '../types';
import { Tooltip } from './Tooltip';

interface PlayerManagerProps {
  players: Player[];
  onKick: (username: string, reason?: string) => void;
  onBan: (username: string, reason?: string) => void;
  onToggleOp: (username: string) => void;
  onToggleWhitelist: (username: string) => void;
  onSendCommand: (cmd: string) => void;
}

export const PlayerManager: React.FC<PlayerManagerProps> = ({
  players,
  onKick,
  onBan,
  onToggleOp,
  onToggleWhitelist,
  onSendCommand,
}) => {
  const [search, setSearch] = useState('');
  const [selectedWhisperPlayer, setSelectedWhisperPlayer] = useState<Player | null>(null);
  const [whisperText, setWhisperText] = useState('');
  
  // Close whisper on ESC
  useEffect(() => {
    if (!selectedWhisperPlayer) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedWhisperPlayer(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedWhisperPlayer]);
  
  // Kick & Ban Modal state
  const [actionModal, setActionModal] = useState<{
    type: 'kick' | 'ban';
    player: Player;
    reason: string;
  } | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Close action modal on ESC
  useEffect(() => {
    if (!actionModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActionModal(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [actionModal]);

  const filteredPlayers = players.filter((p) =>
    p.username.toLowerCase().includes(search.toLowerCase()) ||
    p.uuid.toLowerCase().includes(search.toLowerCase())
  );

  const handleWhisper = (username: string) => {
    if (!whisperText.trim()) return;
    onSendCommand(`/tell ${username} ${whisperText}`);
    setWhisperText('');
    setSelectedWhisperPlayer(null);
  };

  const handleConfirmAction = () => {
    if (!actionModal) return;
    const cleanReason = actionModal.reason.trim();
    if (actionModal.type === 'kick') {
      onKick(actionModal.player.username, cleanReason || undefined);
    } else {
      onBan(actionModal.player.username, cleanReason || undefined);
    }
    setActionModal(null);
  };

  return (
    <div className="rounded-3xl bg-zinc-950/90 border border-white/10 p-5 flex flex-col shadow-xl shadow-black/40 h-full min-h-[540px]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-2xl bg-white/5 border border-white/10 text-white">
            <Users className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white tracking-wide">Çevrimiçi Oyuncular</h3>
            <p className="text-[11px] text-silver-400 font-sans">Toplam {players.length} oyuncu bağlı</p>
          </div>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-silver-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Oyuncu ara..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-xs rounded-full glass-input bg-zinc-900 border border-white/10 text-white placeholder-silver-500 focus:outline-none focus:border-white/30 w-36 font-mono transition-all"
          />
        </div>
      </div>

      {/* Player List */}
      <div className="flex-1 overflow-y-auto py-3 space-y-2 pr-1 flex flex-col">
        {filteredPlayers.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 min-h-[320px] text-silver-500 font-mono gap-3 text-center my-auto">
            <div className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/10 text-silver-400">
              <Users className="w-8 h-8 opacity-60 text-silver-300" />
            </div>
            <p className="text-xs text-silver-400">
              {search.trim() ? 'Aramayla eşleşen oyuncu bulunamadı.' : 'Şu anda bağlı oyuncu bulunmuyor.'}
            </p>
          </div>
        ) : (
          filteredPlayers.map((player) => (
              <div
                key={player.username}
                className="p-3.5 rounded-2xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 hover:border-white/20 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
              >
                {/* Player Info */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-zinc-900 border border-white/15 overflow-hidden shrink-0 flex items-center justify-center">
                    <img
                      src={player.avatarUrl || `https://mc-heads.net/avatar/${encodeURIComponent(player.username)}/64`}
                      alt={player.username}
                      loading="lazy"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                        const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                        if (fallback) fallback.style.display = 'flex';
                      }}
                    />
                    <span className="hidden font-mono font-bold text-xs text-white items-center justify-center">
                      {player.username.slice(0, 2).toUpperCase()}
                    </span>
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white font-mono truncate">{player.username}</span>
                      {player.isOp && (
                        <span className="px-1.5 py-0.5 rounded-full bg-white/20 text-[9px] font-mono text-white border border-white/25">
                          OP
                        </span>
                      )}
                      {player.isWhitelisted && (
                        <span className="px-1.5 py-0.5 rounded-full bg-white/10 text-[9px] font-mono text-silver-300 border border-white/15">
                          WL
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-silver-500 font-mono mt-0.5">
                      <Signal className="w-3 h-3 text-silver-400 shrink-0" />
                      <span className="whitespace-nowrap tabular-nums" title={`Gecikme: ${player.ping} ms`}>
                        {player.ping <= 1 ? '<1 ms' : `${Math.round(player.ping)} ms`}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  <Tooltip content="Fısılda">
                    <button
                      onClick={() => setSelectedWhisperPlayer(player)}
                      className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white transition-colors"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>

                  <Tooltip content={player.isOp ? 'OP Yetkisini Kaldır' : 'OP Yetkisi Ver'}>
                    <button
                      onClick={() => onToggleOp(player.username)}
                      className={`p-1.5 rounded-xl transition-colors ${
                        player.isOp
                          ? 'bg-white text-black shadow-sm'
                          : 'bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white'
                      }`}
                    >
                      <Crown className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>

                  <Tooltip content={player.isWhitelisted ? 'Beyaz Listeden Çıkar' : 'Beyaz Listeye Ekle'}>
                    <button
                      onClick={() => onToggleWhitelist(player.username)}
                      className={`p-1.5 rounded-xl transition-colors ${
                        player.isWhitelisted
                          ? 'bg-white/20 text-white border border-white/20'
                          : 'bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white'
                      }`}
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>

                  <Tooltip content="Sunucudan At">
                    <button
                      type="button"
                      onClick={() => setActionModal({ type: 'kick', player, reason: '' })}
                      className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-silver-400 hover:text-white transition-colors cursor-pointer"
                    >
                      <UserX className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>

                  <Tooltip content="Yasakla">
                    <button
                      type="button"
                      onClick={() => setActionModal({ type: 'ban', player, reason: '' })}
                      className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-rose-400 hover:text-rose-300 transition-colors cursor-pointer"
                    >
                      <Ban className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                </div>
              </div>
          ))
        )}
      </div>

      {/* Whisper Input Popup */}
      <AnimatePresence>
        {selectedWhisperPlayer && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="mt-3 p-3 rounded-2xl bg-white/5 border border-white/10 flex items-center gap-2"
          >
            <div className="text-[11px] font-mono text-silver-400 shrink-0">
              /{selectedWhisperPlayer.username}:
            </div>
            <input
              type="text"
              autoFocus
              value={whisperText}
              onChange={(e) => setWhisperText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleWhisper(selectedWhisperPlayer.username)}
              placeholder="Özel mesaj yazın..."
              className="flex-1 bg-transparent text-xs text-white placeholder-silver-500 focus:outline-none font-mono"
            />
            <button
              onClick={() => handleWhisper(selectedWhisperPlayer.username)}
              className="px-3 py-1 rounded-xl bg-white text-black font-semibold text-xs"
            >
              Gönder
            </button>
            <button
              onClick={() => setSelectedWhisperPlayer(null)}
              className="p-1 rounded-lg text-silver-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Kick & Ban Reason Confirmation Modal */}
      {mounted && typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {actionModal && (
            <div
              onClick={(e) => {
                if (e.target === e.currentTarget) setActionModal(null);
              }}
              className="fixed inset-0 z-[9999] flex items-center justify-center p-4 pointer-events-auto"
            >
              {/* Backdrop Blur Overlay */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                onClick={() => setActionModal(null)}
                className="fixed inset-0 bg-black/60 backdrop-blur-md"
                aria-hidden="true"
              />

              {/* Dialog Container */}
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
                className={`relative w-full max-w-md rounded-3xl bg-zinc-950 border shadow-[0_25px_70px_rgba(0,0,0,0.95)] p-6 z-10 backdrop-blur-2xl pointer-events-auto ${
                  actionModal.type === 'ban' ? 'border-rose-500/30 ring-1 ring-rose-500/20' : 'border-white/15'
                }`}
              >
                {/* Close Button */}
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  className="absolute top-5 right-5 p-2 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  aria-label="Kapat"
                >
                  <X className="w-4 h-4" />
                </button>

                {/* Header with Icon and Title */}
                <div className="flex items-start gap-4">
                  <div className={`p-3 rounded-2xl shrink-0 border ${
                    actionModal.type === 'ban'
                      ? 'bg-rose-500/15 border-rose-500/30 text-rose-400'
                      : 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                  }`}>
                    {actionModal.type === 'ban' ? (
                      <Ban className="w-5 h-5 text-rose-400" />
                    ) : (
                      <UserX className="w-5 h-5 text-amber-300" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0 pr-6">
                    <h3 className="text-base font-bold text-white tracking-wide leading-snug">
                      {actionModal.type === 'ban' ? 'Oyuncuyu Kalıcı Olarak Yasakla' : 'Oyuncuyu Sunucudan At'}
                    </h3>
                    <p className="text-xs text-silver-400 mt-1.5 leading-relaxed font-sans">
                      {actionModal.type === 'ban'
                        ? `"${actionModal.player.username}" adlı oyuncuyu sunucudan kalıcı olarak yasaklamak istediğinize emin misiniz?`
                        : `"${actionModal.player.username}" oyuncusunu sunucudan atmak istediğinize emin misiniz?`}
                    </p>
                  </div>
                </div>

                {/* Optional Reason Input */}
                <div className="mt-4">
                  <label className="block text-[11px] font-medium text-silver-400 mb-1.5">
                    Sebep
                  </label>
                  <input
                    type="text"
                    autoFocus
                    maxLength={200}
                    value={actionModal.reason}
                    onChange={(e) => setActionModal({ ...actionModal, reason: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleConfirmAction();
                      }
                    }}
                    placeholder="Sebep (isteğe bağlı)"
                    className={`w-full px-4 py-2.5 rounded-2xl bg-zinc-900/90 border text-xs text-white placeholder-silver-500 focus:outline-none font-sans transition-all shadow-inner ${
                      actionModal.type === 'ban'
                        ? 'border-white/15 focus:border-rose-500/60 focus:ring-1 focus:ring-rose-500/40'
                        : 'border-white/15 focus:border-white/35'
                    }`}
                  />
                  <div className="text-[10px] text-silver-500 font-mono mt-1 text-right">
                    {actionModal.reason.length}/200
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center justify-end gap-2.5 mt-5 pt-4 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setActionModal(null)}
                    className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all cursor-pointer shrink-0"
                  >
                    Vazgeç
                  </button>

                  <button
                    type="button"
                    onClick={handleConfirmAction}
                    className={`px-5 py-2 rounded-2xl text-xs font-semibold transition-all active:scale-95 cursor-pointer shrink-0 ${
                      actionModal.type === 'ban'
                        ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-[0_0_20px_rgba(244,63,94,0.4)] border border-rose-500/50'
                        : 'bg-white hover:bg-silver-200 text-black shadow-md'
                    }`}
                  >
                    {actionModal.type === 'ban' ? 'Yasakla' : 'Oyuncuyu At'}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
};
