const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const config = require('../../config');
const serverRegistry = require('./serverRegistry');
const javaDetector = require('../system/javaDetector');
const javaCompatibility = require('../system/javaCompatibility');
const { tokenizeArgs, assertSafeStartupArguments } = require('./startupArguments');
const defaultIconHelper = require('./defaultIconHelper');
let webhookService = null;
try {
  webhookService = require('../integrations/webhookService');
} catch (e) {}

let discordBotService = null;
try {
  discordBotService = require('../integrations/discordBotService');
} catch (e) {}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

class RunnerProcessProxy extends EventEmitter {
  constructor({ serverId, runnerPid, javaPid, port, token }) {
    super();
    this.serverId = serverId;
    this.runnerPid = runnerPid;
    this.pid = javaPid || null;
    this.port = port;
    this.token = token;
    this.killed = false;
    this.exitCode = null;
    this.detaching = false;
    this._exitEmitted = false;
    this.socket = null;
    this.lastSeq = 0;
    this.stdin = {
      write: (data) => this.writeStdin(data)
    };
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';

      const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = socket;

      const connectTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            socket.destroy();
          } catch (e) {}
          reject(new Error('Sunucu çalışma köprüsü (runner IPC) zaman aşımına uğradı.'));
        }
      }, timeoutMs);
      if (connectTimer.unref) connectTimer.unref();

      socket.on('connect', () => {
        this._send({ type: 'auth', token: this.token });
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const raw of lines) {
          if (!raw.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(raw);
          } catch (e) {
            continue;
          }

          if (msg.type === 'init') {
            if (msg.javaPid) this.pid = msg.javaPid;
            if (typeof msg.lastSeq === 'number') this.lastSeq = msg.lastSeq;
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              resolve(msg);
            }
          } else if (msg.type === 'auth_error') {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              try {
                socket.destroy();
              } catch (e) {}
              reject(new Error(msg.message || 'Runner IPC kimlik doğrulaması başarısız.'));
            }
          } else if (msg.type === 'line') {
            if (typeof msg.seq === 'number') this.lastSeq = msg.seq;
            this.emit('line', msg);
          } else if (msg.type === 'exit') {
            if (!this._exitEmitted) {
              this._exitEmitted = true;
              this.killed = true;
              this.exitCode = typeof msg.code === 'number' ? msg.code : 0;
              if (msg.error) {
                this.emit('runner_error', new Error(msg.error));
              }
              this.emit('exit', msg.code, msg.signal);
            }
          }
        }
      });

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          reject(err);
        }
      });

      socket.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          reject(new Error('Runner IPC bağlantısı beklenmedik şekilde kapandı.'));
          return;
        }
        if (!this.detaching && !this._exitEmitted) {
          if (!this.pid || !isPidAlive(this.pid)) {
            this._exitEmitted = true;
            this.killed = true;
            this.exitCode = this.exitCode !== null ? this.exitCode : 0;
            this.emit('exit', this.exitCode, null);
          }
        }
      });
    });
  }

  _send(payload) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(JSON.stringify(payload) + '\n');
      return true;
    } catch (e) {
      return false;
    }
  }

  writeStdin(data) {
    return this._send({ type: 'stdin', data: String(data || '') });
  }

  kill(signal = 'SIGTERM') {
    this._send({ type: 'kill', signal });
    if (this.pid && isPidAlive(this.pid)) {
      try {
        process.kill(this.pid, signal);
      } catch (e) {}
    }
    if (signal === 'SIGKILL') {
      this.killed = true;
    }
    return true;
  }

  syncState(stateObj) {
    if (this.detaching || this.killed) return false;
    return this._send({
      type: 'sync_state',
      state: {
        ...stateObj,
        lastSeq: this.lastSeq
      }
    });
  }

  detach() {
    this.detaching = true;
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) {
        return resolve();
      }
      const timer = setTimeout(() => {
        try {
          this.socket.destroy();
        } catch (e) {}
        resolve();
      }, 200);
      if (timer.unref) timer.unref();

      try {
        this.socket.end(() => {
          clearTimeout(timer);
          try {
            this.socket.destroy();
          } catch (e) {}
          resolve();
        });
      } catch (e) {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

class ProcessManager extends EventEmitter {
  constructor() {
    super();
    // serverId -> { process, status, ringBuffer, startTime, stoppingByUser, stoppingByPanelShutdown, gracefulShutdownDetected, crashTimes, onlinePlayers, restartTimer }
    this.instances = new Map();
    // serverId -> { operation, label, startedAt }
    this.activeServerLocks = new Map();
    this._recoveringServers = new Set();
  }

  acquireServerLock(serverId, operation, label = '') {
    if (!serverId) return;
    const existing = this.getServerLock(serverId);
    if (existing) {
      const err = new Error(`Bu sunucu üzerinde devam eden bir işlem var (${existing.label || existing.operation}). Lütfen işlemin tamamlanmasını bekleyin.`);
      err.code = 'SERVER_LOCKED';
      err.statusCode = 409;
      throw err;
    }
    this.activeServerLocks.set(serverId, {
      operation,
      label: label || operation,
      startedAt: Date.now()
    });
  }

  releaseServerLock(serverId, operation = null) {
    if (!serverId) return;
    if (operation) {
      const existing = this.activeServerLocks.get(serverId);
      if (existing && existing.operation === operation) {
        this.activeServerLocks.delete(serverId);
      }
      return;
    }
    this.activeServerLocks.delete(serverId);
  }

  isServerLocked(serverId) {
    if (!serverId) return false;
    const existing = this.activeServerLocks.get(serverId);
    if (!existing) return false;
    if (Date.now() - existing.startedAt >= 30 * 60 * 1000) {
      this.activeServerLocks.delete(serverId);
      return false;
    }
    return true;
  }

  getServerLock(serverId) {
    return this.isServerLocked(serverId) ? this.activeServerLocks.get(serverId) : null;
  }

  _triggerWebhook(event, serverId, extraData = {}) {
    try {
      if (!webhookService) {
        try {
          webhookService = require('../integrations/webhookService');
        } catch (e) {}
      }
      if (webhookService && typeof webhookService.trigger === 'function') {
        const server = serverRegistry.getById(serverId);
        const serverName = server ? (server.name || server.id) : serverId;
        Promise.resolve(
          webhookService.trigger(event, {
            serverId,
            serverName,
            ...extraData
          })
        ).catch((err) => {
          console.warn(`[maziPanel] Webhook tetikleme hatası (${event}):`, err.message);
        });
      }
    } catch (err) {
      console.warn(`[maziPanel] Webhook tetikleme istisnası (${event}):`, err.message);
    }
  }

  _triggerDiscordVoice(action, serverId) {
    try {
      if (!discordBotService) {
        try {
          discordBotService = require('../integrations/discordBotService');
        } catch (e) {}
      }
      if (discordBotService) {
        const server = serverId ? serverRegistry.getById(serverId) : null;
        const owner = server && server.owner ? server.owner.trim().toLowerCase() : null;

        if (action === 'join' && typeof discordBotService.joinVoice === 'function') {
          Promise.resolve(discordBotService.joinVoice(undefined, owner)).catch((err) => {
            console.warn('[maziPanel] Discord bot ses kanalına katılma hatası:', err.message);
          });
        } else if (action === 'leave' && typeof discordBotService.leaveVoice === 'function') {
          const ownerServers = owner ? serverRegistry.getAll(owner) : serverRegistry.getAll();
          const anyOtherOnline = ownerServers.some((s) => {
            if (s.id === serverId) return false;
            const inst = this.instances.get(s.id);
            return Boolean(inst && inst.process && !inst.process.killed && inst.status === 'online');
          });
          if (!anyOtherOnline) {
            Promise.resolve(discordBotService.leaveVoice(owner)).catch((err) => {
              console.warn('[maziPanel] Discord bot ses kanalından ayrılma hatası:', err.message);
            });
          }
        }
      }
    } catch (err) {
      console.warn('[maziPanel] Discord bot ses istisnası:', err.message);
    }
  }

  _getOrCreateInstance(serverId) {
    if (!this.instances.has(serverId)) {
      this.instances.set(serverId, {
        process: null,
        status: 'offline',
        ringBuffer: [],
        sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        startTime: null,
        stoppingByUser: false,
        stoppingByPanelShutdown: false,
        gracefulShutdownDetected: false,
        crashTimes: [],
        onlinePlayers: new Set(),
        playerEndpoints: new Map(),
        restartTimer: null
      });
    }
    return this.instances.get(serverId);
  }

  _resetLifecycle(serverId) {
    const inst = this._getOrCreateInstance(serverId);
    inst.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    inst.ringBuffer = [];
    inst.startTime = null;
    if (inst.playerEndpoints) inst.playerEndpoints.clear();
    this.emit('lifecycle_reset', { serverId, sessionId: inst.sessionId });
    return inst.sessionId;
  }

  getSessionId(serverId) {
    const inst = this.instances.get(serverId);
    return inst ? inst.sessionId : null;
  }

  _parseRamToMB(ramStr, fallbackMB = 2048) {
    if (!ramStr) return fallbackMB;
    const match = String(ramStr).trim().match(/^(\d+)\s*([gmkGMK]?)(?:b|ib)?$/i);
    if (!match) return fallbackMB;
    const val = parseInt(match[1], 10);
    const unit = (match[2] || 'g').toLowerCase();
    if (unit === 'g') return val * 1024;
    if (unit === 'm') return val;
    if (unit === 'k') return Math.round(val / 1024);
    return val * 1024;
  }

  _formatRamMB(mb) {
    if (!mb || mb <= 0) return '0 GB';
    if (mb >= 1024 && mb % 1024 === 0) {
      return `${mb / 1024} GB`;
    }
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${mb} MB`;
  }

  _getPidRssBytes(pid) {
    if (!pid) return 0;
    try {
      const procStatusPath = `/proc/${pid}/status`;
      if (fs.existsSync(procStatusPath)) {
        const statusContent = fs.readFileSync(procStatusPath, 'utf8');
        const vmrssMatch = statusContent.match(/VmRSS:\s+(\d+)\s+kB/);
        if (vmrssMatch) {
          return parseInt(vmrssMatch[1], 10) * 1024;
        }
      }
    } catch (e) {}

    // Fallback using ps command with spawnSync (safe, no shell)
    try {
      const { spawnSync } = require('child_process');
      const res = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false
      });
      if (res.status === 0 && res.stdout) {
        const kb = parseInt(res.stdout.trim(), 10);
        if (!isNaN(kb) && kb > 0) {
          return kb * 1024;
        }
      }
    } catch (e) {}

    return 0;
  }

  isRunning(serverId) {
    const inst = this.instances.get(serverId);
    return Boolean(inst && inst.process && !inst.process.killed && inst.status !== 'offline');
  }

  getStatus(serverId) {
    const inst = this.instances.get(serverId);
    const server = serverRegistry.getById(serverId);
    const allocatedMB = server ? this._parseRamToMB(server.maxRam, 2048) : 2048;
    const allocatedFormatted = this._formatRamMB(allocatedMB);
    const ramAllocated = server ? serverRegistry.formatRamDisplay(server.maxRam) : '2GB';

    if (!inst) {
      return {
        status: 'offline',
        pid: null,
        uptime: 0,
        onlinePlayers: [],
        playerEndpoints: {},
        memoryBytes: 0,
        memoryMB: 0,
        allocatedMB,
        allocatedFormatted,
        ramAllocated,
        sessionId: null
      };
    }

    const uptime = inst.startTime && inst.process ? Math.floor((Date.now() - inst.startTime) / 1000) : 0;
    let memoryBytes = 0;
    let memoryMB = 0;

    if (inst.process && inst.process.pid && inst.status !== 'offline') {
      memoryBytes = this._getPidRssBytes(inst.process.pid);
      memoryMB = Math.round(memoryBytes / (1024 * 1024));
    }

    const playerEndpoints = {};
    if (inst.playerEndpoints instanceof Map) {
      for (const [k, v] of inst.playerEndpoints.entries()) {
        playerEndpoints[k] = v;
      }
    }

    return {
      status: inst.status,
      pid: inst.process ? inst.process.pid : null,
      uptime,
      onlinePlayers: Array.from(inst.onlinePlayers),
      playerEndpoints,
      memoryBytes,
      memoryMB,
      allocatedMB,
      allocatedFormatted,
      ramAllocated,
      sessionId: inst.sessionId || null
    };
  }

  getAllStatuses() {
    const servers = serverRegistry.getAll();
    const result = {};
    for (const s of servers) {
      result[s.id] = this.getStatus(s.id);
    }
    return result;
  }

  getLogs(serverId, limit = 500) {
    const inst = this.instances.get(serverId);
    if (!inst) return [];
    return inst.ringBuffer.slice(-limit);
  }

  _appendLog(serverId, text, type = 'stdout', event = null) {
    const inst = this._getOrCreateInstance(serverId);
    const cleanText = String(text || '')
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/^(?:>\s*|\r\s*)+/g, '')
      .trim();

    const lastEntry = inst.ringBuffer.length > 0 ? inst.ringBuffer[inst.ringBuffer.length - 1] : null;
    if (lastEntry && type === 'stdout' && lastEntry.type === 'stdout') {
      const lastClean = String(lastEntry.text || '')
        .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/^(?:>\s*|\r\s*)+/g, '')
        .trim();

      // 1. Suppress redundant `<player> lost connection: You are banned from this server.` immediately after `Disconnecting <player>: You are banned...`
      const lostBanMatch = cleanText.match(/^(?:\[\d{2}:\d{2}:\d{2}[^\]]*\]:\s*)?([^\s(]+)(?:\s*\([^)]+\))?\s+lost connection:\s*You are banned from this server/i);
      if (lostBanMatch) {
        const player = lostBanMatch[1].toLowerCase();
        const lastLower = lastClean.toLowerCase();
        if (lastLower.includes(`disconnecting ${player}`) && lastLower.includes('you are banned from this server')) {
          return;
        }
      }

      // 2. Merge unprefixed `Reason: ...` / `Expires: ...` continuation lines into the preceding disconnect/ban entry
      const isUnprefixedContinuation =
        !/^\[\d{2}:\d{2}:\d{2}/.test(cleanText) &&
        /^(?:Reason|Sebep|Expires|Banned by|Banland[ıi]):\s*/i.test(cleanText);
      const isLastDisconnect =
        /(?:Disconnecting\s+\S+|\S+(?:\s*\([^)]+\))?\s+lost connection:|You are banned from this server|You are not white-listed on this server)/i.test(lastClean);

      if (isUnprefixedContinuation && isLastDisconnect) {
        if (!lastEntry.text.includes(cleanText)) {
          lastEntry.text = `${lastEntry.text} — ${cleanText}`;
          this.emit('log', { serverId, entry: lastEntry, sessionId: inst.sessionId });
          this._scheduleStateSync(serverId);
        }
        return;
      }
    }

    const entry = {
      timestamp: new Date().toISOString(),
      text,
      type
    };
    if (event) {
      entry.event = event;
    }
    if (inst.sessionId) {
      entry.sessionId = inst.sessionId;
    }

    inst.ringBuffer.push(entry);
    if (inst.ringBuffer.length > config.RING_BUFFER_SIZE) {
      inst.ringBuffer.shift();
    }

    this.emit('log', { serverId, entry, sessionId: inst.sessionId });
    this._scheduleStateSync(serverId);
  }

  _setStatus(serverId, newStatus) {
    const inst = this._getOrCreateInstance(serverId);
    const oldStatus = inst.status;
    if (oldStatus !== newStatus) {
      inst.status = newStatus;
      this.emit('status', { serverId, status: newStatus, oldStatus });
      this._scheduleStateSync(serverId);
    }
  }

  _getRunnersDir() {
    const baseDataDir = process.env.DATA_DIR || config.DATA_DIR;
    const dir = path.join(baseDataDir, 'runners');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
    }
    return dir;
  }

  _getRunnerStateFilePath(serverId) {
    const safeId = String(serverId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this._getRunnersDir(), `${safeId}.json`);
  }

  _removeRunnerStateFile(serverId) {
    try {
      const stateFile = this._getRunnerStateFilePath(serverId);
      if (fs.existsSync(stateFile)) {
        fs.unlinkSync(stateFile);
      }
    } catch (e) {}
  }

  _syncInstanceState(serverId) {
    if (this._recoveringServers.has(serverId)) return;
    const inst = this.instances.get(serverId);
    if (!inst || !inst.process || typeof inst.process.syncState !== 'function' || inst.process.detaching || inst.process.killed) {
      return;
    }
    const playerEndpoints = {};
    if (inst.playerEndpoints instanceof Map) {
      for (const [k, v] of inst.playerEndpoints.entries()) {
        playerEndpoints[k] = v;
      }
    }
    inst.process.syncState({
      status: inst.status,
      sessionId: inst.sessionId,
      startTime: inst.startTime,
      onlinePlayers: Array.from(inst.onlinePlayers),
      playerEndpoints,
      ringBuffer: inst.ringBuffer
    });
  }

  _scheduleStateSync(serverId) {
    if (this._recoveringServers.has(serverId)) return;
    const inst = this.instances.get(serverId);
    if (!inst || !inst.process || typeof inst.process.syncState !== 'function' || inst.process.detaching || inst.process.killed) {
      return;
    }
    if (inst._syncTimer) return;
    inst._syncTimer = setTimeout(() => {
      inst._syncTimer = null;
      this._syncInstanceState(serverId);
    }, 30);
    if (inst._syncTimer.unref) inst._syncTimer.unref();
  }

  _consumeRunnerLine(serverId, stream, rawText, options = {}) {
    const trimmed = String(rawText || '').replace(/\r$/, '');
    if (!trimmed) return;
    if (stream === 'stderr') {
      this._appendLog(serverId, trimmed, 'stderr');
      return;
    }
    const isDone = /Done\s*\([0-9\.]+s\)/i.test(trimmed);
    this._appendLog(serverId, trimmed, 'stdout', isDone ? 'done' : null);
    this._analyzeLine(serverId, trimmed, options);
  }

  _attachRunnerProxy(serverId, inst, proxy, initMsg, { isRecovery = false } = {}) {
    inst.process = proxy;

    if (isRecovery) {
      this._recoveringServers.add(serverId);
      try {
        if (initMsg.sessionId) {
          inst.sessionId = initMsg.sessionId;
        }
        if (initMsg.startTime) {
          inst.startTime = initMsg.startTime;
        } else if (!inst.startTime) {
          inst.startTime = Date.now();
        }
        inst.stoppingByUser = false;
        inst.stoppingByPanelShutdown = false;

        if (initMsg.state && typeof initMsg.state === 'object') {
          inst.status = initMsg.state.status || (initMsg.isReady ? 'online' : 'starting');
          if (Array.isArray(initMsg.state.ringBuffer)) {
            inst.ringBuffer = initMsg.state.ringBuffer.slice(-config.RING_BUFFER_SIZE);
          }
          inst.onlinePlayers = new Set(Array.isArray(initMsg.state.onlinePlayers) ? initMsg.state.onlinePlayers : []);
          inst.playerEndpoints = new Map(Object.entries(initMsg.state.playerEndpoints || {}));

          if (Array.isArray(initMsg.unackedLines)) {
            for (const item of initMsg.unackedLines) {
              this._consumeRunnerLine(serverId, item.stream, item.line, { silent: true });
            }
          }
        } else {
          inst.status = initMsg.isReady ? 'online' : 'starting';
          inst.ringBuffer = [];
          inst.onlinePlayers.clear();
          if (inst.playerEndpoints instanceof Map) inst.playerEndpoints.clear();
          this._appendLog(serverId, 'Sunucu başlatılıyor...', 'system', 'starting');

          const fallbackLines = Array.isArray(initMsg.rawLines) && initMsg.rawLines.length > 0
            ? initMsg.rawLines
            : (Array.isArray(initMsg.unackedLines) ? initMsg.unackedLines : []);
          for (const item of fallbackLines) {
            this._consumeRunnerLine(serverId, item.stream, item.line, { silent: true });
          }
        }

        if (initMsg.isReady && inst.status === 'starting') {
          inst.status = 'online';
        }
      } finally {
        this._recoveringServers.delete(serverId);
      }
      this._syncInstanceState(serverId);
    }

    proxy.on('line', (msg) => {
      this._consumeRunnerLine(serverId, msg.stream, msg.line);
    });

    proxy.on('runner_error', (err) => {
      this._appendLog(serverId, `Süreç hatası: ${err.message}`, 'system', 'crash');
    });

    proxy.on('exit', (code, signal) => {
      this._handleExit(serverId, code, signal);
    });

    if (!isRecovery && Array.isArray(initMsg.unackedLines) && initMsg.unackedLines.length > 0) {
      for (const item of initMsg.unackedLines) {
        this._consumeRunnerLine(serverId, item.stream, item.line);
      }
    }
  }

  async _spawnViaRunner(serverId, inst, { javaExe, jvmArgs, realServerDir }) {
    this._removeRunnerStateFile(serverId);
    const runnersDir = this._getRunnersDir();
    const stateFile = this._getRunnerStateFilePath(serverId);
    const token = crypto.randomBytes(32).toString('hex');
    const bootFile = path.join(runnersDir, `${serverId}.boot.${process.pid}.${Date.now()}.json`);

    fs.writeFileSync(
      bootFile,
      JSON.stringify({
        serverId,
        javaExe,
        jvmArgs,
        cwd: realServerDir,
        stateFile,
        sessionId: inst.sessionId,
        startTime: inst.startTime,
        ringBufferSize: config.RING_BUFFER_SIZE || 1000,
        token
      }),
      { encoding: 'utf8', mode: 0o600 }
    );

    const runnerScript = path.join(__dirname, 'serverRunner.js');
    const runnerChild = spawn(process.execPath, [runnerScript, bootFile], {
      cwd: realServerDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        TERM: 'dumb'
      }
    });
    if (runnerChild.unref) runnerChild.unref();

    const deadline = Date.now() + 5000;
    let meta = null;
    while (Date.now() < deadline) {
      if (fs.existsSync(stateFile)) {
        try {
          const content = fs.readFileSync(stateFile, 'utf8');
          meta = JSON.parse(content);
          if (meta && (meta.port || meta.spawnError)) {
            break;
          }
        } catch (e) {}
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    if (!meta) {
      try {
        if (fs.existsSync(bootFile)) fs.unlinkSync(bootFile);
      } catch (e) {}
      throw new Error('Sunucu çalışma köprüsü (runner) başlatılamadı.');
    }

    if (meta.spawnError) {
      this._removeRunnerStateFile(serverId);
      throw new Error(meta.spawnError);
    }

    const proxy = new RunnerProcessProxy({
      serverId,
      runnerPid: meta.runnerPid,
      javaPid: meta.javaPid,
      port: meta.port,
      token: meta.token
    });

    const initMsg = await proxy.connect(5000);
    if (initMsg.exitError && !initMsg.javaPid) {
      this._removeRunnerStateFile(serverId);
      throw new Error(initMsg.exitError);
    }

    this._attachRunnerProxy(serverId, inst, proxy, initMsg, { isRecovery: false });
    this._syncInstanceState(serverId);
    return proxy;
  }

  async _recoverSingleServer(serverId) {
    if (!serverId) return false;
    const existingInst = this.instances.get(serverId);
    if (existingInst && existingInst.process && !existingInst.process.killed && existingInst.status !== 'offline') {
      return true;
    }

    const stateFile = this._getRunnerStateFilePath(serverId);
    if (!fs.existsSync(stateFile)) return false;

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (e) {
      this._removeRunnerStateFile(serverId);
      return false;
    }

    if (
      !meta ||
      !meta.port ||
      !meta.token ||
      !isPidAlive(meta.runnerPid) ||
      (meta.javaPid && !isPidAlive(meta.javaPid))
    ) {
      this._removeRunnerStateFile(serverId);
      return false;
    }

    const server = serverRegistry.getById(serverId);
    if (!server) {
      if (meta.javaPid && isPidAlive(meta.javaPid)) {
        try { process.kill(meta.javaPid, 'SIGKILL'); } catch (e) {}
      }
      if (meta.runnerPid && isPidAlive(meta.runnerPid)) {
        try { process.kill(meta.runnerPid, 'SIGKILL'); } catch (e) {}
      }
      this._removeRunnerStateFile(serverId);
      return false;
    }

    try {
      const proxy = new RunnerProcessProxy({
        serverId,
        runnerPid: meta.runnerPid,
        javaPid: meta.javaPid,
        port: meta.port,
        token: meta.token
      });

      const initMsg = await proxy.connect(3000);
      if (initMsg.exited || !initMsg.javaPid || !isPidAlive(initMsg.javaPid)) {
        await proxy.detach().catch(() => {});
        this._removeRunnerStateFile(serverId);
        return false;
      }

      const inst = this._getOrCreateInstance(serverId);
      this._attachRunnerProxy(serverId, inst, proxy, initMsg, { isRecovery: true });
      serverRegistry.update(serverId, { lastRunning: true });
      console.log(`[maziPanel] Çalışan sunucu oturumu kesintisiz devralındı: ${server.name || serverId} (PID: ${proxy.pid}, Durum: ${inst.status})`);
      return true;
    } catch (err) {
      this._removeRunnerStateFile(serverId);
      return false;
    }
  }

  async recoverRunningServers() {
    const runnersDir = this._getRunnersDir();
    if (!fs.existsSync(runnersDir)) return 0;

    let files = [];
    try {
      files = fs.readdirSync(runnersDir).filter((f) => f.endsWith('.json') && !f.includes('.boot.') && !f.includes('.tmp.'));
    } catch (e) {
      return 0;
    }

    let recoveredCount = 0;
    for (const file of files) {
      const serverId = file.slice(0, -5);
      const ok = await this._recoverSingleServer(serverId);
      if (ok) recoveredCount++;
    }
    return recoveredCount;
  }

  async detachAll() {
    const promises = [];
    for (const [serverId, inst] of this.instances.entries()) {
      if (inst && inst._syncTimer) {
        clearTimeout(inst._syncTimer);
        inst._syncTimer = null;
      }
      if (inst && inst.process && typeof inst.process.detach === 'function' && !inst.process.killed) {
        this._syncInstanceState(serverId);
        promises.push(inst.process.detach());
      }
    }
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  async startServer(serverId, options = {}) {
    const skipLock = Boolean(options && options._skipLock);
    if (!skipLock) {
      this.acquireServerLock(serverId, 'start', 'Sunucu başlatma');
    }

    try {
      const inst = this._getOrCreateInstance(serverId);
      if (!inst.process || inst.process.killed) {
        await this._recoverSingleServer(serverId).catch(() => false);
      }
      if (inst.process && !inst.process.killed) {
        throw new Error(`"${serverId}" sunucusu zaten çalışıyor (${inst.status}).`);
      }

      const server = serverRegistry.getById(serverId);
      if (!server) {
        throw new Error(`"${serverId}" sunucusu sistem kaydında bulunamadı.`);
      }

      // Cancel any pending auto-restart timer since server is starting now
      if (inst.restartTimer) {
        clearTimeout(inst.restartTimer);
        inst.restartTimer = null;
      }

      // Validate directory and jarFile isolation before starting
      const safeServerDir = serverRegistry.assertSafeServerDirectory(server.directory, server.id);
      const settings = serverRegistry.getServerSettings(server);
      const safeJarFile = serverRegistry.validateJarFile(settings.startup?.jarFile || server.jarFile || 'server.jar');
      const requestedJava = serverRegistry.validateJavaPath(settings.startup?.javaPath || server.javaPath || '');

      // 1. Resolve and validate Java executable BEFORE lifecycle is reset/cleared or spawned
      let mojangMeta = null;
      if (server.type === 'vanilla' && server.version) {
        try {
          mojangMeta = await javaCompatibility.fetchMojangJavaMetadata(server.version);
        } catch (e) {}
      }
      const javaReq = javaCompatibility.getJavaRequirements(server.type, server.version, mojangMeta);

      const javaExe = javaDetector.getJavaForServer(requestedJava, {
        coreType: server.type,
        version: server.version,
        ...javaReq
      });

      if (!javaExe) {
        const rec = javaReq.recommendedJava || javaReq.minJava || 'uyumlu';
        throw new Error(`Bu sunucu (${server.type || 'Minecraft'} ${server.version || ''}) için uyumlu Java bulunamadı. Sunucuyu başlatmak için en az Java ${javaReq.minJava || rec} kurulumu gereklidir.`);
      }

      // Explicitly begin new lifecycle: reset ring buffer and generate new session ID
      this._resetLifecycle(serverId);

      if (!fs.existsSync(safeServerDir)) {
        this._setStatus(serverId, 'offline');
        this._appendLog(serverId, `Sunucu dizini bulunamadı: ${safeServerDir}`, 'system', 'crash');
        throw new Error(`Sunucu dizini bulunamadı: ${safeServerDir}`);
      }

      const realServerDir = fs.realpathSync(safeServerDir);

      // Ensure 64x64 default server-icon.png exists before game server starts
      try {
        defaultIconHelper.ensureServerIcon(realServerDir);
      } catch (iconErr) {
        console.warn(`[processManager] Varsayılan sunucu ikonu oluşturulamadı: ${iconErr.message}`);
      }

      const jarFullPath = path.resolve(realServerDir, safeJarFile);
      if (!fs.existsSync(jarFullPath)) {
        this._setStatus(serverId, 'offline');
        this._appendLog(serverId, `Sunucu JAR dosyası bulunamadı: ${jarFullPath}`, 'system', 'crash');
        throw new Error(`Sunucu JAR dosyası bulunamadı: ${jarFullPath}`);
      }

      const realJarPath = fs.realpathSync(jarFullPath);
      const jarRel = path.relative(realServerDir, realJarPath);
      if (!jarRel || jarRel === '.' || jarRel.startsWith('..') || path.isAbsolute(jarRel) || !fs.statSync(realJarPath).isFile()) {
        this._setStatus(serverId, 'offline');
        this._appendLog(serverId, 'Güvenlik ihlali: JAR dosyası sunucu dizini dışında yer alamaz.', 'system', 'crash');
        throw new Error('Güvenlik ihlali: JAR dosyası sunucu dizini dışında yer alamaz.');
      }

      // Automatically ensure eula.txt exists with eula=true atomically
      const eulaPath = path.join(realServerDir, 'eula.txt');
      try {
        if (!fs.existsSync(eulaPath)) {
          serverRegistry.atomicWriteFileSync(eulaPath, '# Generated by maziPanel\neula=true\n');
        } else {
          const eulaContent = fs.readFileSync(eulaPath, 'utf8');
          if (!eulaContent.includes('eula=true')) {
            serverRegistry.atomicWriteFileSync(eulaPath, eulaContent.replace(/eula\s*=\s*false/i, 'eula=true'));
          }
        }
      } catch (e) {
        console.warn(`${serverId} sunucusu için eula.txt doğrulanamadı:`, e.message);
      }

      // Validate JVM flags and server arguments against dangerous code/command execution
      assertSafeStartupArguments(settings.startup.jvmFlags, settings.startup.serverArgs);

      // Build JVM Arguments
      const jvmArgs = [];
      jvmArgs.push(`-Xms${settings.memory.minMB}M`);
      jvmArgs.push(`-Xmx${settings.memory.maxMB}M`);
      if (settings.startup.jvmFlags) {
        jvmArgs.push(...tokenizeArgs(settings.startup.jvmFlags));
      }
      jvmArgs.push('-jar', safeJarFile);
      if (settings.startup.serverArgs) {
        jvmArgs.push(...tokenizeArgs(settings.startup.serverArgs));
      }

      console.log(`[maziPanel] Sunucu süreci başlatılıyor (${serverId}): ${javaExe} ${jvmArgs.join(' ')}`);

      this._setStatus(serverId, 'starting');
      this._appendLog(serverId, 'Sunucu başlatılıyor...', 'system', 'starting');

      inst.stoppingByUser = false;
      inst.stoppingByPanelShutdown = false;
      inst.gracefulShutdownDetected = false;
      inst.startTime = Date.now();
      inst.onlinePlayers.clear();
      serverRegistry.update(serverId, { lastRunning: true });

      try {
        const proxy = await this._spawnViaRunner(serverId, inst, {
          javaExe,
          jvmArgs,
          realServerDir
        });

        this._triggerWebhook('server_start', serverId, { pid: proxy.pid });

        return {
          success: true,
          message: 'Sunucu süreci başlatıldı.',
          pid: proxy.pid,
          status: inst.status || 'starting'
        };
      } catch (err) {
        this._setStatus(serverId, 'offline');
        inst.process = null;
        this._appendLog(serverId, `Süreç başlatılamadı: ${err.message}`, 'system', 'crash');
        throw new Error(`Sunucu süreci başlatılamadı: ${err.message}`);
      }
    } finally {
      if (!skipLock) {
        this.releaseServerLock(serverId, 'start');
      }
    }
  }

  _analyzeLine(serverId, rawLine, options = {}) {
    const inst = this.instances.get(serverId);
    if (!inst) return;
    const silent = Boolean(options && options.silent);

    // Strip ANSI color and escape sequences
    const line = rawLine.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');

    // Track graceful shutdown keywords in server output
    if (/Stopping (?:the )?server/i.test(line)) {
      inst.gracefulShutdownDetected = true;
    }

    // Detect server ready / online
    if (inst.status === 'starting') {
      if (/Done\s*\([0-9\.]+s\)|Listening on/i.test(line)) {
        this._setStatus(serverId, 'online');
        if (!silent) {
          this._triggerWebhook('server_done', serverId);
          this._triggerDiscordVoice('join', serverId);
        }
      }
    }

    // Player Join Detection (Vanilla, Paper, Purpur, Fabric, Spigot)
    const loginAddrMatch = line.match(/(?:INFO\]:?\s+|System chat:\s+)?([a-zA-Z0-9_]{3,16})\[\/([^\]:]+):(\d+)\]\s+(?:joined the game|logged in with entity id|logged in)/i);
    const joinMatch = loginAddrMatch
      || line.match(/(?:INFO\]:?\s+|System chat:\s+)?([a-zA-Z0-9_]{3,16})(?:\s*[\[\(]\/[^\]\)]+[\]\)])?\s+(?:joined the game|logged in with entity id|logged in)/i);
    if (joinMatch) {
      const playerName = joinMatch[1];
      if (playerName && playerName !== 'System' && playerName !== 'Server') {
        if (loginAddrMatch && inst.playerEndpoints instanceof Map) {
          const rawIp = String(loginAddrMatch[2] || '').replace(/^::ffff:/i, '').trim();
          const port = parseInt(loginAddrMatch[3], 10);
          if (rawIp && !isNaN(port) && port > 0) {
            inst.playerEndpoints.set(playerName.toLowerCase(), {
              ip: rawIp,
              port,
              joinedAt: Date.now()
            });
          }
        }
        inst.onlinePlayers.add(playerName);
        this.emit('player_join', { serverId, player: playerName });
        this._scheduleStateSync(serverId);
      }
    }

    // Player Leave / Disconnect Detection (including pre-login rejections with parentheses e.g. `Seth (/127.0.0.1:49258) lost connection`)
    const leaveMatch = line.match(/(?:INFO\]:?\s+|System chat:\s+)?([a-zA-Z0-9_]{3,16})(?:\s*[\[\(]\/[^\]\)]+[\]\)])?\s+(?:left the game|lost connection)/i)
      || line.match(/(?:INFO\]:?\s+)?Disconnecting\s+([a-zA-Z0-9_]{3,16})(?:\s*[\[\(]\/[^\]\)]+[\]\)])?:/i);
    if (leaveMatch) {
      const playerName = leaveMatch[1];
      if (playerName && playerName !== 'System' && playerName !== 'Server') {
        for (const existing of Array.from(inst.onlinePlayers)) {
          if (existing.toLowerCase() === playerName.toLowerCase()) {
            inst.onlinePlayers.delete(existing);
          }
        }
        if (inst.playerEndpoints instanceof Map) {
          inst.playerEndpoints.delete(playerName.toLowerCase());
        }
        this.emit('player_leave', { serverId, player: playerName });
        this._scheduleStateSync(serverId);
      }
    }
  }

  _handleExit(serverId, code, signal) {
    const inst = this.instances.get(serverId);
    if (!inst) return;

    if (inst._syncTimer) {
      clearTimeout(inst._syncTimer);
      inst._syncTimer = null;
    }
    this._removeRunnerStateFile(serverId);

    const stoppingByUser = inst.stoppingByUser;
    const stoppingByPanelShutdown = inst.stoppingByPanelShutdown;
    const isCleanShutdown = stoppingByUser || stoppingByPanelShutdown || ((code === 0 || signal === null) && inst.gracefulShutdownDetected);

    inst.process = null;
    inst.startTime = null;
    inst.onlinePlayers.clear();
    if (inst.playerEndpoints instanceof Map) {
      inst.playerEndpoints.clear();
    }
    inst.gracefulShutdownDetected = false;

    if (!stoppingByPanelShutdown) {
      serverRegistry.update(serverId, { lastRunning: false });
    }

    if (isCleanShutdown) {
      this._setStatus(serverId, 'offline');
      this._appendLog(serverId, 'Sunucu durduruldu.', 'system', 'offline');
      inst.stoppingByUser = false;
      this._triggerWebhook('server_stop', serverId);
      this._triggerDiscordVoice('leave', serverId);
      return;
    }

    // Server crashed or exited unexpectedly
    const exitDesc = signal ? `sinyal ${signal}` : `çıkış kodu ${code}`;
    this._setStatus(serverId, 'crashed');
    this._triggerWebhook('server_crash', serverId, { code, signal, exitDesc });
    this._triggerDiscordVoice('leave', serverId);

    const server = serverRegistry.getById(serverId);
    const settings = serverRegistry.getServerSettings(server);
    const autoRestart = settings.crash.autoRestart;
    const maxRetries = settings.crash.maxRetries;
    const delaySec = settings.crash.delaySec;

    const now = Date.now();
    inst.crashTimes = inst.crashTimes.filter((t) => now - t < 60000);
    inst.crashTimes.push(now);

    if (inst.crashTimes.length > maxRetries) {
      this._appendLog(serverId, `Sunucu 60 saniye içinde ${inst.crashTimes.length} kez çöktü. Otomatik yeniden başlatma iptal edildi.`, 'system', 'crash');
      return;
    }

    if (autoRestart) {
      this._appendLog(serverId, `Sunucu çöktü (${exitDesc}). ${delaySec} sn içinde yeniden başlatılıyor...`, 'system', 'crash');
      inst.restartTimer = setTimeout(() => {
        inst.restartTimer = null;
        this._appendLog(serverId, 'Sunucu yeniden başlatılıyor...', 'system', 'restarting');
        this._triggerWebhook('server_restart', serverId);
        this.startServer(serverId).catch((err) => {
          this._appendLog(serverId, `Sunucu yeniden başlatılamadı: ${err.message}`, 'system', 'crash');
          this._setStatus(serverId, 'crashed');
        });
      }, delaySec * 1000);
    } else {
      this._appendLog(serverId, `Sunucu çöktü (${exitDesc}).`, 'system', 'crash');
    }
  }

  sendCommand(serverId, command) {
    const inst = this.instances.get(serverId);
    if (!inst || !inst.process || inst.process.killed) {
      throw new Error(`Sunucu "${serverId}" çalışmıyor.`);
    }

    if (typeof command !== 'string') {
      throw new Error('Komut geçerli bir metin olmalıdır.');
    }

    // Sanitize command: remove \r, \n, Unicode line separators and other control characters (single line), limit length to 1000
    let cleanCmd = command.replace(/[\r\n\x00-\x08\x0B-\x1F\x7F\u0085\u2028\u2029]/g, ' ').trim();
    if (cleanCmd.length > 1000) {
      cleanCmd = cleanCmd.slice(0, 1000).trim();
    }

    if (!cleanCmd) return { success: false, message: 'Boş komut gönderilemez.' };

    this._appendLog(serverId, `> ${cleanCmd}`, 'command', 'command');

    // Detect user-initiated stop or restart from console command
    const stripped = cleanCmd.replace(/^\//, '');
    const firstWord = stripped.split(/\s+/)[0]?.toLowerCase();
    if (['stop', 'end', 'restart'].includes(firstWord)) {
      inst.stoppingByUser = true;
      this._setStatus(serverId, 'stopping');
      this._appendLog(serverId, 'Sunucu durduruluyor...', 'system', 'stopping');
      serverRegistry.update(serverId, { lastRunning: false });
    }

    inst.process.stdin.write(cleanCmd + '\n');
    return { success: true, command: cleanCmd };
  }

  async stopServer(serverId, customTimeoutMs) {
    const inst = this.instances.get(serverId);

    // Cancel any pending auto-restart timer
    if (inst && inst.restartTimer) {
      clearTimeout(inst.restartTimer);
      inst.restartTimer = null;
      this._appendLog(serverId, 'Bekleyen otomatik yeniden başlatma iptal edildi.', 'system');
    }

    if (!inst || !inst.process || inst.process.killed) {
      this._setStatus(serverId, 'offline');
      return { success: true, message: 'Sunucu zaten kapalı.' };
    }

    const server = serverRegistry.getById(serverId);
    const settings = serverRegistry.getServerSettings(server);
    const stopCmd = settings.stop.command || 'stop';
    const timeoutMs = typeof customTimeoutMs === 'number' ? customTimeoutMs : ((settings.stop.timeoutSec || 30) * 1000);
    const onTimeout = settings.stop.onTimeout || 'kill';

    inst.stoppingByUser = true;
    if (!inst.stoppingByPanelShutdown) {
      serverRegistry.update(serverId, { lastRunning: false });
    }
    this._setStatus(serverId, 'stopping');
    this._appendLog(serverId, 'Sunucu durduruluyor...', 'system', 'stopping');

    try {
      inst.process.stdin.write(`${stopCmd}\n`);
    } catch (e) {}

    return new Promise((resolve) => {
      let resolved = false;
      let forceKillTimer = null;
      let sigkillTimer = null;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          if (forceKillTimer) clearTimeout(forceKillTimer);
          if (sigkillTimer) clearTimeout(sigkillTimer);
          this._setStatus(serverId, 'offline');
          resolve({ success: true, message: 'Sunucu durduruldu.' });
        }
      };

      if (!inst.process || inst.process.killed || inst.process.exitCode !== null) {
        finish();
        return;
      }

      inst.process.once('exit', finish);

      if (onTimeout === 'kill') {
        forceKillTimer = setTimeout(() => {
          if (resolved) return;
          if (inst.process && !inst.process.killed) {
            this._appendLog(serverId, 'Sunucu yanıt vermedi. Süreç zorla durduruluyor...', 'system');
            try {
              inst.process.kill('SIGTERM');
            } catch (e) {}

            sigkillTimer = setTimeout(() => {
              if (resolved) return;
              if (inst.process && !inst.process.killed) {
                try {
                  inst.process.kill('SIGKILL');
                } catch (e) {}
              }
              finish();
            }, 3000);
          } else {
            finish();
          }
        }, timeoutMs);
      }
    });
  }

  killServer(serverId) {
    const inst = this.instances.get(serverId);

    // Cancel any pending auto-restart timer
    if (inst && inst.restartTimer) {
      clearTimeout(inst.restartTimer);
      inst.restartTimer = null;
      this._appendLog(serverId, 'Bekleyen otomatik yeniden başlatma iptal edildi.', 'system');
    }

    if (!inst || !inst.process || inst.process.killed) {
      this._setStatus(serverId, 'offline');
      return { success: true, message: 'Sunucu zaten kapalı.' };
    }

    inst.stoppingByUser = true;
    serverRegistry.update(serverId, { lastRunning: false });
    this._appendLog(serverId, 'Sunucu işlemi zorla durduruldu.', 'system');
    try {
      inst.process.kill('SIGKILL');
    } catch (err) {
      console.error(`${serverId} süreci sonlandırılırken hata oluştu:`, err);
    }
    this._setStatus(serverId, 'offline');
    return { success: true, message: 'Sunucu işlemi zorla durduruldu.' };
  }

  async restartServer(serverId) {
    this.acquireServerLock(serverId, 'restart', 'Yeniden başlatma');
    try {
      this._triggerWebhook('server_restart', serverId);
      const server = serverRegistry.getById(serverId);
      const settings = serverRegistry.getServerSettings(server);

      if (settings.restart.warnMessage && settings.restart.warnSeconds > 0) {
        try {
          this.sendCommand(serverId, `say ${settings.restart.warnMessage}`);
        } catch (e) {}
        await new Promise((r) => setTimeout(r, settings.restart.warnSeconds * 1000));
      }

      this._appendLog(serverId, 'Sunucu yeniden başlatılıyor...', 'system', 'restarting');

      if (settings.restart.mode === 'kill') {
        this.killServer(serverId);
      } else {
        await this.stopServer(serverId);
      }

      const delayMs = (settings.restart.delaySec || 1) * 1000;
      await new Promise((r) => setTimeout(r, delayMs));
      return await this.startServer(serverId, { _skipLock: true });
    } finally {
      this.releaseServerLock(serverId, 'restart');
    }
  }

  async gracefulShutdownAll() {
    const promises = [];
    for (const [serverId, inst] of this.instances.entries()) {
      if (inst && inst.process && !inst.process.killed && inst.status !== 'offline') {
        inst.stoppingByPanelShutdown = true;
        // Don't mark lastRunning as false, so last_state survives reboot!
        promises.push(this.stopServer(serverId, 25000));
      }
    }
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }
}

module.exports = new ProcessManager();

