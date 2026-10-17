const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const processManager = require('../src/servers/processManager');
const serverRegistry = require('../src/servers/serverRegistry');
const javaDetector = require('../src/system/javaDetector');

async function testLifecycle() {
  console.log('--- Testing Full Process Lifecycle with Genuine Java Execution ---');

  const testDir = '/mazideveloper/temp/test_lifecycle_server';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  // 1. Create Java source file
  const javaSrc = [
    'import java.io.BufferedReader;',
    'import java.io.InputStreamReader;',
    'public class TestServer {',
    '    public static void main(String[] args) throws Exception {',
    '        System.out.println("[Server thread/INFO]: Starting test server version 1.21.1");',
    '        System.out.println("[Server thread/INFO]: Done (0.850s)! For help, type \\"help\\"");',
    '        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));',
    '        String line;',
    '        while ((line = in.readLine()) != null) {',
    '            System.out.println("[Server thread/INFO]: Executed: " + line);',
    '            if (line.trim().equalsIgnoreCase("stop")) {',
    '                System.out.println("[Server thread/INFO]: Stopping server and saving data...");',
    '                break;',
    '            }',
    '        }',
    '    }',
    '}'
  ].join('\n');

  fs.writeFileSync(path.join(testDir, 'TestServer.java'), javaSrc, 'utf8');

  // Compile with Java 27 or Java 21
  const javacPath = fs.existsSync('/usr/lib/jvm/jdk-27-oracle-x64/bin/javac')
    ? '/usr/lib/jvm/jdk-27-oracle-x64/bin/javac'
    : 'javac';
  const jarPath = fs.existsSync('/usr/lib/jvm/jdk-27-oracle-x64/bin/jar')
    ? '/usr/lib/jvm/jdk-27-oracle-x64/bin/jar'
    : 'jar';

  execSync(`"${javacPath}" TestServer.java`, { cwd: testDir });
  execSync(`"${jarPath}" cfe test-purpur.jar TestServer TestServer.class`, { cwd: testDir });

  console.log('[+] Mock purpur JAR created successfully.');

  // 2. Register server
  const testServerId = 'lifecycle-test-srv';
  serverRegistry.register({
    id: testServerId,
    name: 'Lifecycle Test Server',
    directory: testDir,
    jarFile: 'test-purpur.jar',
    javaPath: '/usr/lib/jvm/jdk-27-oracle-x64/bin/java',
    minRam: '256M',
    maxRam: '512M',
    port: 25591,
    autoRestart: false
  });

  console.log('[+] Server registered in registry.');

  // 3. Start server
  console.log('[*] Spawning server process...');
  const spawnRes = await processManager.startServer(testServerId);
  console.log(`[+] Process spawned with PID: ${spawnRes.pid}`);

  // Wait 1.5 seconds for "Done!" log to trigger 'online' status
  await new Promise((r) => setTimeout(r, 1500));

  const statusAfterStart = processManager.getStatus(testServerId);
  console.log(`[+] Server status after startup: ${statusAfterStart.status} (expected: online)`);
  if (statusAfterStart.status !== 'online') {
    throw new Error(`Expected status online, got: ${statusAfterStart.status}`);
  }

  // 4. Send command
  console.log('[*] Sending console command: "say Hello from maziPanel"...');
  processManager.sendCommand(testServerId, 'say Hello from maziPanel');

  // Wait 500ms
  await new Promise((r) => setTimeout(r, 500));

  // Check logs
  const logs = processManager.getLogs(testServerId, 20);
  console.log('[+] Console logs received:');
  logs.forEach((l) => console.log(`    [${l.type}] ${l.text}`));

  const hasExecutedCmd = logs.some((l) => l.text.includes('Executed: say Hello from maziPanel'));
  if (!hasExecutedCmd) {
    throw new Error('Command execution was not reflected in server output!');
  }
  console.log('[+] Console command verified in log stream!');

  // 5. Stop server gracefully
  console.log('[*] Sending graceful stop command...');
  const stopRes = await processManager.stopServer(testServerId, 5000);
  console.log(`[+] Stop response: ${JSON.stringify(stopRes)}`);

  const statusAfterStop = processManager.getStatus(testServerId);
  console.log(`[+] Server status after stop: ${statusAfterStop.status} (expected: offline)`);
  if (statusAfterStop.status !== 'offline') {
    throw new Error(`Expected status offline, got: ${statusAfterStop.status}`);
  }

  // 6. Cleanup
  serverRegistry.delete(testServerId);
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('[+] Lifecycle test completed successfully with 100% PASS!');
}

if (require.main === module) {
  testLifecycle()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Lifecycle Test Failed:', err);
      process.exit(1);
    });
}
