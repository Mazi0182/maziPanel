import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  UploadCloud, 
  FileArchive, 
  CheckCircle2, 
  AlertCircle, 
  AlertTriangle,
  Download,
  Loader2,
  X, 
  ArrowRight, 
  RefreshCw
} from 'lucide-react';
import { CustomSelect } from './CustomSelect';
import { useJavaCatalog } from '../hooks/useJavaCatalog';
import { getJavaRequirements, buildJavaSelectOptions } from '../utils/javaCompatibility';

interface ZipImporterProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: (serverName: string, core: string, ram: number, port: number) => void;
  onShowToast?: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
}

export const ZipImporter: React.FC<ZipImporterProps> = ({
  isOpen,
  onClose,
  onImportComplete,
  onShowToast,
}) => {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [serverName, setServerName] = useState('Yeni Minecraft Sunucusu');
  const [selectedCore, setSelectedCore] = useState('Paper');
  const [selectedJava, setSelectedJava] = useState('');
  const [isInstallingJava, setIsInstallingJava] = useState(false);
  const [ramAllocated, setRamAllocated] = useState(4);
  const [port, setPort] = useState('25565');
  
  const [step, setStep] = useState<'upload' | 'config' | 'processing' | 'done'>('upload');
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const {
    installedJavas,
    catalogJavas,
    isLoadingJava,
    javaError,
    refreshJavaCatalog,
  } = useJavaCatalog(isOpen);

  const javaReq = useMemo(
    () => getJavaRequirements(selectedCore.toLowerCase(), '26.3'),
    [selectedCore]
  );

  const sortedJavaOptions = useMemo(() => {
    return buildJavaSelectOptions({
      installedJavas,
      catalogJavas,
      javaReq,
      includeAuto: false,
    });
  }, [installedJavas, catalogJavas, javaReq]);

  const compatibleJavaOptions = useMemo(() => {
    return sortedJavaOptions.filter((opt) => !opt.isInvalid && opt.isCompatible);
  }, [sortedJavaOptions]);

  const autoJavaChoice = useMemo<string>(() => {
    if (javaReq.recommendedJava && javaReq.recommendedJava >= 25) {
      const recInstalled = compatibleJavaOptions.find(
        (o) => o.installed && o.majorVersion === javaReq.recommendedJava && (o.majorVersion ?? 0) >= 25
      );
      if (recInstalled) return recInstalled.value;

      const recCatalog = compatibleJavaOptions.find(
        (o) => !o.installed && o.majorVersion === javaReq.recommendedJava && (o.majorVersion ?? 0) >= 25
      );
      if (recCatalog) return recCatalog.value;
    }

    const anyInstalled = compatibleJavaOptions.find((o) => o.installed && (o.majorVersion ?? 0) >= 25);
    if (anyInstalled) return anyInstalled.value;

    const firstCompatible = compatibleJavaOptions.find((o) => (o.majorVersion ?? 0) >= 25);
    if (firstCompatible) return firstCompatible.value;

    const anyNonInvalid = sortedJavaOptions.find((o) => !o.isInvalid && !o.disabled && (o.majorVersion ?? 0) >= 25);
    if (anyNonInvalid) return anyNonInvalid.value;

    if (javaReq.recommendedJava && javaReq.recommendedJava >= 25) {
      return `install-${javaReq.recommendedJava}`;
    }

    return 'install-25';
  }, [compatibleJavaOptions, sortedJavaOptions, javaReq.recommendedJava]);

  useEffect(() => {
    const existsInOptions =
      sortedJavaOptions.length === 0 ||
      sortedJavaOptions.some((o) => o.value === selectedJava && !o.disabled && !o.isInvalid);

    if (!selectedJava || !existsInOptions) {
      if (autoJavaChoice && autoJavaChoice !== selectedJava) {
        setSelectedJava(autoJavaChoice);
      }
    }
  }, [sortedJavaOptions, autoJavaChoice, selectedJava]);

  const handleInstallSelectedJava = useCallback(async (major: number) => {
    if (isInstallingJava || step === 'processing') return;
    setIsInstallingJava(true);
    setErrorMsg('');
    try {
      const vendorName = [8, 11, 16, 17].includes(major) ? 'Eclipse Temurin' : 'Oracle';
      onShowToast?.('Java İndiriliyor', `Java ${major} (${vendorName}) indiriliyor ve doğrulanıyor...`, 'info');

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
      onShowToast?.('Java Kuruldu', `Java ${major} başarıyla kuruldu ve algılandı.`, 'success');

      await refreshJavaCatalog(true);
      if (result.path) {
        setSelectedJava(result.path);
      }
    } catch (err: any) {
      const msg = err.message || 'Java kurulumu sırasında hata oluştu.';
      setErrorMsg(msg);
      onShowToast?.('Java Kurulum Hatası', msg, 'error');
    } finally {
      setIsInstallingJava(false);
    }
  }, [isInstallingJava, step, onShowToast, refreshJavaCatalog]);

  const setTrackedTimeout = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timersRef.current.delete(t);
      fn();
    }, ms);
    timersRef.current.add(t);
    return t;
  };

  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current.clear();
    };
  }, []);

  // Close on ESC
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 'processing' && !isInstallingJava) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, step, isInstallingJava, onClose]);

  const coresOptions = [
    { value: 'Paper', label: 'Paper', desc: 'Optimize edilmiş çekirdek' },
    { value: 'Purpur', label: 'Purpur', desc: 'Yüksek TPS ve esneklik' },
    { value: 'Fabric', label: 'Fabric', desc: 'Modlu sunucu altyapısı' },
    { value: 'Spigot', label: 'Spigot', desc: 'Standart eklenti çekirdeği' },
    { value: 'Vanilla', label: 'Vanilla', desc: 'Saf Mojang sunucusu' },
  ];

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.name.endsWith('.zip')) {
        setSelectedFile(file);
        setServerName(file.name.replace(/\.zip$/i, ''));
        setStep('config');
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      setServerName(file.name.replace(/\.zip$/i, ''));
      setStep('config');
    }
  };

  const startImportProcess = async () => {
    if (!selectedFile) return;

    const portNum = parseInt(port, 10);
    if (!port || isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setErrorMsg('Lütfen 1 - 65535 arasında geçerli bir port girin.');
      return;
    }

    const effectiveJava = selectedJava || autoJavaChoice;
    const chosenOpt = sortedJavaOptions.find((o) => o.value === effectiveJava);
    if (chosenOpt && (chosenOpt.isInvalid || chosenOpt.disabled || (chosenOpt.majorVersion && chosenOpt.majorVersion < 25))) {
      setErrorMsg('Java 25 veya üzeri bir çalışma zamanı seçilmelidir.');
      return;
    }

    setStep('processing');
    setProgress(15);
    setStatusMessage('ZIP paketi ve çalışma zamanı hazırlanıyor...');
    setErrorMsg('');

    try {
      let finalJavaPath = effectiveJava;

      if (finalJavaPath && finalJavaPath.startsWith('install-')) {
        const targetMajor = parseInt(finalJavaPath.replace('install-', ''), 10);
        setProgress(25);
        setStatusMessage(`Oracle JDK ${targetMajor} paketi sunucuya indiriliyor ve doğrulanıyor...`);

        const installRes = await fetch('/api/servers/system/java/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('name', serverName);
      formData.append('type', selectedCore.toLowerCase());
      formData.append('port', String(portNum));
      formData.append('ram', `${ramAllocated}G`);
      if (finalJavaPath) {
        formData.append('javaPath', finalJavaPath);
      }

      const timer1 = setTrackedTimeout(() => {
        setProgress(55);
        setStatusMessage('ZIP arşivi Debian sunucu dizinine açılıyor...');
      }, 700);

      const timer2 = setTrackedTimeout(() => {
        setProgress(85);
        setStatusMessage('Yapılandırma dosyaları ve Java ortamı bağlanıyor...');
      }, 1400);

      const res = await fetch('/api/servers/import-zip', {
        method: 'POST',
        body: formData,
      });

      clearTimeout(timer1);
      clearTimeout(timer2);

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'İçe aktarma işlemi başarısız oldu.');
      }

      setProgress(100);
      setStatusMessage('İçe aktarma tamamlandı! Sunucu kullanıma hazır.');
      setTrackedTimeout(() => {
        setStep('done');
      }, 400);
    } catch (err: any) {
      setErrorMsg(err.message || 'İçe aktarma sırasında hata oluştu.');
      setStep('config');
    }
  };

  const handleFinish = () => {
    const portNum = parseInt(port, 10) || 25565;
    onImportComplete(serverName, selectedCore, ramAllocated, portNum);
    resetForm();
    onClose();
  };

  const resetForm = () => {
    setSelectedFile(null);
    setStep('upload');
    setProgress(0);
    setStatusMessage('');
    setErrorMsg('');
  };

  const ramQuickOptions = [2, 4, 6, 8, 12, 16];
  const [shouldRender, setShouldRender] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
    } else {
      const timer = setTimeout(() => setShouldRender(false), 230);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!shouldRender) return null;

  return (
    <div
      className={`fixed inset-0 z-[200] flex items-center justify-center p-4 overflow-y-auto ${
        isOpen ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
    >
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: isOpen ? 1 : 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={step !== 'processing' && isOpen ? onClose : undefined}
        className="fixed inset-0 bg-black/80 backdrop-blur-xl"
      />

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
        className="w-full max-w-xl rounded-3xl bg-zinc-950 border border-white/10 shadow-[0_25px_70px_-15px_rgba(0,0,0,0.9)] p-6 relative overflow-visible z-10 my-auto"
      >
        {/* Modal Header (Title Case, no uppercase İ) */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-white/10 border border-white/15 text-white">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-wide">
                ZIP Arşivinden Sunucu İçe Aktar
              </h3>
              <p className="text-xs text-silver-400 font-sans">
                Mevcut Minecraft sunucu yedeğinizi sisteme yükleyin
              </p>
            </div>
          </div>
          {step !== 'processing' && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Kapat"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {errorMsg && (
          <div className="mt-4 p-3 rounded-2xl bg-white/5 border border-white/20 text-xs text-silver-200 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-white shrink-0" />
            <span className="font-sans">{errorMsg}</span>
          </div>
        )}

        {/* Step 1: Upload Dropzone */}
        {step === 'upload' && (
          <div className="mt-5 space-y-4">
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-3xl p-8 text-center cursor-pointer transition-all flex flex-col items-center justify-center min-h-[220px] ${
                dragActive
                  ? 'border-white bg-white/10 scale-[1.01]'
                  : 'border-white/15 hover:border-white/30 bg-white/[0.02]'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="p-4 rounded-3xl bg-white/5 border border-white/10 text-white mb-3 shadow-lg">
                <FileArchive className="w-8 h-8" />
              </div>
              <p className="text-sm font-semibold text-white mb-1">
                ZIP sunucu dosyasını buraya sürükleyin
              </p>
              <p className="text-xs text-silver-400 font-sans">
                veya bilgisayarınızdan seçmek için tıklayın
              </p>
            </div>
          </div>
        )}

        {/* Step 2: Configuration */}
        {step === 'config' && (
          <div className="mt-5 space-y-4">
            <div className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <FileArchive className="w-4 h-4 text-white" />
                <span className="text-xs font-mono text-silver-200 font-semibold">{selectedFile?.name}</span>
              </div>
              <span className="text-xs text-silver-400 font-mono">
                {selectedFile ? (selectedFile.size / (1024 * 1024)).toFixed(1) + ' MB' : '0 MB'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Sunucu Adı</label>
                <input
                  type="text"
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-2xl bg-zinc-900 border border-white/15 text-xs text-white focus:outline-none focus:border-white/40 font-sans"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Sunucu Portu</label>
                <input
                  type="text"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="Örn: 25565"
                  className="w-full px-4 py-2.5 rounded-2xl bg-zinc-900 border border-white/15 text-xs text-white focus:outline-none focus:border-white/40 font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-silver-300 mb-1.5 block">Sunucu Çekirdeği</label>
                <CustomSelect
                  value={selectedCore}
                  onChange={setSelectedCore}
                  options={coresOptions}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-silver-300">Java Çalışma Zamanı</label>
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
                    disabled={isLoadingJava || isInstallingJava}
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
                {(() => {
                  const sel = sortedJavaOptions.find((o) => o.value === (selectedJava || autoJavaChoice));
                  if (sel && !sel.installed && sel.majorVersion) {
                    return (
                      <div className="mt-2 p-2 rounded-xl bg-white/[0.03] border border-white/10 flex items-center justify-between text-xs">
                        <span className="text-[11px] text-silver-400 font-sans flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          Kurulu değil, kurulumda otomatik indirilir.
                        </span>
                        <button
                          type="button"
                          disabled={isInstallingJava}
                          onClick={() => sel.majorVersion && handleInstallSelectedJava(sel.majorVersion)}
                          className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-[11px] transition-all flex items-center gap-1 shrink-0 disabled:opacity-50 cursor-pointer"
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

            {/* RAM Miktarı */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-silver-300">
                  RAM Miktarı
                </label>
                <div className="flex items-center gap-1.5 bg-zinc-900 border border-white/15 rounded-xl px-2.5 py-1">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={ramAllocated || ''}
                    onChange={(e) => {
                      const clean = e.target.value.replace(/[^0-9]/g, '');
                      const val = parseInt(clean, 10);
                      setRamAllocated(isNaN(val) ? 0 : Math.max(1, Math.min(val, 128)));
                    }}
                    className="w-12 bg-transparent text-right text-xs font-mono font-bold text-white focus:outline-none"
                  />
                  <span className="text-xs font-mono text-silver-400">GB</span>
                </div>
              </div>
              <div className="grid grid-cols-6 gap-1.5">
                {ramQuickOptions.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRamAllocated(r)}
                    className={`py-1.5 rounded-xl text-xs font-mono font-medium transition-all ${
                      ramAllocated === r
                        ? 'bg-white text-black shadow-md font-bold'
                        : 'bg-white/5 text-silver-300 hover:text-white hover:bg-white/10 border border-white/10'
                    }`}
                  >
                    {r} GB
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-white/10">
              <button
                type="button"
                onClick={resetForm}
                disabled={isInstallingJava}
                className="text-xs text-silver-400 hover:text-white transition-colors font-sans disabled:opacity-40"
              >
                Farklı dosya seç
              </button>
              <button
                onClick={startImportProcess}
                disabled={isInstallingJava}
                className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs shadow-md transition-all active:scale-95 disabled:opacity-40"
              >
                <span>İçe Aktarmayı Başlat</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Processing Progress */}
        {step === 'processing' && (
          <div className="mt-8 mb-4 space-y-4 text-center">
            <div className="inline-flex p-4 rounded-3xl bg-white/5 border border-white/10 text-white mb-2">
              <RefreshCw className="w-8 h-8 animate-spin" />
            </div>
            <h4 className="text-sm font-bold text-white font-sans">{statusMessage}</h4>
            <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden max-w-md mx-auto">
              <motion.div
                className="h-full bg-white rounded-full shadow-[0_0_10px_#ffffff]"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </div>
        )}

        {/* Step 4: Done */}
        {step === 'done' && (
          <div className="mt-6 space-y-4 text-center">
            <div className="inline-flex p-4 rounded-3xl bg-white/10 border border-white/20 text-white mb-2 shadow-lg">
              <CheckCircle2 className="w-10 h-10 text-white" />
            </div>
            <h4 className="text-base font-bold text-white font-sans">İçe Aktarma Başarıyla Tamamlandı!</h4>
            <p className="text-xs text-silver-400 font-sans max-w-sm mx-auto">
              "{serverName}" sunucunuz oluşturuldu ve Debian dizinine yerleştirildi. Artık sunucular listenizden yönetebilirsiniz.
            </p>
            <div className="pt-4">
              <button
                onClick={handleFinish}
                className="px-6 py-2.5 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs shadow-md transition-all active:scale-95"
              >
                Sunucu Yönetimine Git
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
};
