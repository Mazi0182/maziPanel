import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Terminal, 
  FolderOpen, 
  Users, 
  Server, 
  Menu, 
  X,
  Archive,
  FileText,
  Activity,
  SlidersHorizontal,
  Webhook,
  Shield,
  UserRound
} from 'lucide-react';
import { TabType, ServerMetrics, ServerInstance } from '../types';
import { MaziLogo } from './MaziLogo';
import { Tooltip } from './Tooltip';

interface NavbarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  servers?: ServerInstance[];
  selectedServer: ServerInstance | null;
  onSelectServer?: (server: ServerInstance) => void;
  metrics?: ServerMetrics;
  onOpenNewServerModal?: () => void;
  onOpenZipModal?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  onTabChange,
  selectedServer,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // Outside click & ESC detection for mobile menu
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(target)) {
        setMobileMenuOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Route-based check: Server tabs only visible when actively inside a server route
  const isServerRoute = Boolean(
    selectedServer && !['servers', 'system', 'integrations', 'p2p'].includes(activeTab)
  );

  // Server-specific tabs (only visible inside server route)
  const serverTabs = [
    { id: 'console' as TabType, label: 'Konsol', icon: Terminal },
    { id: 'logs' as TabType, label: 'Loglar', icon: FileText },
    { id: 'files' as TabType, label: 'Dosyalar', icon: FolderOpen },
    { id: 'players' as TabType, label: 'Oyuncular', icon: Users },
    { id: 'backups' as TabType, label: 'Yedekler', icon: Archive },
    { id: 'server_settings' as TabType, label: 'Ayarlar', icon: SlidersHorizontal },
  ];

  // Global root tabs (always available)
  const globalTabs = [
    { id: 'servers' as TabType, label: 'Sunucular', icon: Server },
    { id: 'system' as TabType, label: 'Sistem Durumu', icon: Activity },
    { id: 'integrations' as TabType, label: 'Entegrasyonlar', icon: Webhook },
    { id: 'p2p' as TabType, label: 'P2P Tünel', icon: Shield },
  ];

  return (
    <header className="fixed top-4 sm:top-5 left-0 right-0 z-[120] flex justify-center px-3 sm:px-4 md:px-6 pointer-events-none">
      <motion.nav 
        layout
        transition={{ layout: { duration: 0.22, ease: 'easeOut' } }}
        className="pointer-events-auto flex items-center gap-1.5 sm:gap-2.5 xl:gap-3.5 px-2.5 sm:px-3 xl:px-4 py-1.5 sm:py-2 rounded-full glass-panel bg-zinc-950/90 border border-white/10 shadow-2xl backdrop-blur-3xl w-fit max-w-[calc(100vw-1.5rem)] relative"
        aria-label="Ana Gezinti"
      >
        {/* Brand Group */}
        <div className="flex items-center gap-1.5 xl:gap-2 pl-0.5 xl:pl-1 pr-1 shrink-0">
          <MaziLogo size={32} />

          <button
            onClick={() => onTabChange('servers')}
            className="flex flex-col text-left group cursor-pointer"
          >
            <div className="flex items-center gap-1">
              <span className="text-xs xl:text-sm font-extrabold tracking-tight text-white group-hover:text-silver-200 transition-colors">
                mazi<span className="text-silver-400 font-light">Panel</span>
              </span>
            </div>
          </button>
        </div>

        {/* Selected Server Context Pill (Read-only badge shown only when inside a server route) */}
        {isServerRoute && selectedServer && (
          <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-white shrink-0">
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              selectedServer.status === 'online'
                ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                : selectedServer.status === 'starting' || selectedServer.status === 'stopping'
                ? 'bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.6)]'
                : selectedServer.status === 'crashed'
                ? 'bg-rose-500 shadow-[0_0_8px_#f43f5e]'
                : 'bg-zinc-600'
            }`} />
            <span className="font-semibold truncate max-w-[110px] xl:max-w-[150px]">
              {selectedServer.name}
            </span>
            {selectedServer.owner && (
              <span className="text-[10px] text-silver-400 border-l border-white/10 pl-1.5 flex items-center gap-1 font-mono">
                <UserRound className="w-3 h-3 text-silver-400" />
                <span>{selectedServer.owner}</span>
              </span>
            )}
          </div>
        )}

        {/* Desktop Navigation Tabs Island Pill */}
        <div className="hidden md:flex items-center gap-0.5 xl:gap-1 bg-white/[0.02] p-0.5 xl:p-1 rounded-full border border-white/5 shrink-0">
          {/* Server-specific tabs (rendered strictly when in server route) */}
          {isServerRoute && serverTabs.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id || (item.id === 'console' && activeTab === 'dashboard');

            return (
              <Tooltip key={item.id} content={item.label}>
                <button
                  onClick={() => onTabChange(item.id)}
                  className={`relative flex items-center gap-1 xl:gap-1.5 px-2 xl:px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors duration-200 cursor-pointer shrink-0 ${
                    isActive ? 'text-black font-semibold' : 'text-silver-400 hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="activeTopNavPill"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      className="absolute inset-0 rounded-full bg-white shadow-[0_0_15px_rgba(255,255,255,0.4)]"
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1 xl:gap-1.5 whitespace-nowrap">
                    <Icon className="w-3.5 h-3.5 xl:w-4 xl:h-4 shrink-0" />
                    <span>{item.label}</span>
                  </span>
                </button>
              </Tooltip>
            );
          })}

          {/* Separator between server tabs and global tabs */}
          {isServerRoute && <div className="w-px h-3.5 bg-white/10 mx-0.5 xl:mx-1 shrink-0" />}

          {/* Global tabs (Sunucular, Sistem Durumu, Entegrasyonlar) */}
          {globalTabs.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <Tooltip key={item.id} content={item.label}>
                <button
                  onClick={() => onTabChange(item.id)}
                  className={`relative flex items-center gap-1 xl:gap-1.5 px-2.5 xl:px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-200 cursor-pointer shrink-0 ${
                    isActive ? 'text-black font-semibold' : 'text-silver-400 hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="activeTopNavPill"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      className="absolute inset-0 rounded-full bg-white shadow-[0_0_15px_rgba(255,255,255,0.4)]"
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1 xl:gap-1.5 whitespace-nowrap">
                    <Icon className="w-3.5 h-3.5 xl:w-4 xl:h-4 shrink-0" />
                    <span>{item.label}</span>
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>

        {/* Mobile Menu Hamburger Button */}
        <div className="md:hidden flex items-center pl-1 pr-1 shrink-0">
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 rounded-full bg-white/10 text-white hover:bg-white/20 border border-white/15 transition-all cursor-pointer"
            aria-label="Menüyü Aç/Kapat"
          >
            {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>

        {/* Mobile Dropdown Menu */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              ref={mobileMenuRef}
              initial={{ opacity: 0, y: -8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="md:hidden absolute top-full left-1/2 -translate-x-1/2 mt-3 w-64 p-3 rounded-3xl bg-[#121316] border border-white/20 shadow-[0_25px_60px_rgba(0,0,0,0.95)] flex flex-col gap-1.5 z-[350] ring-1 ring-white/10"
            >
              {/* Server Info in Mobile Menu (only in server route) */}
              {isServerRoute && selectedServer && (
                <div className="px-3.5 py-2 mb-1 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 truncate">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${
                      selectedServer.status === 'online'
                        ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                        : selectedServer.status === 'starting' || selectedServer.status === 'stopping'
                        ? 'bg-amber-400 animate-pulse'
                        : selectedServer.status === 'crashed'
                        ? 'bg-rose-500'
                        : 'bg-zinc-500'
                    }`} />
                    <span className="font-semibold text-white truncate">{selectedServer.name}</span>
                  </div>
                  <span className="text-[10px] text-silver-400 font-mono shrink-0">{selectedServer.type} {selectedServer.version}</span>
                </div>
              )}

              {/* Server Tabs in Mobile Menu (only in server route) */}
              {isServerRoute && serverTabs.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id || (item.id === 'console' && activeTab === 'dashboard');
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      onTabChange(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-2xl text-xs font-medium transition-all ${
                      isActive
                        ? 'bg-white text-black font-bold shadow-[0_0_15px_rgba(255,255,255,0.3)]'
                        : 'text-silver-300 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}

              {isServerRoute && <div className="h-px bg-white/10 my-1" />}

              {/* Global Tabs in Mobile Menu */}
              {globalTabs.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      onTabChange(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-2xl text-xs font-medium transition-all ${
                      isActive
                        ? 'bg-white text-black font-bold shadow-[0_0_15px_rgba(255,255,255,0.3)]'
                        : 'text-silver-300 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.nav>
    </header>
  );
};
