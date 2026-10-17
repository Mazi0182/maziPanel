import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X, Trash2 } from 'lucide-react';
import { ServerInstance } from '../types';

export interface DeleteServerModalProps {
  isOpen: boolean;
  server: ServerInstance | null;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting?: boolean;
}

export const DeleteServerModal: React.FC<DeleteServerModalProps> = ({
  isOpen,
  server,
  onConfirm,
  onCancel,
  isDeleting = false,
}) => {
  const [mounted, setMounted] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');

  useEffect(() => {
    setMounted(true);
  }, []);

  // Modal kapandığında veya sunucu değiştiğinde inputu sıfırla
  useEffect(() => {
    if (isOpen) {
      setConfirmInput('');
    }
  }, [isOpen, server?.id]);

  // ESC tuşu ile kapatma
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isDeleting) {
        e.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel, isDeleting]);

  if (!mounted || !isOpen || !server) return null;

  const targetName = server.name.trim();
  const isMatch = confirmInput.trim() === targetName;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isMatch && !isDeleting) {
      onConfirm();
    }
  };

  const modalContent = (
    <AnimatePresence>
      {isOpen && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget && !isDeleting) onCancel();
          }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4 pointer-events-auto"
        >
          {/* Backdrop Blur Overlay with subtle red tint */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={() => {
              if (!isDeleting) onCancel();
            }}
            className="fixed inset-0 bg-black/60 backdrop-blur-md"
            aria-hidden="true"
          />

          {/* Dialog Container */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-server-title"
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg rounded-3xl bg-zinc-950 border-2 border-rose-500/40 shadow-[0_25px_80px_rgba(225,29,72,0.25)] p-6 z-10 backdrop-blur-2xl ring-1 ring-rose-500/20 pointer-events-auto"
          >
            {/* Top Close Button */}
            <button
              type="button"
              onClick={onCancel}
              disabled={isDeleting}
              className="absolute top-5 right-5 p-2 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40"
              aria-label="Kapat"
            >
              <X className="w-4 h-4" />
            </button>

            {/* Header: Alert Icon & Title */}
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-500 shrink-0 shadow-[0_0_15px_rgba(244,63,94,0.2)]">
                <AlertTriangle className="w-6 h-6" />
              </div>

              <div className="flex-1 min-w-0 pr-6">
                <div className="flex items-center gap-2">
                  <h3
                    id="delete-server-title"
                    className="text-base font-bold text-rose-400 tracking-wide"
                  >
                    Sunucuyu Kalıcı Olarak Sil
                  </h3>
                </div>
                <p className="text-xs text-silver-400 mt-1.5 leading-relaxed font-sans">
                  Bu işlem <strong className="text-white font-semibold">geri alınamaz</strong>. Seçilen sunucu, dünya verileri, yüklü eklentiler ve tüm yapılandırma dosyaları diskten kalıcı olarak silinecektir.
                </p>
              </div>
            </div>

            {/* Warning Details Box */}
            <div className="mt-5 p-3.5 rounded-2xl bg-rose-950/20 border border-rose-500/20">
              <div className="text-[11px] font-mono text-rose-300/90 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-silver-400 font-sans">Silinecek Sunucu:</span>
                  <span className="font-bold text-white truncate max-w-[240px]">{server.name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-silver-400 font-sans">Tip / Sürüm:</span>
                  <span className="text-silver-200">{server.type} {server.version}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-silver-400 font-sans">Port:</span>
                  <span className="text-silver-200">{server.port}</span>
                </div>
              </div>
            </div>

            {/* Form Confirmation by Typing Name */}
            <form onSubmit={handleSubmit} className="mt-5 space-y-3">
              <div>
                <label
                  htmlFor="confirm-server-name-input"
                  className="block text-xs text-silver-300 font-medium mb-1.5"
                >
                  Onaylamak için lütfen sunucu adını (<span className="font-mono text-white font-semibold select-all">{server.name}</span>) aşağıya yazın:
                </label>
                <input
                  id="confirm-server-name-input"
                  type="text"
                  autoFocus
                  disabled={isDeleting}
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder={server.name}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full px-4 py-2.5 rounded-2xl bg-zinc-900 border border-white/10 focus:border-rose-500/60 focus:ring-2 focus:ring-rose-500/20 text-xs font-mono text-white placeholder:text-zinc-600 outline-none transition-all"
                />
              </div>

              {/* Actions Footer */}
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={isDeleting}
                  className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all cursor-pointer disabled:opacity-40"
                >
                  Vazgeç
                </button>

                <button
                  type="submit"
                  disabled={!isMatch || isDeleting}
                  className="flex items-center gap-2 px-5 py-2 rounded-2xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-[0_0_20px_rgba(225,29,72,0.4)] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-rose-600 transition-all active:scale-95 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{isDeleting ? 'Siliniyor...' : 'Sunucuyu Kalıcı Olarak Sil'}</span>
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  return createPortal(modalContent, document.body);
};
