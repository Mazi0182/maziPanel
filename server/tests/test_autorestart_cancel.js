const processManager = require('../src/servers/processManager');
const serverRegistry = require('../src/servers/serverRegistry');
const fs = require('fs');
const path = require('path');

async function testAutoRestartCancellation() {
  console.log('--- Testing Auto-Restart Cancellation on User Stop ---');
  const testId = 'autorestart-test-srv';
  const testDir = '/mazideveloper/temp/test_autorestart';
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'server.jar'), 'PK\x05\x06' + '\x00'.repeat(18));

  serverRegistry.register({
    id: testId,
    name: 'AutoRestart Test',
    directory: testDir,
    jarFile: 'server.jar',
    autoRestart: true
  });

  const inst = processManager._getOrCreateInstance(testId);
  // Simulate an unexpected crash exit while running
  inst.process = { killed: false };
  processManager._handleExit(testId, 1, null);

  console.log(`[+] Status immediately after crash: ${inst.status} (expected: starting)`);
  console.log(`[+] Restart timer active: ${!!inst.restartTimer} (expected: true)`);

  if (!inst.restartTimer) {
    throw new Error('restartTimer was not scheduled!');
  }

  // Issue stopServer before the 3 second timer fires
  console.log('[*] Issuing stopServer before 3s restart timeout fires...');
  await processManager.stopServer(testId);

  console.log(`[+] Status after stopServer: ${inst.status} (expected: offline)`);
  console.log(`[+] Restart timer after stop: ${inst.restartTimer} (expected: null)`);

  if (inst.restartTimer !== null) {
    throw new Error('restartTimer was NOT cancelled by stopServer!');
  }

  // Wait 4 seconds to guarantee the timer does not fire in the background
  console.log('[*] Waiting 4 seconds to verify no resurrection occurred...');
  await new Promise((r) => setTimeout(r, 4000));

  console.log(`[+] Status after 4s wait: ${inst.status} (expected: offline)`);
  if (inst.status !== 'offline') {
    throw new Error(`Server resurrected unexpectedly with status: ${inst.status}`);
  }

  serverRegistry.delete(testId);
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('[+] Auto-restart cancellation test completed successfully with 100% PASS!');
}

if (require.main === module) {
  testAutoRestartCancellation()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Test Failed:', err);
      process.exit(1);
    });
}

module.exports = { testAutoRestartCancellation };
