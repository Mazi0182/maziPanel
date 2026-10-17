import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';
import { ToastMessage } from '../types';

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  // En fazla son 4 bildirim gösterilir, eskiler otomatik kayarak çıkar
  const visibleToasts = toasts.slice(-4);

  return (
    <div className="fixed bottom-6 right-6 z-[9500] flex flex-col gap-2.5 max-w-sm w-full pointer-events-none px-4 sm:px-0">
      <AnimatePresence mode="popLayout">
        {visibleToasts.map((toast) => {
          const Icon =
            toast.type === 'error'
              ? AlertCircle
              : toast.type === 'warning'
              ? AlertTriangle
              : toast.type === 'info'
              ? Info
              : CheckCircle2;

          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 20, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, y: -10, transition: { duration: 0.15 } }}
              transition={{
                layout: { duration: 0.2, ease: 'easeOut' },
                duration: 0.2,
                ease: 'easeOut'
              }}
              className="pointer-events-auto flex items-start gap-3 p-4 rounded-2xl glass-panel bg-zinc-950/95 border border-white/15 shadow-[0_15px_40px_rgba(0,0,0,0.8)] backdrop-blur-2xl"
            >
              <div className={`p-1.5 rounded-xl shrink-0 mt-0.5 ${
                toast.type === 'error'
                  ? 'bg-rose-500/20 text-rose-200 border border-rose-500/30'
                  : toast.type === 'warning'
                  ? 'bg-amber-500/20 text-amber-200 border border-amber-500/30'
                  : toast.type === 'info'
                  ? 'bg-white/10 text-white border border-white/20'
                  : 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/30'
              }`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-semibold text-white tracking-wide">{toast.title}</h4>
                {toast.description && (
                  <p className="text-xs text-silver-400 mt-0.5 leading-relaxed font-sans">{toast.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                className="text-silver-500 hover:text-white transition-colors p-1 -mr-1 rounded-lg hover:bg-white/5 cursor-pointer"
                aria-label="Kapat"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
