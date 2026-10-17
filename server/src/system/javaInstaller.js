const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const config = require('../../config');
const javaDetector = require('./javaDetector');
const { inspectTarArchive } = require('../servers/archiveSecurity');

const ORACLE_DOWNLOADS_URL = 'https://www.oracle.com/tr/java/technologies/downloads/';
const ORACLE_FALLBACK_URL = 'https://www.oracle.com/java/technologies/downloads/';
const TRUSTED_DOWNLOAD_HOSTS = new Set([
  'download.oracle.com',
  'github.com',
  'objects.githubusercontent.com',
  'api.adoptium.net'
]);
const TRUSTED_REDIRECT_HOSTS = new Set([
  'download.oracle.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);
const TRUSTED_DOWNLOAD_HOST = 'download.oracle.com';
const TRUSTED_PAGE_HOSTS = new Set(['www.oracle.com', 'oracle.com']);

// Verified official Eclipse Temurin (Adoptium) releases for older LTS / GA versions
// Oracle requires account login for 8, 11, 16, 17; Temurin provides official OpenJDK binaries with SHA-256 integrity
const TEMURIN_RELEASES = {
  'linux-x64': [
    {
      majorVersion: 8,
      version: '8u504-b01',
      name: 'Eclipse Temurin JDK 8',
      vendor: 'Eclipse Temurin',
      architecture: 'linux-x64',
      filename: 'OpenJDK8U-jdk_x64_linux_hotspot_8u504b01.tar.gz',
      downloadUrl: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jdk_x64_linux_hotspot_8u504b01.tar.gz',
      sha256Url: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jdk_x64_linux_hotspot_8u504b01.tar.gz.sha256.txt',
      sha256: '9c70e102f527ac674ac2fe9c7d47b9a04e2d19842ba5ab8e9b33f368bbadfaea',
      isLts: true,
      isLatest: false
    },
    {
      majorVersion: 11,
      version: '11.0.32.1+1',
      name: 'Eclipse Temurin JDK 11',
      vendor: 'Eclipse Temurin',
      architecture: 'linux-x64',
      filename: 'OpenJDK11U-jdk_x64_linux_hotspot_11.0.32.1_1.tar.gz',
      downloadUrl: 'https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.32.1%2B1/OpenJDK11U-jdk_x64_linux_hotspot_11.0.32.1_1.tar.gz',
      sha256Url: 'https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.32.1%2B1/OpenJDK11U-jdk_x64_linux_hotspot_11.0.32.1_1.tar.gz.sha256.txt',
      sha256: '5c3f68887c325d36d852ba534303e1f5f1f5cae7d6cc1e951d73e0d8e98a058d',
      isLts: true,
      isLatest: false
    },
    {
      majorVersion: 16,
      version: '16.0.2+7',
      name: 'Eclipse Temurin JDK 16',
      vendor: 'Eclipse Temurin',
      architecture: 'linux-x64',
      filename: 'OpenJDK16U-jdk_x64_linux_hotspot_16.0.2_7.tar.gz',
      downloadUrl: 'https://github.com/adoptium/temurin16-binaries/releases/download/jdk-16.0.2%2B7/OpenJDK16U-jdk_x64_linux_hotspot_16.0.2_7.tar.gz',
      sha256Url: 'https://github.com/adoptium/temurin16-binaries/releases/download/jdk-16.0.2%2B7/OpenJDK16U-jdk_x64_linux_hotspot_16.0.2_7.tar.gz.sha256.txt',
      sha256: '323d6d7474a359a28eff7ddd0df8e65bd61554a8ed12ef42fd9365349e573c2c',
      isLts: false,
      isLatest: false
    },
    {
      majorVersion: 17,
      version: '17.0.20.1+1',
      name: 'Eclipse Temurin JDK 17',
      vendor: 'Eclipse Temurin',
      architecture: 'linux-x64',
      filename: 'OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz',
      downloadUrl: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz',
      sha256Url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz.sha256.txt',
      sha256: '3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e',
      isLts: true,
      isLatest: false
    }
  ],
  'linux-aarch64': [
    {
      majorVersion: 8,
      version: '8u504-b01',
      name: 'Eclipse Temurin JDK 8',
      vendor: 'Eclipse Temurin',
      architecture: 'linux-aarch64',
      filename: 'OpenJDK8U-jdk_aarch64_linux_hotspot_8u504b01.tar.gz',
      downloadUrl: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jdk_aarch64_linux_hotspot_8u504b01.tar.gz',
      sha256Url: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jdk_aarch64_linux_hotspot_8u504b01.tar.gz.sha256.txt',
      sha256: '57b7ed8af9d48542bb49ff7894448040b17bea0a48b41677d11ecaec6129768d',
      isLts: true,
      isLatest: false
    },
    {
      majorVersion: 11,
      version: '11.0.32.1+1',
      name: 'Eclipse Temurin JDK 11',
      vendor: 'Eclipse Temurin',
      architecture: 'linux-aarch64',
      filename: 'OpenJDK11U-jdk_aarch64_linux_hotspot_11.0.32.1_1.tar.gz',
      downloadUrl: 'https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.32.1%2B1/OpenJDK11U-jdk_aarch64_linux_hotspot_11.0.32.1_1.tar.gz',
      sha256Url: 'https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.32.1%2B1/OpenJDK11U-jdk_aarch64_linux_hotspot_11.0.32.1_1.tar.gz.sha256.txt',
      sha256: 'f27033e6f7523c1b0b2565a78e9c0e0abe5596a854ce00ca04ec1b06ece7a935',
      isLts: true,
      isLatest: false
    },
    {
      majorVersion: 16,
      version: '16.0.2+7',
      name: 'Eclipse Temurin JDK 16',
      vendor: 'Eclipse Temurin',
      architecture: 'linux-aarch64',
      filename: 'OpenJDK16U-jdk_aarch64_linux_hotspot_16.0.2_7.tar.gz',
      downloadUrl: 'https://github.com/adoptium/temurin16-binaries/releases/download/jdk-16.0.2%2B7/OpenJDK16U-jdk_aarch64_linux_hotspot_16.0.2_7.tar.gz',
      sha256Url: 'https://github.com/adoptium/temurin16-binaries/releases/download/jdk-16.0.2%2B7/OpenJDK16U-jdk_aarch64_linux_hotspot_16.0.2_7.tar.gz.sha256.txt',
      sha256: 'cb77d9d126f97898dfdc8b5fb694d1e0e5d93d13a0a6cb2aeda76f8635384340',
      isLts: false,
      isLatest: false
    },
    {
      majorVersion: 17,
      version: '17.0.20.1+1',
      name: 'Eclipse Temurin JDK 17',
      vendor: 'Eclipse Temurin',
      architecture: 'linux-aarch64',
      filename: 'OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.20.1_1.tar.gz',
      downloadUrl: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.20.1_1.tar.gz',
      sha256Url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.20.1_1.tar.gz.sha256.txt',
      sha256: '457b57af8f9c93ec39080bb8c764f559dc8c89a6da1a39d718a400b7890d3e41',
      isLts: true,
      isLatest: false
    }
  ]
};

const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_CHECKSUM_BYTES = 1024; // 1KB
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024; // 500MB
const MIN_ARCHIVE_BYTES = 10 * 1024 * 1024; // 10MB

// Catalog cache partitioned strictly by architecture to prevent cache poisoning
// Map<string, { catalog: Array, timestamp: number, networkError: string | null }>()
const cachedCatalogsByArch = new Map();

// Synchronous active installation locks
// Map<number, { majorVersion: number, step: string, progress: number, startTime: number, error: string | null }>
const activeInstalls = new Map();

/**
 * Strict integer parser for Java major versions (rejects "25junk", floats, NaN, negatives)
 */
function parseStrictMajorVersion(val) {
  if (typeof val === 'number') {
    if (Number.isSafeInteger(val) && val >= 8 && val <= 99) return val;
    return null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const num = Number(trimmed);
    if (Number.isSafeInteger(num) && num >= 8 && num <= 99) return num;
  }
  return null;
}

/**
 * Detects and validates supported host architecture for Oracle Linux packages
 */
function getHostArchitecture() {
  if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'linux-x64';
    if (process.arch === 'arm64' || process.arch === 'aarch64') return 'linux-aarch64';
    return null; // Unsupported Linux architecture
  }
  // Allow development/testing on non-Linux hosts (e.g. Windows test runner)
  if (process.env.NODE_ENV === 'test' || process.env.TEST_ENV === 'true' || process.platform === 'win32') {
    if (process.arch === 'arm64' || process.arch === 'aarch64') return 'linux-aarch64';
    return 'linux-x64';
  }
  return null; // Unsupported platform
}

/**
 * Validates Oracle page URLs (must be HTTPS, trusted host, port 443/default, no userinfo)
 */
function validateOraclePageUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    throw new Error('Geçersiz sayfa URL formatı: ' + rawUrl);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Yalnızca güvenli HTTPS protokolü üzerinden sayfa taranabilir.');
  }
  if (!TRUSTED_PAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Yetkisiz ana makine: ${parsed.hostname}. Yalnızca Oracle web sunucularına izin verilir.`);
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('Standart dışı HTTPS portuna izin verilmez.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL kimlik bilgileri içeremez.');
  }
  return parsed;
}

/**
 * Validates Oracle download URLs (must be HTTPS, download.oracle.com, port 443/default, no userinfo)
 */
function validateDownloadUrl(rawUrl, isRedirect = false) {
  if (typeof rawUrl !== 'string' || rawUrl.includes('..')) {
    throw new Error('Geçersiz indirme URL formatı veya path traversal tespit edildi: ' + rawUrl);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    throw new Error('Geçersiz indirme URL formatı: ' + rawUrl);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Yalnızca güvenli HTTPS protokolü üzerinden indirme yapılabilir.');
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowedHosts = isRedirect ? TRUSTED_REDIRECT_HOSTS : TRUSTED_DOWNLOAD_HOSTS;
  if (!allowedHosts.has(hostname)) {
    throw new Error(`Yetkisiz indirme sunucusu: ${parsed.hostname}. Yalnızca resmi Oracle ve Eclipse Temurin sunucuları kabul edilir.`);
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('Standart dışı HTTPS indirme portuna izin verilmez.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('İndirme adresi kimlik bilgileri içeremez.');
  }
  if (hostname === 'download.oracle.com') {
    if (parsed.pathname.includes('/otn/') || !parsed.pathname.startsWith('/java/')) {
      throw new Error('Eski, kısıtlı veya geçersiz Oracle dosya yollarına izin verilmez.');
    }
  } else if (hostname === 'github.com') {
    if (!parsed.pathname.startsWith('/adoptium/')) {
      throw new Error('Yetkisiz GitHub indirme deposu: Yalnızca resmi Adoptium Temurin sürümlerine izin verilir.');
    }
  }
  return parsed;
}

/**
 * Secure HTTPS GET helper with bounded body, redirect limits, and domain validation
 */
function fetchSecurePage(url, timeoutMs = 10000, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error('Çok fazla yönlendirme (redirect limit exceeded): ' + url));
    }

    try {
      validateOraclePageUrl(url);
    } catch (valErr) {
      return reject(valErr);
    }

    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // Drain redirect response
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, url).toString();
          } catch (e) {
            return reject(new Error('Geçersiz yönlendirme adresi: ' + res.headers.location));
          }
          return resolve(fetchSecurePage(nextUrl, timeoutMs, maxRedirects - 1));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP error ${res.statusCode} from ${url}`));
        }

        let data = '';
        let bytesCount = 0;

        res.on('data', (chunk) => {
          bytesCount += chunk.length;
          if (bytesCount > MAX_HTML_BYTES) {
            req.destroy();
            return reject(new Error(`HTML boyutu izin verilen sınırı aştı (max ${MAX_HTML_BYTES} bayt)`));
          }
          data += chunk;
        });

        res.on('end', () => resolve(data));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Sayfa indirme zaman aşımına uğradı (${timeoutMs}ms): ${url}`));
    });

    req.on('error', reject);
  });
}

/**
 * Fetches SHA-256 checksum string with strict size and format validation (fail closed)
 */
function fetchSha256Checksum(rawShaUrl, timeoutMs = 10000, maxRedirects = 3, isRedirect = false) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error('Çok fazla yönlendirme: ' + rawShaUrl));
    }

    try {
      validateDownloadUrl(rawShaUrl, isRedirect);
    } catch (valErr) {
      return reject(valErr);
    }

    const req = https.get(
      rawShaUrl,
      {
        headers: { 'User-Agent': 'maziPanel-JavaInstaller/1.0' },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, rawShaUrl).toString();
          } catch (e) {
            return reject(new Error('Geçersiz SHA-256 yönlendirme adresi: ' + res.headers.location));
          }
          return resolve(fetchSha256Checksum(nextUrl, timeoutMs, maxRedirects - 1, true));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`SHA-256 dosyası alınamadı (HTTP ${res.statusCode}): ${rawShaUrl}`));
        }

        let body = '';
        let bytesCount = 0;

        res.on('data', (chunk) => {
          bytesCount += chunk.length;
          if (bytesCount > MAX_CHECKSUM_BYTES) {
            req.destroy();
            return reject(new Error('SHA-256 dosyası beklenenden büyük.'));
          }
          body += chunk;
        });

        res.on('end', () => {
          const match = body.match(/([a-f0-9]{64})/i);
          if (!match) {
            return reject(new Error(`Geçerli 64 karakter SHA-256 sağlama toplamı bulunamadı: ${rawShaUrl}`));
          }
          resolve(match[1].toLowerCase());
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`SHA-256 indirme zaman aşımına uğradı (${timeoutMs}ms)`));
    });

    req.on('error', reject);
  });
}

/**
 * Parses Oracle Java downloads page HTML to extract freely available tar.gz downloads
 */
function parseOracleHtml(html, preferredArch = null) {
  const arch = preferredArch || getHostArchitecture();
  const entriesByMajor = new Map();

  const versionHeadings = new Map();
  const headingRegex = /Java\s+SE\s+Development\s+Kit\s+([0-9]+(?:\.[0-9]+)*)(?:\s+downloads)?/gi;
  let hMatch;
  while ((hMatch = headingRegex.exec(html)) !== null) {
    const fullVer = hMatch[1];
    const major = parseInt(fullVer.split('.')[0], 10);
    if (!isNaN(major) && !versionHeadings.has(major)) {
      versionHeadings.set(major, fullVer);
    }
  }

  const ltsMajors = new Set();
  const ltsRegex = /JDK\s+(\d+)\s+is\s+the\s+[^.]*?Long-Term\s+Support\s*\(LTS\)/gi;
  let lMatch;
  while ((lMatch = ltsRegex.exec(html)) !== null) {
    const major = parseInt(lMatch[1], 10);
    if (!isNaN(major)) ltsMajors.add(major);
  }
  [21, 25].forEach((m) => ltsMajors.add(m));

  let latestMajor = null;
  const latestRegex = /JDK\s+(\d+)\s+is\s+the\s+latest\s+release/i;
  const latestMatch = html.match(latestRegex);
  if (latestMatch) {
    latestMajor = parseInt(latestMatch[1], 10);
  }

  // Strictly match Oracle download URLs
  const linkRegex = /href=["'](https:\/\/download\.oracle\.com\/java\/(\d+)\/latest\/(jdk-[^"'<>]+\.(tar\.gz)))["']/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const downloadUrl = match[1];
    const major = parseInt(match[2], 10);
    const filename = match[3];

    let filePlatform = null;
    if (filename.includes('linux-x64')) {
      filePlatform = 'linux-x64';
    } else if (filename.includes('linux-aarch64')) {
      filePlatform = 'linux-aarch64';
    }

    if (!filePlatform) continue;
    if (arch && filePlatform !== arch) continue;

    const fullVersion = versionHeadings.get(major) || String(major);
    const sha256Url = `${downloadUrl}.sha256`;
    const isLts = ltsMajors.has(major);
    const isLatest = latestMajor ? major === latestMajor : false;

    if (!entriesByMajor.has(major)) {
      entriesByMajor.set(major, {
        majorVersion: major,
        version: fullVersion,
        name: `Oracle JDK ${major}`,
        vendor: 'Oracle',
        architecture: filePlatform,
        filename,
        downloadUrl,
        sha256Url,
        isLts,
        isLatest
      });
    }
  }

  const list = Array.from(entriesByMajor.values());
  list.sort((a, b) => b.majorVersion - a.majorVersion);

  if (list.length > 0 && !list.some((e) => e.isLatest)) {
    list[0].isLatest = true;
  }

  return list;
}

// In-flight catalog request promises by architecture to prevent duplicate simultaneous fetches
const inflightCatalogRequests = new Map();

/**
 * Fetches a single Adoptium GA release metadata
 */
async function fetchSingleAdoptiumVersion(v, adoptiumArch, arch, timeoutMs) {
  const apiUrl = `https://api.adoptium.net/v3/assets/feature_releases/${v}/ga?architecture=${adoptiumArch}&image_type=jdk&os=linux&vendor=eclipse&page_size=1`;
  const dataStr = await new Promise((resolve, reject) => {
    const parsedUrl = new URL(apiUrl);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'api.adoptium.net') {
      return reject(new Error('Geçersiz Adoptium API adresi: ' + apiUrl));
    }

    const req = https.get(
      apiUrl,
      {
        headers: { 'User-Agent': 'maziPanel-JavaInstaller/1.0' },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Adoptium API HTTP ${res.statusCode}`));
        }

        let body = '';
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            req.destroy();
            return reject(new Error('Adoptium API yanıtı boyutu aştı.'));
          }
          body += chunk;
        });

        res.on('end', () => resolve(body));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Adoptium API zaman aşımı (${timeoutMs}ms)`));
    });

    req.on('error', reject);
  });

  const parsedJson = JSON.parse(dataStr);
  if (Array.isArray(parsedJson) && parsedJson.length > 0) {
    const item = parsedJson[0];
    const binaries = Array.isArray(item.binaries) ? item.binaries : [];
    const linuxJdk = binaries.find(
      (b) => b.os === 'linux' && b.image_type === 'jdk' && b.architecture === adoptiumArch && b.package
    );

    if (linuxJdk && linuxJdk.package && linuxJdk.package.link) {
      const pkg = linuxJdk.package;
      validateDownloadUrl(pkg.link);
      return {
        majorVersion: v,
        version: item.release_name || String(v),
        name: `Eclipse Temurin JDK ${v}`,
        vendor: 'Eclipse Temurin',
        architecture: arch,
        filename: pkg.name || `OpenJDK${v}U-jdk_${adoptiumArch}_linux_hotspot.tar.gz`,
        downloadUrl: pkg.link,
        sha256Url: pkg.checksum_link || `${pkg.link}.sha256.txt`,
        sha256: pkg.checksum ? pkg.checksum.toLowerCase() : null,
        isLts: [8, 11, 17, 21, 25].includes(v),
        isLatest: false,
        source: 'adoptium-api'
      };
    }
  }
  throw new Error(`Adoptium API JDK ${v} için uygun paket döndürmedi.`);
}

/**
 * Fetches official Eclipse Temurin (Adoptium) GA releases for older versions (8, 11, 16, 17)
 * in parallel via Adoptium API v3 with size, timeout, and URL security validation.
 * Falls back to verified static pins if API is unreachable.
 */
async function fetchAdoptiumReleases(arch, timeoutMs = 8000) {
  const adoptiumArch = arch === 'linux-aarch64' ? 'aarch64' : 'x64';
  const versions = [17, 16, 11, 8];
  const results = [];

  // Parallelize individual version requests bounded by Promise.allSettled
  const settled = await Promise.allSettled(
    versions.map((v) => fetchSingleAdoptiumVersion(v, adoptiumArch, arch, timeoutMs))
  );

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const outcome = settled[i];
    if (outcome.status === 'fulfilled' && outcome.value) {
      results.push(outcome.value);
    } else {
      // Fallback to static verified pin for this version
      const fallbackList = TEMURIN_RELEASES[arch] || TEMURIN_RELEASES['linux-x64'] || [];
      const pin = fallbackList.find((p) => p.majorVersion === v);
      if (pin) {
        results.push({
          ...pin,
          isStale: true,
          source: 'temurin-fallback'
        });
      }
    }
  }

  return results;
}

/**
 * Retrieves the Java releases catalog partitioned by architecture.
 * Parallelizes Oracle and Adoptium queries, caches in-flight promises.
 * If network fails: returns last known cache (with stale: true) or empty catalog [].
 * NEVER invents fake latest releases.
 */
async function getJavaCatalog(options = {}) {
  const { forceRefresh = false, targetArch = null } = options;
  const now = Date.now();

  const allowedArchitectures = ['linux-x64', 'linux-aarch64'];
  let arch = targetArch;
  if (!arch || !allowedArchitectures.includes(arch)) {
    arch = getHostArchitecture() || 'linux-x64';
  }

  const cachedEntry = cachedCatalogsByArch.get(arch);

  if (!forceRefresh && cachedEntry && (now - cachedEntry.timestamp < CATALOG_CACHE_TTL_MS)) {
    return decorateCatalogResponse(arch, cachedEntry.catalog, cachedEntry.networkError, false, true, forceRefresh);
  }

  // Deduplicate simultaneous in-flight fetches for the same architecture
  if (!forceRefresh && inflightCatalogRequests.has(arch)) {
    return inflightCatalogRequests.get(arch);
  }

  const fetchPromise = (async () => {
    let catalogItems = [];
    let networkError = null;
    let isStale = false;

    // Parallelize Oracle and Adoptium queries with Promise.allSettled
    const [oracleOutcome, adoptiumOutcome] = await Promise.allSettled([
      (async () => {
        let html = '';
        try {
          html = await module.exports.fetchSecurePage(ORACLE_DOWNLOADS_URL, 8000);
        } catch (err) {
          html = await module.exports.fetchSecurePage(ORACLE_FALLBACK_URL, 8000);
        }
        return parseOracleHtml(html, arch);
      })(),
      module.exports.fetchAdoptiumReleases(arch, 8000)
    ]);

    let oracleItems = [];
    let oracleError = null;
    if (oracleOutcome.status === 'fulfilled' && Array.isArray(oracleOutcome.value)) {
      oracleItems = oracleOutcome.value;
    } else if (oracleOutcome.status === 'rejected') {
      oracleError = oracleOutcome.reason?.message || 'Oracle indirme sayfası alınamadı.';
    }

    let adoptiumItems = [];
    let adoptiumError = null;
    if (adoptiumOutcome.status === 'fulfilled' && Array.isArray(adoptiumOutcome.value)) {
      adoptiumItems = adoptiumOutcome.value;
    } else if (adoptiumOutcome.status === 'rejected') {
      adoptiumError = adoptiumOutcome.reason?.message || 'Adoptium API alınamadı.';
      const fallbackList = TEMURIN_RELEASES[arch] || TEMURIN_RELEASES['linux-x64'] || [];
      adoptiumItems = fallbackList.map((t) => ({ ...t, isStale: true }));
    }

    // Combine releases: Oracle latest + Adoptium older LTS/GA
    const combined = [...oracleItems];
    for (const t of adoptiumItems) {
      if (!combined.some((item) => item.majorVersion === t.majorVersion)) {
        combined.push({ ...t });
      }
    }
    combined.sort((a, b) => b.majorVersion - a.majorVersion);

    if (combined.length > 0) {
      catalogItems = combined;
      networkError = oracleError || adoptiumError;
      cachedCatalogsByArch.set(arch, {
        catalog: combined,
        timestamp: Date.now(),
        networkError
      });
    } else {
      networkError = oracleError || adoptiumError || 'Java kataloğu alınamadı.';
      if (cachedEntry && cachedEntry.catalog && cachedEntry.catalog.length > 0) {
        catalogItems = cachedEntry.catalog;
        isStale = true;
      } else {
        catalogItems = [];
      }
    }

    return decorateCatalogResponse(arch, catalogItems, networkError, isStale, false, forceRefresh);
  })();

  inflightCatalogRequests.set(arch, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inflightCatalogRequests.delete(arch);
  }
}

/**
 * Helper to decorate catalog entries with installed info
 */
function decorateCatalogResponse(arch, catalogItems, networkError, isStale, isCached, forceRefresh) {
  const installedList = javaDetector.detectJavaInstallations(forceRefresh);
  const enrichedCatalog = catalogItems.map((item) => {
    const matchingInstalled = installedList.find(
      (inst) => inst.majorVersion === item.majorVersion
    );

    const isCurrentlyInstalling = activeInstalls.has(item.majorVersion);
    const installInfo = activeInstalls.get(item.majorVersion);

    return {
      ...item,
      installed: !!matchingInstalled,
      installedPath: matchingInstalled ? matchingInstalled.path : null,
      installedVersion: matchingInstalled ? matchingInstalled.rawVersion : null,
      installedVendor: matchingInstalled ? matchingInstalled.vendor : null,
      panelManaged: matchingInstalled ? !!matchingInstalled.panelManaged : false,
      status: isCurrentlyInstalling
        ? 'installing'
        : matchingInstalled
        ? 'installed'
        : 'available',
      installProgress: isCurrentlyInstalling ? installInfo.progress : undefined,
      installStep: isCurrentlyInstalling ? installInfo.step : undefined
    };
  });

  return {
    architecture: arch,
    catalog: enrichedCatalog,
    installed: installedList,
    networkError,
    stale: isStale,
    cached: isCached
  };
}

/**
 * Validates download URL and parameters for strict security compliance
 */
function validateInstallTarget(target) {
  if (!target || typeof target !== 'object') {
    throw new Error('Geçersiz kurulum parametresi.');
  }

  const { downloadUrl, majorVersion, architecture, sha256Url, sha256 } = target;

  const validMajor = parseStrictMajorVersion(majorVersion);
  if (!validMajor) {
    throw new Error(`Geçersiz Java ana sürümü: ${majorVersion}. Tam sayı (8 - 99) olmalıdır.`);
  }

  if (!downloadUrl || typeof downloadUrl !== 'string') {
    throw new Error('İndirme bağlantısı eksik.');
  }

  if (!sha256Url && !sha256) {
    throw new Error('SHA-256 kontrol adresi eksik. Güvenlik gereği kontrol toplamı zorunludur.');
  }

  // Strictly validate both download and checksum URLs
  const parsedDownload = validateDownloadUrl(downloadUrl);
  if (sha256Url) {
    validateDownloadUrl(sha256Url);
  }

  const hostname = parsedDownload.hostname.toLowerCase();
  if (hostname === 'download.oracle.com') {
    const pathRegex = /^\/java\/\d+\/latest\/jdk-[\w.-]+_linux-(?:x64|aarch64)_bin\.tar\.gz$/;
    if (!pathRegex.test(parsedDownload.pathname)) {
      throw new Error('İndirme adresi standart Oracle JDK arşiv formatıyla uyuşmuyor.');
    }
  } else if (hostname === 'github.com') {
    const adoptiumRegex = /^\/adoptium\/temurin\d+-binaries\/releases\/download\/[^/]+\/OpenJDK\d+U-jdk_(?:x64|aarch64)_linux_hotspot_[\w.+-]+\.tar\.gz$/i;
    if (!adoptiumRegex.test(parsedDownload.pathname)) {
      throw new Error('İndirme adresi standart Eclipse Temurin JDK arşiv formatıyla uyuşmuyor.');
    }
  }

  // Validate architecture
  const hostArch = getHostArchitecture();
  if (!hostArch) {
    throw new Error(`Mevcut platform (${process.platform}-${process.arch}) Java kurulumu için desteklenmiyor.`);
  }
  if (architecture && architecture !== hostArch) {
    throw new Error(`İstenen mimari (${architecture}) mevcut sistem mimarisi (${hostArch}) ile uyuşmuyor.`);
  }

  return true;
}

/**
 * Downloads a file to disk with strict checksum verification, bounded byte limits, and safe redirects
 */
function downloadAndVerifyArchive(downloadUrl, sha256Url, destFile, onProgress, expectedSha = null, maxRedirects = 3, isRedirect = false) {
  return new Promise(async (resolve, reject) => {
    let fileStream = null;
    let requestObj = null;

    const cleanup = () => {
      if (fileStream) {
        try { fileStream.destroy(); } catch (e) {}
      }
      try {
        if (fs.existsSync(destFile)) {
          fs.unlinkSync(destFile);
        }
      } catch (e) {}
    };

    if (maxRedirects < 0) {
      cleanup();
      return reject(new Error('İndirmede izin verilen yönlendirme sınırı aşıldı: ' + downloadUrl));
    }

    try {
      validateDownloadUrl(downloadUrl, isRedirect);
    } catch (valErr) {
      cleanup();
      return reject(valErr);
    }

    // Redirects must preserve validated checksum and must not attempt arbitrary downloads
    if (isRedirect && !expectedSha) {
      cleanup();
      return reject(new Error('Yönlendirme sırasında beklenen SHA-256 doğrulama anahtarı eksik.'));
    }

    // 1. Fetch expected SHA-256 checksum (FAIL CLOSED if missing or invalid)
    let targetHash = expectedSha;
    if (!targetHash) {
      if (!sha256Url) {
        cleanup();
        return reject(new Error('SHA-256 kontrol adresi eksik. Güvenlik gereği kontrol toplamı zorunludur.'));
      }
      try {
        targetHash = await fetchSha256Checksum(sha256Url, 10000);
      } catch (shaErr) {
        cleanup();
        return reject(new Error(`SHA-256 doğrulama anahtarı alınamadı: ${shaErr.message}`));
      }
    }

    if (!targetHash || !/^[a-f0-9]{64}$/i.test(targetHash)) {
      cleanup();
      return reject(new Error('Geçerli bir SHA-256 sağlama toplamı temin edilemedi. İndirme durduruldu.'));
    }

    // 2. Stream download with byte counter and hash computation
    requestObj = https.get(
      downloadUrl,
      {
        headers: { 'User-Agent': 'maziPanel-JavaInstaller/1.0' },
        timeout: 45000
      },
      (res) => {
        // Handle redirect while strictly preserving expectedHash and validating target host
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, downloadUrl).toString();
          } catch (e) {
            cleanup();
            return reject(new Error('Geçersiz yönlendirme URL: ' + res.headers.location));
          }
          return downloadAndVerifyArchive(nextUrl, sha256Url, destFile, onProgress, targetHash, maxRedirects - 1, true)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 200) {
          res.resume();
          cleanup();
          return reject(new Error(`İndirme başarısız (HTTP ${res.statusCode}): ${downloadUrl}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        if (totalBytes > MAX_ARCHIVE_BYTES) {
          res.resume();
          cleanup();
          return reject(new Error(`Arşiv boyutu (${totalBytes} bayt) azami izin verilen sınırı (${MAX_ARCHIVE_BYTES} bayt) aşıyor.`));
        }

        let downloadedBytes = 0;
        const hash = crypto.createHash('sha256');

        try {
          fileStream = fs.createWriteStream(destFile);
        } catch (streamErr) {
          res.resume();
          cleanup();
          return reject(streamErr);
        }

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (downloadedBytes > MAX_ARCHIVE_BYTES) {
            requestObj.destroy();
            cleanup();
            return reject(new Error(`İndirilen veri sınırı (${MAX_ARCHIVE_BYTES} bayt) aşıldı.`));
          }

          hash.update(chunk);
          if (onProgress && totalBytes > 0) {
            const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
            onProgress(percent, downloadedBytes, totalBytes);
          }
        });

        res.on('error', (err) => {
          cleanup();
          reject(err);
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => {
            fileStream = null;

            if (totalBytes > 0 && downloadedBytes !== totalBytes) {
              cleanup();
              return reject(new Error(`Eksik indirme: Beklenen ${totalBytes} bayt, alınan ${downloadedBytes} bayt.`));
            }

            try {
              const stats = fs.statSync(destFile);
              const minLimit = (process.env.NODE_ENV === 'test' || process.env.TEST_ENV === 'true') ? 10 : MIN_ARCHIVE_BYTES;
              if (stats.size < minLimit) {
                cleanup();
                return reject(new Error(`İndirilen arşiv boyutu (${stats.size} bayt) geçersiz veya bozuk.`));
              }

              const calculatedHash = hash.digest('hex').toLowerCase();
              if (calculatedHash !== targetHash.toLowerCase()) {
                cleanup();
                return reject(
                  new Error(`SHA-256 doğrulama başarısız! Beklenen: ${targetHash}, Hesaplanan: ${calculatedHash}`)
                );
              }

              resolve({
                filePath: destFile,
                sha256: calculatedHash,
                size: stats.size
              });
            } catch (statErr) {
              cleanup();
              reject(statErr);
            }
          });
        });

        fileStream.on('error', (err) => {
          cleanup();
          reject(err);
        });
      }
    );

    requestObj.on('timeout', () => {
      requestObj.destroy();
      cleanup();
      reject(new Error('İndirme zaman aşımına uğradı (45s).'));
    });

    requestObj.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

/**
 * Validates extracted Java directory in staging: locates bin/java, verifies executable,
 * inspects runtime version, and asserts it matches the requested major version.
 *
 * @param {string} stagingDir Path to staging directory
 * @param {number} expectedMajor Expected Java major version (e.g. 21, 25, 27)
 * @param {object} [detectorStub] Optional detector override for isolated testing
 * @returns {{ extractedRoot: string, javaBin: string, info: object }}
 */
function validateStagedJava(stagingDir, expectedMajor, detectorStub = null) {
  if (!fs.existsSync(stagingDir)) {
    throw new Error('Staging dizini bulunamadı: ' + stagingDir);
  }

  const detector = detectorStub || javaDetector;
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'java.exe' : 'java';

  let extractedRoot = stagingDir;
  let candidateBin = path.join(stagingDir, 'bin', binName);

  if (!fs.existsSync(candidateBin)) {
    const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const subBin = path.join(stagingDir, ent.name, 'bin', binName);
        if (fs.existsSync(subBin)) {
          extractedRoot = path.join(stagingDir, ent.name);
          candidateBin = subBin;
          break;
        }
      }
    }
  }

  if (!fs.existsSync(candidateBin)) {
    throw new Error('Arşiv içinde java çalıştırılabilir dosyası (bin/java) bulunamadı.');
  }

  if (!isWin) {
    try {
      fs.chmodSync(candidateBin, 0o755);
    } catch (e) {}
  }

  const stagedInfo = detector.inspectJavaExecutable(candidateBin);
  if (!stagedInfo || stagedInfo.majorVersion !== expectedMajor) {
    const detectedVer = stagedInfo ? stagedInfo.majorVersion : 'geçersiz';
    throw new Error(
      `Arşiv içindeki Java sürümü doğrulanamadı veya istenen ana sürümle uyuşmuyor (Beklenen: ${expectedMajor}, Tespit: ${detectedVer}). Kurulum iptal edildi.`
    );
  }

  return {
    extractedRoot,
    javaBin: candidateBin,
    info: stagedInfo
  };
}

/**
 * Executes atomic, verified installation of a Java version into panel-owned data directory
 */
async function installJavaVersion(majorVersion, options = {}) {
  // 1. Strict integer validation
  const majorNum = parseStrictMajorVersion(majorVersion);
  if (!majorNum) {
    throw new Error(`Geçersiz veya desteklenmeyen Java ana sürümü: ${majorVersion}. Tam sayı (8 - 99) girilmelidir.`);
  }

  // 2. Synchronous lock reservation to eliminate race window before any await
  if (activeInstalls.has(majorNum)) {
    throw new Error(`Java ${majorNum} kurulumu şu anda zaten devam ediyor.`);
  }

  const installState = {
    majorVersion: majorNum,
    step: 'Katalog ve sistem mimarisi doğrulanıyor...',
    progress: 5,
    startTime: Date.now(),
    error: null
  };
  activeInstalls.set(majorNum, installState);

  const panelJavaBase = path.join(config.DATA_DIR, 'java');
  const stagingDir = path.join(panelJavaBase, `.staging-jdk-${majorNum}-${Date.now()}`);
  const finalDir = path.join(panelJavaBase, `jdk-${majorNum}`);
  let backupDir = null;

  try {
    // 3. Resolve release from catalog
    const catalogData = options.mockCatalog ? await options.mockCatalog : await getJavaCatalog({ forceRefresh: false });
    const entry = catalogData.catalog.find((c) => c.majorVersion === majorNum);

    if (!entry) {
      throw new Error(`Java ${majorNum} katalogda bulunamadı veya sistem mimarisine uygun değil.`);
    }

    // 4. Validate security constraints
    validateInstallTarget(entry);

    if (!fs.existsSync(panelJavaBase)) {
      fs.mkdirSync(panelJavaBase, { recursive: true });
    }
    fs.mkdirSync(stagingDir, { recursive: true });
    const archivePath = path.join(stagingDir, entry.filename || `jdk-${majorNum}.tar.gz`);

    installState.step = `${entry.vendor || 'Java'} JDK ${majorNum} arşivi indiriliyor ve SHA-256 kontrol ediliyor...`;
    installState.progress = 10;

    // 5. Download and verify SHA-256 (fail closed)
    await downloadAndVerifyArchive(
      entry.downloadUrl,
      entry.sha256Url,
      archivePath,
      (percent) => {
        installState.progress = 10 + Math.round(percent * 0.65); // 10% -> 75%
      },
      entry.sha256 || null
    );

    installState.step = 'Arşiv açılıyor ve Java çalıştırılabilir dosyası inceleniyor...';
    installState.progress = 80;

    // 6. Inspect tar archive for Tar-Slip and extract safely into staging directory
    inspectTarArchive(archivePath, { isGzip: true });

    const extractRes = spawnSync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archivePath, '-C', stagingDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      shell: false
    });

    if (extractRes.status !== 0) {
      throw new Error(`Java arşivi açılamadı: ${extractRes.stderr?.toString() || 'tar çıkış kodu ' + extractRes.status}`);
    }

    try {
      fs.unlinkSync(archivePath);
    } catch (e) {}

    installState.progress = 88;
    installState.step = 'Açılan Java sürümü doğrulanıyor...';

    // 7. Validate extracted version matches requested major version EXACTLY using validateStagedJava
    const stagedResult = validateStagedJava(stagingDir, majorNum, options.detectorStub);
    const extractedRoot = stagedResult.extractedRoot;

    installState.progress = 94;
    installState.step = 'Kurulum atomik olarak taşınıyor...';

    // 9. Atomic swap with rollback protection
    if (fs.existsSync(finalDir)) {
      backupDir = `${finalDir}.backup-${Date.now()}`;
      fs.renameSync(finalDir, backupDir);
    }

    try {
      if (extractedRoot !== stagingDir) {
        fs.renameSync(extractedRoot, finalDir);
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) {}
      } else {
        fs.renameSync(stagingDir, finalDir);
      }

      const finalJavaBin = path.join(finalDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (process.platform !== 'win32' && fs.existsSync(finalJavaBin)) {
        try {
          fs.chmodSync(finalJavaBin, 0o755);
        } catch (e) {}
      }

      // Cleanup backup only after swap succeeded
      if (backupDir && fs.existsSync(backupDir)) {
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (moveErr) {
      // Rollback: restore previous installation if directory move failed
      if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(finalDir)) {
        try { fs.renameSync(backupDir, finalDir); } catch (e) {}
      }
      throw moveErr;
    }

    installState.progress = 98;
    installState.step = 'Java algılama sistemi güncelleniyor...';

    // 10. Refresh Java detector cache
    const finalJavaBin = path.join(finalDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const detected = javaDetector.detectJavaInstallations(true);
    const foundInstalled = detected.find((j) => j.path === finalJavaBin || j.majorVersion === majorNum);

    installState.progress = 100;
    installState.step = 'Kurulum başarıyla tamamlandı.';

    return {
      success: true,
      majorVersion: majorNum,
      path: finalJavaBin,
      installedInfo: foundInstalled || {
        path: finalJavaBin,
        majorVersion: majorNum,
        vendor: 'Oracle',
        panelManaged: true
      }
    };
  } catch (err) {
    installState.error = err.message;
    // Cleanup staging on error
    try {
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    } catch (e) {}
    throw err;
  } finally {
    // Lock is always released in finally
    activeInstalls.delete(majorNum);
  }
}

/**
 * Returns active install statuses
 */
function getActiveInstalls() {
  const list = [];
  for (const [major, info] of activeInstalls.entries()) {
    list.push({ ...info });
  }
  return list;
}

/**
 * Resets memory cache for testing purposes
 */
function resetMemoryCache() {
  cachedCatalogsByArch.clear();
  inflightCatalogRequests.clear();
  activeInstalls.clear();
}

module.exports = {
  getJavaCatalog,
  installJavaVersion,
  getActiveInstalls,
  validateInstallTarget,
  validateDownloadUrl,
  validateOraclePageUrl,
  parseOracleHtml,
  getHostArchitecture,
  downloadAndVerifyArchive,
  fetchSecurePage,
  fetchSha256Checksum,
  parseStrictMajorVersion,
  validateStagedJava,
  fetchAdoptiumReleases,
  resetMemoryCache,
  isInstalling: (major) => {
    const num = parseStrictMajorVersion(major);
    return num ? activeInstalls.has(num) : false;
  }
};
