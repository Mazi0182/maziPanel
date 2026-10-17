const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const serverRegistry = require('./serverRegistry');
const processManager = require('./processManager');

let p2pService = null;
try {
  p2pService = require('../p2p/p2pService');
} catch (e) {}

function computeOfflineUuid(playerName) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${playerName}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

class PlayerManager {
  _readJsonSafe(filePath, defaultVal = []) {
    if (!fs.existsSync(filePath)) return defaultVal;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return defaultVal;
    }
  }

  _extractSkinDataFromValue(skinDataObj) {
    if (!skinDataObj || typeof skinDataObj !== 'object' || !skinDataObj.value) {
      return null;
    }
    try {
      const decodedStr = Buffer.from(String(skinDataObj.value), 'base64').toString('utf8');
      const decoded = JSON.parse(decodedStr);
      const skinUrl = decoded?.textures?.SKIN?.url ? String(decoded.textures.SKIN.url).trim() : '';
      const hashMatch = skinUrl.match(/\/texture\/([0-9a-fA-F]{32,64})(?:$|[/?#])/);
      const textureHash = hashMatch ? hashMatch[1].toLowerCase() : '';
      const rawProfileId = String(skinDataObj.uniqueId || decoded?.profileId || '').trim();
      const skinUuid = rawProfileId.length === 32
        ? `${rawProfileId.slice(0, 8)}-${rawProfileId.slice(8, 12)}-${rawProfileId.slice(12, 16)}-${rawProfileId.slice(16, 20)}-${rawProfileId.slice(20, 32)}`
        : rawProfileId;
      const skinName = String(decoded?.profileName || skinDataObj.lastKnownName || skinDataObj.skinName || '').trim();
      return {
        textureHash,
        skinUrl,
        skinUuid,
        skinName
      };
    } catch (e) {
      return null;
    }
  }

  _resolveSkinsRestorerProfile(serverDir, playerName, playerUuid) {
    const cleanName = String(playerName || '').trim();
    const fallbackAvatar = `https://mc-heads.net/avatar/${encodeURIComponent(cleanName)}/64`;
    if (!serverDir || !cleanName) {
      return {
        avatarUrl: fallbackAvatar,
        skinTextureHash: '',
        skinUuid: '',
        skinName: cleanName,
        skinSource: 'default'
      };
    }

    const srDir = path.join(serverDir, 'plugins', 'SkinsRestorer');
    if (!fs.existsSync(srDir)) {
      return {
        avatarUrl: fallbackAvatar,
        skinTextureHash: '',
        skinUuid: '',
        skinName: cleanName,
        skinSource: 'default'
      };
    }

    const playersDir = path.join(srDir, 'players');
    const cacheDir = path.join(srDir, 'cache');
    const skinsDir = path.join(srDir, 'skins');

    const offlineUuid = computeOfflineUuid(cleanName);
    const candidatePlayerUuids = [];
    if (playerUuid) candidatePlayerUuids.push(String(playerUuid).trim().toLowerCase());
    if (offlineUuid && !candidatePlayerUuids.includes(offlineUuid)) candidatePlayerUuids.push(offlineUuid);

    let skinObj = null;

    // 1. Check players/<uuid>.player for explicit skinIdentifier (/skin set)
    if (fs.existsSync(playersDir)) {
      for (const pUuid of candidatePlayerUuids) {
        const playerFile = path.join(playersDir, `${pUuid}.player`);
        const pData = this._readJsonSafe(playerFile, null);
        if (pData && pData.skinIdentifier && pData.skinIdentifier.identifier) {
          const id = String(pData.skinIdentifier.identifier).trim();
          const type = String(pData.skinIdentifier.type || 'PLAYER').toUpperCase();
          const variant = String(pData.skinIdentifier.skinVariant || '').toUpperCase();

          if (fs.existsSync(skinsDir)) {
            const candidateFiles = [];
            if (type === 'PLAYER') {
              candidateFiles.push(path.join(skinsDir, `${id}.playerskin`));
            } else if (type === 'CUSTOM') {
              candidateFiles.push(path.join(skinsDir, `${id}.customskin`));
            } else if (type === 'LEGACY') {
              candidateFiles.push(path.join(skinsDir, `${id}.legacyskin`));
            } else if (type === 'URL') {
              if (variant) {
                candidateFiles.push(path.join(skinsDir, `${id}_${variant}.urlskin`));
              }
              candidateFiles.push(
                path.join(skinsDir, `${id}_CLASSIC.urlskin`),
                path.join(skinsDir, `${id}_SLIM.urlskin`),
                path.join(skinsDir, `${id}.urlskin`)
              );
            }
            candidateFiles.push(
              path.join(skinsDir, `${id}.playerskin`),
              path.join(skinsDir, `${id}.customskin`),
              path.join(skinsDir, `${id}.legacyskin`)
            );

            for (const cf of candidateFiles) {
              const sData = this._readJsonSafe(cf, null);
              if (sData && sData.value) {
                skinObj = sData;
                break;
              }
            }

            // Case-insensitive fallback scan in skins/ for customskin or playerskin matching identifier
            if (!skinObj) {
              try {
                const files = fs.readdirSync(skinsDir);
                const idLower = id.toLowerCase();
                for (const f of files) {
                  const fLower = f.toLowerCase();
                  if (
                    fLower === `${idLower}.playerskin` ||
                    fLower === `${idLower}.customskin` ||
                    fLower === `${idLower}.legacyskin` ||
                    fLower.startsWith(`${idLower}_`)
                  ) {
                    const sData = this._readJsonSafe(path.join(skinsDir, f), null);
                    if (sData && sData.value) {
                      skinObj = sData;
                      break;
                    }
                  }
                }
              } catch (e) {}
            }
          }

          // Also check recommendations.json if custom recommended skin was selected
          if (!skinObj) {
            const recFile = path.join(srDir, 'recommendations.json');
            const recData = this._readJsonSafe(recFile, null);
            if (recData && Array.isArray(recData.skins)) {
              const idLower = id.toLowerCase();
              const matchedRec = recData.skins.find(
                (r) =>
                  (r.skinId && String(r.skinId).toLowerCase() === idLower) ||
                  (r.skinName && String(r.skinName).toLowerCase() === idLower)
              );
              if (matchedRec && matchedRec.value) {
                skinObj = matchedRec;
              }
            }
          }
          if (skinObj) break;
        }
      }
    }

    // 2. Check cache/<PlayerName>.mojangcache -> skins/<uniqueId>.playerskin
    if (!skinObj && fs.existsSync(cacheDir) && fs.existsSync(skinsDir)) {
      let mojangCacheData = this._readJsonSafe(path.join(cacheDir, `${cleanName}.mojangcache`), null);
      if (!mojangCacheData) {
        try {
          const cacheFiles = fs.readdirSync(cacheDir);
          const targetLower = `${cleanName.toLowerCase()}.mojangcache`;
          const foundFile = cacheFiles.find((f) => f.toLowerCase() === targetLower);
          if (foundFile) {
            mojangCacheData = this._readJsonSafe(path.join(cacheDir, foundFile), null);
          }
        } catch (e) {}
      }
      if (mojangCacheData && mojangCacheData.uniqueId) {
        const mojangUuid = String(mojangCacheData.uniqueId).trim().toLowerCase();
        const sData = this._readJsonSafe(path.join(skinsDir, `${mojangUuid}.playerskin`), null);
        if (sData && sData.value) {
          skinObj = sData;
        }
      }
    }

    // 3. Scan skins/ directory for matching lastKnownName / skinName
    if (!skinObj && fs.existsSync(skinsDir)) {
      try {
        const files = fs.readdirSync(skinsDir);
        const nameLower = cleanName.toLowerCase();
        for (const f of files) {
          if (!f.endsWith('.playerskin') && !f.endsWith('.customskin') && !f.endsWith('.legacyskin')) continue;
          const sData = this._readJsonSafe(path.join(skinsDir, f), null);
          if (!sData || !sData.value) continue;
          const lastKnown = String(sData.lastKnownName || sData.skinName || '').trim().toLowerCase();
          if (lastKnown && lastKnown === nameLower) {
            skinObj = sData;
            break;
          }
        }
      } catch (e) {}
    }

    if (skinObj) {
      const extracted = this._extractSkinDataFromValue(skinObj);
      if (extracted && (extracted.textureHash || extracted.skinUuid)) {
        const avatarTarget = extracted.textureHash || extracted.skinUuid || encodeURIComponent(cleanName);
        return {
          avatarUrl: `https://mc-heads.net/avatar/${avatarTarget}/64`,
          skinTextureHash: extracted.textureHash || '',
          skinUuid: extracted.skinUuid || '',
          skinName: extracted.skinName || cleanName,
          skinSource: 'skinsrestorer'
        };
      }
    }

    return {
      avatarUrl: fallbackAvatar,
      skinTextureHash: '',
      skinUuid: '',
      skinName: cleanName,
      skinSource: 'default'
    };
  }

  _collectPlayerEndpoints(serverId, serverDir, statusEndpoints = {}) {
    const endpoints = {};
    if (statusEndpoints && typeof statusEndpoints === 'object') {
      for (const [k, v] of Object.entries(statusEndpoints)) {
        if (v && v.port) {
          endpoints[k.toLowerCase()] = v;
        }
      }
    }

    const parseLineForEndpoint = (rawLine) => {
      if (!rawLine || typeof rawLine !== 'string') return;
      const clean = rawLine.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
      const m = clean.match(/(?:INFO\]:?\s+|System chat:\s+)?([a-zA-Z0-9_]{3,16})\[\/([^\]:]+):(\d+)\]\s+(?:joined the game|logged in with entity id|logged in)/i);
      if (m) {
        const nameLower = m[1].toLowerCase();
        const ip = String(m[2] || '').replace(/^::ffff:/i, '').trim();
        const port = parseInt(m[3], 10);
        if (ip && !isNaN(port) && port > 0) {
          endpoints[nameLower] = { ip, port };
        }
      }
    };

    try {
      const ringLogs = processManager.getLogs(serverId, 500);
      if (Array.isArray(ringLogs)) {
        for (const item of ringLogs) {
          const text = typeof item === 'string' ? item : item?.text;
          parseLineForEndpoint(text);
        }
      }
    } catch (e) {}

    if (serverDir) {
      const latestLogPath = path.join(serverDir, 'logs', 'latest.log');
      if (fs.existsSync(latestLogPath)) {
        try {
          const stat = fs.statSync(latestLogPath);
          const maxBytes = 128 * 1024;
          let content = '';
          if (stat.size <= maxBytes) {
            content = fs.readFileSync(latestLogPath, 'utf8');
          } else {
            const fd = fs.openSync(latestLogPath, 'r');
            try {
              const buf = Buffer.alloc(maxBytes);
              fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
              content = buf.toString('utf8');
            } finally {
              fs.closeSync(fd);
            }
          }
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            parseLineForEndpoint(line);
          }
        } catch (e) {}
      }
    }

    return endpoints;
  }

  _buildPlayersList(serverId, p2pClients = []) {
    const status = processManager.getStatus(serverId);
    const onlineNames = status.onlinePlayers || [];
    const server = serverRegistry.getById(serverId);
    let usercache = [];
    let ops = [];
    let whitelist = [];
    const serverDir = server && server.directory ? server.directory : null;

    if (serverDir) {
      usercache = this._readJsonSafe(path.join(serverDir, 'usercache.json'), []);
      ops = this._readJsonSafe(path.join(serverDir, 'ops.json'), []);
      whitelist = this._readJsonSafe(path.join(serverDir, 'whitelist.json'), []);
    }

    const endpointsMap = this._collectPlayerEndpoints(serverId, serverDir, status.playerEndpoints);
    const activeP2PClients = Array.isArray(p2pClients)
      ? p2pClients.filter((c) => c && typeof c === 'object' && (Number(c.ping_ms ?? c.ping ?? 0) > 0 || Number(c.active_streams ?? c.streams ?? 0) > 0))
      : [];
    const usedPeerAddrs = new Set();

    return onlineNames.map((name, idx) => {
      const nameStr = String(name);
      const nameLower = nameStr.toLowerCase();
      const cached = usercache.find((u) => u.name && u.name.toLowerCase() === nameLower);
      const uuid = cached?.uuid || '';
      const isOp = ops.some((o) => (o.name && o.name.toLowerCase() === nameLower) || (uuid && o.uuid === uuid));
      const isWhitelisted = whitelist.some((w) => (w.name && w.name.toLowerCase() === nameLower) || (uuid && w.uuid === uuid));

      const skinProfile = this._resolveSkinsRestorerProfile(serverDir, nameStr, uuid);
      const endpoint = endpointsMap[nameLower] || null;
      const isLocalLoopback = !endpoint || endpoint.ip === '127.0.0.1' || endpoint.ip === 'localhost' || endpoint.ip === '::1';

      let resolvedPing = 1;
      let matchedClient = null;

      if (activeP2PClients.length > 0 && isLocalLoopback) {
        // 1. Exact TCP stream local port match
        if (endpoint && endpoint.port) {
          matchedClient = activeP2PClients.find(
            (c) => Array.isArray(c.local_ports) && c.local_ports.includes(Number(endpoint.port))
          );
        }

        // 2. Match by username/prefix among clients with active streams
        if (!matchedClient) {
          const streamClients = activeP2PClients.filter((c) => Number(c.active_streams ?? c.streams ?? 0) > 0);
          matchedClient = streamClients.find((c) => {
            const pUser = String(c.username || '').trim().toLowerCase();
            if (!pUser || pUser === 'bilinmeyen') return false;
            return pUser === nameLower || nameLower.startsWith(pUser) || pUser.startsWith(nameLower);
          });

          // 3. If single remaining unmatched active-stream client
          if (!matchedClient && streamClients.length > 0) {
            const unmatchedStreamClients = streamClients.filter((c) => !usedPeerAddrs.has(c.peer_addr || c.addr));
            if (unmatchedStreamClients.length === 1) {
              matchedClient = unmatchedStreamClients[0];
            } else if (unmatchedStreamClients.length > 1) {
              matchedClient = unmatchedStreamClients[0];
            }
          }
        }

        if (matchedClient) {
          if (matchedClient.peer_addr || matchedClient.addr) {
            usedPeerAddrs.add(matchedClient.peer_addr || matchedClient.addr);
          }
          const rawPing = Number(matchedClient.ping_ms ?? matchedClient.ping ?? 0);
          if (Number.isFinite(rawPing) && rawPing > 0) {
            resolvedPing = Math.max(1, Math.round(rawPing));
          }
        }
      }

      return {
        id: uuid || `player-${nameStr}-${idx}`,
        username: nameStr,
        name: nameStr,
        uuid,
        ping: resolvedPing,
        joinedAt: 'Aktif',
        isOp,
        isWhitelisted,
        avatarUrl: skinProfile.avatarUrl,
        skinName: skinProfile.skinName,
        skinUuid: skinProfile.skinUuid,
        skinTextureHash: skinProfile.skinTextureHash,
        skinSource: skinProfile.skinSource
      };
    });
  }

  getOnlinePlayers(serverId) {
    const cachedClients = p2pService && p2pService._clientsPingCache && Array.isArray(p2pService._clientsPingCache.clients)
      ? p2pService._clientsPingCache.clients
      : [];
    return this._buildPlayersList(serverId, cachedClients);
  }

  async getOnlinePlayersAsync(serverId) {
    let p2pClients = [];
    try {
      if (!p2pService) {
        p2pService = require('../p2p/p2pService');
      }
      if (p2pService && typeof p2pService.getActiveClientsFast === 'function') {
        p2pClients = await p2pService.getActiveClientsFast();
      }
    } catch (e) {}
    return this._buildPlayersList(serverId, p2pClients);
  }

  getPlayerLists(serverId) {
    const server = serverRegistry.getById(serverId);
    if (!server) {
      throw new Error(`"${serverId}" sunucusu bulunamadı.`);
    }

    const sDir = server.directory;
    const ops = this._readJsonSafe(path.join(sDir, 'ops.json'), []);
    const bannedPlayers = this._readJsonSafe(path.join(sDir, 'banned-players.json'), []);
    const bannedIps = this._readJsonSafe(path.join(sDir, 'banned-ips.json'), []);
    const whitelist = this._readJsonSafe(path.join(sDir, 'whitelist.json'), []);
    const usercache = this._readJsonSafe(path.join(sDir, 'usercache.json'), []);

    return {
      ops,
      bannedPlayers,
      bannedIps,
      whitelist,
      usercache: usercache.slice(0, 50)
    };
  }

  _validatePlayer(player) {
    if (!player || typeof player !== 'string') {
      throw new Error('Oyuncu adı veya UUID gereklidir.');
    }
    const trimmed = player.trim();
    const isValidUser = /^[a-zA-Z0-9_]{1,16}$/.test(trimmed);
    const isValidUuid = /^[0-9a-fA-F-]{32,36}$/.test(trimmed);
    if (!isValidUser && !isValidUuid) {
      throw new Error(`Geçersiz oyuncu adı veya UUID: "${trimmed}".`);
    }
    return trimmed;
  }

  _sanitizeReason(reason) {
    if (!reason || typeof reason !== 'string') return '';
    const clean = reason.replace(/[\r\n\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.slice(0, 200).trim();
  }

  kickPlayer(serverId, player, reason = '') {
    const validPlayer = this._validatePlayer(player);
    const cleanReason = this._sanitizeReason(reason);
    const cmd = cleanReason ? `kick ${validPlayer} ${cleanReason}` : `kick ${validPlayer}`;
    processManager.sendCommand(serverId, cmd);
    return { success: true, message: `"${validPlayer}" oyuncusu için sunucudan atma (kick) komutu gönderildi.` };
  }

  banPlayer(serverId, player, reason = '') {
    const validPlayer = this._validatePlayer(player);
    const cleanReason = this._sanitizeReason(reason);
    const cmd = cleanReason ? `ban ${validPlayer} ${cleanReason}` : `ban ${validPlayer}`;
    processManager.sendCommand(serverId, cmd);
    return { success: true, message: `"${validPlayer}" oyuncusu için yasaklama (ban) komutu gönderildi.` };
  }

  unbanPlayer(serverId, player) {
    const validPlayer = this._validatePlayer(player);
    const cmd = `pardon ${validPlayer}`;
    processManager.sendCommand(serverId, cmd);
    return { success: true, message: `"${validPlayer}" oyuncusunun yasağını kaldırma komutu gönderildi.` };
  }

  opPlayer(serverId, player) {
    const validPlayer = this._validatePlayer(player);
    const cmd = `op ${validPlayer}`;
    processManager.sendCommand(serverId, cmd);
    return { success: true, message: `"${validPlayer}" oyuncusuna operatör (OP) yetkisi verme komutu gönderildi.` };
  }

  deopPlayer(serverId, player) {
    const validPlayer = this._validatePlayer(player);
    const cmd = `deop ${validPlayer}`;
    processManager.sendCommand(serverId, cmd);
    return { success: true, message: `"${validPlayer}" oyuncusunun operatör (OP) yetkisini alma komutu gönderildi.` };
  }

  whitelistAdd(serverId, player) {
    const validPlayer = this._validatePlayer(player);
    const cmd = `whitelist add ${validPlayer}`;
    processManager.sendCommand(serverId, cmd);
    return { success: true, message: `"${validPlayer}" oyuncusu beyaz listeye (whitelist) eklendi.` };
  }

  whitelistRemove(serverId, player) {
    const validPlayer = this._validatePlayer(player);
    const cmd = `whitelist remove ${validPlayer}`;
    processManager.sendCommand(serverId, cmd);
    return { success: true, message: `"${validPlayer}" oyuncusu beyaz listeden (whitelist) çıkarıldı.` };
  }
}

module.exports = new PlayerManager();
