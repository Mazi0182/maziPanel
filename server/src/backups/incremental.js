const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function hasZipCommand() {
  try {
    const res = spawnSync('which', ['zip'], { stdio: 'pipe' });
    return res.status === 0;
  } catch {
    return false;
  }
}

const MAX_EXCLUSION_PATTERNS = 50;
const MAX_EXCLUSION_LENGTH = 128;
const MAX_WILDCARDS_PER_PATTERN = 6;

function sanitizeExclusions(exclusions, defaultExclusions = ['logs', 'crash-reports']) {
  if (exclusions === undefined || exclusions === null) {
    return [...defaultExclusions];
  }
  if (!Array.isArray(exclusions)) {
    throw new Error('Hariç tutulanlar (exclusions) bir dizi olmalıdır.');
  }
  if (exclusions.length > MAX_EXCLUSION_PATTERNS) {
    throw new Error(`En fazla ${MAX_EXCLUSION_PATTERNS} adet hariç tutma kuralı tanımlanabilir.`);
  }

  const sanitized = [];
  const seen = new Set();

  for (const raw of exclusions) {
    if (typeof raw !== 'string') {
      throw new Error('Her bir hariç tutma kuralı metin (string) formatında olmalıdır.');
    }
    let p = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!p) continue;

    if (/[\r\n\x00-\x1f\x7f]/.test(p)) {
      throw new Error('Hariç tutma kuralı geçersiz kontrol karakterleri içeremez.');
    }
    if (p.length > MAX_EXCLUSION_LENGTH) {
      throw new Error(`Hariç tutma kuralı en fazla ${MAX_EXCLUSION_LENGTH} karakter olabilir.`);
    }
    if (p.startsWith('-')) {
      throw new Error('Hariç tutma kuralı tire (-) karakteri ile başlayamaz.');
    }
    if (p.split('/').includes('..')) {
      throw new Error('Hariç tutma kuralı üst dizin (..) ifadesi içeremez.');
    }

    // Collapse consecutive * wildcards to prevent catastrophic backtracking (ReDoS)
    p = p.replace(/\*+/g, '*');

    const wildcardCount = (p.match(/[*?]/g) || []).length;
    if (wildcardCount > MAX_WILDCARDS_PER_PATTERN) {
      throw new Error(`Hariç tutma kuralı en fazla ${MAX_WILDCARDS_PER_PATTERN} adet joker karakter (* veya ?) içerebilir.`);
    }

    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      sanitized.push(p);
    }
  }

  return sanitized;
}

function globToSafeRegExp(pattern) {
  const collapsed = String(pattern).replace(/\*+/g, '*');
  const escaped = collapsed
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchGlobLinear(text, pattern) {
  const s = String(text).toLowerCase();
  const p = String(pattern).toLowerCase().replace(/\*+/g, '*');
  let sIdx = 0;
  let pIdx = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (sIdx < s.length) {
    if (pIdx < p.length && (p[pIdx] === '?' || p[pIdx] === s[sIdx])) {
      sIdx++;
      pIdx++;
    } else if (pIdx < p.length && p[pIdx] === '*') {
      starIdx = pIdx;
      matchIdx = sIdx;
      pIdx++;
    } else if (starIdx !== -1) {
      pIdx = starIdx + 1;
      matchIdx++;
      sIdx = matchIdx;
    } else {
      return false;
    }
  }

  while (pIdx < p.length && p[pIdx] === '*') {
    pIdx++;
  }

  return pIdx === p.length;
}

function matchesExclusion(relPath, exclusions) {
  if (!exclusions || !Array.isArray(exclusions) || exclusions.length === 0) {
    return false;
  }
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.length > 2048) return false;
  const segments = normalized.split('/');
  const fileName = segments[segments.length - 1];

  const limit = Math.min(exclusions.length, MAX_EXCLUSION_PATTERNS);
  for (let i = 0; i < limit; i++) {
    const pattern = exclusions[i];
    if (typeof pattern !== 'string') continue;
    const p = pattern.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\*+/g, '*');
    if (!p || p.length > MAX_EXCLUSION_LENGTH) continue;

    // Direct folder or exact match
    if (normalized === p || normalized.startsWith(p + '/') || segments.includes(p)) {
      return true;
    }

    // ReDoS-safe Glob wildcard match (e.g. *.jar, cache/*)
    if (p.includes('*') || p.includes('?')) {
      if (!p.includes('/')) {
        const safeRegex = globToSafeRegExp(p);
        if (safeRegex.test(fileName)) {
          return true;
        }
      }
      if (matchGlobLinear(fileName, p) || matchGlobLinear(normalized, p)) {
        return true;
      }
    }
  }
  return false;
}

class IncrementalBackupEngine {
  /**
   * Scans a server directory and gathers size and mtimeMs for all files
   */
  scanDirectory(dirPath, exclusions = []) {
    const safeExclusions = sanitizeExclusions(exclusions);
    const result = {};

    const traverse = (currentDir, relBase = '') => {
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (err) {
        console.warn(`[incremental] Dizin okunamadı (${currentDir}):`, err.message);
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

        if (matchesExclusion(relPath, safeExclusions)) {
          continue;
        }

        try {
          if (entry.isDirectory()) {
            traverse(fullPath, relPath);
          } else if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            result[relPath] = {
              size: stat.size,
              mtimeMs: Math.round(stat.mtimeMs)
            };
          }
        } catch (err) {
          // File might be locked or deleted during scan
          console.warn(`[incremental] Dosya bilgisi alınamadı (${fullPath}):`, err.message);
        }
      }
    };

    traverse(dirPath);
    return result;
  }

  /**
   * Load manifest for archive
   */
  loadManifest(archivePath) {
    const manifestPath = `${archivePath}.manifest.json`;
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    try {
      const data = fs.readFileSync(manifestPath, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.warn(`[incremental] Manifest ayrıştırılamadı (${manifestPath}):`, err.message);
      return null;
    }
  }

  /**
   * Save manifest for archive
   */
  saveManifest(archivePath, manifest) {
    const manifestPath = `${archivePath}.manifest.json`;
    try {
      const tmpFile = `${manifestPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmpFile, JSON.stringify(manifest, null, 2), 'utf8');
      fs.renameSync(tmpFile, manifestPath);
    } catch (err) {
      console.error(`[incremental] Manifest yazılamadı (${manifestPath}):`, err.message);
    }
  }

  /**
   * Compare current files with manifest to compute stats
   */
  computeChanges(currentMap, oldManifest) {
    const currentKeys = Object.keys(currentMap);
    const totalFiles = currentKeys.length;

    if (!oldManifest) {
      // First backup: all files are considered changed/new
      return {
        totalFiles,
        changedFiles: totalFiles,
        removedFiles: 0,
        unchangedFiles: 0
      };
    }

    let changedFiles = 0;
    let unchangedFiles = 0;

    for (const key of currentKeys) {
      const cur = currentMap[key];
      const old = oldManifest[key];

      if (!old) {
        // Newly added file
        changedFiles++;
      } else if (old.size !== cur.size || Math.abs(old.mtimeMs - cur.mtimeMs) > 1000) {
        // Modified file
        changedFiles++;
      } else {
        unchangedFiles++;
      }
    }

    let removedFiles = 0;
    for (const oldKey of Object.keys(oldManifest)) {
      if (!currentMap[oldKey]) {
        removedFiles++;
      }
    }

    return {
      totalFiles,
      changedFiles,
      removedFiles,
      unchangedFiles
    };
  }

  /**
   * Perform single-file sync backup using Info-ZIP filesync (zip -FS)
   */
  syncBackup(serverDir, targetArchiveFile, options = {}) {
    if (!hasZipCommand()) {
      throw new Error(
        "Sunucuda 'zip' komutu bulunamadı. Tek dosya / artımlı yedekleme için Info-ZIP aracına ihtiyaç vardır. Lütfen sunucuda 'sudo apt-get install -y zip unzip' komutunu çalıştırın."
      );
    }

    const startTime = Date.now();
    const exclusions = sanitizeExclusions(options.exclusions);
    const level = Math.max(0, Math.min(9, parseInt(options.level, 10) || 6));

    // 1. Scan current directory
    const currentMap = this.scanDirectory(serverDir, exclusions);
    const oldManifest = this.loadManifest(targetArchiveFile);
    const changes = this.computeChanges(currentMap, oldManifest);

    const exists = fs.existsSync(targetArchiveFile);
    const tmpArchiveFile = `${targetArchiveFile}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.zip`;

    try {
      // Prepare zip arguments
      const zipArgs = [];

      if (exists) {
        // Copy existing archive to temporary working file for atomic update
        fs.copyFileSync(targetArchiveFile, tmpArchiveFile);
        // filesync: zip -FS -r -<level> <tmpArchive> .
        zipArgs.push('-FS', '-r', `-${level}`, tmpArchiveFile, '.');
      } else {
        // First run: zip -r -<level> <tmpArchive> .
        zipArgs.push('-r', `-${level}`, tmpArchiveFile, '.');
      }

      // Add exclusions
      for (const exc of exclusions) {
        const cleanExc = String(exc).trim().replace(/\\/g, '/');
        if (cleanExc && !cleanExc.startsWith('-')) {
          zipArgs.push('-x', `${cleanExc}*`, `*/${cleanExc}*`);
        }
      }

      // Execute zip
      const proc = spawnSync('zip', zipArgs, {
        cwd: serverDir,
        stdio: 'pipe',
        encoding: 'utf8'
      });

      // Exit code 0 is success, exit code 12 is "nothing to do" in some zip versions
      if (proc.status !== 0 && proc.status !== 12 && !fs.existsSync(tmpArchiveFile)) {
        throw new Error(`Zip filesync başarısız oldu (kod ${proc.status}): ${proc.stderr || proc.stdout}`);
      }

      // Atomic rename
      fs.renameSync(tmpArchiveFile, targetArchiveFile);

      // Save new manifest
      this.saveManifest(targetArchiveFile, currentMap);

      const durationMs = Date.now() - startTime;
      const stats = {
        ...changes,
        durationMs
      };

      return {
        success: true,
        stats
      };
    } catch (err) {
      if (fs.existsSync(tmpArchiveFile)) {
        try {
          fs.unlinkSync(tmpArchiveFile);
        } catch {}
      }
      throw err;
    }
  }
}

const incrementalEngineInstance = new IncrementalBackupEngine();
incrementalEngineInstance.sanitizeExclusions = sanitizeExclusions;
incrementalEngineInstance.matchesExclusion = matchesExclusion;
incrementalEngineInstance.globToSafeRegExp = globToSafeRegExp;
incrementalEngineInstance.matchGlobLinear = matchGlobLinear;

module.exports = incrementalEngineInstance;
