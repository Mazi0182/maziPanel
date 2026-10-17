const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const bootFilePath = process.argv[2];
if (!bootFilePath || !fs.existsSync(bootFilePath)) {
  process.exit(1);
}

let bootConfig;
try {
  bootConfig = JSON.parse(fs.readFileSync(bootFilePath, 'utf8'));
  try {
    fs.unlinkSync(bootFilePath);
  } catch (e) {}
} catch (err) {
  process.exit(1);
}

const {
  serverId,
  javaExe,
  jvmArgs,
  cwd,
  stateFile,
  sessionId,
  startTime,
  ringBufferSize = 1000,
  token
} = bootConfig;

let seqCounter = 0;
const rawLines = [];
let isReady = false;
let savedState = null;

let javaChild = null;
let exited = false;
let exitCode = null;
let exitSignal = null;
let exitError = null;
let exitDelivered = false;
let cleanupTimer = null;

const authenticatedClients = new Set();

function writeStateFile(obj) {
  if (!stateFile) return;
  try {
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${stateFile}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  } catch (e) {}
}

function removeStateFile() {
  if (!stateFile) return;
  try {
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  } catch (e) {}
}

function sendJson(socket, payload) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(JSON.stringify(payload) + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

function broadcast(payload) {
  let delivered = false;
  for (const client of authenticatedClients) {
    if (sendJson(client, payload)) {
      delivered = true;
    }
  }
  return delivered;
}

function recordLine(stream, text) {
  const seq = ++seqCounter;
  const timestamp = new Date().toISOString();
  const cleanLine = String(text || '').replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
  if (stream === 'stdout' && /Done\s*\([0-9\.]+s\)|Listening on/i.test(cleanLine)) {
    isReady = true;
  }

  const item = { seq, stream, line: text, timestamp };
  rawLines.push(item);
  if (rawLines.length > ringBufferSize) {
    rawLines.shift();
  }

  broadcast({
    type: 'line',
    seq,
    stream,
    line: text,
    timestamp
  });
}

function shutdownRunner() {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  removeStateFile();
  try {
    ipcServer.close();
  } catch (e) {}
  for (const client of authenticatedClients) {
    try {
      client.end();
    } catch (e) {}
  }
  setTimeout(() => {
    process.exit(0);
  }, 50).unref();
}

function handleChildExit(code, signal, errMsg = null) {
  if (exited) return;
  exited = true;
  exitCode = code;
  exitSignal = signal;
  exitError = errMsg;

  const delivered = broadcast({
    type: 'exit',
    code: exitCode,
    signal: exitSignal,
    error: exitError
  });

  if (delivered) {
    exitDelivered = true;
    shutdownRunner();
  } else {
    // Keep IPC server alive briefly in case the panel is mid-restart so it can collect exit status & final logs
    cleanupTimer = setTimeout(() => {
      shutdownRunner();
    }, 10000);
    if (cleanupTimer.unref) cleanupTimer.unref();
  }
}

const ipcServer = net.createServer((socket) => {
  let authed = false;
  let buffer = '';

  const authTimeout = setTimeout(() => {
    if (!authed) {
      try {
        socket.destroy();
      } catch (e) {}
    }
  }, 5000);
  if (authTimeout.unref) authTimeout.unref();

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

      if (!authed) {
        if (msg.type === 'auth' && token && msg.token === token) {
          authed = true;
          clearTimeout(authTimeout);
          authenticatedClients.add(socket);

          const lastSyncedSeq = savedState && typeof savedState.lastSeq === 'number' ? savedState.lastSeq : 0;
          const unackedLines = rawLines.filter((item) => item.seq > lastSyncedSeq);

          sendJson(socket, {
            type: 'init',
            serverId,
            runnerPid: process.pid,
            javaPid: javaChild && javaChild.pid ? javaChild.pid : null,
            sessionId,
            startTime,
            isReady,
            lastSeq: seqCounter,
            state: savedState,
            unackedLines,
            rawLines: savedState ? [] : rawLines,
            exited,
            exitCode,
            exitSignal,
            exitError
          });

          if (exited) {
            sendJson(socket, {
              type: 'exit',
              code: exitCode,
              signal: exitSignal,
              error: exitError
            });
            exitDelivered = true;
            shutdownRunner();
          }
        } else {
          sendJson(socket, { type: 'auth_error', message: 'Unauthorized runner IPC connection.' });
          try {
            socket.destroy();
          } catch (e) {}
          return;
        }
        continue;
      }

      if (msg.type === 'stdin') {
        if (javaChild && !javaChild.killed && javaChild.stdin && javaChild.stdin.writable) {
          try {
            javaChild.stdin.write(String(msg.data || ''));
          } catch (e) {}
        }
      } else if (msg.type === 'kill') {
        const sig = msg.signal || 'SIGTERM';
        if (javaChild && !javaChild.killed) {
          try {
            javaChild.kill(sig);
          } catch (e) {}
        }
      } else if (msg.type === 'sync_state') {
        if (msg.state && typeof msg.state === 'object') {
          savedState = {
            ...msg.state,
            lastSeq: typeof msg.state.lastSeq === 'number' ? msg.state.lastSeq : seqCounter
          };
        }
      } else if (msg.type === 'ping') {
        sendJson(socket, { type: 'pong', seq: seqCounter });
      }
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimeout);
    authenticatedClients.delete(socket);
  });

  socket.on('error', () => {
    clearTimeout(authTimeout);
    authenticatedClients.delete(socket);
  });
});

ipcServer.on('error', () => {
  process.exit(1);
});

ipcServer.listen(0, '127.0.0.1', () => {
  const addr = ipcServer.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;

  try {
    javaChild = spawn(javaExe, jvmArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TERM: 'dumb'
      }
    });
  } catch (spawnErr) {
    writeStateFile({
      serverId,
      runnerPid: process.pid,
      javaPid: null,
      port,
      token,
      sessionId,
      startTime,
      spawnError: spawnErr.message
    });
    handleChildExit(-1, null, spawnErr.message);
    return;
  }

  let stdoutBuffer = '';
  javaChild.stdout.on('data', (data) => {
    stdoutBuffer += data.toString('utf8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed) continue;
      recordLine('stdout', trimmed);
    }
  });

  let stderrBuffer = '';
  javaChild.stderr.on('data', (data) => {
    stderrBuffer += data.toString('utf8');
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed) continue;
      recordLine('stderr', trimmed);
    }
  });

  javaChild.on('error', (err) => {
    if (!javaChild.pid) {
      writeStateFile({
        serverId,
        runnerPid: process.pid,
        javaPid: null,
        port,
        token,
        sessionId,
        startTime,
        spawnError: err.message
      });
    }
    handleChildExit(-1, null, err.message);
  });

  javaChild.on('exit', (code, signal) => {
    if (stdoutBuffer.trim()) {
      recordLine('stdout', stdoutBuffer.trim());
      stdoutBuffer = '';
    }
    if (stderrBuffer.trim()) {
      recordLine('stderr', stderrBuffer.trim());
      stderrBuffer = '';
    }
    handleChildExit(code, signal, null);
  });

  if (javaChild.pid) {
    writeStateFile({
      serverId,
      runnerPid: process.pid,
      javaPid: javaChild.pid,
      port,
      token,
      sessionId,
      startTime
    });
  }
});

// If the host OS itself is shutting down and sends SIGTERM directly to serverRunner, stop Minecraft cleanly
let runnerStopping = false;
function gracefulHostShutdown() {
  if (runnerStopping) return;
  runnerStopping = true;
  if (javaChild && !javaChild.killed && !exited) {
    try {
      if (javaChild.stdin && javaChild.stdin.writable) {
        javaChild.stdin.write('stop\n');
      }
    } catch (e) {}
    setTimeout(() => {
      if (javaChild && !javaChild.killed && !exited) {
        try {
          javaChild.kill('SIGTERM');
        } catch (e) {}
      }
    }, 22000).unref();
  } else {
    shutdownRunner();
  }
}

process.on('SIGTERM', gracefulHostShutdown);
process.on('SIGINT', gracefulHostShutdown);
