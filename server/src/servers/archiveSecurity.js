const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const DEFAULT_MAX_EXTRACT_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB
const DEFAULT_MAX_ENTRIES = 200000;
const MAX_COMPRESSION_RATIO = 1000;

/**
 * Returns available disk space in bytes for targetDir using fs.statfsSync if supported
 */
function getDiskAvailableBytes(targetDir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(targetDir);
      return Math.floor(Number(stats.bavail) * Number(stats.bsize));
    }
  } catch (e) {}
  return null;
}

/**
 * Determines effective maximum extract bytes: min(MAX_EXTRACT_BYTES, 90% disk space)
 */
function getMaxAllowedBytes(targetDir) {
  const envLimit = process.env.MAX_EXTRACT_BYTES
    ? parseInt(process.env.MAX_EXTRACT_BYTES, 10)
    : DEFAULT_MAX_EXTRACT_BYTES;

  const diskAvail = getDiskAvailableBytes(targetDir);
  if (diskAvail !== null && diskAvail > 0) {
    const diskLimit = Math.floor(diskAvail * 0.9);
    return Math.min(envLimit, diskLimit);
  }
  return envLimit;
}

/**
 * Determines effective maximum entry count
 */
function getMaxAllowedEntries() {
  return process.env.MAX_ENTRIES
    ? parseInt(process.env.MAX_ENTRIES, 10)
    : DEFAULT_MAX_ENTRIES;
}

/**
 * Inspects a tar archive using `tar -tvf` (with spawnSync, shell: false)
 * Validates against Tar-Slip (absolute paths, '..' segments, symlinks, hardlinks, special files)
 * and calculates total uncompressed size and entry count for Zip bomb detection.
 */
function inspectTarArchive(tarFilePath, options = {}) {
  const isGzip = options.isGzip !== undefined
    ? options.isGzip
    : (tarFilePath.endsWith('.tar.gz') || tarFilePath.endsWith('.tgz') || tarFilePath.endsWith('.gz'));

  const tarArgs = isGzip ? ['-ztvf', tarFilePath] : ['-tvf', tarFilePath];

  const res = spawnSync('tar', tarArgs, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    shell: false
  });

  if (res.status !== 0) {
    throw new Error(`Arşiv listelenemedi: ${res.stderr || res.stdout || 'çıkış kodu ' + res.status}`);
  }

  const lines = res.stdout.split(/\r?\n/).filter(Boolean);
  let totalUncompressed = 0;
  const entries = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const firstChar = trimmed[0];
    // Reject symlinks (l), hardlinks (h), character devices (c), block devices (b), fifos (p), sockets (s)
    if (['l', 'h', 'c', 'b', 'p', 's'].includes(firstChar)) {
      const typeDesc = firstChar === 'l' ? 'sembolik bağ (symlink)' :
                       firstChar === 'h' ? 'sert bağ (hardlink)' : 'özel cihaz dosyası';
      throw new Error(`Güvenlik ihlali: Arşiv ${typeDesc} içeriyor ve reddedildi: ${trimmed}`);
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;

    const size = parseInt(parts[2], 10) || 0;
    // Path appears after date and time (index 5 onwards)
    const rawEntryPath = parts.slice(5).join(' ');
    // Handle GNU tar "path -> link" or "path link to link"
    const entryPath = rawEntryPath.split(' -> ')[0].split(' link to ')[0].trim();

    // 1. Tar-Slip: Absolute path rejection
    if (path.isAbsolute(entryPath) || entryPath.startsWith('/') || entryPath.startsWith('\\')) {
      throw new Error(`Güvenlik ihlali (Tar-Slip): Mutlak yol içeren arşiv girdisi reddedildi: ${entryPath}`);
    }

    // 2. Tar-Slip: Path traversal ('..') rejection
    const segments = entryPath.split(/[\\/]/);
    if (segments.includes('..')) {
      throw new Error(`Güvenlik ihlali (Tar-Slip): Üst dizin ("..") segmenti içeren arşiv girdisi reddedildi: ${entryPath}`);
    }

    totalUncompressed += size;
    entries.push({
      path: entryPath,
      size,
      isDirectory: firstChar === 'd'
    });
  }

  return {
    entries,
    entryCount: entries.length,
    totalUncompressed
  };
}

/**
 * Validates and extracts a ZIP archive safely with Zip-Slip, Zip Bomb, and size accounting protections.
 */
function validateAndExtractZip(zipFilePath, targetDir, options = {}) {
  const maxBytes = options.maxBytes || getMaxAllowedBytes(targetDir);
  const maxEntries = options.maxEntries || getMaxAllowedEntries();
  const resolvedTarget = path.resolve(targetDir);

  const zip = new AdmZip(zipFilePath);
  const entries = zip.getEntries();

  if (entries.length > maxEntries) {
    throw new Error(`Güvenlik ihlali (Zip Bomb): Arşivdeki girdi sayısı (${entries.length}) izin verilen üst sınırı (${maxEntries}) aşıyor.`);
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    const entryName = entry.entryName;
    const destPath = path.resolve(resolvedTarget, entryName);

    // Zip Slip check
    if (destPath !== resolvedTarget && !destPath.startsWith(resolvedTarget + path.sep)) {
      throw new Error(`Güvenlik ihlali (Zip Slip): Zararlı arşiv girdisi tespit edildi: ${entryName}`);
    }

    // Symlink check via external attributes (Unix mode 0120000 = S_IFLNK)
    const unixMode = (entry.attr >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new Error(`Güvenlik ihlali: Arşiv sembolik bağ (symlink) içeriyor: ${entryName}`);
    }

    const uncompressed = entry.header.size;
    const compressed = entry.header.compressedSize;

    // Zip bomb single file ratio check (> 1000:1)
    if (compressed > 0 && uncompressed > 1024 * 1024 && (uncompressed / compressed) > MAX_COMPRESSION_RATIO) {
      throw new Error(`Güvenlik ihlali (Zip Bomb): Aşırı sıkıştırma oranı tespit edildi (${Math.round(uncompressed / compressed)}x): ${entryName}`);
    }

    totalUncompressed += uncompressed;
    if (totalUncompressed > maxBytes) {
      throw new Error(`Güvenlik ihlali (Zip Bomb): Arşivin açılmış toplam boyutu izin verilen üst sınırı (${Math.round(maxBytes / (1024 * 1024))} MB) aşıyor.`);
    }
  }

  // Extract with live written byte counter and cleanup on failure
  const writtenFiles = [];
  let totalWrittenBytes = 0;
  try {
    for (const entry of entries) {
      const destPath = path.resolve(resolvedTarget, entry.entryName);
      if (entry.isDirectory) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        continue;
      }

      const parentDir = path.dirname(destPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const data = entry.getData();
      totalWrittenBytes += data.length;
      if (totalWrittenBytes > maxBytes) {
        throw new Error(`Güvenlik ihlali (Zip Bomb): Çıkarma sırasında izin verilen maksimum boyut (${Math.round(maxBytes / (1024 * 1024))} MB) aşıldı.`);
      }

      fs.writeFileSync(destPath, data);
      writtenFiles.push(destPath);
    }
  } catch (err) {
    for (const file of writtenFiles) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (e) {}
    }
    throw err;
  }

  return { totalWrittenBytes, entryCount: entries.length };
}

/**
 * Extracts a TAR or TAR.GZ archive safely:
 * 1. Inspects with `tar -tvf` for Tar-Slip, symlinks, devices, Zip Bomb
 * 2. Extracts to staging directory using `--no-same-owner --no-same-permissions`
 * 3. Verifies extracted content and atomically moves to target directory
 */
function extractTarSafely(tarFilePath, targetDir, options = {}) {
  const isGzip = options.isGzip !== undefined
    ? options.isGzip
    : (tarFilePath.endsWith('.tar.gz') || tarFilePath.endsWith('.tgz') || tarFilePath.endsWith('.gz'));

  const maxBytes = options.maxBytes || getMaxAllowedBytes(targetDir);
  const maxEntries = options.maxEntries || getMaxAllowedEntries();

  // 1. Inspect archive first
  const inspection = inspectTarArchive(tarFilePath, { isGzip });

  if (inspection.entryCount > maxEntries) {
    throw new Error(`Güvenlik ihlali (Zip Bomb): Arşivdeki girdi sayısı (${inspection.entryCount}) izin verilen üst sınırı (${maxEntries}) aşıyor.`);
  }

  if (inspection.totalUncompressed > maxBytes) {
    throw new Error(`Güvenlik ihlali (Zip Bomb): Arşivin açılmış toplam boyutu (${Math.round(inspection.totalUncompressed / (1024 * 1024))} MB) izin verilen üst sınırı (${Math.round(maxBytes / (1024 * 1024))} MB) aşıyor.`);
  }

  try {
    const archiveStat = fs.statSync(tarFilePath);
    if (archiveStat.size > 0 && inspection.totalUncompressed > 10 * 1024 * 1024) {
      const ratio = inspection.totalUncompressed / archiveStat.size;
      if (ratio > MAX_COMPRESSION_RATIO) {
        throw new Error(`Güvenlik ihlali (Zip Bomb): Aşırı sıkıştırma oranı tespit edildi (${Math.round(ratio)}x).`);
      }
    }
  } catch (e) {
    if (e.message.includes('Güvenlik ihlali')) throw e;
  }

  // 2. Extract into staging directory
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const stagingDir = path.join(targetDir, `.staging_tar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const extractArgs = ['--no-same-owner', '--no-same-permissions'];
    extractArgs.push(isGzip ? '-xzf' : '-xf', tarFilePath, '-C', stagingDir);

    const res = spawnSync('tar', extractArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      shell: false
    });

    if (res.status !== 0) {
      throw new Error(`Arşiv çıkarılamadı: ${res.stderr?.toString() || 'tar çıkış kodu ' + res.status}`);
    }

    // 3. Verify staging contents (ensure no symlinks created)
    const verifyStaging = (dir) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isSymbolicLink()) {
          throw new Error(`Güvenlik ihlali: Çıkarılan dosyalar arasında sembolik bağ tespit edildi: ${item.name}`);
        }
        if (item.isDirectory()) {
          verifyStaging(fullPath);
        }
      }
    };
    verifyStaging(stagingDir);

    // 4. Move staging contents to target directory
    const moveContents = (srcDir, dstDir) => {
      const items = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const item of items) {
        const srcPath = path.join(srcDir, item.name);
        const dstPath = path.join(dstDir, item.name);
        if (item.isDirectory()) {
          if (!fs.existsSync(dstPath)) fs.mkdirSync(dstPath, { recursive: true });
          moveContents(srcPath, dstPath);
        } else {
          if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
          fs.renameSync(srcPath, dstPath);
        }
      }
    };
    moveContents(stagingDir, targetDir);

    return {
      totalUncompressed: inspection.totalUncompressed,
      entryCount: inspection.entryCount
    };
  } finally {
    try {
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    } catch (e) {}
  }
}

module.exports = {
  DEFAULT_MAX_EXTRACT_BYTES,
  DEFAULT_MAX_ENTRIES,
  MAX_COMPRESSION_RATIO,
  getDiskAvailableBytes,
  getMaxAllowedBytes,
  getMaxAllowedEntries,
  inspectTarArchive,
  validateAndExtractZip,
  extractTarSafely
};
