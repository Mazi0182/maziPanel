/**
 * RAM formatlama yardımcısı
 * Örnekler:
 * '1G' -> '1GB'
 * '512M' -> '512MB'
 * '1 GB' -> '1GB'
 * 2048 (MB sayı) -> '2GB'
 * 512 (MB sayı) -> '512MB'
 */
export function formatRam(v: string | number | undefined | null): string {
  if (v === undefined || v === null || v === '') {
    return '0MB';
  }

  if (typeof v === 'number') {
    if (isNaN(v) || v <= 0) return '0MB';
    if (v >= 1024) {
      const gb = v / 1024;
      return Number.isInteger(gb) ? `${gb}GB` : `${parseFloat(gb.toFixed(2))}GB`;
    }
    return `${Math.round(v)}MB`;
  }

  const str = String(v).trim();
  if (!str) return '0MB';

  // Sadece sayı stringi ise (örn: "2048")
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const num = parseFloat(str);
    return formatRam(num);
  }

  // Örn: "1G", "1 GB", "1GB", "512M", "512 MB", "2GiB"
  const match = str.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
  if (match) {
    const val = match[1];
    const unit = match[2].toUpperCase();

    if (unit === 'G' || unit === 'GB' || unit === 'GIB') {
      return `${val}GB`;
    }
    if (unit === 'M' || unit === 'MB' || unit === 'MIB') {
      return `${val}MB`;
    }
    if (unit === 'K' || unit === 'KB' || unit === 'KIB') {
      return `${val}KB`;
    }
    if (unit === 'T' || unit === 'TB' || unit === 'TIB') {
      return `${val}TB`;
    }
    return `${val}${unit}`;
  }

  return str;
}
