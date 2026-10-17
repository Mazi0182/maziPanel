import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

export interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  delay?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  position = 'top',
  className = '',
  delay = 120,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const calculateCoords = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const margin = 8;
    const screenWidth = typeof window !== 'undefined' ? window.innerWidth : 1000;

    // Estimate tooltip width if not yet measured
    const tooltipWidth = tooltipRef.current?.offsetWidth || Math.min(240, content.length * 7.5 + 24);
    const tooltipHeight = tooltipRef.current?.offsetHeight || 28;

    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    // Boundary clamp: keep at least 12px from both screen edges
    if (left < 12) left = 12;
    if (left + tooltipWidth > screenWidth - 12) {
      left = screenWidth - tooltipWidth - 12;
    }

    let top = rect.top - tooltipHeight - margin;
    // If not enough room on top, flip below the trigger
    if (top < 12 || position === 'bottom') {
      top = rect.bottom + margin;
    }

    setCoords({ top, left });
  };

  const show = () => {
    calculateCoords();
    timeoutRef.current = setTimeout(() => {
      calculateCoords();
      setIsVisible(true);
    }, delay);
  };

  const hide = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div
      ref={triggerRef}
      className={`inline-flex items-center ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {isVisible && content && (
              <motion.div
                ref={tooltipRef}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                style={{
                  position: 'fixed',
                  top: coords.top,
                  left: coords.left,
                  zIndex: 999999,
                }}
                className="pointer-events-none px-2.5 py-1 rounded-xl bg-[#09090b] border border-white/20 text-white text-[11px] font-sans whitespace-nowrap shadow-[0_10px_35px_rgba(0,0,0,0.98)] ring-1 ring-white/10"
              >
                {content}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </div>
  );
};

