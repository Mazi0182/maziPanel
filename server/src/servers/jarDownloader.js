const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const wsManager = require('../websocket/wsManager');

class JarDownloader {
  constructor() {
    this.activeDownloads = new Map();
  }

  /**
   * Fetch available core versions for a given engine type
   * @param {'purpur' | 'paper' | 'vanilla'} type
   * @returns {Promise<string[]>} List of version strings, newest first
   */
  async getVersions(type) {
    const engine = (type || '').toLowerCase().trim();

    if (engine === 'purpur') {
      return this._getPurpurVersions();
    } else if (engine === 'paper') {
      return this._getPaperVersions();
    } else if (engine === 'vanilla') {
      return this._getVanillaVersions();
    } else {
      throw new Error(`Desteklenmeyen motor türü: "${type}". Desteklenen türler: purpur, paper, vanilla`);
    }
  }

  async _getPurpurVersions() {
    const res = await fetch('https://api.purpurmc.org/v2/purpur', {
      headers: { 'User-Agent': 'maziPanel-Daemon/1.0' }
    });
    if (!res.ok) {
      throw new Error(`Purpur sürümleri alınamadı: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.versions || !Array.isArray(data.versions)) {
      throw new Error('Purpur API yanıt yapısı geçersiz.');
    }
    // Reverse array so newest versions are first (e.g. 26.3, 26.2, 1.21.4...)
    return data.versions.slice().reverse();
  }

  async _getPaperVersions() {
    const res = await fetch('https://fill.papermc.io/v3/projects/paper', {
      headers: { 'User-Agent': 'maziPanel-Daemon/1.0' }
    });
    if (!res.ok) {
      throw new Error(`PaperMC sürümleri alınamadı: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.versions || typeof data.versions !== 'object') {
      throw new Error('PaperMC v3 API yanıt yapısı geçersiz.');
    }
    const versions = [];
    for (const group of Object.values(data.versions)) {
      if (Array.isArray(group)) {
        versions.push(...group);
      }
    }
    return versions;
  }

  async _getVanillaVersions() {
    const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', {
      headers: { 'User-Agent': 'maziPanel-Daemon/1.0' }
    });
    if (!res.ok) {
      throw new Error(`Vanilla sürüm listesi alınamadı: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.versions || !Array.isArray(data.versions)) {
      throw new Error('Mojang sürüm listesi yanıt yapısı geçersiz.');
    }
    // Filter release versions only
    const releases = data.versions
      .filter((v) => v.type === 'release')
      .map((v) => v.id);
    return releases;
  }

  /**
   /**
   * Resolve direct download URL and checksum information for a given engine and version
   * @param {'purpur' | 'paper' | 'vanilla'} type
   * @param {string} version
   * @returns {Promise<{ url: string, hashInfo: { algo: string, hash: string } | null }>}
   */
  async getDownloadInfo(type, version) {
    const engine = (type || '').toLowerCase().trim();

    if (engine === 'purpur') {
      const downloadUrl = `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest/download`;
      let hashInfo = null;
      try {
        const metaRes = await fetch(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest`, {
          headers: { 'User-Agent': 'maziPanel-Daemon/1.0' }
        });
        if (metaRes.ok) {
          const metaData = await metaRes.json();
          if (metaData.sha256) {
            hashInfo = { algo: 'sha256', hash: String(metaData.sha256).trim().toLowerCase() };
          } else if (metaData.md5) {
            hashInfo = { algo: 'md5', hash: String(metaData.md5).trim().toLowerCase() };
          }
        }
      } catch (err) {
        console.warn(`[JarDownloader] Purpur ${version} meta bilgisi alınamadı:`, err.message);
      }
      return { url: downloadUrl, hashInfo };
    }

    if (engine === 'paper') {
      const versionUrl = `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}`;
      const vRes = await fetch(versionUrl, {
        headers: { 'User-Agent': 'maziPanel-Daemon/1.0' }
      });
      if (!vRes.ok) {
        throw new Error(`Paper sürümleri alınamadı (${version}): HTTP ${vRes.status}`);
      }
      const vData = await vRes.json();
      if (!vData.builds || !Array.isArray(vData.builds) || vData.builds.length === 0) {
        throw new Error(`Paper sürümü "${version}" için derleme bulunamadı`);
      }
      const latestBuild = vData.builds.reduce((max, b) => Math.max(max, Number(b) || 0), 0);
      const buildUrl = `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds/${latestBuild}`;
      const bRes = await fetch(buildUrl, {
        headers: { 'User-Agent': 'maziPanel-Daemon/1.0' }
      });
      if (!bRes.ok) {
        throw new Error(`Paper derleme ${latestBuild} detayları alınamadı: HTTP ${bRes.status}`);
      }
      const bData = await bRes.json();
      const downloads = bData.downloads || {};
      const downloadObj = downloads['server:default'] || downloads.server || Object.values(downloads)[0];
      if (!downloadObj || !downloadObj.url) {
        throw new Error(`Paper derleme ${latestBuild} için indirme URL'si eksik`);
      }

      let hashInfo = null;
      if (downloadObj.checksums && downloadObj.checksums.sha256) {
        hashInfo = { algo: 'sha256', hash: String(downloadObj.checksums.sha256).trim().toLowerCase() };
      } else if (downloadObj.sha256) {
        hashInfo = { algo: 'sha256', hash: String(downloadObj.sha256).trim().toLowerCase() };
      }

      return { url: downloadObj.url, hashInfo };
    }

    if (engine === 'vanilla') {
      const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', {
        headers: { 'User-Agent': 'maziPanel-Daemon/1.0' }
      });
      if (!res.ok) {
        throw new Error(`Mojang sürüm bildirimi alınamadı: HTTP ${res.status}`);
      }
      const data = await res.json();
      const targetVersion = (data.versions || []).find((v) => v.id === version && v.type === 'release')
        || (data.versions || []).find((v) => v.id === version);
      if (!targetVersion || !targetVersion.url) {
        throw new Error(`Mojang bildiriminde "${version}" Vanilla sürümü bulunamadı`);
      }
      const pkgRes = await fetch(targetVersion.url, {
        headers: { 'User-Agent': 'maziPanel-Daemon/1.0' }
      });
      if (!pkgRes.ok) {
        throw new Error(`Mojang ${version} paket detayları alınamadı: HTTP ${pkgRes.status}`);
      }
      const pkg = await pkgRes.json();
      if (!pkg.downloads || !pkg.downloads.server || !pkg.downloads.server.url) {
        throw new Error(`"${version}" Vanilla sürümü için sunucu JAR indirme bağlantısı bulunamadı`);
      }

      let hashInfo = null;
      if (pkg.downloads.server.sha1) {
        hashInfo = { algo: 'sha1', hash: String(pkg.downloads.server.sha1).trim().toLowerCase() };
      }

      return { url: pkg.downloads.server.url, hashInfo };
    }

    throw new Error(`Desteklenmeyen motor türü: "${type}". Desteklenen türler: purpur, paper, vanilla`);
  }

  /**
   * Resolve direct download URL for a given engine and version
   * @param {'purpur' | 'paper' | 'vanilla'} type
   * @param {string} version
   * @returns {Promise<string>} Direct download URL for the server jar
   */
  async getDownloadUrl(type, version) {
    const info = await this.getDownloadInfo(type, version);
    return info.url;
  }

  /**
   * Download jar file and emit progress via WebSocket
   * @param {Object} options
   * @param {string} options.serverId
   * @param {string} options.type
   * @param {string} options.version
   * @param {string} options.destPath
   */
  async downloadJar({ serverId, type, version, destPath }) {
    if (this.activeDownloads.has(serverId)) {
      throw new Error(`"${serverId}" sunucusu için zaten devam eden bir indirme işlemi mevcut.`);
    }

    const { url: downloadUrl, hashInfo } = await this.getDownloadInfo(type, version);
    console.log(`[JarDownloader] Starting download for server ${serverId}: ${type} ${version}`);
    console.log(`[JarDownloader] URL: ${downloadUrl}`);
    if (hashInfo) {
      console.log(`[JarDownloader] Beklenen checksum (${hashInfo.algo.toUpperCase()}): ${hashInfo.hash}`);
    } else {
      console.warn(`[JarDownloader] ${type} ${version} için checksum bilgisi sağlanamadı; dosya doğrulaması atlandı.`);
    }

    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${destPath}.download-${Date.now()}`;
    const fileStream = fs.createWriteStream(tempPath);
    let streamErr = null;
    fileStream.on('error', (err) => { streamErr = err; });

    const hasher = (hashInfo && hashInfo.algo) ? crypto.createHash(hashInfo.algo) : null;

    this.activeDownloads.set(serverId, {
      type,
      version,
      destPath,
      startTime: Date.now(),
      status: 'starting'
    });

    try {
      const response = await fetch(downloadUrl, {
        headers: { 'User-Agent': 'maziPanel-Daemon/1.0' },
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`JAR dosyası indirilemedi (${downloadUrl}): HTTP ${response.status}`);
      }

      const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
      let downloadedBytes = 0;
      let lastBroadcastTime = 0;
      let lastPercent = -1;

      // Initial progress event
      wsManager.broadcastDownloadProgress({
        serverId,
        type,
        version,
        percent: 0,
        downloadedBytes: 0,
        totalBytes,
        status: 'downloading'
      });

      for await (const chunk of response.body) {
        if (streamErr) throw streamErr;
        downloadedBytes += chunk.length;
        if (hasher) {
          hasher.update(chunk);
        }
        if (!fileStream.write(chunk)) {
          await new Promise((resolve) => fileStream.once('drain', resolve));
        }

        const now = Date.now();
        const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;

        // Throttle progress broadcast to every 200ms or when percent changes by >= 2
        if (now - lastBroadcastTime >= 200 || percent >= lastPercent + 2 || percent === 100) {
          lastBroadcastTime = now;
          lastPercent = percent;
          wsManager.broadcastDownloadProgress({
            serverId,
            type,
            version,
            percent,
            downloadedBytes,
            totalBytes,
            status: percent === 100 ? 'finishing' : 'downloading'
          });
        }
      }

      await new Promise((resolve, reject) => {
        fileStream.end((err) => {
          if (err) reject(err);
          else resolve();
        });
        fileStream.on('error', reject);
      });

      // Verify checksum before atomic replacement
      if (hasher && hashInfo && hashInfo.hash) {
        const calculatedHash = hasher.digest('hex').toLowerCase();
        if (calculatedHash !== hashInfo.hash.toLowerCase()) {
          if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
          }
          throw new Error(`İndirilen JAR dosyasının sağlama toplamı (${hashInfo.algo.toUpperCase()}) eşleşmedi! Beklenen: ${hashInfo.hash}, Hesaplanan: ${calculatedHash}`);
        }
      }

      // Atomically replace target jar file
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.renameSync(tempPath, destPath);

      console.log(`[JarDownloader] Download completed for server ${serverId}: ${destPath} (${downloadedBytes} bytes)`);

      // Final completed event
      wsManager.broadcastDownloadProgress({
        serverId,
        type,
        version,
        percent: 100,
        downloadedBytes,
        totalBytes: totalBytes || downloadedBytes,
        status: 'completed'
      });

      this.activeDownloads.delete(serverId);
      return {
        success: true,
        destPath,
        size: downloadedBytes,
        type,
        version
      };
    } catch (err) {
      if (fileStream && !fileStream.destroyed) {
        try { fileStream.destroy(); } catch (e) {}
      }
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }
      this.activeDownloads.delete(serverId);
      wsManager.broadcastDownloadProgress({
        serverId,
        type,
        version,
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        status: 'failed',
        error: err.message
      });
      throw err;
    }
  }
}

module.exports = new JarDownloader();
