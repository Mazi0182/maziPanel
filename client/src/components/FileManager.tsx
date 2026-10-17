import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Folder, 
  FolderOpen,
  FileCode, 
  Save, 
  Trash2, 
  Download, 
  Search, 
  RefreshCw, 
  FolderPlus, 
  FilePlus, 
  X, 
  File, 
  ArrowLeft, 
  Package,
  Image as ImageIcon,
  Eye,
  Upload,
  FileJson,
  FileArchive,
  FileType,
  ChevronRight
} from 'lucide-react';
import { ServerFile, ServerInstance, TabType } from '../types';
import { ConfirmModal } from './ConfirmModal';
import { Tooltip } from './Tooltip';
import { SmoothEditor } from './SmoothEditor';
import { ArchiveBrowser } from './ArchiveBrowser';
import { fetchWithAuth } from '../auth/authSession';

export interface EditorTab {
  file: ServerFile;
  originalContent: string;
  content: string;
}

function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

const ARCHIVE_EXTENSIONS = ['.zip', '.jar', '.tar', '.tar.gz', '.tgz', '.gz'];

interface FileManagerProps {
  selectedServer: ServerInstance | null;
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
  urlFilePath?: string;
  onUrlPathChange?: (newPath: string) => void;
  onTabChange?: (tab: TabType) => void;
  resetTrigger?: number;
}

export const FileManager: React.FC<FileManagerProps> = ({ 
  selectedServer, 
  onShowToast,
  urlFilePath,
  onUrlPathChange,
  onTabChange,
  resetTrigger
}) => {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [fileList, setFileList] = useState<ServerFile[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [openTabsByServer, setOpenTabsByServer] = useState<Record<string, EditorTab[]>>({});
  const [activeTabPathByServer, setActiveTabPathByServer] = useState<Record<string, string | null>>({});
  const [isEditorOpenByServer, setIsEditorOpenByServer] = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const openTabsRef = useRef(openTabsByServer);
  openTabsRef.current = openTabsByServer;

  const currentServerId = selectedServer?.id || '';
  const currentTabs = useMemo(() => {
    return currentServerId ? (openTabsByServer[currentServerId] || []) : [];
  }, [currentServerId, openTabsByServer]);

  const activeTabPath = useMemo(() => {
    return currentServerId ? (activeTabPathByServer[currentServerId] || null) : null;
  }, [currentServerId, activeTabPathByServer]);

  const isEditorModalOpen = useMemo(() => {
    return currentServerId ? (isEditorOpenByServer[currentServerId] ?? false) : false;
  }, [currentServerId, isEditorOpenByServer]);

  const activeTab = useMemo(() => {
    return currentTabs.find((t) => t.file.path === activeTabPath) || null;
  }, [currentTabs, activeTabPath]);

  const isActiveTabModified = useMemo(() => {
    if (!activeTab) return false;
    return activeTab.content !== activeTab.originalContent;
  }, [activeTab]);

  const activeTabLines = useMemo(() => {
    return activeTab ? activeTab.content.split('\n') : [];
  }, [activeTab?.content]);

  // Archive Browser Modal State
  const [archiveModal, setArchiveModal] = useState<{
    open: boolean;
    file: ServerFile | null;
  }>({
    open: false,
    file: null,
  });
  const archiveOpenedFromNavRef = useRef(false);
  const editorDepthRef = useRef<number>(0);
  const isUnwindingRef = useRef<boolean>(false);

  // Reset archiveModal state when switching between servers
  useEffect(() => {
    setArchiveModal({ open: false, file: null });
    archiveOpenedFromNavRef.current = false;
  }, [selectedServer?.id]);

  // Request tracking to prevent race conditions and drop stale async responses
  const activeReqIdRef = useRef(0);

  // Stable refs for callbacks to decouple async loaders & effects from prop reference changes
  const onShowToastRef = useRef(onShowToast);
  onShowToastRef.current = onShowToast;
  const onUrlPathChangeRef = useRef(onUrlPathChange);
  onUrlPathChangeRef.current = onUrlPathChange;

  const handleDownloadFile = useCallback(
    async (targetPath: string, fileName: string) => {
      const serverId = selectedServer?.id;
      if (!serverId) return;
      try {
        const downloadUrl = `/api/servers/${serverId}/files/download?path=${encodeURIComponent(targetPath)}`;
        const res = await fetchWithAuth(downloadUrl);
        if (!res.ok) throw new Error('Dosya indirilemedi');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        onShowToastRef.current('İndirme Başlatıldı', `"${fileName}" başarıyla indirildi.`, 'success');
      } catch (err: any) {
        onShowToastRef.current('İndirme Hatası', err.message, 'error');
      }
    },
    [selectedServer?.id]
  );

  // Modals
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; file: ServerFile | null }>({
    open: false,
    file: null,
  });

  const [confirmDiscard, setConfirmDiscard] = useState<{
    open: boolean;
    tabToClose: EditorTab | null;
    nextAction?: () => void;
  }>({
    open: false,
    tabToClose: null,
  });

  const [createModal, setCreateModal] = useState<{ open: boolean; type: 'file' | 'folder'; name: string }>({
    open: false,
    type: 'file',
    name: '',
  });

  // Close create modal on ESC
  useEffect(() => {
    if (!createModal.open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setCreateModal({ open: false, type: 'file', name: '' });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [createModal.open]);

  // Clean unmount cancels any pending async response
  useEffect(() => {
    return () => {
      activeReqIdRef.current++;
    };
  }, []);

  // Safe navigation helper
  const navigateTo = useCallback((targetPath: string) => {
    onUrlPathChangeRef.current?.(targetPath);
  }, []);

  const onTabChangeRef = useRef(onTabChange);
  onTabChangeRef.current = onTabChange;

  // Log file detection: .log, .log.gz or files in logs/ folder
  const isLogFile = useCallback((file: ServerFile) => {
    if (file.type === 'directory') return false;
    const lowerName = file.name.toLowerCase();
    const lowerPath = file.path.toLowerCase();
    if (lowerName.endsWith('.log') || lowerName.endsWith('.log.gz')) return true;
    if (lowerPath.startsWith('logs/') || lowerPath.startsWith('logs\\')) {
      return lowerName.endsWith('.log') || lowerName.endsWith('.log.gz') || lowerName.endsWith('.gz');
    }
    return false;
  }, []);

  // Redirect to server logs tab with selected file
  const handleOpenLog = useCallback((file: ServerFile) => {
    if (!selectedServer) return;
    const logFileName = file.name;
    const targetUrl = `/${selectedServer.id}/logs?file=${encodeURIComponent(logFileName)}`;
    window.history.pushState({ tab: 'logs', serverId: selectedServer.id }, '', targetUrl);
    if (onTabChangeRef.current) {
      onTabChangeRef.current('logs');
    } else {
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, [selectedServer]);

  // Directory listing loader (for refresh, file create/delete)
  const loadDirectory = useCallback(async (dirPath: string) => {
    if (!selectedServer) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/servers/${selectedServer.id}/files?path=${encodeURIComponent(dirPath)}`);
      if (res.ok) {
        const data = await res.json();
        const entries: ServerFile[] = Array.isArray(data)
          ? data
          : Array.isArray((data as any)?.entries)
          ? (data as any).entries
          : Array.isArray((data as any)?.files)
          ? (data as any).files
          : [];
        setFileList(entries);
        setCurrentPath(dirPath);
      }
    } catch (err: any) {
      onShowToastRef.current('Dosya Yükleme Hatası', err.message, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [selectedServer?.id]);

  // Drag and drop state & handlers for file upload
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // Global dragend listener to reset counter if drag is cancelled outside
  useEffect(() => {
    const handleWindowDragEnd = () => {
      dragCounterRef.current = 0;
      setIsDragging(false);
    };
    window.addEventListener('dragend', handleWindowDragEnd);
    return () => window.removeEventListener('dragend', handleWindowDragEnd);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (archiveModal.open) return;
    if (e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
      dragCounterRef.current++;
      setIsDragging(true);
    }
  }, [archiveModal.open]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (archiveModal.open) return;

    // Alt elemanlara geçerken (relatedTarget bu kapsayıcı içindeyse) sayacı düşürme, overlay titremesini önle
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }

    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, [archiveModal.open]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (archiveModal.open) return;
    e.dataTransfer.dropEffect = 'copy';
  }, [archiveModal.open]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    if (archiveModal.open || !selectedServer) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    setIsLoading(true);
    onShowToastRef.current(
      'Dosyalar Yükleniyor',
      `${files.length} dosya yükleniyor...`,
      'info'
    );

    try {
      const formData = new FormData();
      formData.append('targetDir', currentPath);
      for (const f of files) {
        formData.append('files', f);
      }

      const res = await fetch(`/api/servers/${selectedServer.id}/files/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Dosyalar yüklenemedi.');
      }

      const data = await res.json().catch(() => ({}));
      const count = data.files?.length || files.length;
      onShowToastRef.current(
        'Yükleme Başarılı',
        `${count} dosya başarıyla yüklendi.`,
        'success'
      );
      loadDirectory(currentPath);
    } catch (err: any) {
      onShowToastRef.current('Yükleme Hatası', err.message, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [archiveModal.open, selectedServer, currentPath, loadDirectory]);

  // Handle resetTrigger cleanly without re-trigger loops
  const lastHandledResetTrigger = useRef(resetTrigger ?? 0);
  useEffect(() => {
    if (resetTrigger !== undefined && resetTrigger !== lastHandledResetTrigger.current) {
      lastHandledResetTrigger.current = resetTrigger;
      if (resetTrigger > 0) {
        navigateTo('');
      }
    }
  }, [resetTrigger, navigateTo]);

  // Resolve and load path: does not guess file vs folder from dots/extensions
  const resolveAndLoadPath = useCallback(async (
    serverId: string,
    targetPath: string,
    reqId: number,
    isCancelled: () => boolean
  ) => {
    const isStale = () => isCancelled() || activeReqIdRef.current !== reqId;
    setIsLoading(true);

    try {
      // 1. Root directory
      if (!targetPath) {
        const res = await fetch(`/api/servers/${serverId}/files?path=`);
        if (isStale()) return;
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          if (isStale()) return;
          throw new Error(errData.error || 'Dosya listesi alınamadı');
        }
        const data = await res.json();
        if (isStale()) return;

        const entries: ServerFile[] = Array.isArray(data)
          ? data
          : Array.isArray((data as any)?.entries)
          ? (data as any).entries
          : Array.isArray((data as any)?.files)
          ? (data as any).files
          : [];
        setFileList(entries);
        setCurrentPath('');
        setIsEditorOpenByServer((prev) => ({ ...prev, [serverId]: false }));
        if (!isUnwindingRef.current) {
          editorDepthRef.current = 0;
        }
        setArchiveModal({ open: false, file: null });
        archiveOpenedFromNavRef.current = false;
        try {
          const u = new URL(window.location.href);
          if (u.searchParams.has('archivePath') || u.searchParams.has('preview')) {
            u.searchParams.delete('archivePath');
            u.searchParams.delete('preview');
            window.history.replaceState(null, '', u.pathname + (u.search ? u.search : ''));
          }
        } catch {}
        return;
      }

      // 2. Non-root path: try listFiles first to test if it is a directory without guessing from extensions
      const dirRes = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(targetPath)}`);
      if (isStale()) return;

      if (dirRes.ok) {
        // It is a directory!
        const data = await dirRes.json();
        if (isStale()) return;

        const entries: ServerFile[] = Array.isArray(data)
          ? data
          : Array.isArray((data as any)?.entries)
          ? (data as any).entries
          : Array.isArray((data as any)?.files)
          ? (data as any).files
          : [];
        setFileList(entries);
        setCurrentPath(targetPath);
        setIsEditorOpenByServer((prev) => ({ ...prev, [serverId]: false }));
        if (!isUnwindingRef.current) {
          editorDepthRef.current = 0;
        }
        setArchiveModal({ open: false, file: null });
        archiveOpenedFromNavRef.current = false;
        try {
          const u = new URL(window.location.href);
          if (u.searchParams.has('archivePath') || u.searchParams.has('preview')) {
            u.searchParams.delete('archivePath');
            u.searchParams.delete('preview');
            window.history.replaceState(null, '', u.pathname + (u.search ? u.search : ''));
          }
        } catch {}
        return;
      }

      // If not 200, check error message
      const dirErrData = await dirRes.json().catch(() => ({}));
      if (isStale()) return;
      const errMsg = (dirErrData.error || '').toLowerCase();
      const isNotDirectory = dirRes.status === 400 && (errMsg.includes('not a directory') || errMsg.includes('dizin değil'));

      if (isNotDirectory) {
        // It is a file!
        const segments = targetPath.split('/').filter(Boolean);
        const fileName = segments[segments.length - 1] || '';
        const parentDir = segments.slice(0, -1).join('/');
        const lower = fileName.toLowerCase();

        // Check log file
        if (isLogFile({ name: fileName, path: targetPath, type: 'file' })) {
          setArchiveModal({ open: false, file: null });
          handleOpenLog({ name: fileName, path: targetPath, type: 'file' });
          return;
        }

        // Check archive
        const isArchive = ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
        if (isArchive) {
          setArchiveModal({ open: true, file: { name: fileName, path: targetPath, type: 'file' } });
          // Load parent directory
          const pRes = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(parentDir)}`);
          if (isStale()) return;
          if (pRes.ok) {
            const pData = await pRes.json();
            if (isStale()) return;
            const pEntries: ServerFile[] = Array.isArray(pData)
              ? pData
              : Array.isArray((pData as any)?.entries)
              ? (pData as any).entries
              : Array.isArray((pData as any)?.files)
              ? (pData as any).files
              : [];
            setFileList(pEntries);
            setCurrentPath(parentDir);
          }
          return;
        }

        // Normal / binary file - archive modal should not be open
        setArchiveModal({ open: false, file: null });

        // Check binary
        const binaryExtensions = ['.dat', '.png', '.jpg', '.jpeg', '.ico', '.webp'];
        const isBinary = binaryExtensions.some((ext) => lower.endsWith(ext));
        if (isBinary) {
          handleDownloadFile(targetPath, fileName);
          const pRes = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(parentDir)}`);
          if (isStale()) return;
          if (pRes.ok) {
            const pData = await pRes.json();
            if (isStale()) return;
            const pEntries: ServerFile[] = Array.isArray(pData)
              ? pData
              : Array.isArray((pData as any)?.entries)
              ? (pData as any).entries
              : Array.isArray((pData as any)?.files)
              ? (pData as any).files
              : [];
            setFileList(pEntries);
            setCurrentPath(parentDir);
          }
          return;
        }

        // Check if file is already open in tabs
        const currentOpenTabs = openTabsRef.current[serverId] || [];
        const existingTab = currentOpenTabs.find((t) => t.file.path === targetPath);

        // Fetch parent directory
        const parentRes = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(parentDir)}`);
        if (isStale()) return;

        if (parentRes.ok) {
          const pData = await parentRes.json();
          if (isStale()) return;
          const pEntries: ServerFile[] = Array.isArray(pData)
            ? pData
            : Array.isArray((pData as any)?.entries)
            ? (pData as any).entries
            : Array.isArray((pData as any)?.files)
            ? (pData as any).files
            : [];
          setFileList(pEntries);
          setCurrentPath(parentDir);
        }

        if (existingTab) {
          setActiveTabPathByServer((prev) => ({ ...prev, [serverId]: targetPath }));
          setIsEditorOpenByServer((prev) => ({ ...prev, [serverId]: true }));
          return;
        }

        // Fetch new file content
        const contentRes = await fetch(`/api/servers/${serverId}/files/content?path=${encodeURIComponent(targetPath)}`);
        if (isStale()) return;

        if (!contentRes.ok) {
          const cErr = await contentRes.json().catch(() => ({}));
          if (isStale()) return;
          throw new Error(cErr.error || 'Dosya içeriği okunamadı');
        }

        const contentData = await contentRes.json();
        if (isStale()) return;

        const newTab: EditorTab = {
          file: {
            name: fileName,
            path: targetPath,
            type: 'file',
            size: contentData.size,
          },
          originalContent: contentData.content || '',
          content: contentData.content || '',
        };

        setOpenTabsByServer((prev) => ({
          ...prev,
          [serverId]: [...(prev[serverId] || []).filter((t) => t.file.path !== targetPath), newTab],
        }));
        setActiveTabPathByServer((prev) => ({ ...prev, [serverId]: targetPath }));
        setIsEditorOpenByServer((prev) => ({ ...prev, [serverId]: true }));
        return;
      }

      // Neither directory nor valid file: path does not exist
      throw new Error(dirErrData.error || 'Yol bulunamadı');
    } catch (err: any) {
      if (!isStale()) {
        onShowToastRef.current('Dosya Yükleme Hatası', err.message, 'error');
        if (targetPath) {
          onUrlPathChangeRef.current?.('');
        }
      }
    } finally {
      if (!isStale()) {
        setIsLoading(false);
      }
    }
  }, []);

  // URL-driven synchronizer: App.tsx updates urlFilePath, FileManager resolves and loads it
  useEffect(() => {
    if (!selectedServer) return;
    const targetPath = urlFilePath || '';
    let isEffectCancelled = false;
    const reqId = ++activeReqIdRef.current;

    resolveAndLoadPath(selectedServer.id, targetPath, reqId, () => isEffectCancelled);

    return () => {
      isEffectCancelled = true;
    };
  }, [selectedServer?.id, urlFilePath, resolveAndLoadPath]);

  // Save specific tab
  const handleSaveTab = useCallback(async (tab: EditorTab) => {
    if (!selectedServer) return false;
    setIsSaving(true);

    try {
      const res = await fetch(`/api/servers/${selectedServer.id}/files/content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: tab.file.path,
          content: tab.content,
        }),
      });

      if (!res.ok) throw new Error('Dosya kaydedilemedi');

      setOpenTabsByServer((prev) => {
        const serverId = selectedServer.id;
        const tabs = prev[serverId] || [];
        return {
          ...prev,
          [serverId]: tabs.map((t) => (t.file.path === tab.file.path ? { ...t, originalContent: tab.content } : t)),
        };
      });

      onShowToastRef.current('Kaydedildi', `"${tab.file.name}" başarıyla güncellendi.`, 'success');
      loadDirectory(currentPath);
      return true;
    } catch (err: any) {
      onShowToastRef.current('Kayıt Hatası', err.message, 'error');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [selectedServer?.id, currentPath, loadDirectory]);

  // Save active tab (for Save button & Ctrl+S)
  const handleSaveActiveTab = useCallback(async () => {
    if (!activeTab || isSaving) return;
    if (activeTab.content === activeTab.originalContent) return;
    await handleSaveTab(activeTab);
  }, [activeTab, isSaving, handleSaveTab]);

  // Global Ctrl+S listener within editor modal
  useEffect(() => {
    if (!isEditorModalOpen) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSaveActiveTab();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isEditorModalOpen, handleSaveActiveTab]);

  // Close editor modal cleanly and unwind history stack
  const executeCloseModal = useCallback(() => {
    if (isUnwindingRef.current || !selectedServer) return;

    const serverId = selectedServer.id;
    const totalStepsToUnwind = editorDepthRef.current;
    editorDepthRef.current = 0;

    setIsEditorOpenByServer((prev) => ({ ...prev, [serverId]: false }));

    const targetUrl = currentPath
      ? `/${serverId}/files/${encodeURIComponent(currentPath).replace(/%2F/g, '/')}`
      : `/${serverId}/files`;

    if (totalStepsToUnwind > 0) {
      isUnwindingRef.current = true;
      try {
        window.history.replaceState(
          { tab: 'files', serverId, filePath: currentPath },
          '',
          targetUrl
        );
      } catch {
        // Ignore
      }

      window.history.go(-totalStepsToUnwind);

      setTimeout(() => {
        isUnwindingRef.current = false;
        onUrlPathChangeRef.current?.(currentPath);
      }, 150);
    } else {
      try {
        window.history.replaceState(
          { tab: 'files', serverId, filePath: currentPath },
          '',
          targetUrl
        );
      } catch {
        // Ignore
      }
      onUrlPathChangeRef.current?.(currentPath);
    }
  }, [selectedServer?.id, currentPath]);

  // Close editor modal with unsaved changes verification
  const handleCloseModal = useCallback(() => {
    if (!selectedServer) return;

    // Check if any open tab has unsaved changes
    const dirtyTab = currentTabs.find((t) => t.content !== t.originalContent);
    if (dirtyTab) {
      setConfirmDiscard({
        open: true,
        tabToClose: dirtyTab,
        nextAction: () => {
          executeCloseModal();
        },
      });
      return;
    }

    executeCloseModal();
  }, [selectedServer, currentTabs, executeCloseModal]);

  // Tab switching
  const handleSelectTab = useCallback((tabPath: string) => {
    if (!selectedServer) return;
    const serverId = selectedServer.id;
    if (activeTabPathByServer[serverId] === tabPath) return;

    editorDepthRef.current += 1;
    setActiveTabPathByServer((prev) => ({ ...prev, [serverId]: tabPath }));
    onUrlPathChangeRef.current?.(tabPath);
  }, [selectedServer?.id, activeTabPathByServer]);

  // Remove tab from openTabs
  const removeTab = useCallback((tabPath: string) => {
    if (!selectedServer) return;
    const serverId = selectedServer.id;
    const tabs = openTabsByServer[serverId] || [];
    const tabIndex = tabs.findIndex((t) => t.file.path === tabPath);
    if (tabIndex === -1) return;

    const newTabs = tabs.filter((t) => t.file.path !== tabPath);
    const currentActive = activeTabPathByServer[serverId];

    let nextActive = currentActive;
    if (currentActive === tabPath) {
      if (newTabs.length > 0) {
        const nextIndex = Math.min(tabIndex, newTabs.length - 1);
        nextActive = newTabs[nextIndex].file.path;
      } else {
        nextActive = null;
      }
    }

    setOpenTabsByServer((prev) => ({ ...prev, [serverId]: newTabs }));
    setActiveTabPathByServer((prev) => ({ ...prev, [serverId]: nextActive }));

    if (newTabs.length === 0) {
      executeCloseModal();
    } else if (currentActive === tabPath && nextActive) {
      editorDepthRef.current += 1;
      onUrlPathChangeRef.current?.(nextActive);
    }
  }, [selectedServer?.id, openTabsByServer, activeTabPathByServer, executeCloseModal]);

  // Close tab with unsaved changes verification
  const handleCloseTab = useCallback((tabPath: string) => {
    if (!selectedServer) return;
    const serverId = selectedServer.id;
    const tabs = openTabsByServer[serverId] || [];
    const tab = tabs.find((t) => t.file.path === tabPath);
    if (!tab) return;

    const isDirty = tab.content !== tab.originalContent;
    if (isDirty) {
      setConfirmDiscard({
        open: true,
        tabToClose: tab,
        nextAction: () => removeTab(tabPath),
      });
      return;
    }

    removeTab(tabPath);
  }, [selectedServer?.id, openTabsByServer, removeTab]);

  // Close editor modal on ESC key
  useEffect(() => {
    if (!isEditorModalOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCloseModal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditorModalOpen, handleCloseModal]);

  // Browser back/forward (popstate) handling for editor modal with capture & consumed flag
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if ((e as any).__consumed) return;
      if (archiveModal.open || isUnwindingRef.current) return;
      if (!isEditorModalOpen) return;

      const serverId = selectedServer?.id;
      if (!serverId) return;

      // Consume this event so App.tsx does not process a conflicting route navigation
      e.stopImmediatePropagation();
      (e as any).__consumed = true;

      // Check if any tab has unsaved changes
      const dirtyTab = currentTabs.find((t) => t.content !== t.originalContent);
      if (dirtyTab) {
        // User navigated back; temporarily push forward to maintain editor state while prompt is visible
        window.history.forward();
        setConfirmDiscard({
          open: true,
          tabToClose: dirtyTab,
          nextAction: () => {
            executeCloseModal();
          },
        });
        return;
      }

      // No unsaved changes: inspect URL pathname
      const pathname = window.location.pathname;
      const prefix = `/${serverId}/files`;
      let subPath = '';
      if (pathname.startsWith(prefix)) {
        subPath = decodeURIComponent(pathname.slice(prefix.length).replace(/^\/+/, ''));
      }

      if (!subPath || subPath === currentPath) {
        editorDepthRef.current = 0;
        setIsEditorOpenByServer((prev) => ({ ...prev, [serverId]: false }));
        onUrlPathChangeRef.current?.(currentPath);
      } else {
        editorDepthRef.current = Math.max(0, editorDepthRef.current - 1);
        const matchedTab = currentTabs.find((t) => t.file.path === subPath);
        if (matchedTab) {
          setActiveTabPathByServer((prev) => ({ ...prev, [serverId]: subPath }));
          onUrlPathChangeRef.current?.(subPath);
        }
      }
    };

    window.addEventListener('popstate', handlePopState, true);
    return () => window.removeEventListener('popstate', handlePopState, true);
  }, [
    archiveModal.open,
    isEditorModalOpen,
    selectedServer?.id,
    currentTabs,
    currentPath,
    executeCloseModal,
  ]);

  // Content change handler for tabs
  const handleTabContentChange = useCallback((tabPath: string, newContent: string) => {
    if (!selectedServer) return;
    const serverId = selectedServer.id;
    setOpenTabsByServer((prev) => {
      const tabs = prev[serverId] || [];
      return {
        ...prev,
        [serverId]: tabs.map((t) => (t.file.path === tabPath ? { ...t, content: newContent } : t)),
      };
    });
  }, [selectedServer?.id]);

  // Navigate folder or open file
  const handleSelectFile = (file: ServerFile) => {
    if (!selectedServer) return;

    if (file.type === 'directory') {
      navigateTo(file.path);
      return;
    }

    if (isLogFile(file)) {
      handleOpenLog(file);
      return;
    }

    const lower = file.name.toLowerCase();
    const isArchive = ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
    if (isArchive) {
      archiveOpenedFromNavRef.current = true;
      navigateTo(file.path);
      return;
    }

    const binaryExtensions = ['.dat', '.png', '.jpg', '.jpeg', '.ico', '.webp'];
    const isBinary = binaryExtensions.some((ext) => lower.endsWith(ext));
    if (isBinary) {
      handleDownloadFile(file.path, file.name);
      return;
    }

    // Check if file is already open in tabs
    const existingTab = currentTabs.find((t) => t.file.path === file.path);
    if (existingTab) {
      if (activeTabPath !== file.path) {
        editorDepthRef.current += 1;
        handleSelectTab(file.path);
      }
      setIsEditorOpenByServer((prev) => ({ ...prev, [selectedServer.id]: true }));
      return;
    }

    editorDepthRef.current += 1;
    navigateTo(file.path);
  };

  const handleNavigateParent = () => {
    const parent = pathBreadcrumbs.slice(0, -1).join('/');
    navigateTo(parent);
  };

  // Delete file or folder
  const handleDelete = async () => {
    const file = confirmDelete.file;
    if (!selectedServer || !file) return;

    try {
      const res = await fetch(`/api/servers/${selectedServer.id}/files?path=${encodeURIComponent(file.path)}`, {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Dosya silinemedi');
      onShowToastRef.current('Silindi', `"${file.name}" silindi.`, 'warning');
      setConfirmDelete({ open: false, file: null });

      if (currentServerId) {
        setOpenTabsByServer((prev) => {
          const tabs = prev[currentServerId] || [];
          return { ...prev, [currentServerId]: tabs.filter((t) => t.file.path !== file.path) };
        });
        if (activeTabPath === file.path) {
          const remaining = currentTabs.filter((t) => t.file.path !== file.path);
          const nextActive = remaining.length > 0 ? remaining[0].file.path : null;
          setActiveTabPathByServer((prev) => ({ ...prev, [currentServerId]: nextActive }));
          if (!nextActive) {
            setIsEditorOpenByServer((prev) => ({ ...prev, [currentServerId]: false }));
            onUrlPathChangeRef.current?.(currentPath);
          }
        }
      }

      loadDirectory(currentPath);
    } catch (err: any) {
      onShowToastRef.current('Silme Hatası', err.message, 'error');
    }
  };

  // Create file or folder
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedServer || !createModal.name.trim()) return;

    const endpoint = createModal.type === 'folder' 
      ? `/api/servers/${selectedServer.id}/files/create-folder`
      : `/api/servers/${selectedServer.id}/files/create-file`;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: currentPath,
          name: createModal.name.trim(),
          content: createModal.type === 'file' ? '# Yeni dosya\n' : undefined,
        }),
      });

      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'İşlem başarısız');
      }

      onShowToastRef.current(
        createModal.type === 'folder' ? 'Klasör Oluşturuldu' : 'Dosya Oluşturuldu',
        `"${createModal.name}" hazırlandı.`,
        'success'
      );
      setCreateModal({ open: false, type: 'file', name: '' });
      loadDirectory(currentPath);
    } catch (err: any) {
      onShowToastRef.current('Oluşturma Hatası', err.message, 'error');
    }
  };

  // Distinct neutral file icons by type & filled amber folder
  const getFileIcon = (file: ServerFile) => {
    if (file.type === 'directory') {
      return <Folder className="w-4 h-4 text-amber-400 fill-amber-400/25" />;
    }
    const name = file.name.toLowerCase();

    // JSON file
    if (name.endsWith('.json')) {
      return <FileJson className="w-4 h-4 text-silver-400" />;
    }

    // YAML / YML configuration file
    if (name.endsWith('.yml') || name.endsWith('.yaml')) {
      return <FileCode className="w-4 h-4 text-silver-400" />;
    }

    // Configuration / properties / ini / toml
    if (
      name.endsWith('.properties') || 
      name.endsWith('.toml') || 
      name.endsWith('.ini') || 
      name.endsWith('.cfg') || 
      name.endsWith('.conf')
    ) {
      return <FileType className="w-4 h-4 text-silver-400" />;
    }

    // Java JAR / core package
    if (name.endsWith('.jar')) {
      return <Package className="w-4 h-4 text-silver-400" />;
    }

    // Compressed archives (.zip, .tar, .gz, etc.)
    if (ARCHIVE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      return <FileArchive className="w-4 h-4 text-silver-400" />;
    }

    // Image assets
    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.ico') || name.endsWith('.webp')) {
      return <ImageIcon className="w-4 h-4 text-silver-400" />;
    }

    // Shell & batch & scripts
    if (
      name.endsWith('.sh') || 
      name.endsWith('.bat') || 
      name.endsWith('.cmd') || 
      name.endsWith('.js') || 
      name.endsWith('.ts') || 
      name.endsWith('.py') || 
      name.endsWith('.java')
    ) {
      return <FileCode className="w-4 h-4 text-silver-400" />;
    }

    // Plain text / logs / markdown (FileType used instead of restricted FileText)
    if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.log')) {
      return <FileType className="w-4 h-4 text-silver-400" />;
    }

    return <File className="w-4 h-4 text-silver-400" />;
  };

  const filteredFiles = useMemo(() => {
    const list = Array.isArray(fileList) ? fileList : [];
    const filtered = !search.trim()
      ? list
      : list.filter((f) => f && f.name && f.name.toLowerCase().includes(search.toLowerCase()));

    // Directories always sorted first, then files alphabetically
    return [...filtered].sort((a, b) => {
      const aIsDir = a.type === 'directory';
      const bIsDir = b.type === 'directory';
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
  }, [fileList, search]);

  const pathBreadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    return currentPath.split('/').filter(Boolean);
  }, [currentPath]);

  if (!selectedServer) {
    return (
      <div className="p-12 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 text-center flex flex-col items-center justify-center gap-3 shadow-2xl">
        <FolderOpen className="w-10 h-10 text-silver-500" />
        <h3 className="text-base font-bold text-white">Lütfen Bir Sunucu Seçin</h3>
        <p className="text-xs text-silver-400 font-mono">Dosya yöneticisini kullanmak için sol üstteki menüden bir sunucu seçin.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner & Path Header */}
      <div className="p-5 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="p-3 rounded-2xl bg-white/5 border border-white/10 text-white shrink-0">
            <FolderOpen className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-mono text-silver-400 flex-wrap">
              <button
                onClick={() => navigateTo('')}
                className="hover:text-white transition-colors flex items-center gap-1 font-bold text-white cursor-pointer"
              >
                <span>{selectedServer.name}</span>
              </button>
            <span>/</span>
            {pathBreadcrumbs.map((crumb, idx) => {
              const crumbPath = pathBreadcrumbs.slice(0, idx + 1).join('/');
              return (
                <React.Fragment key={crumbPath}>
                  <button
                    onClick={() => navigateTo(crumbPath)}
                    className="hover:text-white transition-colors cursor-pointer"
                  >
                    {crumb}
                  </button>
                  {idx < pathBreadcrumbs.length - 1 && <span>/</span>}
                </React.Fragment>
              );
            })}
          </div>
          <p className="text-[11px] text-silver-500 font-mono mt-1 truncate">
            {selectedServer.directory || `/mazideveloper/servers/${selectedServer.id}`}
          </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <Tooltip content="Yeni Klasör">
            <button
              onClick={() => setCreateModal({ open: true, type: 'folder', name: '' })}
              className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-silver-300 hover:text-white transition-all"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Klasör Ekle</span>
            </button>
          </Tooltip>

          <Tooltip content="Yeni Dosya">
            <button
              onClick={() => setCreateModal({ open: true, type: 'file', name: '' })}
              className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-silver-300 hover:text-white transition-all"
            >
              <FilePlus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Dosya Ekle</span>
            </button>
          </Tooltip>

          <Tooltip content="Listeyi Yenile">
            <button
              onClick={() => loadDirectory(currentPath)}
              disabled={isLoading}
              className="p-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-silver-300 hover:text-white transition-all"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-white' : ''}`} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* File Explorer Tree */}
      <div 
        className="w-full rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-5 flex flex-col h-[650px] max-h-[78vh] min-h-[500px] relative overflow-hidden"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag and Drop Upload Overlay */}
        <AnimatePresence>
          {isDragging && !archiveModal.open && (
            <motion.div
              key="file-drop-overlay"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="absolute inset-0 z-50 rounded-3xl bg-zinc-950/90 backdrop-blur-md border-2 border-dashed border-white/50 flex flex-col items-center justify-center p-6 text-center pointer-events-none select-none"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.85, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.85, y: 6 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="p-4 rounded-2xl bg-white/10 border border-white/20 text-white mb-3 shadow-xl"
              >
                <Upload className="w-8 h-8" />
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.18, delay: 0.02 }}
                className="text-sm font-bold text-white tracking-wide"
              >
                Yüklemek için dosyaları bırakın
              </motion.p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, delay: 0.04 }}
                className="text-xs text-silver-400 font-mono mt-1"
              >
                {currentPath ? `Hedef Dizin: /${currentPath}` : 'Hedef: Kök Dizin'}
              </motion.p>
            </motion.div>
          )}
        </AnimatePresence>
          {/* Search Bar */}
          <div className="relative mb-3 shrink-0">
            <Search className="w-3.5 h-3.5 text-silver-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Dosyalarda ara..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/10 text-xs text-white placeholder-silver-500 focus:outline-none focus:border-white/30 font-mono transition-all"
            />
          </div>

          {/* Files List with Smooth Navigation Animation */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1 pr-1 overscroll-contain">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentPath}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="space-y-1"
              >
                {filteredFiles.length === 0 ? (
                  <div className="p-8 text-center text-xs text-silver-500 font-mono">
                    {isLoading ? 'Dosyalar taranıyor...' : 'Bu klasörde dosya bulunmuyor.'}
                  </div>
                ) : (
                  filteredFiles.map((file) => {
                    const isSelected = activeTabPath === file.path;
                    const isArchive = ARCHIVE_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
                    const isDotFile = file.name.startsWith('.');
                    const isDirectory = file.type === 'directory';

                    return (
                      <div
                        key={file.path}
                        onClick={() => handleSelectFile(file)}
                        className={`flex items-center justify-between gap-2.5 px-3 py-2 rounded-2xl cursor-pointer transition-all group ${
                          isSelected
                            ? 'bg-white/15 text-white font-medium border border-white/20 shadow-sm'
                            : isDirectory
                            ? 'text-zinc-100 hover:text-white hover:bg-white/[0.06] border border-transparent'
                            : 'text-silver-300 hover:text-white hover:bg-white/[0.04] border border-transparent'
                        } ${isDotFile ? 'opacity-65 italic' : ''}`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className="shrink-0 flex items-center justify-center w-5 h-5 not-italic">
                            {getFileIcon(file)}
                          </div>
                          <span className={`truncate text-xs font-mono ${
                            isDirectory ? 'font-semibold text-white tracking-wide' : 'font-normal text-silver-300 group-hover:text-white'
                          }`}>
                            {file.name}
                          </span>
                          {isDotFile && (
                            <span className="px-1.5 py-0.5 rounded bg-white/10 text-silver-400 text-[9px] font-mono font-semibold tracking-wider border border-white/10 uppercase select-none not-italic shrink-0">
                              GİZLİ
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <div className="w-20 text-right font-mono tabular-nums shrink-0 text-[10px] text-silver-500 hidden sm:block not-italic">
                            {isDirectory
                              ? '—'
                              : file.size !== undefined && file.size !== null
                              ? (typeof file.size === 'number' ? formatBytes(file.size) : file.size)
                              : ''}
                          </div>

                          <div className="w-24 flex items-center justify-end gap-1 shrink-0">
                            {isDirectory ? (
                              <>
                                <ChevronRight className="w-3.5 h-3.5 text-silver-500/70 group-hover:text-amber-400 transition-colors shrink-0" />
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmDelete({ open: true, file });
                                  }}
                                  className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-lg hover:bg-white/10 text-silver-400 hover:text-white transition-all not-italic shrink-0"
                                  aria-label="Klasörü Sil"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              <>
                                {isArchive && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      archiveOpenedFromNavRef.current = true;
                                      navigateTo(file.path);
                                    }}
                                    title="Arşive Göz At"
                                    className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-lg hover:bg-white/10 text-silver-300 hover:text-white transition-all not-italic shrink-0"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                  </button>
                                )}

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDownloadFile(file.path, file.name);
                                  }}
                                  className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-lg hover:bg-white/10 text-silver-400 hover:text-white transition-all not-italic shrink-0"
                                  aria-label="Dosyayı İndir"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </button>

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmDelete({ open: true, file });
                                  }}
                                  className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-lg hover:bg-white/10 text-silver-400 hover:text-white transition-all not-italic shrink-0"
                                  aria-label="Dosyayı Sil"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

      {/* Archive Browser Modal for Files in Server */}
      {archiveModal.open && archiveModal.file && (
        <ArchiveBrowser
          isOpen={archiveModal.open}
          isOpenedFromNav={archiveOpenedFromNavRef.current}
          onClose={() => {
            const wasFromNav = archiveOpenedFromNavRef.current;
            archiveOpenedFromNavRef.current = false;
            setArchiveModal({ open: false, file: null });

            try {
              const url = new URL(window.location.href);
              url.searchParams.delete('archivePath');
              url.searchParams.delete('preview');
              window.history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
            } catch {
              // Ignore
            }

            if (!wasFromNav && selectedServer) {
              const parentDir = currentPath;
              const serverId = selectedServer.id;
              const targetUrl = parentDir
                ? `/${serverId}/files/${encodeURIComponent(parentDir).replace(/%2F/g, '/')}`
                : `/${serverId}/files`;
              try {
                window.history.replaceState(
                  { tab: 'files', serverId, filePath: parentDir },
                  '',
                  targetUrl
                );
              } catch {
                // Ignore
              }
              onUrlPathChangeRef.current?.(parentDir);
            }
          }}
          title={archiveModal.file.name}
          mode="file"
          serverId={selectedServer.id}
          filePath={archiveModal.file.path}
          onShowToast={onShowToast}
        />
      )}

      {/* Confirm File Delete Modal */}
      <ConfirmModal
        isOpen={confirmDelete.open}
        title="Dosyayı Sil"
        message={`"${confirmDelete.file?.name}" dosyasını kalıcı olarak silmek istediğinize emin misiniz? Bu işlem geri alınamaz.`}
        confirmText="Sil"
        cancelText="Vazgeç"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete({ open: false, file: null })}
      />

      {/* Confirm Discard Unsaved Changes Modal */}
      <ConfirmModal
        isOpen={confirmDiscard.open}
        title="Kaydedilmemiş Değişiklikler"
        message={
          confirmDiscard.tabToClose
            ? `"${confirmDiscard.tabToClose.file.name}" dosyasında kaydedilmemiş değişiklikleriniz var. Değişiklikleri kaybetmeden devam etmek istiyor musunuz?`
            : "Mevcut dosyada kaydedilmemiş değişiklikleriniz var. Değişiklikleri kaybetmeden devam etmek istiyor musunuz?"
        }
        confirmText="Yoksay"
        cancelText="Geri Dön"
        saveAndProceedText="Kaydet ve Devam Et"
        variant="warning"
        onSaveAndProceed={async () => {
          const tab = confirmDiscard.tabToClose;
          const action = confirmDiscard.nextAction;
          setConfirmDiscard({ open: false, tabToClose: null });
          if (tab) {
            await handleSaveTab(tab);
          }
          action?.();
        }}
        onConfirm={() => {
          const action = confirmDiscard.nextAction;
          setConfirmDiscard({ open: false, tabToClose: null });
          action?.();
        }}
        onCancel={() => setConfirmDiscard({ open: false, tabToClose: null })}
      />

      {/* SmoothEditor Luxury Fluid Monochrome Multi-Tab Modal */}
      {mounted && typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {isEditorModalOpen && currentTabs.length > 0 && (
            <div
              onClick={(e) => {
                if (e.target === e.currentTarget) handleCloseModal();
              }}
              className="fixed inset-0 z-[150] flex items-center justify-center p-3 sm:p-5 md:p-6 pointer-events-auto"
            >
              {/* Dark Overlay Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                onClick={handleCloseModal}
                className="fixed inset-0 bg-black/80 backdrop-blur-xl"
                aria-hidden="true"
              />

              {/* Wide Editor Modal Container */}
              <motion.div
                initial={{ opacity: 0, scale: 0.97, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: 12 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
                className="relative w-full max-w-[1500px] h-[92vh] max-h-[94vh] rounded-3xl bg-zinc-950/95 border border-white/15 shadow-[0_30px_90px_rgba(0,0,0,0.95)] p-4 sm:p-5 flex flex-col z-10 backdrop-blur-2xl overflow-hidden pointer-events-auto"
              >
                {/* Header: Tab Bar & Actions */}
                <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/10 mb-3 shrink-0">
                  {/* Tab Bar */}
                  <div className="flex items-center gap-1.5 overflow-x-auto min-w-0 flex-1 no-scrollbar py-0.5">
                    {currentTabs.map((tab) => {
                      const isActive = tab.file.path === activeTabPath;
                      const isDirty = tab.content !== tab.originalContent;

                      return (
                        <div
                          key={tab.file.path}
                          onClick={() => handleSelectTab(tab.file.path)}
                          className={`group flex items-center gap-2 px-3 py-1.5 rounded-xl border cursor-pointer transition-all text-xs font-mono shrink-0 select-none ${
                            isActive
                              ? 'bg-white/15 text-white font-medium border-white/25 shadow-sm'
                              : 'bg-white/[0.03] text-silver-400 hover:text-silver-200 hover:bg-white/[0.07] border-white/5'
                          }`}
                        >
                          <div className="shrink-0 flex items-center justify-center w-4 h-4 not-italic">
                            {getFileIcon(tab.file)}
                          </div>
                          <span className="truncate max-w-[140px] sm:max-w-[200px]">{tab.file.name}</span>

                          {/* Unsaved changes dot indicator */}
                          {isDirty && (
                            <span
                              className="w-2 h-2 rounded-full bg-amber-400 shrink-0"
                              title="Kaydedilmemiş değişiklikler"
                            />
                          )}

                          {/* Tab close (X) button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCloseTab(tab.file.path);
                            }}
                            className="p-0.5 rounded-md text-silver-400 hover:text-white hover:bg-white/15 transition-colors shrink-0"
                            title="Sekmeyi Kapat"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Header Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {activeTab && (
                      <>
                        {isActiveTabModified && (
                          <span className="hidden sm:inline-block px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-mono text-silver-200 border border-white/15">
                            Düzenlendi
                          </span>
                        )}

                        <Tooltip content="Dosyayı İndir">
                          <button
                            onClick={() => {
                              handleDownloadFile(activeTab.file.path, activeTab.file.name);
                            }}
                            className="p-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-silver-300 hover:text-white transition-all text-xs"
                            aria-label="Dosyayı İndir"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>

                        <button
                          onClick={handleSaveActiveTab}
                          disabled={isSaving || !isActiveTabModified}
                          className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.25)] active:scale-95 disabled:opacity-40"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>{isSaving ? 'Kaydediliyor...' : 'Kaydet'}</span>
                        </button>
                      </>
                    )}

                    <Tooltip content="Editörü Kapat">
                      <button
                        onClick={handleCloseModal}
                        className="p-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-silver-300 hover:text-white transition-all text-xs"
                        aria-label="Editörü Kapat"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                </div>

                {/* Multi-Tab Smooth Editor Container */}
                <div className="relative flex-1 min-h-0 rounded-2xl bg-black/80 border border-white/10 overflow-hidden transition-all flex flex-col">
                  <div className="flex-1 min-h-0 overflow-hidden relative">
                    {currentTabs.map((tab) => {
                      const isActive = tab.file.path === activeTabPath;
                      return (
                        <div
                          key={tab.file.path}
                          className={`absolute inset-0 flex flex-col ${isActive ? 'z-10 visible' : 'pointer-events-none invisible z-0'}`}
                        >
                          <SmoothEditor
                            value={tab.content}
                            onChange={(val) => handleTabContentChange(tab.file.path, val)}
                            onSave={handleSaveActiveTab}
                            fileName={tab.file.name}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {/* Calm, Static Footer Status Bar */}
                  <div className="flex items-center justify-between px-4 py-2 bg-white/[0.02] border-t border-white/5 text-[11px] font-mono text-silver-500 shrink-0 select-none">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${isActiveTabModified ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                      <span className="text-silver-300 font-sans text-xs">
                        {isActiveTabModified ? 'Değişiklikler var (Ctrl+S)' : 'Kayıtlı'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 tabular-nums font-mono text-xs">
                      {activeTab && (
                        <>
                          <span>{activeTabLines.length} Satır</span>
                          <span className="uppercase text-silver-400">
                            {activeTab.file.name.endsWith('.json')
                              ? 'JSON'
                              : activeTab.file.name.endsWith('.yml') || activeTab.file.name.endsWith('.yaml')
                              ? 'YAML'
                              : activeTab.file.name.endsWith('.properties')
                              ? 'Properties'
                              : 'Metin'}
                          </span>
                          <span>UTF-8</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Create File / Folder Modal */}
      <AnimatePresence>
        {createModal.open && (
          <div 
            onClick={(e) => {
              if (e.target === e.currentTarget) setCreateModal({ open: false, type: 'file', name: '' });
            }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setCreateModal({ open: false, type: 'file', name: '' })}
              className="fixed inset-0 bg-black/80 backdrop-blur-xl"
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              role="dialog"
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-md rounded-3xl bg-zinc-950/95 border border-white/10 shadow-2xl p-6 z-10 backdrop-blur-2xl"
            >
              <button
                onClick={() => setCreateModal({ open: false, type: 'file', name: '' })}
                className="absolute top-5 right-5 p-1.5 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 rounded-2xl bg-white/5 border border-white/10 text-white">
                  {createModal.type === 'folder' ? <FolderPlus className="w-5 h-5" /> : <FilePlus className="w-5 h-5" />}
                </div>
                <div>
                  <h3 className="text-base font-bold text-white tracking-wide">
                    {createModal.type === 'folder' ? 'Yeni Klasör Oluştur' : 'Yeni Dosya Oluştur'}
                  </h3>
                  <p className="text-xs text-silver-400 font-mono">Dizin: /{currentPath}</p>
                </div>
              </div>

              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                    {createModal.type === 'folder' ? 'Klasör Adı' : 'Dosya Adı'}
                  </label>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={createModal.name}
                    onChange={(e) => setCreateModal((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder={createModal.type === 'folder' ? 'klasor-adi' : 'ornek.yml'}
                    className="w-full px-4 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white focus:outline-none focus:border-white/40 font-mono"
                  />
                </div>

                <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setCreateModal({ open: false, type: 'file', name: '' })}
                    className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium"
                  >
                    Vazgeç
                  </button>
                  <button
                    type="submit"
                    disabled={!createModal.name.trim()}
                    className="px-5 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs shadow-md disabled:opacity-40"
                  >
                    Oluştur
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
