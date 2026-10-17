const https = require('https');

/**
 * Java and Minecraft Core/Version Compatibility Helper
 *
 * Rules verified from Paper docs (https://docs.papermc.io/paper/getting-started/):
 * - Paper/Purpur:
 *   1.7.10 - 1.11: Java 8
 *   1.12 - 1.16.4: Java 11 (min 8)
 *   1.16.5: Java 16 (min 16)
 *   1.17 - 1.19: Java 17 (min 17)
 *   1.20 - 1.20.4: Java 21 (min 17)
 *   1.20.5 - 1.21.11: Java 21 (min 21)
 *   26.1+: Java 25 (min 25)
 *
 * - Vanilla:
 *   Mojang version metadata javaVersion.majorVersion when available:
 *   1.17: 16
 *   1.18 - 1.20.4: 17
 *   1.20.5+: 21
 *   26.x: 25
 *   Older (<= 1.16.5): 8
 */

// Cache for Mojang version manifest and package data
let cachedManifest = null;
let manifestTimestamp = 0;
const MANIFEST_TTL_MS = 15 * 60 * 1000;
const packageMetadataCache = new Map();

const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ALLOWED_MOJANG_HOSTS = new Set(['piston-meta.mojang.com', 'launchermeta.mojang.com']);

/**
 * Bounded, secure fetch for Mojang JSON metadata
 */
function fetchMojangJson(urlStr, timeoutMs = 5000, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error('Invalid Mojang URL'));
    }

    if (url.protocol !== 'https:' || !ALLOWED_MOJANG_HOSTS.has(url.hostname)) {
      return reject(new Error(`Untrusted Mojang host: ${url.hostname}`));
    }

    const req = https.get(
      urlStr,
      {
        headers: { 'User-Agent': 'maziPanel-JavaCompatibility/1.0' },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP error ${res.statusCode}`));
        }

        let body = '';
        let bytes = 0;

        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy();
            return reject(new Error('Response size limit exceeded'));
          }
          body += chunk;
        });

        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Fetch timed out (${timeoutMs}ms)`));
    });

    req.on('error', reject);
  });
}

/**
 * Fetches official javaVersion metadata from Mojang manifest and package JSON
 * @param {string} versionId E.g. '1.20.4', '26.4-snapshot-3', '24w14a'
 * @param {number} timeoutMs
 * @returns {Promise<{ component: string, majorVersion: number } | null>}
 */
async function fetchMojangJavaMetadata(versionId, timeoutMs = 5000) {
  if (!versionId || typeof versionId !== 'string') return null;
  const cleanId = versionId.trim();

  if (packageMetadataCache.has(cleanId)) {
    return packageMetadataCache.get(cleanId);
  }

  const now = Date.now();
  if (!cachedManifest || now - manifestTimestamp > MANIFEST_TTL_MS) {
    try {
      const manifest = await fetchMojangJson(MOJANG_MANIFEST_URL, timeoutMs, 4 * 1024 * 1024);
      if (manifest && Array.isArray(manifest.versions)) {
        cachedManifest = manifest;
        manifestTimestamp = now;
      }
    } catch (err) {
      // Manifest fetch failed or offline
    }
  }

  if (!cachedManifest || !Array.isArray(cachedManifest.versions)) {
    return null;
  }

  const versionEntry = cachedManifest.versions.find((v) => v.id === cleanId);
  if (!versionEntry || !versionEntry.url) {
    return null;
  }

  try {
    const pkg = await fetchMojangJson(versionEntry.url, timeoutMs, 1024 * 1024);
    if (pkg && pkg.javaVersion && typeof pkg.javaVersion.majorVersion === 'number') {
      const result = {
        component: pkg.javaVersion.component || 'jre-legacy',
        majorVersion: pkg.javaVersion.majorVersion
      };
      packageMetadataCache.set(cleanId, result);
      return result;
    }
  } catch (err) {
    // Package JSON fetch failed
  }

  return null;
}

/**
 * Strict semantic release version parser.
 * Requires full semantic release pattern like "1.20.4", "1.12", "26.1".
 * Rejects snapshots and prefix strings (e.g. "26w14a", "26.4-snapshot-3") returning null.
 */
function parseVersionNumbers(verStr) {
  if (!verStr || typeof verStr !== 'string') return null;
  const cleaned = verStr.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3] || '0', 10),
    raw: cleaned
  };
}

/**
 * Returns Java requirements for a given engine type and Minecraft version
 */
function getJavaRequirements(coreType, mcVersion, mojangMetadata = null) {
  const cleanCore = (coreType || 'paper').toLowerCase().trim();

  // If Vanilla has official Mojang version metadata with javaVersion.majorVersion, honor it directly
  if (cleanCore === 'vanilla' && mojangMetadata) {
    const rawMajor = mojangMetadata.majorVersion || mojangMetadata.javaVersion?.majorVersion;
    const reqMajor = parseInt(rawMajor, 10);
    if (!isNaN(reqMajor) && reqMajor >= 8) {
      let compatibleMajors = [reqMajor];
      if (reqMajor === 16) {
        compatibleMajors = [16, 17];
      }
      return {
        minJava: reqMajor,
        recommendedJava: reqMajor,
        compatibleMajors,
        captionTr: `Önerilen: Java ${reqMajor} (Gereken: Java ${reqMajor})`,
        isUnknown: false
      };
    }
  }

  const parsed = parseVersionNumbers(mcVersion);

  // If unknown version or snapshot without parseable numbers or Mojang metadata
  if (!parsed) {
    return {
      minJava: null,
      recommendedJava: null,
      compatibleMajors: [],
      captionTr: 'Bilinmeyen sürüm / snapshot · Seçim kullanıcıya bırakıldı',
      isUnknown: true
    };
  }

  const { major, minor, patch } = parsed;

  // 1. Vanilla engine
  if (cleanCore === 'vanilla') {
    if (major >= 26) {
      return {
        minJava: 25,
        recommendedJava: 25,
        compatibleMajors: [25, 27],
        captionTr: 'Önerilen: Java 25 (En Düşük: Java 25)',
        isUnknown: false
      };
    }

    if (major === 1) {
      if (minor > 20 || (minor === 20 && patch >= 5)) {
        return {
          minJava: 21,
          recommendedJava: 21,
          compatibleMajors: [21],
          captionTr: 'Önerilen: Java 21 (Gereken: Java 21)',
          isUnknown: false
        };
      }
      if ((minor === 20 && patch < 5) || minor === 19 || minor === 18) {
        return {
          minJava: 17,
          recommendedJava: 17,
          compatibleMajors: [17],
          captionTr: 'Önerilen: Java 17 (Gereken: Java 17)',
          isUnknown: false
        };
      }
      if (minor === 17) {
        return {
          minJava: 16,
          recommendedJava: 16,
          compatibleMajors: [16, 17],
          captionTr: 'Önerilen: Java 16 (Gereken: Java 16)',
          isUnknown: false
        };
      }
      // 1.16.5 and older Vanilla runs on Java 8
      return {
        minJava: 8,
        recommendedJava: 8,
        compatibleMajors: [8],
        captionTr: 'Önerilen: Java 8 (Gereken: Java 8)',
        isUnknown: false
      };
    }
  }

  // 2. Paper & Purpur (and standard forks)
  // 26.1+ -> Java 25 minimum (Java 25, 27 modern choices valid, recommend 25)
  if (major >= 26) {
    return {
      minJava: 25,
      recommendedJava: 25,
      compatibleMajors: [25, 27],
      captionTr: 'Önerilen: Java 25 (En Düşük: Java 25)',
      isUnknown: false
    };
  }

  if (major === 1) {
    // 1.20 - 1.21.11 -> Java 21
    if (minor >= 20) {
      const isEarly120 = minor === 20 && patch < 5;
      const minJ = isEarly120 ? 17 : 21;
      return {
        minJava: minJ,
        recommendedJava: 21,
        compatibleMajors: isEarly120 ? [21, 17] : [21],
        captionTr: isEarly120
          ? 'Önerilen: Java 21 (En Düşük: Java 17)'
          : 'Önerilen: Java 21 (Gereken: Java 21)',
        isUnknown: false
      };
    }

    // 1.17 - 1.19 -> Java 17
    if (minor >= 17 && minor <= 19) {
      return {
        minJava: 17,
        recommendedJava: 17,
        compatibleMajors: [17],
        captionTr: 'Önerilen: Java 17 (Gereken: Java 17)',
        isUnknown: false
      };
    }

    // 1.16.5 -> Java 16
    if (minor === 16 && patch >= 5) {
      return {
        minJava: 16,
        recommendedJava: 16,
        compatibleMajors: [16, 17],
        captionTr: 'Önerilen: Java 16 (Gereken: Java 16)',
        isUnknown: false
      };
    }

    // 1.12 - 1.16.4 -> Java 11
    if (minor >= 12 && minor <= 16) {
      return {
        minJava: 11,
        recommendedJava: 11,
        compatibleMajors: [11],
        captionTr: 'Önerilen: Java 11 (Gereken: Java 11)',
        isUnknown: false
      };
    }

    // 1.7.10 - 1.11 -> Java 8
    if (minor <= 11) {
      return {
        minJava: 8,
        recommendedJava: 8,
        compatibleMajors: [8],
        captionTr: 'Önerilen: Java 8 (Gereken: Java 8)',
        isUnknown: false
      };
    }
  }

  // Fallback for unexpected version patterns: do not guess incompatible
  return {
    minJava: null,
    recommendedJava: null,
    compatibleMajors: [],
    captionTr: 'Bilinmeyen sürüm · Seçim kullanıcıya bırakıldı',
    isUnknown: true
  };
}

/**
 * Checks if a specific Java major version is compatible with core + version.
 * @param {number} javaMajor
 * @param {string} coreType
 * @param {string} mcVersion
 * @param {any} mojangMetadata
 * @param {boolean} isExplicitCustomPath If true, preserves custom path if not truly too low (>= minJava)
 */
function isJavaCompatible(javaMajor, coreType, mcVersion, mojangMetadata = null, isExplicitCustomPath = false) {
  if (!javaMajor) return true; // auto/unknown
  const req = getJavaRequirements(coreType, mcVersion, mojangMetadata);
  if (req.isUnknown || !req.minJava) return true; // Never silently reject unknown versions
  if (isExplicitCustomPath) {
    return javaMajor >= req.minJava;
  }
  // Modern 26 requires 25 minimum: modern installed/Oracle (25+) remain valid choices
  if (req.minJava >= 25) {
    return javaMajor >= 25;
  }
  return req.compatibleMajors.includes(javaMajor);
}

module.exports = {
  fetchMojangJavaMetadata,
  getJavaRequirements,
  isJavaCompatible,
  parseVersionNumbers
};
