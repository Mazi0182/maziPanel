const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const processManager = require('../src/servers/processManager');
const serverRegistry = require('../src/servers/serverRegistry');

async function testPanelRestartPersistence() {
  console.log('--- Testing Zero-Downtime Minecraft Server Persistence Across Panel Restarts ---');

  const baseServersDir = process.env.SERVERS_DIR || config.SERVERS_DIR;
  const testServerId = `persist-test-${Date.now()}`;
  const testDir = path.join(baseServersDir, testServerId);

  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  const javaSrc = [
    'import java.io.BufferedReader;',
    'import java.io.InputStreamReader;',
    'public class PersistTestServer {',
    '    public static void main(String[] args) throws Exception {',
    '        System.out.println("[Server thread/INFO]: Starting PersistTestServer version 1.21.1");',
    '        System.out.println("[Server thread/INFO]: Done (0.420s)! For help, type \\"help\\"");',
    '        System.out.println("[Server thread/INFO]: TestPlayer[/127.0.0.1:54321] logged in with entity id 12 at ([world] 0.0, 64.0, 0.0)");',
    '        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));',
    '        String line;',
    '        while ((line = in.readLine()) != null) {',
    '            System.out.println("[Server thread/INFO]: Executed: " + line);',
    '            if (line.trim().equalsIgnoreCase("stop")) {',
    '                System.out.println("[Server thread/INFO]: Stopping server");',
    '                break;',
    '            }',
    '        }',
    '    }',
    '}'
  ].join('\n');

  fs.writeFileSync(path.join(testDir, 'PersistTestServer.java'), javaSrc, 'utf8');

  const javacPath = fs.existsSync('/usr/lib/jvm/jdk-27-oracle-x64/bin/javac')
    ? '/usr/lib/jvm/jdk-27-oracle-x64/bin/javac'
    : 'javac';
  const jarPath = fs.existsSync('/usr/lib/jvm/jdk-27-oracle-x64/bin/jar')
    ? '/usr/lib/jvm/jdk-27-oracle-x64/bin/jar'
    : 'jar';
  const javaPath = fs.existsSync('/usr/lib/jvm/jdk-27-oracle-x64/bin/java')
    ? '/usr/lib/jvm/jdk-27-oracle-x64/bin/java'
    : '';

  execSync(`"${javacPath}" PersistTestServer.java`, { cwd: testDir });
  execSync(`"${jarPath}" cfe persist-test.jar PersistTestServer PersistTestServer.class`, { cwd: testDir });

  serverRegistry.register({
    id: testServerId,
    name: 'Persistence Test Server',
    directory: testDir,
    jarFile: 'persist-test.jar',
    javaPath,
    minRam: '128M',
    maxRam: '256M',
    port: 25594,
    autoRestart: false
  });

  try {
    // 1. Start server
    const spawnRes = await processManager.startServer(testServerId);
    const initialPid = spawnRes.pid;
    if (!initialPid || typeof initialPid !== 'number') {
      throw new Error(`Expected valid numeric Java PID, got: ${initialPid}`);
    }

    // Wait for Done! and player join output
    const waitOnlineDeadline = Date.now() + 5000;
    while (Date.now() < waitOnlineDeadline) {
      const st = processManager.getStatus(testServerId);
      if (st.status === 'online' && st.onlinePlayers.includes('TestPlayer')) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const beforeStatus = processManager.getStatus(testServerId);
    if (beforeStatus.status !== 'online') {
      throw new Error(`Expected status online before restart, got: ${beforeStatus.status}`);
    }
    if (!beforeStatus.onlinePlayers.includes('TestPlayer')) {
      throw new Error(`Expected TestPlayer in onlinePlayers, got: ${JSON.stringify(beforeStatus.onlinePlayers)}`);
    }

    const initialSessionId = beforeStatus.sessionId;
    const initialInst = processManager.instances.get(testServerId);
    const initialStartTime = initialInst.startTime;

    // 2. Send a command before panel restart
    processManager.sendCommand(testServerId, 'say Before Panel Restart');
    await new Promise((r) => setTimeout(r, 300));

    const beforeLogs = processManager.getLogs(testServerId, 50);
    if (!beforeLogs.some((l) => l.text.includes('Executed: say Before Panel Restart'))) {
      throw new Error('Command before panel restart was not reflected in logs!');
    }

    // 3. Simulate Panel Service Restart (detachAll -> clear in-memory instances -> recoverRunningServers)
    console.log('[*] Simulating mazipanel.service restart (detachAll + fresh instances + recoverRunningServers)...');
    await processManager.detachAll();
    processManager.instances.clear();

    if (processManager.isRunning(testServerId)) {
      throw new Error('Expected in-memory instance to be cleared before recovery');
    }

    const recoveredCount = await processManager.recoverRunningServers();
    if (recoveredCount < 1) {
      throw new Error(`Expected at least 1 recovered server, got: ${recoveredCount}`);
    }

    // 4. Verify recovered state matches 100% with zero interruption
    const afterStatus = processManager.getStatus(testServerId);
    const afterInst = processManager.instances.get(testServerId);

    if (afterStatus.status !== 'online') {
      throw new Error(`Expected recovered status to be online, got: ${afterStatus.status}`);
    }
    if (afterStatus.pid !== initialPid) {
      throw new Error(`Expected Java PID to remain ${initialPid}, got: ${afterStatus.pid}`);
    }
    if (afterStatus.sessionId !== initialSessionId) {
      throw new Error(`Expected sessionId to remain ${initialSessionId}, got: ${afterStatus.sessionId}`);
    }
    if (afterInst.startTime !== initialStartTime) {
      throw new Error(`Expected startTime to remain ${initialStartTime}, got: ${afterInst.startTime}`);
    }
    if (!afterStatus.onlinePlayers.includes('TestPlayer')) {
      throw new Error(`Expected TestPlayer to remain in onlinePlayers after recovery, got: ${JSON.stringify(afterStatus.onlinePlayers)}`);
    }
    if (!afterStatus.playerEndpoints || !afterStatus.playerEndpoints.testplayer || afterStatus.playerEndpoints.testplayer.port !== 54321) {
      throw new Error(`Expected playerEndpoints for testplayer to be preserved, got: ${JSON.stringify(afterStatus.playerEndpoints)}`);
    }

    const recoveredLogs = processManager.getLogs(testServerId, 50);
    if (!recoveredLogs.some((l) => l.text.includes('Executed: say Before Panel Restart'))) {
      throw new Error('Logs from before panel restart were not preserved across recovery!');
    }

    // 5. Send a new command AFTER panel restart to prove stdin & stdout pipes are still live
    console.log('[*] Sending console command after panel restart...');
    processManager.sendCommand(testServerId, 'say After Panel Restart');
    await new Promise((r) => setTimeout(r, 300));

    const postCommandLogs = processManager.getLogs(testServerId, 50);
    if (!postCommandLogs.some((l) => l.text.includes('Executed: say After Panel Restart'))) {
      throw new Error('Command sent after panel restart was not executed by the recovered server!');
    }

    // 6. Stop server gracefully after recovery
    console.log('[*] Stopping recovered server gracefully...');
    await processManager.stopServer(testServerId, 5000);

    const finalStatus = processManager.getStatus(testServerId);
    if (finalStatus.status !== 'offline') {
      throw new Error(`Expected final status offline, got: ${finalStatus.status}`);
    }

    console.log('[+] Zero-downtime panel restart persistence test PASSED 100%!');
  } finally {
    try {
      await processManager.stopServer(testServerId, 2000);
    } catch (e) {}
    try {
      serverRegistry.delete(testServerId);
    } catch (e) {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

if (require.main === module) {
  testPanelRestartPersistence()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Panel Restart Persistence Test Failed:', err);
      process.exit(1);
    });
}

module.exports = { testPanelRestartPersistence };
