import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Navbar } from './components/Navbar';
import { MetricsCards } from './components/MetricsCards';
import { ToastContainer } from './components/Toast';
import { PowerControls } from './components/PowerControls';
import { useServerData } from './hooks/useServerData';
import { TabType, ToastMessage, ServerInstance } from './types';
import { Server, Plus, UploadCloud, User } from 'lucide-react';
import { parseRoute, buildPath } from './utils/routes';
import { useAuth } from './AuthGate';

// Lazy-loaded tab views and modals for optimal bundle splitting
const Terminal = React.lazy(() => import('./components/Terminal').then((m) => ({ default: m.Terminal })));
const PlayerManager = React.lazy(() => import('./components/PlayerManager').then((m) => ({ default: m.PlayerManager })));
const FileManager = React.lazy(() => import('./components/FileManager').then((m) => ({ default: m.FileManager })));
const ServerManager = React.lazy(() => import('./components/ServerManager').then((m) => ({ default: m.ServerManager })));
const BackupManager = React.lazy(() => import('./components/BackupManager').then((m) => ({ default: m.BackupManager })));
const SystemStatus = React.lazy(() => import('./components/SystemStatus').then((m) => ({ default: m.SystemStatus })));
const SettingsView = React.lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));
const IntegrationsView = React.lazy(() => import('./components/IntegrationsView').then((m) => ({ default: m.IntegrationsView })));
const P2PTunnelView = React.lazy(() => import('./components/P2PTunnelView').then((m) => ({ default: m.P2PTunnelView })));
const ZipImporter = React.lazy(() => import('./components/ZipImporter').then((m) => ({ default: m.ZipImporter })));
const NewServerModal = React.lazy(() => import('./components/NewServerModal').then((m) => ({ default: m.NewServerModal })));
const LogsView = React.lazy(() => import('./components/LogsView').then((m) => ({ default: m.LogsView })));
const UserSettingsModal = React.lazy(() => import('./components/UserSettingsModal').then((m) => ({ default: m.UserSettingsModal })));

interface TabErrorBoundaryProps {
  children: React.ReactNode;
  activeTab: string;
  onReset?: () => void;
}

interface TabErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class TabErrorBoundary extends React.Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
  constructor(props: TabErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): TabErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[maziPanel] Tab render error:', error, errorInfo);
  }

  componentDidUpdate(prevProps: TabErrorBoundaryProps) {
    if (this.state.hasError && prevProps.activeTab !== this.props.activeTab) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 rounded-3xl glass-panel bg-zinc-950/90 border border-rose-500/30 text-center flex flex-col items-center justify-center gap-4 shadow-2xl max-w-xl mx-auto my-12">
          <div className="p-3 rounded-2xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <Server className="w-8 h-8" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-white">Görünüm Yüklenirken Bir Sorun Oluştu</h3>
            <p className="text-xs text-silver-400 font-mono max-w-md">
              {this.state.error?.message || 'Bileşen işlenirken beklenmeyen bir hata meydana geldi.'}
            </p>
          </div>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              this.props.onReset?.();
            }}
            className="px-4 py-2 rounded-xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all cursor-pointer"
          >
            Konsola Dön
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const App: React.FC = () => {
  const initialRoute = useRef(parseRoute(window.location.pathname));
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    return initialRoute.current.tab || 'servers';
  });
  const [filesRoutePath, setFilesRoutePath] = useState<string | undefined>(() => {
    return initialRoute.current.filePath;
  });
  const [filesResetTrigger, setFilesResetTrigger] = useState(0);
  const [isZipModalOpen, setIsZipModalOpen] = useState(false);
  const [isNewServerModalOpen, setIsNewServerModalOpen] = useState(false);
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const { user, checkAuth, logout } = useAuth();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const hasInitializedTab = useRef(false);
  const isPopStateRef = useRef(false);
  const hasReplacedInitialUrl = useRef(false);

  const {
    servers,
    selectedServer,
    selectedServerId,
    selectServer,
    hostMetrics,
    metrics,
    logs,
    players,
    isLoadingServers,
    sendCommand,
    startServer,
    stopServer,
    restartServer,
    killServer,
    clearLogs,
    kickPlayer,
    banPlayer,
    toggleOp,
    toggleWhitelist,
    addServer,
    updateServerIcon,
    fetchServers,
  } = useServerData(initialRoute.current.serverId);

  const SERVER_TABS: TabType[] = ['console', 'dashboard', 'logs', 'files', 'players', 'backups', 'server_settings'];

  // Initial tab and server resolution on load
  useEffect(() => {
    if (!hasInitializedTab.current && !isLoadingServers) {
      hasInitializedTab.current = true;
      const isServerTab = SERVER_TABS.includes(activeTab);
      if (!initialRoute.current.tab || (isServerTab && !selectedServer)) {
        setActiveTab('servers');
        setFilesRoutePath('');
        window.history.replaceState({ tab: 'servers' }, '', '/servers');
      }
    }
  }, [servers.length, isLoadingServers, selectedServer?.id, activeTab]);

  // If at any point the user is on a server tab but no server is selected, redirect to servers list
  useEffect(() => {
    if (isLoadingServers) return;
    const isServerTab = SERVER_TABS.includes(activeTab);
    if (isServerTab && !selectedServer) {
      setActiveTab('servers');
      setFilesRoutePath('');
      window.history.replaceState({ tab: 'servers' }, '', '/servers');
    }
  }, [isLoadingServers, selectedServer, activeTab]);

  // Handle login event and refresh server data immediately
  useEffect(() => {
    const handleLoginEvent = () => {
      setActiveTab('servers');
      setFilesRoutePath('');
      window.history.replaceState({ tab: 'servers' }, '', '/servers');
      fetchServers();
    };

    window.addEventListener('mazipanel:login', handleLoginEvent);
    return () => window.removeEventListener('mazipanel:login', handleLoginEvent);
  }, [fetchServers]);

  // Immediate data fetch on user change
  useEffect(() => {
    if (user?.username) {
      fetchServers();
    }
  }, [user?.username, fetchServers]);

  // Sync state to URL path - App.tsx is the sole clear owner of history updates
  useEffect(() => {
    if (isLoadingServers) return;

    if (isPopStateRef.current) {
      isPopStateRef.current = false;
      return;
    }

    const currentServerId = selectedServer?.id;
    const targetPath = buildPath(
      activeTab,
      currentServerId,
      activeTab === 'files' ? filesRoutePath : undefined
    );

    if (window.location.pathname !== targetPath) {
      if (!hasReplacedInitialUrl.current) {
        hasReplacedInitialUrl.current = true;
        window.history.replaceState(
          { tab: activeTab, serverId: currentServerId, filePath: activeTab === 'files' ? filesRoutePath : undefined },
          '',
          targetPath
        );
      } else {
        window.history.pushState(
          { tab: activeTab, serverId: currentServerId, filePath: activeTab === 'files' ? filesRoutePath : undefined },
          '',
          targetPath
        );
      }
    } else {
      hasReplacedInitialUrl.current = true;
    }
  }, [activeTab, selectedServer?.id, isLoadingServers, filesRoutePath]);

  // Handle browser Back / Forward buttons cleanly
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if ((e as any).__consumed || e.defaultPrevented) return;
      isPopStateRef.current = true;
      const route = parseRoute(window.location.pathname);
      if (route.tab) {
        setActiveTab(route.tab);
      }
      if (route.serverId) {
        selectServer(route.serverId);
      }
      setFilesRoutePath(route.tab === 'files' ? (route.filePath || '') : '');
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectServer]);

  // Stable toast callback to prevent recreating references on 3s polling cycles
  const showToast = useCallback((
    title: string,
    description?: string,
    type: 'default' | 'success' | 'warning' | 'error' | 'info' = 'default'
  ) => {
    const id = Date.now().toString() + Math.random().toString().slice(2, 6);
    setToasts((prev) => [...prev, { id, title, description, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const handleDismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const handleUrlPathChange = useCallback((newPath: string) => {
    setFilesRoutePath(newPath);
  }, []);

  const handleTabChange = useCallback((tab: TabType) => {
    if (tab === 'files') {
      if (activeTab === 'files') {
        // Repeated click on files tab: do not clear filesRoutePath here,
        // let FileManager coordinate unsaved changes check before resetting
        setFilesResetTrigger((c) => c + 1);
      } else {
        setFilesRoutePath('');
      }
    } else {
      // Clear file route path when leaving files tab so file URLs never leak into other tabs
      setFilesRoutePath('');
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    setActiveTab(tab);
  }, [activeTab]);


  const handleStart = () => {
    startServer();
    showToast('Sunucu Başlatılıyor', `${selectedServer?.name || 'Sunucu'} başlatma sekansı tetiklendi.`, 'info');
  };

  const handleStop = () => {
    stopServer();
    showToast('Sunucu Durduruluyor', 'Düzgün kapatma sinyali iletildi.', 'warning');
  };

  const handleRestart = () => {
    restartServer();
    showToast('Yeniden Başlatılıyor', 'Sunucu yeniden başlatma döngüsü başladı.', 'info');
  };

  const handleKill = () => {
    killServer();
    showToast('Zorla Kapatıldı', 'Sunucu işlemi zorla sonlandırıldı.', 'error');
  };

  const handleImportComplete = (serverName: string, core: string, ram: number, port: number) => {
    fetchServers();
    showToast(
      'İçe Aktarma Tamamlandı',
      `"${serverName}" (${core}) sunucusu başarıyla içe aktarıldı.`,
      'success'
    );
    setFilesRoutePath('');
    setActiveTab('servers');
  };

  const renderActiveTab = () => {
    const isServerTab = SERVER_TABS.includes(activeTab);
    if (isServerTab && isLoadingServers && !selectedServer) {
      return (
        <div className="p-12 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 text-center flex flex-col items-center justify-center gap-3 shadow-2xl max-w-xl mx-auto my-12">
          <Server className="w-8 h-8 animate-pulse text-silver-400" />
          <h3 className="text-base font-bold text-white tracking-wide">Sunucu Bilgileri Yükleniyor</h3>
          <p className="text-xs text-silver-400 font-sans">Lütfen bekleyin...</p>
        </div>
      );
    }

    switch (activeTab) {
      case 'console':
      case 'dashboard':
        return !selectedServer ? (
          <div className="p-12 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 text-center flex flex-col items-center justify-center gap-4 shadow-2xl max-w-2xl mx-auto my-12">
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10 text-silver-300">
              <Server className="w-8 h-8" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-base font-bold text-white tracking-wide">Henüz Bir Sunucu Kurulmadı</h3>
              <p className="text-xs text-silver-400 font-sans max-w-md mx-auto">
                Canlı yönetim konsolunu, donanım kaynaklarını ve oyuncuları yönetebilmek için lütfen ilk Minecraft sunucunuzu oluşturun.
              </p>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={() => setIsNewServerModalOpen(true)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs shadow-lg transition-all active:scale-95 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>İlk Sunucunuzu Oluşturun</span>
              </button>
              <button
                onClick={() => setIsZipModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all cursor-pointer"
              >
                <UploadCloud className="w-4 h-4" />
                <span>ZIP İçe Aktar</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Real-time Hardware & Performance Metrics */}
            <MetricsCards metrics={metrics} />

            {/* Large Status & Power Actions Bar */}
            <PowerControls
              server={selectedServer}
              status={metrics.status}
              uptime={metrics.uptime}
              onStart={handleStart}
              onStop={handleStop}
              onRestart={handleRestart}
              onKill={handleKill}
            />

            {/* Main Workspace: Console & Player Management */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              <div className="lg:col-span-8 flex flex-col">
                <Terminal
                  logs={logs}
                  onSendCommand={sendCommand}
                  onClear={clearLogs}
                  serverStatus={metrics.status}
                  serverId={selectedServer.id}
                />
              </div>

              <div className="lg:col-span-4 flex flex-col">
                <PlayerManager
                  players={players}
                  onKick={(u, r) => {
                    kickPlayer(u, r);
                    showToast('Oyuncu Atıldı', `${u} sunucudan atıldı.`, 'warning');
                  }}
                  onBan={(u, r) => {
                    banPlayer(u, r);
                    showToast('Oyuncu Yasaklandı', `${u} kalıcı olarak yasaklandı.`, 'error');
                  }}
                  onToggleOp={(u) => {
                    toggleOp(u);
                    showToast('Yetki Değiştirildi', `${u} için OP yetkisi güncellendi.`, 'info');
                  }}
                  onToggleWhitelist={(u) => {
                    toggleWhitelist(u);
                    showToast('Beyaz Liste Güncellendi', `${u} beyaz liste kaydı güncellendi.`, 'info');
                  }}
                  onSendCommand={sendCommand}
                />
              </div>
            </div>
          </div>
        );

      case 'servers':
        return (
          <ServerManager
            servers={servers}
            selectedServerId={selectedServerId}
            onOpenZipModal={() => setIsZipModalOpen(true)}
            onOpenNewServerModal={() => setIsNewServerModalOpen(true)}
            onSelectServer={(srv) => {
              selectServer(srv);
              setFilesRoutePath('');
              setActiveTab('console');
            }}
            onToggleServer={(id) => {
              const target = servers.find((s) => s.id === id);
              if (target?.status === 'online') {
                stopServer(id);
                showToast('Sunucu Durduruluyor', `"${target.name}" kapatılıyor.`, 'warning');
              } else {
                startServer(id);
                showToast('Sunucu Başlatılıyor', `"${target?.name}" başlatılıyor.`, 'info');
              }
            }}
            onRestartServer={(id) => {
              const target = servers.find((s) => s.id === id);
              restartServer(id);
              showToast('Yeniden Başlatılıyor', `"${target?.name}" yeniden başlatılıyor.`, 'info');
            }}
            onDeleteServer={() => {
              fetchServers();
            }}
            onUpdateServerIcon={updateServerIcon}
            onShowToast={showToast}
          />
        );

      case 'logs':
        return (
          <LogsView
            selectedServer={selectedServer}
            onShowToast={showToast}
          />
        );

      case 'files':
        return (
          <FileManager
            selectedServer={selectedServer}
            onShowToast={showToast}
            urlFilePath={filesRoutePath}
            resetTrigger={filesResetTrigger}
            onUrlPathChange={handleUrlPathChange}
            onTabChange={handleTabChange}
          />
        );

      case 'players':
        return (
          <div className="max-w-4xl mx-auto pt-6 pb-6">
            <PlayerManager
              players={players}
              onKick={(u, r) => {
                kickPlayer(u, r);
                showToast('Oyuncu Atıldı', `${u} sunucudan atıldı.`, 'warning');
              }}
              onBan={(u, r) => {
                banPlayer(u, r);
                showToast('Oyuncu Yasaklandı', `${u} kalıcı olarak yasaklandı.`, 'error');
              }}
              onToggleOp={(u) => {
                toggleOp(u);
                showToast('Yetki Değiştirildi', `${u} için OP yetkisi güncellendi.`, 'info');
              }}
              onToggleWhitelist={(u) => {
                toggleWhitelist(u);
                showToast('Beyaz Liste Güncellendi', `${u} beyaz liste kaydı güncellendi.`, 'info');
              }}
              onSendCommand={sendCommand}
            />
          </div>
        );

      case 'backups':
        return (
          <BackupManager
            selectedServer={selectedServer}
            servers={servers}
            onSelectServer={selectServer}
            onShowToast={showToast}
            onOpenNewServerModal={() => setIsNewServerModalOpen(true)}
          />
        );

      case 'server_settings':
      case 'settings':
        return (
          <SettingsView
            selectedServer={selectedServer}
            servers={servers}
            onSelectServer={selectServer}
            onShowToast={showToast}
            onOpenNewServerModal={() => setIsNewServerModalOpen(true)}
          />
        );

      case 'system':
        return (
          <SystemStatus
            hostMetrics={hostMetrics}
            onRefresh={fetchServers}
            onShowToast={showToast}
          />
        );

      case 'integrations':
        return <IntegrationsView onShowToast={showToast} />;

      case 'p2p':
        return <P2PTunnelView onShowToast={showToast} />;

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0b0e] text-silver-100 flex flex-col relative selection:bg-white selection:text-black">
      {/* Background Ambient Luxury Monochrome Glows */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1100px] h-[350px] bg-gradient-to-b from-white/[0.035] via-white/[0.008] to-transparent rounded-full blur-3xl" />
        <div className="absolute top-1/3 -left-48 w-96 h-96 bg-white/[0.012] rounded-full blur-3xl" />
        <div className="absolute bottom-10 -right-48 w-96 h-96 bg-white/[0.015] rounded-full blur-3xl" />
      </div>

      {/* Floating Top Island Navbar with Selected Server Picker */}
      <Navbar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        servers={servers}
        selectedServer={selectedServer}
        onSelectServer={(srv) => {
          selectServer(srv);
          setFilesRoutePath('');
          if (activeTab === 'servers') setActiveTab('console');
        }}
        metrics={metrics}
        onOpenNewServerModal={() => setIsNewServerModalOpen(true)}
        onOpenZipModal={() => setIsZipModalOpen(true)}
      />

      {/* Bottom-Left Isolated User Menu Button */}
      <div className="fixed bottom-4 left-4 sm:bottom-6 sm:left-6 z-[130]">
        <button
          onClick={() => setIsUserSettingsOpen(true)}
          title="Kullanıcı Ayarları"
          className="flex items-center gap-2 px-3 py-2 rounded-full glass-panel bg-zinc-950/95 hover:bg-white/10 border border-white/10 shadow-2xl text-white transition-all active:scale-95 cursor-pointer group"
        >
          <div className="w-6 h-6 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-white group-hover:bg-white group-hover:text-black transition-colors">
            <User className="w-3.5 h-3.5" />
          </div>
          <span className="text-xs font-mono font-medium max-w-[110px] truncate hidden sm:inline">
            {user?.username || 'Hesap'}
          </span>
          <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border border-white/15 bg-white/5 text-silver-300">
            {user?.role === 'admin' ? 'Admin' : 'Kullanıcı'}
          </span>
        </button>
      </div>

      {/* Main App Workspace */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 pt-28 pb-16 z-10 relative">
        <TabErrorBoundary activeTab={activeTab} onReset={() => setActiveTab('console')}>
          <motion.div
            key={activeTab === 'dashboard' ? 'console' : activeTab}
            initial={{ opacity: 0, y: 14, scale: 0.992 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="w-full"
          >
            <React.Suspense fallback={<div className="flex items-center justify-center p-12 text-silver-400 font-sans text-xs">Yükleniyor...</div>}>
              {renderActiveTab()}
            </React.Suspense>
          </motion.div>
        </TabErrorBoundary>
      </main>

      {/* New Server Creation Wizard Modal */}
      <React.Suspense fallback={null}>
        <NewServerModal
          isOpen={isNewServerModalOpen}
          onClose={() => setIsNewServerModalOpen(false)}
          onCreated={(srv) => {
            addServer(srv);
            selectServer(srv);
            setFilesRoutePath('');
            setActiveTab('console');
          }}
          onShowToast={showToast}
        />
      </React.Suspense>

      {/* ZIP Importer Modal */}
      <React.Suspense fallback={null}>
        <ZipImporter
          isOpen={isZipModalOpen}
          onClose={() => setIsZipModalOpen(false)}
          onImportComplete={handleImportComplete}
          onShowToast={showToast}
        />
      </React.Suspense>

      {/* User Settings & Account Management Modal */}
      <React.Suspense fallback={null}>
        <UserSettingsModal
          isOpen={isUserSettingsOpen}
          onClose={() => setIsUserSettingsOpen(false)}
          currentUser={user}
          onShowToast={showToast}
          onUserUpdated={() => {
            checkAuth();
          }}
          onLogout={logout}
        />
      </React.Suspense>

      {/* Floating Monochrome Toasts */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />

      {/* Clean Footer (No broken uppercase İ) */}
      <footer className="w-full border-t border-white/5 py-6 px-4 text-center z-10">
        <span className="text-xs text-silver-500 font-sans tracking-wider">
          maziPanel • Minecraft Sunucu Yönetimi
        </span>
      </footer>
    </div>
  );
};

export default App;
