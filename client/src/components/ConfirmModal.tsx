import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Trash2, HelpCircle, X } from 'lucide-react';

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  saveAndProceedText?: string;
  variant?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
  onSaveAndProceed?: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmText = 'Onayla',
  cancelText = 'Vazgeç',
  saveAndProceedText = 'Kaydet ve Devam Et',
  variant = 'warning',
  onConfirm,
  onCancel,
  onSaveAndProceed,
}) => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // ESC key listener to close modal immediately
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  const getIcon = () => {
    switch (variant) {
      case 'danger':
        return <Trash2 className="w-5 h-5 text-white" />;
      case 'warning':
        return <AlertTriangle className="w-5 h-5 text-silver-200" />;
      case 'info':
      default:
        return <HelpCircle className="w-5 h-5 text-silver-300" />;
    }
  };

  const modalContent = (
    <AnimatePresence>
      {isOpen && (
        <div 
          onClick={(e) => {
            if (e.target === e.currentTarget) onCancel();
          }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4 pointer-events-auto"
        >
          {/* Backdrop Blur Overlay - Softened luxury glass */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={onCancel}
            className="fixed inset-0 bg-black/45 backdrop-blur-md"
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
            aria-labelledby="confirm-modal-title"
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg sm:max-w-xl rounded-3xl bg-zinc-950 border border-white/15 shadow-[0_25px_70px_rgba(0,0,0,0.95)] p-6 sm:p-7 z-10 backdrop-blur-2xl pointer-events-auto"
          >
            {/* Close Icon Button */}
            <button
              type="button"
              onClick={onCancel}
              className="absolute top-5 right-5 p-2 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors pointer-events-auto cursor-pointer"
              aria-label="Kapat"
            >
              <X className="w-4 h-4" />
            </button>

            {/* Header with Icon and Title */}
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-2xl bg-white/5 border border-white/10 shrink-0">
                {getIcon()}
              </div>

              <div className="flex-1 min-w-0 pr-6">
                <h3
                  id="confirm-modal-title"
                  className="text-base font-bold text-white tracking-wide leading-snug"
                >
                  {title}
                </h3>
                <p className="text-xs text-silver-400 mt-2 leading-relaxed font-sans">
                  {message}
                </p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap sm:flex-nowrap items-center justify-end gap-2.5 sm:gap-3 mt-6 pt-4 border-t border-white/10">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all pointer-events-auto cursor-pointer whitespace-nowrap shrink-0"
              >
                {cancelText}
              </button>

              <button
                type="button"
                onClick={() => {
                  onConfirm();
                }}
                className={`px-5 py-2 rounded-2xl text-xs font-semibold transition-all active:scale-95 pointer-events-auto cursor-pointer whitespace-nowrap shrink-0 ${
                  variant === 'danger'
                    ? 'bg-white hover:bg-silver-200 text-black shadow-[0_0_25px_rgba(255,255,255,0.4)] border border-white ring-1 ring-white/40'
                    : onSaveAndProceed
                    ? 'bg-white/10 hover:bg-white/20 text-silver-300 hover:text-white border border-white/15'
                    : 'bg-white/15 hover:bg-white/25 text-white border border-white/20 shadow-md'
                }`}
              >
                {confirmText}
              </button>

              {onSaveAndProceed && (
                <button
                  type="button"
                  onClick={onSaveAndProceed}
                  className="px-5 py-2 rounded-2xl text-xs font-semibold bg-white hover:bg-silver-200 text-black shadow-[0_0_25px_rgba(255,255,255,0.4)] border border-white ring-1 ring-white/40 transition-all active:scale-95 pointer-events-auto cursor-pointer whitespace-nowrap shrink-0"
                >
                  {saveAndProceedText}
                </button>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  if (!mounted || typeof document === 'undefined') {
    return null;
  }

  return createPortal(modalContent, document.body);
};
