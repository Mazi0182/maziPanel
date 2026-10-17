import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Archive, 
  DownloadCloud, 
  Trash2, 
  ArchiveRestore, 
  FolderPlus, 
  RefreshCw, 
  Server, 
  CheckCircle2, 
  FolderArchive,
  HardDrive,
  Calendar,
  Layers,
  ChevronDown,
  X,
  FileCheck,
  Save,
  Clock,
  Check,
  Eye,
  Info,
  AlertCircle
} from 'lucide-react';
import { ServerInstance } from '../types';
import { BackupItem, BackupSchedule } from '../types/backups';
import { CustomSelect } from './CustomSelect';
import { ConfirmModal } from './ConfirmModal';
import { ArchiveBrowser } from './ArchiveBrowser';
import { fetchWithAuth } from '../auth/authSession';

function formatBytes(bytes?: number | null, decimals = 1): string {
  if (bytes === undefined || bytes === null || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

interface BackupManagerProps {
  selectedServer: ServerInstance | null;
  servers: ServerInstance[];
  onSelectServer: (server: ServerInstance) => void;
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
  onOpenNewServerModal?: () => void;
}

const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  frequency: 'daily',
  intervalHours: 6,
  intervalWindow: null,
  dailyTime: '04:00',
  weeklyDays: [0], // Pazar
  weeklyTime: '03:00',
  name: '',
  format: 'zip',
  level: 6,
  exclusions: ['logs', 'cache', 'crash-reports'],
  maxBackups: null, // Boş = sınırsız
  singleFile: false,
  targetBackupId: '',
  runImmediately: true,
  nextRunAt: null,
  lastRunAt: null,
  lastResult: null,
};

const DAYS_OF_WEEK = [
  { id: 1, label: 'Pzt' },
  { id: 2, label: 'Sal' },
  { id: 3, label: 'Çar' },
  { id: 4, label: 'Per' },
  { id: 5, label: 'Cum' },
  { id: 6, label: 'Cmt' },
  { id: 0, label: 'Paz' },
];

export const BackupManager: React.FC<BackupManagerProps> = ({
  selectedServer,
  servers,
  onSelectServer,
  onShowToast,
  onOpenNewServerModal,
}) => {
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Archive Browser Modal
  const [browserModal, setBrowserModal] = useState<{
    open: boolean;
    backup: BackupItem | null;
  }>({
    open: false,
    backup: null,
  });

  // Creation form state
  const [backupName, setBackupName] = useState('');
  const [format, setFormat] = useState<'zip' | 'tar.gz' | 'tar'>('zip');
  const [compressionLevel, setCompressionLevel] = useState<number>(6);
  const [singleFileMode, setSingleFileMode] = useState<boolean>(false);
  const [targetBackupId, setTargetBackupId] = useState<string>('');
  const [excludeLogs, setExcludeLogs] = useState(true);
  const [excludeCache, setExcludeCache] = useState(true);
  const [excludeCrashReports, setExcludeCrashReports] = useState(true);
  const [customExcludes, setCustomExcludes] = useState('');

  // Schedule Policy State
  const [initialSchedule, setInitialSchedule] = useState<BackupSchedule>(DEFAULT_SCHEDULE);
  const [schedule, setSchedule] = useState<BackupSchedule>(DEFAULT_SCHEDULE);
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [useIntervalWindow, setUseIntervalWindow] = useState(false);
  const [windowFrom, setWindowFrom] = useState('08:00');
  const [windowTo, setWindowTo] = useState('22:00');

  // Confirmation Modals
  const [restoreModal, setRestoreModal] = useState<{ open: boolean; backup: BackupItem | null }>({
    open: false,
    backup: null,
  });
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; backup: BackupItem | null }>({
    open: false,
    backup: null,
  });

  // Is schedule dirty?
  const isScheduleDirty = useMemo(() => {
    return JSON.stringify(initialSchedule) !== JSON.stringify(schedule);
  }, [initialSchedule, schedule]);

  // Fetch Backups
  const fetchBackups = useCallback(async () => {
    if (!selectedServer) {
      setBackups([]);
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch(`/api/backups?serverId=${selectedServer.id}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Yedek listesi alınamadı');
      const data = await res.json();
      const list: BackupItem[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.backups)
        ? data.backups
        : [];
      setBackups(list);
    } catch (err: any) {
      console.warn('Backups fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [selectedServer?.id]);

  // Fetch Schedule
  const fetchSchedule = useCallback(async () => {
    if (!selectedServer) return;
    try {
      const res = await fetch(`/api/backups/schedules/${selectedServer.id}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        const merged: BackupSchedule = {
          enabled: !!data.enabled,
          frequency: data.frequency || 'daily',
          intervalHours: data.intervalHours ?? 6,
          intervalWindow: data.intervalWindow ?? null,
          dailyTime: data.dailyTime || '04:00',
          weeklyDays: Array.isArray(data.weeklyDays) ? data.weeklyDays : [0],
          weeklyTime: data.weeklyTime || '03:00',
          name: data.name || '',
          format: data.format || 'zip',
          level: data.level ?? 6,
          exclusions: Array.isArray(data.exclusions) ? data.exclusions : ['logs', 'cache'],
          maxBackups: data.maxBackups !== undefined ? data.maxBackups : null,
          singleFile: !!data.singleFile,
          targetBackupId: data.targetBackupId || '',
          runImmediately: data.runImmediately !== undefined ? !!data.runImmediately : true,
          nextRunAt: data.nextRunAt ?? null,
          lastRunAt: data.lastRunAt ?? null,
          lastResult: data.lastResult ?? null,
        };
        setInitialSchedule(merged);
        setSchedule(merged);
        if (merged.intervalWindow) {
          setUseIntervalWindow(true);
          setWindowFrom(merged.intervalWindow.from || '08:00');
          setWindowTo(merged.intervalWindow.to || '22:00');
        } else {
          setUseIntervalWindow(false);
        }
      }
    } catch (err) {
      console.warn('Failed to fetch schedule:', err);
    }
  }, [selectedServer?.id]);

  useEffect(() => {
    fetchBackups();
    fetchSchedule();
  }, [fetchBackups, fetchSchedule]);

  // Save Schedule
  const handleSaveSchedule = async () => {
    if (!selectedServer || !isScheduleDirty) return;
    setIsSavingSchedule(true);

    try {
      const payload: BackupSchedule = {
        ...schedule,
        intervalWindow:
          schedule.frequency === 'interval' && useIntervalWindow
            ? { from: windowFrom, to: windowTo }
            : null,
      };

      const res = await fetch(`/api/backups/schedules/${selectedServer.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Zamanlama kaydedilemedi.');
      }

      const updated = await res.json().catch(() => payload);
      setInitialSchedule(updated);
      setSchedule(updated);
      onShowToast(
        'Zamanlama Kaydedildi',
        updated.enabled && updated.runImmediately !== false
          ? 'Plan kaydedildi ve ilk yedekleme işlemi arka planda hemen başlatıldı!'
          : 'Otomatik yedekleme planı başarıyla güncellendi.',
        'success'
      );
      if (updated.enabled && updated.runImmediately !== false) {
        setTimeout(() => {
          fetchBackups();
          fetchSchedule();
        }, 4000);
      }
    } catch (err: any) {
      onShowToast('Kayıt Hatası', err.message || 'Zamanlama kaydedilemedi.', 'error');
    } finally {
      setIsSavingSchedule(false);
    }
  };

  // Create Backup
  const handleCreateBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedServer) return;

    const exclusions: string[] = [];
    if (excludeLogs) exclusions.push('logs');
    if (excludeCache) exclusions.push('cache');
    if (excludeCrashReports) exclusions.push('crash-reports');
    if (customExcludes.trim()) {
      customExcludes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => exclusions.push(s));
    }

    setIsCreating(true);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const res = await fetch('/api/backups', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          serverId: selectedServer.id,
          name: backupName.trim() || undefined,
          format: singleFileMode ? 'zip' : format,
          level: compressionLevel,
          exclusions,
          singleFile: singleFileMode,
          targetBackupId: singleFileMode && targetBackupId ? targetBackupId : undefined,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Yedekleme oluşturulamadı.');
      }

      onShowToast('Yedek Oluşturuldu', 'Sunucu arşivi başarıyla paketlendi ve kaydedildi.', 'success');
      setShowCreateModal(false);
      setBackupName('');
      fetchBackups();
    } catch (err: any) {
      onShowToast('Yedekleme Hatası', err.message || 'Yedekleme sırasında bir hata oluştu.', 'error');
    } finally {
      setIsCreating(false);
    }
  };

  // Restore Backup
  const handleConfirmRestore = async () => {
    if (!restoreModal.backup || !selectedServer) return;
    const backup = restoreModal.backup;
    setRestoreModal({ open: false, backup: null });

    try {
      const res = await fetch(`/api/backups/${backup.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ forceStop: true }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Geri yükleme başarısız oldu.');
      }

      onShowToast('Geri Yüklendi', `"${backup.name}" yedeği başarıyla sunucuya uygulandı.`, 'success');
    } catch (err: any) {
      onShowToast('Geri Yükleme Hatası', err.message || 'Geri yüklenirken bir sorun oluştu.', 'error');
    }
  };

  // Delete Backup
  const handleConfirmDelete = async () => {
    if (!deleteModal.backup) return;
    const backup = deleteModal.backup;
    setDeleteModal({ open: false, backup: null });

    try {
      const res = await fetch(`/api/backups/${backup.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Yedek silinemedi.');
      }

      onShowToast('Yedek Silindi', `"${backup.name}" arşivi diskten kaldırıldı.`, 'info');
      fetchBackups();
    } catch (err: any) {
      onShowToast('Silme Hatası', err.message || 'Yedek silinirken bir sorun oluştu.', 'error');
    }
  };

  const handleDownload = async (backup: BackupItem) => {
    try {
      onShowToast('İndirme Başlatıldı', `"${backup.filename}" hazırlanıyor...`, 'info');
      const res = await fetchWithAuth(`/api/backups/${backup.id}/download`);
      if (!res.ok) throw new Error('Yedek indirilemedi.');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = backup.filename || `${backup.name}.tar.gz`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      onShowToast('İndirme Tamamlandı', `"${backup.filename}" başarıyla indirildi.`, 'success');
    } catch (err: any) {
      onShowToast('İndirme Hatası', err.message || 'Yedek indirilirken bir sorun oluştu.', 'error');
    }
  };

  const totalSizeBytes = backups.reduce((acc, b) => acc + (b.sizeBytes || 0), 0);
  const formatTotalSize = (bytes: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getCompressionLevelDesc = (lvl: number) => {
    if (lvl === 0) return '0 (Sadece Paketle - Sıfır CPU)';
    if (lvl <= 2) return `${lvl} (Çok Hızlı)`;
    if (lvl <= 5) return `${lvl} (Hızlı & Dengeli)`;
    if (lvl <= 7) return `${lvl} (Dengeli Sıkıştırma - Önerilen)`;
    return `${lvl} (En Küçük Boyut - Yüksek CPU)`;
  };

  if (servers.length === 0 || !selectedServer) {
    return (
      <div className="p-12 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 text-center flex flex-col items-center justify-center gap-4 shadow-2xl max-w-2xl mx-auto my-8">
        <div className="p-4 rounded-2xl bg-white/5 border border-white/10 text-silver-400">
          <Archive className="w-8 h-8 text-silver-300" />
        </div>
        <div className="space-y-1">
          <h3 className="text-base font-bold text-white tracking-wide">Henüz Bir Sunucu Bulunmuyor</h3>
          <p className="text-xs text-silver-400 font-sans max-w-md mx-auto">
            Yedekleme oluşturabilmek için önce bir Minecraft sunucusu oluşturun.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner & Control Bar */}
      <div className="p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="p-3 rounded-2xl bg-white/10 border border-white/15 text-white">
            <Archive className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white tracking-wide">Yedekleme ve Geri Yükleme</h2>
            <p className="text-xs text-silver-400 font-sans mt-0.5">
              "{selectedServer.name}" dünyalarını, eklentilerini ve yapılandırmalarını güvenle arşivleyin
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {servers.length > 1 && (
            <div className="w-48 sm:w-56">
              <CustomSelect
                value={selectedServer.id}
                onChange={(newId) => {
                  const target = servers.find((s) => s.id === newId);
                  if (target) onSelectServer(target);
                }}
                options={servers.map((s) => ({
                  value: s.id,
                  label: s.name,
                  desc: s.status === 'online' ? 'Çevrimiçi' : 'Çevrimdışı',
                  icon: Server,
                }))}
              />
            </div>
          )}

          <button
            onClick={fetchBackups}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-sans text-silver-300 hover:text-white transition-all disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-white' : ''}`} />
            <span>Yenile</span>
          </button>

          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.25)] active:scale-95"
          >
            <FolderPlus className="w-4 h-4" />
            <span>Yeni Yedek Oluştur</span>
          </button>
        </div>
      </div>

      {/* Overview Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-3xl glass-panel bg-white/[0.02] border border-white/10 flex items-center justify-between">
          <div>
            <span className="text-[11px] font-sans text-silver-400 uppercase tracking-wider block">
              Toplam Yedek Sayısı
            </span>
            <span className="text-xl font-bold font-mono text-white mt-1 block">{backups.length}</span>
          </div>
          <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10 text-silver-300">
            <FolderArchive className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-3xl glass-panel bg-white/[0.02] border border-white/10 flex items-center justify-between">
          <div>
            <span className="text-[11px] font-sans text-silver-400 uppercase tracking-wider block">
              Toplam Arşiv Boyutu
            </span>
            <span className="text-xl font-bold font-mono text-white mt-1 block">
              {formatTotalSize(totalSizeBytes)}
            </span>
          </div>
          <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10 text-silver-300">
            <HardDrive className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-3xl glass-panel bg-white/[0.02] border border-white/10 flex items-center justify-between">
          <div>
            <span className="text-[11px] font-sans text-silver-400 uppercase tracking-wider block">
              Sonraki Otomatik Çalışma
            </span>
            <span className="text-xs font-mono text-silver-300 mt-1 block truncate max-w-[200px]">
              {schedule.enabled && schedule.nextRunAt
                ? new Date(schedule.nextRunAt).toLocaleString('tr-TR')
                : schedule.enabled
                ? 'Hesaplanıyor...'
                : 'Zamanlama Kapalı'}
            </span>
          </div>
          <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10 text-silver-300">
            <Clock className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Automatic Backup Scheduling Card */}
      <div className="rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-6 relative z-20">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b border-white/10 gap-3 mb-5">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10 text-white">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white tracking-wide">Otomatik Yedekleme Planı</h3>
                {isScheduleDirty && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-300 text-[10px] font-mono border border-amber-400/20">
                    Kaydedilmemiş
                  </span>
                )}
              </div>
              <p className="text-[11px] text-silver-400 font-sans mt-0.5">
                Periyodik veya takvime dayalı otomatik arşiv paketleme düzeni
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setSchedule((prev) => ({ ...prev, enabled: !prev.enabled }))}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                schedule.enabled
                  ? 'bg-white text-black font-semibold border-white shadow-md'
                  : 'bg-white/5 text-silver-400 border-white/10 hover:text-white'
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${schedule.enabled ? 'bg-black' : 'bg-zinc-600'}`} />
              <span>{schedule.enabled ? 'Yedekleme Planı: Aktif' : 'Yedekleme Planı: Devre Dışı'}</span>
            </button>

            <button
              onClick={handleSaveSchedule}
              disabled={!isScheduleDirty || isSavingSchedule}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-white hover:bg-silver-200 text-black font-semibold text-xs shadow-md transition-all disabled:opacity-40"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSavingSchedule ? 'Kaydediliyor...' : 'Kaydet'}</span>
            </button>
          </div>
        </div>

        {/* Schedule Inputs Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Frequency & Timing (7 cols) */}
          <div className="lg:col-span-7 space-y-4">
            <div>
              <label className="text-xs font-semibold text-silver-300 mb-2 block">Yedekleme Sıklığı</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'interval', label: 'Belirli Aralıklarla' },
                  { id: 'daily', label: 'Her Gün' },
                  { id: 'weekly', label: 'Haftalık' },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    disabled={!schedule.enabled}
                    onClick={() => setSchedule((prev) => ({ ...prev, frequency: f.id as any }))}
                    className={`py-2 px-3 rounded-2xl text-xs font-semibold border transition-all disabled:opacity-40 ${
                      schedule.frequency === f.id
                        ? 'bg-white/15 text-white border-white/30 shadow-sm'
                        : 'bg-white/[0.02] text-silver-400 border-white/10 hover:text-white'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Sub-config by Frequency */}
            {schedule.frequency === 'interval' && (
              <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-silver-300">Aralık (Saat)</label>
                  <span className="text-xs font-mono font-bold text-white">Her {schedule.intervalHours} saatte bir</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={24}
                  disabled={!schedule.enabled}
                  value={schedule.intervalHours || 6}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setSchedule((prev) => ({ ...prev, intervalHours: val }));
                  }}
                  className="w-full accent-white h-1.5 bg-white/10 rounded-lg cursor-pointer disabled:opacity-40"
                />

                <div className="pt-2 border-t border-white/5 space-y-2">
                  <label className="flex items-center gap-2 text-xs text-silver-300 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!schedule.enabled}
                      checked={schedule.runImmediately !== false}
                      onChange={(e) => setSchedule((prev) => ({ ...prev, runImmediately: e.target.checked }))}
                      className="rounded accent-white"
                    />
                    <span>Açıldığında / kaydedildiğinde hemen ilk yedeği al ve periyodu başlat</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-silver-300 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!schedule.enabled}
                      checked={useIntervalWindow}
                      onChange={(e) => setUseIntervalWindow(e.target.checked)}
                      className="rounded accent-white"
                    />
                    <span>İsteğe bağlı saat aralığı uygula (örn: sadece gündüz çalışsın)</span>
                  </label>

                  {useIntervalWindow && (
                    <div className="flex items-center gap-3 pt-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-silver-400 font-mono">Başlangıç:</span>
                        <input
                          type="time"
                          value={windowFrom}
                          onChange={(e) => setWindowFrom(e.target.value)}
                          className="px-2 py-1 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono"
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-silver-400 font-mono">Bitiş:</span>
                        <input
                          type="time"
                          value={windowTo}
                          onChange={(e) => setWindowTo(e.target.value)}
                          className="px-2 py-1 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {schedule.frequency === 'daily' && (
              <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-2">
                <label className="text-xs font-semibold text-silver-300 block">Çalışma Saati</label>
                <div className="flex items-center gap-3">
                  <input
                    type="time"
                    disabled={!schedule.enabled}
                    value={schedule.dailyTime || '04:00'}
                    onChange={(e) => setSchedule((prev) => ({ ...prev, dailyTime: e.target.value }))}
                    className="px-3 py-2 rounded-2xl bg-zinc-900 border border-white/15 text-xs text-white font-mono disabled:opacity-40"
                  />
                  <span className="text-xs text-silver-400 font-sans">Her gece bu saatte otomatik yedeklenir.</span>
                </div>
              </div>
            )}

            {schedule.frequency === 'weekly' && (
              <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-3">
                <label className="text-xs font-semibold text-silver-300 block">Haftalık Gün Seçimi (Çoklu)</label>
                <div className="flex flex-wrap gap-1.5">
                  {DAYS_OF_WEEK.map((day) => {
                    const isSelected = (schedule.weeklyDays || []).includes(day.id);
                    return (
                      <button
                        key={day.id}
                        type="button"
                        disabled={!schedule.enabled}
                        onClick={() => {
                          const currentDays = schedule.weeklyDays || [];
                          const nextDays = isSelected
                            ? currentDays.filter((d) => d !== day.id)
                            : [...currentDays, day.id];
                          setSchedule((prev) => ({ ...prev, weeklyDays: nextDays }));
                        }}
                        className={`w-10 h-8 rounded-xl text-xs font-bold border transition-all disabled:opacity-40 ${
                          isSelected
                            ? 'bg-white text-black border-white'
                            : 'bg-zinc-900 text-silver-400 border-white/10 hover:text-white'
                        }`}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <span className="text-xs text-silver-400 font-sans">Saat:</span>
                  <input
                    type="time"
                    disabled={!schedule.enabled}
                    value={schedule.weeklyTime || '03:00'}
                    onChange={(e) => setSchedule((prev) => ({ ...prev, weeklyTime: e.target.value }))}
                    className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono disabled:opacity-40"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Retention & Continuous Single File Mode (5 cols) */}
          <div className="lg:col-span-5 space-y-4">
            {/* Saklanacak Azami Yedek Sayısı (BOŞ = SINIRSIZ) */}
            <div>
              <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                Saklanacak Azami Yedek Sayısı
              </label>
              <input
                type="number"
                min={1}
                max={200}
                disabled={!schedule.enabled}
                value={schedule.maxBackups !== null && schedule.maxBackups !== undefined ? schedule.maxBackups : ''}
                onChange={(e) => {
                  const val = e.target.value.trim() === '' ? null : parseInt(e.target.value, 10);
                  setSchedule((prev) => ({ ...prev, maxBackups: val }));
                }}
                placeholder="Sınırsız (boş bırakın)"
                className="w-full px-4 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white font-mono placeholder-silver-500 focus:outline-none focus:border-white/40 disabled:opacity-40"
              />
              <p className="text-[11px] text-silver-500 font-sans mt-1">
                Boş bırakıldığında eski yedekler silinmez (sınırsız saklanır).
              </p>
            </div>

            {/* Tek Dosyaya Sürekli Yaz Anahtarı */}
            <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-white block">Tek Dosyaya Sürekli Yaz</span>
                  <span className="text-[11px] text-silver-400 font-mono block mt-0.5">Diferansiyel / Artımlı ZIP</span>
                </div>
                <button
                  type="button"
                  disabled={!schedule.enabled}
                  onClick={() => {
                    const nextVal = !schedule.singleFile;
                    setSchedule((prev) => ({
                      ...prev,
                      singleFile: nextVal,
                      format: nextVal ? 'zip' : prev.format,
                    }));
                  }}
                  className={`w-10 h-5 rounded-full p-0.5 transition-colors disabled:opacity-40 ${
                    schedule.singleFile ? 'bg-white' : 'bg-zinc-800'
                  }`}
                >
                  <div
                    className={`w-4 h-4 rounded-full bg-black transition-transform ${
                      schedule.singleFile ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {schedule.singleFile && (
                <div className="pt-2 border-t border-white/10 space-y-1.5">
                  <label className="text-[11px] font-semibold text-silver-300 block">
                    Kullanılacak Hedef Yedek Dosyası
                  </label>
                  <select
                    disabled={!schedule.enabled}
                    value={schedule.targetBackupId || ''}
                    onChange={(e) => setSchedule((prev) => ({ ...prev, targetBackupId: e.target.value }))}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-white/40 disabled:opacity-40"
                  >
                    <option value="">Otomatik (Varsa Tek Dosyayı Kullan / Yoksa Yeni Oluştur)</option>
                    {backups
                      .filter((b) => (b.filename || '').toLowerCase().endsWith('.zip'))
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          Şu dosyayı kullan: {b.filename} ({b.sizeFormatted || formatBytes(b.sizeBytes)})
                        </option>
                      ))}
                  </select>
                </div>
              )}

              <p className="text-[11px] text-silver-400 font-sans leading-relaxed pt-1 border-t border-white/5">
                {schedule.singleFile
                  ? 'İlk yedek tam alınır; sonrakilerde sadece değişen dosyalar yazılır, silinenler arşivden çıkarılır. Format ZIP olarak kilitlidir.'
                  : 'Her yedek alma işleminde tarihe göre ayrı bir arşiv dosyası oluşturulur.'}
              </p>
            </div>

            {/* Status overview info */}
            {schedule.lastRunAt && (
              <div className="text-[11px] font-mono text-silver-400 p-3 rounded-xl bg-white/[0.02] border border-white/5 space-y-1">
                <div>Son Çalışma: {new Date(schedule.lastRunAt).toLocaleString('tr-TR')}</div>
                {schedule.lastResult && (
                  <div className="flex items-center gap-1.5 text-silver-300">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                    <span>Son Sonuç: Başarılı</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Backups List Table */}
      <div className="rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl p-6 relative z-10">
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-4">
          <div className="flex items-center gap-2">
            <FileCheck className="w-4 h-4 text-white" />
            <h3 className="text-sm font-bold text-white tracking-wide">Mevcut Sunucu Yedekleri</h3>
          </div>
          <span className="text-xs text-silver-400 font-sans">{backups.length} Arşiv Mevcut</span>
        </div>

        {backups.length === 0 ? (
          <div className="py-12 text-center flex flex-col items-center justify-center gap-3">
            <Archive className="w-8 h-8 text-silver-600" />
            <p className="text-xs text-silver-400 font-sans">Bu sunucu için henüz bir yedekleme oluşturulmadı.</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="mt-1 px-4 py-2 rounded-2xl bg-white/10 hover:bg-white/15 text-white border border-white/10 text-xs font-medium transition-all"
            >
              İlk Yedeği Al
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-sans">
              <thead>
                <tr className="border-b border-white/5 text-silver-500 text-[11px] uppercase">
                  <th className="pb-3 font-semibold">Yedek Adı / Dosya</th>
                  <th className="pb-3 font-semibold">Format</th>
                  <th className="pb-3 font-semibold">Boyut</th>
                  <th className="pb-3 font-semibold">Tarih & Durum</th>
                  <th className="pb-3 font-semibold text-right">İşlemler</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {backups.map((b) => (
                  <tr key={b.id} className="hover:bg-white/[0.02] transition-colors group">
                    <td className="py-3.5 pr-2">
                      <div className="font-bold text-white text-sm tracking-wide flex items-center gap-2">
                        <span>{b.name}</span>
                        {b.singleFile && (
                          <span className="px-2 py-0.5 rounded-full bg-white/10 text-silver-300 font-mono text-[9px] border border-white/15">
                            Tek Dosya
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-silver-500 font-mono mt-0.5">{b.filename}</div>
                    </td>

                    <td className="py-3.5">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-white/10 text-silver-200 border border-white/15 text-[10px] font-mono">
                        {(b.format || (b.filename.endsWith('.zip') ? 'zip' : 'tar.gz')).toUpperCase()}
                      </span>
                    </td>

                    <td className="py-3.5 font-mono text-silver-300">
                      {b.sizeFormatted || formatBytes(b.sizeBytes)}
                    </td>

                    <td className="py-3.5 text-silver-400 font-mono text-[11px]">
                      <div>{b.createdAt ? new Date(b.createdAt).toLocaleString('tr-TR') : '-'}</div>
                      {b.singleFile && b.updatedAt && (
                        <div className="text-[10px] text-silver-500">
                          Güncelleme: {new Date(b.updatedAt).toLocaleTimeString('tr-TR')}
                        </div>
                      )}
                      {b.stats?.changedFiles !== undefined && (
                        <div className="text-[10px] text-emerald-400">
                          {b.stats.changedFiles} dosya değişti
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Göz At Button (ArchiveBrowser WinRAR Modal) */}
                        <button
                          onClick={() => setBrowserModal({ open: true, backup: b })}
                          title="Arşive Göz At (WinRAR)"
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/15 text-[11px] font-medium transition-all"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Göz At</span>
                        </button>

                        {/* Geri Yükle Button */}
                        <button
                          onClick={() => setRestoreModal({ open: true, backup: b })}
                          title="Geri Yükle"
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-white/15 text-silver-300 hover:text-white border border-white/10 text-[11px] transition-all"
                        >
                          <ArchiveRestore className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Geri Yükle</span>
                        </button>

                        {/* İndir Button */}
                        <button
                          onClick={() => handleDownload(b)}
                          title="İndir"
                          className="p-1.5 rounded-xl bg-white/5 hover:bg-white/15 text-silver-300 hover:text-white border border-white/10 transition-all"
                        >
                          <DownloadCloud className="w-3.5 h-3.5" />
                        </button>

                        {/* Sil Button */}
                        <button
                          onClick={() => setDeleteModal({ open: true, backup: b })}
                          title="Sil"
                          className="p-1.5 rounded-xl bg-white/5 hover:bg-rose-500/20 text-silver-400 hover:text-rose-300 border border-white/10 transition-all"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Backup Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <div
            onClick={(e) => {
              if (e.target === e.currentTarget && !isCreating) setShowCreateModal(false);
            }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 overflow-y-auto"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isCreating && setShowCreateModal(false)}
              className="fixed inset-0 bg-black/80 backdrop-blur-xl"
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-lg rounded-3xl bg-zinc-950 border border-white/10 shadow-[0_25px_70px_-15px_rgba(0,0,0,0.9)] p-6 z-10 overflow-visible my-auto"
            >
              {!isCreating && (
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="absolute top-5 right-5 p-1.5 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}

              <div className="flex items-center gap-3.5 pb-4 border-b border-white/10">
                <div className="p-3 rounded-2xl bg-white/10 border border-white/15 text-white">
                  <Archive className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white tracking-wide">Yeni Yedek Oluştur</h3>
                  <p className="text-xs text-silver-400 font-sans mt-0.5">
                    "{selectedServer.name}" sunucusu için arşiv paketi oluşturun
                  </p>
                </div>
              </div>

              <form onSubmit={handleCreateBackup} className="space-y-4 mt-5">
                {/* Yedek Adı */}
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Yedek Adı</label>
                  <input
                    type="text"
                    disabled={isCreating}
                    value={backupName}
                    onChange={(e) => setBackupName(e.target.value)}
                    placeholder={`Örn: ${selectedServer.name}-yedek`}
                    className="w-full px-4 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white placeholder-silver-500 focus:outline-none focus:border-white/40 font-sans transition-all"
                  />
                </div>

                {/* Tek Dosyaya Sürekli Yaz Seçeneği */}
                <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 flex items-center justify-between">
                  <div>
                    <span className="text-xs font-semibold text-white block">Tek Dosyaya Sürekli Yaz</span>
                    <span className="text-[11px] text-silver-400 font-sans block mt-0.5">
                      İlk seferde tam yedek, sonrasında değişen dosyalar
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={isCreating}
                    onClick={() => {
                      const next = !singleFileMode;
                      setSingleFileMode(next);
                      if (next) setFormat('zip');
                    }}
                    className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
                      singleFileMode ? 'bg-white' : 'bg-zinc-800'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-black transition-transform ${
                        singleFileMode ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {singleFileMode && backups.some((b) => (b.filename || '').toLowerCase().endsWith('.zip')) && (
                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                      Kullanılacak Hedef Yedek Dosyası
                    </label>
                    <select
                      disabled={isCreating}
                      value={targetBackupId}
                      onChange={(e) => setTargetBackupId(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-2xl bg-zinc-900 border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-white/40"
                    >
                      <option value="">Yeni Tek Dosya Oluştur / Otomatik Eşleştir</option>
                      {backups
                        .filter((b) => (b.filename || '').toLowerCase().endsWith('.zip'))
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            Şu dosyayı kullan: {b.filename} ({b.sizeFormatted || formatBytes(b.sizeBytes)})
                          </option>
                        ))}
                    </select>
                  </div>
                )}

                {/* Format Seçimi (singleFileMode açıkken ZIP kilitli) */}
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Arşiv Formatı</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'zip', label: 'ZIP' },
                      { id: 'tar.gz', label: 'TAR.GZ' },
                      { id: 'tar', label: 'TAR' },
                    ].map((fmt) => (
                      <button
                        key={fmt.id}
                        type="button"
                        disabled={isCreating || (singleFileMode && fmt.id !== 'zip')}
                        onClick={() => setFormat(fmt.id as any)}
                        className={`py-2 px-3 rounded-2xl border text-xs font-bold transition-all disabled:opacity-30 ${
                          format === fmt.id
                            ? 'bg-white text-black border-white shadow-md'
                            : 'bg-white/[0.02] text-silver-300 border-white/10 hover:text-white'
                        }`}
                      >
                        {fmt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Sıkıştırma Derecesi Kaydırıcısı (0 - 9) */}
                <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-silver-300">Sıkıştırma Seviyesi</label>
                    <span className="text-xs font-mono font-bold text-white">
                      {getCompressionLevelDesc(compressionLevel)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={9}
                    step={1}
                    disabled={isCreating}
                    value={compressionLevel}
                    onChange={(e) => setCompressionLevel(parseInt(e.target.value, 10))}
                    className="w-full accent-white h-1.5 bg-white/10 rounded-lg cursor-pointer"
                  />
                  <div className="flex items-center gap-1.5 text-[11px] text-silver-400 font-sans pt-1">
                    <Info className="w-3.5 h-3.5 text-silver-400 shrink-0" />
                    <span>
                      Minecraft dünya dosyaları (.mca) zaten sıkıştırılmış olduğu için ZIP ile TAR.GZ boyutları birbirine yakın çıkar.
                    </span>
                  </div>
                </div>

                {/* Dışlanacak Dizinler */}
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Dışlanacak Dizinler</label>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="flex items-center gap-2 p-2.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 text-xs text-silver-300 cursor-pointer">
                      <div
                        className={`w-4 h-4 rounded-md border flex items-center justify-center ${
                          excludeLogs ? 'bg-white border-white text-black' : 'border-white/20 bg-zinc-900'
                        }`}
                      >
                        {excludeLogs && <Check className="w-3 h-3 text-black stroke-[3]" />}
                      </div>
                      <input
                        type="checkbox"
                        checked={excludeLogs}
                        onChange={(e) => setExcludeLogs(e.target.checked)}
                        disabled={isCreating}
                        className="sr-only"
                      />
                      <span>logs</span>
                    </label>

                    <label className="flex items-center gap-2 p-2.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 text-xs text-silver-300 cursor-pointer">
                      <div
                        className={`w-4 h-4 rounded-md border flex items-center justify-center ${
                          excludeCache ? 'bg-white border-white text-black' : 'border-white/20 bg-zinc-900'
                        }`}
                      >
                        {excludeCache && <Check className="w-3 h-3 text-black stroke-[3]" />}
                      </div>
                      <input
                        type="checkbox"
                        checked={excludeCache}
                        onChange={(e) => setExcludeCache(e.target.checked)}
                        disabled={isCreating}
                        className="sr-only"
                      />
                      <span>cache</span>
                    </label>

                    <label className="flex items-center gap-2 p-2.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 text-xs text-silver-300 cursor-pointer">
                      <div
                        className={`w-4 h-4 rounded-md border flex items-center justify-center ${
                          excludeCrashReports ? 'bg-white border-white text-black' : 'border-white/20 bg-zinc-900'
                        }`}
                      >
                        {excludeCrashReports && <Check className="w-3 h-3 text-black stroke-[3]" />}
                      </div>
                      <input
                        type="checkbox"
                        checked={excludeCrashReports}
                        onChange={(e) => setExcludeCrashReports(e.target.checked)}
                        disabled={isCreating}
                        className="sr-only"
                      />
                      <span>crash-reports</span>
                    </label>
                  </div>

                  <input
                    type="text"
                    disabled={isCreating}
                    value={customExcludes}
                    onChange={(e) => setCustomExcludes(e.target.value)}
                    placeholder="Ek dışlanacak dosyalar veya klasörler, örn: .temp, test.jar"
                    className="w-full mt-2 px-3.5 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white placeholder-silver-500 font-sans focus:outline-none focus:border-white/40"
                  />
                </div>

                {/* Form Actions */}
                <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                  <button
                    type="button"
                    disabled={isCreating}
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all disabled:opacity-40"
                  >
                    Vazgeç
                  </button>

                  <button
                    type="submit"
                    disabled={isCreating}
                    className="flex items-center gap-2 px-5 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.25)] active:scale-95 disabled:opacity-40"
                  >
                    {isCreating ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Arşivleniyor...</span>
                      </>
                    ) : (
                      <>
                        <Archive className="w-3.5 h-3.5" />
                        <span>Yedek Al</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Archive Browser Modal for Backups */}
      {browserModal.open && browserModal.backup && (
        <ArchiveBrowser
          isOpen={browserModal.open}
          onClose={() => setBrowserModal({ open: false, backup: null })}
          title={browserModal.backup.name}
          mode="backup"
          backupId={browserModal.backup.id}
          onShowToast={onShowToast}
        />
      )}

      {/* Restore Confirmation Modal */}
      <ConfirmModal
        isOpen={restoreModal.open}
        title="Yedeği Geri Yükle"
        message={`"${restoreModal.backup?.name}" yedeği sunucu dosyalarının üzerine yazılacaktır. Sunucu çalışıyorsa otomatik olarak durdurulup geri yüklenecektir. Devam etmek istiyor musunuz?`}
        confirmText="Geri Yükle ve Uygula"
        cancelText="Vazgeç"
        variant="warning"
        onConfirm={handleConfirmRestore}
        onCancel={() => setRestoreModal({ open: false, backup: null })}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={deleteModal.open}
        title="Yedeği Sil"
        message={`"${deleteModal.backup?.name}" yedeği sunucu diskinden kalıcı olarak silinecektir. Bu işlem geri alınamaz.`}
        confirmText="Kalıcı Olarak Sil"
        cancelText="Vazgeç"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteModal({ open: false, backup: null })}
      />
    </div>
  );
};
