const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('../../config');
const serverRegistry = require('./serverRegistry');
const javaDetector = require('../system/javaDetector');
const { validateAndExtractZip } = require('./archiveSecurity');

class ZipImporter {
  /**
   * Parses server.properties simple key=value format
   */
  parseServerProperties(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const result = {};
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Finds the main Minecraft server JAR file
   */
  findMainJar(serverDir) {
    try {
      const files = fs.readdirSync(serverDir, { withFileTypes: true });
      const jarCandidates = files
        .filter((f) => f.isFile() && !f.isSymbolicLink() && !f.name.startsWith('-') && /^[a-zA-Z0-9._+-]+\.jar$/i.test(f.name))
        .map((f) => f.name);

      if (jarCandidates.length === 0) {
        return null;
      }

      // Priority list
      const priorities = [
        /^purpur.*\.jar$/i,
        /^paper.*\.jar$/i,
        /^spigot.*\.jar$/i,
        /^folia.*\.jar$/i,
        /^server.*\.jar$/i,
        /^minecraft_server.*\.jar$/i,
        /^forge.*\.jar$/i,
        /^fabric.*\.jar$/i
      ];

      for (const pattern of priorities) {
        const found = jarCandidates.find((name) => pattern.test(name));
        if (found) return found;
      }

      // Fallback: pick the largest jar file in root (since server jars are usually 40MB-70MB, whereas tools are small)
      jarCandidates.sort((a, b) => {
        const sizeA = fs.statSync(path.join(serverDir, a)).size;
        const sizeB = fs.statSync(path.join(serverDir, b)).size;
        return sizeB - sizeA;
      });

      return jarCandidates[0];
    } catch (err) {
      console.error('JAR dosyası taranırken hata oluştu:', err);
      return null;
    }
  }

  /**
   * Imports a server from a zip file
   */
  async importZip(zipFilePath, customName = null, owner = null) {
    if (!fs.existsSync(zipFilePath)) {
      throw new Error(`ZIP dosyası bulunamadı: ${zipFilePath}`);
    }

    // Generate unique and strictly validated server ID
    const timestamp = Date.now().toString(36);
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const cleanSlug = customName
      ? String(customName).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)
      : '';
    const serverId = serverRegistry.validateServerId(
      cleanSlug ? `${cleanSlug}-${timestamp}` : `server-${timestamp}-${randomSuffix}`
    );

    const targetDir = serverRegistry.assertSafeServerDirectory(path.join(config.SERVERS_DIR, serverId), serverId);

    if (fs.existsSync(targetDir)) {
      throw new Error(`Hedef dizin zaten mevcut: ${targetDir}`);
    }

    fs.mkdirSync(targetDir, { recursive: true });

    try {
      // Validate and extract ZIP safely (Zip Slip and Zip Bomb protections)
      validateAndExtractZip(zipFilePath, targetDir);

      // Clean macOS and Windows metadata files
      const junkPatterns = ['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini'];
      for (const item of fs.readdirSync(targetDir)) {
        if (junkPatterns.includes(item)) {
          const itemPath = path.join(targetDir, item);
          try { fs.rmSync(itemPath, { recursive: true, force: true }); } catch (e) {}
        }
      }

      // Check if the zip contained a single wrapping directory (e.g. server-name/...)
      // Loop until flattened if deeply nested (bounded to max 5 levels, rejecting symlinks)
      const realTargetDir = fs.realpathSync(targetDir);
      let unwrapDepth = 0;
      let continueUnwrapping = true;
      while (continueUnwrapping && unwrapDepth < 5) {
        unwrapDepth++;
        const remaining = fs.readdirSync(targetDir, { withFileTypes: true })
          .filter((e) => !junkPatterns.includes(e.name));

        if (remaining.length === 1 && remaining[0].isDirectory() && !remaining[0].isSymbolicLink()) {
          const singleSubdir = path.join(targetDir, remaining[0].name);
          const realSubdir = fs.realpathSync(singleSubdir);
          const relSub = path.relative(realTargetDir, realSubdir);
          if (!relSub || relSub.startsWith('..') || path.isAbsolute(relSub)) {
            throw new Error('ZIP içindeki alt dizin hedef klasör sınırlarını aşıyor.');
          }
          const subFiles = fs.readdirSync(singleSubdir);
          for (const f of subFiles) {
            if (f === '.' || f === '..' || f.includes('/') || f.includes('\\')) continue;
            const src = path.join(singleSubdir, f);
            const dst = path.join(targetDir, f);
            fs.renameSync(src, dst);
          }
          try {
            fs.rmdirSync(singleSubdir);
          } catch (e) {}
        } else {
          continueUnwrapping = false;
        }
      }

      // Auto accept EULA atomically
      const eulaPath = path.join(targetDir, 'eula.txt');
      serverRegistry.atomicWriteFileSync(eulaPath, '# Generated by maziPanel\neula=true\n');

      // Detect and validate JAR file
      let jarFile = this.findMainJar(targetDir);
      if (!jarFile) {
        jarFile = 'server.jar'; // default placeholder
      }
      jarFile = serverRegistry.validateJarFile(jarFile);

      // Parse server.properties
      const propsPath = path.join(targetDir, 'server.properties');
      const properties = this.parseServerProperties(propsPath);
      const rawPort = parseInt(properties['server-port'] || properties['port'] || '25565', 10);
      const motd = properties['motd'] || customName || serverId;

      // Resolve port conflicts against existing servers and P2P Tunnel UDP port (25566)
      const usedPorts = new Set(
        serverRegistry.getAll().map((s) => parseInt(s.port, 10)).filter((p) => !isNaN(p) && p > 0)
      );
      usedPorts.add(25566);

      let serverPort = (!isNaN(rawPort) && rawPort >= 1024 && rawPort <= 65535) ? rawPort : 25565;
      while (usedPorts.has(serverPort)) {
        serverPort++;
        if (serverPort === 25566) serverPort++;
        if (serverPort > 65535) serverPort = 1024;
      }

      // Update server.properties atomically if port was changed or if server.properties exists
      if (fs.existsSync(propsPath) && serverPort !== rawPort) {
        try {
          let propsContent = fs.readFileSync(propsPath, 'utf8');
          const updateProp = (content, key, val) => {
            const regex = new RegExp(`^${key}\\s*=.*$`, 'm');
            return regex.test(content)
              ? content.replace(regex, `${key}=${val}`)
              : content.trimEnd() + `\n${key}=${val}\n`;
          };
          propsContent = updateProp(propsContent, 'server-port', serverPort);
          if (/^query\.port\s*=/m.test(propsContent)) {
            propsContent = updateProp(propsContent, 'query.port', serverPort);
          }
          serverRegistry.atomicWriteFileSync(propsPath, propsContent);
        } catch (e) {}
      }

      // Detect core type and Minecraft version from imported files if possible
      let detectedType = 'purpur';
      let detectedVersion = null;
      const lowerJar = (jarFile || '').toLowerCase();
      if (lowerJar.includes('paper')) detectedType = 'paper';
      else if (lowerJar.includes('vanilla') || lowerJar.includes('minecraft_server')) detectedType = 'vanilla';
      else if (lowerJar.includes('purpur')) detectedType = 'purpur';

      const jarVerMatch = (jarFile || '').match(/\b(1\.\d+(?:\.\d+)?)\b/);
      if (jarVerMatch) {
        detectedVersion = jarVerMatch[1];
      }

      if (!detectedVersion) {
        const versionHistoryPath = path.join(targetDir, 'version_history.json');
        if (fs.existsSync(versionHistoryPath)) {
          try {
            const vh = JSON.parse(fs.readFileSync(versionHistoryPath, 'utf8'));
            const vhMatch = String(vh.currentVersion || '').match(/\b(1\.\d+(?:\.\d+)?)\b/);
            if (vhMatch) detectedVersion = vhMatch[1];
          } catch (e) {}
        }
      }

      // Pick best Java version based on detected MC version, or default to Java 21
      let javaPath = null;
      try {
        const javaCompatibility = require('../system/javaCompatibility');
        if (detectedVersion) {
          const javaReq = javaCompatibility.getJavaRequirements(detectedType, detectedVersion);
          javaPath = javaDetector.getJavaForServer(null, {
            coreType: detectedType,
            version: detectedVersion,
            ...javaReq
          });
        }
      } catch (e) {}
      if (!javaPath) {
        javaPath = javaDetector.getJavaForServer(21);
      }

      const rawMaxPlayers = properties['max-players'] || properties['maxPlayers'];
      const serverMaxPlayers = rawMaxPlayers && !isNaN(parseInt(rawMaxPlayers, 10))
        ? parseInt(rawMaxPlayers, 10)
        : 10;

      const rawDisplayName = customName || properties['server-name'] || motd.replace(/§[0-9a-fk-or]/gi, '').trim() || serverId;
      const safeDisplayName = String(rawDisplayName).replace(/[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029\u0085]/g, ' ').trim() || serverId;

      // Register server in database
      const serverData = {
        id: serverId,
        name: safeDisplayName,
        owner: (owner && String(owner).trim().toLowerCase()) || null,
        directory: targetDir,
        jarFile,
        javaPath,
        port: serverPort,
        type: detectedType,
        version: detectedVersion || '1.20.4',
        maxPlayers: serverMaxPlayers,
        minRam: '2G',
        maxRam: '6G',
        jvmFlags: '-XX:+UseG1GC -XX:MaxGCPauseMillis=200',
        autoRestart: true,
        maxCrashRetries: 5,
        detectedProperties: {
          motd,
          onlineMode: properties['online-mode'],
          gamemode: properties['gamemode'],
          maxPlayers: String(serverMaxPlayers)
        }
      };

      const registered = serverRegistry.register(serverData);

      // Clean up uploaded zip
      try {
        fs.unlinkSync(zipFilePath);
      } catch (e) {}

      return {
        success: true,
        message: 'Sunucu ZIP arşivinden başarıyla içe aktarıldı.',
        server: registered
      };
    } catch (err) {
      // Cleanup targetDir on failure
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch (e) {}
      throw new Error(`Sunucu ZIP arşivinden içe aktarılamadı: ${err.message}`);
    }
  }
}

module.exports = new ZipImporter();
