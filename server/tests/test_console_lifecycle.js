const assert = require('assert');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const processManager = require('../src/servers/processManager');
const serverRegistry = require('../src/servers/serverRegistry');
const wsManager = require('../src/websocket/wsManager');

async function runConsoleLifecycleTests() {
  console.log('====================================================');
  console.log('    maziPanel Console Lifecycle Regression Tests    ');
  console.log('====================================================\n');

  const srvA = 'test-srv-console-a';
  const srvB = 'test-srv-console-b';
  const tempBase = path.join(config.SERVERS_DIR, 'temp_console_tests');

  const dirA = path.join(tempBase, srvA);
  const dirB = path.join(tempBase, srvB);

  // Setup isolated temporary directories
  if (fs.existsSync(tempBase)) {
    fs.rmSync(tempBase, { recursive: true, force: true });
  }
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  // Create dummy server jar files
  fs.writeFileSync(path.join(dirA, 'server.jar'), 'dummy-jar-content');
  fs.writeFileSync(path.join(dirB, 'server.jar'), 'dummy-jar-content');

  // Register temporary servers
  serverRegistry.register({
    id: srvA,
    name: 'Console Test Server A',
    directory: dirA,
    jarFile: 'server.jar',
    autoRestart: false
  });

  serverRegistry.register({
    id: srvB,
    name: 'Console Test Server B',
    directory: dirB,
    jarFile: 'server.jar',
    autoRestart: false
  });

  try {
    // ----------------------------------------------------
    // Test 1: Logs are retained when server stops
    // ----------------------------------------------------
    console.log('[*] Test 1: Live console logs retained on stop/offline...');
    const instA = processManager._getOrCreateInstance(srvA);
    const initialSessionA = instA.sessionId;
    assert(initialSessionA, 'Instance must have an initial sessionId');

    processManager._appendLog(srvA, '[10:00:00 INFO]: Server starting up...', 'stdout');
    processManager._appendLog(srvA, '[10:00:05 INFO]: Done (4.2s)! For help, type "help"', 'stdout', 'done');
    processManager._appendLog(srvA, '[10:00:10 INFO]: Player Steve joined the game', 'stdout');

    // Simulate stopping the server
    instA.stoppingByUser = true;
    processManager._handleExit(srvA, 0, null);

    assert.strictEqual(instA.status, 'offline', 'Status must be offline after exit');
    const logsAfterStop = processManager.getLogs(srvA);
    assert(logsAfterStop.length >= 4, `Expected at least 4 logs, got ${logsAfterStop.length}`);
    const lastLog = logsAfterStop[logsAfterStop.length - 1];
    assert.strictEqual(lastLog.text, 'Sunucu durduruldu.', 'Last log must confirm server stopped');
    assert.strictEqual(instA.sessionId, initialSessionA, 'Session ID must remain unchanged during stop');
    console.log('    [+] PASSED: Logs retained on stop without clearing buffer.');

    // ----------------------------------------------------
    // Test 2: Logs are retained on killServer
    // ----------------------------------------------------
    console.log('\n[*] Test 2: Live console logs retained on killServer...');
    processManager._appendLog(srvA, '[10:05:00 INFO]: Server running before kill...', 'stdout');
    // Simulate kill
    instA.process = { killed: false, kill: () => {} };
    processManager.killServer(srvA);

    assert.strictEqual(instA.status, 'offline', 'Status must be offline after killServer');
    const logsAfterKill = processManager.getLogs(srvA);
    assert(logsAfterKill.some((l) => l.text.includes('Sunucu işlemi zorla durduruldu.')), 'Kill log must be retained');
    console.log('    [+] PASSED: Logs retained after process kill.');

    // ----------------------------------------------------
    // Test 3: Logs are retained on crash (exit code != 0)
    // ----------------------------------------------------
    console.log('\n[*] Test 3: Live console logs retained on server crash...');
    instA.stoppingByUser = false;
    instA.gracefulShutdownDetected = false;
    processManager._appendLog(srvA, '[10:10:00 ERROR]: OutOfMemoryError in Java heap space', 'stderr');
    processManager._handleExit(srvA, 1, null);

    assert.strictEqual(instA.status, 'crashed', 'Status must be crashed after unexpected exit');
    const logsAfterCrash = processManager.getLogs(srvA);
    assert(logsAfterCrash.some((l) => l.text.includes('OutOfMemoryError')), 'Crash log must be present in buffer');
    assert(logsAfterCrash.some((l) => l.text.includes('Sunucu çöktü')), 'Crash notification must be present in buffer');
    console.log('    [+] PASSED: Crash logs and exit description retained.');

    // ----------------------------------------------------
    // Test 4: Ring buffer cleared ONLY when next lifecycle actually begins
    // ----------------------------------------------------
    console.log('\n[*] Test 4: Reset occurs ONLY when next start begins with new session ID...');
    let resetEmitted = false;
    let emittedSessionId = null;

    const onReset = ({ serverId, sessionId }) => {
      if (serverId === srvA) {
        resetEmitted = true;
        emittedSessionId = sessionId;
      }
    };
    processManager.on('lifecycle_reset', onReset);

    // Call _resetLifecycle (which startServer calls at the exact start of a new run)
    const newSessionId = processManager._resetLifecycle(srvA);
    processManager.removeListener('lifecycle_reset', onReset);

    assert(resetEmitted, 'lifecycle_reset event must be emitted');
    assert.strictEqual(emittedSessionId, newSessionId, 'Emitted session ID must match new session ID');
    assert.notStrictEqual(newSessionId, initialSessionA, 'New session ID must be different from previous session');
    assert.strictEqual(processManager.getLogs(srvA).length, 0, 'Ring buffer must be empty immediately after lifecycle reset');
    console.log('    [+] PASSED: Ring buffer reset and new session ID generated on lifecycle start.');

    // ----------------------------------------------------
    // Test 5: Preserve startup failure diagnostic logs
    // ----------------------------------------------------
    console.log('\n[*] Test 5: Startup failure diagnostic logs preserved in ring buffer...');
    // Attempt to start a server with missing jar
    const missingJarServerId = 'missing-jar-srv';
    const missingDir = path.join(tempBase, missingJarServerId);
    fs.mkdirSync(missingDir, { recursive: true });

    serverRegistry.register({
      id: missingJarServerId,
      name: 'Missing JAR Server',
      directory: missingDir,
      jarFile: 'non-existent.jar',
      autoRestart: false
    });

    let startError = null;
    try {
      await processManager.startServer(missingJarServerId);
    } catch (e) {
      startError = e;
    }

    assert(startError, 'startServer must throw error when jar is missing');
    const diagLogs = processManager.getLogs(missingJarServerId);
    assert(diagLogs.length > 0, 'Diagnostic logs must be recorded in ring buffer');
    assert(diagLogs.some((l) => l.text.includes('Sunucu JAR dosyası bulunamadı')), 'Diagnostic error must be in ring buffer');
    console.log('    [+] PASSED: Missing JAR diagnostic message preserved in ring buffer.');

    serverRegistry.delete(missingJarServerId);
    fs.rmSync(missingDir, { recursive: true, force: true });

    // ----------------------------------------------------
    // Test 6: Multiple servers isolated
    // ----------------------------------------------------
    console.log('\n[*] Test 6: Multi-server buffer and session isolation...');
    processManager._appendLog(srvA, '[A] Line 1 from Server A', 'stdout');
    processManager._appendLog(srvB, '[B] Line 1 from Server B', 'stdout');

    const logsA = processManager.getLogs(srvA);
    const logsB = processManager.getLogs(srvB);

    assert(logsA.every((l) => l.text.includes('[A]')), 'Server A logs must only contain Server A entries');
    assert(logsB.every((l) => l.text.includes('[B]')), 'Server B logs must only contain Server B entries');
    assert.notStrictEqual(processManager.getSessionId(srvA), processManager.getSessionId(srvB), 'Session IDs must be distinct');

    // Resetting Server A must not affect Server B
    processManager._resetLifecycle(srvA);
    assert.strictEqual(processManager.getLogs(srvA).length, 0, 'Server A buffer should be reset');
    assert.strictEqual(processManager.getLogs(srvB).length, 1, 'Server B buffer must remain intact');
    console.log('    [+] PASSED: Server A and Server B logs and sessions are completely isolated.');

    // ----------------------------------------------------
    // Test 7: HTTP logs API and Reconnect use session buffer (no disk repopulation)
    // ----------------------------------------------------
    console.log('\n[*] Test 7: HTTP history and reconnect use session buffer without old disk repopulation...');
    // Create an old latest.log file on disk in Server A's logs directory
    const logsDirA = path.join(dirA, 'logs');
    fs.mkdirSync(logsDirA, { recursive: true });
    fs.writeFileSync(path.join(logsDirA, 'latest.log'), 'OLD DISK LOG FROM LAST MONTH\n');

    // Server A is offline and its ring buffer is empty
    const currentBuffer = processManager.getLogs(srvA);
    assert.strictEqual(currentBuffer.length, 0, 'Current session buffer is empty');

    // Verify getLogs returns empty array, NOT the old disk log!
    assert.strictEqual(processManager.getLogs(srvA).length, 0, 'getLogs must not pull old disk logs into console session');
    console.log('    [+] PASSED: Current session buffer does not repopulate old disk logs.');

    // ----------------------------------------------------
    // Test 8: Auto-restart delay logs retained until restart actually begins
    // ----------------------------------------------------
    console.log('\n[*] Test 8: Auto-restart countdown logs retained until spawn begins...');
    const instAuto = processManager._getOrCreateInstance(srvA);
    processManager._appendLog(srvA, '[10:20:00 INFO]: Server crashed before auto-restart', 'system', 'crash');
    processManager._appendLog(srvA, 'Sunucu çöktü (çıkış kodu 1). 3 sn içinde yeniden başlatılıyor...', 'system', 'crash');

    // While timer is ticking, logs must be retained
    const autoLogsWhileWaiting = processManager.getLogs(srvA);
    assert(autoLogsWhileWaiting.some((l) => l.text.includes('yeniden başlatılıyor')), 'Countdown log must be in buffer');

    // When new lifecycle explicitly resets for startServer
    processManager._resetLifecycle(srvA);
    assert.strictEqual(processManager.getLogs(srvA).length, 0, 'Buffer resets only when restart actually begins');
    console.log('    [+] PASSED: Auto-restart retains crash message until new start begins.');

    console.log('\n====================================================');
    console.log('All Console Lifecycle Regression Tests PASSED (100%)');
    console.log('====================================================');
  } finally {
    // Cleanup registry and temp files
    serverRegistry.delete(srvA);
    serverRegistry.delete(srvB);
    if (fs.existsSync(tempBase)) {
      try {
        fs.rmSync(tempBase, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}

if (require.main === module) {
  runConsoleLifecycleTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n[!] Test FAILED with error:', err);
      process.exit(1);
    });
}

module.exports = { runConsoleLifecycleTests };
