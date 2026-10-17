import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield,
  Waypoints,
  Users,
  Ban,
  History,
  SlidersHorizontal,
  Play,
  RotateCcw,
  Square,
  Copy,
  Check,
  KeyRound,
  RefreshCw,
  Search,
  Trash2,
  UserX,
  Eye,
  EyeOff,
  Terminal,
  Server,
  ArrowUpDown,
  Clock,
  Radio,
  AlertTriangle,
  X,
  Save,
  Lock,
  Unlock,
  Globe,
  HardDrive,
  ChevronRight,
  Loader2
} from 'lucide-react';
import { copyTextToClipboard } from '../utils/clipboard';

interface P2PTunnelViewProps {
  onShowToast: (
    title: string,
    description?: string,
    type?: 'default' | 'success' | 'warning' | 'error' | 'info'
  ) => void;
}

type P2PSubTab = 'overview' | 'clients' | 'bans' | 'history' | 'settings';

interface P2PClientPeer {
  addr: string;
  peer_addr?: string;
  hwid?: string;
  hwid_details?: Record<string, unknown>;
  username?: string;
  role?: 'admin' | 'player' | string;
  os?: string;
  hostname?: string;
  computer_name?: string;
  rx?: number;
  bytes_received?: number;
  tx?: number;
  bytes_sent?: number;
  streams?: number;
  active_streams?: number;
  ping?: number;
  ping_ms?: number;
  duration?: number;
  duration_seconds?: number;
}

interface P2PBanEntry {
  id?: string;
  hwid: string;
  username?: string;
  reason?: string;
  banned_at?: string;
}

interface P2PSessionEntry {
  id?: string;
  key?: string;
  addr?: string;
  peer_addr?: string;
  ip?: string;
  hwid?: string;
  hwid_details?: Record<string, unknown>;
  username?: string;
  role?: string;
  os?: string;
  hostname?: string;
  computer_name?: string;
  joined_at?: string;
  first_seen?: string;
  left_at?: string | null;
  last_seen?: string;
  login_count?: number;
  is_banned?: boolean;
  duration?: number;
  rx?: number;
  tx?: number;
  active?: boolean;
  is_online?: boolean;
}

interface P2PConfig {
  server_name: string;
  server_key: string;
  game_port: number;
  connection_address: string;
  admin_secret: string;
}

interface P2PStatusData {
  installed: boolean;
  systemdActive: boolean;
  running: boolean;
  uptime: number;
  publicEndpoint: string;
  requiredVersion: string;
  connectedClients: number;
  activeStreams: number;
  totalRx: number;
  totalTx: number;
  speedRx: number;
  speedTx: number;
  clients: P2PClientPeer[];
  bans: P2PBanEntry[];
  sessions: P2PSessionEntry[];
  logs: string[];
  config: P2PConfig;
}

export function formatPublicEndpoint(raw: unknown): string {
  if (!raw) return '';
  if (Array.isArray(raw)) {
    if (raw.length >= 2 && raw[0] && raw[1] !== undefined && raw[1] !== null && raw[1] !== '') {
      return `${String(raw[0]).trim()}:${String(raw[1]).trim()}`;
    }
    return raw[0] ? String(raw[0]).trim() : '';
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const host = obj.ip || obj.host || obj.address || obj[0];
    const port = obj.port ?? obj[1];
    if (host && port !== undefined && port !== null && port !== '') {
      return `${String(host).trim()}:${String(port).trim()}`;
    }
    return host ? String(host).trim() : '';
  }
  const str = String(raw).trim();
  if (!str) return '';

  const tupleMatch = str.match(/^[\(\[]\s*['"]?([0-9a-zA-Z.\-]+)['"]?\s*,\s*['"]?(\d{1,5})['"]?\s*[\)\]]$/);
  if (tupleMatch) {
    return `${tupleMatch[1]}:${tupleMatch[2]}`;
  }

  const commaMatch = str.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*,\s*(\d{1,5})$/);
  if (commaMatch) {
    return `${commaMatch[1]}:${commaMatch[2]}`;
  }

  if (/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.test(str)) {
    return str;
  }

  const concatMatch = str.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.)(\d{4,8})$/);
  if (concatMatch) {
    const prefix = concatMatch[1];
    const tail = concatMatch[2];
    for (const octLen of [3, 2, 1]) {
      if (tail.length > octLen) {
        const octet = Number(tail.slice(0, octLen));
        const port = Number(tail.slice(octLen));
        if (octet >= 0 && octet <= 255 && port >= 1 && port <= 65535) {
          return `${prefix}${octet}:${port}`;
        }
      }
    }
  }

  return str;
}

function formatBytes(bytes: number | undefined | null): string {
  const val = Number(bytes) || 0;
  if (val <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(val) / Math.log(1024)), units.length - 1);
  const formatted = val / Math.pow(1024, i);
  return `${formatted >= 100 || i === 0 ? formatted.toFixed(0) : formatted.toFixed(2)} ${units[i]}`;
}

function formatDuration(seconds: number | undefined | null): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total === 0) return '0sn';
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}g`);
  if (hours > 0) parts.push(`${hours}s`);
  if (mins > 0) parts.push(`${mins}dk`);
  if (secs > 0 && days === 0) parts.push(`${secs}sn`);
  return parts.join(' ') || '0sn';
}

const DEFAULT_P2P_STATUS_DATA: P2PStatusData = {
  installed: true,
  systemdActive: false,
  running: false,
  uptime: 0,
  publicEndpoint: '',
  requiredVersion: '',
  connectedClients: 0,
  activeStreams: 0,
  totalRx: 0,
  totalTx: 0,
  speedRx: 0,
  speedTx: 0,
  clients: [],
  bans: [],
  sessions: [],
  logs: [],
  config: {
    server_name: 'Ana Sunucu',
    server_key: '',
    game_port: 25565,
    connection_address: 'baglanti.localhost',
    admin_secret: ''
  }
};

let cachedP2PStatusData: P2PStatusData | null = null;

export const P2PTunnelView: React.FC<P2PTunnelViewProps> = ({ onShowToast }) => {
  const [activeSubTab, setActiveSubTab] = useState<P2PSubTab>('overview');
  const [statusData, setStatusData] = useState<P2PStatusData>(
    () => cachedP2PStatusData || DEFAULT_P2P_STATUS_DATA
  );
  const [hasLoadedOnce, setHasLoadedOnce] = useState<boolean>(() => cachedP2PStatusData !== null);

  const [isLoading, setIsLoading] = useState<boolean>(() => cachedP2PStatusData === null);
  const [serviceActionLoading, setServiceActionLoading] = useState<'start' | 'restart' | 'stop' | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Modals & Action states
  const [isRegenModalOpen, setIsRegenModalOpen] = useState<boolean>(false);
  const [isRegeneratingKey, setIsRegeneratingKey] = useState<boolean>(false);
  const [isRefreshingVersion, setIsRefreshingVersion] = useState<boolean>(false);
  const [versionCheckSuccess, setVersionCheckSuccess] = useState<boolean>(false);

  // Clients sub-tab state
  const [clientSearch, setClientSearch] = useState<string>('');
  const [kickingPeerId, setKickingPeerId] = useState<string | null>(null);
  const [banModalTarget, setBanModalTarget] = useState<{
    hwid: string;
    addr?: string;
    username?: string;
    hwid_details?: Record<string, unknown>;
  } | null>(null);
  const [banModalReason, setBanModalReason] = useState<string>('Yönetici tarafından yasaklandı.');
  const [isSubmittingBan, setIsSubmittingBan] = useState<boolean>(false);

  // Bans sub-tab state
  const [manualBanHwid, setManualBanHwid] = useState<string>('');
  const [manualBanReason, setManualBanReason] = useState<string>('');
  const [unbanningHwid, setUnbanningHwid] = useState<string | null>(null);

  // History sub-tab state
  const [historySearch, setHistorySearch] = useState<string>('');
  const [isClearingHistory, setIsClearingHistory] = useState<boolean>(false);
  const [isClearHistoryConfirmOpen, setIsClearHistoryConfirmOpen] = useState<boolean>(false);

  // Settings & Logs sub-tab state
  const [formConfig, setFormConfig] = useState<P2PConfig>({
    server_name: 'Ana Sunucu',
    server_key: '',
    game_port: 25565,
    connection_address: 'baglanti.localhost',
    admin_secret: ''
  });
  const [isSettingsDirty, setIsSettingsDirty] = useState<boolean>(false);
  const [isSavingSettings, setIsSavingSettings] = useState<boolean>(false);
  const [showAdminSecret, setShowAdminSecret] = useState<boolean>(false);
  const [logSearch, setLogSearch] = useState<string>('');
  const [autoScrollLogs, setAutoScrollLogs] = useState<boolean>(true);

  const hasInitializedConfigRef = useRef<boolean>(false);
  const isSettingsDirtyRef = useRef<boolean>(false);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);
  const isUserAtLogsBottomRef = useRef<boolean>(true);
  const prevLogsSignatureRef = useRef<string>('');
  const prevSubTabRef = useRef<P2PSubTab>('overview');

  useEffect(() => {
    isSettingsDirtyRef.current = isSettingsDirty;
  }, [isSettingsDirty]);

  // Close open modals on Escape key
  useEffect(() => {
    if (!isRegenModalOpen && !banModalTarget && !isClearHistoryConfirmOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isRegenModalOpen && !isRegeneratingKey) {
          setIsRegenModalOpen(false);
        }
        if (banModalTarget && !isSubmittingBan) {
          setBanModalTarget(null);
        }
        if (isClearHistoryConfirmOpen && !isClearingHistory) {
          setIsClearHistoryConfirmOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isRegenModalOpen,
    isRegeneratingKey,
    banModalTarget,
    isSubmittingBan,
    isClearHistoryConfirmOpen,
    isClearingHistory
  ]);

  const copyToClipboard = useCallback(
    async (text: string, label: string, keyId: string) => {
      if (!text) return;
      const ok = await copyTextToClipboard(text);
      if (ok) {
        setCopiedKey(keyId);
        onShowToast('Panoya Kopyalandı', `${label} panoya kopyalandı.`, 'success');
        setTimeout(() => {
          setCopiedKey((prev) => (prev === keyId ? null : prev));
        }, 2000);
      } else {
        onShowToast('Kopyalama Başarısız', 'Panoya erişim sağlanamadı.', 'error');
      }
    },
    [onShowToast]
  );

  const fetchP2PStatus = useCallback(async (silent = true) => {
    if (!silent) setIsLoading(true);
    try {
      const res = await fetch('/api/p2p/status', {
        credentials: 'include'
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const nextConfig: P2PConfig = {
        server_name:
          data?.config?.server_name ??
          data?.server_name ??
          data?.serverName ??
          'Ana Sunucu',
        server_key:
          data?.config?.server_key ??
          data?.server_key ??
          data?.serverKey ??
          '',
        game_port:
          Number(data?.config?.game_port ?? data?.game_port ?? data?.gamePort) || 25565,
        connection_address:
          data?.config?.connection_address ??
          data?.connection_address ??
          data?.connectionAddress ??
          'baglanti.localhost',
        admin_secret:
          data?.config?.admin_secret ??
          data?.admin_secret ??
          data?.adminSecret ??
          ''
      };

      const rawClients = Array.isArray(data?.clients) ? data.clients : [];
      const normalizedClients: P2PClientPeer[] = rawClients.map((c: Record<string, unknown>) => {
        const addr = String(
          c.addr || c.peer_addr || (c.ip && c.port ? `${c.ip}:${c.port}` : c.ip || '')
        );
        const rawHwid = String(c.hwid || '').trim();
        return {
          ...c,
          addr,
          peer_addr: String(c.peer_addr || addr),
          hwid: rawHwid && rawHwid !== 'N/A' ? rawHwid : '',
          hwid_details: (c.hwid_details as Record<string, unknown>) || {},
          username: String(c.username || 'İsimsiz İstemci'),
          role: String(c.role || 'PLAYER'),
          os: String(c.os || 'Bilinmiyor'),
          hostname: String(c.hostname || c.computer_name || '-'),
          rx: Number(c.rx ?? c.bytes_received ?? 0),
          tx: Number(c.tx ?? c.bytes_sent ?? 0),
          streams: Number(c.streams ?? c.active_streams ?? 0),
          ping: Number(c.ping ?? c.ping_ms ?? 0),
          duration: Number(c.duration ?? c.duration_seconds ?? 0)
        };
      });

      const rawBans = Array.isArray(data?.bans) ? data.bans : [];
      const normalizedBans: P2PBanEntry[] = rawBans.map((b: Record<string, unknown>) => ({
        id: String(b.id || b.hwid || ''),
        hwid: String(b.hwid || b.id || '').trim().toUpperCase(),
        username: String(b.username || 'Bilinmeyen'),
        reason: String(b.reason || 'Yönetici tarafından yasaklandı.'),
        banned_at: String(b.banned_at || '-')
      }));

      const rawSessions = Array.isArray(data?.sessions)
        ? data.sessions
        : Array.isArray(data?.history)
        ? data.history
        : [];
      const normalizedSessions: P2PSessionEntry[] = rawSessions.map(
        (s: Record<string, unknown>, idx: number) => {
          const rawHwid = String(s.hwid || '').trim();
          const hwid = rawHwid && rawHwid !== 'N/A' ? rawHwid : '';
          const addr = String(
            s.addr || s.peer_addr || (s.ip && s.port ? `${s.ip}:${s.port}` : s.ip || '-')
          );
          const active = Boolean(s.active ?? s.is_online);
          const firstSeen = String(s.joined_at || s.first_seen || '-');
          const lastSeen = s.left_at || s.last_seen ? String(s.left_at || s.last_seen) : null;
          return {
            ...s,
            id: String(s.id || s.key || hwid || `sess-${idx}`),
            addr,
            ip: String(s.ip || (addr !== '-' ? addr.split(':')[0] : '-')),
            hwid,
            hwid_details: (s.hwid_details as Record<string, unknown>) || {},
            username: String(s.username || 'İsimsiz İstemci'),
            role: String(s.role || ''),
            os: String(s.os || 'Bilinmiyor'),
            hostname: String(s.hostname || s.computer_name || '-'),
            joined_at: firstSeen,
            first_seen: firstSeen,
            left_at: lastSeen,
            last_seen: lastSeen || '-',
            login_count: Number(s.login_count || 1),
            is_banned: Boolean(s.is_banned),
            duration: Number(s.duration || 0),
            rx: Number(s.rx || 0),
            tx: Number(s.tx || 0),
            active,
            is_online: active
          };
        }
      );

      const isRunning = Boolean(data?.running ?? data?.daemonOnline);
      const isSystemdActive = Boolean(
        data?.systemdActive ??
          (isRunning || data?.serviceState === 'active' || data?.serviceState === 'activating')
      );

      const nextStatusData: P2PStatusData = {
        installed: Boolean(data?.installed ?? true),
        systemdActive: isSystemdActive,
        running: isRunning,
        uptime: Number(data?.uptime ?? data?.server_uptime) || 0,
        publicEndpoint: formatPublicEndpoint(data?.publicEndpoint ?? data?.public_endpoint),
        requiredVersion: String(data?.requiredVersion ?? data?.required_client_version ?? ''),
        connectedClients: Number(data?.connectedClients ?? data?.connected_clients ?? normalizedClients.length) || 0,
        activeStreams: Number(data?.activeStreams ?? data?.active_streams) || 0,
        totalRx: Number(data?.totalRx ?? data?.total_rx ?? data?.total_rx_bytes) || 0,
        totalTx: Number(data?.totalTx ?? data?.total_tx ?? data?.total_tx_bytes) || 0,
        speedRx: Number(data?.speedRx ?? data?.speed_rx ?? data?.rx_speed_bps) || 0,
        speedTx: Number(data?.speedTx ?? data?.speed_tx ?? data?.tx_speed_bps) || 0,
        clients: normalizedClients,
        bans: normalizedBans,
        sessions: normalizedSessions,
        logs: Array.isArray(data?.logs) ? data.logs : [],
        config: nextConfig
      };

      cachedP2PStatusData = nextStatusData;
      setStatusData(nextStatusData);
      setHasLoadedOnce(true);

      if (!hasInitializedConfigRef.current || !isSettingsDirtyRef.current) {
        hasInitializedConfigRef.current = true;
        setFormConfig(nextConfig);
      }
    } catch (err) {
      if (!silent) {
        onShowToast(
          'P2P Durumu Alınamadı',
          err instanceof Error ? err.message : 'Sunucu ile bağlantı kurulamadı.',
          'error'
        );
      }
    } finally {
      setIsLoading(false);
    }
  }, [onShowToast]);

  useEffect(() => {
    fetchP2PStatus(false);
    const interval = setInterval(() => {
      fetchP2PStatus(true);
    }, 2500);
    return () => clearInterval(interval);
  }, [fetchP2PStatus]);

  const handleLogsScroll = useCallback(() => {
    const el = logsContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isUserAtLogsBottomRef.current = distanceFromBottom <= 36;
  }, []);

  const handleServiceAction = async (action: 'start' | 'restart' | 'stop') => {
    setServiceActionLoading(action);
    try {
      const res = await fetch('/api/p2p/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Servis işlemi başarısız oldu.');
      }
      onShowToast(
        'Servis Komutu İletildi',
        data.message || `P2P Tünel servisi için "${action}" işlemi uygulandı.`,
        'success'
      );
      await fetchP2PStatus(true);
    } catch (err) {
      onShowToast(
        'Servis Hatası',
        err instanceof Error ? err.message : 'P2P servisi kontrol edilemedi.',
        'error'
      );
    } finally {
      setServiceActionLoading(null);
    }
  };

  const handleRegenerateKey = async () => {
    setIsRegeneratingKey(true);
    try {
      const res = await fetch('/api/p2p/regenerate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Anahtar yenilenemedi.');
      }
      if (data.server_key) {
        setFormConfig((prev) => ({ ...prev, server_key: data.server_key }));
      }
      setIsRegenModalOpen(false);
      onShowToast(
        'Bağlantı Kodu Yenilendi',
        data.server_key
          ? `Yeni bağlantı kodu: ${data.server_key}`
          : 'Yeni P2P bağlantı anahtarı oluşturuldu.',
        'success'
      );
      await fetchP2PStatus(true);
    } catch (err) {
      onShowToast(
        'İşlem Başarısız',
        err instanceof Error ? err.message : 'Bağlantı kodu yenilenirken hata oluştu.',
        'error'
      );
    } finally {
      setIsRegeneratingKey(false);
    }
  };

  const handleRefreshVersion = async () => {
    setIsRefreshingVersion(true);
    setVersionCheckSuccess(false);
    try {
      const [res] = await Promise.all([
        fetch('/api/p2p/version/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include'
        }),
        new Promise((resolve) => setTimeout(resolve, 650))
      ]);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Sürüm kontrolü başarısız oldu.');
      }
      await fetchP2PStatus(true);
      setVersionCheckSuccess(true);
      setTimeout(() => setVersionCheckSuccess(false), 2200);
      const cleanVer = data.version ? `v${String(data.version).replace(/^v/i, '')}` : '';
      onShowToast(
        'Sürüm Bilgisi Güncellendi',
        cleanVer
          ? `Zorunlu istemci sürümü: ${cleanVer}`
          : 'GitHub sürüm kontrolü tamamlandı.',
        'info'
      );
    } catch (err) {
      onShowToast(
        'Sürüm Kontrol Hatası',
        err instanceof Error ? err.message : 'Sürüm bilgisi yenilenemedi.',
        'error'
      );
    } finally {
      setIsRefreshingVersion(false);
    }
  };

  const handleKickPeer = async (peer: P2PClientPeer) => {
    const peerKey = peer.addr || peer.hwid || '';
    if (!peerKey) return;
    setKickingPeerId(peerKey);
    try {
      const res = await fetch('/api/p2p/kick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ addr: peer.addr, hwid: peer.hwid })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'İstemci bağlantısı kesilemedi.');
      }
      onShowToast(
        'İstemci Çıkarıldı',
        `${peer.username || peer.addr} tünel bağlantısından çıkarıldı.`,
        'warning'
      );
      await fetchP2PStatus(true);
    } catch (err) {
      onShowToast(
        'Atma İşlemi Başarısız',
        err instanceof Error ? err.message : 'İstemci atılırken hata oluştu.',
        'error'
      );
    } finally {
      setKickingPeerId(null);
    }
  };

  const handleBanSubmit = async (
    hwid: string,
    addr?: string,
    reason?: string,
    username?: string,
    hwidDetails?: Record<string, unknown>
  ) => {
    const cleanHwid = hwid.trim();
    if (!cleanHwid) {
      onShowToast('Eksik Bilgi', 'Yasaklamak için geçerli bir HWID gerekli.', 'warning');
      return;
    }
    setIsSubmittingBan(true);
    try {
      const res = await fetch('/api/p2p/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          hwid: cleanHwid,
          addr: addr || undefined,
          peer_addr: addr || undefined,
          username: username || undefined,
          hwid_details: hwidDetails || undefined,
          reason: (reason || 'Yönetici tarafından yasaklandı.').trim()
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'HWID yasaklama işlemi başarısız oldu.');
      }
      onShowToast(
        'Donanım Kimliği Yasaklandı',
        `${cleanHwid.slice(0, 14)}... kara listeye eklendi.`,
        'error'
      );
      setBanModalTarget(null);
      setManualBanHwid('');
      setManualBanReason('');
      await fetchP2PStatus(true);
    } catch (err) {
      onShowToast(
        'Yasaklama Başarısız',
        err instanceof Error ? err.message : 'HWID yasaklanamadı.',
        'error'
      );
    } finally {
      setIsSubmittingBan(false);
    }
  };

  const handleUnbanHwid = async (hwid: string, id?: string) => {
    setUnbanningHwid(hwid);
    try {
      const res = await fetch('/api/p2p/unban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ hwid, id: id || hwid })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Yasak kaldırılamadı.');
      }
      onShowToast('Yasak Kaldırıldı', `${hwid.slice(0, 14)}... kara listeden çıkarıldı.`, 'success');
      await fetchP2PStatus(true);
    } catch (err) {
      onShowToast(
        'İşlem Başarısız',
        err instanceof Error ? err.message : 'Yasak kaldırılırken hata oluştu.',
        'error'
      );
    } finally {
      setUnbanningHwid(null);
    }
  };

  const handleClearHistory = async () => {
    setIsClearingHistory(true);
    try {
      const res = await fetch('/api/p2p/clear-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Geçmiş temizlenemedi.');
      }
      setIsClearHistoryConfirmOpen(false);
      onShowToast('Geçmiş Temizlendi', 'Tüm oturum geçmişi kayıtları silindi.', 'info');
      await fetchP2PStatus(true);
    } catch (err) {
      onShowToast(
        'Temizleme Başarısız',
        err instanceof Error ? err.message : 'Bağlantı geçmişi temizlenemedi.',
        'error'
      );
    } finally {
      setIsClearingHistory(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const portNum = Number(formConfig.game_port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      onShowToast('Geçersiz Port', 'Hedef oyun portu 1 ile 65535 arasında olmalıdır.', 'warning');
      return;
    }

    setIsSavingSettings(true);
    try {
      const res = await fetch('/api/p2p/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          server_name: formConfig.server_name.trim() || 'Ana Sunucu',
          server_key: formConfig.server_key.trim(),
          game_port: portNum,
          connection_address: formConfig.connection_address.trim() || 'baglanti.localhost',
          admin_secret: formConfig.admin_secret
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Ayarlar kaydedilemedi.');
      }
      setIsSettingsDirty(false);
      isSettingsDirtyRef.current = false;
      onShowToast(
        'P2P Ayarları Kaydedildi',
        data.message || 'Yapılandırma güncellendi ve P2P servisine uygulandı.',
        'success'
      );
      await fetchP2PStatus(true);
    } catch (err) {
      onShowToast(
        'Kayıt Başarısız',
        err instanceof Error ? err.message : 'Ayarlar kaydedilirken hata oluştu.',
        'error'
      );
    } finally {
      setIsSavingSettings(false);
    }
  };

  const updateFormField = <K extends keyof P2PConfig>(key: K, value: P2PConfig[K]) => {
    setIsSettingsDirty(true);
    isSettingsDirtyRef.current = true;
    setFormConfig((prev) => ({
      ...prev,
      [key]: value
    }));
  };

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return statusData.clients;
    return statusData.clients.filter(
      (c) =>
        (c.username || '').toLowerCase().includes(q) ||
        (c.addr || '').toLowerCase().includes(q) ||
        (c.hwid || '').toLowerCase().includes(q) ||
        (c.hostname || '').toLowerCase().includes(q) ||
        (c.os || '').toLowerCase().includes(q)
    );
  }, [statusData.clients, clientSearch]);

  const filteredSessions = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return statusData.sessions;
    return statusData.sessions.filter(
      (s) =>
        (s.username || '').toLowerCase().includes(q) ||
        (s.addr || '').toLowerCase().includes(q) ||
        (s.hwid || '').toLowerCase().includes(q) ||
        (s.hostname || '').toLowerCase().includes(q) ||
        (s.os || '').toLowerCase().includes(q)
    );
  }, [statusData.sessions, historySearch]);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    if (!q) return statusData.logs;
    return statusData.logs.filter((line) => line.toLowerCase().includes(q));
  }, [statusData.logs, logSearch]);

  const scrollLogsToBottom = useCallback(() => {
    const el = logsContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isUserAtLogsBottomRef.current = true;
    requestAnimationFrame(() => {
      if (logsContainerRef.current) {
        logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
      }
    });
  }, []);

  const handleLogsContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      logsContainerRef.current = el;
      if (el && autoScrollLogs) {
        el.scrollTop = el.scrollHeight;
        isUserAtLogsBottomRef.current = true;
        requestAnimationFrame(() => {
          if (logsContainerRef.current) {
            logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
          }
        });
      }
    },
    [autoScrollLogs]
  );

  // Smart log auto-scroll: scroll immediately on entering settings tab or when new log lines arrive at bottom
  useEffect(() => {
    const sig = `${filteredLogs.length}:${filteredLogs[filteredLogs.length - 1] || ''}`;
    const justEnteredSettings = prevSubTabRef.current !== 'settings' && activeSubTab === 'settings';
    const logsChanged = sig !== prevLogsSignatureRef.current;

    prevSubTabRef.current = activeSubTab;
    prevLogsSignatureRef.current = sig;

    if (
      activeSubTab === 'settings' &&
      autoScrollLogs &&
      (justEnteredSettings || (logsChanged && isUserAtLogsBottomRef.current))
    ) {
      scrollLogsToBottom();
    }
  }, [filteredLogs, activeSubTab, autoScrollLogs, scrollLogsToBottom]);

  const bannedHwidSet = useMemo(() => {
    return new Set(statusData.bans.map((b) => b.hwid));
  }, [statusData.bans]);

  const subTabs: {
    id: P2PSubTab;
    label: string;
    icon: React.FC<{ className?: string }>;
    badge?: number;
  }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: Waypoints },
    { id: 'clients', label: 'Aktif Bağlantılar', icon: Users, badge: statusData.connectedClients },
    { id: 'bans', label: 'Kara Liste', icon: Ban, badge: statusData.bans.length },
    { id: 'history', label: 'Bağlantı Geçmişi', icon: History, badge: statusData.sessions.length },
    { id: 'settings', label: 'Ayarlar & Loglar', icon: SlidersHorizontal }
  ];

  const isInitialChecking = !hasLoadedOnce && isLoading;
  const isDaemonOnline = statusData.running;
  const isServiceActiveOnly = !statusData.running && statusData.systemdActive;

  return (
    <div className="space-y-6 pb-10">
      {/* Top Header & Service Control Bar */}
      <div className="p-5 sm:p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          {/* Title + Daemon Live Status + Public STUN Endpoint */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3.5">
            <div className="flex items-center gap-3.5">
              <div className="p-3 rounded-2xl bg-white/[0.04] border border-white/10 text-white shrink-0">
                <Shield className="w-6 h-6" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-lg sm:text-xl font-extrabold text-white tracking-tight">
                    P2P Tünel Yönetimi
                  </h1>

                  {/* Live Status Pill */}
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border transition-colors ${
                      isDaemonOnline
                        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
                        : isInitialChecking
                        ? 'bg-white/5 text-silver-300 border-white/15'
                        : isServiceActiveOnly
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                        : 'bg-rose-500/10 text-rose-300 border-rose-500/25'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        isDaemonOnline
                          ? 'bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse'
                          : isInitialChecking
                          ? 'bg-white animate-pulse'
                          : isServiceActiveOnly
                          ? 'bg-amber-400 animate-pulse'
                          : 'bg-rose-400'
                      }`}
                    />
                    {isDaemonOnline
                      ? 'Çevrimiçi'
                      : isInitialChecking
                      ? 'Kontrol Ediliyor'
                      : isServiceActiveOnly
                      ? 'Başlatılıyor / IPC Bekleniyor'
                      : 'Çevrimdışı'}
                  </span>

                  {/* Public STUN Endpoint Pill */}
                  {statusData.publicEndpoint && (
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard(statusData.publicEndpoint, 'Genel STUN uç noktası', 'stun-endpoint')
                      }
                      title="Genel STUN uç noktasını kopyala"
                      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-[11px] font-mono text-silver-300 hover:text-white transition-all cursor-pointer"
                    >
                      <Globe className="w-3 h-3 text-silver-300" />
                      <span>{statusData.publicEndpoint}</span>
                      {copiedKey === 'stun-endpoint' ? (
                        <Check className="w-3 h-3 text-white" />
                      ) : (
                        <Copy className="w-2.5 h-2.5 text-silver-400" />
                      )}
                    </button>
                  )}
                </div>
                <p className="text-xs text-silver-400 font-sans mt-1">
                  QUIC ve UDP Hole-Punching tabanlı eşler arası tünel motoru ve donanım kimliği güvenlik duvarı.
                </p>
              </div>
            </div>
          </div>

          {/* Right Side: Service Controls (p2ptunnel.service) */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={serviceActionLoading !== null || isDaemonOnline || isInitialChecking}
              onClick={() => handleServiceAction('start')}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/25 text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {serviceActionLoading === 'start' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span>Başlat</span>
            </button>

            <button
              type="button"
              disabled={serviceActionLoading !== null || isInitialChecking}
              onClick={() => handleServiceAction('restart')}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-200 hover:text-white border border-white/10 text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {serviceActionLoading === 'restart' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              <span>Yeniden Başlat</span>
            </button>

            <button
              type="button"
              disabled={serviceActionLoading !== null || isInitialChecking || (!isDaemonOnline && !statusData.systemdActive)}
              onClick={() => handleServiceAction('stop')}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/25 text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {serviceActionLoading === 'stop' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Square className="w-3.5 h-3.5" />
              )}
              <span>Durdur</span>
            </button>

            <button
              type="button"
              onClick={() => fetchP2PStatus(false)}
              title="Verileri Şimdi Yenile"
              className="p-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 transition-all cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-white' : ''}`} />
            </button>
          </div>
        </div>

        {/* Segmented Sub-Tab Navigation with Sliding Active Pill */}
        <div className="pt-2 border-t border-white/10 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {subTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSubTab(tab.id)}
                className={`relative flex items-center gap-2 px-4 py-2 rounded-2xl text-xs font-semibold transition-colors duration-200 whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'text-black'
                    : 'bg-white/[0.02] text-silver-400 hover:text-white hover:bg-white/[0.06] border border-white/5'
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeP2PSubTabPill"
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    className="absolute inset-0 rounded-2xl bg-white shadow-[0_0_20px_rgba(255,255,255,0.25)]"
                  />
                )}
                <span className="relative z-10 flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{tab.label}</span>
                  {typeof tab.badge === 'number' && (
                    <span
                      className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold transition-colors ${
                        isActive
                          ? 'bg-black/15 text-black'
                          : 'bg-white/10 text-silver-200'
                      }`}
                    >
                      {tab.badge}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Animated Sub-Tab Content Container */}
      <div className="w-full">
        {/* SUB-TAB 1: GENEL BAKIŞ (OVERVIEW) */}
        {activeSubTab === 'overview' && (
          <motion.div
            key="overview"
            initial={{ opacity: 0, y: 12, scale: 0.994 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="space-y-6"
          >
            {/* Top Hero Row: Connection Code Card & Target Service Card */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Connection Code Card */}
              <div className="lg:col-span-7 p-6 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col justify-between gap-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-silver-400 flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 text-white" />
                      Tünel Bağlantı Kodu
                    </span>
                    <p className="text-xs text-silver-400 font-sans">
                      Oyuncular P2P İstemcisine bu bağlantı kodunu girerek sunucunuza doğrudan bağlanır.
                    </p>
                  </div>
                  <span className="px-2.5 py-1 rounded-xl bg-white/5 border border-white/10 text-[11px] font-mono text-silver-300 shrink-0">
                    {statusData.config.server_name || 'Ana Sunucu'}
                  </span>
                </div>

                <div className="p-4 sm:p-5 rounded-2xl bg-black/50 border border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase tracking-widest text-silver-500 font-mono block">
                      AKTİF BAĞLANTI ANAHTARI
                    </span>
                    <div className="text-2xl sm:text-3xl font-mono font-extrabold tracking-widest text-white select-all">
                      {statusData.config.server_key || '----'}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={!statusData.config.server_key}
                      onClick={() =>
                        copyToClipboard(
                          statusData.config.server_key,
                          'Tünel bağlantı kodu',
                          'hero-server-key'
                        )
                      }
                      className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)] active:scale-95 disabled:opacity-40 cursor-pointer"
                    >
                      {copiedKey === 'hero-server-key' ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>Kopyalandı</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Kodu Kopyala</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsRegenModalOpen(true)}
                      className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-200 hover:text-white border border-white/10 text-xs font-medium transition-all cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Yeni Kod Üret</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Target Service & Connection Address Summary Card */}
              <div className="lg:col-span-5 p-6 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col justify-between gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-silver-400 flex items-center gap-1.5">
                      <Server className="w-3.5 h-3.5 text-white" />
                      Hedef Servis & İstemci Adresi
                    </span>
                    <p className="text-xs text-silver-400 font-sans">
                      Tünel üzerinden yönlendirilen yerel oyun portu ve istemci bağlantı adresi.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveSubTab('settings')}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-[11px] font-medium transition-all shrink-0 cursor-pointer"
                  >
                    <span>Düzenle</span>
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 space-y-1">
                    <span className="text-[10px] font-mono uppercase text-silver-400 block">
                      HEDEF OYUN PORTU
                    </span>
                    <div className="flex items-center justify-between">
                      <span className="text-base font-mono font-bold text-white">
                        127.0.0.1:{statusData.config.game_port || 25565}
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-mono">
                        TCP
                      </span>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 space-y-1">
                    <span className="text-[10px] font-mono uppercase text-silver-400 block">
                      OYUN İÇİ SUNUCU ADRESİ
                    </span>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-mono font-bold text-white truncate">
                        {statusData.config.connection_address || 'baglanti.localhost'}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(
                            statusData.config.connection_address || 'baglanti.localhost',
                            'Oyun içi bağlantı adresi',
                            'conn-addr'
                          )
                        }
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white transition-all cursor-pointer shrink-0"
                        title="Adresi Kopyala"
                      >
                        {copiedKey === 'conn-addr' ? (
                          <Check className="w-3.5 h-3.5 text-white" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 4 Metric Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {/* Metric 1: Connected Peers & Active Streams */}
              <div className="p-5 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-silver-400">Aktif İstemciler</span>
                  <div className="p-2 rounded-xl bg-white/5 border border-white/10 text-white">
                    <Radio className="w-4 h-4" />
                  </div>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-mono font-extrabold text-white">
                    {statusData.connectedClients}
                  </span>
                  <span className="text-xs text-silver-400">bağlı oyuncu</span>
                </div>
                <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px] text-silver-400 font-mono">
                  <span>Aktif TCP Akışı:</span>
                  <span className="text-white font-bold">{statusData.activeStreams}</span>
                </div>
              </div>

              {/* Metric 2: Live Throughput */}
              <div className="p-5 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-silver-400">Anlık Veri Akışı</span>
                  <div className="p-2 rounded-xl bg-white/5 border border-white/10 text-white">
                    <ArrowUpDown className="w-4 h-4" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-[10px] text-silver-400 uppercase font-mono block">İNDİRME</span>
                    <span className="text-base font-mono font-bold text-emerald-400">
                      {formatBytes(statusData.speedRx)}/s
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-silver-400 uppercase font-mono block">YÜKLEME</span>
                    <span className="text-base font-mono font-bold text-sky-400">
                      {formatBytes(statusData.speedTx)}/s
                    </span>
                  </div>
                </div>
                <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px] text-silver-400 font-mono">
                  <span>Toplam Anlık Hız:</span>
                  <span className="text-white font-bold">
                    {formatBytes((statusData.speedRx || 0) + (statusData.speedTx || 0))}/s
                  </span>
                </div>
              </div>

              {/* Metric 3: Total Transferred */}
              <div className="p-5 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-silver-400">Toplam Veri Transferi</span>
                  <div className="p-2 rounded-xl bg-white/5 border border-white/10 text-white">
                    <HardDrive className="w-4 h-4" />
                  </div>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-mono font-extrabold text-white">
                    {formatBytes((statusData.totalRx || 0) + (statusData.totalTx || 0))}
                  </span>
                  <span className="text-xs text-silver-400">toplam</span>
                </div>
                <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px] text-silver-400 font-mono">
                  <span>İndirilen: {formatBytes(statusData.totalRx)}</span>
                  <span>Yüklenen: {formatBytes(statusData.totalTx)}</span>
                </div>
              </div>

              {/* Metric 4: Uptime & Required Client Version */}
              <div className="p-5 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-silver-400">Çalışma Süresi & Sürüm</span>
                  <div className="p-2 rounded-xl bg-white/5 border border-white/10 text-white">
                    <Clock className="w-4 h-4" />
                  </div>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <div>
                    <span className="text-xl font-mono font-extrabold text-white">
                      {isDaemonOnline ? formatDuration(statusData.uptime) : 'Kapalı'}
                    </span>
                  </div>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.94 }}
                    disabled={isRefreshingVersion}
                    onClick={handleRefreshVersion}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-[11px] font-medium transition-all cursor-pointer ${
                      versionCheckSuccess
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 shadow-[0_0_12px_rgba(52,211,153,0.18)]'
                        : isRefreshingVersion
                        ? 'bg-white/15 text-white border-white/25'
                        : 'bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border-white/10'
                    }`}
                    title="GitHub üzerinden en güncel istemci sürümünü denetle"
                  >
                    {versionCheckSuccess ? (
                      <Check className="w-3 h-3 text-emerald-300" />
                    ) : (
                      <RefreshCw className={`w-3 h-3 ${isRefreshingVersion ? 'animate-spin text-white' : ''}`} />
                    )}
                    <span>
                      {isRefreshingVersion
                        ? 'Denetleniyor...'
                        : versionCheckSuccess
                        ? 'Güncel'
                        : 'Sürümü Denetle'}
                    </span>
                  </motion.button>
                </div>
                <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px] text-silver-400 font-mono">
                  <span>Zorunlu İstemci Sürümü:</span>
                  <motion.span
                    key={statusData.requiredVersion || 'auto'}
                    initial={{ opacity: 0.5, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.2 }}
                    className={`font-bold ${versionCheckSuccess ? 'text-emerald-300' : 'text-white'}`}
                  >
                    {statusData.requiredVersion ? `v${statusData.requiredVersion.replace(/^v/i, '')}` : 'Otomatik'}
                  </motion.span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* SUB-TAB 2: AKTİF BAĞLANTILAR (CLIENTS) */}
        {activeSubTab === 'clients' && (
          <motion.div
            key="clients"
            initial={{ opacity: 0, y: 12, scale: 0.994 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="p-5 sm:p-6 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-2xl space-y-4"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Users className="w-4 h-4 text-white" />
                  <span>Aktif Tünel Bağlantıları</span>
                  <span className="px-2 py-0.5 rounded-full bg-white/10 text-white text-xs font-mono">
                    {filteredClients.length}
                  </span>
                </h2>
                <p className="text-xs text-silver-400 mt-0.5">
                  Şu anda P2P QUIC tüneli üzerinden bağlı olan oyuncuların gerçek zamanlı ağ ve donanım bilgileri.
                </p>
              </div>

              <div className="relative w-full sm:w-72">
                <Search className="w-3.5 h-3.5 text-silver-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Oyuncu, IP, HWID veya cihaz ara..."
                  className="w-full pl-9 pr-3.5 py-2 rounded-2xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-silver-500 focus:outline-none focus:border-white/30"
                />
              </div>
            </div>

            {filteredClients.length === 0 ? (
              <div className="py-14 px-4 rounded-2xl bg-white/[0.015] border border-white/5 text-center space-y-2">
                <Radio className="w-8 h-8 text-silver-500 mx-auto" />
                <div className="text-sm font-semibold text-white">
                  {clientSearch ? 'Arama Kriterine Uygun Bağlantı Bulunamadı' : 'Henüz Aktif P2P Bağlantısı Yok'}
                </div>
                <p className="text-xs text-silver-400 max-w-md mx-auto">
                  {clientSearch
                    ? 'Farklı bir oyuncu adı, IP adresi veya donanım kimliği ile aramayı deneyin.'
                    : 'Oyuncular P2P istemcisi üzerinden bağlantı kodunu kullanarak katıldığında burada listelenecektir.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-white/10">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-white/[0.03] border-b border-white/10 text-[11px] font-semibold uppercase tracking-wider text-silver-400">
                      <th className="py-3 px-4">Oyuncu</th>
                      <th className="py-3 px-4">Rol</th>
                      <th className="py-3 px-4">Cihaz / OS</th>
                      <th className="py-3 px-4">Dış IP:Port</th>
                      <th className="py-3 px-4">HWID</th>
                      <th className="py-3 px-4">Gecikme</th>
                      <th className="py-3 px-4">Akış</th>
                      <th className="py-3 px-4">Veri Trafiği</th>
                      <th className="py-3 px-4">Süre</th>
                      <th className="py-3 px-4 text-right">İşlemler</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-xs">
                    {filteredClients.map((peer, idx) => {
                      const peerKey = peer.addr || peer.hwid || `peer-${idx}`;
                      const isAdminRole = (peer.role || '').toLowerCase() === 'admin';
                      const pingVal = Number(peer.ping) || 0;
                      return (
                        <tr key={peerKey} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 px-4 font-semibold text-white whitespace-nowrap">
                            {peer.username || 'İsimsiz İstemci'}
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold border ${
                                isAdminRole
                                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                  : 'bg-white/5 text-silver-300 border-white/10'
                              }`}
                            >
                              {isAdminRole ? 'YÖNETİCİ' : 'OYUNCU'}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-silver-300 whitespace-nowrap">
                            <div className="flex flex-col">
                              <span className="text-white font-medium">{peer.hostname || '-'}</span>
                              <span className="text-[10px] text-silver-400 font-mono">{peer.os || 'Bilinmiyor'}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-silver-200 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <span>{peer.addr || '-'}</span>
                              {peer.addr && (
                                <button
                                  type="button"
                                  onClick={() => copyToClipboard(peer.addr, 'İstemci IP adresi', `ip-${peerKey}`)}
                                  className="p-1 rounded-md hover:bg-white/10 text-silver-400 hover:text-white transition-colors cursor-pointer"
                                  title="IP Adresini Kopyala"
                                >
                                  {copiedKey === `ip-${peerKey}` ? (
                                    <Check className="w-3 h-3 text-white" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-silver-300 whitespace-nowrap">
                            {peer.hwid ? (
                              <div className="flex items-center gap-1.5" title={peer.hwid}>
                                <span>{peer.hwid.slice(0, 12)}...</span>
                                <button
                                  type="button"
                                  onClick={() => copyToClipboard(peer.hwid!, 'HWID', `hwid-${peerKey}`)}
                                  className="p-1 rounded-md hover:bg-white/10 text-silver-400 hover:text-white transition-colors cursor-pointer"
                                  title="Tam HWID Kopyala"
                                >
                                  {copiedKey === `hwid-${peerKey}` ? (
                                    <Check className="w-3 h-3 text-white" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </div>
                            ) : (
                              <span className="text-silver-500">-</span>
                            )}
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded-lg text-[11px] font-mono font-semibold border ${
                                pingVal === 0
                                  ? 'bg-white/5 text-silver-400 border-white/10'
                                  : pingVal < 80
                                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                                  : pingVal < 150
                                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                                  : 'bg-rose-500/10 text-rose-300 border-rose-500/20'
                              }`}
                            >
                              {pingVal > 0 ? `${pingVal} ms` : '-'}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono text-white whitespace-nowrap">
                            {peer.streams ?? 0}
                          </td>
                          <td className="py-3 px-4 font-mono text-[11px] whitespace-nowrap">
                            <span className="text-emerald-400">{formatBytes(peer.rx)}</span>
                            <span className="text-silver-500 mx-1">/</span>
                            <span className="text-sky-400">{formatBytes(peer.tx)}</span>
                          </td>
                          <td className="py-3 px-4 font-mono text-silver-300 whitespace-nowrap">
                            {formatDuration(peer.duration)}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={kickingPeerId === peerKey}
                                onClick={() => handleKickPeer(peer)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/20 text-[11px] font-semibold transition-all disabled:opacity-40 cursor-pointer"
                                title="Bağlantıyı Kes"
                              >
                                {kickingPeerId === peerKey ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <UserX className="w-3 h-3" />
                                )}
                                <span>At</span>
                              </button>
                              <button
                                type="button"
                                disabled={!peer.hwid}
                                onClick={() => {
                                  if (!peer.hwid) return;
                                  setBanModalReason('Yönetici tarafından yasaklandı.');
                                  setBanModalTarget({
                                    hwid: peer.hwid,
                                    addr: peer.addr,
                                    username: peer.username,
                                    hwid_details: peer.hwid_details
                                  });
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/25 text-[11px] font-semibold transition-all disabled:opacity-40 cursor-pointer"
                                title="Donanım Kimliğini Yasakla"
                              >
                                <Ban className="w-3 h-3" />
                                <span>Yasakla</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        )}

        {/* SUB-TAB 3: KARA LİSTE (BANS) */}
        {activeSubTab === 'bans' && (
          <motion.div
            key="bans"
            initial={{ opacity: 0, y: 12, scale: 0.994 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="space-y-6"
          >
            {/* Manual HWID Ban Card */}
            <div className="p-5 sm:p-6 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-2xl space-y-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Ban className="w-4 h-4 text-white" />
                  <span>Manuel HWID Yasaklama</span>
                </h2>
                <p className="text-xs text-silver-400 mt-0.5">
                  Belirli bir donanım kimliğini doğrudan kara listeye ekleyerek tünele erişimini kalıcı olarak engelleyin.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-5">
                  <input
                    type="text"
                    value={manualBanHwid}
                    onChange={(e) => setManualBanHwid(e.target.value)}
                    placeholder="Donanım kimliği girin..."
                    className="w-full px-3.5 py-2.5 rounded-2xl bg-black/50 border border-white/10 text-xs font-mono text-white placeholder:text-silver-500 focus:outline-none focus:border-white/30"
                  />
                </div>
                <div className="md:col-span-5">
                  <input
                    type="text"
                    value={manualBanReason}
                    onChange={(e) => setManualBanReason(e.target.value)}
                    placeholder="Yasaklama nedeni..."
                    className="w-full px-3.5 py-2.5 rounded-2xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-silver-500 focus:outline-none focus:border-white/30"
                  />
                </div>
                <div className="md:col-span-2">
                  <button
                    type="button"
                    disabled={isSubmittingBan || !manualBanHwid.trim()}
                    onClick={() => handleBanSubmit(manualBanHwid, undefined, manualBanReason)}
                    className="w-full h-full flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-2xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/30 text-xs font-semibold transition-all disabled:opacity-40 cursor-pointer"
                  >
                    {isSubmittingBan ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Ban className="w-3.5 h-3.5" />
                    )}
                    <span>HWID Yasakla</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Banned HWIDs Table */}
            <div className="p-5 sm:p-6 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <span>Yasaklı Donanım Kimlikleri</span>
                    <span className="px-2 py-0.5 rounded-full bg-white/10 text-white text-xs font-mono">
                      {statusData.bans.length}
                    </span>
                  </h3>
                  <p className="text-xs text-silver-400 mt-0.5">
                    Yasaklanan istemciler IP adreslerini değiştirseler dahi bu tünele bağlanamazlar.
                  </p>
                </div>
              </div>

              {statusData.bans.length === 0 ? (
                <div className="py-12 px-4 rounded-2xl bg-white/[0.015] border border-white/5 text-center space-y-2">
                  <Shield className="w-8 h-8 text-silver-500 mx-auto" />
                  <div className="text-sm font-semibold text-white">Kara Liste Boş</div>
                  <p className="text-xs text-silver-400 max-w-md mx-auto">
                    Şu anda yasaklanmış herhangi bir donanım kimliği bulunmuyor.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-white/10">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-white/[0.03] border-b border-white/10 text-[11px] font-semibold uppercase tracking-wider text-silver-400">
                        <th className="py-3 px-4">Kullanıcı</th>
                        <th className="py-3 px-4">Donanım Kimliği</th>
                        <th className="py-3 px-4">Yasaklama Nedeni</th>
                        <th className="py-3 px-4">Tarih</th>
                        <th className="py-3 px-4 text-right">İşlem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-xs">
                      {statusData.bans.map((ban) => (
                        <tr key={ban.id || ban.hwid} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 px-4 font-semibold text-white whitespace-nowrap">
                            {ban.username || 'Bilinmeyen'}
                          </td>
                          <td className="py-3 px-4 font-mono text-white whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <span>{ban.hwid}</span>
                              <button
                                type="button"
                                onClick={() => copyToClipboard(ban.hwid, 'HWID', `ban-${ban.hwid}`)}
                                className="p-1 rounded-md hover:bg-white/10 text-silver-400 hover:text-white transition-colors cursor-pointer"
                                title="HWID Kopyala"
                              >
                                {copiedKey === `ban-${ban.hwid}` ? (
                                  <Check className="w-3 h-3 text-white" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-silver-300">
                            {ban.reason || 'Yönetici tarafından yasaklandı.'}
                          </td>
                          <td className="py-3 px-4 font-mono text-silver-400 whitespace-nowrap">
                            {ban.banned_at || '-'}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              disabled={unbanningHwid === ban.hwid}
                              onClick={() => handleUnbanHwid(ban.hwid, ban.id)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-silver-200 hover:text-white border border-white/10 text-[11px] font-semibold transition-all disabled:opacity-40 cursor-pointer"
                            >
                              {unbanningHwid === ban.hwid ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Unlock className="w-3.5 h-3.5 text-silver-300" />
                              )}
                              <span>Yasağı Kaldır</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* SUB-TAB 4: BAĞLANTI GEÇMİŞİ (HISTORY) */}
        {activeSubTab === 'history' && (
          <motion.div
            key="history"
            initial={{ opacity: 0, y: 12, scale: 0.994 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="p-5 sm:p-6 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-2xl space-y-4"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <History className="w-4 h-4 text-white" />
                  <span>Oturum ve Bağlantı Geçmişi</span>
                  <span className="px-2 py-0.5 rounded-full bg-white/10 text-white text-xs font-mono">
                    {filteredSessions.length}
                  </span>
                </h2>
                <p className="text-xs text-silver-400 mt-0.5">
                  Tünele bağlanan tüm istemcilerin geçmiş oturum kayıtları, donanım kimlikleri ve erişim durumları.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-64">
                  <Search className="w-3.5 h-3.5 text-silver-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Geçmişte ara..."
                    className="w-full pl-9 pr-3.5 py-2 rounded-2xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-silver-500 focus:outline-none focus:border-white/30"
                  />
                </div>

                <button
                  type="button"
                  disabled={statusData.sessions.length === 0 || isClearingHistory}
                  onClick={() => setIsClearHistoryConfirmOpen(true)}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/25 text-xs font-semibold transition-all disabled:opacity-40 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Geçmişi Temizle</span>
                </button>
              </div>
            </div>

            {filteredSessions.length === 0 ? (
              <div className="py-14 px-4 rounded-2xl bg-white/[0.015] border border-white/5 text-center space-y-2">
                <History className="w-8 h-8 text-silver-500 mx-auto" />
                <div className="text-sm font-semibold text-white">Oturum Kaydı Bulunamadı</div>
                <p className="text-xs text-silver-400 max-w-md mx-auto">
                  Henüz kaydedilmiş bir bağlantı geçmişi bulunmuyor veya arama kriterinizle eşleşen kayıt yok.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-white/10">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-white/[0.03] border-b border-white/10 text-[11px] font-semibold uppercase tracking-wider text-silver-400">
                      <th className="py-3 px-4">Kullanıcı</th>
                      <th className="py-3 px-4">Cihaz / OS</th>
                      <th className="py-3 px-4">Dış IP</th>
                      <th className="py-3 px-4">HWID</th>
                      <th className="py-3 px-4">Durum</th>
                      <th className="py-3 px-4">İlk / Son Görülme</th>
                      <th className="py-3 px-4">Oturum Bilgisi</th>
                      <th className="py-3 px-4 text-right">İşlem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-xs">
                    {filteredSessions.map((sess, idx) => {
                      const sessKey = sess.id || `${sess.hwid || sess.addr}-${idx}`;
                      const isAlreadyBanned =
                        Boolean(sess.is_banned) || (sess.hwid ? bannedHwidSet.has(sess.hwid) : false);
                      return (
                        <tr key={sessKey} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 px-4 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-white">
                                {sess.username || 'İsimsiz İstemci'}
                              </span>
                              {(sess.role || '').toLowerCase() === 'admin' && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/25 text-[10px] font-mono">
                                  YÖNETİCİ
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-silver-300 whitespace-nowrap">
                            <div className="flex flex-col">
                              <span className="text-white">{sess.hostname || '-'}</span>
                              <span className="text-[10px] text-silver-400 font-mono">{sess.os || '-'}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-silver-300 whitespace-nowrap">
                            {sess.addr || sess.ip || '-'}
                          </td>
                          <td className="py-3 px-4 font-mono text-silver-300 whitespace-nowrap">
                            {sess.hwid ? (
                              <div className="flex items-center gap-1.5" title={sess.hwid}>
                                <span>{sess.hwid.slice(0, 12)}...</span>
                                <button
                                  type="button"
                                  onClick={() => copyToClipboard(sess.hwid!, 'HWID', `hist-hwid-${sessKey}`)}
                                  className="p-1 rounded-md hover:bg-white/10 text-silver-400 hover:text-white transition-colors cursor-pointer"
                                >
                                  {copiedKey === `hist-hwid-${sessKey}` ? (
                                    <Check className="w-3 h-3 text-white" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </div>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                                sess.active
                                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
                                  : 'bg-white/5 text-silver-400 border-white/10'
                              }`}
                            >
                              {sess.active ? 'Aktif' : 'Ayrıldı'}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono text-[11px] text-silver-300 whitespace-nowrap">
                            <div>İlk: {sess.joined_at || '-'}</div>
                            {sess.left_at && <div className="text-silver-500">Son: {sess.left_at}</div>}
                          </td>
                          <td className="py-3 px-4 font-mono text-silver-300 whitespace-nowrap">
                            {sess.duration && sess.duration > 0 ? (
                              <span>{formatDuration(sess.duration)}</span>
                            ) : (
                              <span>{sess.login_count || 1} bağlantı</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            {sess.hwid && (
                              <button
                                type="button"
                                disabled={isAlreadyBanned}
                                onClick={() => {
                                  setBanModalReason('Geçmiş oturum kaydından yasaklandı.');
                                  setBanModalTarget({
                                    hwid: sess.hwid!,
                                    addr: sess.addr,
                                    username: sess.username,
                                    hwid_details: sess.hwid_details
                                  });
                                }}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-[11px] font-semibold border transition-all ${
                                  isAlreadyBanned
                                    ? 'bg-white/5 text-silver-500 border-white/5 cursor-not-allowed'
                                    : 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border-rose-500/25 cursor-pointer'
                                }`}
                              >
                                <Ban className="w-3 h-3" />
                                <span>{isAlreadyBanned ? 'Yasaklı' : 'HWID Yasakla'}</span>
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        )}

        {/* SUB-TAB 5: AYARLAR & LOGLAR (SETTINGS & LOGS) */}
        {activeSubTab === 'settings' && (
          <motion.div
            key="settings"
            initial={{ opacity: 0, y: 12, scale: 0.994 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
          >
            {/* Left Column: P2P Configuration Form */}
            <form
              onSubmit={handleSaveSettings}
              className="lg:col-span-5 p-5 sm:p-6 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-2xl space-y-4"
            >
              <div className="flex items-center justify-between pb-3 border-b border-white/10">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4 text-white" />
                    <span>Tünel Yapılandırması</span>
                  </h2>
                  <p className="text-xs text-silver-400 mt-0.5">
                    P2P sunucu parametrelerini ve yerel port yönlendirmesini düzenleyin.
                  </p>
                </div>
                {isSettingsDirty && (
                  <span className="px-2 py-0.5 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/25 text-[10px] font-semibold">
                    Kaydedilmemiş
                  </span>
                )}
              </div>

              <div className="space-y-3.5">
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                    Tünel Sunucu Adı
                  </label>
                  <input
                    type="text"
                    value={formConfig.server_name}
                    onChange={(e) => updateFormField('server_name', e.target.value)}
                    placeholder="Ana Sunucu"
                    className="w-full px-3.5 py-2.5 rounded-2xl bg-black/50 border border-white/10 text-xs text-white focus:outline-none focus:border-white/30"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                    Bağlantı Anahtarı
                  </label>
                  <input
                    type="text"
                    value={formConfig.server_key}
                    onChange={(e) => updateFormField('server_key', e.target.value.toUpperCase())}
                    placeholder="XXXX-YYYY"
                    className="w-full px-3.5 py-2.5 rounded-2xl bg-black/50 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                      Hedef Oyun Portu
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={formConfig.game_port}
                      onChange={(e) => updateFormField('game_port', parseInt(e.target.value, 10) || 25565)}
                      className="w-full px-3.5 py-2.5 rounded-2xl bg-black/50 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                      İstemci Bağlantı Adresi
                    </label>
                    <input
                      type="text"
                      value={formConfig.connection_address}
                      onChange={(e) => updateFormField('connection_address', e.target.value)}
                      placeholder="baglanti.localhost"
                      className="w-full px-3.5 py-2.5 rounded-2xl bg-black/50 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-silver-400" />
                    <span>Yönetici Gizli Anahtarı</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showAdminSecret ? 'text' : 'password'}
                      value={formConfig.admin_secret}
                      onChange={(e) => updateFormField('admin_secret', e.target.value)}
                      placeholder="Yönetici rolü için gizli parola..."
                      className="w-full pl-3.5 pr-10 py-2.5 rounded-2xl bg-black/50 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAdminSecret((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-silver-400 hover:text-white transition-colors cursor-pointer"
                      title={showAdminSecret ? 'Gizle' : 'Göster'}
                    >
                      {showAdminSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-silver-500 mt-1">
                    Bu gizli anahtara sahip istemciler tünelde yönetici rolüyle görünür.
                  </p>
                </div>
              </div>

              <div className="pt-3 border-t border-white/10 flex items-center justify-end gap-2">
                {isSettingsDirty && (
                  <button
                    type="button"
                    onClick={() => {
                      setFormConfig(statusData.config);
                      setIsSettingsDirty(false);
                      isSettingsDirtyRef.current = false;
                    }}
                    className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all cursor-pointer"
                  >
                    Vazgeç
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isSavingSettings}
                  className="flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)] active:scale-95 disabled:opacity-40 cursor-pointer"
                >
                  {isSavingSettings ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  <span>Ayarları Kaydet</span>
                </button>
              </div>
            </form>

            {/* Right Column: Live P2P Daemon Console Logs */}
            <div className="lg:col-span-7 p-5 sm:p-6 rounded-3xl glass-panel glass-panel-hover bg-zinc-950/80 border border-white/10 shadow-2xl space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-white/10">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-white" />
                    <span>Canlı P2P Servis Logları</span>
                    <span className="px-2 py-0.5 rounded-full bg-white/10 text-silver-200 text-[11px] font-mono">
                      {filteredLogs.length} satır
                    </span>
                  </h2>
                  <p className="text-xs text-silver-400 mt-0.5">
                    P2P QUIC tünel motorundan gelen gerçek zamanlı bağlantı ve STUN/UDP günlükleri.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative w-48 sm:w-56">
                    <Search className="w-3.5 h-3.5 text-silver-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={logSearch}
                      onChange={(e) => setLogSearch(e.target.value)}
                      placeholder="Loglarda filtrele..."
                      className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-silver-500 focus:outline-none focus:border-white/30"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setAutoScrollLogs((prev) => {
                        const next = !prev;
                        if (next && logsContainerRef.current) {
                          isUserAtLogsBottomRef.current = true;
                          logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
                        }
                        return next;
                      })
                    }
                    className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-all cursor-pointer ${
                      autoScrollLogs
                        ? 'bg-white text-black border-white'
                        : 'bg-white/5 text-silver-300 border-white/10 hover:text-white'
                    }`}
                  >
                    Oto-Kaydır
                  </button>
                </div>
              </div>

              <div
                ref={handleLogsContainerRef}
                onScroll={handleLogsScroll}
                className="h-[360px] overflow-y-auto rounded-2xl bg-black/70 border border-white/10 p-4 font-mono text-xs space-y-1.5 select-text"
              >
                {filteredLogs.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-silver-500 text-xs">
                    Görüntülenecek P2P servis günlüğü bulunmuyor.
                  </div>
                ) : (
                  filteredLogs.map((line, index) => {
                    const lower = line.toLowerCase();
                    const isErr = lower.includes('error') || lower.includes('hata') || lower.includes('fail');
                    const isWarn = lower.includes('warn') || lower.includes('uyarı') || lower.includes('ban') || lower.includes('kick');
                    const isOk = lower.includes('başlatıldı') || lower.includes('bağlandı') || lower.includes('aktif');
                    return (
                      <div
                        key={index}
                        className={`leading-relaxed break-all ${
                          isErr
                            ? 'text-rose-400'
                            : isWarn
                            ? 'text-amber-300'
                            : isOk
                            ? 'text-emerald-300'
                            : 'text-silver-300'
                        }`}
                      >
                        {line}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* PORTAL MODALS (Escape + Backdrop Click Enabled) */}
      {typeof document !== 'undefined' &&
        createPortal(
          <>
            {/* MODAL 1: REGENERATE CONNECTION KEY CONFIRMATION */}
            <AnimatePresence>
              {isRegenModalOpen && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => {
                    if (!isRegeneratingKey) setIsRegenModalOpen(false);
                  }}
                  className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: 8 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full max-w-md p-6 rounded-3xl bg-[#111215] border border-white/15 shadow-2xl space-y-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-2xl bg-amber-500/15 border border-amber-500/25 text-amber-300">
                          <AlertTriangle className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-white">Yeni Bağlantı Kodu Üretilsin mi?</h3>
                          <p className="text-xs text-silver-400">Mevcut bağlantı anahtarı geçersiz kılınacaktır.</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={isRegeneratingKey}
                        onClick={() => setIsRegenModalOpen(false)}
                        className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-silver-400 hover:text-white transition-colors cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <p className="text-xs text-silver-300 leading-relaxed">
                      Yeni bir bağlantı kodu üretildiğinde, oyuncuların sunucunuza bağlanabilmesi için yeni kodu P2P istemcilerine girmeleri gerekecektir.
                    </p>

                    <div className="flex items-center justify-end gap-2 pt-2">
                      <button
                        type="button"
                        disabled={isRegeneratingKey}
                        onClick={() => setIsRegenModalOpen(false)}
                        className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all cursor-pointer"
                      >
                        İptal
                      </button>
                      <button
                        type="button"
                        disabled={isRegeneratingKey}
                        onClick={handleRegenerateKey}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all disabled:opacity-40 cursor-pointer"
                      >
                        {isRegeneratingKey ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        <span>Evet, Yeni Kod Üret</span>
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* MODAL 2: BAN HWID CONFIRMATION MODAL */}
            <AnimatePresence>
              {banModalTarget && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => {
                    if (!isSubmittingBan) setBanModalTarget(null);
                  }}
                  className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: 8 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full max-w-md p-6 rounded-3xl bg-[#111215] border border-white/15 shadow-2xl space-y-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-2xl bg-rose-500/15 border border-rose-500/25 text-rose-300">
                          <Ban className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-white">Donanım Kimliğini Yasakla</h3>
                          <p className="text-xs text-silver-400">
                            {banModalTarget.username || banModalTarget.addr || 'Seçili İstemci'}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={isSubmittingBan}
                        onClick={() => setBanModalTarget(null)}
                        className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-silver-400 hover:text-white transition-colors cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div className="p-3 rounded-2xl bg-black/50 border border-white/10 text-xs font-mono text-silver-300 break-all">
                        <span className="text-[10px] uppercase text-silver-500 block mb-0.5">HEDEF HWID</span>
                        {banModalTarget.hwid}
                      </div>

                      <div>
                        <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                          Yasaklama Nedeni
                        </label>
                        <input
                          type="text"
                          value={banModalReason}
                          onChange={(e) => setBanModalReason(e.target.value)}
                          placeholder="Yasaklama nedenini yazın..."
                          className="w-full px-3.5 py-2.5 rounded-2xl bg-black/50 border border-white/10 text-xs text-white focus:outline-none focus:border-white/30"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-2">
                      <button
                        type="button"
                        disabled={isSubmittingBan}
                        onClick={() => setBanModalTarget(null)}
                        className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all cursor-pointer"
                      >
                        İptal
                      </button>
                      <button
                        type="button"
                        disabled={isSubmittingBan}
                        onClick={() =>
                          handleBanSubmit(
                            banModalTarget.hwid,
                            banModalTarget.addr,
                            banModalReason,
                            banModalTarget.username,
                            banModalTarget.hwid_details
                          )
                        }
                        className="flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-rose-500 hover:bg-rose-600 text-white font-semibold text-xs transition-all disabled:opacity-40 cursor-pointer"
                      >
                        {isSubmittingBan ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Ban className="w-3.5 h-3.5" />
                        )}
                        <span>Kalıcı Olarak Yasakla</span>
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* MODAL 3: CLEAR HISTORY CONFIRMATION */}
            <AnimatePresence>
              {isClearHistoryConfirmOpen && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => {
                    if (!isClearingHistory) setIsClearHistoryConfirmOpen(false);
                  }}
                  className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: 8 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full max-w-md p-6 rounded-3xl bg-[#111215] border border-white/15 shadow-2xl space-y-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-2xl bg-rose-500/15 border border-rose-500/25 text-rose-300">
                          <Trash2 className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-white">Bağlantı Geçmişi Temizlensin mi?</h3>
                          <p className="text-xs text-silver-400">Bu işlem geri alınamaz.</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={isClearingHistory}
                        onClick={() => setIsClearHistoryConfirmOpen(false)}
                        className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-silver-400 hover:text-white transition-colors cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <p className="text-xs text-silver-300 leading-relaxed">
                      Geçmiş oturum kayıtlarının tamamı silinecektir. Aktif bağlantılar ve kara liste kayıtları bu işlemden etkilenmez.
                    </p>

                    <div className="flex items-center justify-end gap-2 pt-2">
                      <button
                        type="button"
                        disabled={isClearingHistory}
                        onClick={() => setIsClearHistoryConfirmOpen(false)}
                        className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all cursor-pointer"
                      >
                        İptal
                      </button>
                      <button
                        type="button"
                        disabled={isClearingHistory}
                        onClick={handleClearHistory}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-rose-500 hover:bg-rose-600 text-white font-semibold text-xs transition-all disabled:opacity-40 cursor-pointer"
                      >
                        {isClearingHistory ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        <span>Evet, Geçmişi Sil</span>
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </>,
          document.body
        )}
    </div>
  );
};
