import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FileArchive, 
  Folder, 
  File, 
  ArrowLeft, 
  Download, 
  Search, 
  X, 
  RefreshCw, 
  Eye, 
  Package, 
  FileCode,
  HardDrive,
  AlertTriangle
} from 'lucide-react';
import { ArchiveEntry, ArchiveEntriesResponse, ArchiveEntryDetail } from '../types/backups';
import { fetchWithAuth } from '../auth/authSession';

export interface ArchiveBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  mode: 'backup' | 'file';
  backupId?: string;
  serverId?: string;
  filePath?: string;
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
  isOpenedFromNav?: boolean;
}

interface ArchiveHistoryState {
  isArchiveModal?: boolean;
  archivePath?: string;
  previewPath?: string | null;
  archiveDepth?: number;
}

function formatBytes(bytes?: number | null, decimals = 1): string {
  if (bytes === undefined || bytes === null || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export const ArchiveBrowser: React.FC<ArchiveBrowserProps> = ({
  isOpen,
  onClose,
  title,
  mode,
  backupId,
  serverId,
  filePath,
  onShowToast,
  isOpenedFromNav = false,
}) => {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [search, setSearch] = useState<string>('');
  const wasOpenRef = useRef<boolean>(false);
  const internalDepthRef = useRef<number>(0);
  const isUnwindingRef = useRef<boolean>(false);

  // File Preview Modal State
  const [previewFile, setPreviewFile] = useState<{
    open: boolean;
    entry: ArchiveEntry | null;
    content: string;
    isBinary: boolean;
    truncated: boolean;
    isLoading: boolean;
  }>({
    open: false,
    entry: null,
    content: '',
    isBinary: false,
    truncated: false,
    isLoading: false,
  });

  // Keep fresh references for popstate event listener
  const currentPathRef = useRef<string>('');
  currentPathRef.current = currentPath;

  const previewFileRef = useRef(previewFile);
  previewFileRef.current = previewFile;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Build entry endpoints
  const getEntriesUrl = useCallback(
    (subPath: string) => {
      if (mode === 'backup') {
        return `/api/backups/${backupId}/entries?path=${encodeURIComponent(subPath)}`;
      }
      return `/api/backups/archive/entries?serverId=${encodeURIComponent(serverId || '')}&file=${encodeURIComponent(
        filePath || ''
      )}&path=${encodeURIComponent(subPath)}`;
    },
    [mode, backupId, serverId, filePath]
  );

  const getEntryDownloadUrl = useCallback(
    (itemPath: string) => {
      if (mode === 'backup') {
        return `/api/backups/${backupId}/entry?path=${encodeURIComponent(itemPath)}&download=1`;
      }
      return `/api/backups/archive/entry?serverId=${encodeURIComponent(serverId || '')}&file=${encodeURIComponent(
        filePath || ''
      )}&path=${encodeURIComponent(itemPath)}&download=1`;
    },
    [mode, backupId, serverId, filePath]
  );

  const getEntryPreviewUrl = useCallback(
    (itemPath: string) => {
      if (mode === 'backup') {
        return `/api/backups/${backupId}/entry?path=${encodeURIComponent(itemPath)}`;
      }
      return `/api/backups/archive/entry?serverId=${encodeURIComponent(serverId || '')}&file=${encodeURIComponent(
        filePath || ''
      )}&path=${encodeURIComponent(itemPath)}`;
    },
    [mode, backupId, serverId, filePath]
  );

  // Close modal and cleanly unwind history so archive isn't reopened on back
  const handleCloseModal = useCallback(() => {
    if (isUnwindingRef.current) return;

    const internalDepth = internalDepthRef.current;
    const outerPushed = (mode === 'file' && isOpenedFromNav) ? 1 : 0;
    const totalStepsToUnwind = internalDepth + outerPushed;

    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('archivePath');
      url.searchParams.delete('preview');
      window.history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
    } catch {
      // Ignore if URL parse fails
    }

    if (totalStepsToUnwind > 0) {
      isUnwindingRef.current = true;
      window.history.go(-totalStepsToUnwind);
    }

    onCloseRef.current();
  }, [mode, isOpenedFromNav]);

  // Back from preview: pops history if preview was pushed or closes preview directly
  const handleBackFromPreview = useCallback(() => {
    if (previewFileRef.current.open) {
      if (window.history.state?.previewPath) {
        window.history.back();
      } else {
        setPreviewFile((prev) => ({ ...prev, open: false, entry: null }));
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('preview');
          window.history.replaceState(
            { isArchiveModal: true, archivePath: currentPathRef.current, previewPath: null, archiveDepth: internalDepthRef.current },
            '',
            url.pathname + (url.search ? url.search : '')
          );
        } catch {
          // Ignore
        }
      }
    }
  }, []);

  // Load archive entries with optional history push
  const loadEntries = useCallback(
    async (subPath: string = '', pushHistory: boolean = true) => {
      setIsLoading(true);
      try {
        const url = getEntriesUrl(subPath);
        const res = await fetch(url);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Arşiv içeriği okunamadı.');
        }
        const data: ArchiveEntriesResponse = await res.json();
        setEntries(data.entries || []);
        setCurrentPath(subPath);

        if (pushHistory) {
          try {
            internalDepthRef.current += 1;
            const pageUrl = new URL(window.location.href);
            if (subPath) {
              pageUrl.searchParams.set('archivePath', subPath);
            } else {
              pageUrl.searchParams.set('archivePath', '/');
            }
            pageUrl.searchParams.delete('preview');
            window.history.pushState(
              { isArchiveModal: true, archivePath: subPath, previewPath: null, archiveDepth: internalDepthRef.current },
              '',
              pageUrl.pathname + (pageUrl.search ? pageUrl.search : '')
            );
          } catch {
            // Ignore
          }
        }
      } catch (err: any) {
        onShowToast('Arşiv Okuma Hatası', err.message, 'error');
        setEntries([]);
      } finally {
        setIsLoading(false);
      }
    },
    [getEntriesUrl, onShowToast]
  );

  // Initial load and URL synchronization when archive opens
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      internalDepthRef.current = 0;
      isUnwindingRef.current = false;

      let startPath = '';
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const initialPath = searchParams.get('archivePath');
        startPath = initialPath && initialPath !== '/' ? initialPath : '';
      } catch {
        startPath = '';
      }

      setCurrentPath(startPath);
      setSearch('');
      setPreviewFile({
        open: false,
        entry: null,
        content: '',
        isBinary: false,
        truncated: false,
        isLoading: false,
      });

      // Synchronize open state with browser history (replaceState avoids duplicate entry on initial open)
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('archivePath', startPath || '/');
        url.searchParams.delete('preview');
        window.history.replaceState(
          { isArchiveModal: true, archivePath: startPath, previewPath: null, archiveDepth: 0 },
          '',
          url.pathname + (url.search ? url.search : '')
        );
      } catch {
        // Ignore
      }

      loadEntries(startPath, false);
    } else if (!isOpen) {
      wasOpenRef.current = false;
      internalDepthRef.current = 0;
      isUnwindingRef.current = false;
    }
  }, [isOpen, loadEntries]);

  const modalContainerRef = useRef<HTMLDivElement>(null);

  const handleDownloadEntry = useCallback(
    async (itemPath: string, fileName: string) => {
      try {
        const url = getEntryDownloadUrl(itemPath);
        const res = await fetchWithAuth(url);
        if (!res.ok) throw new Error('Dosya indirilemedi');
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        onShowToast('İndirme Başlatıldı', `"${fileName}" indiriliyor.`, 'info');
      } catch (err: any) {
        onShowToast('İndirme Hatası', err.message, 'error');
      }
    },
    [getEntryDownloadUrl, onShowToast]
  );

  // Clean URL and unwind any orphaned history states when unmounting
  useEffect(() => {
    return () => {
      if (internalDepthRef.current > 0 && !isUnwindingRef.current) {
        isUnwindingRef.current = true;
        window.history.go(-internalDepthRef.current);
      }
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('archivePath') || url.searchParams.has('preview')) {
          url.searchParams.delete('archivePath');
          url.searchParams.delete('preview');
          window.history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
        }
      } catch {
        // Ignore
      }
    };
  }, []);

  // Browser back/forward (popstate) handling with capture & consumed flag
  useEffect(() => {
    if (!isOpen) return;

    const handlePopState = (e: PopStateEvent) => {
      if ((e as any).__consumed) return;
      if (isUnwindingRef.current) return;

      if (typeof e.state?.archiveDepth === 'number') {
        internalDepthRef.current = e.state.archiveDepth;
      } else {
        internalDepthRef.current = Math.max(0, internalDepthRef.current - 1);
      }

      let urlArchivePath: string | null = null;
      let urlPreviewPath: string | null = null;
      try {
        const url = new URL(window.location.href);
        urlArchivePath = url.searchParams.get('archivePath');
        urlPreviewPath = url.searchParams.get('preview');
      } catch {
        // Ignore
      }

      // If URL no longer has archivePath, user navigated back past the archive
      if (urlArchivePath === null) {
        onCloseRef.current();
        return;
      }

      // Consume this event so App.tsx does not process conflicting route transition
      e.stopImmediatePropagation();
      (e as any).__consumed = true;

      // 1. Preview state synchronization
      if (previewFileRef.current.open && !urlPreviewPath) {
        setPreviewFile((prev) => ({ ...prev, open: false, entry: null }));
      }

      // 2. Folder directory synchronization
      const target = urlArchivePath === '/' ? '' : urlArchivePath;
      if (target !== currentPathRef.current) {
        loadEntries(target, false);
      }
    };

    window.addEventListener('popstate', handlePopState, true);
    return () => window.removeEventListener('popstate', handlePopState, true);
  }, [isOpen, loadEntries]);

  // Modal focus trap
  useEffect(() => {
    if (!isOpen) return;
    const modalEl = modalContainerRef.current;
    if (!modalEl) return;

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusableEls = modalEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusableEls.length === 0) return;
      const firstEl = focusableEls[0];
      const lastEl = focusableEls[focusableEls.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstEl) {
          lastEl.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastEl) {
          firstEl.focus();
          e.preventDefault();
        }
      }
    };

    modalEl.addEventListener('keydown', handleTabKey);
    return () => modalEl.removeEventListener('keydown', handleTabKey);
  }, [isOpen]);

  // Keyboard navigation (Escape key)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (previewFileRef.current.open) {
          handleBackFromPreview();
        } else {
          handleCloseModal();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleBackFromPreview, handleCloseModal]);

  // Handle entry click (directory drill-down or file preview)
  const handleEntryClick = async (entry: ArchiveEntry) => {
    if (entry.type === 'directory') {
      loadEntries(entry.path, true);
      return;
    }

    // Open file preview
    setPreviewFile({
      open: true,
      entry,
      content: '',
      isBinary: false,
      truncated: false,
      isLoading: true,
    });

    try {
      internalDepthRef.current += 1;
      const pageUrl = new URL(window.location.href);
      if (currentPath) {
        pageUrl.searchParams.set('archivePath', currentPath);
      } else {
        pageUrl.searchParams.set('archivePath', '/');
      }
      pageUrl.searchParams.set('preview', entry.path);
      window.history.pushState(
        { isArchiveModal: true, archivePath: currentPath, previewPath: entry.path, archiveDepth: internalDepthRef.current },
        '',
        pageUrl.pathname + (pageUrl.search ? pageUrl.search : '')
      );
    } catch {
      // Ignore
    }

    try {
      const res = await fetch(getEntryPreviewUrl(entry.path));
      if (!res.ok) throw new Error('Dosya içeriği okunamadı.');
      const data: ArchiveEntryDetail = await res.json();

      setPreviewFile((prev) => ({
        ...prev,
        content: data.content || '',
        isBinary: !!data.binary,
        truncated: !!data.truncated,
        isLoading: false,
      }));
    } catch (err: any) {
      setPreviewFile((prev) => ({
        ...prev,
        content: `Önizleme yüklenemedi: ${err.message}`,
        isBinary: false,
        isLoading: false,
      }));
    }
  };

  const handleNavigateParent = () => {
    const segments = currentPath.split('/').filter(Boolean);
    const parentPath = segments.slice(0, -1).join('/');
    loadEntries(parentPath, true);
  };

  const filteredEntries = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, search]);

  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    return currentPath.split('/').filter(Boolean);
  }, [currentPath]);

  if (!isOpen) return null;

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) handleCloseModal();
      }}
      className="fixed inset-0 z-[250] flex items-center justify-center p-4 overflow-y-auto"
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={handleCloseModal}
        className="fixed inset-0 bg-black/85 backdrop-blur-xl"
      />

      <motion.div
        ref={modalContainerRef}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-4xl rounded-3xl bg-zinc-950 border border-white/10 shadow-[0_25px_80px_rgba(0,0,0,0.95)] p-6 z-10 flex flex-col h-[750px] max-h-[90vh] my-auto overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-3 rounded-2xl bg-white/10 border border-white/15 text-white shrink-0">
              <FileArchive className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-wide truncate">{title}</h3>
                <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-mono text-silver-300 border border-white/15">
                  Arşiv Tarayıcı
                </span>
              </div>
              <p className="text-xs text-silver-400 font-sans mt-0.5">
                Arşiv içerisindeki dosyaları salt okunur inceleyin ve dilediğiniz dosyayı tek tıkla indirin
              </p>
            </div>
          </div>

          <button
            onClick={handleCloseModal}
            aria-label="Arşiv Tarayıcısını Kapat"
            className="p-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-silver-400 hover:text-white transition-colors"
            title="Arşiv Tarayıcısını Kapat"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Path Bar, Breadcrumb & Controls */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 py-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-1.5 text-xs font-mono text-silver-400 overflow-x-auto py-1">
            <button
              onClick={() => loadEntries('', true)}
              className={`hover:text-white transition-colors px-2 py-1 rounded-lg ${
                !currentPath ? 'bg-white/10 text-white font-bold' : ''
              }`}
            >
              / (Kök)
            </button>
            {breadcrumbs.map((crumb, idx) => {
              const crumbSub = breadcrumbs.slice(0, idx + 1).join('/');
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <React.Fragment key={crumbSub}>
                  <span className="text-zinc-600">/</span>
                  <button
                    onClick={() => loadEntries(crumbSub, true)}
                    className={`hover:text-white transition-colors px-2 py-1 rounded-lg ${
                      isLast ? 'bg-white/10 text-white font-bold' : ''
                    }`}
                  >
                    {crumb}
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {currentPath && (
              <button
                onClick={handleNavigateParent}
                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs flex items-center gap-1 transition-all"
                title="Üst Klasöre Çık"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Üst Klasör</span>
              </button>
            )}

            <div className="relative w-48 sm:w-56">
              <Search className="w-3.5 h-3.5 text-silver-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Arşivde ara..."
                className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-zinc-900 border border-white/10 text-xs text-white placeholder-silver-500 font-mono focus:outline-none focus:border-white/30"
              />
            </div>

            <button
              onClick={() => loadEntries(currentPath, false)}
              disabled={isLoading}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 transition-all"
              title="Yenile"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-white' : ''}`} />
            </button>
          </div>
        </div>

        {/* Entries Table with Animated Folder Transitions */}
        <div className="flex-1 min-h-0 overflow-y-auto mt-2 pr-1 overscroll-contain [contain:content]">
          <AnimatePresence mode="wait">
            {isLoading ? (
              <motion.div
                key="loading-state"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="p-12 text-center text-xs text-silver-400 font-mono flex flex-col items-center justify-center gap-3"
              >
                <RefreshCw className="w-6 h-6 animate-spin text-white" />
                <span>Arşiv dizini okunuyor...</span>
              </motion.div>
            ) : filteredEntries.length === 0 ? (
              <motion.div
                key="empty-state"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="p-12 text-center text-xs text-silver-500 font-mono"
              >
                Bu klasörde içerik bulunmuyor veya aramayla eşleşen öge yok.
              </motion.div>
            ) : (
              <motion.div
                key={currentPath}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="min-h-full"
              >
                <table className="w-full text-left text-xs font-sans">
                  <thead>
                    <tr className="border-b border-white/5 text-silver-500 text-[11px] uppercase sticky top-0 bg-zinc-950 z-10 shadow-[0_1px_0_0_rgba(255,255,255,0.06)]">
                      <th className="pb-2.5 pt-1 font-semibold bg-zinc-950">Dosya / Klasör Adı</th>
                      <th className="pb-2.5 pt-1 font-semibold bg-zinc-950">Boyut</th>
                      <th className="pb-2.5 pt-1 font-semibold hidden sm:table-cell bg-zinc-950">Sıkıştırılmış</th>
                      <th className="pb-2.5 pt-1 font-semibold hidden md:table-cell bg-zinc-950">Tarih</th>
                      <th className="pb-2.5 pt-1 font-semibold text-right bg-zinc-950">İşlem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredEntries.map((item) => {
                      const isDir = item.type === 'directory';
                      const isDotFile = item.name.startsWith('.');
                      return (
                        <tr
                          key={item.path}
                          onClick={() => handleEntryClick(item)}
                          className={`hover:bg-white/[0.03] transition-colors cursor-pointer group ${
                            isDotFile ? 'opacity-65 italic' : ''
                          }`}
                        >
                          <td className="py-2.5 pr-2">
                            <div className="flex items-center gap-2.5">
                              <div className="shrink-0 not-italic">
                                {isDir ? (
                                  <Folder className="w-4 h-4 text-silver-300" />
                                ) : item.name.endsWith('.jar') ? (
                                  <Package className="w-4 h-4 text-white" />
                                ) : item.name.endsWith('.yml') || item.name.endsWith('.yaml') ? (
                                  <span className="px-1 py-0.5 rounded bg-white/10 text-white font-mono text-[8px] font-bold border border-white/20">
                                    YML
                                  </span>
                                ) : item.name.endsWith('.json') ? (
                                  <span className="px-1 py-0.5 rounded bg-white/10 text-white font-mono text-[8px] font-bold border border-white/20">
                                    JSON
                                  </span>
                                ) : item.name.endsWith('.properties') ? (
                                  <span className="px-1 py-0.5 rounded bg-white/10 text-white font-mono text-[8px] font-bold border border-white/20">
                                    PROP
                                  </span>
                                ) : (
                                  <File className="w-4 h-4 text-silver-400" />
                                )}
                              </div>
                              <span
                                className={`truncate font-mono ${
                                  isDir ? 'text-white font-semibold' : 'text-silver-300 group-hover:text-white'
                                }`}
                              >
                                {item.name}
                              </span>
                              {isDotFile && (
                                <span className="px-1.5 py-0.5 rounded bg-white/10 text-silver-400 text-[9px] font-mono font-semibold tracking-wider border border-white/10 uppercase select-none not-italic shrink-0 ml-1">
                                  GİZLİ
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="py-2.5 font-mono text-silver-400 text-xs">
                            {isDir ? '—' : formatBytes(item.sizeBytes)}
                          </td>

                          <td className="py-2.5 font-mono text-silver-500 text-xs hidden sm:table-cell">
                            {isDir ? '—' : item.compressedBytes !== undefined && item.compressedBytes !== null ? formatBytes(item.compressedBytes) : '—'}
                          </td>

                          <td className="py-2.5 text-silver-500 font-mono text-[11px] hidden md:table-cell">
                            {item.modifiedAt ? new Date(item.modifiedAt).toLocaleString('tr-TR') : '—'}
                          </td>

                          <td className="py-2.5 text-right">
                            <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                              {!isDir && (
                                <>
                                  <button
                                    onClick={() => handleEntryClick(item)}
                                    title="Önizle"
                                    className="p-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-silver-400 hover:text-white border border-white/10 transition-colors"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleDownloadEntry(item.path, item.name)}
                                    title="İndir"
                                    aria-label="İndir"
                                    className="p-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-silver-400 hover:text-white border border-white/10 transition-colors"
                                  >
                                    <Download className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* File Preview Animated Sub-Modal */}
        <AnimatePresence>
          {previewFile.open && (
            <motion.div
              initial={{ opacity: 0, scale: 0.97, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 12 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => {
                if (e.target === e.currentTarget) handleBackFromPreview();
              }}
              className="absolute inset-0 z-30 bg-black/95 backdrop-blur-2xl rounded-3xl p-6 flex flex-col border border-white/10 shadow-2xl"
            >
              {/* Preview Header */}
              <div className="flex items-center justify-between pb-3 border-b border-white/10 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  {/* Prominent Geri Dön Button with ArrowLeft icon */}
                  <button
                    onClick={handleBackFromPreview}
                    aria-label="Klasör Listesine Geri Dön"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/15 text-xs font-semibold transition-all shrink-0 active:scale-95 shadow-sm"
                    title="Klasör Listesine Geri Dön"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>Geri Dön</span>
                  </button>

                  <div className="p-2 rounded-xl bg-white/10 border border-white/15 text-white shrink-0">
                    <FileCode className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold text-white truncate font-mono">
                      {previewFile.entry?.name}
                    </h4>
                    <span className="text-[11px] text-silver-500 font-mono truncate block">
                      {previewFile.entry?.path} • {formatBytes(previewFile.entry?.sizeBytes)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {previewFile.entry && (
                    <button
                      onClick={() => previewFile.entry && handleDownloadEntry(previewFile.entry.path, previewFile.entry.name)}
                      aria-label="İndir"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white text-black font-semibold text-xs hover:bg-silver-200 transition-all shadow-sm active:scale-95"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>İndir</span>
                    </button>
                  )}

                  <button
                    onClick={handleBackFromPreview}
                    aria-label="Önizlemeyi Kapat"
                    className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-silver-400 hover:text-white transition-colors"
                    title="Önizlemeyi Kapat"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {previewFile.truncated && (
                <div className="p-2 my-2 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-300 text-xs font-mono shrink-0 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Bu dosya çok büyük olduğu için yalnızca ilk kısmı gösterilmektedir. Tamamını görüntülemek için indirin.</span>
                </div>
              )}

              <div className="flex-1 min-h-0 bg-zinc-900/90 rounded-2xl border border-white/10 p-4 overflow-auto font-mono text-xs text-zinc-300 whitespace-pre mt-3 select-text overscroll-contain [contain:content]">
                <AnimatePresence mode="wait">
                  {previewFile.isLoading ? (
                    <motion.div
                      key="preview-loading"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12 }}
                      className="flex items-center justify-center h-full text-silver-400 gap-2"
                    >
                      <RefreshCw className="w-4 h-4 animate-spin text-white" />
                      <span>Önizleme yükleniyor...</span>
                    </motion.div>
                  ) : previewFile.isBinary ? (
                    <motion.div
                      key="preview-binary"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12 }}
                      className="flex flex-col items-center justify-center h-full text-center text-silver-400 gap-3"
                    >
                      <HardDrive className="w-8 h-8 opacity-40 text-white" />
                      <p className="text-xs">Bu dosya ikili (binary) bir formatta ve doğrudan metin olarak görüntülenemez.</p>
                      <button
                        onClick={() => previewFile.entry && handleDownloadEntry(previewFile.entry.path, previewFile.entry.name)}
                        aria-label="Dosyayı İndir"
                        className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white border border-white/15 text-xs font-medium"
                      >
                        Dosyayı İndir
                      </button>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="preview-content"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      {previewFile.content || '(Dosya boş)'}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
