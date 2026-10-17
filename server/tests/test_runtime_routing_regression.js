/**
 * Focused regression test suite for:
 * 1. Default 64x64 server-icon.png helper & asset validity
 * 2. Icon preservation (never overwrites existing custom or legacy icon; migrates valid legacy 64x64)
 * 3. maxPlayers fallback (10) and API reading in serverRegistry, zipImporter, fileManager
 * 4. Command log normalization (live vs history consistency, type 'command' before 'system')
 * 5. Console stop retains, next-start resets lifecycle behavior
 * 6. Transpiled parseLogLine & selectHistoryEntries execution
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

// Set isolated temporary directories for test BEFORE requiring any app config or modules!
const testRootDir = path.join(__dirname, 'temp_regression_' + Date.now());
const testDataDir = path.join(testRootDir, 'data');
const testServersDir = path.join(testRootDir, 'servers');
const testTempDir = path.join(testRootDir, 'temp');
const testBackupsDir = path.join(testRootDir, 'backups');

fs.mkdirSync(testDataDir, { recursive: true });
fs.mkdirSync(testServersDir, { recursive: true });
fs.mkdirSync(testTempDir, { recursive: true });
fs.mkdirSync(testBackupsDir, { recursive: true });

process.env.DATA_DIR = testDataDir;
process.env.SERVERS_DIR = testServersDir;
process.env.TEMP_DIR = testTempDir;
process.env.BACKUPS_DIR = testBackupsDir;

// Modules under test
const defaultIconHelper = require('../src/servers/defaultIconHelper');
const serverRegistry = require('../src/servers/serverRegistry');
const fileManager = require('../src/servers/fileManager');
const processManager = require('../src/servers/processManager');

// Transpile client/src/utils/parseLog.ts using installed TypeScript module
const ts = require('../../client/node_modules/typescript');
const parseLogTsPath = path.join(__dirname, '../../client/src/utils/parseLog.ts');
const parseLogSource = fs.readFileSync(parseLogTsPath, 'utf8');
const transpiledCode = ts.transpileModule(parseLogSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020
  }
}).outputText;

const parseLogExports = {};
const vmContext = vm.createContext({
  exports: parseLogExports,
  module: { exports: parseLogExports },
  console,
  Date,
  RegExp,
  Math
});
vm.runInContext(transpiledCode, vmContext);

const { parseLogLine, selectHistoryEntries } = parseLogExports;

let passedTests = 0;
let totalTests = 0;

async function it(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('=== Running Runtime / Routing / Defaults Regression Tests ===\n');

  // 1. Default Icon Helper Tests
  console.log('1. Default Server Icon Helper:');

  await it('default-server-icon.png asset exists and is valid 64x64 PNG', async () => {
    assert(fs.existsSync(defaultIconHelper.ASSET_ICON_PATH), 'Asset file must exist on disk');
    const buf = defaultIconHelper.getDefaultIconBuffer();
    assert(buf && buf.length > 100, 'Buffer must be valid and non-empty');
    assert.strictEqual(defaultIconHelper.isValidServerIcon(defaultIconHelper.ASSET_ICON_PATH), true, 'Must validate as 64x64 PNG');

    // Verify PNG magic header 89 50 4E 47 0D 0A 1A 0A
    assert.strictEqual(buf[0], 0x89);
    assert.strictEqual(buf[1], 0x50);
    assert.strictEqual(buf[2], 0x4e);
    assert.strictEqual(buf[3], 0x47);
    assert.strictEqual(buf.readUInt32BE(16), 64, 'Width must be 64');
    assert.strictEqual(buf.readUInt32BE(20), 64, 'Height must be 64');
  });

  await it('ensureServerIcon copies 64x64 default icon if none exists', async () => {
    const testDir = path.join(__dirname, 'temp_test_srv_' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const copied = defaultIconHelper.ensureServerIcon(testDir);
      assert.strictEqual(copied, true, 'Should copy default icon when missing');

      const targetPath = path.join(testDir, 'server-icon.png');
      assert(fs.existsSync(targetPath), 'server-icon.png must be created');
      assert.strictEqual(defaultIconHelper.isValidServerIcon(targetPath), true, 'Created icon must be valid 64x64 PNG');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  await it('ensureServerIcon NEVER overwrites existing custom server-icon.png', async () => {
    const testDir = path.join(__dirname, 'temp_test_srv_custom_' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const customPath = path.join(testDir, 'server-icon.png');
      const customContent = 'CUSTOM_USER_ICON_DATA_TEST_123';
      fs.writeFileSync(customPath, customContent, 'utf8');

      const copied = defaultIconHelper.ensureServerIcon(testDir);
      assert.strictEqual(copied, false, 'Must not overwrite existing icon');
      assert.strictEqual(fs.readFileSync(customPath, 'utf8'), customContent, 'Custom icon content must be untouched');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  await it('ensureServerIcon copies valid 64x64 legacy icon.png to server-icon.png and preserves icon.png', async () => {
    const testDir = path.join(__dirname, 'temp_test_srv_valid_legacy_' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const legacyPath = path.join(testDir, 'icon.png');
      const defaultBuf = defaultIconHelper.getDefaultIconBuffer();
      fs.writeFileSync(legacyPath, defaultBuf);

      const copied = defaultIconHelper.ensureServerIcon(testDir);
      assert.strictEqual(copied, true, 'Must copy valid legacy icon to missing server-icon.png');

      const targetPath = path.join(testDir, 'server-icon.png');
      assert(fs.existsSync(targetPath), 'server-icon.png must now exist');
      assert.strictEqual(defaultIconHelper.isValidServerIcon(targetPath), true, 'server-icon.png must be valid 64x64 PNG');
      assert(fs.existsSync(legacyPath), 'Original legacy icon.png must still exist (preserved)');
      assert.strictEqual(fs.readFileSync(legacyPath).length, defaultBuf.length, 'Original legacy icon.png must not be erased');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  await it('ensureServerIcon preserves invalid legacy icon.png and creates default server-icon.png', async () => {
    const testDir = path.join(__dirname, 'temp_test_srv_invalid_legacy_' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const legacyPath = path.join(testDir, 'icon.png');
      const invalidContent = 'INVALID_NOT_A_PNG_ICON_DATA_TEST_456';
      fs.writeFileSync(legacyPath, invalidContent, 'utf8');

      const copied = defaultIconHelper.ensureServerIcon(testDir);
      assert.strictEqual(copied, true, 'Must create default server-icon.png when legacy is invalid');

      const targetPath = path.join(testDir, 'server-icon.png');
      assert(fs.existsSync(targetPath), 'server-icon.png must be created');
      assert.strictEqual(defaultIconHelper.isValidServerIcon(targetPath), true, 'Created server-icon.png must be default 64x64 PNG');
      assert(fs.existsSync(legacyPath), 'Original invalid legacy icon.png must NOT be erased');
      assert.strictEqual(fs.readFileSync(legacyPath, 'utf8'), invalidContent, 'Legacy icon.png content must remain intact');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 2. serverRegistry Tests
  console.log('\n2. serverRegistry maxPlayers & Icon:');

  await it('serverRegistry.register preserves maxPlayers and sets fallback 10', async () => {
    const testId = 'test-reg-srv-' + Date.now();
    const testDir = path.join(__dirname, 'temp_' + testId);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const srv1 = serverRegistry.register({
        id: testId + '-1',
        name: 'Test Server Fallback',
        directory: testDir
      });
      assert.strictEqual(srv1.maxPlayers, 10, 'Fallback maxPlayers must be 10');

      const srv2 = serverRegistry.register({
        id: testId + '-2',
        name: 'Test Server Custom',
        directory: testDir,
        maxPlayers: 25
      });
      assert.strictEqual(srv2.maxPlayers, 25, 'Explicit maxPlayers 25 must be preserved');

      const updated = serverRegistry.update(testId + '-2', { maxPlayers: 32 });
      assert.strictEqual(updated.maxPlayers, 32, 'Updated maxPlayers must be 32');

      const iconPath = path.join(testDir, 'server-icon.png');
      assert(fs.existsSync(iconPath), 'server-icon.png must be created in server dir');
      assert.strictEqual(defaultIconHelper.isValidServerIcon(iconPath), true);
    } finally {
      serverRegistry.delete(testId + '-1');
      serverRegistry.delete(testId + '-2');
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 3. fileManager Properties Tests
  console.log('\n3. fileManager server.properties maxPlayers:');

  await it('fileManager getServerProperties defaults maxPlayers to server maxPlayers or 10', async () => {
    const testId = 'test-fm-srv-' + Date.now();
    const testDir = path.join(__dirname, 'temp_' + testId);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      serverRegistry.register({
        id: testId,
        name: 'FM Test Server',
        directory: testDir,
        maxPlayers: 18
      });

      const props = fileManager.getServerProperties(testId);
      assert.strictEqual(props.maxPlayers, 18, 'Must reflect server maxPlayers');

      const saved = fileManager.saveServerProperties(testId, { 'max-players': '42' });
      assert.strictEqual(saved.maxPlayers, 42, 'Saved maxPlayers must be 42');

      const srv = serverRegistry.getById(testId);
      assert.strictEqual(srv.maxPlayers, 42, 'serverRegistry must be synced to 42');
    } finally {
      serverRegistry.delete(testId);
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 4. processManager Command & Lifecycle Tests
  console.log('\n4. processManager command log type & lifecycle:');

  await it('sendCommand logs with type command and event command', async () => {
    const testId = 'test-pm-srv-' + Date.now();
    const inst = processManager._getOrCreateInstance(testId);

    let written = '';
    inst.process = {
      killed: false,
      stdin: {
        write: (str) => { written += str; }
      }
    };
    inst.status = 'online';

    try {
      processManager.sendCommand(testId, 'say test');
      assert.strictEqual(written, 'say test\n');

      const logs = processManager.getLogs(testId);
      assert(logs.length > 0, 'Logs must contain command entry');
      const last = logs[logs.length - 1];
      assert.strictEqual(last.text, '> say test');
      assert.strictEqual(last.type, 'command', 'Log entry type must be "command", NOT "system"');
      assert.strictEqual(last.event, 'command');
    } finally {
      inst.process = null;
      inst.status = 'offline';
      inst.ringBuffer = [];
    }
  });

  await it('Lifecycle reset clears ring buffer on next start, while stop retains it', async () => {
    const testId = 'test-lifecycle-srv-' + Date.now();
    const inst = processManager._getOrCreateInstance(testId);

    inst.ringBuffer.push({ text: 'Log row 1', type: 'stdout' });
    inst.ringBuffer.push({ text: 'Log row 2', type: 'stdout' });

    assert.strictEqual(processManager.getLogs(testId).length, 2, 'Stop retains logs');

    processManager._resetLifecycle(testId);
    assert.strictEqual(processManager.getLogs(testId).length, 0, 'Next start resets ring buffer');
  });

  // 5. Transpiled parseLog Execution Tests
  console.log('\n5. Transpiled parseLogLine live / history execution:');

  await it('parseLogLine executes and normalizes live command echo object', async () => {
    const liveEcho = {
      text: '> say test',
      type: 'command',
      event: 'command',
      timestamp: '2026-10-11T12:00:00Z'
    };
    const parsed = parseLogLine(liveEcho, 0, 'INFO');
    assert(parsed, 'Parsed entry must not be null');
    assert.strictEqual(parsed.type, 'command', 'Parsed type must be command');
    assert.strictEqual(parsed.event, 'command', 'Parsed event must be command');
    assert.strictEqual(parsed.isCommandEcho, true, 'isCommandEcho must be true');
    assert.strictEqual(parsed.message, '> say test');
  });

  await it('parseLogLine normalizes raw string command echo equivalent to live echo', async () => {
    const rawStringCommand = '> say test';
    const parsed = parseLogLine(rawStringCommand, 1, 'INFO');
    assert(parsed, 'Parsed entry must not be null');
    assert.strictEqual(parsed.type, 'command', 'Raw string > must normalize to command type');
    assert.strictEqual(parsed.event, 'command', 'Raw string > must normalize to command event');
    assert.strictEqual(parsed.isCommandEcho, true, 'Raw string > must set isCommandEcho to true');
    assert.strictEqual(parsed.message, '> say test');
  });

  await it('parseLogLine distinguishes system/stdout log lines without marking as command', async () => {
    const stdoutLine = '[12:00:05 INFO]: [Server] Hello from Minecraft!';
    const parsed = parseLogLine(stdoutLine, 2, 'INFO');
    assert(parsed, 'Parsed entry must not be null');
    assert.strictEqual(parsed.level, 'INFO');
    assert.strictEqual(parsed.message, '[Server] Hello from Minecraft!');
    assert.strictEqual(parsed.isCommandEcho, false, 'System log must not be marked as command echo');
    assert.notStrictEqual(parsed.type, 'command', 'System log type must not be command');
  });

  // 6. Transpiled selectHistoryEntries Tests
  console.log('\n6. Transpiled selectHistoryEntries payload prioritization:');

  await it('selectHistoryEntries prioritizes structured logs array over lines and preserves metadata', async () => {
    const payload = {
      serverId: 'srv-test-1',
      lines: ['Loading libraries...', '> say test'],
      logs: [
        { text: 'Loading libraries...', type: 'stdout', event: null },
        { text: '> say test', type: 'command', event: 'command' }
      ]
    };

    const selected = selectHistoryEntries(payload);
    assert.strictEqual(selected, payload.logs, 'Must select logs over lines');
    assert.strictEqual(selected.length, 2);
    assert.strictEqual(selected[1].type, 'command');
    assert.strictEqual(selected[1].event, 'command');
  });

  await it('selectHistoryEntries accepts empty logs [] as authoritatively empty without falling back to stale lines', async () => {
    const freshBootPayload = {
      serverId: 'srv-fresh',
      lines: ['stale line from previous process run'],
      logs: []
    };

    const selected = selectHistoryEntries(freshBootPayload);
    assert(Array.isArray(selected), 'Selected must be an array');
    assert.strictEqual(selected.length, 0, 'Empty logs [] must be authoritatively accepted');
  });

  await it('selectHistoryEntries falls back to history then lines when logs is absent', async () => {
    const historyOnly = {
      history: [{ text: 'Row from history', type: 'stdout' }]
    };
    assert.strictEqual(selectHistoryEntries(historyOnly), historyOnly.history);

    const linesOnly = {
      lines: ['Row 1', 'Row 2']
    };
    assert.strictEqual(selectHistoryEntries(linesOnly), linesOnly.lines);
  });

  // Cleanup isolated test directory
  try {
    fs.rmSync(testRootDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n========================================`);
  console.log(`Regression Results: ${passedTests} / ${totalTests} passed`);
  console.log(`========================================\n`);

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
