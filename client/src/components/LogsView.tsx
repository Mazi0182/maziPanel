import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FileText, 
  Search, 
  Download, 
  RefreshCw, 
  ArrowDownCircle, 
  Copy, 
  Check, 
  AlertTriangle, 
  ChevronDown, 
  FileArchive, 
  Clock, 
  HardDrive 
} from 'lucide-react';
import Ansi from 'ansi-to-react';
import { ServerInstance, LogFileInfo } from '../types';
import { Tooltip } from './Tooltip';
import { parseLogContent, ParsedLogEntry, cleanJLineArtifacts } from '../utils/parseLog';
import { copyTextToClipboard } from '../utils/clipboard';

interface LogsViewProps {
  selectedServer: ServerInstance | null;
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
}

export const LogsView: React.FC<LogsViewProps> = ({ selectedServer, onShowToast }) => {
  const [rawLogs, setRawLogs] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterLevel, setFilterLevel] = useState<'ALL' | 'INFO' | 'WARN' | 'ERROR'>('ALL');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);

  // Log dosyaları listesi ve seçili dosya
  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('latest.log');
  const [isTruncated, setIsTruncated] = useState<boolean>(false);
  const [showFileDropdown, setShowFileDropdown] = useState<boolean>(false);
  const [isSpinning, setIsSpinning] = useState<boolean>(false);

  // Virtualization state
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [containerHeight, setContainerHeight] = useState<number>(600);

  const scrollRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Request tracking to prevent race conditions
  const filesReqIdRef = useRef(0);
  const filesAbortRef = useRef<AbortController | null>(null);

  const loadReqIdRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const setTrackedTimeout = useCallback((fn: () => void, delay: number) => {
    const t = setTimeout(() => {
      timersRef.current.delete(t);
      fn();
    }, delay);
    timersRef.current.add(t);
    return t;
  }, []);

  useEffect(() => {
    return () => {
      filesAbortRef.current?.abort();
      loadAbortRef.current?.abort();
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current.clear();
    };
  }, []);

  // Track container height for virtualization
  useEffect(() => {
    if (!scrollRef.current) return;
    const updateSize = () => {
      if (scrollRef.current) {
        setContainerHeight(scrollRef.current.clientHeight);
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, []);

  // Outside click for file dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowFileDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Format bytes helper
  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  // 1. Log dosyaları listesini çek with request id & AbortController guard
  const fetchLogFiles = async () => {
    if (!selectedServer) return;
    filesAbortRef.current?.abort();
    const controller = new AbortController();
    filesAbortRef.current = controller;
    const reqId = ++filesReqIdRef.current;

    setIsLoadingFiles(true);
    try {
      const res = await fetch(`/api/servers/${selectedServer.id}/logs/files`, { signal: controller.signal });
      if (reqId !== filesReqIdRef.current) return;
      if (res.ok) {
        const files: LogFileInfo[] = await res.json();
        if (reqId !== filesReqIdRef.current) return;
        if (Array.isArray(files) && files.length > 0) {
          setLogFiles(files);
          return;
        }
      }
      setLogFiles([{
        name: 'latest.log',
        sizeBytes: 0,
        modifiedAt: new Date().toISOString(),
        compressed: false,
      }]);
    } catch (err: any) {
      if (reqId !== filesReqIdRef.current || err?.name === 'AbortError') return;
      setLogFiles([{
        name: 'latest.log',
        sizeBytes: 0,
        modifiedAt: new Date().toISOString(),
        compressed: false,
      }]);
    } finally {
      if (reqId === filesReqIdRef.current) {
        setIsLoadingFiles(false);
      }
    }
  };

  // 2. Seçili log dosyasının içeriğini yükle with request id & AbortController guard
  const loadLogs = async (fileName = selectedFile) => {
    if (!selectedServer) return;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const reqId = ++loadReqIdRef.current;

    setIsLoading(true);
    setIsTruncated(false);
    try {
      // 1. Tercih: GET /api/servers/:id/logs/files/:name
      const fileRes = await fetch(`/api/servers/${selectedServer.id}/logs/files/${encodeURIComponent(fileName)}`, { signal: controller.signal });
      if (reqId !== loadReqIdRef.current) return;
      if (fileRes.ok) {
        const data = await fileRes.json();
        if (reqId !== loadReqIdRef.current) return;
        setRawLogs(data.content || '');
        if (data.truncated) setIsTruncated(true);
        return;
      }

      // 2. Tercih: latest.log ise dedicated veya dosya endpoint'leri
      if (fileName === 'latest.log') {
        const latestRes = await fetch(`/api/servers/${selectedServer.id}/logs/latest`, { signal: controller.signal });
        if (reqId !== loadReqIdRef.current) return;
        if (latestRes.ok) {
          const data = await latestRes.json();
          if (reqId !== loadReqIdRef.current) return;
          setRawLogs(data.content || '');
          return;
        }

        const directRes = await fetch(`/api/servers/${selectedServer.id}/files/content?path=logs/latest.log`, { signal: controller.signal });
        if (reqId !== loadReqIdRef.current) return;
        if (directRes.ok) {
          const fileData = await directRes.json();
          if (reqId !== loadReqIdRef.current) return;
          setRawLogs(fileData.content || '');
          return;
        }

        // Ring buffer fallback
        const ringRes = await fetch(`/api/servers/${selectedServer.id}/logs?limit=1500`, { signal: controller.signal });
        if (reqId !== loadReqIdRef.current) return;
        if (ringRes.ok) {
          const ringData = await ringRes.json();
          if (reqId !== loadReqIdRef.current) return;
          const textLines = Array.isArray(ringData) 
            ? ringData.map((item) => (typeof item === 'string' ? item : (item.text || ''))).join('\n')
            : '';
          setRawLogs(textLines);
          return;
        }
      }

      // Genel dosya okuma fallback'i
      const fallbackFile = await fetch(`/api/servers/${selectedServer.id}/files/content?path=logs/${encodeURIComponent(fileName)}`, { signal: controller.signal });
      if (reqId !== loadReqIdRef.current) return;
      if (fallbackFile.ok) {
        const fd = await fallbackFile.json();
        if (reqId !== loadReqIdRef.current) return;
        setRawLogs(fd.content || '');
        return;
      }

      onShowToast('Log Okuma Hatası', `"${fileName}" içeriği alınamadı.`, 'error');
    } catch (err: any) {
      if (reqId !== loadReqIdRef.current || err?.name === 'AbortError') return;
      console.warn('Logs load failed:', err);
      onShowToast('Log Okuma Hatası', 'Sunucu log dosyası yüklenemedi.', 'error');
    } finally {
      if (reqId === loadReqIdRef.current) {
        setIsLoading(false);
      }
    }
  };

  const handleRefresh = async () => {
    setIsSpinning(true);
    const start = Date.now();
    try {
      await loadLogs();
    } finally {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, 600 - elapsed);
      setTrackedTimeout(() => {
        setIsSpinning(false);
      }, remaining);
    }
  };

  useEffect(() => {
    if (selectedServer) {
      let initialFile = 'latest.log';
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const fileParam = searchParams.get('file');
        if (fileParam) {
          initialFile = fileParam;
        }
      } catch {
        // Ignore
      }

      fetchLogFiles();
      loadLogs(initialFile);
      setSelectedFile(initialFile);
    }
  }, [selectedServer?.id]);

  const handleSelectFile = (file: LogFileInfo) => {
    setSelectedFile(file.name);
    setShowFileDropdown(false);
    loadLogs(file.name);
  };

  // Parse raw text into structured lines using common parser
  const parsedLines: ParsedLogEntry[] = useMemo(() => {
    return parseLogContent(rawLogs);
  }, [rawLogs]);

  // Counts for each log level to prove filter works
  const levelCounts = useMemo(() => {
    const counts = { ALL: parsedLines.length, INFO: 0, WARN: 0, ERROR: 0 };
    for (const l of parsedLines) {
      if (l.level === 'INFO') counts.INFO++;
      else if (l.level === 'WARN') counts.WARN++;
      else if (l.level === 'ERROR') counts.ERROR++;
    }
    return counts;
  }, [parsedLines]);

  // Filtered log lines
  const filteredLines = useMemo(() => {
    return parsedLines.filter((l) => {
      const matchesLevel = filterLevel === 'ALL' || l.level === filterLevel;
      const matchesSearch = !searchQuery.trim() || l.raw.toLowerCase().includes(searchQuery.toLowerCase().trim());
      return matchesLevel && matchesSearch;
    });
  }, [parsedLines, filterLevel, searchQuery]);

  // Auto-scroll when filtered lines change
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      const targetTop = Math.max(0, filteredLines.length * 28);
      scrollRef.current.scrollTop = Math.max(scrollRef.current.scrollHeight, targetTop);
      setScrollTop(scrollRef.current.scrollTop);
      if (gutterRef.current) {
        gutterRef.current.scrollTop = scrollRef.current.scrollTop;
      }
      const raf = requestAnimationFrame(() => {
        if (scrollRef.current && autoScroll) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          setScrollTop(scrollRef.current.scrollTop);
          if (gutterRef.current) {
            gutterRef.current.scrollTop = scrollRef.current.scrollTop;
          }
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [filteredLines, autoScroll]);

  const handleExport = () => {
    const blob = new Blob([rawLogs], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedServer?.name || 'server'}-${selectedFile}`;
    a.click();
    URL.revokeObjectURL(url);
    onShowToast('Log İndirildi', `"${selectedFile}" başarıyla cihazınıza kaydedildi.`, 'success');
  };

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(rawLogs);
    if (ok) {
      setCopied(true);
      setTrackedTimeout(() => setCopied(false), 2000);
      onShowToast('Kopyalandı', 'Tüm log içeriği panoya kopyalandı.', 'info');
    } else {
      onShowToast('Kopyalama Hatası', 'Log içeriği panoya kopyalanamadı.', 'error');
    }
  };

  const ROW_HEIGHT = 28;
  const buffer = 15;
  const totalCount = filteredLines.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - buffer);
  const endIndex = Math.min(totalCount, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + buffer);
  const visibleLines = filteredLines.slice(startIndex, endIndex);
  const topSpacerHeight = startIndex * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (totalCount - endIndex) * ROW_HEIGHT);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const currentScrollTop = e.currentTarget.scrollTop;
    setScrollTop(currentScrollTop);
    if (gutterRef.current) {
      gutterRef.current.scrollTop = currentScrollTop;
    }
  };

  if (!selectedServer) {
    return (
      <div className="p-12 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 text-center flex flex-col items-center justify-center gap-4 shadow-2xl max-w-2xl mx-auto my-12">
        <FileText className="w-10 h-10 text-silver-500" />
        <h3 className="text-base font-bold text-white">Lütfen Bir Sunucu Seçin</h3>
        <p className="text-xs text-silver-400 font-sans">
          Sunucu log kayıtlarını incelemek için lütfen sol üstteki menüden bir sunucu seçin.
        </p>
      </div>
    );
  }

  const currentFileInfo = logFiles.find((f) => f.name === selectedFile);

  return (
    <div className="space-y-6">
      {/* Top Banner & File Selector */}
      <div className="relative z-30 p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="p-3 rounded-2xl bg-white/10 border border-white/20 text-white">
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-white tracking-wide">Sunucu Log Dosyaları</h2>
              {isTruncated && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/30 font-mono">
                  Son Bölüm (Kısaltıldı)
                </span>
              )}
            </div>
            <p className="text-xs text-silver-400 font-mono mt-0.5">
              /{selectedServer.directory || selectedServer.name}/logs/{selectedFile} • {parsedLines.length} Satır
            </p>
          </div>
        </div>

        {/* Action Controls & File Dropdown */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* DOSYA SEÇİCİ (GÖREV 7) */}
          <div ref={dropdownRef} className="relative z-40">
            <button
              type="button"
              onClick={() => setShowFileDropdown(!showFileDropdown)}
              className="flex items-center gap-2 px-3.5 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/15 text-xs font-mono text-white transition-all cursor-pointer shadow-sm active:scale-95"
            >
              <HardDrive className="w-3.5 h-3.5 text-silver-400" />
              <span className="font-semibold">{selectedFile}</span>
              <ChevronDown className={`w-3.5 h-3.5 text-silver-400 transition-transform ${showFileDropdown ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
              {showFileDropdown && (
                <motion.div
                  initial={{ opacity: 0, y: 6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.97 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                  className="absolute right-0 mt-2 w-72 max-h-80 overflow-y-auto rounded-2xl bg-[#121316] border border-white/20 shadow-[0_25px_60px_rgba(0,0,0,0.95)] p-1.5 flex flex-col gap-1 z-50 ring-1 ring-white/10"
                >
                  <div className="px-3 py-1.5 text-[10px] uppercase font-mono text-silver-500 border-b border-white/5 flex items-center justify-between">
                    <span>Log Dosyaları ({logFiles.length})</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        fetchLogFiles();
                      }}
                      className="text-silver-400 hover:text-white"
                    >
                      <RefreshCw className={`w-3.5 h-3 ${isLoadingFiles ? 'animate-spin' : ''}`} />
                    </button>
                  </div>

                  {logFiles.map((file) => {
                    const isSelected = file.name === selectedFile;
                    const dateFormatted = file.modifiedAt 
                      ? new Date(file.modifiedAt).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                      : '';

                    return (
                      <button
                        key={file.name}
                        type="button"
                        onClick={() => handleSelectFile(file)}
                        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs transition-all text-left cursor-pointer ${
                          isSelected 
                            ? 'bg-white/15 text-white font-semibold' 
                            : 'text-silver-300 hover:text-white hover:bg-white/5'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 truncate">
                            {file.compressed ? (
                              <FileArchive className="w-3.5 h-3.5 text-silver-400 shrink-0" />
                            ) : (
                              <FileText className="w-3.5 h-3.5 text-silver-400 shrink-0" />
                            )}
                            <span className="truncate text-white font-mono">{file.name}</span>
                          </div>
                          <div className="text-[10px] text-silver-500 font-mono mt-0.5 flex items-center gap-2">
                            {file.sizeBytes > 0 && <span>{formatBytes(file.sizeBytes)}</span>}
                            {dateFormatted && <span>• {dateFormatted}</span>}
                          </div>
                        </div>
                        {isSelected && <Check className="w-3.5 h-3.5 text-white shrink-0" />}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <Tooltip content="Dosyayı Yeniden Oku">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isLoading || isSpinning}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-sans text-silver-300 hover:text-white transition-all disabled:opacity-40 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading || isSpinning ? 'animate-spin text-white' : ''}`} />
              <span>Yenile</span>
            </button>
          </Tooltip>

          <Tooltip content="Panoya Kopyala">
            <button
              type="button"
              onClick={handleCopy}
              className="p-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-silver-300 hover:text-white transition-all cursor-pointer"
            >
              {copied ? <Check className="w-4 h-4 text-white" /> : <Copy className="w-4 h-4" />}
            </button>
          </Tooltip>

          <Tooltip content="Log Dosyasını İndir">
            <button
              type="button"
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-sans text-silver-300 hover:text-white transition-all cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>İndir</span>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Main Log Viewer Card */}
      <div className="relative z-10 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-6 flex flex-col h-[650px] max-h-[75vh] min-h-[500px]">
        {/* Toolbar: Search & Level Filters with Smooth Sliding Pill (Görev 7) */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/10 mb-4 shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-silver-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Loglarda ara..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-xs rounded-full glass-input bg-zinc-900 border border-white/10 text-white placeholder-silver-500 focus:outline-none focus:border-white/30 w-44 sm:w-56 font-mono transition-all"
              />
            </div>

            {/* Level Filter Buttons with Framer-Motion layoutId Sliding Pill */}
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
                    className={`relative px-3 py-1 rounded-full transition-colors font-sans text-[11px] cursor-pointer ${
                      isActive
                        ? 'text-black font-semibold'
                        : 'text-silver-400 hover:text-white'
                    }`}
                  >
                    {isActive && (
                      <motion.div
                        layoutId="activeLogsViewFilterPill"
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        className="absolute inset-0 rounded-full bg-white shadow-sm"
                      />
                    )}
                    <span className="relative z-10">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-silver-500 hidden sm:inline mr-2">
              {filteredLines.length} / {parsedLines.length} Satır
            </span>

            {/* AutoScroll Button */}
            <Tooltip content={autoScroll ? 'Otomatik Kaydırma Açık' : 'Otomatik Kaydırma Kapalı'}>
              <button
                type="button"
                onClick={() => setAutoScroll(!autoScroll)}
                className={`p-2 rounded-2xl border transition-colors cursor-pointer ${
                  autoScroll
                    ? 'bg-white/15 text-white border-white/30'
                    : 'bg-white/5 text-silver-500 border-white/10 hover:text-white'
                }`}
              >
                <ArrowDownCircle className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Log Viewer Content with Synchronized Line Numbers & Smooth Container Crossfade */}
        <div className="relative flex-1 min-h-0 rounded-2xl bg-black/80 border border-white/10 overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {/* Gutter Line Numbers */}
            <div
              ref={gutterRef}
              onWheel={(e) => {
                if (scrollRef.current) {
                  scrollRef.current.scrollTop += e.deltaY;
                }
              }}
              className="select-none py-4 pl-3 pr-2.5 bg-white/[0.02] border-r border-white/10 text-right font-mono text-xs leading-6 text-silver-600 overflow-hidden shrink-0 cursor-default"
              style={{ minWidth: '3.5rem' }}
              aria-hidden="true"
            >
              <div style={{ height: topSpacerHeight }} />
              {visibleLines.map((_, idx) => (
                <div key={startIndex + idx} style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}>
                  {startIndex + idx + 1}
                </div>
              ))}
              <div style={{ height: bottomSpacerHeight }} />
            </div>

            {/* Log Lines Container - Container Crossfade Transition */}
            <motion.div
              key={filterLevel}
              initial={{ opacity: 0.85 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.12 }}
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-auto p-4 font-mono text-xs select-text focus:outline-none"
            >
              {filteredLines.length === 0 ? (
                <div className="p-12 text-center text-silver-500 flex flex-col items-center justify-center gap-2">
                  <AlertTriangle className="w-6 h-6 opacity-40 text-white" />
                  <p>{isLoading && !rawLogs ? 'Log kayıtları taranıyor...' : 'Seçilen filtrelere uygun log satırı bulunamadı.'}</p>
                </div>
              ) : (
                <>
                  <div style={{ height: topSpacerHeight }} />
                  {visibleLines.map((line) => {
                    const isError = line.level === 'ERROR';
                    const isWarn = line.level === 'WARN';
                    const isDone = line.event === 'done' || /Done \(\d+(?:\.\d+)?s\)!/i.test(line.message);

                    if (isDone) {
                      return (
                        <div
                          key={line.id}
                          style={{ minHeight: ROW_HEIGHT }}
                          className="my-1 flex items-start gap-2.5 py-0.5 px-3 rounded-xl bg-emerald-500/10 border border-emerald-400/30 text-emerald-200 shadow-[0_0_15px_rgba(52,211,153,0.15)] font-mono leading-6 text-xs"
                        >
                          {line.timestamp && (
                            <span className="text-emerald-400/70 text-[11px] shrink-0 select-none">
                              [{line.timestamp}]
                            </span>
                          )}
                          <span className="text-[10px] font-bold px-1.5 py-0.2 rounded border select-none shrink-0 bg-emerald-500/20 text-emerald-200 border-emerald-400/40">
                            BAŞARILI
                          </span>
                          <div className="break-words flex-1 min-w-0 font-bold text-emerald-100">
                            <Ansi useClasses className="ansi-container font-mono">
                              {line.message}
                            </Ansi>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={line.id}
                        style={{ minHeight: ROW_HEIGHT }}
                        className={`flex items-start gap-2.5 py-0.5 px-2 rounded-lg transition-colors leading-6 ${
                          isError
                            ? 'border-l-2 border-rose-500 bg-rose-500/[0.04] hover:bg-rose-500/[0.08]'
                            : isWarn
                            ? 'border-l-2 border-amber-400/70 bg-amber-500/[0.03] hover:bg-amber-500/[0.07]'
                            : 'hover:bg-white/[0.02] border-l-2 border-transparent'
                        }`}
                      >
                        {line.timestamp && (
                          <span className="text-zinc-500 text-[11px] shrink-0 select-none">
                            [{line.timestamp}]
                          </span>
                        )}

                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.2 rounded border select-none shrink-0 ${
                            isError
                              ? 'bg-rose-500/20 text-rose-200 border-rose-500/40'
                              : isWarn
                              ? 'bg-amber-500/20 text-amber-200 border-amber-400/30'
                              : line.level === 'DEBUG'
                              ? 'bg-sky-500/10 text-sky-300 border-sky-400/20'
                              : 'bg-white/[0.04] text-silver-400 border-white/5'
                          }`}
                        >
                          {isError ? 'Hata' : isWarn ? 'Uyarı' : line.level === 'DEBUG' ? 'Hata Ayıklama' : 'Bilgi'}
                        </span>

                        <div className={`break-words flex-1 min-w-0 ${
                          isError ? 'text-rose-100 font-semibold' : isWarn ? 'text-amber-100 font-medium' : 'text-silver-300'
                        }`}>
                          <Ansi useClasses className="ansi-container font-mono">
                            {line.message}
                          </Ansi>
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ height: bottomSpacerHeight }} />
                </>
              )}
            </motion.div>
          </div>

          {/* Footer Bar */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-white/[0.02] border-t border-white/5 text-[11px] font-mono text-silver-500 shrink-0">
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>{selectedFile} • Ayrıştırılmış Log Çıktısı</span>
            </span>
            <span>UTF-8 Metin Formatı</span>
          </div>
        </div>
      </div>
    </div>
  );
};
