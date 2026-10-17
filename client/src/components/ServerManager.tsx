import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Server, 
  Play, 
  Square, 
  RotateCcw, 
  Plus, 
  UploadCloud, 
  Users, 
  HardDrive, 
  Radio, 
  ArrowUpRight, 
  Trash2, 
  CheckCircle2, 
  Clock,
  Image as ImageIcon,
  UserRound
} from 'lucide-react';
import { useAuth } from '../AuthGate';
import { ServerInstance } from '../types';
import { DeleteServerModal } from './DeleteServerModal';
import { Tooltip } from './Tooltip';
import { ImageCropModal } from './ImageCropModal';
import { formatRam } from '../utils/format';

interface ServerManagerProps {
  servers: ServerInstance[];
  selectedServerId: string | null;
  onOpenZipModal: () => void;
  onOpenNewServerModal: () => void;
  onSelectServer: (server: ServerInstance) => void;
  onToggleServer: (serverId: string) => void;
  onRestartServer: (serverId: string) => void;
  onDeleteServer?: (serverId: string) => void;
  onUpdateServerIcon?: (serverId: string, iconUrl: string) => void;
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
}

export const ServerManager: React.FC<ServerManagerProps> = ({
  servers,
  selectedServerId,
  onOpenZipModal,
  onOpenNewServerModal,
  onSelectServer,
  onToggleServer,
  onRestartServer,
  onDeleteServer,
  onUpdateServerIcon,
  onShowToast,
}) => {
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; server: ServerInstance | null }>({
    open: false,
    server: null,
  });
  const [isDeleting, setIsDeleting] = useState(false);

  const [cropModal, setCropModal] = useState<{
    open: boolean;
    serverId: string;
    serverName: string;
    imageSrc: string | null;
  }>({
    open: false,
    serverId: '',
    serverName: '',
    imageSrc: null,
  });

  const [iconOverrides, setIconOverrides] = useState<Record<string, string>>({});
  const [failedIcons, setFailedIcons] = useState<Record<string, boolean>>({});

  const fileInputRefs = React.useRef<{ [key: string]: HTMLInputElement | null }>({});

  const handleSelectFile = (server: ServerInstance, file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setCropModal({
        open: true,
        serverId: server.id,
        serverName: server.name,
        imageSrc: reader.result as string,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleSaveCroppedIcon = async (blob: Blob) => {
    const serverId = cropModal.serverId;
    if (!serverId) return;

    const formData = new FormData();
    formData.append('icon', blob, 'server-icon.png');

    try {
      const res = await fetch(`/api/servers/${serverId}/icon`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('İkon yüklenemedi');

      const data = await res.json().catch(() => ({}));
      let newUrl = data.icon || data.iconUrl || `/api/servers/${serverId}/icon`;
      if (!newUrl.includes('v=')) {
        newUrl += (newUrl.includes('?') ? '&' : '?') + `v=${Date.now()}`;
      }

      // Instantly update icon state without page refresh or waiting
      setIconOverrides((prev) => ({ ...prev, [serverId]: newUrl }));
      setFailedIcons((prev) => ({ ...prev, [serverId]: false }));
      if (onUpdateServerIcon) {
        onUpdateServerIcon(serverId, newUrl);
      }

      onShowToast('Görsel Güncellendi', 'Sunucu simgesi 64x64 formatında kaydedildi.', 'success');
    } catch (err: any) {
      onShowToast('Yükleme Hatası', err.message, 'error');
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteModal.server) return;
    const srv = deleteModal.server;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/servers/${srv.id}?deleteFiles=true`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Sunucu silinemedi');
      onShowToast('Sunucu Silindi', `"${srv.name}" ve dosyaları kaldırıldı.`, 'warning');
      if (onDeleteServer) onDeleteServer(srv.id);
      setDeleteModal({ open: false, server: null });
    } catch (err: any) {
      onShowToast('Hata', err.message, 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const currentUsername = (user?.username || '').trim().toLowerCase();

  const myServers = isAdmin
    ? servers.filter((s) => (s.owner || '').trim().toLowerCase() === currentUsername)
    : servers;
  const otherServers = isAdmin
    ? servers.filter((s) => (s.owner || '').trim().toLowerCase() !== currentUsername)
    : [];
  const showSplitSections = isAdmin && otherServers.length > 0;

  const renderServerCard = (server: ServerInstance) => {
    const isOnline = server.status === 'online';
    const isSelected = selectedServerId === server.id;

    return (
      <div
        key={server.id}
        onClick={() => {
          onSelectServer(server);
          onShowToast('Sunucu Seçildi', `"${server.name}" yönetim paneline geçildi.`, 'info');
        }}
        className={`p-6 rounded-3xl glass-panel cursor-pointer transition-all duration-300 flex flex-col justify-between group shadow-xl ${
          isSelected
            ? 'bg-white/[0.05] border-white/30 shadow-[0_0_25px_rgba(255,255,255,0.08)] ring-1 ring-white/20'
            : 'bg-white/[0.02] hover:bg-white/[0.04] border-white/10 hover:border-white/20'
        }`}
      >
        <div>
          {/* Header Row */}
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="flex items-center gap-3 min-w-0">
              {/* Server Icon with Upload trigger */}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRefs.current[server.id]?.click();
                }}
                title="Sunucu görseli yükle veya değiştir"
                className="w-11 h-11 rounded-2xl bg-zinc-900 border border-white/15 flex items-center justify-center text-white shrink-0 relative overflow-hidden group/icon cursor-pointer"
              >
                <input
                  ref={(el) => { fileInputRefs.current[server.id] = el; }}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleSelectFile(server, f);
                    e.target.value = '';
                  }}
                />
                {(() => {
                  const iconSrc = iconOverrides[server.id] || server.icon;
                  const isFailed = Boolean(failedIcons[server.id]);
                  if (iconSrc && !isFailed) {
                    return (
                      <img
                        key={server.id}
                        src={iconSrc}
                        alt=""
                        aria-hidden="true"
                        className="w-full h-full object-cover rounded-2xl select-none"
                        onError={() => {
                          setFailedIcons((prev) => ({ ...prev, [server.id]: true }));
                        }}
                      />
                    );
                  }
                  return <Server className="w-5 h-5 text-silver-300" />;
                })()}
                <div className="absolute inset-0 bg-black/75 opacity-0 group-hover/icon:opacity-100 flex items-center justify-center transition-opacity">
                  <ImageIcon className="w-4 h-4 text-white" />
                </div>
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-bold text-white group-hover:text-silver-100 transition-colors truncate">
                    {server.name}
                  </h3>
                  {isSelected && (
                    <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-mono text-white border border-white/15">
                      Seçili
                    </span>
                  )}
                  {server.owner && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] font-mono text-silver-300 shrink-0">
                      <UserRound className="w-3 h-3 text-silver-400" />
                      <span>Sahip: {server.owner}</span>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-silver-400 font-mono mt-0.5">
                  <span>{server.type}</span>
                  <span>•</span>
                  <span>{server.version}</span>
                </div>
              </div>
            </div>

            {/* Status Badge */}
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[11px] font-mono shrink-0">
              <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-zinc-600'}`} />
              <span className="text-silver-300 font-sans">
                {isOnline ? 'Aktif' : 'Kapalı'}
              </span>
            </div>
          </div>

          {/* Info Row */}
          <div className="grid grid-cols-3 gap-2 py-3.5 border-y border-white/5 font-mono text-xs">
            <div>
              <div className="text-[10px] uppercase text-silver-500">Port</div>
              <div className="text-white font-bold mt-0.5">{server.port}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-silver-500">Bellek</div>
              <div className="text-white font-bold mt-0.5">{formatRam(server.ramAllocated)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-silver-500">Oyuncu</div>
              <div className="text-white font-bold mt-0.5">
                {isOnline ? `${server.playersCount} / ${server.maxPlayers || 10}` : `0 / ${server.maxPlayers || 10}`}
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons Row */}
        <div className="flex items-center justify-between gap-2 pt-4 mt-2">
          <div className="flex items-center gap-1.5 text-xs text-silver-300 group-hover:text-white transition-colors">
            <span>Sunucuyu Yönet</span>
            <ArrowUpRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
          </div>

          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Tooltip content="Yeniden Başlat">
              <button
                onClick={() => onRestartServer(server.id)}
                disabled={!isOnline}
                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 disabled:opacity-30 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </Tooltip>

            {isOnline ? (
              <Tooltip content="Sunucuyu Durdur">
                <button
                  onClick={() => onToggleServer(server.id)}
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Sunucuyu Başlat">
                <button
                  onClick={() => onToggleServer(server.id)}
                  className="p-2 rounded-xl bg-white hover:bg-silver-200 text-black shadow-md transition-colors"
                >
                  <Play className="w-3.5 h-3.5 fill-black" />
                </button>
              </Tooltip>
            )}

            <Tooltip content="Sunucuyu Sil">
              <button
                onClick={() => setDeleteModal({ open: true, server })}
                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-silver-400 hover:text-white border border-white/10 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Main Actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl">
        <div className="flex items-center gap-3.5">
          <div className="p-3 rounded-2xl bg-white/10 border border-white/15 text-white">
            <Server className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white tracking-wide">Yönetilen Sunucular</h2>
            <p className="text-xs text-silver-400 font-sans mt-0.5">
              {servers.length} sunucu örneği yapılandırıldı
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            onClick={onOpenNewServerModal}
            className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white text-black font-semibold text-xs hover:bg-silver-200 transition-all shadow-[0_0_20px_rgba(255,255,255,0.3)] active:scale-95"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Yeni Sunucu Oluştur</span>
          </button>

          <button
            onClick={onOpenZipModal}
            className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-white border border-white/10 font-semibold text-xs transition-all active:scale-95"
          >
            <UploadCloud className="w-3.5 h-3.5 text-silver-300" />
            <span>ZIP İçe Aktar</span>
          </button>
        </div>
      </div>

      {/* Servers Grid */}
      {servers.length === 0 ? (
        <div className="p-12 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 text-center flex flex-col items-center justify-center gap-3 shadow-2xl">
          <Server className="w-10 h-10 opacity-30 text-white" />
          <h3 className="text-base font-bold text-white">Henüz Bir Sunucu Bulunmuyor</h3>
          <p className="text-xs text-silver-400 font-sans">
            Yukarıdaki "Yeni Sunucu Oluştur" butonunu kullanarak Purpur, Paper veya Vanilla sunucusu kurabilirsiniz.
          </p>
        </div>
      ) : showSplitSections ? (
        <div className="space-y-8">
          {/* Sunucularım Bölümü */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 px-1">
              <h3 className="text-sm font-bold text-white tracking-wide">Sunucularım</h3>
              <span className="text-xs text-silver-400 font-mono">({myServers.length})</span>
            </div>
            {myServers.length === 0 ? (
              <div className="p-8 rounded-3xl glass-panel bg-zinc-950/60 border border-white/10 text-center text-xs text-silver-400 font-sans">
                Henüz kendi hesabınıza atanmış bir sunucu bulunmuyor.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {myServers.map(renderServerCard)}
              </div>
            )}
          </div>

          {/* Diğer Kullanıcıların Sunucuları Bölümü */}
          <div className="space-y-4 pt-6 border-t border-white/10">
            <div className="flex items-center gap-2 px-1">
              <h3 className="text-sm font-bold text-white tracking-wide">Diğer Kullanıcıların Sunucuları</h3>
              <span className="text-xs text-silver-400 font-mono">({otherServers.length})</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {otherServers.map(renderServerCard)}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {servers.map(renderServerCard)}
        </div>
      )}

      {/* Delete Server Danger Modal */}
      <DeleteServerModal
        isOpen={deleteModal.open}
        server={deleteModal.server}
        isDeleting={isDeleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          if (!isDeleting) setDeleteModal({ open: false, server: null });
        }}
      />

      {/* 64x64 Minecraft Server Icon Cropper Modal */}
      <ImageCropModal
        isOpen={cropModal.open}
        imageSrc={cropModal.imageSrc}
        serverName={cropModal.serverName}
        onClose={() => setCropModal({ open: false, serverId: '', serverName: '', imageSrc: null })}
        onSave={handleSaveCroppedIcon}
      />
    </div>
  );
};
