import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import './SmoothEditor.css';

export interface SmoothEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  fileName?: string;
  readOnly?: boolean;
  className?: string;
}

interface DeletedAnimItem {
  id: number;
  text: string;
  x: number;
  y: number;
}

interface InsertAnimRange {
  from: number;
  to: number;
  expiresAt: number;
}

const LINE_HEIGHT = 20; // px
const FONT_SIZE = 12; // px
const PADDING_TOP = 12; // px
const PADDING_LEFT = 12; // px
const FONT_FAMILY = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";

export const SmoothEditor: React.FC<SmoothEditorProps> = ({
  value,
  onChange,
  onSave,
  fileName = 'file.txt',
  readOnly = false,
  className = '',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const docCaretCoords = useRef<{ x: number; y: number }>({ x: PADDING_LEFT, y: PADDING_TOP });
  const scrollRafId = useRef<number | null>(null);

  const [charWidth, setCharWidth] = useState<number>(7.2);
  const [caretPos, setCaretPos] = useState<{ x: number; y: number; visible: boolean }>({
    x: PADDING_LEFT,
    y: PADDING_TOP,
    visible: false,
  });
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [isFocused, setIsFocused] = useState<boolean>(false);

  // Floating Inline Search State (Ctrl+F)
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);

  // Animation tracking
  const [animRange, setAnimRange] = useState<InsertAnimRange | null>(null);
  const [deletedItems, setDeletedItems] = useState<DeletedAnimItem[]>([]);
  const prevValueRef = useRef<string>(value);
  const isInitialMount = useRef<boolean>(true);
  const typingTimer = useRef<any>(null);
  const animCleanTimer = useRef<any>(null);
  const deleteIdCounter = useRef<number>(0);

  // Measure monospace character width exactly
  useEffect(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
      const measured = ctx.measureText('M').width;
      if (measured > 0) {
        setCharWidth(measured);
      }
    }
  }, []);

  // Compute lines and total line count
  const lines = useMemo(() => value.split('\n'), [value]);
  const lineCount = lines.length;

  // Memoized linear line-offset calculation (O(N) instead of quadratic)
  const lineStarts = useMemo(() => {
    const starts = new Int32Array(lines.length);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      starts[i] = offset;
      offset += lines[i].length + 1; // +1 for newline character
    }
    return starts;
  }, [lines]);

  // Calculate coordinates (x, y) for a string index
  const calculateCaretCoords = useCallback(
    (index: number, textVal: string) => {
      const safeIndex = Math.max(0, Math.min(index, textVal.length));
      const textBefore = textVal.slice(0, safeIndex);
      const splitLines = textBefore.split('\n');
      const lineIdx = splitLines.length - 1;
      const currentLineText = splitLines[lineIdx];

      // Expand tabs to 2 spaces for column index
      let colIdx = 0;
      for (let i = 0; i < currentLineText.length; i++) {
        if (currentLineText[i] === '\t') {
          colIdx += 2;
        } else {
          colIdx += 1;
        }
      }

      const x = PADDING_LEFT + colIdx * charWidth;
      const y = PADDING_TOP + lineIdx * LINE_HEIGHT;
      return { x, y, lineIdx, colIdx };
    },
    [charWidth]
  );

  // Update caret position from textarea selection
  const updateCaret = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;

    const selStart = ta.selectionStart;
    const { x, y } = calculateCaretCoords(selStart, ta.value);
    docCaretCoords.current = { x, y };

    const cx = x - ta.scrollLeft;
    const cy = y - ta.scrollTop;

    setCaretPos({
      x: cx,
      y: cy,
      visible: true,
    });

    if (caretRef.current) {
      caretRef.current.style.transform = `translate(${cx}px, ${cy + 1}px)`;
    }
  }, [calculateCaretCoords]);

  // Compute search matches across document
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const matches: { from: number; to: number; lineIdx: number }[] = [];
    const q = searchQuery.toLowerCase();
    const lowerVal = value.toLowerCase();
    let pos = 0;
    while ((pos = lowerVal.indexOf(q, pos)) !== -1) {
      const lineIdx = value.slice(0, pos).split('\n').length - 1;
      matches.push({ from: pos, to: pos + q.length, lineIdx });
      pos += Math.max(1, q.length);
    }
    return matches;
  }, [value, searchQuery]);

  // Adjust match index bounds
  useEffect(() => {
    if (searchMatches.length === 0) {
      setCurrentMatchIndex(0);
    } else if (currentMatchIndex >= searchMatches.length) {
      setCurrentMatchIndex(0);
    }
  }, [searchMatches.length, currentMatchIndex]);

  const scrollToMatch = useCallback(
    (matchIdx: number) => {
      const match = searchMatches[matchIdx];
      if (!match || !textareaRef.current) return;
      const ta = textareaRef.current;
      ta.focus();
      ta.setSelectionRange(match.from, match.to);

      const targetTop = Math.max(0, match.lineIdx * LINE_HEIGHT - 60);

      const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (prefersReducedMotion) {
        ta.scrollTop = targetTop;
        if (gutterRef.current) gutterRef.current.scrollTop = targetTop;
        if (mirrorRef.current) mirrorRef.current.scrollTop = targetTop;
      } else {
        ta.scrollTo({ top: targetTop, behavior: 'smooth' });
      }

      updateCaret();
    },
    [searchMatches, updateCaret]
  );

  const goToNextMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const nextIdx = (currentMatchIndex + 1) % searchMatches.length;
    setCurrentMatchIndex(nextIdx);
    scrollToMatch(nextIdx);
  }, [searchMatches.length, currentMatchIndex, scrollToMatch]);

  const goToPrevMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const prevIdx = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    setCurrentMatchIndex(prevIdx);
    scrollToMatch(prevIdx);
  }, [searchMatches.length, currentMatchIndex, scrollToMatch]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 40);
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    textareaRef.current?.focus();
  }, []);

  // Intercept Ctrl+F and Esc globally within the editor container
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (containerRef.current && containerRef.current.contains(document.activeElement)) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          openSearch();
        } else if (e.key === 'Escape' && isSearchOpen) {
          e.preventDefault();
          closeSearch();
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isSearchOpen, openSearch, closeSearch]);

  // Handle typing change & detect animations
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextVal = e.target.value;
    const prevVal = prevValueRef.current;
    const selStart = e.target.selectionStart;

    // Check reduced motion preference
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!prefersReducedMotion && !isInitialMount.current) {
      const prevLen = prevVal.length;
      const nextLen = nextVal.length;
      const diff = nextLen - prevLen;

      // Character insertion (1 to 500 characters)
      if (diff > 0 && diff <= 500) {
        const insertStart = selStart - diff;
        if (insertStart >= 0) {
          setAnimRange({
            from: insertStart,
            to: selStart,
            expiresAt: Date.now() + 200,
          });
          if (animCleanTimer.current) clearTimeout(animCleanTimer.current);
          animCleanTimer.current = setTimeout(() => {
            setAnimRange(null);
          }, 220);
        }
      } else if (diff < 0 && Math.abs(diff) <= 40) {
        // Character deletion animation (single or few characters)
        const deletedLen = Math.abs(diff);
        const deletedStart = selStart;
        const deletedText = prevVal.slice(deletedStart, deletedStart + deletedLen);

        if (!deletedText.includes('\n')) {
          const { x, y } = calculateCaretCoords(deletedStart, prevVal);
          const ta = textareaRef.current;
          const scrollL = ta ? ta.scrollLeft : 0;
          const scrollT = ta ? ta.scrollTop : 0;

          const item: DeletedAnimItem = {
            id: ++deleteIdCounter.current,
            text: deletedText,
            x: x - scrollL,
            y: y - scrollT,
          };

          setDeletedItems((prev) => [...prev.slice(-10), item]);
          setTimeout(() => {
            setDeletedItems((prev) => prev.filter((i) => i.id !== item.id));
          }, 200);
        }
      }
    }

    prevValueRef.current = nextVal;
    onChange(nextVal);

    // Active typing caret state
    setIsTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      setIsTyping(false);
    }, 380);

    // Synchronize caret after DOM update
    requestAnimationFrame(() => {
      updateCaret();
    });
  };

  // Keyboard navigation & Shortcuts (Tab, Ctrl+S, Ctrl+F)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
      return;
    }

    if (e.key === 'Tab' && !readOnly) {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;

      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const current = ta.value;

      const nextVal = current.substring(0, start) + '  ' + current.substring(end);
      prevValueRef.current = nextVal;
      onChange(nextVal);

      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
        updateCaret();
      });
      return;
    }

    // Immediate caret update for arrow keys, backspace, enter
    requestAnimationFrame(() => {
      updateCaret();
    });
  };

  const syncScrollLayers = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const top = ta.scrollTop;
    const left = ta.scrollLeft;

    if (gutterRef.current && gutterRef.current.scrollTop !== top) {
      gutterRef.current.scrollTop = top;
    }
    if (mirrorRef.current) {
      if (mirrorRef.current.scrollTop !== top) mirrorRef.current.scrollTop = top;
      if (mirrorRef.current.scrollLeft !== left) mirrorRef.current.scrollLeft = left;
    }

    if (caretRef.current) {
      const cx = docCaretCoords.current.x - left;
      const cy = docCaretCoords.current.y - top;
      caretRef.current.style.transform = `translate(${cx}px, ${cy + 1}px)`;
    }
  }, []);

  // Synchronize scrolling between textarea, mirror layer, and line numbers using rAF
  const handleScroll = useCallback(() => {
    if (scrollRafId.current !== null) {
      cancelAnimationFrame(scrollRafId.current);
    }
    scrollRafId.current = requestAnimationFrame(() => {
      scrollRafId.current = null;
      syncScrollLayers();
    });
  }, [syncScrollLayers]);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      prevValueRef.current = value;
    }
  }, [value]);

  // Clean timers and rAF on unmount
  useEffect(() => {
    return () => {
      if (scrollRafId.current !== null) cancelAnimationFrame(scrollRafId.current);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (animCleanTimer.current) clearTimeout(animCleanTimer.current);
    };
  }, []);

  // Simple, elegant monochrome token renderer with animation spans
  const renderLineContent = (lineText: string, lineGlobalStart: number) => {
    if (lineText.length === 0) {
      return '\n';
    }

    // If animRange is active and affects this line
    if (
      animRange &&
      animRange.from < lineGlobalStart + lineText.length &&
      animRange.to > lineGlobalStart
    ) {
      const parts: React.ReactNode[] = [];
      for (let i = 0; i < lineText.length; i++) {
        const globalIdx = lineGlobalStart + i;
        const char = lineText[i];
        if (globalIdx >= animRange.from && globalIdx < animRange.to) {
          parts.push(
            <span key={i} className="smooth-char-fade-in text-white font-medium">
              {char}
            </span>
          );
        } else {
          parts.push(char);
        }
      }
      return parts;
    }

    // Fast monochrome syntax highlighting with high contrast for JSON, YAML, Properties
    const trimmed = lineText.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('!')) {
      return <span className="text-zinc-500 italic">{lineText}</span>;
    }

    const colonIdx = lineText.indexOf(':');
    const eqIdx = lineText.indexOf('=');
    const splitIdx = colonIdx !== -1 ? colonIdx : eqIdx;

    if (splitIdx !== -1) {
      const keyPart = lineText.slice(0, splitIdx);
      const sep = lineText[splitIdx];
      const valPart = lineText.slice(splitIdx + 1);

      return (
        <>
          <span className="text-white font-bold">{keyPart}</span>
          <span className="text-zinc-500">{sep}</span>
          <span className="text-zinc-400 font-normal">{valPart}</span>
        </>
      );
    }

    return lineText;
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full flex flex-col bg-black/90 rounded-2xl border border-white/10 overflow-hidden font-mono text-xs select-text focus-within:border-white/30 transition-colors ${className}`}
      style={{ fontFamily: FONT_FAMILY }}
    >
      {/* Floating Inline Search Bar (Ctrl+F) */}
      <AnimatePresence>
        {isSearchOpen && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className="absolute top-3 right-4 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-zinc-950/95 border border-white/20 shadow-[0_10px_35px_rgba(0,0,0,0.85)] backdrop-blur-xl ring-1 ring-white/10"
          >
            <Search className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Bul (Ctrl+F)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (e.shiftKey) {
                    goToPrevMatch();
                  } else {
                    goToNextMatch();
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              className="w-28 sm:w-36 bg-transparent text-xs text-white placeholder-zinc-500 outline-none font-mono"
            />

            <span className="text-[11px] font-mono tabular-nums text-zinc-400 shrink-0 select-none px-1 border-l border-white/10">
              {searchMatches.length > 0
                ? `${currentMatchIndex + 1} / ${searchMatches.length}`
                : searchQuery.trim()
                ? '0 / 0'
                : '0 / 0'}
            </span>

            <div className="flex items-center gap-0.5 border-l border-white/10 pl-1">
              <button
                type="button"
                onClick={goToPrevMatch}
                title="Önceki (Shift+Enter)"
                className="p-1 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={goToNextMatch}
                title="Sonraki (Enter)"
                className="p-1 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={closeSearch}
                title="Kapat (Esc)"
                className="p-1 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer ml-0.5"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative flex-1 min-h-0 flex items-stretch overflow-hidden">
        {/* Left Column: Line Numbers Gutter */}
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="w-12 shrink-0 bg-white/[0.02] border-r border-white/10 text-zinc-500 text-right pr-3 py-3 select-none overflow-hidden font-mono text-xs"
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
        >
          {Array.from({ length: Math.max(1, lineCount) }).map((_, idx) => (
            <div key={idx} className="h-5 leading-5 tabular-nums">
              {idx + 1}
            </div>
          ))}
        </div>

        {/* Center: Main Editor Wrapper */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          {/* Layer 1: Mirror Layer with Fluid Typing & Syntax Highlighting */}
          <pre
            ref={mirrorRef}
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none p-3 overflow-hidden text-zinc-300 whitespace-pre font-mono text-xs z-0"
            style={{
              lineHeight: `${LINE_HEIGHT}px`,
              fontFamily: FONT_FAMILY,
              tabSize: 2,
              paddingTop: `${PADDING_TOP}px`,
              paddingLeft: `${PADDING_LEFT}px`,
            }}
          >
            {lines.map((line, lIdx) => (
              <div key={lIdx} className="h-5 leading-5">
                {renderLineContent(line, lineStarts[lIdx])}
              </div>
            ))}
          </pre>

          {/* Layer 2: Deleted Character Fade-out Animations */}
          {deletedItems.map((item) => (
            <div
              key={item.id}
              className="smooth-char-deleted"
              style={{
                left: `${item.x}px`,
                top: `${item.y}px`,
                lineHeight: `${LINE_HEIGHT}px`,
                fontSize: `${FONT_SIZE}px`,
                fontFamily: FONT_FAMILY,
              }}
            >
              {item.text}
            </div>
          ))}

          {/* Layer 3: Custom Smooth Caret (Office/Word Fluid Caret) */}
          {isFocused && !readOnly && caretPos.visible && (
            <div
              ref={caretRef}
              className={`absolute pointer-events-none z-20 w-[2px] bg-white rounded-full ${
                isTyping ? 'smooth-caret-active' : 'smooth-caret-active smooth-caret-blinking'
              }`}
              style={{
                height: '17px',
                transform: `translate(${caretPos.x}px, ${caretPos.y + 1}px)`,
                boxShadow: '0 0 8px rgba(255, 255, 255, 0.9), 0 0 2px #ffffff',
              }}
            />
          )}

          {/* Layer 4: Transparent Native Textarea (Full IME, Native Selection, Copy/Paste, Undo) */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onScroll={handleScroll}
            onFocus={() => {
              setIsFocused(true);
              updateCaret();
            }}
            onBlur={() => {
              setIsFocused(false);
            }}
            onClick={updateCaret}
            onKeyUp={updateCaret}
            readOnly={readOnly}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            wrap="off"
            className="smooth-editor-textarea absolute inset-0 w-full h-full p-3 overflow-auto font-mono text-xs z-10"
            style={{
              lineHeight: `${LINE_HEIGHT}px`,
              fontFamily: FONT_FAMILY,
              tabSize: 2,
              paddingTop: `${PADDING_TOP}px`,
              paddingLeft: `${PADDING_LEFT}px`,
            }}
          />
        </div>
      </div>
    </div>
  );
};
