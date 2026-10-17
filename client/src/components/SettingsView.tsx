import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Settings, 
  Save, 
  Undo2, 
  RefreshCw, 
  Server, 
  Cpu, 
  HardDrive, 
  Code2, 
  AlertTriangle, 
  Zap, 
  ShieldAlert, 
  HelpCircle, 
  CheckCircle2, 
  Check, 
  Sparkles,
  SlidersHorizontal,
  Download,
  Loader2,
  X
} from 'lucide-react';
import { ServerInstance } from '../types';
import { ServerRuntimeSettings, JavaInstallation, UpdateSettingsResponse } from '../types/settings';
import { ConfirmModal } from './ConfirmModal';
import { CustomSelect } from './CustomSelect';
import { formatRam } from '../utils/format';
import { getJavaRequirements, isJavaCompatible, JavaRequirement, getJavaCompatibilityInfo, buildJavaSelectOptions } from '../utils/javaCompatibility';
import {
  splitStartupCommandLine,
  composeStartupCommandLine,
  updateJarInCommandLine,
  applyAikarPreset,
  validateStartupCommandLine,
} from '../utils/startupArguments';

export interface SettingsViewProps {
  selectedServer?: ServerInstance | null;
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
  servers?: ServerInstance[];
  onSelectServer?: (server: ServerInstance) => void;
  onOpenNewServerModal?: () => void;
}

const AIKAR_FLAGS = 
  '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';

const DEFAULT_SETTINGS: ServerRuntimeSettings = {
  memory: { minMB: 1024, maxMB: 2048 },
  startup: {
    jarFile: 'server.jar',
    javaPath: null,
    jvmFlags: '-XX:+UseG1GC -XX:MaxGCPauseMillis=200',
    serverArgs: 'nogui',
  },
  autoStartOnBoot: 'last_state',
  crash: {
    autoRestart: true,
    maxRetries: 3,
    delaySec: 10,
  },
  stop: {
    command: 'stop',
    timeoutSec: 30,
    onTimeout: 'kill',
  },
  restart: {
    mode: 'graceful',
    delaySec: 5,
    warnMessage: 'Sunucu 5 saniye içinde yeniden başlatılıyor...',
    warnSeconds: 5,
  },
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  selectedServer,
  onShowToast,
  servers,
  onSelectServer,
  onOpenNewServerModal,
}) => {
  const [initialSettings, setInitialSettings] = useState<ServerRuntimeSettings>(DEFAULT_SETTINGS);
  const [currentSettings, setCurrentSettings] = useState<ServerRuntimeSettings>(DEFAULT_SETTINGS);
  const [availableJars, setAvailableJars] = useState<string[]>([]);
  const [availableJavas, setAvailableJavas] = useState<JavaInstallation[]>([]);
  const [hostTotalRamMB, setHostTotalRamMB] = useState<number>(16384);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [restartBanner, setRestartBanner] = useState(false);
  const [commandArgsText, setCommandArgsText] = useState<string>('');
  const [catalogJavas, setCatalogJavas] = useState<Array<{
    majorVersion: number;
    name?: string;
    isLatest?: boolean;
    isLts?: boolean;
    vendor?: string;
  }>>([]);
  const [isLoadingJava, setIsLoadingJava] = useState(true);
  const [isInstallingJava, setIsInstallingJava] = useState(false);
  const [installingMajor, setInstallingMajor] = useState<number | null>(null);
  const [activeInstallInfo, setActiveInstallInfo] = useState<{
    majorVersion: number;
    step: string;
    progress: number;
    startTime?: number;
    error?: string | null;
  } | null>(null);

  // Unsaved changes confirmation modal
  const [discardModal, setDiscardModal] = useState<{ open: boolean; onConfirm: () => void }>({
    open: false,
    onConfirm: () => {},
  });

  // Real-time boundary calculation for JVM flags, jar boundary, and server arguments
  const parsedBoundary = useMemo(() => {
    return splitStartupCommandLine(commandArgsText, currentSettings.startup.jarFile);
  }, [commandArgsText, currentSettings.startup.jarFile]);

  // Real-time syntax validation for command arguments
  const syntaxValidation = useMemo(() => {
    return validateStartupCommandLine(commandArgsText);
  }, [commandArgsText]);

  // Official Java requirements state (initialized with local helper, updated via live API)
  const [javaReq, setJavaReq] = useState<JavaRequirement>(() =>
    getJavaRequirements(selectedServer?.type, selectedServer?.version)
  );
  const [isLoadingReqs, setIsLoadingReqs] = useState<boolean>(false);

  // Fetch official requirement from /api/servers/system/java/requirements with stale response guard
  useEffect(() => {
    if (!selectedServer?.version) return;
    let cancelled = false;
    setIsLoadingReqs(true);

    const fetchReqs = async () => {
      try {
        const core = selectedServer.type || 'paper';
        const res = await fetch(
          `/api/servers/system/java/requirements?core=${encodeURIComponent(core)}&version=${encodeURIComponent(selectedServer.version)}`,
          { credentials: 'include' }
        );
        if (!res.ok) throw new Error('Gereksinimler alınamadı.');
        const data = await res.json();
        if (!cancelled && data.success) {
          setJavaReq({
            minJava: data.minJava,
            recommendedJava: data.recommendedJava,
            compatibleMajors: Array.isArray(data.compatibleMajors) ? data.compatibleMajors : [],
            captionTr: data.captionTr || 'Gereksinimler belirlendi',
            isUnknown: !!data.isUnknown
          });
        }
      } catch {
        if (!cancelled) {
          setJavaReq(getJavaRequirements(selectedServer.type, selectedServer.version));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingReqs(false);
        }
      }
    };

    fetchReqs();
    return () => {
      cancelled = true;
    };
  }, [selectedServer?.id, selectedServer?.type, selectedServer?.version]);

  // Java selection options with compact labels and core+version compatibility filtering
  const compatibleInstalled = useMemo(() => {
    return availableJavas.filter((j) => {
      if (!j.majorVersion) return true;
      if (javaReq.minJava && javaReq.minJava >= 25) {
        return j.majorVersion >= 25;
      }
      return javaReq.isUnknown || javaReq.compatibleMajors.includes(j.majorVersion);
    });
  }, [availableJavas, javaReq]);

  const compatibleCatalog = useMemo(() => {
    const uninstalledCatalog = catalogJavas.filter(
      (c) => !availableJavas.some((j) => j.majorVersion === c.majorVersion)
    );
    return uninstalledCatalog.filter((c) => {
      if (!c.majorVersion) return true;
      if (javaReq.minJava && javaReq.minJava >= 25) {
        return c.majorVersion >= 25;
      }
      return javaReq.isUnknown || javaReq.compatibleMajors.includes(c.majorVersion);
    });
  }, [catalogJavas, availableJavas, javaReq]);

  const javaSelectOptions = useMemo(() => {
    return buildJavaSelectOptions({
      installedJavas: availableJavas,
      catalogJavas,
      javaReq,
      includeAuto: false,
      customJavaPath: currentSettings.startup.javaPath,
    });
  }, [availableJavas, catalogJavas, javaReq, currentSettings.startup.javaPath]);

  // Effective Java path: if current setting is empty or 'auto', default to recommended version
  const effectiveJavaPath = useMemo(() => {
    const raw = currentSettings.startup.javaPath;
    if (raw && raw !== 'auto') {
      return raw;
    }
    const recInstalled = availableJavas.find(
      (j) => j.majorVersion === javaReq.recommendedJava || (j.majorVersion && j.majorVersion >= 25 && j.majorVersion >= (javaReq.minJava || 25))
    );
    if (recInstalled) return recInstalled.path;
    const anyInstalled25 = availableJavas.find((j) => (j.majorVersion || 0) >= 25);
    if (anyInstalled25) return anyInstalled25.path;
    if (availableJavas.length > 0) return availableJavas[0].path;
    if (javaReq.recommendedJava) return `install-${javaReq.recommendedJava}`;
    return 'install-25';
  }, [currentSettings.startup.javaPath, availableJavas, javaReq]);

  // Warning for custom path if truly too low
  const customPathWarning = useMemo(() => {
    const checkPath = currentSettings.startup.javaPath || effectiveJavaPath;
    if (!checkPath || checkPath === 'auto' || checkPath.startsWith('install-')) return null;
    const detected = availableJavas.find((j) => j.path === checkPath);
    if (detected && detected.majorVersion && javaReq.minJava && detected.majorVersion < javaReq.minJava) {
      return `Seçili Java (Java ${detected.majorVersion}) bu sunucu için yetersiz. En az Java ${javaReq.minJava} gereklidir.`;
    }
    return null;
  }, [currentSettings.startup.javaPath, effectiveJavaPath, availableJavas, javaReq.minJava]);

  // Calculate dirty status
  const isDirty = useMemo(() => {
    return JSON.stringify(initialSettings) !== JSON.stringify(currentSettings);
  }, [initialSettings, currentSettings]);

  // Parse fallback settings from server instance
  const buildFallbackSettings = useCallback((srv: ServerInstance): ServerRuntimeSettings => {
    let maxMB = 2048;
    if (srv.ramAllocated) {
      const parsedNum = parseFloat(srv.ramAllocated);
      if (!isNaN(parsedNum) && parsedNum > 0) {
        maxMB = srv.ramAllocated.toLowerCase().includes('m') ? Math.round(parsedNum) : Math.round(parsedNum * 1024);
      }
    }
    const minMB = Math.min(1024, maxMB);

    return {
      memory: { minMB, maxMB },
      startup: {
        jarFile: srv.jarFile || 'server.jar',
        javaPath: srv.javaPath || null,
        jvmFlags: '-XX:+UseG1GC -XX:MaxGCPauseMillis=200',
        serverArgs: 'nogui',
      },
      autoStartOnBoot: 'last_state',
      crash: {
        autoRestart: true,
        maxRetries: 3,
        delaySec: 10,
      },
      stop: {
        command: 'stop',
        timeoutSec: 30,
        onTimeout: 'kill',
      },
      restart: {
        mode: 'graceful',
        delaySec: 5,
        warnMessage: 'Sunucu 5 saniye içinde yeniden başlatılıyor...',
        warnSeconds: 5,
      },
    };
  }, []);

  // Request tracking to prevent race conditions on server switch
  const loadReqIdRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const jarsReqIdRef = useRef(0);
  const jarsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      loadAbortRef.current?.abort();
      jarsAbortRef.current?.abort();
    };
  }, []);

  // Fetch server files to list JARs
  const fetchJars = useCallback(async (srvId: string) => {
    jarsAbortRef.current?.abort();
    const controller = new AbortController();
    jarsAbortRef.current = controller;
    const reqId = ++jarsReqIdRef.current;

    try {
      const res = await fetch(`/api/servers/${srvId}/files`, { signal: controller.signal });
      if (reqId !== jarsReqIdRef.current) return;
      if (res.ok) {
        const data = await res.json();
        if (reqId !== jarsReqIdRef.current) return;
        const files: any[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.entries)
          ? data.entries
          : Array.isArray(data?.files)
          ? data.files
          : [];
        const jars = files
          .filter((f) => f && f.name && f.name.toLowerCase().endsWith('.jar'))
          .map((f) => f.name);
        setAvailableJars(jars);
      }
    } catch (err: any) {
      if (reqId !== jarsReqIdRef.current || err?.name === 'AbortError') return;
      setAvailableJars([]);
    }
  }, []);

  // Fetch Java environments from host & dynamic Oracle catalog
  const fetchJavas = useCallback(async () => {
    setIsLoadingJava(true);
    try {
      let res = await fetch('/api/servers/system/java/catalog', { credentials: 'include' });
      if (!res.ok) {
        res = await fetch('/api/servers/system/java', { credentials: 'include' });
      }

      if (res.ok) {
        const data = await res.json();
        const installedList: JavaInstallation[] = Array.isArray(data)
          ? data
          : Array.isArray(data.installed)
          ? data.installed
          : Array.isArray(data.installations)
          ? data.installations
          : [];
        setAvailableJavas(installedList);

        const catalogList = Array.isArray(data.catalog) ? data.catalog : [];
        setCatalogJavas(catalogList);
      }
    } catch {
      setAvailableJavas([]);
      setCatalogJavas([]);
    } finally {
      setIsLoadingJava(false);
    }
  }, []);

  // Poll background Java installation status from /api/servers/system/java/install/status
  const checkInstallStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/servers/system/java/install/status', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const activeList = Array.isArray(data?.activeInstalls) ? data.activeInstalls : [];
        if (activeList.length > 0) {
          const current = activeList[0];
          setActiveInstallInfo(current);
          setIsInstallingJava(true);
          setInstallingMajor(current.majorVersion);
          return true;
        } else {
          setActiveInstallInfo((prev) => {
            if (prev) {
              // Installation just completed in background, refresh Java installations
              fetchJavas();
            }
            return null;
          });
          setIsInstallingJava(false);
          setInstallingMajor(null);
          return false;
        }
      }
    } catch {
      // Ignore background status polling errors
    }
    return false;
  }, [fetchJavas]);

  // Background installation polling loop (survives tab switches)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const poll = async () => {
      const isBusy = await checkInstallStatus();
      if (!cancelled) {
        const interval = isBusy ? 1000 : 4000;
        timer = setTimeout(poll, interval);
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [checkInstallStatus]);

  // Fetch host RAM
  const fetchHostRam = useCallback(async () => {
    try {
      const res = await fetch('/api/metrics/host');
      if (res.ok) {
        const data = await res.json();
        if (data?.memory?.totalBytes) {
          setHostTotalRamMB(Math.round(data.memory.totalBytes / (1024 * 1024)));
        }
      }
    } catch {
      // Default to 16GB
      setHostTotalRamMB(16384);
    }
  }, []);

  // Load server settings from backend
  const loadSettings = useCallback(async () => {
    if (!selectedServer) return;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const reqId = ++loadReqIdRef.current;

    setIsLoading(true);
    setRestartBanner(false);

    try {
      // 1. Fetch server runtime settings
      const res = await fetch(`/api/servers/${selectedServer.id}`, { signal: controller.signal });
      if (reqId !== loadReqIdRef.current) return;
      if (res.ok) {
        const data = await res.json();
        if (reqId !== loadReqIdRef.current) return;
        if (data.settings && typeof data.settings === 'object') {
          const merged: ServerRuntimeSettings = {
            memory: {
              minMB: data.settings.memory?.minMB ?? DEFAULT_SETTINGS.memory.minMB,
              maxMB: data.settings.memory?.maxMB ?? DEFAULT_SETTINGS.memory.maxMB,
            },
            startup: {
              jarFile: data.settings.startup?.jarFile || data.jarFile || 'server.jar',
              javaPath: data.settings.startup?.javaPath ?? data.javaPath ?? null,
              jvmFlags: data.settings.startup?.jvmFlags ?? DEFAULT_SETTINGS.startup.jvmFlags,
              serverArgs: data.settings.startup?.serverArgs ?? DEFAULT_SETTINGS.startup.serverArgs,
            },
            autoStartOnBoot: data.settings.autoStartOnBoot || 'last_state',
            crash: {
              autoRestart: data.settings.crash?.autoRestart ?? true,
              maxRetries: data.settings.crash?.maxRetries ?? 3,
              delaySec: data.settings.crash?.delaySec ?? 10,
            },
            stop: {
              command: data.settings.stop?.command || 'stop',
              timeoutSec: data.settings.stop?.timeoutSec ?? 30,
              onTimeout: data.settings.stop?.onTimeout || 'kill',
            },
            restart: {
              mode: data.settings.restart?.mode || 'graceful',
              delaySec: data.settings.restart?.delaySec ?? 5,
              warnMessage: data.settings.restart?.warnMessage ?? 'Sunucu yeniden başlatılıyor...',
              warnSeconds: data.settings.restart?.warnSeconds ?? 5,
            },
          };
          setInitialSettings(merged);
          setCurrentSettings(merged);
          setCommandArgsText(
            composeStartupCommandLine(
              merged.startup.jvmFlags,
              merged.startup.jarFile,
              merged.startup.serverArgs
            )
          );
        } else {
          // Fallback from server fields
          const fallback = buildFallbackSettings(data);
          setInitialSettings(fallback);
          setCurrentSettings(fallback);
          setCommandArgsText(
            composeStartupCommandLine(
              fallback.startup.jvmFlags,
              fallback.startup.jarFile,
              fallback.startup.serverArgs
            )
          );
        }
      }

      // Parallel helper queries
      fetchJars(selectedServer.id);
      fetchJavas();
      fetchHostRam();
    } catch (err: any) {
      if (reqId !== loadReqIdRef.current || err?.name === 'AbortError') return;
      onShowToast('Ayarlar Alınamadı', err.message, 'error');
    } finally {
      if (reqId === loadReqIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [selectedServer, buildFallbackSettings, fetchJars, fetchJavas, fetchHostRam, onShowToast]);

  useEffect(() => {
    loadSettings();
  }, [selectedServer?.id]);

  // Window beforeunload warning if dirty
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Handle server switch with unsaved changes prompt
  const handleSelectServerSafe = (target: ServerInstance) => {
    if (!onSelectServer) return;
    if (isDirty) {
      setDiscardModal({
        open: true,
        onConfirm: () => {
          onSelectServer(target);
          setDiscardModal({ open: false, onConfirm: () => {} });
        },
      });
      return;
    }
    onSelectServer(target);
  };

  // Revert changes
  const handleRevert = () => {
    setCurrentSettings(initialSettings);
    setCommandArgsText(
      composeStartupCommandLine(
        initialSettings.startup.jvmFlags,
        initialSettings.startup.jarFile,
        initialSettings.startup.serverArgs
      )
    );
    onShowToast('Değişiklikler Geri Alındı', 'Tüm form kaydedilmiş son duruma döndürüldü.', 'info');
  };

  // Update JAR in unified command arguments while preserving JVM flags and server arguments
  const handleJarChange = (newJar: string) => {
    const updated = updateJarInCommandLine(commandArgsText, newJar, currentSettings.startup.jarFile);
    const parsed = splitStartupCommandLine(updated, newJar);
    setCommandArgsText(updated);
    setCurrentSettings((prev) => ({
      ...prev,
      startup: {
        ...prev.startup,
        jarFile: newJar,
        jvmFlags: parsed.jvmFlags,
        serverArgs: parsed.serverArgs,
      },
    }));
  };

  // Apply Aikar preset: updates only JVM portion, preserves JAR and server arguments
  const handleApplyAikar = () => {
    const updated = applyAikarPreset(commandArgsText, AIKAR_FLAGS, currentSettings.startup.jarFile);
    const parsed = splitStartupCommandLine(updated, currentSettings.startup.jarFile);
    setCommandArgsText(updated);
    setCurrentSettings((prev) => ({
      ...prev,
      startup: {
        ...prev.startup,
        jvmFlags: AIKAR_FLAGS,
        serverArgs: parsed.serverArgs,
      },
    }));
    onShowToast('Aikar Bayrakları Uygulandı', 'Minecraft için optimize edilmiş G1GC bayrakları aktarıldı, sunucu argümanları korundu.', 'info');
  };

  // Direct editing of single command arguments textarea
  const handleCommandArgsChange = (val: string) => {
    setCommandArgsText(val);
    const parsed = splitStartupCommandLine(val, currentSettings.startup.jarFile);
    setCurrentSettings((prev) => ({
      ...prev,
      startup: {
        ...prev.startup,
        jvmFlags: parsed.jvmFlags,
        jarFile: parsed.jarFile || prev.startup.jarFile,
        serverArgs: parsed.serverArgs,
      },
    }));
  };

  // Dynamic Oracle / Temurin Java installation on demand
  const handleInstallJava = async (majorVersion: number) => {
    setIsInstallingJava(true);
    setInstallingMajor(majorVersion);
    setActiveInstallInfo({
      majorVersion,
      step: 'Kurulum başlatılıyor...',
      progress: 5,
    });
    const vendorName = [8, 11, 16, 17].includes(majorVersion) ? 'Eclipse Temurin' : 'Oracle';
    onShowToast('Java İndiriliyor', `Java ${majorVersion} (${vendorName}) paketi sunucuya indiriliyor ve kuruluyor...`, 'info');

    try {
      // Trigger status check immediately to capture progress
      setTimeout(() => {
        checkInstallStatus();
      }, 500);

      const res = await fetch('/api/servers/system/java/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ majorVersion }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Java ${majorVersion} kurulumu tamamlanamadı.`);
      }

      const result = await res.json();
      const detectedPath = result.path;

      // Update current settings with the newly installed Java path
      setCurrentSettings((prev) => ({
        ...prev,
        startup: {
          ...prev.startup,
          javaPath: detectedPath,
        },
      }));

      // Refresh installed Java and catalog
      await fetchJavas();

      onShowToast(
        'Java Başarıyla Kuruldu',
        `Java ${majorVersion} kuruldu ve sunucu yolu ${detectedPath} olarak seçildi.`,
        'success'
      );
    } catch (err: any) {
      onShowToast('Java Kurulum Hatası', err.message || 'Kurulum başarısız oldu.', 'error');
    } finally {
      setIsInstallingJava(false);
      setInstallingMajor(null);
      setActiveInstallInfo(null);
    }
  };

  // Save Settings
  const handleSave = async () => {
    if (!selectedServer || !isDirty) return;

    // Validate command arguments syntax
    const validation = validateStartupCommandLine(commandArgsText);
    if (!validation.valid) {
      onShowToast(
        'Geçersiz Komut Satırı Sözdizimi',
        validation.error || 'Komut satırında kapatılmamış tırnak işareti bulunmaktadır.',
        'error'
      );
      return;
    }

    setIsSaving(true);

    try {
      const settingsToSave: ServerRuntimeSettings = {
        ...currentSettings,
        startup: {
          ...currentSettings.startup,
          javaPath: (currentSettings.startup.javaPath && currentSettings.startup.javaPath !== 'auto')
            ? currentSettings.startup.javaPath
            : (effectiveJavaPath.startsWith('install-') ? null : effectiveJavaPath)
        }
      };

      const res = await fetch(`/api/servers/${selectedServer.id}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsToSave),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Ayarlar kaydedilemedi.');
      }

      const data: UpdateSettingsResponse = await res.json();
      if (data.settings) {
        setInitialSettings(data.settings);
        setCurrentSettings(data.settings);
        setCommandArgsText(
          composeStartupCommandLine(
            data.settings.startup?.jvmFlags ?? currentSettings.startup.jvmFlags,
            data.settings.startup?.jarFile ?? currentSettings.startup.jarFile,
            data.settings.startup?.serverArgs ?? currentSettings.startup.serverArgs
          )
        );
      } else {
        setInitialSettings(currentSettings);
      }

      if (data.requiresRestart) {
        setRestartBanner(true);
        onShowToast(
          'Ayarlar Kaydedildi (Yeniden Başlatma Gerekli)',
          'Yeni çalıştırma parametrelerinin geçerli olması için sunucuyu yeniden başlatın.',
          'warning'
        );
      } else {
        onShowToast('Ayarlar Kaydedildi', 'Sunucu çalıştırma parametreleri başarıyla güncellendi.', 'success');
      }
    } catch (err: any) {
      onShowToast('Kayıt Hatası', err.message || 'Ayarlar kaydedilemedi.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  if (!selectedServer) {
    return (
      <div className="p-12 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 text-center flex flex-col items-center justify-center gap-4 shadow-2xl max-w-2xl mx-auto my-8">
        <div className="p-4 rounded-2xl bg-white/5 border border-white/10 text-silver-400">
          <SlidersHorizontal className="w-8 h-8 text-silver-300" />
        </div>
        <div className="space-y-1">
          <h3 className="text-base font-bold text-white tracking-wide">Henüz Bir Sunucu Seçilmedi</h3>
          <p className="text-xs text-silver-400 font-sans max-w-md mx-auto">
            Sunucu çalıştırma ve başlatma parametrelerini yönetmek için lütfen bir sunucu seçin.
          </p>
        </div>
      </div>
    );
  }

  const exceedsHostRam = currentSettings.memory.maxMB > hostTotalRamMB;

  return (
    <div className="space-y-6">
      {/* Top Banner & Control Bar */}
      <div className="p-6 rounded-3xl glass-panel bg-zinc-950/80 border border-white/10 shadow-2xl flex flex-col xl:flex-row items-start xl:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          <div className="p-3.5 rounded-2xl bg-white/10 border border-white/20 text-white shadow-lg shrink-0">
            <SlidersHorizontal className="w-6 h-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-white tracking-wide truncate">Sunucu Çalıştırma Ayarları</h2>
              {isDirty && (
                <span className="px-2.5 py-0.5 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/20 text-[10px] font-mono shrink-0">
                  Kaydedilmemiş Değişiklikler
                </span>
              )}
            </div>
            <p className="text-xs text-silver-400 font-sans mt-0.5 truncate">
              "{selectedServer.name}" JVM bellek, başlangıç argümanları ve otomatik kurtarma yapılandırması
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-nowrap shrink-0 max-w-full overflow-x-auto">
          {servers && servers.length > 1 && (
            <div className="w-48 xl:w-56 min-w-[160px] shrink-0">
              <CustomSelect
                value={selectedServer.id}
                onChange={(val) => {
                  const target = servers.find((s) => s.id === val);
                  if (target) handleSelectServerSafe(target);
                }}
                options={servers.map((s) => ({
                  value: s.id,
                  label: s.name,
                  desc: s.version ? `${s.type || 'Server'} ${s.version}` : undefined,
                  icon: Server,
                }))}
                className="w-full"
              />
            </div>
          )}

          <button
            onClick={loadSettings}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-sans text-silver-300 hover:text-white transition-all disabled:opacity-40 shrink-0 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-white' : ''}`} />
            <span>Yenile</span>
          </button>

          {isDirty && (
            <button
              onClick={handleRevert}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-sans text-silver-300 hover:text-white transition-all shrink-0 whitespace-nowrap"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>Değişiklikleri Geri Al</span>
            </button>
          )}

          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="flex items-center gap-2 px-5 py-2 rounded-2xl bg-white text-black font-semibold text-xs hover:bg-silver-200 transition-all shadow-[0_0_20px_rgba(255,255,255,0.3)] active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Kaydediliyor...' : 'Ayarları Kaydet'}</span>
          </button>
        </div>
      </div>

      {/* Restart Required Warning Banner */}
      {restartBanner && (
        <div className="p-4 rounded-3xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-3 text-amber-200 shadow-xl">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            <div className="text-xs font-sans">
              <span className="font-bold">Yeniden Başlatma Gerekiyor:</span> Yapılan bellek ve JVM değişikliklerinin sunucu sürecinde aktif olabilmesi için sunucuyu yeniden başlatmanız gerekir.
            </div>
          </div>
          <button
            onClick={() => setRestartBanner(false)}
            className="p-1 rounded-lg hover:bg-amber-500/20 text-amber-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main Form Sections Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (8 cols): Memory & Startup & Auto-Boot */}
        <div className="lg:col-span-8 space-y-6">
          {/* Section 1: Bellek Ayarları (RAM Slider + Inputs) */}
          <div className="p-6 rounded-3xl bg-zinc-950/90 border border-white/10 shadow-2xl shadow-black/50 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Cpu className="w-4 h-4 text-white" />
                <h3 className="text-sm font-bold text-white tracking-wide">Bellek Yapılandırması</h3>
              </div>
              <span className="text-xs font-mono text-silver-400">
                Host Toplam: {formatRam(hostTotalRamMB)}
              </span>
            </div>

            {exceedsHostRam && (
              <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center gap-3 text-rose-300 text-xs font-sans">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>
                  <strong>Aşırı Bellek Uyarısı:</strong> Seçilen azami RAM ({formatRam(currentSettings.memory.maxMB)}), fiziksel host sunucu belleğini ({formatRam(hostTotalRamMB)}) aşıyor. Bu durum sunucunun bellek yetersizliğinden aniden kapanmasına veya çökmesine neden olabilir.
                </span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {/* Asgari RAM (minMB) */}
              <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-silver-300">Asgari Bellek</label>
                  <span className="text-xs font-mono font-bold text-white">
                    {formatRam(currentSettings.memory.minMB)}
                  </span>
                </div>
                <input
                  type="range"
                  min={512}
                  max={Math.min(currentSettings.memory.maxMB, 32768)}
                  step={256}
                  value={currentSettings.memory.minMB}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setCurrentSettings((prev) => ({
                      ...prev,
                      memory: { ...prev.memory, minMB: val },
                    }));
                  }}
                  className="w-full accent-white h-1.5 bg-white/10 rounded-lg cursor-pointer"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={256}
                    max={currentSettings.memory.maxMB}
                    step={256}
                    value={currentSettings.memory.minMB}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10) || 512;
                      setCurrentSettings((prev) => ({
                        ...prev,
                        memory: { ...prev.memory, minMB: val },
                      }));
                    }}
                    className="w-24 px-3 py-1.5 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                  />
                  <span className="text-xs text-silver-400 font-mono">MB</span>
                </div>
              </div>

              {/* Azami RAM (maxMB) */}
              <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-silver-300">Azami Bellek</label>
                  <span className="text-xs font-mono font-bold text-white">
                    {formatRam(currentSettings.memory.maxMB)}
                  </span>
                </div>
                <input
                  type="range"
                  min={1024}
                  max={Math.max(hostTotalRamMB, 32768)}
                  step={512}
                  value={currentSettings.memory.maxMB}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setCurrentSettings((prev) => ({
                      ...prev,
                      memory: {
                        minMB: Math.min(prev.memory.minMB, val),
                        maxMB: val,
                      },
                    }));
                  }}
                  className="w-full accent-white h-1.5 bg-white/10 rounded-lg cursor-pointer"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1024}
                    step={512}
                    value={currentSettings.memory.maxMB}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10) || 1024;
                      setCurrentSettings((prev) => ({
                        ...prev,
                        memory: {
                          minMB: Math.min(prev.memory.minMB, val),
                          maxMB: val,
                        },
                      }));
                    }}
                    className="w-24 px-3 py-1.5 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                  />
                  <span className="text-xs text-silver-400 font-mono">MB</span>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Başlangıç Parametreleri (JAR, Java, JVM Bayrakları, Argümanlar) */}
          <div className="p-6 rounded-3xl bg-zinc-950/90 border border-white/10 shadow-2xl shadow-black/50 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Code2 className="w-4 h-4 text-white" />
                <h3 className="text-sm font-bold text-white tracking-wide">Başlangıç Parametreleri</h3>
              </div>
              <span className="text-xs font-mono text-silver-400">Çekirdek & JVM Yürütme</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* JAR Dosyası Seçimi */}
              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                  Sunucu JAR Dosyası
                </label>
                {availableJars.length > 0 ? (
                  <CustomSelect
                    value={currentSettings.startup.jarFile}
                    onChange={(val) => handleJarChange(val)}
                    options={Array.from(new Set([currentSettings.startup.jarFile, ...availableJars]))
                      .filter(Boolean)
                      .map((jar) => ({
                        value: jar,
                        label: jar,
                      }))}
                    className="w-full font-mono"
                  />
                ) : (
                  <input
                    type="text"
                    value={currentSettings.startup.jarFile}
                    onChange={(e) => handleJarChange(e.target.value)}
                    placeholder="server.jar"
                    className="w-full px-4 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                  />
                )}
                <p className="text-[11px] text-silver-500 font-sans mt-1">Sunucu kök dizinindeki çalıştırılabilir paket</p>
              </div>

              {/* Java Sürümü / Yolu & Oracle Katalog Entegrasyonu */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-silver-300 block">
                    Java Çalışma Zamanı
                  </label>
                  {isInstallingJava && (
                    <span className="flex items-center gap-1.5 text-[11px] text-amber-300 font-medium">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Java {installingMajor || activeInstallInfo?.majorVersion} Kuruluyor (%{activeInstallInfo?.progress ?? 10})</span>
                    </span>
                  )}
                </div>
                <CustomSelect
                  disabled={isInstallingJava}
                  value={effectiveJavaPath}
                  onChange={(val) => {
                    const opt = javaSelectOptions.find((o) => o.value === val);
                    if (opt?.disabled || opt?.isInvalid) return;
                    if (val.startsWith('install-')) {
                      const major = parseInt(val.replace('install-', ''), 10);
                      if (!isNaN(major)) {
                        if (major < 25) return;
                        handleInstallJava(major);
                      }
                      return;
                    }
                    const found = availableJavas.find((j) => j.path === val);
                    if (found && found.majorVersion && found.majorVersion < 25) {
                      return;
                    }
                    setCurrentSettings((prev) => ({
                      ...prev,
                      startup: { ...prev.startup, javaPath: val },
                    }));
                  }}
                  options={javaSelectOptions}
                  className="w-full font-mono"
                />

                {/* Arka Planda Canlı Java İndirme ve İlerleme Paneli */}
                {isInstallingJava && (
                  <div className="mt-2 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/25 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-amber-300 font-medium">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
                        <span>Java {installingMajor || activeInstallInfo?.majorVersion} Kurulumu Sürüyor</span>
                      </span>
                      <span className="text-amber-200 font-mono font-bold text-xs">
                        %{activeInstallInfo?.progress ?? 10}
                      </span>
                    </div>
                    {/* Canlı İlerleme Çubuğu */}
                    <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-amber-400 h-full rounded-full transition-all duration-300 ease-out"
                        style={{ width: `${Math.min(100, Math.max(5, activeInstallInfo?.progress ?? 10))}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-silver-400 font-sans truncate">
                      {activeInstallInfo?.step || 'Arşiv indiriliyor ve sistem ortamı hazırlanıyor...'}
                    </p>
                  </div>
                )}

                {customPathWarning && (
                  <p className="text-[11px] text-amber-400 font-sans mt-1">
                    {customPathWarning}
                  </p>
                )}

                {/* Empty / Needs-install banner for this server version (!isLoadingJava && !isLoadingReqs && compatibleInstalled.length === 0) */}
                {!isLoadingJava && !isLoadingReqs && compatibleInstalled.length === 0 && (
                  <div className="mt-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <div className="space-y-1.5 flex-1">
                        <p className="text-amber-200 font-medium">
                          Bu sunucu için kurulu uyumlu Java bulunamadı.
                        </p>
                        <p className="text-[11px] text-amber-300/80">
                          {javaReq.captionTr}. Sunucunun başlatılabilmesi için uyumlu bir Java sürümü kurulmalıdır.
                        </p>
                        {javaReq.recommendedJava && (
                          <button
                            type="button"
                            disabled={isInstallingJava}
                            onClick={() => handleInstallJava(javaReq.recommendedJava!)}
                            className="mt-1 px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 font-medium text-[11px] transition-all flex items-center gap-1.5 disabled:opacity-50"
                          >
                            {isInstallingJava ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                <span>Java {installingMajor || javaReq.recommendedJava} Kuruluyor (%{activeInstallInfo?.progress ?? 10})</span>
                              </>
                            ) : (
                              <>
                                <Download className="w-3 h-3" />
                                <span>Java {javaReq.recommendedJava} Kur</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between text-[11px] text-silver-500 font-sans mt-1">
                  <span>Host makinesindeki Java SDK/JRE</span>
                  {catalogJavas.find((c) => c.isLatest) && (
                    <span className="text-[10px] text-emerald-400">
                      En yeni Oracle sürümü: Java {catalogJavas.find((c) => c.isLatest)?.majorVersion}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Tek Başlatma Komutu ve Argümanları Alanı */}
            <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-white/10">
                <div>
                  <h4 className="text-xs font-bold text-white tracking-wide">Komut Satırı Başlatma Argümanları</h4>
                  <p className="text-[11px] text-silver-400 font-sans mt-0.5">
                    JVM optimizasyon bayrakları ve sunucu başlatma argümanları tek komut satırında
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleApplyAikar}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white/10 hover:bg-white/20 border border-white/15 text-white text-[11px] font-sans transition-all active:scale-95"
                >
                  <Sparkles className="w-3 h-3 text-silver-300" />
                  <span>Aikar Bayraklarını Uygula</span>
                </button>
              </div>

              {/* Sınır Göstergesi */}
              <div className="p-3 rounded-2xl bg-black/40 border border-white/10 flex flex-wrap items-center gap-2 text-xs font-mono">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="px-2 py-0.5 rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-300 text-[10px] font-sans font-semibold">
                    JVM Bayrakları
                  </span>
                  <span className="text-silver-300 truncate max-w-[220px]" title={parsedBoundary.jvmFlags || '(Yok)'}>
                    {parsedBoundary.jvmFlags || <span className="text-silver-500 italic">Yok</span>}
                  </span>
                </div>
                <span className="text-silver-600 font-bold">→</span>
                <div className="flex items-center gap-1.5">
                  <span className="px-2 py-0.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-sans font-semibold">
                    -jar Sınırı
                  </span>
                  <span className="text-emerald-200 font-bold">
                    {parsedBoundary.jarFile}
                  </span>
                </div>
                <span className="text-silver-600 font-bold">→</span>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="px-2 py-0.5 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 text-[10px] font-sans font-semibold">
                    Sunucu Argümanları
                  </span>
                  <span className="text-silver-300 truncate max-w-[220px]" title={parsedBoundary.serverArgs || '(Yok)'}>
                    {parsedBoundary.serverArgs || <span className="text-silver-500 italic">Yok</span>}
                  </span>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                  Başlatma Komut Satırı (-jar sınırıyla birleşik)
                </label>
                <textarea
                  rows={4}
                  value={commandArgsText}
                  onChange={(e) => handleCommandArgsChange(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none leading-relaxed resize-y"
                  placeholder="-XX:+UseG1GC -jar server.jar nogui"
                  spellCheck={false}
                />
                <p className="text-[11px] text-silver-500 font-sans mt-1">
                  <strong>İpucu:</strong> <code className="text-silver-300">-jar {currentSettings.startup.jarFile}</code> öncesindeki parametreler JVM bayrağı, sonrasındakiler ise sunucu argümanı (örn. <code>nogui</code>) olarak ayrıştırılır ve sunucu yapılandırmasına kaydedilir. Tırnak içindeki boşluklu değerler korunur.
                </p>

                {!syntaxValidation.valid && (
                  <div className="mt-2.5 p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center gap-2.5 text-rose-300 text-xs font-sans">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span><strong>Sözdizimi Uyarısı:</strong> {syntaxValidation.error}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Section 3: Otomatik Başlatma (Boot / Reboot Davranışı) */}
          <div className="p-6 rounded-3xl bg-zinc-950/90 border border-white/10 shadow-2xl shadow-black/50 space-y-3">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Zap className="w-4 h-4 text-white" />
                <h3 className="text-sm font-bold text-white tracking-wide">Sistem Açılışında Otomatik Başlatma</h3>
              </div>
              <span className="text-[11px] text-silver-400 font-sans">Elektrik / Panel Yeniden Başlaması</span>
            </div>

            <p className="text-xs text-silver-400 font-sans pt-0.5">
              Elektrik gidip gelince, sunucu makinesi yeniden başladığında veya panel servisi devreye girdiğinde bu sunucunun nasıl davranacağını seçin:
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              {[
                {
                  id: 'never',
                  title: 'Asla Başlatma',
                  desc: 'Sunucu kapalı kalır, sadece elle başlatılır.',
                },
                {
                  id: 'always',
                  title: 'Her Zaman Başlat',
                  desc: 'Sistem açılınca sunucu otomatik olarak başlatılır.',
                },
                {
                  id: 'last_state',
                  title: 'Son Duruma Göre',
                  desc: 'Sistem kapanmadan önce açıksa yeniden açılır.',
                },
              ].map((opt) => {
                const isSelected = currentSettings.autoStartOnBoot === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setCurrentSettings((prev) => ({
                        ...prev,
                        autoStartOnBoot: opt.id as any,
                      }));
                    }}
                    className={`p-3.5 rounded-2xl border text-left transition-all flex flex-col justify-center gap-1 ${
                      isSelected
                        ? 'bg-white/15 border-white/40 shadow-md ring-1 ring-white/20'
                        : 'bg-white/[0.02] border-white/10 hover:border-white/25 hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="text-xs font-bold text-white">{opt.title}</span>
                      {isSelected && <CheckCircle2 className="w-4 h-4 text-white shrink-0" />}
                    </div>
                    <span className="text-[11px] text-silver-400 font-sans">{opt.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Column (4 cols): Crash, Stop & Restart Behaviors */}
        <div className="lg:col-span-4 space-y-6">
          {/* Section 4: Çökme Davranışı (Crash Recovery) */}
          <div className="p-6 rounded-3xl bg-zinc-950/90 border border-white/10 shadow-2xl shadow-black/50 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-white" />
                <h3 className="text-sm font-bold text-white tracking-wide">Çökme Davranışı</h3>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-2xl bg-white/[0.02] border border-white/10">
                <div>
                  <span className="text-xs font-bold text-white block">Otomatik Yeniden Başlat</span>
                  <span className="text-[11px] text-silver-400 font-sans block mt-0.5">Süreç beklenmedik şekilde çökerse kurtar</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCurrentSettings((prev) => ({
                      ...prev,
                      crash: { ...prev.crash, autoRestart: !prev.crash.autoRestart },
                    }));
                  }}
                  className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
                    currentSettings.crash.autoRestart ? 'bg-white' : 'bg-zinc-800'
                  }`}
                >
                  <div
                    className={`w-4 h-4 rounded-full bg-black transition-transform ${
                      currentSettings.crash.autoRestart ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {currentSettings.crash.autoRestart && (
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-1 block">Azami Deneme</label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={currentSettings.crash.maxRetries}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10) || 1;
                        setCurrentSettings((prev) => ({
                          ...prev,
                          crash: { ...prev.crash, maxRetries: val },
                        }));
                      }}
                      className="w-full px-3 py-1.5 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-1 block">Gecikme (sn)</label>
                    <input
                      type="number"
                      min={0}
                      max={120}
                      value={currentSettings.crash.delaySec}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10) || 0;
                        setCurrentSettings((prev) => ({
                          ...prev,
                          crash: { ...prev.crash, delaySec: val },
                        }));
                      }}
                      className="w-full px-3 py-1.5 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Section 5: Durdur'a Basınca Ne Olacak */}
          <div className="p-6 rounded-3xl bg-zinc-950/90 border border-white/10 shadow-2xl shadow-black/50 space-y-4">
            <div className="pb-3 border-b border-white/10">
              <h3 className="text-sm font-bold text-white tracking-wide">Durdurma Davranışı</h3>
              <p className="text-[11px] text-silver-400 font-sans mt-0.5">Durdur butonuna basıldığında uygulanacak adımlar</p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1 block">Konsol Komutu</label>
                <input
                  type="text"
                  value={currentSettings.stop.command}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCurrentSettings((prev) => ({
                      ...prev,
                      stop: { ...prev.stop, command: val },
                    }));
                  }}
                  placeholder="stop"
                  className="w-full px-4 py-2.5 rounded-2xl bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="text-xs font-semibold text-silver-300 mb-1 block">Zaman Aşımı (sn)</label>
                  <input
                    type="number"
                    min={5}
                    max={300}
                    value={currentSettings.stop.timeoutSec}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10) || 5;
                      setCurrentSettings((prev) => ({
                        ...prev,
                        stop: { ...prev.stop, timeoutSec: val },
                      }));
                    }}
                    className="w-full px-4 py-2.5 rounded-2xl bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="text-xs font-semibold text-silver-300 mb-1 block">Süre Dolunca</label>
                  <CustomSelect
                    value={currentSettings.stop.onTimeout}
                    onChange={(val) => {
                      setCurrentSettings((prev) => ({
                        ...prev,
                        stop: { ...prev.stop, onTimeout: val as any },
                      }));
                    }}
                    options={[
                      { value: 'kill', label: 'Zorla' },
                      { value: 'none', label: 'Bekleyerek' },
                    ]}
                    className="w-full"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 6: Yeniden Başlat'a Basınca Ne Olacak */}
          <div className="p-6 rounded-3xl bg-zinc-950/90 border border-white/10 shadow-2xl shadow-black/50 space-y-4">
            <div className="pb-3 border-b border-white/10">
              <h3 className="text-sm font-bold text-white tracking-wide">Yeniden Başlatma Davranışı</h3>
              <p className="text-[11px] text-silver-400 font-sans mt-0.5">Yeniden Başlat butonuna basıldığında uygulanacak adımlar</p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1 block">Kapatma Modu</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentSettings((prev) => ({
                        ...prev,
                        restart: { ...prev.restart, mode: 'graceful' },
                      }));
                    }}
                    className={`py-1.5 rounded-xl text-xs font-sans border transition-all ${
                      currentSettings.restart.mode === 'graceful'
                        ? 'bg-white text-black font-bold border-white'
                        : 'bg-white/5 text-silver-300 border-white/10'
                    }`}
                  >
                    Düzgün Kapatma
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentSettings((prev) => ({
                        ...prev,
                        restart: { ...prev.restart, mode: 'kill' },
                      }));
                    }}
                    className={`py-1.5 rounded-xl text-xs font-sans border transition-all ${
                      currentSettings.restart.mode === 'kill'
                        ? 'bg-white text-black font-bold border-white'
                        : 'bg-white/5 text-silver-300 border-white/10'
                    }`}
                  >
                    Zorla Kapat
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1 block">Gecikme Süresi (sn)</label>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={currentSettings.restart.delaySec}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10) || 0;
                    setCurrentSettings((prev) => ({
                      ...prev,
                      restart: { ...prev.restart, delaySec: val },
                    }));
                  }}
                  className="w-full px-3 py-1.5 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1 block">Oyunculara Uyarı Mesajı</label>
                <input
                  type="text"
                  value={currentSettings.restart.warnMessage || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCurrentSettings((prev) => ({
                      ...prev,
                      restart: { ...prev.restart, warnMessage: val },
                    }));
                  }}
                  placeholder="Sunucu 5 sn içinde yeniden başlayacak..."
                  className="w-full px-3 py-1.5 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-sans input-glow focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1 block">Kaç Sn Önce Bildirilsin</label>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={currentSettings.restart.warnSeconds}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10) || 0;
                    setCurrentSettings((prev) => ({
                      ...prev,
                      restart: { ...prev.restart, warnSeconds: val },
                    }));
                  }}
                  className="w-full px-3 py-1.5 rounded-xl bg-zinc-900 border border-white/15 text-xs text-white font-mono input-glow focus:outline-none"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Discard Unsaved Changes Modal */}
      <ConfirmModal
        isOpen={discardModal.open}
        title="Kaydedilmemiş Ayarlar"
        message="Sunucu ayarlarında kaydedilmemiş değişiklikleriniz var. Değişiklikleri kaybetmeden ayrılmak istiyor musunuz?"
        confirmText="Değişiklikleri Yoksay"
        cancelText="Geri Dön"
        variant="warning"
        onConfirm={discardModal.onConfirm}
        onCancel={() => setDiscardModal({ open: false, onConfirm: () => {} })}
      />
    </div>
  );
};
