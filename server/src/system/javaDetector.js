const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../config');
const javaCompatibility = require('./javaCompatibility');

let cachedInstallations = null;
let lastScanTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

/**
 * Checks if a path is located inside panel-managed data directories
 */
function isPanelManagedPath(targetPath) {
  if (!targetPath) return false;
  const panelJavaDir = path.resolve(path.join(config.DATA_DIR, 'java'));
  const resolved = path.resolve(targetPath);
  if (resolved.startsWith(panelJavaDir)) return true;
  if (fs.existsSync('/mazideveloper/data/java')) {
    const remotePanelDir = path.resolve('/mazideveloper/data/java');
    if (resolved.startsWith(remotePanelDir)) return true;
  }
  return false;
}

/**
 * Validates that a candidate filesystem path is a legitimate Java binary path
 * and is never located inside untrusted server, backup, or temp directories.
 */
function isSafeJavaExecutablePath(javaPath) {
  if (!javaPath || typeof javaPath !== 'string') return false;
  const trimmed = javaPath.trim();
  if (!trimmed || /[\r\n\x00-\x1f\x7f]/.test(trimmed)) return false;

  const base = path.basename(trimmed).toLowerCase();
  if (base !== 'java' && base !== 'java.exe') return false;

  const normalized = path.normalize(trimmed);
  if (normalized.split(/[\\/]+/).includes('..')) return false;

  const resolved = path.resolve(trimmed);
  const forbiddenRoots = [
    config.SERVERS_DIR ? path.resolve(config.SERVERS_DIR) : null,
    config.BACKUPS_DIR ? path.resolve(config.BACKUPS_DIR) : null,
    config.TEMP_DIR ? path.resolve(config.TEMP_DIR) : null
  ].filter(Boolean);

  for (const root of forbiddenRoots) {
    const rel = path.relative(root, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return false;
    }
    if (fs.existsSync(resolved) && fs.existsSync(root)) {
      try {
        const realTarget = fs.realpathSync(resolved);
        const realRoot = fs.realpathSync(root);
        const realRel = path.relative(realRoot, realTarget);
        if (realRel === '' || (!realRel.startsWith('..') && !path.isAbsolute(realRel))) {
          return false;
        }
      } catch (e) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Inspects a Java executable and extracts version and vendor details
 */
function inspectJavaExecutable(javaPath) {
  try {
    if (!isSafeJavaExecutablePath(javaPath)) return null;
    if (!fs.existsSync(javaPath)) return null;
    const stats = fs.statSync(javaPath);
    if (!stats.isFile()) return null;

    // Run -version using spawnSync with array arguments (shell: false)
    const res = spawnSync(javaPath, ['-version'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });
    const output = ((res.stdout || '') + '\n' + (res.stderr || '')).trim();

    // Parse output lines
    // Example 1: java version "27" 2026-09-15 \n Java(TM) SE Runtime Environment (build 27+35-2325)
    // Example 2: openjdk version "21.0.12.1" 2026-08-18 \n OpenJDK Runtime Environment (build 21.0.12.1+1-1-deb13u1-Debian)
    // Example 3: java version "25.0.4.1" 2026-04-14
    const versionMatch = output.match(/(?:java|openjdk)\s+version\s+"([^"]+)"/i) ||
                         output.match(/(?:java|openjdk)\s+([0-9._]+)/i);
    const rawVersion = versionMatch ? versionMatch[1] : 'unknown';

    let majorVersion = null;
    if (rawVersion !== 'unknown') {
      const parts = rawVersion.split('.');
      if (parts[0] === '1' && parts[1]) {
        majorVersion = parseInt(parts[1], 10);
      } else {
        majorVersion = parseInt(parts[0], 10);
      }
    }

    let vendor = 'Unknown';
    if (/oracle|Java\(TM\)/i.test(output)) {
      vendor = 'Oracle';
    } else if (/openjdk/i.test(output)) {
      vendor = 'OpenJDK';
    } else if (/eclipse\s+temurin|adoptium/i.test(output)) {
      vendor = 'Eclipse Temurin';
    } else if (/zulu/i.test(output)) {
      vendor = 'Azul Zulu';
    }

    const panelManaged = isPanelManagedPath(javaPath);
    const tag = panelManaged ? ' [maziPanel]' : '';

    return {
      path: javaPath,
      rawVersion,
      majorVersion,
      vendor,
      panelManaged,
      label: `Java ${majorVersion || rawVersion} · Kurulu`,
      description: `${vendor} Java ${majorVersion || rawVersion}${tag} (${javaPath})`,
      available: true
    };
  } catch (err) {
    return null;
  }
}

/**
 * Scans host and panel-managed directories for available Java installations
 */
function detectJavaInstallations(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedInstallations && (now - lastScanTime < CACHE_TTL_MS)) {
    return cachedInstallations;
  }

  const detectedMap = new Map();

  const addCandidate = (candidatePath) => {
    if (!candidatePath || !fs.existsSync(candidatePath)) return;
    try {
      const canonical = fs.realpathSync(candidatePath);
      if (!detectedMap.has(canonical)) {
        const info = inspectJavaExecutable(candidatePath);
        if (info) {
          detectedMap.set(canonical, info);
        }
      }
    } catch (e) {
      // Ignore filesystem inspection errors
    }
  };

  // 1. Scan panel-managed data directories (e.g. /mazideveloper/data/java or config.DATA_DIR/java)
  const panelJavaDirs = [
    path.join(config.DATA_DIR, 'java'),
    '/mazideveloper/data/java'
  ];

  for (const javaBaseDir of panelJavaDirs) {
    if (fs.existsSync(javaBaseDir)) {
      try {
        const entries = fs.readdirSync(javaBaseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            // Check direct candidate: javaBaseDir/entry/bin/java (or java.exe)
            const binJava = path.join(javaBaseDir, entry.name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
            addCandidate(binJava);

            // Also check one-level nested in case archive contained an inner directory
            try {
              const nestedEntries = fs.readdirSync(path.join(javaBaseDir, entry.name), { withFileTypes: true });
              for (const nested of nestedEntries) {
                if (nested.isDirectory()) {
                  const nestedBin = path.join(javaBaseDir, entry.name, nested.name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
                  addCandidate(nestedBin);
                }
              }
            } catch (err) {}
          }
        }
      } catch (err) {
        // Ignore directory read error
      }
    }
  }

  // 2. Check known specific paths from config
  if (Array.isArray(config.KNOWN_JAVA_PATHS)) {
    for (const p of config.KNOWN_JAVA_PATHS) {
      addCandidate(p);
    }
  }

  // 3. Scan /usr/lib/jvm for subdirectories
  const jvmDir = '/usr/lib/jvm';
  if (fs.existsSync(jvmDir)) {
    try {
      const entries = fs.readdirSync(jvmDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const candidate = path.join(jvmDir, entry.name, 'bin', 'java');
          addCandidate(candidate);
        }
      }
    } catch (e) {
      // Ignore directory read errors
    }
  }

  // 4. Check system PATH using spawnSync (safe, no shell)
  try {
    const isWindows = process.platform === 'win32';
    const checkTool = isWindows ? 'where.exe' : 'which';
    const res = spawnSync(checkTool, ['java'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
      shell: false
    });

    if (res.status === 0 && res.stdout) {
      const whichJava = res.stdout.split(/\r?\n/)[0].trim();
      if (whichJava) {
        addCandidate(whichJava);
      }
    }
  } catch (e) {
    // which not found or java not in PATH
  }

  const results = Array.from(detectedMap.values());
  // Sort descending by majorVersion
  results.sort((a, b) => (b.majorVersion || 0) - (a.majorVersion || 0));

  cachedInstallations = results;
  lastScanTime = now;
  return results;
}

/**
 * Gets best Java executable based on server preference and core/version requirements
 * @param {string|null} requestedJava - Explicit path, version string, 'auto', or null
 * @param {object|null} serverContext - Optional context: { coreType, version, minJava, recommendedJava, compatibleMajors, isUnknown }
 */
function getJavaForServer(requestedJava, serverContext = null) {
  const list = (module.exports && typeof module.exports.detectJavaInstallations === 'function')
    ? module.exports.detectJavaInstallations()
    : detectJavaInstallations();

  // If serverContext provided, resolve requirements
  let req = null;
  if (serverContext) {
    if (serverContext.minJava !== undefined || serverContext.recommendedJava !== undefined) {
      req = serverContext;
    } else if (serverContext.coreType || serverContext.version) {
      req = javaCompatibility.getJavaRequirements(serverContext.coreType, serverContext.version);
    }
  }

  // 1. Explicit path or version requested (and not 'auto')
  if (requestedJava && requestedJava !== 'auto') {
    // If exact path matches an installed Java
    const exact = list.find((j) => j.path === requestedJava);
    if (exact) {
      if (req && req.minJava && exact.majorVersion && exact.majorVersion < req.minJava) {
        throw new Error(`Seçilen Java sürümü (Java ${exact.majorVersion}) bu sunucu için yetersizdir. En az Java ${req.minJava} gereklidir.`);
      }
      return exact.path;
    }

    // If requested is major version number or alias (e.g. 17, 21, 'java-21')
    const reqNum = parseInt(String(requestedJava).replace(/^java-/i, ''), 10);
    if (!isNaN(reqNum)) {
      const match = list.find((j) => j.majorVersion === reqNum);
      if (match) {
        if (req && req.minJava && match.majorVersion && match.majorVersion < req.minJava) {
          throw new Error(`Seçilen Java sürümü (Java ${match.majorVersion}) bu sunucu için yetersizdir. En az Java ${req.minJava} gereklidir.`);
        }
        return match.path;
      }
    }

    // If requested path exists directly on disk (custom executable)
    if (isSafeJavaExecutablePath(requestedJava) && fs.existsSync(requestedJava)) {
      const info = inspectJavaExecutable(requestedJava);
      if (info && info.majorVersion && req && req.minJava && info.majorVersion < req.minJava) {
        throw new Error(`Seçilen Java yolu (Java ${info.majorVersion}) bu sunucu için yetersizdir. En az Java ${req.minJava} gereklidir.`);
      }
      return requestedJava;
    }

    if (!isSafeJavaExecutablePath(requestedJava) && (String(requestedJava).includes('/') || String(requestedJava).includes('\\') || String(requestedJava).includes('..'))) {
      throw new Error('Geçersiz veya güvenli olmayan Java yürütülebilir dosya yolu.');
    }
  }

  // 2. Auto selection with requirements (when requestedJava is 'auto', null, undefined, or empty)
  if (req && req.minJava && !req.isUnknown) {
    // a. Choose installed recommended first
    if (req.recommendedJava) {
      const rec = list.find((j) => j.majorVersion === req.recommendedJava);
      if (rec) return rec.path;
    }

    // b. Documented compatible alternatives next
    if (Array.isArray(req.compatibleMajors)) {
      for (const major of req.compatibleMajors) {
        const alt = list.find((j) => j.majorVersion === major);
        if (alt) return alt.path;
      }
    }

    // c. Modern >= 25 permits 27 (or higher modern versions)
    if (req.minJava >= 25) {
      const modern = list.find((j) => j.majorVersion && j.majorVersion >= 25);
      if (modern) return modern.path;
    }

    // d. No compatible Java installed -> throw clear Turkish error (no silent fallback to e.g. Java 27 for old cores!)
    const recStr = req.recommendedJava ? ` (önerilen: Java ${req.recommendedJava})` : '';
    const coreStr = (serverContext && serverContext.coreType) ? serverContext.coreType : 'Minecraft';
    const verStr = (serverContext && serverContext.version) ? ` ${serverContext.version}` : '';
    throw new Error(`Bu sunucu (${coreStr}${verStr}) için uyumlu Java bulunamadı. Sunucuyu başlatmak için en az Java ${req.minJava}${recStr} kurulumu gereklidir.`);
  }

  // 3. Fallback / Unknown snapshot / No context provided (100% backward compatible)
  if (list.length === 0) {
    return 'java'; // Fallback to PATH
  }

  // If unknown/snapshot or no context, prefer modern >= 21, otherwise highest detected
  const modern = list.find((j) => j.majorVersion && j.majorVersion >= 21);
  if (modern) return modern.path;

  return list[0].path;
}

/**
 * Sanitizes Java installations list for non-admin users.
 * Hides host filesystem paths while preserving IDs, version numbers, and labels needed by the wizard.
 */
function sanitizeJavaList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const major = item.majorVersion || 0;
    const versionLabel = major > 0 ? String(major) : (item.rawVersion || 'unknown');
    const safeId = `java-${versionLabel}`;
    return {
      id: safeId,
      path: safeId,
      rawVersion: item.rawVersion,
      majorVersion: item.majorVersion,
      vendor: item.vendor,
      panelManaged: Boolean(item.panelManaged),
      label: item.label,
      description: `${item.vendor || 'Java'} Java ${major || item.rawVersion || ''}${item.panelManaged ? ' [maziPanel]' : ''}`.trim(),
      available: item.available !== false
    };
  });
}

module.exports = {
  detectJavaInstallations,
  getJavaForServer,
  inspectJavaExecutable,
  isPanelManagedPath,
  isSafeJavaExecutablePath,
  sanitizeJavaList
};
