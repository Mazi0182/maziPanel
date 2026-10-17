import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Webhook, 
  Bot, 
  Link, 
  Trash2, 
  Edit3, 
  Send, 
  X, 
  Eye, 
  EyeOff, 
  Radio, 
  Volume2, 
  VolumeX, 
  RefreshCw, 
  Save 
} from 'lucide-react';
import { ConfirmModal } from './ConfirmModal';
import { Tooltip } from './Tooltip';
import { CustomSelect, SelectOption } from './CustomSelect';

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  format: 'discord' | 'generic';
  secretToken?: string;
  events: string[];
  active: boolean;
  createdAt: string;
  lastTriggered?: string | null;
  lastStatus?: number | string | null;
}

export interface DiscordBotConfig {
  enabled: boolean;
  token?: string;
  hasToken?: boolean;
  tokenMasked?: string;
  guildId: string;
  voiceChannelId: string;
  status: 'online' | 'idle' | 'dnd';
  activityType: 'Playing' | 'Listening' | 'Watching' | 'Streaming';
  activityText: string;
}

export interface DiscordBotStatus {
  enabled: boolean;
  configured: boolean;
  available: boolean;
  voiceAvailable: boolean;
  connected: boolean;
  status: 'ready' | 'disconnected' | 'connecting' | 'error' | string;
  user: {
    id?: string;
    tag?: string;
    username?: string;
    avatar?: string | null;
  } | null;
  voiceConnected: boolean;
  guildId: string | null;
  voiceChannelId: string | null;
  activity: {
    type: string;
    text: string;
  } | null;
  lastError: string | null;
}

const AVAILABLE_EVENTS = [
  { id: 'server_start', label: 'Sunucu Başlatıldı', desc: 'Sunucu başlatıldığında' },
  { id: 'server_stop', label: 'Sunucu Durduruldu', desc: 'Sunucu kapatıldığında' },
  { id: 'server_crash', label: 'Sunucu Çöktü', desc: 'Sunucu beklenmedik şekilde kapandığında' },
  { id: 'player_join', label: 'Oyuncu Katıldı', desc: 'Bir oyuncu sunucuya bağlandığında' },
  { id: 'player_leave', label: 'Oyuncu Ayrıldı', desc: 'Bir oyuncu sunucudan ayrıldığında' },
  { id: 'backup_complete', label: 'Yedekleme Alındı', desc: 'Yedekleme başarıyla tamamlandığında' }
];

const BOT_STATUS_OPTIONS: SelectOption[] = [
  { value: 'online', label: 'Çevrimiçi' },
  { value: 'idle', label: 'Boşta' },
  { value: 'dnd', label: 'Rahatsız Etmeyin' },
];

const BOT_ACTIVITY_OPTIONS: SelectOption[] = [
  { value: 'Playing', label: 'Oynuyor' },
  { value: 'Streaming', label: 'Yayında' },
  { value: 'Listening', label: 'Dinliyor' },
  { value: 'Watching', label: 'İzliyor' },
];

const WEBHOOK_FORMAT_OPTIONS: SelectOption[] = [
  { value: 'discord', label: 'Discord Embed Biçimi' },
  { value: 'generic', label: 'Genel JSON (HTTP POST)' },
];

const DEFAULT_BOT_CONFIG: DiscordBotConfig = {
  enabled: true,
  token: '',
  hasToken: false,
  tokenMasked: '',
  guildId: '',
  voiceChannelId: '',
  status: 'online',
  activityType: 'Playing',
  activityText: 'maziPanel • Minecraft'
};

const DEFAULT_BOT_STATUS: DiscordBotStatus = {
  enabled: false,
  configured: false,
  available: true,
  voiceAvailable: true,
  connected: false,
  status: 'disconnected',
  user: null,
  voiceConnected: false,
  guildId: null,
  voiceChannelId: null,
  activity: null,
  lastError: null
};

export interface IntegrationsViewProps {
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
}

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({ onShowToast }) => {
  // Webhooks State (no localStorage per security policy)
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [isLoadingWebhooks, setIsLoadingWebhooks] = useState<boolean>(false);

  // Discord Bot State (no localStorage per security policy)
  const [botConfig, setBotConfig] = useState<DiscordBotConfig>(DEFAULT_BOT_CONFIG);
  const [tokenInput, setTokenInput] = useState<string>('');

  const [botStatus, setBotStatus] = useState<DiscordBotStatus>(DEFAULT_BOT_STATUS);
  const [showToken, setShowToken] = useState(false);
  const [isSavingBot, setIsSavingBot] = useState(false);
  const [isTestingBot, setIsTestingBot] = useState(false);
  const [isTogglingVoice, setIsTogglingVoice] = useState(false);
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null);

  // Webhook Modal State (Add / Edit)
  const [webhookModal, setWebhookModal] = useState<{
    open: boolean;
    mode: 'add' | 'edit';
    item: Partial<WebhookConfig>;
  }>({
    open: false,
    mode: 'add',
    item: {
      name: '',
      url: '',
      format: 'discord',
      secretToken: '',
      events: ['server_start', 'server_stop', 'server_crash'],
      active: true
    }
  });

  // Delete Webhook Confirmation
  const [deleteWebhookModal, setDeleteWebhookModal] = useState<{
    open: boolean;
    webhook: WebhookConfig | null;
  }>({
    open: false,
    webhook: null
  });

  // Clean legacy localStorage keys on mount per privacy requirement
  useEffect(() => {
    try {
      localStorage.removeItem('mazipanel_webhooks');
      localStorage.removeItem('mazipanel_discord_bot_config');
    } catch {}
  }, []);

  // Fetch Webhooks from Backend
  const fetchWebhooks = useCallback(async () => {
    setIsLoadingWebhooks(true);
    try {
      const res = await fetch('/api/integrations/webhooks');
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : Array.isArray(data.webhooks) ? data.webhooks : [];
        setWebhooks(list);
      }
    } catch {
      // Offline fallback
    } finally {
      setIsLoadingWebhooks(false);
    }
  }, []);

  // Fetch Discord Bot from Backend
  const fetchDiscordBot = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/discord');
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setBotConfig((prev) => ({ ...prev, ...data.config }));
        }
        if (data.status) {
          setBotStatus(data.status);
        }
      }
    } catch {
      // Offline fallback
    }
  }, []);

  useEffect(() => {
    fetchWebhooks();
    fetchDiscordBot();

    // 5-second gentle polling for live bot status
    const timer = setInterval(() => {
      fetchDiscordBot();
    }, 5000);

    return () => clearInterval(timer);
  }, [fetchWebhooks, fetchDiscordBot]);

  // Add / Edit Webhook Submit
  const handleSaveWebhookModal = async (e: React.FormEvent) => {
    e.preventDefault();
    const { mode, item } = webhookModal;

    if (!item.name?.trim() || !item.url?.trim()) {
      onShowToast('Eksik Bilgi', 'Lütfen webhook adı ve URL adresini doldurun.', 'warning');
      return;
    }

    const payload = {
      name: item.name.trim(),
      url: item.url.trim(),
      format: item.format || 'discord',
      secretToken: item.secretToken?.trim() || '',
      events: item.events || ['server_start', 'server_stop', 'server_crash'],
      active: item.active !== false
    };

    if (mode === 'add') {
      try {
        const res = await fetch('/api/integrations/webhooks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Webhook kaydedilemedi');
        }

        const created = await res.json();
        setWebhooks((prev) => [...prev, created]);
        onShowToast('Webhook Eklendi', `"${created.name}" entegrasyonu başarıyla kaydedildi.`, 'success');
      } catch (err: any) {
        onShowToast('Webhook Hatası', err.message || 'Webhook kaydedilemedi.', 'error');
      }
    } else {
      try {
        const res = await fetch(`/api/integrations/webhooks/${item.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Webhook güncellenemedi');
        }

        const updated = await res.json();
        setWebhooks((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
        onShowToast('Webhook Güncellendi', `"${updated.name}" ayarları güncellendi.`, 'success');
      } catch (err: any) {
        onShowToast('Webhook Hatası', err.message || 'Webhook güncellenemedi.', 'error');
      }
    }

    setWebhookModal({ open: false, mode: 'add', item: {} });
  };

  // Delete Webhook
  const handleDeleteWebhook = async () => {
    if (!deleteWebhookModal.webhook) return;
    const target = deleteWebhookModal.webhook;

    try {
      const res = await fetch(`/api/integrations/webhooks/${target.id}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Webhook silinemedi');
      }

      setWebhooks((prev) => prev.filter((w) => w.id !== target.id));
      onShowToast('Webhook Silindi', `"${target.name}" entegrasyonu kaldırıldı.`, 'info');
    } catch (err: any) {
      onShowToast('Silme Hatası', err.message || 'Webhook silinemedi.', 'error');
    } finally {
      setDeleteWebhookModal({ open: false, webhook: null });
    }
  };

  // Test Webhook
  const handleTestWebhook = async (wh: WebhookConfig) => {
    setTestingWebhookId(wh.id);
    try {
      const res = await fetch(`/api/integrations/webhooks/${wh.id}/test`, {
        method: 'POST'
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Webhook testine yanıt alınamadı');
      }

      const result = await res.json();
      onShowToast(
        'Webhook Test Edildi',
        result.message || `"${wh.name}" adresine test yükü gönderildi. ${wh.format === 'discord' ? 'Discord kanalınızı kontrol edin.' : 'Uç noktayı kontrol edin.'}`,
        'success'
      );
    } catch (err: any) {
      onShowToast(
        'Webhook Test Uyarısı',
        err.message || 'Webhook uç noktasına ulaşılamadı. Lütfen URL adresinizi kontrol edin.',
        'warning'
      );
    } finally {
      setTestingWebhookId(null);
    }
  };

  // Save Discord Bot Config (Write-only token policy)
  const handleSaveDiscordBot = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingBot(true);
    try {
      const payload: Partial<DiscordBotConfig> = {
        enabled: botConfig.enabled,
        guildId: botConfig.guildId,
        voiceChannelId: botConfig.voiceChannelId,
        status: botConfig.status,
        activityType: botConfig.activityType,
        activityText: botConfig.activityText
      };

      if (tokenInput.trim()) {
        payload.token = tokenInput.trim();
      }

      const res = await fetch('/api/integrations/discord', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Bot yapılandırması kaydedilemedi');
      }

      const data = await res.json();
      if (data.config) {
        setBotConfig((prev) => ({ ...prev, ...data.config }));
      }
      if (data.status) setBotStatus(data.status);
      setTokenInput('');

      onShowToast('Discord Bot Kaydedildi', 'Bot yapılandırması başarıyla güncellendi.', 'success');
    } catch (err: any) {
      onShowToast('Kayıt Hatası', err.message || 'Bot yapılandırması kaydedilemedi.', 'error');
    } finally {
      setIsSavingBot(false);
    }
  };

  // Test Discord Bot Connection
  const handleTestDiscordBot = async () => {
    const hasAnyToken = Boolean(botConfig.hasToken || tokenInput.trim());
    if (!hasAnyToken) {
      onShowToast('Eksik Token', 'Lütfen geçerli bir Discord Bot Token girin.', 'warning');
      return;
    }
    setIsTestingBot(true);
    try {
      const bodyPayload = tokenInput.trim() ? { token: tokenInput.trim() } : {};
      const res = await fetch('/api/integrations/discord/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Bot bağlantısı kurulamadı');
      }

      const data = await res.json();
      if (data.success) {
        onShowToast(
          'Bot Bağlantısı Başarılı',
          data.message || `Bot aktif: ${data.user?.tag || data.user?.username || botStatus.user?.username || 'maziBot'}`,
          'success'
        );
        fetchDiscordBot();
      } else {
        throw new Error(data.error || 'Bilinmeyen bağlantı hatası');
      }
    } catch (err: any) {
      onShowToast('Bağlantı Hatası', err.message || 'Discord Gateway ile bağlantı kurulamadı.', 'error');
    } finally {
      setIsTestingBot(false);
    }
  };

  // Voice Channel Join / Leave
  const handleToggleVoice = async () => {
    if (!botConfig.voiceChannelId.trim()) {
      onShowToast('Eksik Kanal ID', 'Lütfen geçerli bir Ses Kanalı ID girin.', 'warning');
      return;
    }

    setIsTogglingVoice(true);
    const isCurrentlyConnected = botStatus.voiceConnected;
    const endpoint = isCurrentlyConnected
      ? '/api/integrations/discord/voice/leave'
      : '/api/integrations/discord/voice/join';

    try {
      // Save voiceChannelId first
      await fetch('/api/integrations/discord', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botConfig)
      }).catch(() => null);

      const res = await fetch(endpoint, {
        method: 'POST'
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || errData.message || 'Ses kanalına bağlanılamadı');
      }

      const data = await res.json();
      setBotStatus((prev) => ({
        ...prev,
        voiceConnected: !isCurrentlyConnected
      }));

      onShowToast(
        !isCurrentlyConnected ? 'Ses Kanalına Katılındı' : 'Ses Kanalından Ayrılındı',
        data.message || (!isCurrentlyConnected ? `Bot #${botConfig.voiceChannelId} kanalına bağlandı.` : 'Bot ses kanalından ayrıldı.'),
        'info'
      );
    } catch (err: any) {
      onShowToast(
        'Ses Kanalı Hatası',
        err.message || 'Discord ses sunucusuna bağlanılamadı.',
        'warning'
      );
    } finally {
      setIsTogglingVoice(false);
      fetchDiscordBot();
    }
  };

  const isBotOnline = botStatus.connected || botStatus.status === 'ready';

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Top Banner */}
      <div className="p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 text-white shadow-inner">
            <Webhook className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-white tracking-wide">Entegrasyonlar & Bildirimler</h2>
              <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-mono text-silver-300 border border-white/15">
                v1.0
              </span>
            </div>
            <p className="text-xs text-silver-400 font-sans mt-0.5 max-w-xl">
              Minecraft sunucu olaylarını Discord webhooklarına veya özel API uç noktalarına aktarın; Discord botu ile canlı durumu ve ses kanalı bağlantısını yönetin.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() =>
              setWebhookModal({
                open: true,
                mode: 'add',
                item: {
                  name: '',
                  url: '',
                  format: 'discord',
                  secretToken: '',
                  events: ['server_start', 'server_stop', 'server_crash'],
                  active: true
                }
              })
            }
            className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.25)] active:scale-95 cursor-pointer"
          >
            <Link className="w-4 h-4" />
            <span>Yeni Webhook Ekle</span>
          </button>
        </div>
      </div>

      {/* Grid Layout: Left Webhooks, Right Discord Bot */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Webhook Management (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          <div className="p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-white/5 border border-white/10 text-silver-300">
                  <Webhook className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Aktif Webhook Listesi</h3>
                  <p className="text-[11px] text-silver-500 font-sans">Sunucu olaylarında otomatik tetiklenen HTTP uç noktaları</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={fetchWebhooks}
                  disabled={isLoadingWebhooks}
                  className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-silver-400 hover:text-white border border-white/10 transition-colors cursor-pointer"
                  title="Listeyi Yenile"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingWebhooks ? 'animate-spin text-white' : ''}`} />
                </button>
                <span className="text-xs font-mono text-silver-400 px-2.5 py-1 rounded-full bg-white/5 border border-white/10">
                  {webhooks.length} Entegrasyon
                </span>
              </div>
            </div>

            {/* Webhooks List */}
            {webhooks.length === 0 ? (
              <div className="p-8 text-center text-silver-500 font-mono text-xs border border-dashed border-white/10 rounded-2xl space-y-2">
                <Webhook className="w-8 h-8 mx-auto opacity-30 text-white" />
                <p>Henüz yapılandırılmış bir webhook bulunmuyor.</p>
                <button
                  onClick={() =>
                    setWebhookModal({
                      open: true,
                      mode: 'add',
                      item: {
                        name: 'Discord Genel',
                        url: '',
                        format: 'discord',
                        events: ['server_start', 'server_stop', 'server_crash'],
                        active: true
                      }
                    })
                  }
                  className="mt-2 text-xs text-white underline underline-offset-4 hover:text-silver-300 cursor-pointer"
                >
                  İlk webhook entegrasyonunu ekleyin
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {webhooks.map((wh) => (
                  <div
                    key={wh.id}
                    className={`p-4 rounded-2xl border transition-all ${
                      wh.active
                        ? 'bg-white/[0.02] border-white/10 hover:border-white/20'
                        : 'bg-zinc-900/30 border-white/5 opacity-60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold text-white truncate font-sans">{wh.name}</span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[9px] font-mono uppercase font-bold tracking-wider ${
                              wh.format === 'discord'
                                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                            }`}
                          >
                            {wh.format === 'discord' ? 'Discord Webhook' : 'Genel JSON API'}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[9px] font-mono ${
                              wh.active
                                ? 'bg-white/10 text-white border border-white/15'
                                : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                            }`}
                          >
                            {wh.active ? 'Aktif' : 'Devre Dışı'}
                          </span>
                        </div>

                        <div className="text-[11px] font-mono text-silver-500 truncate select-all">
                          {wh.url.replace(/(\/webhooks\/\d+\/)[^/]+$/, '$1••••••••')}
                        </div>

                        {/* Event Tags */}
                        <div className="flex items-center gap-1.5 flex-wrap pt-1">
                          {(wh.events || []).map((evId) => {
                            const found = AVAILABLE_EVENTS.find((e) => e.id === evId);
                            return (
                              <span
                                key={evId}
                                className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[10px] font-mono text-silver-400"
                              >
                                {found?.label || evId}
                              </span>
                            );
                          })}
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                        <Tooltip content="Test Gönder">
                          <button
                            onClick={() => handleTestWebhook(wh)}
                            disabled={testingWebhookId === wh.id}
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/15 text-silver-300 hover:text-white border border-white/10 transition-all cursor-pointer disabled:opacity-50"
                          >
                            <Send className={`w-3.5 h-3.5 ${testingWebhookId === wh.id ? 'animate-pulse text-white' : ''}`} />
                          </button>
                        </Tooltip>

                        <Tooltip content="Düzenle">
                          <button
                            onClick={() =>
                              setWebhookModal({
                                open: true,
                                mode: 'edit',
                                item: { ...wh }
                              })
                            }
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/15 text-silver-300 hover:text-white border border-white/10 transition-all cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>

                        <Tooltip content="Sil">
                          <button
                            onClick={() => setDeleteWebhookModal({ open: true, webhook: wh })}
                            className="p-2 rounded-xl bg-white/5 hover:bg-rose-500/20 text-silver-400 hover:text-rose-300 border border-white/10 transition-all cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Discord Bot Management (5 cols) */}
        <div className="lg:col-span-5 space-y-6">
          <div className="p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-300">
                  <Bot className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Discord Bot Entegrasyonu</h3>
                  <p className="text-[11px] text-silver-500 font-sans">Canlı durum, ses kanalı bağlantısı ve sunucu köprüsü</p>
                </div>
              </div>

              {/* Bot Live Status Pill */}
              <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-mono">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isBotOnline
                      ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                      : botStatus.status === 'connecting'
                      ? 'bg-amber-400 animate-pulse'
                      : 'bg-zinc-600'
                  }`}
                />
                <span className="capitalize text-silver-300 text-[11px]">
                  {isBotOnline
                    ? 'Çevrimiçi'
                    : botStatus.status === 'connecting'
                    ? 'Bağlanıyor...'
                    : 'Çevrimdışı'}
                </span>
              </div>
            </div>

            <form onSubmit={handleSaveDiscordBot} className="space-y-4">
              {/* Bot Token with Masking */}
              <div>
                <label className="flex items-center justify-between text-xs font-semibold text-silver-300 mb-1.5">
                  <span>Discord Bot Token</span>
                  <span className="text-[10px] text-silver-500 font-mono font-normal">Discord Developer Portal</span>
                </label>
                <div className="relative">
                  <input
                    type={showToken ? 'text' : 'password'}
                    placeholder={
                      botConfig.hasToken
                        ? 'Kayıtlı (değiştirmek için yeni token girin)'
                        : 'Bot tokenini yapıştırın'
                    }
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    className="w-full pl-3 pr-10 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white placeholder-silver-500 font-mono focus:outline-none focus:border-white/40"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-silver-400 hover:text-white transition-colors cursor-pointer"
                  >
                    {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {botConfig.hasToken && !tokenInput && (
                  <div className="flex items-center gap-2 mt-2 px-2.5 py-1 rounded-xl bg-white/5 border border-white/10 text-[11px] font-mono text-silver-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                    <span>Kayıtlı Token: {botConfig.tokenMasked || '••••••••'}</span>
                  </div>
                )}
              </div>

              {/* Guild ID & Voice Channel ID */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Discord Sunucu ID</label>
                  <input
                    type="text"
                    placeholder="Sunucu ID (örn. 123456789...)"
                    value={botConfig.guildId}
                    onChange={(e) => setBotConfig({ ...botConfig, guildId: e.target.value })}
                    className="w-full px-3 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white placeholder-silver-600 font-mono focus:outline-none focus:border-white/40"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Ses Kanalı ID</label>
                  <input
                    type="text"
                    placeholder="Ses kanalı ID (örn. 987654321...)"
                    value={botConfig.voiceChannelId}
                    onChange={(e) => setBotConfig({ ...botConfig, voiceChannelId: e.target.value })}
                    className="w-full px-3 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white placeholder-silver-600 font-mono focus:outline-none focus:border-white/40"
                  />
                </div>
              </div>

              {/* Presence Status & Activity Type */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Bot Durumu</label>
                  <CustomSelect
                    value={botConfig.status}
                    onChange={(val) => setBotConfig({ ...botConfig, status: val as any })}
                    options={BOT_STATUS_OPTIONS}
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Etkinlik Türü</label>
                  <CustomSelect
                    value={botConfig.activityType}
                    onChange={(val) => setBotConfig({ ...botConfig, activityType: val as any })}
                    options={BOT_ACTIVITY_OPTIONS}
                  />
                </div>
              </div>

              {/* Activity Text */}
              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Etkinlik Durum Mesajı</label>
                <input
                  type="text"
                  placeholder="Örn: maziPanel • Minecraft"
                  value={botConfig.activityText}
                  onChange={(e) => setBotConfig({ ...botConfig, activityText: e.target.value })}
                  className="w-full px-3 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white placeholder-silver-600 font-mono focus:outline-none focus:border-white/40"
                />
              </div>

              {/* Voice Channel Controls */}
              <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {botStatus.voiceConnected ? (
                      <Volume2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <VolumeX className="w-4 h-4 text-silver-500" />
                    )}
                    <span className="text-xs font-semibold text-white">Ses Kanalı Bağlantısı</span>
                  </div>

                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                      botStatus.voiceConnected
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold'
                        : 'bg-white/5 text-silver-500 border border-white/10'
                    }`}
                  >
                    {botStatus.voiceConnected ? 'Kanalda Aktif' : 'Bağlı Değil'}
                  </span>
                </div>

                <p className="text-[11px] text-silver-400 font-sans">
                  Bot, belirlediğiniz ses kanalına katılarak 7/24 kesintisiz bağlı kalır.
                </p>

                <button
                  type="button"
                  onClick={handleToggleVoice}
                  disabled={isTogglingVoice || !botConfig.voiceChannelId.trim()}
                  className={`w-full py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-40 ${
                    botStatus.voiceConnected
                      ? 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40'
                      : 'bg-white/10 hover:bg-white/20 text-white border border-white/15'
                  }`}
                >
                  {isTogglingVoice ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : botStatus.voiceConnected ? (
                    <>
                      <VolumeX className="w-3.5 h-3.5" />
                      <span>Ses Kanalından Ayrıl</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>Ses Kanalına Katıl</span>
                    </>
                  )}
                </button>
              </div>

              {/* Bot Action Buttons */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleTestDiscordBot}
                  disabled={isTestingBot || (!botConfig.hasToken && !tokenInput.trim())}
                  className="flex-1 py-2.5 px-3 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-40"
                >
                  <Radio className={`w-3.5 h-3.5 ${isTestingBot ? 'animate-pulse text-white' : ''}`} />
                  <span>{isTestingBot ? 'Test Ediliyor...' : 'Bağlantıyı Test Et'}</span>
                </button>

                <button
                  type="submit"
                  disabled={isSavingBot}
                  className="flex-1 py-2.5 px-4 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs shadow-md transition-all active:scale-95 cursor-pointer disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{isSavingBot ? 'Kaydediliyor...' : 'Ayarları Kaydet'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Add / Edit Webhook Modal */}
      <AnimatePresence>
        {webhookModal.open && (
          <div
            onClick={(e) => {
              if (e.target === e.currentTarget) setWebhookModal({ open: false, mode: 'add', item: {} });
            }}
            className="fixed inset-0 z-[300] flex items-center justify-center p-4 overflow-y-auto"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setWebhookModal({ open: false, mode: 'add', item: {} })}
              className="fixed inset-0 bg-black/45 backdrop-blur-md"
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-lg rounded-3xl bg-zinc-950 border border-white/15 shadow-[0_25px_70px_rgba(0,0,0,0.95)] p-6 z-10 backdrop-blur-2xl my-auto"
            >
              <button
                type="button"
                onClick={() => setWebhookModal({ open: false, mode: 'add', item: {} })}
                className="absolute top-5 right-5 p-2 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-3 mb-5">
                <div className="p-3 rounded-2xl bg-white/5 border border-white/10 text-white">
                  <Webhook className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white tracking-wide">
                    {webhookModal.mode === 'add' ? 'Yeni Webhook Yapılandır' : 'Webhook Düzenle'}
                  </h3>
                  <p className="text-xs text-silver-400 font-sans">
                    Discord veya HTTP POST uyumlu webhook uç noktası ekleyin.
                  </p>
                </div>
              </div>

              <form onSubmit={handleSaveWebhookModal} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Entegrasyon Adı</label>
                  <input
                    type="text"
                    required
                    placeholder="Örn: Discord Bildirimleri"
                    value={webhookModal.item.name || ''}
                    onChange={(e) =>
                      setWebhookModal((prev) => ({
                        ...prev,
                        item: { ...prev.item, name: e.target.value }
                      }))
                    }
                    className="w-full px-3 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white focus:outline-none focus:border-white/40"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Webhook URL Adresi</label>
                  <input
                    type="url"
                    required
                    placeholder="https://discord.com/api/webhooks/..."
                    value={webhookModal.item.url || ''}
                    onChange={(e) =>
                      setWebhookModal((prev) => ({
                        ...prev,
                        item: { ...prev.item, url: e.target.value }
                      }))
                    }
                    className="w-full px-3 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-white/40"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-1.5 block">İçerik Biçimi</label>
                    <CustomSelect
                      value={webhookModal.item.format || 'discord'}
                      onChange={(val) =>
                        setWebhookModal((prev) => ({
                          ...prev,
                          item: { ...prev.item, format: val as any }
                        }))
                      }
                      options={WEBHOOK_FORMAT_OPTIONS}
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Güvenlik Anahtarı (İsteğe bağlı)</label>
                    <input
                      type="text"
                      placeholder="Opsiyonel gizli belirteç"
                      value={webhookModal.item.secretToken || ''}
                      onChange={(e) =>
                        setWebhookModal((prev) => ({
                          ...prev,
                          item: { ...prev.item, secretToken: e.target.value }
                        }))
                      }
                      className="w-full px-3 py-2 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-white/40"
                    />
                  </div>
                </div>

                {/* Subscribed Events Checklist */}
                <div>
                  <label className="text-xs font-semibold text-silver-300 mb-2 block">Tetiklenecek Olaylar</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-white/[0.02] border border-white/5 p-3 rounded-2xl max-h-48 overflow-y-auto">
                    {AVAILABLE_EVENTS.map((ev) => {
                      const isChecked = (webhookModal.item.events || []).includes(ev.id);
                      return (
                        <label
                          key={ev.id}
                          className="flex items-start gap-2.5 p-2 rounded-xl hover:bg-white/5 transition-colors cursor-pointer select-none"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              const curr = webhookModal.item.events || [];
                              const next = isChecked ? curr.filter((id) => id !== ev.id) : [...curr, ev.id];
                              setWebhookModal((prev) => ({
                                ...prev,
                                item: { ...prev.item, events: next }
                              }));
                            }}
                            className="mt-0.5 rounded border-white/20 bg-zinc-800 text-white focus:ring-0 cursor-pointer"
                          />
                          <div className="min-w-0">
                            <span className="text-xs font-medium text-white block">{ev.label}</span>
                            <span className="text-[10px] text-silver-500 font-sans block">{ev.desc}</span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Active Toggle */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="wh-active-check"
                    checked={webhookModal.item.active !== false}
                    onChange={(e) =>
                      setWebhookModal((prev) => ({
                        ...prev,
                        item: { ...prev.item, active: e.target.checked }
                      }))
                    }
                    className="rounded border-white/20 bg-zinc-800 text-white focus:ring-0 cursor-pointer"
                  />
                  <label htmlFor="wh-active-check" className="text-xs text-silver-300 font-medium cursor-pointer">
                    Bu webhook şu anda aktif olsun
                  </label>
                </div>

                {/* Action buttons */}
                <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setWebhookModal({ open: false, mode: 'add', item: {} })}
                    className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium cursor-pointer"
                  >
                    Vazgeç
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs shadow-md transition-all active:scale-95 cursor-pointer"
                  >
                    {webhookModal.mode === 'add' ? 'Webhook Ekle' : 'Değişiklikleri Kaydet'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Webhook Confirmation Modal */}
      <ConfirmModal
        isOpen={deleteWebhookModal.open}
        title="Webhook Entegrasyonunu Sil"
        message={`"${deleteWebhookModal.webhook?.name}" entegrasyonunu silmek istediğinize emin misiniz? Sunucu olay bildirimleri bu uç noktaya iletilmeyecektir.`}
        confirmText="Sil"
        cancelText="Vazgeç"
        variant="danger"
        onConfirm={handleDeleteWebhook}
        onCancel={() => setDeleteWebhookModal({ open: false, webhook: null })}
      />
    </div>
  );
};

export default IntegrationsView;
