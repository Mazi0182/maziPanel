const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Load ACTUAL implementation from client/src/utils/routes.ts using existing TypeScript compiler
const ts = require('../../client/node_modules/typescript');
const routesTsPath = path.resolve(__dirname, '../../client/src/utils/routes.ts');
assert(fs.existsSync(routesTsPath), `routes.ts must exist at ${routesTsPath}`);

const tsSource = fs.readFileSync(routesTsPath, 'utf8');
const { outputText } = ts.transpileModule(tsSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
});
const routesModule = { exports: {} };
const fn = new Function('module', 'exports', outputText);
fn(routesModule, routesModule.exports);

const { parseRoute, buildPath } = routesModule.exports;
assert.strictEqual(typeof parseRoute, 'function', 'parseRoute must be exported from routes.ts');
assert.strictEqual(typeof buildPath, 'function', 'buildPath must be exported from routes.ts');

// Import backend file manager and server registry for backend resolution checks
const fileManager = require('../src/servers/fileManager');
const serverRegistry = require('../src/servers/serverRegistry');

async function runRoutingNavigationTests() {
  console.log('========================================================');
  console.log('   Focused Regression Test: Actual Routing & Navigation ');
  console.log('========================================================');

  // --- TEST 1: Global Tabs Route Parsing (using actual parseRoute) ---
  console.log('[*] Test 1: Global Tabs Route Parsing (from client/src/utils/routes.ts)');
  assert.deepStrictEqual(parseRoute('/'), {});
  assert.deepStrictEqual(parseRoute('///'), {});
  assert.deepStrictEqual(parseRoute('/servers'), { tab: 'servers' });
  assert.deepStrictEqual(parseRoute('/system'), { tab: 'system' });
  assert.deepStrictEqual(parseRoute('/integrations'), { tab: 'integrations' });
  assert.deepStrictEqual(parseRoute('/settings'), { tab: 'settings' });
  console.log('    PASS: Global routes parsed accurately without misinterpreting serverId');

  // --- TEST 2: Server Subtabs and Route Parsing ---
  console.log('[*] Test 2: Server Subtabs and Route Parsing (from client/src/utils/routes.ts)');
  assert.deepStrictEqual(parseRoute('/srv-alpha'), { serverId: 'srv-alpha', tab: 'console', filePath: undefined });
  assert.deepStrictEqual(parseRoute('/srv-alpha/console'), { serverId: 'srv-alpha', tab: 'console', filePath: undefined });
  assert.deepStrictEqual(parseRoute('/srv-alpha/dashboard'), { serverId: 'srv-alpha', tab: 'console', filePath: undefined });
  assert.deepStrictEqual(parseRoute('/srv-alpha/logs'), { serverId: 'srv-alpha', tab: 'logs', filePath: undefined });
  assert.deepStrictEqual(parseRoute('/srv-alpha/players'), { serverId: 'srv-alpha', tab: 'players', filePath: undefined });
  assert.deepStrictEqual(parseRoute('/srv-alpha/backups'), { serverId: 'srv-alpha', tab: 'backups', filePath: undefined });
  assert.deepStrictEqual(parseRoute('/srv-alpha/settings'), { serverId: 'srv-alpha', tab: 'server_settings', filePath: undefined });
  assert.deepStrictEqual(parseRoute('/srv-alpha/files'), { serverId: 'srv-alpha', tab: 'files', filePath: undefined });
  console.log('    PASS: Server subtabs parse correctly with valid mappings');

  // --- TEST 3: Deep Link File and Folder Path Parsing ---
  console.log('[*] Test 3: Deep Link File and Folder Path Parsing (from client/src/utils/routes.ts)');
  assert.deepStrictEqual(parseRoute('/srv-alpha/files/plugins'), { serverId: 'srv-alpha', tab: 'files', filePath: 'plugins' });
  assert.deepStrictEqual(parseRoute('/srv-alpha/files/plugins/WorldEdit'), { serverId: 'srv-alpha', tab: 'files', filePath: 'plugins/WorldEdit' });
  assert.deepStrictEqual(parseRoute('/srv-alpha/files/1.20.4/config.d'), { serverId: 'srv-alpha', tab: 'files', filePath: '1.20.4/config.d' });
  assert.deepStrictEqual(parseRoute('/srv-alpha/files/bin/run-service'), { serverId: 'srv-alpha', tab: 'files', filePath: 'bin/run-service' });
  assert.deepStrictEqual(parseRoute('/srv-alpha/files/My%20Folder/custom%20config.yml'), {
    serverId: 'srv-alpha',
    tab: 'files',
    filePath: 'My Folder/custom config.yml'
  });
  console.log('    PASS: File paths with dots, spaces, or no extension parse identically');

  // --- TEST 4: buildPath and File URL Invariant Across Other Tabs ---
  console.log('[*] Test 4: File URL Invariant - A file URL must not remain while another tab is shown');
  assert.strictEqual(buildPath('console', 'srv-1', 'plugins/config.yml'), '/srv-1/console');
  assert.strictEqual(buildPath('players', 'srv-1', 'world/level.dat'), '/srv-1/players');
  assert.strictEqual(buildPath('backups', 'srv-1', 'server.properties'), '/srv-1/backups');
  assert.strictEqual(buildPath('server_settings', 'srv-1', 'paper.yml'), '/srv-1/settings');
  assert.strictEqual(buildPath('servers', 'srv-1', 'plugins'), '/servers');
  assert.strictEqual(buildPath('system', 'srv-1', 'logs/latest.log'), '/system');
  assert.strictEqual(buildPath('integrations', 'srv-1', 'config.json'), '/integrations');

  // Files tab correctly encodes and preserves path
  assert.strictEqual(buildPath('files', 'srv-1', 'plugins/config.yml'), '/srv-1/files/plugins/config.yml');
  assert.strictEqual(buildPath('files', 'srv-1', ''), '/srv-1/files');
  assert.strictEqual(buildPath('files', 'srv-1', undefined), '/srv-1/files');
  assert.strictEqual(buildPath('files', 'srv-1', 'folder with space/my file.txt'), '/srv-1/files/folder%20with%20space/my%20file.txt');
  console.log('    PASS: File URL invariant is strictly enforced across all non-files tabs');

  // --- TEST 5: Cross-Server Deep Links & History Navigation Invariant ---
  console.log('[*] Test 5: Cross-Server Deep Links & Popstate Invariant');
  // Simulating popstate between different server IDs with deep links
  const popRoute1 = parseRoute('/srv-1/console');
  assert.strictEqual(popRoute1.serverId, 'srv-1');
  assert.strictEqual(popRoute1.tab, 'console');
  assert.strictEqual(popRoute1.filePath, undefined);

  const popRoute2 = parseRoute('/srv-2/files/config/paper.yml');
  assert.strictEqual(popRoute2.serverId, 'srv-2');
  assert.strictEqual(popRoute2.tab, 'files');
  assert.strictEqual(popRoute2.filePath, 'config/paper.yml');

  // Server selection explicit navigation clears filePath
  const switchedPath = buildPath('files', 'srv-3', '');
  assert.strictEqual(switchedPath, '/srv-3/files');
  console.log('    PASS: Cross-server history and deep link routes retain accurate per-server targets');

  // --- TEST 6: Dot-Agnostic Backend File vs Directory Detection ---
  console.log('[*] Test 6: Backend Detection - Directories with dots vs Files without extension');
  const tempTestDir = path.join(os.tmpdir(), `routing-test-${Date.now()}`);
  fs.mkdirSync(tempTestDir, { recursive: true });

  const testServerId = `test-srv-${Date.now()}`;
  const origGetById = serverRegistry.getById;
  serverRegistry.getById = (id) => {
    if (id === testServerId) {
      return { id: testServerId, name: 'Routing Test Server', directory: tempTestDir };
    }
    return origGetById.call(serverRegistry, id);
  };

  try {
    // Create a directory containing dots: e.g. "1.20.4-config.d"
    const dirWithDots = path.join(tempTestDir, '1.20.4-config.d');
    fs.mkdirSync(dirWithDots, { recursive: true });
    fs.writeFileSync(path.join(dirWithDots, 'child.txt'), 'hello', 'utf8');

    // Create a file without extension: e.g. "LICENSE"
    const fileNoExt = path.join(tempTestDir, 'LICENSE');
    fs.writeFileSync(fileNoExt, 'MIT License Content', 'utf8');

    // 1. Verify listFiles on directory with dots succeeds (proves it is a directory)
    const listDirResult = fileManager.listFiles(testServerId, '1.20.4-config.d');
    const entries = Array.isArray(listDirResult) ? listDirResult : (listDirResult.entries || []);
    assert(entries.length > 0, 'Directory with dots must be listable');
    assert.strictEqual(entries[0].name, 'child.txt');

    // 2. Verify listFiles on file with no extension throws "not a directory"
    assert.throws(
      () => {
        fileManager.listFiles(testServerId, 'LICENSE');
      },
      (err) => {
        return err.message.toLowerCase().includes('not a directory');
      },
      'listFiles on a file with no extension must throw "not a directory"'
    );

    // 3. Verify readFileContent on file with no extension succeeds
    const fileContent = fileManager.readFileContent(testServerId, 'LICENSE');
    assert.strictEqual(fileContent.content, 'MIT License Content');

    // 4. Verify readFileContent on directory with dots throws error indicating it is a directory
    assert.throws(
      () => {
        fileManager.readFileContent(testServerId, '1.20.4-config.d');
      },
      (err) => {
        return err.message.toLowerCase().includes('directory');
      },
      'readFileContent on a directory must throw an error indicating directory'
    );

    console.log('    PASS: Extension-agnostic resolution succeeds: dots in folders and extensionless files handled accurately');
  } finally {
    serverRegistry.getById = origGetById;
    try {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    } catch {}
  }

  console.log('========================================================');
  console.log('   ALL ROUTING AND NAVIGATION REGRESSION TESTS PASSED!  ');
  console.log('========================================================');
}

runRoutingNavigationTests().catch((err) => {
  console.error('[FAIL] Routing regression test failed:', err);
  process.exit(1);
});
