import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  Terminal as TerminalIcon,
  Send,
  Trash2,
  ArrowDownCircle,
  Download,
  Search,
  Maximize2,
  Minimize2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle
} from 'lucide-react';
import Ansi from 'ansi-to-react';
import { LogEntry, ServerStatus } from '../types';
import { Tooltip } from './Tooltip';
import { ConfirmModal } from './ConfirmModal';
import { cleanJLineArtifacts } from '../utils/parseLog';
import './SmoothEditor.css';

interface TerminalProps {
  logs: LogEntry[];
  onSendCommand: (cmd: string) => void;
  onClear: () => void;
  serverStatus: ServerStatus;
  serverId?: string;
}

export const Terminal: React.FC<TerminalProps> = ({
  logs,
  onSendCommand,
  onClear,
  serverStatus,
  serverId,
}) => {
  const [inputCommand, setInputCommand] = useState('');

  // Real command history persisted in localStorage per serverId
  const historyStorageKey = serverId ? `mazipanel_cmd_history_${serverId}` : 'mazipanel_cmd_history';
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(historyStorageKey);
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterLevel, setFilterLevel] = useState<'ALL' | 'INFO' | 'WARN' | 'ERROR'>('ALL');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<string>('');
  const caretRef = useRef<HTMLDivElement>(null);

  // Smooth typing effect and fluid caret states
  const [charWidth, setCharWidth] = useState<number>(7.2);
  const [caretX, setCaretX] = useState<number>(32);
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [inputScrollLeft, setInputScrollLeft] = useState<number>(0);
  const [animRange, setAnimRange] = useState<{ from: number; to: number } | null>(null);
  const [deletedItems, setDeletedItems] = useState<{ id: number; text: string; x: number }[]>([]);

  const prevCommandRef = useRef<string>(inputCommand);
  const typingTimer = useRef<any>(null);
  const animCleanTimer = useRef<any>(null);
  const deleteIdCounter = useRef<number>(0);

  // Measure monospace character width exactly
  useEffect(() => {
    if (inputRef.current) {
      const computed = window.getComputedStyle(inputRef.current);
      const font = `${computed.fontSize} ${computed.fontFamily}`;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = font;
        const measured = ctx.measureText('M').width;
        if (measured > 0) {
          setCharWidth(measured);
        }
      }
    }
  }, []);

  const getPaddingLeft = useCallback(() => {
    if (inputRef.current) {
      const pl = parseFloat(window.getComputedStyle(inputRef.current).paddingLeft);
      if (!isNaN(pl) && pl > 0) return pl;
    }
    return 32;
  }, []);

  const updateCaret = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const selStart = el.selectionStart ?? el.value.length;
    const sLeft = el.scrollLeft;
    setInputScrollLeft(sLeft);
    const pl = getPaddingLeft();
    const x = pl + selStart * charWidth - sLeft;
    setCaretX(x);
  }, [charWidth, getPaddingLeft]);

  // Clean timers on unmount
  useEffect(() => {
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (animCleanTimer.current) clearTimeout(animCleanTimer.current);
    };
  }, []);

  // TİTREME / ÇİFT ANİMASYON ÇÖZÜMÜ:
  // İlk yüklemede veya sekme açıldığında var olan mevcut logların hiçbiri animasyon oynatmamalı.
  // Sadece mount ve ilk veri geldikten sonra tekil eklenen yeni loglar canlı animasyon almalı.
  const knownLogIdsRef = useRef<Set<string>>(new Set(logs.map((l) => l.id)));
  const liveAnimatedIdsRef = useRef<Set<string>>(new Set());
  const initialMountDoneRef = useRef(false);

  // Sunucu değiştiğinde (serverId / historyStorageKey) komut geçmişini ilgili sunucudan yükle
  // ve önceki sunucunun geçmişinin yeni sunucunun üzerine yazılmasını engelle
  useEffect(() => {
    try {
      const saved = localStorage.getItem(historyStorageKey);
      const parsed = saved ? JSON.parse(saved) : [];
      setHistory(Array.isArray(parsed) ? parsed : []);
    } catch {
      setHistory([]);
    }
    setHistoryIndex(-1);
    draftRef.current = '';
    prevCommandRef.current = '';
    setInputCommand('');
    setAnimRange(null);
    setDeletedItems([]);

    // Yeni sunucu için log animasyon izleme referanslarını sıfırla
    knownLogIdsRef.current = new Set(logs.map((l) => l.id));
    liveAnimatedIdsRef.current.clear();
    initialMountDoneRef.current = logs.length > 0;
  }, [historyStorageKey]);

  // Tam ekran modunda ESC ile çıkış ve arka plan kaydırma kilidi
  useEffect(() => {
    if (!isFullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !stopConfirmOpen) {
        e.preventDefault();
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleEsc);
    };
  }, [isFullscreen, stopConfirmOpen]);

  useEffect(() => {
    if (!initialMountDoneRef.current) {
      // İlk veri gelişi: Mevcut gelen tüm logları 'bilinen' listesine kaydet
      if (logs.length > 0) {
        logs.forEach((l) => knownLogIdsRef.current.add(l.id));
        initialMountDoneRef.current = true;
      }
      return;
    }

    // İlk yüklemeden sonra sonradan gelen yeni loglar
    logs.forEach((l) => {
      if (!knownLogIdsRef.current.has(l.id)) {
        knownLogIdsRef.current.add(l.id);
        liveAnimatedIdsRef.current.add(l.id);
      }
    });
  }, [logs]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextVal = e.target.value;
    const prevVal = prevCommandRef.current;
    const selStart = e.target.selectionStart ?? nextVal.length;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!prefersReducedMotion) {
      const prevLen = prevVal.length;
      const nextLen = nextVal.length;
      const diff = nextLen - prevLen;

      if (diff > 0 && diff <= 100) {
        const insertStart = Math.max(0, selStart - diff);
        setAnimRange({ from: insertStart, to: selStart });
        if (animCleanTimer.current) clearTimeout(animCleanTimer.current);
        animCleanTimer.current = setTimeout(() => {
          setAnimRange(null);
        }, 220);
      } else if (diff < 0 && Math.abs(diff) <= 20) {
        const deletedLen = Math.abs(diff);
        const deletedStart = selStart;
        const deletedText = prevVal.slice(deletedStart, deletedStart + deletedLen);
        const pl = getPaddingLeft();
        const el = inputRef.current;
        const sLeft = el ? el.scrollLeft : 0;
        const item = {
          id: ++deleteIdCounter.current,
          text: deletedText,
          x: pl + deletedStart * charWidth - sLeft,
        };
        setDeletedItems((prev) => [...prev.slice(-5), item]);
        setTimeout(() => {
          setDeletedItems((prev) => prev.filter((i) => i.id !== item.id));
        }, 200);
      }
    }

    prevCommandRef.current = nextVal;
    setInputCommand(nextVal);

    setIsTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      setIsTyping(false);
    }, 380);

    requestAnimationFrame(() => {
      updateCaret();
    });
  };

  // Execute command and save to history
  const executeCommand = (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (trimmed.toLowerCase() === '/stop' || trimmed.toLowerCase() === 'stop') {
      setStopConfirmOpen(true);
      return;
    }

    onSendCommand(trimmed);
    setHistory((prev) => {
      const updated = [trimmed, ...prev.filter((c) => c !== trimmed).slice(0, 49)];
      try {
        localStorage.setItem(historyStorageKey, JSON.stringify(updated));
      } catch {}
      return updated;
    });
    setHistoryIndex(-1);
    draftRef.current = '';
    prevCommandRef.current = '';
    setInputCommand('');
    setAnimRange(null);
    setDeletedItems([]);
    requestAnimationFrame(() => {
      updateCaret();
    });
  };

  const handleConfirmStop = () => {
    onSendCommand('/stop');
    setHistory((prev) => {
      const updated = ['/stop', ...prev.filter((c) => c !== '/stop').slice(0, 49)];
      try {
        localStorage.setItem(historyStorageKey, JSON.stringify(updated));
      } catch {}
      return updated;
    });
    setHistoryIndex(-1);
    setStopConfirmOpen(false);
    draftRef.current = '';
    prevCommandRef.current = '';
    setInputCommand('');
    setAnimRange(null);
    setDeletedItems([]);
    requestAnimationFrame(() => {
      updateCaret();
    });
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    executeCommand(inputCommand);
  };

  // Keyboard navigation for history
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;

      let nextVal = '';
      if (historyIndex === -1) {
        draftRef.current = inputCommand;
        setHistoryIndex(0);
        nextVal = history[0];
      } else if (historyIndex < history.length - 1) {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        nextVal = history[nextIndex];
      } else {
        return;
      }
      prevCommandRef.current = nextVal;
      setInputCommand(nextVal);
      setAnimRange(null);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          const len = nextVal.length;
          inputRef.current.setSelectionRange(len, len);
          updateCaret();
        }
      });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      let nextVal = '';
      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        nextVal = history[nextIndex];
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        nextVal = draftRef.current;
      } else {
        return;
      }
      prevCommandRef.current = nextVal;
      setInputCommand(nextVal);
      setAnimRange(null);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          const len = nextVal.length;
          inputRef.current.setSelectionRange(len, len);
          updateCaret();
        }
      });
    } else {
      requestAnimationFrame(() => {
        updateCaret();
      });
    }
  };

  const renderMirrorContent = () => {
    if (!inputCommand) return null;
    if (animRange && animRange.from < inputCommand.length && animRange.to > 0) {
      const parts: React.ReactNode[] = [];
      for (let i = 0; i < inputCommand.length; i++) {
        const char = inputCommand[i];
        if (i >= animRange.from && i < animRange.to) {
          parts.push(
            <span key={i} className="smooth-char-fade-in text-white font-medium">
              {char}
            </span>
          );
        } else {
          parts.push(<span key={i} className="text-white">{char}</span>);
        }
      }
      return parts;
    }
    return <span className="text-white">{inputCommand}</span>;
  };

  // Level counts for filter pills
  const levelCounts = useMemo(() => {
    const counts = { ALL: logs.length, INFO: 0, WARN: 0, ERROR: 0 };
    for (const l of logs) {
      if (l.level === 'INFO') counts.INFO++;
      else if (l.level === 'WARN') counts.WARN++;
      else if (l.level === 'ERROR') counts.ERROR++;
    }
    return counts;
  }, [logs]);

  // Filtered logs (filters out orphan prompt artifacts like bare '$' or '>')
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const rawTrimmed = (typeof log.raw === 'string' ? log.raw : String(log.raw || '')).replace(/\r/g, '').trim();
      const msgRaw = typeof log.message === 'string' ? log.message : String(log.message || '');
      const msgTrimmed = msgRaw.replace(/^>\s*/, '').trim();

      if (!rawTrimmed || rawTrimmed === '$' || rawTrimmed === '>' || (!msgTrimmed && (log.isCommandEcho || log.event === 'command' || (log.type as string) === 'command' || msgRaw.startsWith('>')))) {
        return false;
      }
      if (msgTrimmed === '$' || msgTrimmed === '>') {
        return false;
      }

      const matchesLevel = filterLevel === 'ALL' || log.level === filterLevel;
      const matchesSearch = searchQuery === '' ||
        rawTrimmed.toLowerCase().includes(searchQuery.toLowerCase()) ||
        msgTrimmed.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesLevel && matchesSearch;
    });
  }, [logs, filterLevel, searchQuery]);

  // SCROLL YÖNETİMİ: Boot burstlarında ve 500 satır halkası dolduğunda kilitlenmeyen akıllı otomatik kaydırma
  const userScrolledUpRef = useRef(false);
  const isAutoScrollingRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  const lastFilteredLog = filteredLogs[filteredLogs.length - 1];
  const lastFilteredSignature = lastFilteredLog
    ? `${filteredLogs.length}:${lastFilteredLog.id}:${lastFilteredLog.raw.length}`
    : '0';

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAutoScrollingRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const currentScrollTop = el.scrollTop;
    const distanceFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight;

    if (isAutoScrollingRef.current) {
      isAutoScrollingRef.current = false;
      lastScrollTopRef.current = currentScrollTop;
      return;
    }

    // Kullanıcı tabana yakınsa (<= 60px) otomatik kaydırmayı aktif tut
    if (distanceFromBottom <= 60) {
      userScrolledUpRef.current = false;
    } else if (currentScrollTop < lastScrollTopRef.current - 4) {
      // Yalnızca gerçek yukarı yönlü kaydırma hareketinde otomatik kaydırmayı duraklat
      userScrolledUpRef.current = true;
    }
    lastScrollTopRef.current = currentScrollTop;
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      userScrolledUpRef.current = true;
    } else if (e.deltaY > 0 && scrollRef.current) {
      const el = scrollRef.current;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= 60) {
        userScrolledUpRef.current = false;
      }
    }
  };

  const handleToggleAutoScroll = () => {
    const nextState = !autoScroll;
    setAutoScroll(nextState);
    if (nextState) {
      userScrolledUpRef.current = false;
      scrollToBottom();
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  };

  // İlk yüklemede, sunucu değişiminde ve tam ekran geçişinde en alta anında konumlan
  const isFirstLayoutRef = useRef(true);
  useLayoutEffect(() => {
    userScrolledUpRef.current = false;
    scrollToBottom();
    isFirstLayoutRef.current = false;
  }, [historyStorageKey, scrollToBottom]);

  // Yeni loglar geldiğinde (veya 500 satır halkası kaydığında), filtre/tam ekran değiştiğinde kullanıcı yukarı kaydırmadıysa tabanı koru
  useLayoutEffect(() => {
    if (!autoScroll || !scrollRef.current || userScrolledUpRef.current) return;
    scrollToBottom();
  }, [lastFilteredSignature, filterLevel, searchQuery, autoScroll, isFullscreen, scrollToBottom]);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current || userScrolledUpRef.current) return;
    scrollToBottom();
    const raf = requestAnimationFrame(() => {
      if (scrollRef.current && autoScroll && !userScrolledUpRef.current) {
        scrollToBottom();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [lastFilteredSignature, filterLevel, searchQuery, autoScroll, isFullscreen, scrollToBottom]);

  // Export logs to txt file
  const handleExportLogs = () => {
    const content = logs.map((l) => l.raw).join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mazipanel-logs-${new Date().toISOString().slice(0, 10)}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderLogLine = (log: LogEntry) => {
    const rawStr = typeof log.raw === 'string' ? log.raw : String(log.raw || '');
    const msgStr = typeof log.message === 'string' ? log.message : String(log.message || '');

    // Only live incoming lines animate — switching filters NEVER replays animation on existing lines
    const shouldAnimate = liveAnimatedIdsRef.current.has(log.id);

    // 1. Command check and render FIRST (before system row)
    const isCommandEcho = Boolean(
      log.isCommandEcho ||
      log.event === 'command' ||
      (log.type as string) === 'command' ||
      (msgStr.startsWith('>') && !/\[\d{2}:\d{2}:\d{2}/.test(rawStr))
    );

    if (isCommandEcho) {
      const displayCmd = msgStr.replace(/^>\s*/, '').trimStart();
      if (!displayCmd.trim() || displayCmd.trim() === '$' || displayCmd.trim() === '>') {
        return null;
      }
      return (
        <div
          key={log.id}
          className={`flex items-start gap-2.5 py-0.5 leading-relaxed text-xs px-2 rounded-lg transition-colors group font-mono hover:bg-white/[0.02] border-l-2 border-transparent ${
            shouldAnimate ? 'console-line-enter' : ''
          }`}
        >
          <span className="text-zinc-500 text-[11px] shrink-0 select-none">
            [{log.timestamp}]
          </span>
          <span className="text-white font-bold tracking-wide flex items-center gap-1.5 min-w-0 break-words">
            <span className="text-silver-400 select-none font-bold">$</span>
            {displayCmd}
          </span>
        </div>
      );
    }

    // 2. Clean JLine artifacts and unsigned prefix for regular server logs
    let displayMessage = cleanJLineArtifacts(msgStr).replace(/^\[Not Secure\]\s*/i, '').trimStart();
    if (!displayMessage.trim() || displayMessage.trim() === '$' || displayMessage.trim() === '>') {
      return null;
    }

    // 3. System line check (type === 'system' or [maziPanel])
    const isSystemLine = log.type === 'system' || displayMessage.startsWith('[maziPanel]');
    if (isSystemLine) {
      const cleanSystemMsg = displayMessage.replace(/^\[maziPanel\]\s*/, '');
      return (
        <div
          key={log.id}
          className="flex items-center justify-center my-2 py-1 text-zinc-400 text-xs font-mono select-none"
        >
          <span className="text-zinc-600 select-none mr-2">—</span>
          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.04] border border-white/10 text-silver-300 font-medium tracking-wide">
            {cleanSystemMsg}
          </span>
          <span className="text-zinc-600 select-none ml-2">—</span>
        </div>
      );
    }

    // 4. Done (x.xxxs)! satırı vurgusu (Görev 6)
    const isDoneLine = log.event === 'done' || /Done \(\d+(?:\.\d+)?s\)!/i.test(displayMessage);

    if (isDoneLine) {
      return (
        <div
          key={log.id}
          className={`my-1.5 flex items-start gap-2.5 py-1 px-3 rounded-xl bg-emerald-500/10 border border-emerald-400/30 text-emerald-200 shadow-[0_0_15px_rgba(52,211,153,0.15)] font-mono leading-relaxed text-xs ${
            shouldAnimate ? 'console-line-enter' : ''
          }`}
        >
          <span className="text-emerald-400/70 text-[11px] shrink-0 select-none font-mono">
            [{log.timestamp}]
          </span>
          <span className="text-[10px] font-bold px-1.5 py-0.2 rounded border select-none shrink-0 bg-emerald-500/20 text-emerald-200 border-emerald-400/40">
            BAŞARILI
          </span>
          <div className="font-bold flex-1 break-words text-emerald-100 flex items-center gap-1.5 min-w-0">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 inline" />
            <Ansi useClasses className="ansi-container font-mono">
              {displayMessage}
            </Ansi>
          </div>
        </div>
      );
    }

    // 5. Normal log satırı: Bilgi, Uyarı, Hata (Görev 6 net ayırt etme)
    const isError = log.level === 'ERROR';
    const isWarn = log.level === 'WARN';

    return (
      <div
        key={log.id}
        className={`flex items-start gap-2.5 py-0.5 leading-relaxed text-xs px-2 rounded-lg transition-colors group font-mono ${
          isError
            ? 'border-l-2 border-rose-500 bg-rose-500/[0.04] hover:bg-rose-500/[0.08]'
            : isWarn
            ? 'border-l-2 border-amber-400/70 bg-amber-500/[0.03] hover:bg-amber-500/[0.07]'
            : 'hover:bg-white/[0.02] border-l-2 border-transparent'
        } ${shouldAnimate ? 'console-line-enter' : ''}`}
      >
        <span className="text-zinc-500 text-[11px] shrink-0 select-none">
          [{log.timestamp}]
        </span>

        <div className="flex items-start gap-2 flex-1 min-w-0">
          <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded border select-none shrink-0 ${
            isError
              ? 'bg-rose-500/20 text-rose-200 border-rose-500/40 shadow-sm'
              : isWarn
              ? 'bg-amber-500/20 text-amber-200 border-amber-400/30'
              : log.level === 'DEBUG'
              ? 'bg-sky-500/10 text-sky-300 border-sky-400/20'
              : 'bg-white/[0.04] text-silver-400 border-white/5'
          }`}>
            {isError ? 'Hata' : isWarn ? 'Uyarı' : log.level === 'DEBUG' ? 'Hata Ayıklama' : 'Bilgi'}
          </span>

          <div className={`break-words flex-1 min-w-0 ${
            isError
              ? 'text-rose-100 font-semibold'
              : isWarn
              ? 'text-amber-100 font-medium'
              : 'text-silver-300'
          }`}>
            <Ansi useClasses className="ansi-container font-mono">
              {displayMessage}
            </Ansi>
          </div>
        </div>
      </div>
    );
  };

  const terminalPanel = (
    <div className={`flex flex-col transition-all duration-300 ${
      isFullscreen
        ? 'fixed inset-4 z-[200] rounded-3xl bg-zinc-950/95 border border-white/20 shadow-[0_25px_80px_rgba(0,0,0,0.95)] backdrop-blur-3xl p-6'
        : 'rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-5 w-full flex-1 min-h-[540px]'
    }`}>
      {/* Terminal Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
            <TerminalIcon className="w-3.5 h-3.5 text-white" />
            <span className="text-xs font-semibold text-white tracking-wide">CANLI KONSOL</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-silver-400 font-mono">
            <span className={`inline-block w-2 h-2 rounded-full ${
              serverStatus === 'online'
                ? 'bg-emerald-400 animate-pulse'
                : serverStatus === 'starting' || serverStatus === 'stopping'
                ? 'bg-amber-400 animate-pulse'
                : serverStatus === 'crashed'
                ? 'bg-rose-500'
                : 'bg-zinc-600'
            }`} />
            <span>{logs.length} Satır</span>
          </div>
        </div>

        {/* Toolbar: Search, Filter, AutoScroll, Clear, Export, Fullscreen */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-silver-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Loglarda ara..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1 text-xs rounded-full glass-input bg-zinc-900 border border-white/10 text-white placeholder-silver-500 focus:outline-none focus:border-white/30 w-36 sm:w-44 font-mono transition-all"
            />
          </div>

          {/* Level Filter Pills with dynamic counts & Framer-Motion Animated Pill (Görev 7) */}
          <div className="flex items-center rounded-full bg-white/5 p-0.5 border border-white/10 text-[11px] relative">
            {([
              { key: 'ALL', label: `Tümü ${levelCounts.ALL}` },
              { key: 'INFO', label: `Bilgi ${levelCounts.INFO}` },
              { key: 'WARN', label: `Uyarı ${levelCounts.WARN}` },
              { key: 'ERROR', label: `Hata ${levelCounts.ERROR}` },
            ] as const).map(({ key, label }) => {
              const isActive = filterLevel === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilterLevel(key)}
                  className={`relative px-2.5 py-0.5 rounded-full transition-colors font-sans text-[11px] cursor-pointer ${
                    isActive ? 'text-black font-semibold' : 'text-silver-400 hover:text-white'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="activeTerminalFilterPill"
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                      className="absolute inset-0 rounded-full bg-white shadow-sm"
                    />
                  )}
                  <span className="relative z-10">{label}</span>
                </button>
              );
            })}
          </div>

          {/* AutoScroll Button */}
          <Tooltip content={autoScroll ? 'Otomatik Kaydırma Açık' : 'Otomatik Kaydırma Kapalı'}>
            <button
              type="button"
              onClick={handleToggleAutoScroll}
              className={`p-1.5 rounded-full border transition-colors cursor-pointer ${
                autoScroll
                  ? 'bg-white/15 text-white border-white/30'
                  : 'bg-white/5 text-silver-500 border-white/10 hover:text-white'
              }`}
            >
              <ArrowDownCircle className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          {/* Export Button */}
          <Tooltip content="Logları İndir">
            <button
              type="button"
              onClick={handleExportLogs}
              className="p-1.5 rounded-full bg-white/5 border border-white/10 text-silver-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          {/* Clear Button */}
          <Tooltip content="Konsolu Temizle">
            <button
              type="button"
              onClick={onClear}
              className="p-1.5 rounded-full bg-white/5 border border-white/10 text-silver-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          {/* Fullscreen Button */}
          <Tooltip content={isFullscreen ? 'Küçült (Esc)' : 'Tam Ekran'}>
            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-1.5 rounded-full bg-white/5 border border-white/10 text-silver-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Terminal Output Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        className={`flex-1 overflow-y-auto py-3 space-y-1 font-mono text-xs select-text ${
          isFullscreen ? 'min-h-0' : 'min-h-[300px] max-h-[500px]'
        }`}
      >
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-silver-500 font-mono gap-2">
            <TerminalIcon className="w-8 h-8 opacity-30 text-white" />
            <p className="text-xs">
              {serverStatus === 'offline'
                ? 'Sunucu kapalı durumda. Konsol çıktısını görüntülemek için sunucuyu başlatın.'
                : serverStatus === 'crashed'
                ? 'Sunucu beklenmedik biçimde çöktü. Konsol çıktılarını inceleyebilirsiniz.'
                : filterLevel === 'WARN'
                ? 'Kayıtlarda herhangi bir uyarı (WARN) bulunmuyor.'
                : filterLevel === 'ERROR'
                ? 'Kayıtlarda herhangi bir hata (ERROR) bulunmuyor.'
                : 'Görüntülenecek log kaydı bulunamadı.'}
            </p>
          </div>
        ) : (
          filteredLogs.map(renderLogLine)
        )}
      </div>

      {/* Command Input Form */}
      <form
        onSubmit={handleSubmit}
        className="pt-3 border-t border-white/10 flex items-center gap-2"
      >
        <div className="relative flex-1 flex items-center overflow-hidden rounded-2xl">
          <span className="absolute left-3.5 font-mono text-sm text-silver-400 select-none pointer-events-none z-20">$</span>

          {/* Layer 1: Mirror layer with smooth fade-in character animation */}
          {inputCommand && (
            <div
              aria-hidden="true"
              className="absolute left-0 top-0 bottom-0 pointer-events-none flex items-center whitespace-pre font-mono text-xs z-10 select-none overflow-hidden"
              style={{
                transform: `translateX(${getPaddingLeft() - inputScrollLeft}px)`,
              }}
            >
              {renderMirrorContent()}
            </div>
          )}

          {/* Layer 2: Deleted character fade-out animations */}
          {deletedItems.map((item) => (
            <div
              key={item.id}
              className="smooth-char-deleted font-mono text-xs z-15"
              style={{
                left: `${item.x}px`,
                top: '50%',
                transform: 'translateY(-50%)',
              }}
            >
              {item.text}
            </div>
          ))}

          {/* Layer 3: Custom Smooth Caret (Office/Word Fluid Caret) */}
          {isFocused && serverStatus !== 'offline' && (
            <div
              ref={caretRef}
              className={`absolute pointer-events-none z-20 w-[2px] bg-white rounded-full ${
                isTyping ? 'smooth-caret-active' : 'smooth-caret-active smooth-caret-blinking'
              }`}
              style={{
                height: '16px',
                top: '50%',
                left: 0,
                transform: `translate(${caretX}px, -50%)`,
                boxShadow: '0 0 8px rgba(255, 255, 255, 0.9), 0 0 2px #ffffff',
              }}
            />
          )}

          {/* Layer 4: Native Input */}
          <input
            ref={inputRef}
            type="text"
            value={inputCommand}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onKeyUp={updateCaret}
            onClick={updateCaret}
            onFocus={() => {
              setIsFocused(true);
              updateCaret();
            }}
            onBlur={() => {
              setIsFocused(false);
            }}
            onScroll={() => {
              if (inputRef.current) {
                setInputScrollLeft(inputRef.current.scrollLeft);
                updateCaret();
              }
            }}
            disabled={serverStatus === 'offline'}
            placeholder={
              serverStatus === 'offline'
                ? 'Sunucu kapalı durumda.'
                : 'Bir komut girin...'
            }
            className={`w-full pl-8 pr-4 py-2.5 rounded-2xl glass-input bg-black/60 border border-white/15 text-xs placeholder-silver-600 focus:outline-none focus:border-white/40 font-mono disabled:opacity-40 transition-all shadow-inner relative z-10 ${
              inputCommand ? 'text-transparent selection:bg-white/20 selection:text-transparent' : 'text-white'
            }`}
            style={{ caretColor: 'transparent' }}
          />
        </div>

        <button
          type="submit"
          disabled={!inputCommand.trim() || serverStatus === 'offline'}
          className="px-4 py-2.5 rounded-2xl bg-white text-black font-semibold text-xs hover:bg-silver-200 active:scale-95 disabled:opacity-30 disabled:pointer-events-none transition-all flex items-center gap-1.5 shadow-[0_0_15px_rgba(255,255,255,0.3)] shrink-0 cursor-pointer"
        >
          <span>Gönder</span>
          <Send className="w-3.5 h-3.5" />
        </button>
      </form>

      {/* Stop Server ConfirmModal */}
      <ConfirmModal
        isOpen={stopConfirmOpen}
        title="Sunucuyu Durdur"
        message="Sunucuya durdurma sinyali iletilecektir. Tüm dünyalar ve oyuncu verileri kaydedilecektir. Devam etmek istiyor musunuz?"
        confirmText="Durdur"
        cancelText="Vazgeç"
        variant="warning"
        onConfirm={handleConfirmStop}
        onCancel={() => setStopConfirmOpen(false)}
      />
    </div>
  );

  if (isFullscreen && typeof document !== 'undefined') {
    return (
      <>
        <div
          className="rounded-3xl glass-panel bg-zinc-950/40 border border-white/5 w-full flex-1 min-h-[540px]"
          aria-hidden="true"
        />
        {createPortal(
          <>
            <div
              onClick={() => setIsFullscreen(false)}
              className="fixed inset-0 z-[190] bg-black/80 backdrop-blur-md"
              aria-hidden="true"
            />
            {terminalPanel}
          </>,
          document.body
        )}
      </>
    );
  }

  return terminalPanel;
};
