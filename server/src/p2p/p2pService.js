const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');

const DEFAULT_CONFIG = {
  server_name: 'P2P Sunucusu',
  server_key: '0000-0000',
  game_port: 25565,
  connection_address: 'baglanti.localhost',
  server_udp_port: 25566,
  web_port: 9090,
  player_token: '',
  admin_secret: '',
  room_secret: ''
};

function normalizeServerKey(key) {
  let val = String(key || '').trim().toUpperCase();
  if (val.startsWith('MC-')) {
    val = val.slice(3);
  }
  const clean = val.replace(/[^A-Z0-9]/g, '');
  if (clean.length === 8) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
  }
  return val || '0000-0000';
}

function generateServerKey() {
  const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

function deriveCredentialsFromKey(key) {
  let clean = String(key || '').trim().replace(/[-\s]/g, '').toUpperCase();
  if (clean.startsWith('MC') && clean.length === 10) {
    clean = clean.slice(2);
  }
  const hash = crypto.createHash('sha256').update(`P2P_MC_KEY_MC${clean}`, 'utf8').digest('hex');
  return {
    roomId: `p2pmc_${hash.slice(0, 16)}`,
    roomSecret: `SEC_${hash.slice(16, 40)}`,
    playerToken: `TOK_${hash.slice(40, 56)}`
  };
}

function formatPublicEndpoint(raw) {
  if (!raw) return '';
  if (Array.isArray(raw)) {
    if (raw.length >= 2 && raw[0] && raw[1] !== undefined && raw[1] !== null && raw[1] !== '') {
      return `${String(raw[0]).trim()}:${String(raw[1]).trim()}`;
    }
    return raw[0] ? String(raw[0]).trim() : '';
  }
  if (typeof raw === 'object') {
    const host = raw.ip || raw.host || raw.address || raw[0];
    const port = raw.port ?? raw[1];
    if (host && port !== undefined && port !== null && port !== '') {
      return `${String(host).trim()}:${String(port).trim()}`;
    }
    return host ? String(host).trim() : '';
  }
  const str = String(raw).trim();
  if (!str) return '';

  // Tuple/list string e.g. "('212.253.195.146', 13141)" or "['212.253.195.146', 13141]"
  const tupleMatch = str.match(/^[\(\[]\s*['"]?([0-9a-zA-Z.\-]+)['"]?\s*,\s*['"]?(\d{1,5})['"]?\s*[\)\]]$/);
  if (tupleMatch) {
    return `${tupleMatch[1]}:${tupleMatch[2]}`;
  }

  // Comma-separated "212.253.195.146,13141"
  const commaMatch = str.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*,\s*(\d{1,5})$/);
  if (commaMatch) {
    return `${commaMatch[1]}:${commaMatch[2]}`;
  }

  // Valid IPv4:Port
  if (/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.test(str)) {
    return str;
  }

  // Concatenated IPv4+Port without colon e.g. "212.253.195.14613141"
  const concatMatch = str.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.)(\d{4,8})$/);
  if (concatMatch) {
    const prefix = concatMatch[1];
    const tail = concatMatch[2];
    for (const octLen of [3, 2, 1]) {
      if (tail.length > octLen) {
        const octet = Number(tail.slice(0, octLen));
        const port = Number(tail.slice(octLen));
        if (octet >= 0 && octet <= 255 && port >= 1 && port <= 65535) {
          return `${prefix}${octet}:${port}`;
        }
      }
    }
  }

  return str;
}

function normalizeClientEntry(c) {
  if (!c || typeof c !== 'object') return {};
  const addr = c.addr || c.peer_addr || (c.ip && c.port ? `${c.ip}:${c.port}` : c.ip || '');
  const hostname = c.hostname || c.computer_name || '-';
  const ping = Number(c.ping ?? c.ping_ms ?? 0);
  const streams = Number(c.streams ?? c.active_streams ?? 0);
  const rx = Number(c.rx ?? c.bytes_received ?? 0);
  const tx = Number(c.tx ?? c.bytes_sent ?? 0);
  const duration = Number(c.duration ?? c.duration_seconds ?? 0);
  const rawHwid = String(c.hwid || '').trim();
  const hwid = rawHwid && rawHwid !== 'N/A' ? rawHwid : '';
  const localPorts = Array.isArray(c.local_ports)
    ? c.local_ports.map((p) => Number(p)).filter((p) => Number.isFinite(p) && p > 0)
    : [];
  return {
    ...c,
    addr,
    peer_addr: c.peer_addr || addr,
    hostname,
    computer_name: c.computer_name || hostname,
    username: c.username || 'Bilinmeyen',
    role: c.role || 'PLAYER',
    os: c.os || 'Bilinmiyor',
    hwid,
    hwid_details: c.hwid_details || {},
    ping,
    ping_ms: ping,
    streams,
    active_streams: streams,
    local_ports: localPorts,
    rx,
    bytes_received: rx,
    tx,
    bytes_sent: tx,
    duration,
    duration_seconds: duration
  };
}

function normalizeBanEntry(b) {
  if (!b || typeof b !== 'object') return {};
  const hwid = String(b.hwid || b.id || '').trim().toUpperCase();
  return {
    ...b,
    id: b.id || hwid,
    hwid,
    username: b.username || 'Bilinmeyen',
    reason: b.reason || 'Yönetici tarafından yasaklandı.',
    banned_at: b.banned_at || '-'
  };
}

function normalizeSessionEntry(h, idx = 0) {
  if (!h || typeof h !== 'object') return {};
  const rawHwid = String(h.hwid || '').trim();
  const hwid = rawHwid && rawHwid !== 'N/A' ? rawHwid : '';
  const addr = h.addr || h.peer_addr || (h.ip && h.port ? `${h.ip}:${h.port}` : h.ip || '-');
  const hostname = h.hostname || h.computer_name || '-';
  const active = Boolean(h.active ?? h.is_online);
  const firstSeen = h.joined_at || h.first_seen || '-';
  const lastSeen = h.left_at || h.last_seen || null;
  return {
    ...h,
    id: h.id || h.key || hwid || `${h.username || 'session'}-${idx}`,
    key: h.key || h.id || hwid || `${h.username || 'session'}-${idx}`,
    addr,
    peer_addr: h.peer_addr || addr,
    ip: h.ip || (addr !== '-' ? String(addr).split(':')[0] : '-'),
    hostname,
    computer_name: h.computer_name || hostname,
    username: h.username || 'Bilinmeyen',
    hwid,
    hwid_details: h.hwid_details || {},
    os: h.os || 'Bilinmiyor',
    version: h.version || '-',
    active,
    is_online: active,
    joined_at: firstSeen,
    first_seen: firstSeen,
    left_at: lastSeen,
    last_seen: lastSeen || '-',
    login_count: Number(h.login_count || 1),
    is_banned: Boolean(h.is_banned),
    duration: Number(h.duration || 0),
    rx: Number(h.rx || 0),
    tx: Number(h.tx || 0)
  };
}

class P2PService {
  constructor() {
    this._sessionCookie = null;
    this._lastAdminSecret = null;
    this._clientsPingCache = { timestamp: 0, clients: [] };
  }

  _getCandidateConfigPaths() {
    const candidates = [];
    if (process.env.P2P_CONFIG_PATH) {
      candidates.push(path.resolve(process.env.P2P_CONFIG_PATH));
    }
    if (process.env.P2P_CONFIG_DIR) {
      candidates.push(path.join(path.resolve(process.env.P2P_CONFIG_DIR), 'server_config.json'));
    }
    candidates.push(
      '/home/mazidev/p2ptunnel/config/server_config.json',
      '/etc/p2ptunnel/server_config.json',
      path.join(os.homedir(), '.config', 'p2ptunnel', 'server_config.json'),
      path.join(os.homedir(), '.p2ptunnel', 'server_config.json'),
      'C:\\ProgramData\\P2PTunnel\\server_config.json',
      path.resolve(__dirname, '../../../../P2P/config/server_config.json')
    );
    return candidates;
  }

  resolveConfigPath(forWrite = false) {
    const candidates = this._getCandidateConfigPaths();
    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          return p;
        }
      } catch (e) {}
    }

    if (!forWrite) {
      const examplePaths = [
        '/home/mazidev/p2ptunnel/config/server_config.json.example',
        path.resolve(__dirname, '../../../../P2P/config/server_config.json.example')
      ];
      for (const ep of examplePaths) {
        try {
          if (fs.existsSync(ep) && fs.statSync(ep).isFile()) {
            return ep;
          }
        } catch (e) {}
      }
    }

    if (process.env.P2P_CONFIG_PATH) {
      return path.resolve(process.env.P2P_CONFIG_PATH);
    }
    if (process.platform === 'win32') {
      const localSiblingDir = path.resolve(__dirname, '../../../../P2P/config');
      if (fs.existsSync(localSiblingDir)) {
        return path.join(localSiblingDir, 'server_config.json');
      }
      return 'C:\\ProgramData\\P2PTunnel\\server_config.json';
    }
    if (fs.existsSync('/home/mazidev/p2ptunnel')) {
      return '/home/mazidev/p2ptunnel/config/server_config.json';
    }
    return '/etc/p2ptunnel/server_config.json';
  }

  _getCandidateDataDirs() {
    const dirs = new Set();
    const cfgPath = this.resolveConfigPath(false);
    if (cfgPath) {
      dirs.add(path.dirname(cfgPath));
    }
    if (process.env.P2P_CONFIG_DIR) {
      dirs.add(path.resolve(process.env.P2P_CONFIG_DIR));
    }
    dirs.add('/home/mazidev/p2ptunnel/config');
    dirs.add('/home/mazidev/p2ptunnel');
    dirs.add('/etc/p2ptunnel');
    dirs.add('/var/lib/p2ptunnel');
    dirs.add(path.join(os.homedir(), '.config', 'p2ptunnel'));
    dirs.add(path.join(os.homedir(), '.p2ptunnel'));
    dirs.add('C:\\ProgramData\\P2PTunnel');
    dirs.add(path.resolve(__dirname, '../../../../P2P/config'));
    return Array.from(dirs);
  }

  readLocalConfig() {
    const cfgPath = this.resolveConfigPath(false);
    let raw = {};
    if (cfgPath && fs.existsSync(cfgPath)) {
      try {
        raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch (e) {
        raw = {};
      }
    }
    const merged = { ...DEFAULT_CONFIG, ...raw };
    merged.server_key = normalizeServerKey(merged.server_key);
    merged.game_port = parseInt(merged.game_port, 10) || 25565;
    merged.server_udp_port = parseInt(merged.server_udp_port || merged.udp_port, 10) || 25566;
    merged.web_port = parseInt(merged.web_port, 10) || 9090;
    return { config: merged, configPath: cfgPath };
  }

  writeLocalConfig(updates = {}) {
    const { config: current } = this.readLocalConfig();
    const targetPath = this.resolveConfigPath(true);

    const next = { ...current };
    if (updates.server_name !== undefined && String(updates.server_name).trim()) {
      next.server_name = String(updates.server_name).trim();
    }
    if (updates.server_key !== undefined && String(updates.server_key).trim()) {
      const normKey = normalizeServerKey(updates.server_key);
      next.server_key = normKey;
      const derived = deriveCredentialsFromKey(normKey);
      next.room_secret = derived.roomSecret;
      next.player_token = derived.playerToken;
    }
    if (updates.game_port !== undefined) {
      const gp = parseInt(updates.game_port, 10);
      if (!isNaN(gp) && gp >= 1 && gp <= 65535) {
        next.game_port = gp;
      }
    }
    if (updates.connection_address !== undefined && String(updates.connection_address).trim()) {
      let addr = String(updates.connection_address).trim().toLowerCase();
      if (addr !== '127.0.0.1' && addr !== 'localhost' && !addr.endsWith('.localhost')) {
        addr = `${addr}.localhost`;
      }
      next.connection_address = addr;
    }
    if (updates.admin_secret !== undefined && String(updates.admin_secret).trim()) {
      next.admin_secret = String(updates.admin_secret).trim();
    }

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${targetPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmpPath, targetPath);
    return next;
  }

  readLocalBans() {
    const dirs = this._getCandidateDataDirs();
    const filenames = ['bans.json', 'banned_clients.json'];
    for (const dir of dirs) {
      for (const fname of filenames) {
        const p = path.join(dir, fname);
        if (fs.existsSync(p)) {
          try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            let list = [];
            if (Array.isArray(data)) {
              list = data;
            } else if (data && typeof data === 'object') {
              list = Object.entries(data).map(([k, v]) => {
                if (v && typeof v === 'object') {
                  return { id: v.id || k, hwid: v.hwid || k, ...v };
                }
                return { id: k, hwid: k, reason: String(v || '') };
              });
            }
            list.sort((a, b) => String(b.banned_at || '').localeCompare(String(a.banned_at || '')));
            return { bans: list, filePath: p };
          } catch (e) {}
        }
      }
    }
    const defaultDir = path.dirname(this.resolveConfigPath(true));
    return { bans: [], filePath: path.join(defaultDir, 'bans.json') };
  }

  readLocalHistory() {
    const dirs = this._getCandidateDataDirs();
    const filenames = ['client_history.json', 'connection_history.json'];
    for (const dir of dirs) {
      for (const fname of filenames) {
        const p = path.join(dir, fname);
        if (fs.existsSync(p)) {
          try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            let list = [];
            if (Array.isArray(data)) {
              list = data;
            } else if (data && typeof data === 'object') {
              list = Object.entries(data).map(([k, v]) => (v && typeof v === 'object' ? { key: k, ...v } : { key: k }));
            }
            list.sort((a, b) => (Number(b.last_seen_ts || 0) - Number(a.last_seen_ts || 0)));
            return { history: list, filePath: p };
          } catch (e) {}
        }
      }
    }
    const defaultDir = path.dirname(this.resolveConfigPath(true));
    return { history: [], filePath: path.join(defaultDir, 'client_history.json') };
  }

  readLocalLogs(limit = 200) {
    const dirs = this._getCandidateDataDirs();
    for (const dir of dirs) {
      const p = path.join(dir, 'server.log');
      if (fs.existsSync(p)) {
        try {
          const stat = fs.statSync(p);
          if (stat.size === 0) continue;
          const readSize = Math.min(stat.size, 128 * 1024);
          const fd = fs.openSync(p, 'r');
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
          fs.closeSync(fd);
          const lines = buf.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          return lines.slice(-limit);
        } catch (e) {}
      }
    }
    return [];
  }

  _rawRequest(method, endpoint, bodyObj = null, headers = {}, timeoutMs = 3500) {
    const { config } = this.readLocalConfig();
    const port = config.web_port || 9090;
    const payload = bodyObj !== null ? JSON.stringify(bodyObj) : null;

    return new Promise((resolve, reject) => {
      const reqHeaders = {
        Accept: 'application/json',
        ...headers
      };
      if (payload !== null) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: endpoint,
          method,
          headers: reqHeaders,
          timeout: timeoutMs
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const rawText = Buffer.concat(chunks).toString('utf8');
            let data = null;
            try {
              data = rawText ? JSON.parse(rawText) : {};
            } catch (e) {
              data = { raw: rawText };
            }
            resolve({
              statusCode: res.statusCode || 500,
              headers: res.headers || {},
              data
            });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('P2P daemon request timed out'));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload !== null) {
        req.write(payload);
      }
      req.end();
    });
  }

  async _ensureSession(adminSecret, forceLogin = false) {
    if (!forceLogin && this._sessionCookie && this._lastAdminSecret === adminSecret) {
      return this._sessionCookie;
    }
    if (!adminSecret) return null;

    try {
      const loginRes = await this._rawRequest('POST', '/api/login', { password: adminSecret }, {
        'X-P2P-Admin-Secret': adminSecret
      });
      if (loginRes.statusCode === 200) {
        const setCookie = loginRes.headers['set-cookie'];
        if (Array.isArray(setCookie)) {
          for (const c of setCookie) {
            const m = String(c).match(/p2p_session=([^;]+)/);
            if (m) {
              this._sessionCookie = m[1].trim();
              this._lastAdminSecret = adminSecret;
              return this._sessionCookie;
            }
          }
        } else if (typeof setCookie === 'string') {
          const m = setCookie.match(/p2p_session=([^;]+)/);
          if (m) {
            this._sessionCookie = m[1].trim();
            this._lastAdminSecret = adminSecret;
            return this._sessionCookie;
          }
        }
        if (loginRes.data && loginRes.data.token) {
          this._sessionCookie = String(loginRes.data.token).trim();
          this._lastAdminSecret = adminSecret;
          return this._sessionCookie;
        }
      }
    } catch (e) {}
    return null;
  }

  async daemonRequest(method, endpoint, bodyObj = null, secretOverride = null) {
    const { config } = this.readLocalConfig();
    const adminSecret = secretOverride !== null && secretOverride !== undefined ? String(secretOverride) : (config.admin_secret || '');

    const buildHeaders = (sessionToken, secretVal) => {
      const h = {};
      if (secretVal) {
        h['X-P2P-Admin-Secret'] = secretVal;
      }
      if (sessionToken) {
        h.Cookie = `p2p_session=${sessionToken}`;
        h.Authorization = sessionToken;
      }
      return h;
    };

    let token = await this._ensureSession(adminSecret, false);
    let res = await this._rawRequest(method, endpoint, bodyObj, buildHeaders(token, adminSecret));

    if (res.statusCode === 401 && adminSecret) {
      token = await this._ensureSession(adminSecret, true);
      res = await this._rawRequest(method, endpoint, bodyObj, buildHeaders(token, adminSecret));
    }

    return res;
  }

  _checkPortOpen(port, host = '127.0.0.1', timeoutMs = 300) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let settled = false;
      const done = (open) => {
        if (!settled) {
          settled = true;
          try { sock.destroy(); } catch (e) {}
          resolve(open);
        }
      };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
      sock.connect(port, host);
    });
  }

  _getStopFlagPath() {
    const cfgPath = this.resolveConfigPath(true);
    return path.join(path.dirname(cfgPath), '.stopped_by_panel');
  }

  _isStoppedByPanel() {
    try {
      return fs.existsSync(this._getStopFlagPath());
    } catch (e) {
      return false;
    }
  }

  _setStoppedByPanel(stopped) {
    const flagPath = this._getStopFlagPath();
    try {
      if (stopped) {
        const dir = path.dirname(flagPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(flagPath, String(Date.now()), 'utf8');
      } else if (fs.existsSync(flagPath)) {
        fs.unlinkSync(flagPath);
      }
    } catch (e) {}
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getServiceStateSync() {
    if (this._isStoppedByPanel()) {
      return 'inactive';
    }
    if (process.platform !== 'linux') {
      return 'unknown';
    }
    try {
      const res = spawnSync('systemctl', ['is-active', 'p2ptunnel.service'], {
        encoding: 'utf8',
        timeout: 2500,
        shell: false
      });
      const out = ((res.stdout || '') + (res.stderr || '')).trim().toLowerCase();
      if (out === 'active' || out === 'activating' || out === 'inactive' || out === 'failed') {
        return out;
      }
      return res.status === 0 ? 'active' : 'inactive';
    } catch (e) {
      return 'unknown';
    }
  }

  async getServiceStatus() {
    let serviceState = this.getServiceStateSync();
    let daemonOnline = false;
    try {
      let res = await this.daemonRequest('GET', '/api/status');
      if ((!res || res.statusCode !== 200) && serviceState === 'active') {
        await this._sleep(120);
        res = await this.daemonRequest('GET', '/api/status');
      }
      if (res && res.statusCode === 200) {
        daemonOnline = true;
        this._lastOnlineTimestamp = Date.now();
        if (serviceState !== 'active') {
          serviceState = 'active';
        }
      } else if (
        serviceState === 'active' &&
        this._lastOnlineTimestamp &&
        Date.now() - this._lastOnlineTimestamp < 8000
      ) {
        daemonOnline = true;
      }
    } catch (e) {
      daemonOnline = serviceState === 'active' && Boolean(this._lastOnlineTimestamp && Date.now() - this._lastOnlineTimestamp < 8000);
    }
    return { daemonOnline, serviceState };
  }

  _execCmd(cmd, args, timeout = 8000) {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          err,
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim()
        });
      });
    });
  }

  async controlService(action) {
    const cleanAction = String(action || '').trim().toLowerCase();
    if (!['start', 'stop', 'restart'].includes(cleanAction)) {
      throw new Error(`Geçersiz servis komutu: ${action}`);
    }

    if (process.platform !== 'linux') {
      throw new Error('Systemd servis kontrolü yalnızca Linux sunucuda desteklenir.');
    }

    const { config } = this.readLocalConfig();
    const webPort = config.web_port || 9090;

    if (cleanAction === 'stop') {
      this._setStoppedByPanel(true);
      this._lastOnlineTimestamp = 0;

      let sysRes = await this._execCmd('sudo', ['-n', 'systemctl', 'stop', 'p2ptunnel.service']);
      if (!sysRes.ok) {
        sysRes = await this._execCmd('systemctl', ['stop', 'p2ptunnel.service']);
      }
      if (!sysRes.ok) {
        // p2ptunnel.service runs as User=mazidev; terminating run_server.py while .stopped_by_panel is set keeps it in standby
        await this._execCmd('pkill', ['-TERM', '-f', 'run_server.py'], 5000);
      }

      for (let i = 0; i < 12; i++) {
        const open = await this._checkPortOpen(webPort, '127.0.0.1', 200);
        if (!open) break;
        await this._sleep(200);
      }

      return {
        success: true,
        action: 'stop',
        message: 'P2P Tünel servisi durduruldu.'
      };
    }

    if (cleanAction === 'start') {
      this._setStoppedByPanel(false);

      let sysRes = await this._execCmd('sudo', ['-n', 'systemctl', 'start', 'p2ptunnel.service']);
      if (!sysRes.ok) {
        await this._execCmd('systemctl', ['start', 'p2ptunnel.service']);
      }

      for (let i = 0; i < 22; i++) {
        const open = await this._checkPortOpen(webPort, '127.0.0.1', 250);
        if (open) {
          await this._sleep(150);
          break;
        }
        await this._sleep(300);
      }

      return {
        success: true,
        action: 'start',
        message: 'P2P Tünel servisi başlatıldı.'
      };
    }

    if (cleanAction === 'restart') {
      this._setStoppedByPanel(false);

      let sysRes = await this._execCmd('sudo', ['-n', 'systemctl', 'restart', 'p2ptunnel.service']);
      if (!sysRes.ok) {
        sysRes = await this._execCmd('systemctl', ['restart', 'p2ptunnel.service']);
      }
      if (!sysRes.ok) {
        // p2ptunnel.service runs as User=mazidev with Restart=always; sending SIGTERM triggers systemd restart without root
        await this._execCmd('pkill', ['-TERM', '-f', 'run_server.py'], 5000);
      }

      // Wait briefly for old daemon socket to close, then poll until new daemon socket comes back online
      await this._sleep(400);
      for (let i = 0; i < 22; i++) {
        const open = await this._checkPortOpen(webPort, '127.0.0.1', 250);
        if (open) {
          await this._sleep(150);
          break;
        }
        await this._sleep(300);
      }

      return {
        success: true,
        action: 'restart',
        message: 'P2P Tünel servisi yeniden başlatıldı.'
      };
    }
  }

  async getOverview() {
    const { config: localCfg, configPath } = this.readLocalConfig();
    const stoppedByPanel = this._isStoppedByPanel();
    let serviceState = this.getServiceStateSync();
    let daemonOnline = false;
    let statusData = {};
    let clientsList = null;
    let bansList = null;
    let historyList = null;
    let logsList = null;
    let settingsData = {};

    if (!stoppedByPanel) {
      try {
        let statusRes = await this.daemonRequest('GET', '/api/status');
        if ((!statusRes || statusRes.statusCode !== 200) && serviceState === 'active') {
          await this._sleep(120);
          statusRes = await this.daemonRequest('GET', '/api/status');
        }
        if (statusRes && statusRes.statusCode === 200 && statusRes.data && typeof statusRes.data === 'object') {
          daemonOnline = true;
          this._lastOnlineTimestamp = Date.now();
          this._lastStatusData = statusRes.data;
          serviceState = 'active';
          statusData = statusRes.data;

          if (Array.isArray(statusData.clients)) clientsList = statusData.clients;
          if (Array.isArray(statusData.bans)) bansList = statusData.bans;
          if (Array.isArray(statusData.history)) historyList = statusData.history;
          if (Array.isArray(statusData.logs)) logsList = statusData.logs;

          const tasks = [];
          if (clientsList === null || historyList === null) {
            tasks.push(
              this.daemonRequest('GET', '/api/clients')
                .then((r) => {
                  if (r.statusCode === 200 && r.data) {
                    if (clientsList === null && Array.isArray(r.data.clients)) clientsList = r.data.clients;
                    if (historyList === null && Array.isArray(r.data.history)) historyList = r.data.history;
                  }
                })
                .catch(() => {})
            );
          }
          if (bansList === null) {
            tasks.push(
              this.daemonRequest('GET', '/api/bans')
                .then((r) => {
                  if (r.statusCode === 200 && r.data && Array.isArray(r.data.bans)) {
                    bansList = r.data.bans;
                  }
                })
                .catch(() => {})
            );
          }
          if (logsList === null) {
            tasks.push(
              this.daemonRequest('GET', '/api/logs')
                .then((r) => {
                  if (r.statusCode === 200 && r.data && Array.isArray(r.data.logs)) {
                    logsList = r.data.logs;
                  }
                })
                .catch(() => {})
            );
          }
          tasks.push(
            this.daemonRequest('GET', '/api/settings')
              .then((r) => {
                if (r.statusCode === 200 && r.data && typeof r.data === 'object') {
                  settingsData = r.data;
                }
              })
              .catch(() => {})
          );

          await Promise.all(tasks);
        } else if (
          serviceState === 'active' &&
          this._lastOnlineTimestamp &&
          Date.now() - this._lastOnlineTimestamp < 8000
        ) {
          daemonOnline = true;
          statusData = this._lastStatusData || {};
        }
      } catch (e) {
        if (
          serviceState === 'active' &&
          this._lastOnlineTimestamp &&
          Date.now() - this._lastOnlineTimestamp < 8000
        ) {
          daemonOnline = true;
          statusData = this._lastStatusData || {};
        } else {
          daemonOnline = false;
        }
      }
    }

    if (clientsList === null) clientsList = [];
    if (bansList === null) bansList = this.readLocalBans().bans;
    if (historyList === null) historyList = this.readLocalHistory().history;
    if (logsList === null) logsList = this.readLocalLogs(250);

    const normalizedClients = Array.isArray(clientsList) ? clientsList.map((c) => normalizeClientEntry(c)) : [];
    if (daemonOnline) {
      this._clientsPingCache = { timestamp: Date.now(), clients: normalizedClients };
    }
    const normalizedBans = Array.isArray(bansList) ? bansList.map((b) => normalizeBanEntry(b)) : [];
    const normalizedHistory = Array.isArray(historyList) ? historyList.map((h, i) => normalizeSessionEntry(h, i)) : [];

    const serverName = statusData.server_name || settingsData.server_name || localCfg.server_name || 'P2P Sunucusu';
    const serverKey = normalizeServerKey(statusData.server_key || settingsData.server_key || localCfg.server_key || '0000-0000');
    const gamePort = parseInt(statusData.game_port || settingsData.game_port || localCfg.game_port || 25565, 10);
    const connectionAddress = statusData.connection_address || settingsData.connection_address || localCfg.connection_address || 'baglanti.localhost';
    const adminSecret = settingsData.admin_secret || localCfg.admin_secret || '';
    const udpPort = parseInt(statusData.udp_port || localCfg.server_udp_port || 25566, 10);
    const webPort = parseInt(statusData.web_port || settingsData.web_port || localCfg.web_port || 9090, 10);
    const publicEndpoint = formatPublicEndpoint(statusData.public_endpoint ?? statusData.publicEndpoint) || '';
    const uptime = daemonOnline ? Number(statusData.uptime ?? statusData.server_uptime ?? 0) : 0;
    const connectedClients = daemonOnline ? Number(statusData.connected_clients ?? normalizedClients.length ?? 0) : 0;
    const activeStreams = daemonOnline ? Number(statusData.active_streams ?? 0) : 0;
    const totalRx = Number(statusData.total_rx ?? statusData.total_rx_bytes ?? 0);
    const totalTx = Number(statusData.total_tx ?? statusData.total_tx_bytes ?? 0);
    const speedRx = daemonOnline ? Number(statusData.speed_rx ?? statusData.rx_speed_bps ?? 0) : 0;
    const speedTx = daemonOnline ? Number(statusData.speed_tx ?? statusData.tx_speed_bps ?? 0) : 0;
    const requiredVersion = String(statusData.required_client_version || settingsData.required_client_version || statusData.requiredVersion || '3.0');

    let gamePortActive = Boolean(statusData.game_port_active);
    if (!daemonOnline) {
      gamePortActive = await this._checkPortOpen(gamePort);
    }

    const effectiveServiceState = stoppedByPanel
      ? 'inactive'
      : daemonOnline
      ? 'active'
      : serviceState === 'active'
      ? 'inactive'
      : serviceState;

    const systemdActive = !stoppedByPanel && Boolean(daemonOnline || effectiveServiceState === 'active' || effectiveServiceState === 'activating');

    const configObj = {
      server_name: serverName,
      server_key: serverKey,
      game_port: gamePort,
      connection_address: connectionAddress,
      admin_secret: adminSecret,
      udp_port: udpPort,
      web_port: webPort
    };

    return {
      installed: true,
      running: daemonOnline,
      daemonOnline,
      systemdActive,
      serviceState: effectiveServiceState,
      configPath,
      config: configObj,
      serverName,
      server_name: serverName,
      serverKey,
      server_key: serverKey,
      gamePort,
      game_port: gamePort,
      gamePortActive,
      game_port_active: gamePortActive,
      connectionAddress,
      connection_address: connectionAddress,
      adminSecret,
      admin_secret: adminSecret,
      udpPort,
      udp_port: udpPort,
      webPort,
      web_port: webPort,
      publicEndpoint,
      public_endpoint: publicEndpoint,
      uptime,
      server_uptime: uptime,
      connectedClients,
      connected_clients: connectedClients,
      activeStreams,
      active_streams: activeStreams,
      totalRx,
      total_rx: totalRx,
      total_rx_bytes: totalRx,
      totalTx,
      total_tx: totalTx,
      total_tx_bytes: totalTx,
      speedRx,
      speed_rx: speedRx,
      rx_speed_bps: speedRx,
      speedTx,
      speed_tx: speedTx,
      tx_speed_bps: speedTx,
      cpuPercent: Number(statusData.cpu_percent || 0),
      ramPercent: Number(statusData.ram_percent || 0),
      ramUsedMb: Number(statusData.ram_used_mb || 0),
      ramTotalMb: Number(statusData.ram_total_mb || 0),
      requiredVersion,
      required_client_version: requiredVersion,
      clients: normalizedClients,
      bans: normalizedBans,
      history: normalizedHistory,
      sessions: normalizedHistory,
      logs: logsList
    };
  }

  async getActiveClientsFast() {
    if (this._isStoppedByPanel()) {
      return [];
    }
    const now = Date.now();
    if (this._clientsPingCache && now - this._clientsPingCache.timestamp < 2000 && Array.isArray(this._clientsPingCache.clients)) {
      return this._clientsPingCache.clients;
    }
    try {
      const res = await this.daemonRequest('GET', '/api/clients');
      if (res && res.statusCode === 200 && res.data && Array.isArray(res.data.clients)) {
        const normalized = res.data.clients.map((c) => normalizeClientEntry(c));
        this._clientsPingCache = { timestamp: Date.now(), clients: normalized };
        return normalized;
      }
    } catch (e) {}
    return Array.isArray(this._clientsPingCache?.clients) ? this._clientsPingCache.clients : [];
  }

  async kickClient(payload = {}) {
    const peerAddr = payload.peer_addr || payload.addr || payload.peer_id || '';
    const hwid = payload.hwid || '';
    const res = await this.daemonRequest('POST', '/api/kick', {
      peer_addr: peerAddr,
      addr: peerAddr,
      peer_id: peerAddr,
      hwid
    });
    if (res.statusCode >= 400) {
      throw new Error((res.data && (res.data.message || res.data.error)) || 'İstemci bağlantısı kesilemedi.');
    }
    return res.data;
  }

  async banClient(payload = {}) {
    const hwid = String(payload.hwid || '').trim().toUpperCase();
    const reason = String(payload.reason || 'Yönetici tarafından yasaklandı').trim();
    const username = String(payload.username || 'Bilinmeyen').trim();
    const peerAddr = String(payload.peer_addr || payload.addr || payload.peer_id || '').trim();
    const hwidDetails = payload.hwid_details || {};

    if (!hwid) {
      throw new Error('HWID boş olamaz.');
    }

    try {
      const res = await this.daemonRequest('POST', '/api/ban', {
        hwid,
        reason,
        username,
        peer_addr: peerAddr,
        addr: peerAddr,
        ip: payload.ip || '',
        peer_id: peerAddr,
        hwid_details: hwidDetails
      });
      if (res.statusCode === 200 && res.data && res.data.success !== false) {
        return res.data;
      }
    } catch (e) {
      // Fallback to direct bans.json update when daemon is offline
    }

    const { bans, filePath } = this.readLocalBans();
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const id = `ban_${crypto.randomBytes(4).toString('hex')}`;
    const record = {
      id,
      hwid,
      motherboard_uuid: String(hwidDetails.motherboard_uuid || '').trim().toUpperCase(),
      motherboard_product: String(hwidDetails.motherboard_product || '').trim(),
      machine_guid: String(hwidDetails.machine_guid || '').trim().toUpperCase(),
      volume_serial: String(hwidDetails.volume_serial || '').trim().toUpperCase(),
      mac: String(hwidDetails.mac || '').trim().toUpperCase(),
      username: username || 'Bilinmeyen',
      reason: reason || 'Yönetici tarafından yasaklandı',
      banned_at: nowIso,
      banned_by: 'maziPanel'
    };

    const existingIdx = bans.findIndex((b) => String(b.hwid || '').toUpperCase() === hwid);
    if (existingIdx >= 0) {
      record.id = bans[existingIdx].id || id;
      bans[existingIdx] = record;
    } else {
      bans.unshift(record);
    }

    const bansMap = {};
    for (const b of bans) {
      bansMap[b.id || b.hwid] = b;
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(bansMap, null, 2), 'utf8');

    return {
      success: true,
      message: `${username} (${hwid}) başarıyla yasaklandı.`,
      ban: record
    };
  }

  async unbanClient(payload = {}) {
    const identifier = String(payload.id || payload.hwid || payload.target || '').trim().toUpperCase();
    if (!identifier) {
      throw new Error('Kaldırılacak yasak kimliği (HWID veya ID) belirtilmedi.');
    }

    try {
      const res = await this.daemonRequest('POST', '/api/unban', {
        id: identifier,
        hwid: identifier,
        target: identifier
      });
      if (res.statusCode === 200 && res.data && res.data.success !== false) {
        return res.data;
      }
    } catch (e) {
      // Fallback to direct bans.json update when daemon is offline
    }

    const { bans, filePath } = this.readLocalBans();
    const filtered = bans.filter(
      (b) =>
        String(b.id || '').toUpperCase() !== identifier &&
        String(b.hwid || '').toUpperCase() !== identifier &&
        String(b.motherboard_uuid || '').toUpperCase() !== identifier
    );

    const bansMap = {};
    for (const b of filtered) {
      bansMap[b.id || b.hwid] = b;
    }
    if (fs.existsSync(path.dirname(filePath))) {
      fs.writeFileSync(filePath, JSON.stringify(bansMap, null, 2), 'utf8');
    }

    return {
      success: true,
      message: 'Yasak başarıyla kaldırıldı.'
    };
  }

  async clearHistory() {
    try {
      const res = await this.daemonRequest('POST', '/api/clear_history');
      if (res.statusCode === 200 && res.data && res.data.success !== false) {
        return res.data;
      }
    } catch (e) {}

    const { filePath } = this.readLocalHistory();
    if (filePath && fs.existsSync(path.dirname(filePath))) {
      fs.writeFileSync(filePath, JSON.stringify({}, null, 2), 'utf8');
    }
    return {
      success: true,
      message: 'Bağlantı geçmişi başarıyla temizlendi.'
    };
  }

  async regenerateKey() {
    try {
      const res = await this.daemonRequest('POST', '/api/regenerate_key');
      if (res.statusCode === 200 && res.data && res.data.success !== false) {
        const cleanKey = normalizeServerKey(res.data.server_key);
        return {
          ...res.data,
          server_key: cleanKey,
          serverKey: cleanKey
        };
      }
    } catch (e) {}

    const newKey = generateServerKey();
    this.writeLocalConfig({ server_key: newKey });
    return {
      success: true,
      server_key: newKey,
      serverKey: newKey,
      message: `Yeni sunucu bağlantı kodu oluşturuldu: ${newKey}`
    };
  }

  async updateSettings(payload = {}) {
    const normalizedPayload = {
      server_name: payload.server_name ?? payload.serverName,
      server_key: payload.server_key ?? payload.serverKey,
      game_port: payload.game_port ?? payload.gamePort,
      connection_address: payload.connection_address ?? payload.connectionAddress,
      admin_secret: payload.admin_secret ?? payload.adminSecret
    };

    const { config: prevCfg } = this.readLocalConfig();
    const prevAdminSecret = (prevCfg && prevCfg.admin_secret) ? String(prevCfg.admin_secret) : '';

    // Always persist to local config file first or in tandem so offline changes work seamlessly
    const updatedCfg = this.writeLocalConfig(normalizedPayload);
    const nextAdminSecret = (updatedCfg && updatedCfg.admin_secret) ? String(updatedCfg.admin_secret) : '';

    try {
      let res = await this.daemonRequest('POST', '/api/update_settings', normalizedPayload, prevAdminSecret || nextAdminSecret);
      if (res.statusCode === 401 && nextAdminSecret && nextAdminSecret !== prevAdminSecret) {
        res = await this.daemonRequest('POST', '/api/update_settings', normalizedPayload, nextAdminSecret);
      }
      this._sessionCookie = null;
      this._lastAdminSecret = nextAdminSecret || null;
      if (res.statusCode === 200 && res.data && res.data.success !== false) {
        return {
          ...res.data,
          settings: updatedCfg
        };
      }
    } catch (e) {}

    return {
      success: true,
      message: 'Yapılandırma kalıcı olarak kaydedildi.',
      settings: updatedCfg
    };
  }

  async refreshVersion() {
    try {
      const res = await this.daemonRequest('POST', '/api/version/refresh');
      if (res.statusCode >= 400) {
        throw new Error((res.data && (res.data.message || res.data.error)) || 'İstemci sürümü yenilenemedi.');
      }
      return res.data;
    } catch (e) {
      return {
        success: true,
        version: '3.0',
        refreshed: false,
        message: 'P2P servisi çevrimdışı; varsayılan istemci sürümü (v3.0) aktif.'
      };
    }
  }
}

module.exports = new P2PService();
module.exports.formatPublicEndpoint = formatPublicEndpoint;
