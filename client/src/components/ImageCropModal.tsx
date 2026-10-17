import React, { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Cropper, { Area } from 'react-easy-crop';
import { X, ZoomIn, ZoomOut, Check, Crop } from 'lucide-react';

interface ImageCropModalProps {
  isOpen: boolean;
  imageSrc: string | null;
  serverName: string;
  onClose: () => void;
  onSave: (croppedBlob: Blob) => Promise<void>;
}

async function getCroppedImg(imageSrc: string, pixelCrop: Area): Promise<Blob> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = imageSrc;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
  });

  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas bağlamı alınamadı');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    64,
    64
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Görsel dönüştürülemedi'));
    }, 'image/png');
  });
}

export const ImageCropModal: React.FC<ImageCropModalProps> = ({
  isOpen,
  imageSrc,
  serverName,
  onClose,
  onSave,
}) => {
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Close on ESC
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  // Reset state when opened with new image
  useEffect(() => {
    if (isOpen) {
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setPreviewUrl(null);
    }
  }, [isOpen, imageSrc]);

  const onCropComplete = useCallback((_croppedArea: Area, currentPixels: Area) => {
    setCroppedAreaPixels(currentPixels);
  }, []);

  // Live 64x64 preview generator with debounce
  useEffect(() => {
    if (!imageSrc || !croppedAreaPixels) return;

    let isSubscribed = true;
    const timeout = setTimeout(async () => {
      try {
        const blob = await getCroppedImg(imageSrc, croppedAreaPixels);
        if (isSubscribed) {
          const url = URL.createObjectURL(blob);
          setPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
        }
      } catch {}
    }, 100);

    return () => {
      isSubscribed = false;
      clearTimeout(timeout);
    };
  }, [imageSrc, croppedAreaPixels]);

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleSaveCrop = async () => {
    if (!imageSrc || !croppedAreaPixels || isSaving) return;
    setIsSaving(true);
    try {
      const blob = await getCroppedImg(imageSrc, croppedAreaPixels);
      await onSave(blob);
      onClose();
    } catch (err: any) {
      console.error('Kırpma hatası:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const [shouldRender, setShouldRender] = useState(Boolean(isOpen && imageSrc));

  useEffect(() => {
    if (isOpen && imageSrc) {
      setShouldRender(true);
    } else {
      const timer = setTimeout(() => setShouldRender(false), 230);
      return () => clearTimeout(timer);
    }
  }, [isOpen, imageSrc]);

  if (!shouldRender || !imageSrc) return null;

  return (
    <div 
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving && isOpen) onClose();
      }}
      className={`fixed inset-0 z-[250] flex items-center justify-center p-4 overflow-y-auto ${
        isOpen ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
    >
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: isOpen ? 1 : 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={() => {
          if (!isSaving && isOpen) onClose();
        }}
        className="fixed inset-0 bg-black/80 backdrop-blur-xl"
      />

      {/* Modal Container */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{
          opacity: isOpen ? 1 : 0,
          scale: isOpen ? 1 : 0.95,
          y: isOpen ? 0 : 10,
        }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg rounded-3xl bg-zinc-950/95 border border-white/20 shadow-2xl p-6 z-10 flex flex-col gap-5 text-white"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-white/10 border border-white/15 text-white">
              <Crop className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-wide">Sunucu İkonunu Düzenle</h3>
              <p className="text-xs text-silver-400 font-sans mt-0.5">
                "{serverName}" için 64x64 kare sunucu simgesi
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="p-1.5 rounded-full text-silver-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
            aria-label="Kapat"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Interactive Cropper Area */}
        <div className="relative w-full h-64 sm:h-72 rounded-2xl overflow-hidden bg-black/90 border border-white/15 shadow-inner">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="rect"
            showGrid={true}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>

        {/* Controls: Zoom Slider & 64x64 Preview */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-1">
          {/* Zoom Slider */}
          <div className="flex items-center gap-3 w-full sm:w-auto flex-1">
            <ZoomOut className="w-4 h-4 text-silver-400 shrink-0" />
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="Yakınlaştırma düzeyi"
              className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-white"
            />
            <ZoomIn className="w-4 h-4 text-silver-400 shrink-0" />
            <span className="text-xs font-mono text-silver-400 min-w-[3rem] text-right">
              {zoom.toFixed(1)}x
            </span>
          </div>

          {/* 64x64 Result Preview Box */}
          <div className="flex items-center gap-3 bg-white/5 border border-white/10 p-2 rounded-2xl shrink-0">
            <div className="w-10 h-10 rounded-xl overflow-hidden bg-black/60 border border-white/20 flex items-center justify-center shrink-0">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="64x64 Önizleme"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-[9px] font-mono text-silver-500">64x64</span>
              )}
            </div>
            <div className="text-[11px] font-sans text-silver-300 pr-1">
              <div className="font-semibold text-white">64×64 PNG</div>
              <div className="text-[10px] text-silver-400">Minecraft Formatı</div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white border border-white/10 text-xs font-medium transition-colors"
          >
            Vazgeç
          </button>
          <button
            type="button"
            onClick={handleSaveCrop}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-5 py-2 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs shadow-md active:scale-95 transition-all disabled:opacity-40"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Kaydediliyor...' : 'Kaydet'}</span>
          </button>
        </div>
      </motion.div>
    </div>
  );
};
