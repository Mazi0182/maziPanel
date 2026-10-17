import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Server, 
  Plus,
  CheckCircle2, 
  X, 
  RefreshCw,
  Download,
  AlertTriangle,
  Check,
  Loader2,
  SlidersHorizontal,
  Info,
  ArrowRight,
  ArrowLeft,
  ChevronRight
} from 'lucide-react';
import { CustomSelect } from './CustomSelect';
import { ServerInstance } from '../types';
import { formatRam } from '../utils/format';
import { getJavaRequirements, JavaRequirement, buildJavaSelectOptions } from '../utils/javaCompatibility';
import { useJavaCatalog } from '../hooks/useJavaCatalog';

export interface NewServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (server: ServerInstance) => void;
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
}

type CoreType = 'purpur' | 'paper' | 'vanilla';

export const NewServerModal: React.FC<NewServerModalProps> = ({
  isOpen,
  onClose,
  onCreated,
  onShowToast,
}) => {
  // Sihirbaz Adımı ve Geçiş Yönü
  const [step, setStep] = useState<number>(1);
  const [direction, setDirection] = useState<number>(1);

  // Adım 1: Temel Bilgiler
  const [serverName, setServerName] = useState('');
  const [coreType, setCoreType] = useState<CoreType>('purpur');
  const [version, setVersion] = useState<string>('26.3');
  const [availableVersions, setAvailableVersions] = useState<string[]>(['26.3', '1.21.4', '1.20.4']);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);

  // Adım 2: Kaynaklar ve Java
  const [ram, setRam] = useState<number>(4);
  const [ramDirection, setRamDirection] = useState<'up' | 'down'>('up');
  const [isEditingRam, setIsEditingRam] = useState(false);
  const ramInputRef = useRef<HTMLInputElement>(null);

  const [port, setPort] = useState<string>('25565');
  const [portStatus, setPortStatus] = useState<{ checked: boolean; available?: boolean; message?: string }>({ checked: false });
  const [isCheckingPort, setIsCheckingPort] = useState<boolean>(false);
  const portRequestIdRef = useRef<number>(0);
  const portAbortControllerRef = useRef<AbortController | null>(null);
  const lastValidatedPortRef = useRef<string>('');

  // Java kataloğu önbellekli hook (modal açılır açılmaz arka planda çeker, anında döner)
  const {
    installedJavas,
    catalogJavas,
    isLoadingJava,
    javaError,
    refreshJavaCatalog,
  } = useJavaCatalog(isOpen);

  const [selectedJava, setSelectedJava] = useState<string>('');
  const [isInstallingJava, setIsInstallingJava] = useState(false);
  const [activeJavaInstall, setActiveJavaInstall] = useState<{
    majorVersion: number;
    step: string;
    progress: number;
  } | null>(null);

  // Adım 3: Oyun Ayarları
  const [difficulty, setDifficulty] = useState<'peaceful' | 'easy' | 'normal' | 'hard'>('normal');
  const [viewDistance, setViewDistance] = useState<number>(10);
  const [simulationDistance, setSimulationDistance] = useState<number>(10);
  const [onlineMode, setOnlineMode] = useState<boolean>(true);

  // Kurulum Süreci
  const [isInstalling, setIsInstalling] = useState(false);
  const [installStep, setInstallStep] = useState<string>('');
  const [installProgress, setInstallProgress] = useState<number>(0);

  // Modal sıfırlama (Açıldığında 1. adımdan başla)
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setDirection(1);
    }
  }, [isOpen]);

  // ESC ile kapatma (yalnızca kurulum yokken)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isInstalling) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isInstalling, onClose]);

  const handleRamSelect = (newRam: number) => {
    if (newRam !== ram) {
      setRamDirection(newRam > ram ? 'up' : 'down');
      setRam(newRam);
    }
  };

  const difficultyOptions: Array<{ id: 'peaceful' | 'easy' | 'normal' | 'hard'; name: string }> = [
    { id: 'peaceful', name: 'Barışçıl' },
    { id: 'easy', name: 'Kolay' },
    { id: 'normal', name: 'Normal' },
    { id: 'hard', name: 'Zor' },
  ];

  // Arka planda devam eden Java kurulumu durumunu kontrol et
  const checkInstallStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/servers/system/java/install/status', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const activeList = Array.isArray(data?.activeInstalls) ? data.activeInstalls : [];
        if (activeList.length > 0) {
          const current = activeList[0];
          setActiveJavaInstall(current);
          setIsInstallingJava(true);
          return true;
        } else {
          setActiveJavaInstall((prev) => {
            if (prev) {
              refreshJavaCatalog(true);
            }
            return null;
          });
          setIsInstallingJava(false);
          return false;
        }
      }
    } catch {}
    return false;
  }, [refreshJavaCatalog]);

  useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen, checkInstallStatus]);

  // Java gereksinim durumu (senkron yerel hesaplama + asenkron API doğrulama)
  const [javaReq, setJavaReq] = useState<JavaRequirement>(() => getJavaRequirements(coreType, version));
  const [isLoadingReqs, setIsLoadingReqs] = useState<boolean>(false);

  // Sürüm veya çekirdek değiştiğinde gereksinimleri güncelle
  useEffect(() => {
    if (!version) return;
    // Yerel kural matrisini anında uygula (ağ beklemesini beklemeden UI doğru kalsın)
    setJavaReq(getJavaRequirements(coreType, version));

    let cancelled = false;
    setIsLoadingReqs(true);

    const fetchReqs = async () => {
      try {
        const res = await fetch(
          `/api/servers/system/java/requirements?core=${encodeURIComponent(coreType)}&version=${encodeURIComponent(version)}`,
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
          setJavaReq(getJavaRequirements(coreType, version));
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
  }, [coreType, version]);

  // Java seçenekleri listesi
  const sortedJavaOptions = useMemo(() => {
    return buildJavaSelectOptions({
      installedJavas,
      catalogJavas,
      javaReq,
      includeAuto: false,
    });
  }, [installedJavas, catalogJavas, javaReq]);

  // Uyumlu Java seçenekleri alt kümesi
  const compatibleJavaOptions = useMemo(() => {
    return sortedJavaOptions.filter((opt) => !opt.isInvalid && opt.isCompatible);
  }, [sortedJavaOptions]);

  // Önerilen / Uyumlu Java seçeneğini senkron olarak belirleme (asla Java 25 altı seçilmez)
  const autoJavaChoice = useMemo<string>(() => {
    // 1. Önerilen kurulu Java (yalnızca >= 25)
    if (javaReq.recommendedJava && javaReq.recommendedJava >= 25) {
      const recInstalled = compatibleJavaOptions.find(
        (o) => o.installed && o.majorVersion === javaReq.recommendedJava && (o.majorVersion ?? 0) >= 25
      );
      if (recInstalled) return recInstalled.value;

      // 2. Önerilen indirilebilir Java (yalnızca >= 25)
      const recCatalog = compatibleJavaOptions.find(
        (o) => !o.installed && o.majorVersion === javaReq.recommendedJava && (o.majorVersion ?? 0) >= 25
      );
      if (recCatalog) return recCatalog.value;
    }

    // 3. Herhangi bir kurulu uyumlu Java (yalnızca >= 25)
    const anyInstalled = compatibleJavaOptions.find((o) => o.installed && (o.majorVersion ?? 0) >= 25);
    if (anyInstalled) return anyInstalled.value;

    // 4. İlk uyumlu Java seçeneği (yalnızca >= 25)
    const firstCompatible = compatibleJavaOptions.find((o) => (o.majorVersion ?? 0) >= 25);
    if (firstCompatible) {
      return firstCompatible.value;
    }

    // 5. Herhangi bir devre dışı olmayan seçenek (yalnızca >= 25)
    const anyNonInvalid = sortedJavaOptions.find((o) => !o.isInvalid && !o.disabled && (o.majorVersion ?? 0) >= 25);
    if (anyNonInvalid) return anyNonInvalid.value;

    // 6. Henüz katalog yüklenmemiş olsa bile önerilen sürüm >= 25 ise katalog değeri üret
    if (javaReq.recommendedJava && javaReq.recommendedJava >= 25) {
      return `install-${javaReq.recommendedJava}`;
    }

    // Sistem kuralı: Asla Java 25 altı otomatik seçilmez. Taban güvenli sürüm Java 25'tir.
    return 'install-25';
  }, [compatibleJavaOptions, sortedJavaOptions, javaReq.recommendedJava]);

  const prevCoreVersionRef = useRef({ coreType, version });

  // Java boşsa, katalog yüklendiğinde mevcut değer seçeneklerde yoksa veya sürüm değiştiğinde önerilen sürümü otomatik ata
  useEffect(() => {
    const versionChanged =
      prevCoreVersionRef.current.coreType !== coreType ||
      prevCoreVersionRef.current.version !== version;
    prevCoreVersionRef.current = { coreType, version };

    const existsInOptions =
      sortedJavaOptions.length === 0 ||
      sortedJavaOptions.some((o) => o.value === selectedJava && !o.disabled && !o.isInvalid);

    if (!selectedJava || !existsInOptions) {
      if (autoJavaChoice && autoJavaChoice !== selectedJava) {
        setSelectedJava(autoJavaChoice);
      }
    } else if (versionChanged) {
      const currentStillCompatible = compatibleJavaOptions.some((o) => o.value === selectedJava);
      if (!currentStillCompatible && autoJavaChoice && autoJavaChoice !== selectedJava) {
        setSelectedJava(autoJavaChoice);
      }
    }
  }, [compatibleJavaOptions, sortedJavaOptions, autoJavaChoice, coreType, version, selectedJava]);

  const handleInstallSelectedJava = async (major: number) => {
    if (isInstallingJava || isInstalling) return;
    setIsInstallingJava(true);
    setActiveJavaInstall({
      majorVersion: major,
      step: 'Kurulum başlatılıyor...',
      progress: 5,
    });
    try {
      const vendorName = [8, 11, 16, 17].includes(major) ? 'Eclipse Temurin' : 'Oracle';
      onShowToast('Java İndiriliyor', `Java ${major} (${vendorName}) indiriliyor ve doğrulanıyor...`, 'info');

      const res = await fetch('/api/servers/system/java/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ majorVersion: major }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Java ${major} kurulumu başarısız oldu.`);
      }

      const result = await res.json();
      onShowToast('Java Kuruldu', `Java ${major} başarıyla kuruldu ve algılandı.`, 'success');

      await refreshJavaCatalog(true);
      if (result.path) {
        setSelectedJava(result.path);
      }
    } catch (err: any) {
      onShowToast('Java Kurulum Hatası', err.message, 'error');
    } finally {
      setIsInstallingJava(false);
      setActiveJavaInstall(null);
    }
  };

  // Çekirdek türü değiştiğinde canlı sürümleri çek
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setIsLoadingVersions(true);

    fetch(`/api/servers/cores/versions?type=${coreType}`)
      .then((res) => {
        if (!res.ok) throw new Error('Sürümler alınamadı');
        return res.json();
      })
      .then((data) => {
        if (!isMounted) return;
        const vList: string[] = data.versions || [];
        setAvailableVersions(vList);
        if (vList.length > 0) {
          // Eğer mevcut seçili sürüm bu listede varsa koru, yoksa ilk sürümü seç
          setVersion((currentVer) => {
            if (currentVer && vList.includes(currentVer)) {
              return currentVer;
            }
            return vList[0];
          });
        }
        setIsLoadingVersions(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('Core versions fetch error:', err);
        const fallback = coreType === 'purpur' 
          ? ['26.3', '26.2', '26.1.2', '1.21.4', '1.20.4', '1.19.4']
          : ['1.21.4', '1.20.4', '1.19.4', '1.18.2'];
        setAvailableVersions(fallback);
        setVersion((currentVer) => {
          if (currentVer && fallback.includes(currentVer)) {
            return currentVer;
          }
          return fallback[0];
        });
        setIsLoadingVersions(false);
      });

    return () => {
      isMounted = false;
    };
  }, [coreType, isOpen]);

  // Port müsaitlik kontrolü (Debounce + AbortController + Kesin durum tutarlılığı)
  useEffect(() => {
    // Port boş ise
    if (!port || !port.trim()) {
      if (portAbortControllerRef.current) {
        portAbortControllerRef.current.abort();
        portAbortControllerRef.current = null;
      }
      setIsCheckingPort(false);
      setPortStatus({ checked: false });
      return;
    }

    const p = parseInt(port.trim(), 10);
    // Port geçersiz sayı veya aralık dışı ise
    if (isNaN(p) || p < 1 || p > 65535) {
      if (portAbortControllerRef.current) {
        portAbortControllerRef.current.abort();
        portAbortControllerRef.current = null;
      }
      setIsCheckingPort(false);
      setPortStatus({ checked: true, available: false, message: 'Geçersiz port numarası (1 - 65535).' });
      return;
    }

    // Önceki isteği abort et
    if (portAbortControllerRef.current) {
      portAbortControllerRef.current.abort();
      portAbortControllerRef.current = null;
    }

    const currentReqId = ++portRequestIdRef.current;
    const controller = new AbortController();
    portAbortControllerRef.current = controller;

    setIsCheckingPort(true);
    setPortStatus({ checked: false });

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/servers/check-port?port=${p}`, {
          signal: controller.signal,
        });

        if (currentReqId !== portRequestIdRef.current) return;

        if (res.ok) {
          const data = await res.json();
          if (currentReqId === portRequestIdRef.current) {
            setPortStatus({
              checked: true,
              available: Boolean(data.available),
              message: data.available ? 'Port kullanılabilir.' : (data.reason || 'Port kullanımda.'),
            });
            lastValidatedPortRef.current = String(p);
          }
        } else {
          if (currentReqId === portRequestIdRef.current) {
            setPortStatus({ checked: true, available: true, message: 'Port durumu doğrulanamadı.' });
            lastValidatedPortRef.current = String(p);
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          if (currentReqId === portRequestIdRef.current) {
            setIsCheckingPort(false);
          }
          return;
        }
        if (currentReqId === portRequestIdRef.current) {
          setPortStatus({ checked: true, available: true, message: 'Port durumu kontrol edilemedi.' });
          lastValidatedPortRef.current = String(p);
        }
      } finally {
        if (currentReqId === portRequestIdRef.current) {
          setIsCheckingPort(false);
          portAbortControllerRef.current = null;
        }
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
      if (currentReqId === portRequestIdRef.current) {
        setIsCheckingPort(false);
      }
    };
  }, [port]);

  // Senkron Adım Doğrulama ve Durum İpucu
  const stepValidation = useMemo<{
    isValid: boolean;
    reason: string | null;
    isChecking: boolean;
  }>(() => {
    if (step === 1) {
      if (!serverName.trim()) {
        return { isValid: false, reason: 'Sunucu adı gerekli', isChecking: false };
      }
      if (isLoadingVersions && !version) {
        return { isValid: false, reason: 'Sürümler yükleniyor...', isChecking: true };
      }
      if (!version.trim()) {
        return { isValid: false, reason: 'Minecraft sürümü seçilmedi', isChecking: false };
      }
      return { isValid: true, reason: null, isChecking: false };
    }

    if (step === 2) {
      if (!ram || ram <= 0) {
        return { isValid: false, reason: 'Geçerli bir RAM miktarı seçin', isChecking: false };
      }
      const portNum = parseInt(port, 10);
      if (!port || !port.trim() || isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return { isValid: false, reason: 'Geçerli bir port girin (1 - 65535)', isChecking: false };
      }
      if (isCheckingPort) {
        return { isValid: false, reason: 'Port kontrol ediliyor...', isChecking: true };
      }
      if (portStatus.checked && portStatus.available === false) {
        return { isValid: false, reason: portStatus.message || 'Port kullanımda', isChecking: false };
      }
      const effectiveJava = selectedJava || autoJavaChoice;
      if (!effectiveJava) {
        if (isLoadingJava) {
          return { isValid: false, reason: 'Java listesi taranıyor...', isChecking: true };
        }
        return { isValid: false, reason: 'Java çalışma zamanı seçilmeli', isChecking: false };
      }
      const chosenOpt = sortedJavaOptions.find((o) => o.value === effectiveJava);
      if (chosenOpt && (chosenOpt.isInvalid || chosenOpt.disabled || (chosenOpt.majorVersion && chosenOpt.majorVersion < 25))) {
        return { isValid: false, reason: 'Java 25 veya üzeri bir sürüm seçilmelidir', isChecking: false };
      }
      return { isValid: true, reason: null, isChecking: false };
    }

    if (step === 3) {
      return { isValid: true, reason: null, isChecking: false };
    }

    return { isValid: true, reason: null, isChecking: false };
  }, [
    step,
    serverName,
    version,
    isLoadingVersions,
    ram,
    port,
    isCheckingPort,
    portStatus,
    selectedJava,
    autoJavaChoice,
    sortedJavaOptions,
    isLoadingJava,
  ]);

  const canProceed = stepValidation.isValid;

  const nextStep = () => {
    if (!canProceed || step >= 4) return;
    setDirection(1);
    setStep((s) => s + 1);
  };

  const prevStep = () => {
    if (step <= 1) return;
    setDirection(-1);
    setStep((s) => s - 1);
  };

  // Sunucu Kurulumunu Başlat
  const handleCreate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!serverName.trim()) {
      onShowToast('Eksik Bilgi', 'Lütfen bir sunucu adı girin.', 'error');
      setStep(1);
      return;
    }

    const portNum = parseInt(port, 10);
    if (!port || isNaN(portNum) || portNum < 1 || portNum > 65535) {
      onShowToast('Geçersiz Port', 'Lütfen 1 - 65535 arasında geçerli bir port girin.', 'error');
      setStep(2);
      return;
    }

    setIsInstalling(true);
    setInstallProgress(15);
    setInstallStep('Sunucu parametreleri ve port ayarlanıyor...');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      let finalJavaPath = selectedJava || autoJavaChoice;

      // İndirilmemiş katalog Java seçildiyse (örn: "install-27") önce indir
      if (selectedJava && selectedJava.startsWith('install-')) {
        const targetMajor = parseInt(selectedJava.replace('install-', ''), 10);
        setInstallProgress(25);
        setInstallStep(`Oracle JDK ${targetMajor} paketi sunucuya indiriliyor ve hazırlanıyor...`);

        const installRes = await fetch('/api/servers/system/java/install', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({ majorVersion: targetMajor }),
        });

        if (!installRes.ok) {
          const errData = await installRes.json().catch(() => ({}));
          throw new Error(errData.error || `Java ${targetMajor} otomatik kurulumu tamamlanamadı.`);
        }

        const installResult = await installRes.json();
        finalJavaPath = installResult.path || '';
        refreshJavaCatalog(true);
      }

      setInstallProgress(50);
      setInstallStep(`"${coreType.toUpperCase()}" ${version} jar paketi sunucuya indiriliyor...`);

      const progressTimer2 = setTimeout(() => {
        setInstallProgress(80);
        setInstallStep('Sunucu dizini, eula.txt ve server.properties yapılandırılıyor...');
      }, 1200);

      const response = await fetch('/api/servers/create', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          name: serverName.trim(),
          type: coreType,
          version,
          port: portNum,
          ramMin: `${Math.min(ram, 2)}G`,
          ramMax: `${ram}G`,
          javaPath: finalJavaPath || undefined,
          difficulty,
          viewDistance,
          simulationDistance,
          onlineMode,
        }),
      });

      clearTimeout(progressTimer2);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Sunucu oluşturulurken hata oluştu (HTTP ${response.status}).`);
      }

      const created = await response.json();
      setInstallProgress(100);
      setInstallStep('Kurulum başarıyla tamamlandı!');

      setTimeout(() => {
        setIsInstalling(false);
        setInstallProgress(0);
        onCreated({
          id: created.id,
          name: created.name,
          type: coreType === 'purpur' ? 'Purpur' : coreType === 'paper' ? 'Paper' : 'Vanilla',
          version: created.version || version,
          port: created.port || portNum,
          status: 'offline',
          ramAllocated: formatRam(`${ram}G`),
          playersCount: 0,
          maxPlayers: typeof created.maxPlayers === 'number' ? created.maxPlayers : (created.server?.maxPlayers || 10),
        });
        onShowToast('Sunucu Oluşturuldu', `"${created.name}" başarıyla kuruldu ve hazırlandı.`, 'success');
        onClose();
      }, 500);
    } catch (err: any) {
      setIsInstalling(false);
      setInstallProgress(0);
      onShowToast('Kurulum Hatası', err.message || 'Sunucu oluşturulamadı.', 'error');
    }
  };

  const coreOptions = [
    {
      id: 'purpur' as CoreType,
      name: 'Purpur',
      desc: 'Yüksek TPS, geniş yapılandırma ve 26.3 desteği',
    },
    {
      id: 'paper' as CoreType,
      name: 'Paper',
      desc: 'Kararlı eklenti ekosistemi ve async motoru',
    },
    {
      id: 'vanilla' as CoreType,
      name: 'Vanilla',
      desc: 'Saf Mojang Minecraft sunucu çekirdeği',
    },
  ];

  const ramQuickOptions = [2, 4, 6, 8, 12, 16];

  const wizardSteps = [
    { id: 1, title: 'Temel Bilgiler', desc: 'Ad, çekirdek ve sürüm' },
    { id: 2, title: 'Kaynaklar', desc: 'RAM, port ve Java' },
    { id: 3, title: 'Oyun Ayarları', desc: 'Zorluk ve mesafeler' },
    { id: 4, title: 'Özet ve Onay', desc: 'Kurulum doğrulaması' },
  ];

  // Adım geçiş animasyon varyantı
  const stepVariants = {
    enter: (dir: number) => ({
      x: dir > 0 ? 24 : -24,
      opacity: 0,
    }),
    center: {
      x: 0,
      opacity: 1,
    },
    exit: (dir: number) => ({
      x: dir > 0 ? -24 : 24,
      opacity: 0,
    }),
  };

  const [shouldRender, setShouldRender] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
    } else {
      const timer = setTimeout(() => setShouldRender(false), 230);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Seçili Java'nın etiket bilgisi
  const selectedJavaDisplay = useMemo(() => {
    const found = sortedJavaOptions.find((o) => o.value === selectedJava);
    if (!found) return selectedJava || 'Belirlenmedi';
    return found.label;
  }, [sortedJavaOptions, selectedJava]);

  if (!shouldRender) return null;

  return (
    <div 
      onClick={(e) => {
        if (e.target === e.currentTarget && !isInstalling && isOpen) onClose();
      }}
      className={`fixed inset-0 z-[200] flex items-center justify-center p-4 overflow-y-auto ${
        isOpen ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
    >
      {/* Backdrop Blur */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: isOpen ? 1 : 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={() => !isInstalling && isOpen && onClose()}
        className="fixed inset-0 bg-black/80 backdrop-blur-xl"
        aria-hidden="true"
      />

      {/* Modal Container */}
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{
          opacity: isOpen ? 1 : 0,
          scale: isOpen ? 1 : 0.96,
          y: isOpen ? 0 : 10,
        }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-xl rounded-3xl bg-zinc-950 border border-white/10 shadow-[0_25px_70px_-15px_rgba(0,0,0,0.9)] p-6 z-10 overflow-visible my-auto flex flex-col"
      >
            {/* Close Button */}
            {!isInstalling && (
              <button
                type="button"
                onClick={onClose}
                className="absolute top-5 right-5 p-1.5 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="Kapat"
              >
                <X className="w-4 h-4" />
              </button>
            )}

            {/* Header */}
            <div className="flex items-center gap-3.5 pb-4 border-b border-white/10">
              <div className="p-3 rounded-2xl bg-white/10 border border-white/15 text-white">
                <Plus className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white tracking-wide">
                  Yeni Sunucu Oluşturma Sihirbazı
                </h3>
                <p className="text-xs text-silver-400 font-sans mt-0.5">
                  Çekirdek jarını otomatik indir ve Debian ortamında hazırla
                </p>
              </div>
            </div>

            {/* Stepper Göstergesi */}
            {!isInstalling && (
              <div className="pt-4 pb-2">
                <div className="grid grid-cols-4 gap-2">
                  {wizardSteps.map((ws) => {
                    const isCompleted = ws.id < step;
                    const isCurrent = ws.id === step;
                    return (
                      <div
                        key={ws.id}
                        className={`p-2.5 rounded-2xl border text-center flex flex-col items-center justify-center transition-all ${
                          isCurrent
                            ? 'bg-white/10 border-white/30 ring-1 ring-white/15'
                            : isCompleted
                            ? 'bg-white/[0.04] border-white/15 text-silver-300'
                            : 'bg-white/[0.01] border-white/5 opacity-50'
                        }`}
                      >
                        <div className="flex items-center justify-center gap-1.5 mb-1 w-full">
                          {isCompleted ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          ) : (
                            <span
                              className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[10px] font-mono font-bold shrink-0 ${
                                isCurrent
                                  ? 'bg-white text-black'
                                  : 'bg-white/10 text-silver-400'
                              }`}
                            >
                              {ws.id}
                            </span>
                          )}
                          <span className={`text-[11px] font-bold truncate ${isCurrent ? 'text-white' : 'text-silver-300'}`}>
                            {ws.title}
                          </span>
                        </div>
                        <p className="text-[10px] text-silver-400 font-sans truncate w-full">
                          {ws.desc}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sihirbaz Adımları İçeriği */}
            <div className="mt-4 pb-5 min-h-[310px] flex flex-col justify-start">
              {/* ADIM 1: TEMEL BİLGİLER */}
              {step === 1 && (
                <motion.div
                  key="step-1"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                  className="space-y-4"
                >
                  {/* Sunucu Adı */}
                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                      Sunucu Adı <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      disabled={isInstalling}
                      value={serverName}
                      onChange={(e) => setServerName(e.target.value)}
                      placeholder="Örn: Ana Sunucu"
                      className="w-full px-4 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white placeholder-silver-500 focus:outline-none focus:border-white/40 font-sans transition-all disabled:opacity-50"
                    />
                  </div>

                  {/* Çekirdek Türü Seçici */}
                  <div>
                    <label className="text-xs font-semibold text-silver-300 mb-2 block">
                      Sunucu Çekirdeği
                    </label>
                    <div className="grid grid-cols-3 gap-2.5">
                      {coreOptions.map((core) => {
                        const isSelected = coreType === core.id;
                        return (
                          <button
                            key={core.id}
                            type="button"
                            disabled={isInstalling}
                            onClick={() => setCoreType(core.id)}
                            className={`p-3 rounded-2xl border text-left transition-all flex flex-col justify-start gap-1.5 min-h-[76px] ${
                              isSelected
                                ? 'bg-white/15 border-white/40 shadow-[0_0_15px_rgba(255,255,255,0.15)] ring-1 ring-white/20'
                                : 'bg-white/[0.02] border-white/10 hover:border-white/25 hover:bg-white/5'
                            }`}
                          >
                            <div className="flex items-center justify-between w-full">
                              <span className={`text-xs font-bold ${isSelected ? 'text-white' : 'text-silver-200'}`}>
                                {core.name}
                              </span>
                              {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-white shrink-0" />}
                            </div>
                            <span className="text-xs text-silver-400 font-sans leading-relaxed">
                              {core.desc}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Sürüm Seçimi (Canlı API Listesi) */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-silver-300">
                        Minecraft Sürümü
                      </label>
                      {isLoadingVersions && (
                        <span className="text-[11px] text-silver-400 font-sans flex items-center gap-1.5">
                          <RefreshCw className="w-3 h-3 animate-spin text-white" />
                          Sürümler çekiliyor...
                        </span>
                      )}
                    </div>

                    <CustomSelect
                      disabled={isInstalling || isLoadingVersions}
                      value={version}
                      onChange={setVersion}
                      options={availableVersions.map((v) => ({
                        value: v,
                        label: `Sürüm ${v}`,
                        desc: v === '26.3' ? 'En Yeni' : undefined,
                      }))}
                      placeholder={isLoadingVersions ? 'Sürümler alınıyor...' : 'Sürüm seçin...'}
                    />
                  </div>
                </motion.div>
              )}

              {/* ADIM 2: KAYNAKLAR VE JAVA */}
              {step === 2 && (
                <motion.div
                  key="step-2"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                  className="space-y-4"
                >
                  {/* RAM Miktarı */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-silver-300">
                        RAM Miktarı
                      </label>
                      <div 
                        onClick={() => {
                          if (!isInstalling) {
                            setIsEditingRam(true);
                            setTimeout(() => ramInputRef.current?.focus(), 0);
                          }
                        }}
                        className="flex items-center gap-1.5 bg-zinc-900 border border-white/15 rounded-xl px-2.5 py-1 cursor-text hover:border-white/30 transition-colors"
                      >
                        {isEditingRam ? (
                          <input
                            ref={ramInputRef}
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            disabled={isInstalling}
                            autoFocus
                            value={ram || ''}
                            onBlur={() => setIsEditingRam(false)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                setIsEditingRam(false);
                              }
                            }}
                            onChange={(e) => {
                              const clean = e.target.value.replace(/[^0-9]/g, '');
                              const val = parseInt(clean, 10);
                              const nextVal = isNaN(val) ? 0 : Math.max(1, Math.min(val, 128));
                              handleRamSelect(nextVal);
                            }}
                            className="w-10 bg-transparent text-right text-xs font-mono font-bold text-white focus:outline-none"
                          />
                        ) : (
                          <div className="relative overflow-hidden flex items-center justify-end min-w-[28px] h-4">
                            <span className="font-mono font-bold text-xs text-white">
                              {ram}
                            </span>
                          </div>
                        )}
                        <span className="text-xs font-mono text-silver-400 select-none">GB</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-6 gap-1.5">
                      {ramQuickOptions.map((r) => (
                        <button
                          key={r}
                          type="button"
                          disabled={isInstalling}
                          onClick={() => {
                            setIsEditingRam(false);
                            handleRamSelect(r);
                          }}
                          className={`py-1.5 rounded-xl text-xs font-mono font-medium transition-all ${
                            ram === r
                              ? 'bg-white text-black shadow-md font-bold'
                              : 'bg-white/5 text-silver-300 hover:text-white hover:bg-white/10 border border-white/10'
                          }`}
                        >
                          {formatRam(`${r}G`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Port & Java Seçimi */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Sunucu Portu */}
                    <div>
                      <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                        Sunucu Portu
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          disabled={isInstalling}
                          value={port}
                          onChange={(e) => {
                            const cleanVal = e.target.value.replace(/[^0-9]/g, '');
                            setPort(cleanVal);
                          }}
                          placeholder="Örn: 25565"
                          className="w-full px-3.5 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white focus:outline-none focus:border-white/40 font-mono transition-all pr-9"
                        />
                        {isCheckingPort && (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-silver-400" />
                          </div>
                        )}
                      </div>
                      {isCheckingPort ? (
                        <p className="text-[11px] font-sans mt-1.5 flex items-center gap-1.5 text-silver-400">
                          <Loader2 className="w-3 h-3 animate-spin text-white shrink-0" />
                          <span>Port kullanılabilirliği kontrol ediliyor...</span>
                        </p>
                      ) : portStatus.checked && port ? (
                        <p className={`text-[11px] font-sans mt-1.5 flex items-center gap-1.5 ${
                          portStatus.available ? 'text-emerald-400' : 'text-rose-400'
                        }`}>
                          {portStatus.available ? (
                            <Check className="w-3 h-3 shrink-0" />
                          ) : (
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                          )}
                          <span>{portStatus.message}</span>
                        </p>
                      ) : null}
                    </div>

                    {/* Java Sürümü */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs font-semibold text-silver-300">
                          Java Çalışma Zamanı
                        </label>
                        {isLoadingJava && (
                          <span className="text-[10px] text-silver-400 font-sans flex items-center gap-1">
                            <RefreshCw className="w-2.5 h-2.5 animate-spin text-white" />
                            Taranıyor...
                          </span>
                        )}
                      </div>
                      {isLoadingJava && sortedJavaOptions.length === 0 ? (
                        <div className="h-[42px] w-full rounded-2xl bg-zinc-900 border border-white/10 animate-pulse flex items-center px-3.5 gap-2.5">
                          <div className="w-3.5 h-3.5 rounded-full bg-white/10 shrink-0" />
                          <div className="h-3.5 w-32 rounded bg-white/10" />
                        </div>
                      ) : (
                        <CustomSelect
                          disabled={isInstalling || isLoadingJava}
                          value={selectedJava || autoJavaChoice}
                          onChange={(val) => {
                            const opt = sortedJavaOptions.find((o) => o.value === val);
                            if (opt && (opt.disabled || opt.isInvalid)) return;
                            if (opt?.majorVersion && opt.majorVersion < 25) return;
                            if (val.startsWith('install-')) {
                              const major = parseInt(val.replace('install-', ''), 10);
                              if (!isNaN(major) && major < 25) return;
                            }
                            const found = installedJavas.find((j) => j.path === val);
                            if (found && found.majorVersion && Number(found.majorVersion) < 25) {
                              return;
                            }
                            setSelectedJava(val);
                          }}
                          options={sortedJavaOptions}
                          placeholder={isLoadingJava ? 'Java sürümleri yükleniyor...' : 'Java sürümü seçin...'}
                        />
                      )}

                        {/* Arka Planda Canlı Java İndirme Paneli */}
                        {isInstallingJava && (
                          <div className="mt-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="flex items-center gap-1.5 text-amber-300 font-medium">
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
                                <span>Java {activeJavaInstall?.majorVersion || ''} Kuruluyor</span>
                              </span>
                              <span className="text-amber-200 font-mono font-bold text-xs">
                                %{activeJavaInstall?.progress ?? 10}
                              </span>
                            </div>
                            <div className="w-full bg-white/10 rounded-full h-1 overflow-hidden">
                              <div
                                className="bg-amber-400 h-full rounded-full transition-all duration-300 ease-out"
                                style={{ width: `${Math.min(100, Math.max(5, activeJavaInstall?.progress ?? 10))}%` }}
                              />
                            </div>
                            <p className="text-[10px] text-silver-400 font-sans truncate">
                              {activeJavaInstall?.step || 'Arşiv indiriliyor ve SHA-256 kontrol ediliyor...'}
                            </p>
                          </div>
                        )}

                        {/* Kurulu Olmayan Java İçin Hızlı Kurulum */}
                        {(() => {
                          const sel = sortedJavaOptions.find((o) => o.value === selectedJava);
                          if (sel && !sel.installed && sel.majorVersion) {
                            return (
                              <div className="mt-2 p-2 rounded-xl bg-white/[0.03] border border-white/10 flex items-center justify-between text-xs">
                                <span className="text-[11px] text-silver-400 font-sans flex items-center gap-1.5">
                                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                  Kurulu değil, kurulumda otomatik indirilir.
                                </span>
                                <button
                                  type="button"
                                  disabled={isInstalling || isInstallingJava}
                                  onClick={() => sel.majorVersion && handleInstallSelectedJava(sel.majorVersion)}
                                  className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-[11px] transition-all flex items-center gap-1 shrink-0 disabled:opacity-50"
                                >
                                  {isInstallingJava ? (
                                    <>
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      Yükleniyor...
                                    </>
                                  ) : (
                                    <>
                                      <Download className="w-3 h-3" />
                                      Şimdi Kur
                                    </>
                                  )}
                                </button>
                              </div>
                            );
                          }
                          return null;
                        })()}

                        {javaError && (
                          <p className="text-[10px] text-amber-400 font-sans mt-1">
                            {javaError}
                          </p>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* ADIM 3: OYUN AYARLARI */}
                {step === 3 && (
                  <motion.div
                    key="step-3"
                    custom={direction}
                    variants={stepVariants}
                    initial="enter"
                    animate="center"
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="space-y-4"
                  >
                    {/* Zorluk */}
                    <div>
                      <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                        Zorluk Derecesi
                      </label>
                      <div className="grid grid-cols-4 gap-1.5">
                        {difficultyOptions.map((opt) => {
                          const isSelected = difficulty === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              disabled={isInstalling}
                              onClick={() => setDifficulty(opt.id)}
                              className={`py-2 rounded-xl text-xs font-medium transition-all ${
                                isSelected
                                  ? 'bg-white text-black shadow-md font-bold'
                                  : 'bg-white/5 text-silver-300 hover:text-white hover:bg-white/10 border border-white/10'
                              }`}
                            >
                              {opt.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Görüş & Simülasyon Mesafesi */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {/* Görüş Mesafesi */}
                      <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-[11px] font-medium text-silver-300">
                            Görüş Mesafesi
                          </label>
                          <span className="text-xs font-mono font-bold text-white bg-white/5 px-2 py-0.5 rounded-lg border border-white/10">
                            {viewDistance} chunk
                          </span>
                        </div>
                        <input
                          type="range"
                          min={2}
                          max={32}
                          step={1}
                          disabled={isInstalling}
                          value={viewDistance}
                          onChange={(e) => setViewDistance(parseInt(e.target.value, 10))}
                          className="w-full accent-white bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                        />
                        <div className="flex justify-between text-[10px] text-silver-500 font-mono">
                          <span>2</span>
                          <span>Varsayılan: 10</span>
                          <span>32</span>
                        </div>
                      </div>

                      {/* Simülasyon Mesafesi */}
                      <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-[11px] font-medium text-silver-300">
                            Simülasyon Mesafesi
                          </label>
                          <span className="text-xs font-mono font-bold text-white bg-white/5 px-2 py-0.5 rounded-lg border border-white/10">
                            {simulationDistance} chunk
                          </span>
                        </div>
                        <input
                          type="range"
                          min={5}
                          max={32}
                          step={1}
                          disabled={isInstalling}
                          value={simulationDistance}
                          onChange={(e) => setSimulationDistance(parseInt(e.target.value, 10))}
                          className="w-full accent-white bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                        />
                        <div className="flex justify-between text-[10px] text-silver-500 font-mono">
                          <span>5</span>
                          <span>10</span>
                          <span>32</span>
                        </div>
                      </div>
                    </div>

                    {/* Orijinal Mod Toggle & Güvenlik Uyarısı */}
                    <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/10">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <span className="text-xs font-semibold text-white block">
                            Orijinal Mod
                          </span>
                          <span className="text-[11px] text-silver-400 font-sans block mt-0.5">
                            {onlineMode
                              ? 'Yalnızca resmi Mojang / Microsoft hesaplarının girişine izin verilir.'
                              : 'Resmi olmayan istemcilerin bağlanmasına izin verilir.'}
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={onlineMode}
                          disabled={isInstalling}
                          onClick={() => setOnlineMode(!onlineMode)}
                          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            onlineMode ? 'bg-white' : 'bg-zinc-800'
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-black shadow-lg ring-0 transition duration-200 ease-in-out ${
                              onlineMode ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>

                      <AnimatePresence initial={false}>
                        {!onlineMode && (
                          <motion.div
                            key="offline-mode-warning"
                            initial={{ opacity: 0, height: 0, marginTop: 0 }}
                            animate={{ opacity: 1, height: 'auto', marginTop: 10 }}
                            exit={{ opacity: 0, height: 0, marginTop: 0 }}
                            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                            className="overflow-hidden"
                          >
                            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs flex items-start gap-2.5">
                              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                              <div className="text-[11px] text-amber-200/90 font-sans leading-relaxed">
                                <strong className="font-semibold text-amber-200">Güvenlik Uyarısı:</strong> Orijinal Mod kapalı olduğunda resmi kimlik doğrulaması yapılmaz. Sunucunuzda bir kimlik doğrulama eklentisi kullanmanız önemle önerilir.
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )}

                {/* ADIM 4: ÖZET VE ONAY */}
                {step === 4 && (
                  <motion.div
                    key="step-4"
                    custom={direction}
                    variants={stepVariants}
                    initial="enter"
                    animate="center"
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="space-y-3.5"
                  >
                    <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-2.5">
                      <div className="flex items-center justify-between pb-2.5 border-b border-white/10">
                        <span className="text-xs font-semibold text-white flex items-center gap-2">
                          <Server className="w-3.5 h-3.5 text-white" />
                          Sunucu Yapılandırma Özeti
                        </span>
                        <span className="text-[11px] font-mono text-silver-300 bg-white/5 px-2.5 py-0.5 rounded-lg border border-white/10">
                          {coreType.toUpperCase()} {version}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5 text-xs">
                        <div className="px-3 py-2 rounded-xl bg-white/[0.025] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Sunucu Adı</span>
                          <span className="text-white font-semibold truncate block mt-0.5">{serverName}</span>
                        </div>
                        <div className="px-3 py-2 rounded-xl bg-white/[0.025] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Çekirdek & Sürüm</span>
                          <span className="text-white font-semibold block mt-0.5">
                            {coreType === 'purpur' ? 'Purpur' : coreType === 'paper' ? 'Paper' : 'Vanilla'} {version}
                          </span>
                        </div>
                        <div className="px-3 py-2 rounded-xl bg-white/[0.025] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Ayrılan RAM</span>
                          <span className="text-white font-mono font-semibold block mt-0.5">{ram} GB</span>
                        </div>
                        <div className="px-3 py-2 rounded-xl bg-white/[0.025] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Sunucu Portu</span>
                          <span className="text-white font-mono font-semibold block mt-0.5">{port}</span>
                        </div>
                        <div className="px-3 py-2 rounded-xl bg-white/[0.025] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Java Çalışma Zamanı</span>
                          <span className="text-white font-semibold truncate block mt-0.5">{selectedJavaDisplay}</span>
                        </div>
                        <div className="px-3 py-2 rounded-xl bg-white/[0.025] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Orijinal Mod</span>
                          <span className={`font-semibold block mt-0.5 ${onlineMode ? 'text-emerald-400' : 'text-silver-300'}`}>
                            {onlineMode ? 'Açık' : 'Kapalı'}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2.5 text-xs pt-0.5">
                        <div className="px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Zorluk Derecesi</span>
                          <span className="text-white font-semibold block mt-0.5">
                            {difficultyOptions.find((d) => d.id === difficulty)?.name}
                          </span>
                        </div>
                        <div className="px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Görüş Mesafesi</span>
                          <span className="text-white font-mono font-semibold block mt-0.5">{viewDistance} chunk</span>
                        </div>
                        <div className="px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                          <span className="text-[11px] text-silver-400 block">Simülasyon Mesafesi</span>
                          <span className="text-white font-mono font-semibold block mt-0.5">{simulationDistance} chunk</span>
                        </div>
                      </div>
                    </div>

                    <div className="p-3 rounded-2xl bg-sky-500/10 border border-sky-500/20 text-xs flex items-center gap-2.5">
                      <Info className="w-4 h-4 text-sky-400 shrink-0" />
                      <span className="text-[11px] text-sky-200/90 font-sans leading-relaxed">
                        Onayladıktan sonra sunucu dizini oluşturulacak, çekirdek JAR dosyası otomatik indirilecek ve yapılandırılacaktır.
                      </span>
                    </div>

                    {/* Kurulum İlerleme Çubuğu */}
                    {isInstalling && (
                      <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-2 mt-2">
                        <div className="flex items-center justify-between text-xs font-sans text-silver-300">
                          <span className="flex items-center gap-2">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin text-white" />
                            {installStep}
                          </span>
                          <span className="text-white font-mono font-bold">{installProgress}%</span>
                        </div>
                        <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                          <motion.div
                            className="h-full bg-white rounded-full shadow-[0_0_10px_#ffffff]"
                            initial={{ width: 0 }}
                            animate={{ width: `${installProgress}%` }}
                            transition={{ duration: 0.3 }}
                          />
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
            </div>

            {/* Footer Butonları */}
            <div className="flex items-center justify-between pt-4 mt-1 border-t border-white/10">
              {/* Sol Buton: İptal / Geri */}
              {step === 1 ? (
                <button
                  type="button"
                  disabled={isInstalling}
                  onClick={onClose}
                  className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all disabled:opacity-40"
                >
                  İptal
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isInstalling}
                  onClick={prevStep}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-all disabled:opacity-40"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Geri</span>
                </button>
              )}

              {/* Sağ Alan: İleri / Kurulumu Başlat */}
              <div className="flex items-center gap-3">
                {step < 4 ? (
                  <button
                    type="button"
                    disabled={isInstalling || !canProceed}
                    onClick={nextStep}
                    className="flex items-center gap-1.5 px-5 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.25)] active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {stepValidation.isChecking ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Kontrol ediliyor...</span>
                      </>
                    ) : (
                      <>
                        <span>İleri</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isInstalling || !serverName.trim()}
                    onClick={() => handleCreate()}
                    className="flex items-center gap-2 px-5 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.25)] active:scale-95 disabled:opacity-40"
                  >
                    {isInstalling ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Kuruluyor...</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        <span>Kurulumu Başlat</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </div>
  );
};
