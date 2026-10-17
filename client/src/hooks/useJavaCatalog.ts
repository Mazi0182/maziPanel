import { useState, useEffect, useCallback, useRef } from 'react';

export interface JavaInstalledItem {
  path: string;
  majorVersion?: number;
  rawVersion?: string;
  vendor?: string;
}

export interface JavaCatalogItem {
  majorVersion: number;
  name?: string;
  vendor?: string;
}

export interface JavaCatalogCacheData {
  installed: JavaInstalledItem[];
  catalog: JavaCatalogItem[];
  networkError: string | null;
  timestamp: number;
}

// Modül düzeyinde singleton bellek önbelleği
let memoryCache: JavaCatalogCacheData | null = null;
let pendingFetchPromise: Promise<JavaCatalogCacheData> | null = null;

/**
 * Java kataloğunu API üzerinden çeker veya geçerli bellek önbelleğini döner.
 * force=true verildiğinde önbelleği atlayıp taze veri çeker.
 */
export async function prefetchJavaCatalog(force = false): Promise<JavaCatalogCacheData> {
  const now = Date.now();
  // 60 saniye boyunca taze kabul et (force değilse)
  if (!force && memoryCache && now - memoryCache.timestamp < 60000) {
    return memoryCache;
  }

  if (pendingFetchPromise) {
    return pendingFetchPromise;
  }

  pendingFetchPromise = (async () => {
    try {
      let catalogRes = await fetch('/api/servers/system/java/catalog', { credentials: 'include' });
      if (!catalogRes.ok) {
        catalogRes = await fetch('/api/servers/system/java', { credentials: 'include' });
      }

      if (!catalogRes.ok) {
        throw new Error('Java listesi alınamadı.');
      }

      const data = await catalogRes.json();
      const installedList: JavaInstalledItem[] = Array.isArray(data)
        ? data
        : Array.isArray(data.installed)
        ? data.installed
        : [];
      const catalogList: JavaCatalogItem[] = Array.isArray(data.catalog) ? data.catalog : [];

      const result: JavaCatalogCacheData = {
        installed: installedList,
        catalog: catalogList,
        networkError: data.networkError || null,
        timestamp: Date.now(),
      };
      memoryCache = result;
      return result;
    } catch (err: any) {
      console.warn('Java catalog fetch error:', err);
      // Yerel fallback taraması
      let fallbackInstalled: JavaInstalledItem[] = memoryCache?.installed || [];
      try {
        const res = await fetch('/api/servers/system/java');
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list) && list.length > 0) {
            fallbackInstalled = list;
          }
        }
      } catch {}

      const result: JavaCatalogCacheData = {
        installed: fallbackInstalled,
        catalog: memoryCache?.catalog || [],
        networkError: 'Java kataloğuna ulaşılamadı. Yerel Java kurulumları taranıyor...',
        timestamp: Date.now(),
      };
      memoryCache = result;
      return result;
    } finally {
      pendingFetchPromise = null;
    }
  })();

  return pendingFetchPromise;
}

/**
 * useJavaCatalog Hook
 * - enabled=true olduğunda derhal veri çeker/önbellekten okur
 * - Önbellek varsa bekleme süresini 0ms'ye indirir
 * - Arka planda yenileme desteği sunar
 */
export function useJavaCatalog(enabled: boolean = true) {
  const [installedJavas, setInstalledJavas] = useState<JavaInstalledItem[]>(
    () => memoryCache?.installed || []
  );
  const [catalogJavas, setCatalogJavas] = useState<JavaCatalogItem[]>(
    () => memoryCache?.catalog || []
  );
  const [isLoadingJava, setIsLoadingJava] = useState<boolean>(() => !memoryCache);
  const [javaError, setJavaError] = useState<string | null>(
    () => memoryCache?.networkError || null
  );

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshJavaCatalog = useCallback(async (force = false) => {
    if (!memoryCache) {
      setIsLoadingJava(true);
    }
    try {
      const data = await prefetchJavaCatalog(force);
      if (isMountedRef.current) {
        setInstalledJavas(data.installed);
        setCatalogJavas(data.catalog);
        setJavaError(data.networkError);
      }
      return data;
    } catch (e: any) {
      if (isMountedRef.current) {
        setJavaError(e.message || 'Java listesi alınamadı.');
      }
      return null;
    } finally {
      if (isMountedRef.current) {
        setIsLoadingJava(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    if (memoryCache) {
      setInstalledJavas(memoryCache.installed);
      setCatalogJavas(memoryCache.catalog);
      setJavaError(memoryCache.networkError);
      setIsLoadingJava(false);
      // Stale cache yenileme (60 saniyeden eskiyse arka planda sessizce yenile)
      if (Date.now() - memoryCache.timestamp > 60000) {
        prefetchJavaCatalog(true)
          .then((data) => {
            if (isMountedRef.current) {
              setInstalledJavas(data.installed);
              setCatalogJavas(data.catalog);
              setJavaError(data.networkError);
            }
          })
          .catch((err) => {
            if (isMountedRef.current) {
              setJavaError(err?.message || 'Java kataloğu güncellenemedi.');
            }
          });
      }
    } else {
      refreshJavaCatalog(false);
    }
  }, [enabled, refreshJavaCatalog]);

  return {
    installedJavas,
    catalogJavas,
    isLoadingJava,
    javaError,
    refreshJavaCatalog,
  };
}
