import React, { useState, useRef, useEffect, useId, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  desc?: string;
  badge?: {
    text: string;
    variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  };
  icon?: React.ComponentType<{ className?: string }>;
  statusIcon?: React.ComponentType<{ className?: string }>;
  statusTitle?: string;
  statusIconClassName?: string;
  disabled?: boolean;
  lineThrough?: boolean;
}

export interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  onChange,
  options,
  placeholder = 'Seçiniz...',
  className = '',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    openUpwards: boolean;
  }>({
    left: 0,
    width: 220,
    openUpwards: false,
  });

  const rawUniqueId = useId();
  const safeId = rawUniqueId.replace(/[^a-zA-Z0-9_-]/g, '');
  const listboxId = `custom-select-listbox-${safeId}`;
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionsListRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const updateCoords = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const padding = 8;

    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const isUp = spaceBelow < 280 && spaceAbove > spaceBelow;

    // Viewport-clamped width & left
    const minWidth = Math.min(220, viewportWidth - padding * 2);
    let width = Math.max(rect.width, minWidth);
    width = Math.min(width, viewportWidth - padding * 2);

    let left = rect.left;
    if (left + width > viewportWidth - padding) {
      left = viewportWidth - width - padding;
    }
    left = Math.max(padding, left);

    setCoords({
      top: isUp ? undefined : Math.round(rect.bottom + 6),
      bottom: isUp ? Math.round(viewportHeight - rect.top + 6) : undefined,
      left: Math.round(left),
      width: Math.round(width),
      openUpwards: isUp,
    });
  }, []);

  const toggleOpen = () => {
    if (disabled) return;
    if (!isOpen) {
      updateCoords();
      setSearchQuery('');
    }
    setIsOpen(!isOpen);
  };

  useEffect(() => {
    if (!isOpen) return;
    updateCoords();

    const handleScrollOrResize = () => {
      updateCoords();
    };

    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [isOpen, updateCoords]);

  const filteredOptions = options.filter((opt) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      opt.label.toLowerCase().includes(q) ||
      (opt.desc && opt.desc.toLowerCase().includes(q)) ||
      (opt.badge?.text && opt.badge.text.toLowerCase().includes(q)) ||
      (opt.statusTitle && opt.statusTitle.toLowerCase().includes(q)) ||
      opt.value.toLowerCase().includes(q)
    );
  });

  // Keep highlighted index in sync when opening or filtering
  useEffect(() => {
    if (isOpen) {
      const selectedIdx = filteredOptions.findIndex((opt) => opt.value === value);
      setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0);
    } else {
      setHighlightedIndex(-1);
    }
  }, [isOpen, searchQuery, value, filteredOptions.length]);

  // Focus search input or scroll selected option into view when opened
  useEffect(() => {
    if (!isOpen) return;

    if (options.length > 5) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, options.length]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (isOpen && highlightedIndex >= 0 && itemRefs.current[highlightedIndex]) {
      itemRefs.current[highlightedIndex]?.scrollIntoView({
        block: 'nearest',
      });
    }
  }, [isOpen, highlightedIndex]);

  // Outside click detection including portal
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscapeCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setIsOpen(false);
        triggerBtnRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscapeCapture, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscapeCapture, true);
    };
  }, [isOpen]);

  const selectOptionByIndex = (idx: number) => {
    if (idx >= 0 && idx < filteredOptions.length) {
      const opt = filteredOptions[idx];
      if (opt.disabled) return;
      onChange(opt.value);
      setIsOpen(false);
      triggerBtnRef.current?.focus();
    }
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        updateCoords();
        setSearchQuery('');
        setIsOpen(true);
      } else {
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setHighlightedIndex((prev) => {
          const next = prev + delta;
          if (next < 0) return filteredOptions.length - 1;
          if (next >= filteredOptions.length) return 0;
          return next;
        });
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isOpen) {
        updateCoords();
        setSearchQuery('');
        setIsOpen(true);
      } else if (highlightedIndex >= 0) {
        const opt = filteredOptions[highlightedIndex];
        if (!opt?.disabled) {
          selectOptionByIndex(highlightedIndex);
        }
      }
    } else if (e.key === 'Escape') {
      if (isOpen) {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent?.stopImmediatePropagation();
        setIsOpen(false);
        triggerBtnRef.current?.focus();
      }
      // When closed, do not preventDefault or stopPropagation; allow parent dialog to handle Escape
    }
  };

  const handleDropdownKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const isFromInput = e.target === searchInputRef.current;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1 >= filteredOptions.length ? 0 : prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 < 0 ? filteredOptions.length - 1 : prev - 1));
    } else if (e.key === 'Home') {
      if (isFromInput) {
        // Preserve native text cursor navigation inside search input
        return;
      }
      e.preventDefault();
      setHighlightedIndex(0);
    } else if (e.key === 'End') {
      if (isFromInput) {
        // Preserve native text cursor navigation inside search input
        return;
      }
      e.preventDefault();
      setHighlightedIndex(filteredOptions.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0) {
        const opt = filteredOptions[highlightedIndex];
        if (!opt?.disabled) {
          selectOptionByIndex(highlightedIndex);
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent?.stopImmediatePropagation();
      setIsOpen(false);
      triggerBtnRef.current?.focus();
    } else if (e.key === 'Tab') {
      setIsOpen(false);
    }
  };

  const selectedOption = options.find((opt) => opt.value === value);

  return (
    <div ref={containerRef} className={`relative select-none ${className}`}>
      {/* Trigger Button with full ARIA combobox pattern */}
      <button
        ref={triggerBtnRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={
          isOpen && highlightedIndex >= 0 ? `${listboxId}-opt-${highlightedIndex}` : undefined
        }
        disabled={disabled}
        onClick={toggleOpen}
        onKeyDown={handleTriggerKeyDown}
        className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-2xl bg-zinc-900 border text-xs text-white transition-all text-left disabled:opacity-40 disabled:cursor-not-allowed ${
          isOpen ? 'border-white/40 ring-1 ring-white/20' : 'border-white/15 hover:border-white/25'
        }`}
        style={{
          isolation: 'isolate',
          transform: 'translateZ(0)',
          WebkitBackfaceVisibility: 'hidden',
          backfaceVisibility: 'hidden',
        }}
      >
        <span className="min-w-0 flex items-center overflow-hidden flex-1">
          <span className="min-w-0 flex items-center gap-2 overflow-hidden w-full">
            {selectedOption ? (
              <>
                {selectedOption.icon && (
                  <selectedOption.icon className="w-3.5 h-3.5 text-silver-300 shrink-0" />
                )}
                {/* Primary label always prioritized and full width without artificial truncation */}
                <span
                  className={`font-medium truncate ${
                    selectedOption.lineThrough ? 'line-through text-silver-400' : 'text-white'
                  }`}
                >
                  {selectedOption.label}
                </span>
                {selectedOption.statusIcon && (
                  <span title={selectedOption.statusTitle} className="inline-flex items-center shrink-0">
                    <selectedOption.statusIcon
                      className={selectedOption.statusIconClassName || 'w-3.5 h-3.5 text-silver-400 shrink-0'}
                    />
                  </span>
                )}
                {/* Concise description separated and secondary */}
                {selectedOption.desc && (
                  <span className="text-silver-400 font-sans text-xs truncate min-w-0">
                    • {selectedOption.desc}
                  </span>
                )}
              </>
            ) : (
              <span className="text-silver-500 truncate">{placeholder}</span>
            )}
          </span>
        </span>

        <ChevronDown
          className={`w-3.5 h-3.5 text-silver-400 shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-180 text-white' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {/* Dropdown Menu via React Portal: Never clipped by parent cards or overflow-hidden */}
      {typeof document !== 'undefined' &&
        isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            role="listbox"
            id={listboxId}
            tabIndex={-1}
            onKeyDown={handleDropdownKeyDown}
            style={{
              position: 'fixed',
              top: coords.top !== undefined ? `${coords.top}px` : 'auto',
              bottom: coords.bottom !== undefined ? `${coords.bottom}px` : 'auto',
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              zIndex: 99999,
              isolation: 'isolate',
            }}
            className="rounded-2xl bg-[#121316] border border-white/20 shadow-[0_25px_60px_rgba(0,0,0,0.98)] p-1.5 flex flex-col gap-1 ring-1 ring-white/15"
          >
            {/* Search Input for Long Lists */}
            {options.length > 5 && (
              <div className="p-1 pb-1.5 border-b border-white/10 relative">
                <Search
                  className="w-3.5 h-3.5 text-silver-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filtrele veya ara..."
                  aria-label="Seçenekleri ara"
                  className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-silver-500 focus:outline-none focus:border-white/30 font-sans transition-all"
                />
              </div>
            )}

            {/* Options List */}
            <div
              ref={optionsListRef}
              className="max-h-56 overflow-y-auto flex flex-col gap-0.5 pr-0.5 overscroll-contain"
            >
              {filteredOptions.length === 0 ? (
                <div className="p-3 text-center text-xs text-silver-400 font-sans">
                  Eşleşen seçenek bulunamadı.
                </div>
              ) : (
                filteredOptions.map((option, idx) => {
                  const isSelected = option.value === value;
                  const isHighlighted = idx === highlightedIndex;
                  const Icon = option.icon;

                  return (
                    <div
                      key={option.value}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      id={`${listboxId}-opt-${idx}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={option.disabled}
                      onClick={() => {
                        if (option.disabled) return;
                        selectOptionByIndex(idx);
                      }}
                      onMouseEnter={() => {
                        if (!option.disabled) {
                          setHighlightedIndex(idx);
                        }
                      }}
                      title={option.disabled ? `${option.label} (Geçersiz: Java 25 altı sürümler desteklenmez)` : option.statusTitle}
                      className={`relative w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-xs text-left select-none transition-colors duration-100 ${
                        option.disabled
                          ? 'opacity-40 cursor-not-allowed text-silver-500'
                          : isSelected
                          ? 'bg-white/15 text-white font-semibold cursor-pointer'
                          : isHighlighted
                          ? 'bg-white/10 text-white cursor-pointer'
                          : 'text-silver-300 hover:text-white hover:bg-white/5 cursor-pointer'
                      }`}
                    >
                      <div className="relative z-10 flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                        {Icon && (
                          <Icon className="w-3.5 h-3.5 shrink-0 text-silver-400" aria-hidden="true" />
                        )}
                        {/* Primary label with full width without artificial truncation */}
                        <span
                          className={`truncate font-medium ${
                            option.lineThrough || (option.disabled && !isSelected)
                              ? 'line-through text-silver-500'
                              : 'text-white'
                          }`}
                        >
                          {option.label}
                        </span>
                        {/* Status Icon (Kurulu / İndirilebilir) between label and badges */}
                        {option.statusIcon && (
                          <span
                            title={option.statusTitle}
                            className="inline-flex items-center shrink-0 cursor-help"
                          >
                            <option.statusIcon
                              className={option.statusIconClassName || 'w-3.5 h-3.5 text-silver-400 shrink-0'}
                              aria-hidden="true"
                            />
                          </span>
                        )}
                        {/* Concise secondary desc truncated cleanly */}
                        {option.desc && (
                          <span className="text-silver-400 text-xs font-sans truncate min-w-0">
                            • {option.desc}
                          </span>
                        )}
                      </div>

                      {/* Right side: Badge aligned to far right + Selection check */}
                      <div className="relative z-10 flex items-center gap-2 shrink-0 ml-auto">
                        {option.badge && (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono tracking-tight shrink-0 ${
                              option.badge.variant === 'success'
                                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25'
                                : option.badge.variant === 'warning'
                                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                                : option.badge.variant === 'danger'
                                ? 'bg-rose-500/15 text-rose-300 border border-rose-500/25'
                                : option.badge.variant === 'info'
                                ? 'bg-sky-500/15 text-sky-300 border border-sky-500/25'
                                : 'bg-white/10 text-silver-300 border border-white/10'
                            }`}
                          >
                            {option.badge.text}
                          </span>
                        )}

                        {isSelected && (
                          <Check className="w-3.5 h-3.5 text-white shrink-0 ml-1" aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
