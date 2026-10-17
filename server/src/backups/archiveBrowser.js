const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

// In-memory cache for archive indices: key -> { mtimeMs, size, entries, cachedAt }
const ARCHIVE_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_ENTRIES = 50;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.json', '.yml', '.yaml', '.properties', '.log', '.md',
  '.toml', '.xml', '.html', '.css', '.js', '.cfg', '.conf', '.ini',
  '.sh', '.bat', '.cmd', '.env', '.csv', '.tsv', '.mcmeta', '.lang', '.json5'
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.jar', '.zip',
  '.tar', '.gz', '.tgz', '.bz2', '.zst', '.mca', '.dat', '.nbt',
  '.class', '.exe', '.so', '.dll', '.bin', '.ogg', '.mp3', '.schem', '.schematic'
]);

function isBinaryBuffer(buf) {
  const checkLen = Math.min(buf.length, 8000);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function cleanArchivePath(p) {
  if (!p) return '';
  let normalized = String(p).replace(/\\/g, '/');
  // Strip leading/trailing slashes
  normalized = normalized.replace(/^\/+|\/+$/g, '');
  // Disallow path traversal components
  const parts = normalized.split('/').filter(Boolean);
  const safeParts = [];
  for (const part of parts) {
    if (part === '.' || part === '..') continue;
    safeParts.push(part);
  }
  return safeParts.join('/');
}

function hasCommand(cmd) {
  try {
    const res = spawnSync('which', [cmd], { stdio: 'pipe' });
    return res.status === 0;
  } catch {
    return false;
  }
}

class ArchiveBrowser {
  /**
   * Determine archive type based on extension
   */
  getArchiveType(filePath) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
    if (lower.endsWith('.tar')) return 'tar';
    if (lower.endsWith('.zip') || lower.endsWith('.jar')) return 'zip';
    return null;
  }

  /**
   * Parse flat entries list from archive
   */
  getArchiveEntries(archivePath) {
    if (!fs.existsSync(archivePath)) {
      throw new Error(`Arşiv dosyası bulunamadı: ${archivePath}`);
    }

    const stat = fs.statSync(archivePath);
    const cacheKey = `${archivePath}:${stat.mtimeMs}:${stat.size}`;
    const cached = ARCHIVE_CACHE.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      return cached.entries;
    }

    const type = this.getArchiveType(archivePath);
    if (!type) {
      throw new Error('Desteklenmeyen arşiv formatı (.zip, .jar, .tar, .tar.gz, .tgz desteklenir).');
    }

    let entries = [];
    if (type === 'zip') {
      entries = this._listZipEntries(archivePath);
    } else if (type === 'tar.gz') {
      entries = this._listTarEntries(archivePath, true);
    } else if (type === 'tar') {
      entries = this._listTarEntries(archivePath, false);
    }

    // Cache management
    if (ARCHIVE_CACHE.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = ARCHIVE_CACHE.keys().next().value;
      ARCHIVE_CACHE.delete(oldestKey);
    }
    ARCHIVE_CACHE.set(cacheKey, { entries, cachedAt: now });

    return entries;
  }

  _listZipEntries(archivePath) {
    // If unzip is available on system, use unzip -l (memory efficient for 160MB+)
    if (hasCommand('unzip')) {
      try {
        const proc = spawnSync('unzip', ['-l', archivePath], {
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024
        });
        if (proc.status === 0 && proc.stdout) {
          const lines = proc.stdout.split('\n');
          const entries = [];
          // Pattern: Length Date Time Name
          // Example: "  1234  2026-10-10 19:40   folder/file.ext"
          let headerPassed = false;
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('---') || trimmed.includes('----')) {
              headerPassed = !headerPassed;
              continue;
            }
            if (!headerPassed) continue;

            const match = line.match(/^\s*(\d+)\s+([\d-]+)\s+([\d:]+)\s+(.+)$/);
            if (match) {
              const sizeBytes = parseInt(match[1], 10);
              const dateStr = match[2];
              const timeStr = match[3];
              const rawName = match[4].trim();
              const isDir = rawName.endsWith('/') || sizeBytes === 0 && rawName.endsWith('/');
              const cleanPath = cleanArchivePath(rawName);
              if (!cleanPath) continue;

              entries.push({
                path: cleanPath,
                type: isDir ? 'directory' : 'file',
                sizeBytes: isDir ? 0 : sizeBytes,
                compressedBytes: null,
                modifiedAt: `${dateStr}T${timeStr}:00`
              });
            }
          }
          if (entries.length > 0) {
            return this._normalizeEntryList(entries);
          }
        }
      } catch (err) {
        console.warn('unzip -l failed, falling back to AdmZip:', err.message);
      }
    }

    // Fallback: AdmZip
    try {
      const zip = new AdmZip(archivePath);
      const zipEntries = zip.getEntries();
      const entries = [];
      for (const ze of zipEntries) {
        const cleanPath = cleanArchivePath(ze.entryName);
        if (!cleanPath) continue;
        entries.push({
          path: cleanPath,
          type: ze.isDirectory ? 'directory' : 'file',
          sizeBytes: ze.isDirectory ? 0 : ze.header.size,
          compressedBytes: ze.header.compressedSize || null,
          modifiedAt: ze.header.time ? new Date(ze.header.time).toISOString() : null
        });
      }
      return this._normalizeEntryList(entries);
    } catch (err) {
      throw new Error(`Zip arşivi okunamadı: ${err.message}`);
    }
  }

  _listTarEntries(archivePath, isGzip) {
    const flags = isGzip ? ['-tzvf', archivePath] : ['-tvf', archivePath];
    const proc = spawnSync('tar', flags, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });

    if (proc.status !== 0) {
      throw new Error(`Tar arşivi okunamadı: ${proc.stderr?.toString() || 'tar hata verdi'}`);
    }

    const lines = proc.stdout.split('\n');
    const entries = [];
    // Example: drwxr-xr-x user/group 0 2026-10-10 19:40 world/
    // -rw-r--r-- user/group 1234 2026-10-10 19:40 world/level.dat
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 6) {
        const perms = parts[0];
        const isDir = perms.startsWith('d');
        const sizeBytes = parseInt(parts[2], 10) || 0;
        const dateStr = parts[3];
        const timeStr = parts[4];
        // The filename is the rest of the line from index 5
        const rawName = parts.slice(5).join(' ');
        const cleanPath = cleanArchivePath(rawName);
        if (!cleanPath) continue;

        entries.push({
          path: cleanPath,
          type: isDir ? 'directory' : 'file',
          sizeBytes: isDir ? 0 : sizeBytes,
          compressedBytes: null,
          modifiedAt: dateStr && timeStr ? `${dateStr}T${timeStr}` : null
        });
      }
    }
    return this._normalizeEntryList(entries);
  }

  _normalizeEntryList(entries) {
    // Ensure all implied parent directories exist in the list
    const dirMap = new Map();
    const fileMap = new Map();

    for (const e of entries) {
      const entryName = e.name || path.basename(e.path);
      const enriched = {
        ...e,
        name: entryName,
        isHidden: (entryName || '').startsWith('.')
      };

      if (e.type === 'directory') {
        dirMap.set(e.path, enriched);
      } else {
        fileMap.set(e.path, enriched);
        // Ensure parent dirs
        const parts = e.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const parentDir = parts.slice(0, i).join('/');
          if (!dirMap.has(parentDir)) {
            const pName = path.basename(parentDir);
            dirMap.set(parentDir, {
              name: pName,
              path: parentDir,
              type: 'directory',
              sizeBytes: 0,
              compressedBytes: null,
              modifiedAt: e.modifiedAt,
              isHidden: (pName || '').startsWith('.')
            });
          }
        }
      }
    }

    const result = [];
    for (const d of dirMap.values()) result.push(d);
    for (const f of fileMap.values()) result.push(f);
    return result;
  }

  /**
   * Get direct children of a directory path in the archive
   */
  listDirectoryChildren(archivePath, requestedPath = '') {
    const allEntries = this.getArchiveEntries(archivePath);
    const cleanReq = cleanArchivePath(requestedPath);

    const childrenMap = new Map();

    for (const item of allEntries) {
      const itemPath = item.path;
      if (itemPath === cleanReq) continue; // Skip itself

      let isChild = false;
      let childName = '';

      if (!cleanReq) {
        // Root directory: immediate items have no '/'
        const slashIdx = itemPath.indexOf('/');
        if (slashIdx === -1) {
          isChild = true;
          childName = itemPath;
        } else {
          // It's in a subfolder, add the root folder
          const rootFolder = itemPath.slice(0, slashIdx);
          if (!childrenMap.has(rootFolder)) {
            childrenMap.set(rootFolder, {
              name: rootFolder,
              path: rootFolder,
              type: 'directory',
              sizeBytes: 0,
              compressedBytes: null,
              modifiedAt: item.modifiedAt,
              isHidden: (rootFolder || '').startsWith('.')
            });
          }
        }
      } else {
        // Subdirectory check
        const prefix = cleanReq + '/';
        if (itemPath.startsWith(prefix)) {
          const sub = itemPath.slice(prefix.length);
          const slashIdx = sub.indexOf('/');
          if (slashIdx === -1) {
            isChild = true;
            childName = sub;
          } else {
            const subDirName = sub.slice(0, slashIdx);
            const subDirPath = `${cleanReq}/${subDirName}`;
            if (!childrenMap.has(subDirPath)) {
              childrenMap.set(subDirPath, {
                name: subDirName,
                path: subDirPath,
                type: 'directory',
                sizeBytes: 0,
                compressedBytes: null,
                modifiedAt: item.modifiedAt,
                isHidden: (subDirName || '').startsWith('.')
              });
            }
          }
        }
      }

      if (isChild && childName) {
        const fullChildPath = cleanReq ? `${cleanReq}/${childName}` : childName;
        childrenMap.set(fullChildPath, {
          name: childName,
          path: fullChildPath,
          type: item.type,
          sizeBytes: item.sizeBytes,
          compressedBytes: item.compressedBytes,
          modifiedAt: item.modifiedAt,
          isHidden: (childName || '').startsWith('.')
        });
      }
    }

    const result = Array.from(childrenMap.values()).map((entry) => ({
      ...entry,
      isHidden: (entry.name || '').startsWith('.')
    }));

    // Sort: directories first, then alphabetical by name
    result.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });

    return {
      path: cleanReq,
      entries: result
    };
  }

  /**
   * Read single entry content or stream for download
   */
  async readEntry(archivePath, entryPath, options = {}) {
    const cleanEntry = cleanArchivePath(entryPath);
    if (!cleanEntry) {
      throw new Error('Geçersiz dosya yolu.');
    }

    const type = this.getArchiveType(archivePath);
    if (!type) {
      throw new Error('Desteklenmeyen arşiv formatı.');
    }

    const isDownload = options.download === true || options.download === '1' || options.download === 'true';
    const ext = path.extname(cleanEntry).toLowerCase();

    // Stream download mode
    if (isDownload) {
      return this._streamEntryDownload(archivePath, cleanEntry, type);
    }

    // View file mode
    // 1. Check if known binary extension
    if (BINARY_EXTENSIONS.has(ext)) {
      const stat = this._getEntryMetadata(archivePath, cleanEntry);
      return {
        path: cleanEntry,
        binary: true,
        sizeBytes: stat ? stat.sizeBytes : 0
      };
    }

    // Read file buffer (limit 1 MB + 1 byte to check truncation)
    const MAX_VIEW_BYTES = 1024 * 1024; // 1 MB
    const buf = await this._readEntryBuffer(archivePath, cleanEntry, type, MAX_VIEW_BYTES + 1);

    if (!buf || buf.length === 0) {
      return {
        path: cleanEntry,
        content: '',
        truncated: false,
        binary: false
      };
    }

    // Check if buffer is actually binary
    if (isBinaryBuffer(buf)) {
      return {
        path: cleanEntry,
        binary: true,
        sizeBytes: buf.length
      };
    }

    let truncated = false;
    let sliceBuf = buf;
    if (buf.length > MAX_VIEW_BYTES) {
      truncated = true;
      sliceBuf = buf.subarray(0, MAX_VIEW_BYTES);
    }

    return {
      path: cleanEntry,
      content: sliceBuf.toString('utf8'),
      truncated,
      binary: false
    };
  }

  _getEntryMetadata(archivePath, cleanEntry) {
    const entries = this.getArchiveEntries(archivePath);
    return entries.find((e) => e.path === cleanEntry) || null;
  }

  _readEntryBuffer(archivePath, cleanEntry, type, maxBytes = null) {
    return new Promise((resolve, reject) => {
      let proc;
      if (type === 'zip') {
        if (hasCommand('unzip')) {
          proc = spawn('unzip', ['-p', archivePath, cleanEntry]);
        } else {
          try {
            const zip = new AdmZip(archivePath);
            const entry = zip.getEntry(cleanEntry);
            if (!entry) return reject(new Error(`Dosya arşivde bulunamadı: ${cleanEntry}`));
            return resolve(entry.getData());
          } catch (err) {
            return reject(err);
          }
        }
      } else if (type === 'tar.gz') {
        proc = spawn('tar', ['-xzOf', archivePath, cleanEntry]);
      } else if (type === 'tar') {
        proc = spawn('tar', ['-xOf', archivePath, cleanEntry]);
      }

      if (!proc) {
        return reject(new Error('Arşiv okuma işlemi başlatılamadı.'));
      }

      const chunks = [];
      let totalBytes = 0;
      let isDone = false;

      proc.stdout.on('data', (chunk) => {
        if (isDone) return;
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (maxBytes && totalBytes >= maxBytes) {
          isDone = true;
          proc.kill();
          resolve(Buffer.concat(chunks));
        }
      });

      proc.stderr.on('data', () => {});

      proc.on('close', (code) => {
        if (isDone) return;
        isDone = true;
        if (chunks.length === 0 && code !== 0) {
          return reject(new Error(`Dosya arşivden okunamadı (kod ${code}): ${cleanEntry}`));
        }
        resolve(Buffer.concat(chunks));
      });

      proc.on('error', (err) => {
        if (!isDone) {
          isDone = true;
          reject(err);
        }
      });
    });
  }

  _streamEntryDownload(archivePath, cleanEntry, type) {
    let proc;
    if (type === 'zip') {
      if (hasCommand('unzip')) {
        proc = spawn('unzip', ['-p', archivePath, cleanEntry]);
      } else {
        const zip = new AdmZip(archivePath);
        const entry = zip.getEntry(cleanEntry);
        if (!entry) throw new Error(`Dosya arşivde bulunamadı: ${cleanEntry}`);
        const { Readable } = require('stream');
        return {
          stream: Readable.from(entry.getData()),
          filename: path.basename(cleanEntry)
        };
      }
    } else if (type === 'tar.gz') {
      proc = spawn('tar', ['-xzOf', archivePath, cleanEntry]);
    } else if (type === 'tar') {
      proc = spawn('tar', ['-xOf', archivePath, cleanEntry]);
    }

    if (!proc) {
      throw new Error('Arşiv dışa aktarma işlemi başlatılamadı.');
    }

    return {
      stream: proc.stdout,
      process: proc,
      filename: path.basename(cleanEntry)
    };
  }
}

module.exports = new ArchiveBrowser();
