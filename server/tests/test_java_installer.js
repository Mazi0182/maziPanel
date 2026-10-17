const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const EventEmitter = require('events');
const express = require('express');

process.env.TEST_ENV = 'true';
process.env.NODE_ENV = 'test';

const config = require('../config');
const javaDetector = require('../src/system/javaDetector');
const javaInstaller = require('../src/system/javaInstaller');

// Lifecycle management: track all timers created during tests to ensure clean event loop exit
const originalSetInterval = global.setInterval;
const trackedIntervals = new Set();
global.setInterval = function(...args) {
  const handle = originalSetInterval.apply(this, args);
  trackedIntervals.add(handle);
  return handle;
};

function cleanupTrackedTimers() {
  for (const h of trackedIntervals) {
    clearInterval(h);
  }
  trackedIntervals.clear();
  global.setInterval = originalSetInterval;
}

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err.message);
    failedTests++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err.message);
    failedTests++;
  }
}

async function main() {
  console.log('====================================================');
  console.log('       maziPanel Java Hardened Security & Isolation Tests');
  console.log('====================================================\n');

  try {
    // Test 1: Strict Major Version Integer Parsing
    runTest('Strict Integer Parsing: Rejects "25junk", floats, negatives, accepts clean integers', () => {
      assert.strictEqual(javaInstaller.parseStrictMajorVersion(25), 25);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion('27'), 27);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion('21'), 21);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion(' 25 '), 25);

      // Rejections
      assert.strictEqual(javaInstaller.parseStrictMajorVersion('25junk'), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion('junk25'), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion(25.5), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion('25.5'), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion(-21), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion(0), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion(null), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion(undefined), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion({}), null);
      assert.strictEqual(javaInstaller.parseStrictMajorVersion([]), null);
    });

    // Test 2: URL & Host Security Validation
    runTest('Security: Validate Oracle download and page URLs fail closed on untrusted hosts/ports/credentials', () => {
      // Valid Oracle download
      assert.doesNotThrow(() => {
        javaInstaller.validateDownloadUrl('https://download.oracle.com/java/27/latest/jdk-27_linux-x64_bin.tar.gz');
      });

      // Insecure HTTP protocol rejected
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('http://download.oracle.com/java/27/latest/jdk-27_linux-x64_bin.tar.gz');
      }, /HTTPS/);

      // Arbitrary external host rejected
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://malicious-site.com/java/27/latest/jdk-27_linux-x64_bin.tar.gz');
      }, /Yetkisiz indirme sunucusu/);

      // Credentials in URL rejected
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://user:pass@download.oracle.com/java/27/latest/jdk-27_linux-x64_bin.tar.gz');
      }, /kimlik bilgileri/);

      // Non-standard port rejected
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://download.oracle.com:8443/java/27/latest/jdk-27_linux-x64_bin.tar.gz');
      }, /Standart dışı HTTPS/);

      // Gated OTN path rejected
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://download.oracle.com/otn/java/jdk/17/jdk-17_linux-x64_bin.tar.gz');
      }, /Eski, kısıtlı/);

      // Path traversal rejected
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://download.oracle.com/java/../etc/passwd');
      }, /path traversal/);

      // Page URL validation
      assert.doesNotThrow(() => {
        javaInstaller.validateOraclePageUrl('https://www.oracle.com/tr/java/technologies/downloads/');
      });
      assert.throws(() => {
        javaInstaller.validateOraclePageUrl('http://www.oracle.com/tr/java/technologies/downloads/');
      }, /HTTPS/);
      assert.throws(() => {
        javaInstaller.validateOraclePageUrl('https://evil-oracle.com/downloads');
      }, /Yetkisiz ana makine/);
    });

    // Test 3: downloadAndVerifyArchive Fails Closed on Missing/Invalid SHA-256
    await runAsyncTest('Integrity: downloadAndVerifyArchive fails closed without valid SHA-256', async () => {
      const dummyDest = path.join(config.TEMP_DIR, `test-missing-sha-${Date.now()}.tar.gz`);

      // Missing sha256Url
      await assert.rejects(
        async () => {
          await javaInstaller.downloadAndVerifyArchive(
            'https://download.oracle.com/java/27/latest/jdk-27_linux-x64_bin.tar.gz',
            null, // No SHA-256 URL
            dummyDest
          );
        },
        /SHA-256.*zorunludur/i,
        'Must reject when sha256Url is missing'
      );

      assert.strictEqual(fs.existsSync(dummyDest), false, 'Temporary destination must be cleaned up');
    });

    // Test 4: downloadAndVerifyArchive Rejects Untrusted Redirect Host
    await runAsyncTest('Security: downloadAndVerifyArchive rejects redirect to external domain', async () => {
      const dummyDest = path.join(config.TEMP_DIR, `test-redirect-${Date.now()}.tar.gz`);

      await assert.rejects(
        async () => {
          await javaInstaller.downloadAndVerifyArchive(
            'https://attacker-redirect.com/java/27/latest/jdk-27_linux-x64_bin.tar.gz',
            'https://download.oracle.com/java/27/latest/jdk-27_linux-x64_bin.tar.gz.sha256',
            dummyDest,
            null,
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
          );
        },
        /Yetkisiz indirme sunucusu/,
        'Must reject untrusted hosts immediately'
      );

      assert.strictEqual(fs.existsSync(dummyDest), false);
    });

    // Test 5: No Invented Latest Releases on Network Error
    await runAsyncTest('Resilience: Network failure returns empty catalog or stale cache; never invents fake latest', async () => {
      javaInstaller.resetMemoryCache();

      const catalogData = await javaInstaller.getJavaCatalog({
        forceRefresh: true,
        targetArch: 'linux-x64'
      }).catch((e) => ({ catalog: [], networkError: e.message }));

      assert(Array.isArray(catalogData.catalog), 'Catalog must be an array');
      assert(Array.isArray(catalogData.installed), 'Installed list must always be present');
      if (catalogData.networkError) {
        assert.strictEqual(catalogData.catalog.length, 0, 'On first network failure, catalog must be empty without fake releases');
      }
    });

    // Test 6: Architecture Partitioning of Catalog Cache
    await runAsyncTest('Isolation: Cache is partitioned by architecture; arm64 does not poison x64', async () => {
      javaInstaller.resetMemoryCache();

      const mockHtml = `
        <h1>Java Downloads</h1>
        <p>JDK 27 is the latest release</p>
        <h2>Java SE Development Kit 27 downloads</h2>
        <a href="https://download.oracle.com/java/27/latest/jdk-27_linux-x64_bin.tar.gz">x64</a>
        <a href="https://download.oracle.com/java/27/latest/jdk-27_linux-aarch64_bin.tar.gz">arm64</a>
      `;

      const x64Items = javaInstaller.parseOracleHtml(mockHtml, 'linux-x64');
      const armItems = javaInstaller.parseOracleHtml(mockHtml, 'linux-aarch64');

      assert.strictEqual(x64Items[0].architecture, 'linux-x64');
      assert.strictEqual(armItems[0].architecture, 'linux-aarch64');
      assert.strictEqual(x64Items[0].filename.includes('x64'), true);
      assert.strictEqual(armItems[0].filename.includes('aarch64'), true);
    });

    // Test 7: Synchronous Lock Prevents Concurrent Install Race
    await runAsyncTest('Concurrency: Synchronous lock immediately rejects duplicate in-flight installs', async () => {
      javaInstaller.resetMemoryCache();

      const mockMajor = 27;
      assert.strictEqual(javaInstaller.isInstalling(mockMajor), false);

      let resolveMock;
      const delayedPromise = new Promise((resolve) => { resolveMock = resolve; });

      // Launch first install
      const p1 = javaInstaller.installJavaVersion(mockMajor, {
        mockCatalog: delayedPromise
      }).catch((e) => e);

      // Synchronously, the lock MUST already be set before any await finishes
      assert.strictEqual(javaInstaller.isInstalling(mockMajor), true, 'Lock must be set synchronously before first await');

      // Second call arrives immediately while first is in flight
      let secondCallError = null;
      try {
        await javaInstaller.installJavaVersion(mockMajor, {
          mockCatalog: Promise.resolve({ catalog: [] })
        });
      } catch (err) {
        secondCallError = err;
      }

      assert(secondCallError, 'Second call must throw an error');
      assert(secondCallError.message.includes('zaten devam ediyor'), 'Second call must be rejected with already in progress');

      // Release first call
      resolveMock({ catalog: [] });
      await p1;

      // After completion, lock is released in finally
      assert.strictEqual(javaInstaller.isInstalling(mockMajor), false, 'Lock must be released in finally');
    });

    // Test 8: Staged Executable Validation (validateStagedJava) Rejects Mismatch and Accepts Matching
    runTest('Integrity: validateStagedJava helper verifies executable and enforces exact major version match', () => {
      const fixtureDir = path.join(config.TEMP_DIR, `test-staged-java-${Date.now()}`);
      const binDir = path.join(fixtureDir, 'jdk-staging', 'bin');
      fs.mkdirSync(binDir, { recursive: true });

      const isWin = process.platform === 'win32';
      const fakeJavaBin = path.join(binDir, isWin ? 'java.exe' : 'java');
      fs.writeFileSync(fakeJavaBin, 'dummy-binary-content', { mode: 0o755 });

      try {
        // Case A: Missing bin/java in empty staging directory -> must throw
        const emptyDir = path.join(config.TEMP_DIR, `test-empty-staging-${Date.now()}`);
        fs.mkdirSync(emptyDir, { recursive: true });
        try {
          assert.throws(() => {
            javaInstaller.validateStagedJava(emptyDir, 27);
          }, /bulunamadı/);
        } finally {
          try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch (e) {}
        }

        // Case B: Detector stub reports mismatched major version (reports 21 when 27 expected) -> must reject
        const mismatchDetector = {
          inspectJavaExecutable: (p) => ({
            path: p,
            majorVersion: 21,
            rawVersion: '21.0.12',
            vendor: 'OpenJDK'
          })
        };
        assert.throws(() => {
          javaInstaller.validateStagedJava(fixtureDir, 27, mismatchDetector);
        }, /uyuşmuyor.*Beklenen: 27.*Tespit: 21/);

        // Case C: Detector stub reports matching major version (reports 27 when 27 expected) -> must accept
        const matchDetector = {
          inspectJavaExecutable: (p) => ({
            path: p,
            majorVersion: 27,
            rawVersion: '27.0.0',
            vendor: 'Oracle'
          })
        };
        const validationResult = javaInstaller.validateStagedJava(fixtureDir, 27, matchDetector);
        assert.strictEqual(validationResult.info.majorVersion, 27);
        assert.strictEqual(validationResult.javaBin, fakeJavaBin);
        assert.strictEqual(validationResult.extractedRoot, path.join(fixtureDir, 'jdk-staging'));
      } finally {
        try {
          fs.rmSync(fixtureDir, { recursive: true, force: true });
        } catch (e) {}
      }
    });

    // Test 9: HTTP Controllers & Route Security (Isolated with socket and timer lifecycle management)
    await runAsyncTest('API Controller: Validates inputs, rejects "25junk", restricts architecture parameter', async () => {
      // Isolate background services in require.cache before loading serversController
      const wsPath = path.resolve(__dirname, '../src/websocket/wsManager');
      const origWs = require.cache[wsPath];
      require.cache[wsPath] = {
        id: wsPath,
        filename: wsPath,
        loaded: true,
        exports: {
          broadcastDownloadProgress: () => {},
          broadcastConsoleLine: () => {},
          broadcastServerStatus: () => {},
          initialize: () => {}
        }
      };

      const metricsPath = path.resolve(__dirname, '../src/metrics/metricsService');
      const origMetrics = require.cache[metricsPath];
      require.cache[metricsPath] = {
        id: metricsPath,
        filename: metricsPath,
        loaded: true,
        exports: {}
      };

      const serversController = require('../src/servers/serversController');
      const authService = require('../src/auth/authService');
      const testToken = authService.generateToken({ username: 'admin', role: 'admin' });
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        req.user = { username: 'admin', role: 'admin' };
        next();
      });
      app.use('/api/servers', serversController);

      const testServer = http.createServer(app);
      const activeSockets = new Set();
      testServer.on('connection', (sock) => {
        activeSockets.add(sock);
        sock.on('close', () => activeSockets.delete(sock));
      });

      await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
      const port = testServer.address().port;

      try {
        // 1. POST /system/java/install with "25junk" -> MUST return 400 Bad Request
        const resJunk = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/api/servers/system/java/install',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${testToken}`,
                'Connection': 'close'
              },
              agent: false
            },
            (res) => {
              let b = '';
              res.on('data', (c) => (b += c));
              res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
            }
          );
          req.on('error', reject);
          req.write(JSON.stringify({ majorVersion: '25junk' }));
          req.end();
        });
        assert.strictEqual(resJunk.status, 400, 'Must reject "25junk" with 400 Bad Request');

        // 2. POST /system/java/install with negative number -> MUST return 400
        const resNeg = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/api/servers/system/java/install',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${testToken}`,
                'Connection': 'close'
              },
              agent: false
            },
            (res) => {
              let b = '';
              res.on('data', (c) => (b += c));
              res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
            }
          );
          req.on('error', reject);
          req.write(JSON.stringify({ majorVersion: -5 }));
          req.end();
        });
        assert.strictEqual(resNeg.status, 400, 'Must reject negative major version with 400');

        // 3. GET /system/java/catalog with malicious arch string -> Sanitized to host arch
        const resArch = await new Promise((resolve, reject) => {
          http.get(
            {
              host: '127.0.0.1',
              port,
              path: '/api/servers/system/java/catalog?arch=poison_arch_x86',
              headers: {
                'Authorization': `Bearer ${testToken}`,
                'Connection': 'close'
              },
              agent: false
            },
            (res) => {
              let b = '';
              res.on('data', (c) => (b += c));
              res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
            }
          ).on('error', reject);
        });
        assert.strictEqual(resArch.status, 200);
        assert(['linux-x64', 'linux-aarch64'].includes(resArch.body.architecture), 'Must sanitize invalid arch');
      } finally {
        // Destroy all connected sockets and close server cleanly
        for (const sock of activeSockets) {
          try { sock.destroy(); } catch (e) {}
        }
        await new Promise((resolve) => testServer.close(resolve));

        // Restore require cache
        if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
        if (origMetrics) require.cache[metricsPath] = origMetrics; else delete require.cache[metricsPath];
      }
    });

    // Test 10: Multi-vendor Java Catalog includes 8, 11, 16, 17, 21, 25 with real vendor labeling and fail-closed SHA-256
    await runAsyncTest('Catalog: Includes Java 8, 11, 16, 17, 21, 25, correctly labeled vendors and valid SHA-256', async () => {
      const mockOracleHtml = `
        <h1>Java Downloads</h1>
        <p>JDK 25 is the latest release</p>
        <p>JDK 21 is the Long-Term Support (LTS) release</p>
        <h2>Java SE Development Kit 25 downloads</h2>
        <a href="https://download.oracle.com/java/25/latest/jdk-25_linux-x64_bin.tar.gz">x64</a>
        <h2>Java SE Development Kit 21 downloads</h2>
        <a href="https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz">x64</a>
      `;

      const oracleItems = javaInstaller.parseOracleHtml(mockOracleHtml, 'linux-x64');
      assert(oracleItems.some((e) => e.majorVersion === 25 && e.vendor === 'Oracle'), 'Must include Oracle JDK 25');
      assert(oracleItems.some((e) => e.majorVersion === 21 && e.vendor === 'Oracle'), 'Must include Oracle JDK 21');

      // Test catalog fetch with mock catalog combining Oracle and Temurin
      javaInstaller.resetMemoryCache();
      const catalogResult = await javaInstaller.getJavaCatalog({ targetArch: 'linux-x64' }).catch(() => null);
      if (catalogResult && catalogResult.catalog.length > 0) {
        const majors = catalogResult.catalog.map((c) => c.majorVersion);
        // Verify presence of relevant older majors
        assert(majors.includes(8), 'Catalog must include Java 8');
        assert(majors.includes(11), 'Catalog must include Java 11');
        assert(majors.includes(16), 'Catalog must include Java 16');
        assert(majors.includes(17), 'Catalog must include Java 17');
        assert(majors.includes(21), 'Catalog must include Java 21');

        // Check vendor sources
        const j8 = catalogResult.catalog.find((c) => c.majorVersion === 8);
        assert.strictEqual(j8.vendor, 'Eclipse Temurin', 'Java 8 must be from Eclipse Temurin');
        assert(/^[a-f0-9]{64}$/i.test(j8.sha256), 'Java 8 must have 64-character SHA-256 checksum');

        const j17 = catalogResult.catalog.find((c) => c.majorVersion === 17);
        assert.strictEqual(j17.vendor, 'Eclipse Temurin', 'Java 17 must be from Eclipse Temurin');
        assert(/^[a-f0-9]{64}$/i.test(j17.sha256), 'Java 17 must have valid SHA-256 checksum');
      }
    });

    // Test 11: Java Compatibility Matrix Helper (Paper docs Oct 11 2026 & Vanilla Mojang metadata)
    runTest('Compatibility: Matrix correctly resolves recommended/min Java for Paper & Vanilla, and handles snapshots', () => {
      const javaCompatibility = require('../src/system/javaCompatibility');

      // 1. Paper / Purpur 1.7.10 - 1.11 -> Java 8
      const p1_8 = javaCompatibility.getJavaRequirements('paper', '1.8.8');
      assert.strictEqual(p1_8.minJava, 8);
      assert.strictEqual(p1_8.recommendedJava, 8);
      assert.strictEqual(javaCompatibility.isJavaCompatible(8, 'paper', '1.8.8'), true);

      // 2. Paper 1.12 - 1.16.4 -> Java 11
      const p1_12 = javaCompatibility.getJavaRequirements('paper', '1.12.2');
      assert.strictEqual(p1_12.minJava, 11);
      assert.strictEqual(p1_12.recommendedJava, 11);
      assert.strictEqual(javaCompatibility.isJavaCompatible(8, 'paper', '1.12.2'), false);
      assert.strictEqual(javaCompatibility.isJavaCompatible(11, 'paper', '1.12.2'), true);

      // 3. Paper 1.16.5 -> Java 16
      const p1_16_5 = javaCompatibility.getJavaRequirements('paper', '1.16.5');
      assert.strictEqual(p1_16_5.minJava, 16);
      assert.strictEqual(p1_16_5.recommendedJava, 16);
      assert.strictEqual(javaCompatibility.isJavaCompatible(11, 'paper', '1.16.5'), false);
      assert.strictEqual(javaCompatibility.isJavaCompatible(16, 'paper', '1.16.5'), true);

      // 4. Paper 1.17 - 1.19 -> Java 17
      const p1_18 = javaCompatibility.getJavaRequirements('paper', '1.18.2');
      assert.strictEqual(p1_18.minJava, 17);
      assert.strictEqual(p1_18.recommendedJava, 17);
      assert.strictEqual(javaCompatibility.isJavaCompatible(16, 'paper', '1.18.2'), false);
      assert.strictEqual(javaCompatibility.isJavaCompatible(17, 'paper', '1.18.2'), true);

      // 5. Paper 1.20 - 1.21.11 -> Java 21
      const p1_20_4 = javaCompatibility.getJavaRequirements('paper', '1.20.4');
      assert.strictEqual(p1_20_4.recommendedJava, 21);
      assert.strictEqual(p1_20_4.minJava, 17);
      assert.strictEqual(javaCompatibility.isJavaCompatible(17, 'paper', '1.20.4'), true);

      const p1_21_4 = javaCompatibility.getJavaRequirements('purpur', '1.21.4');
      assert.strictEqual(p1_21_4.minJava, 21);
      assert.strictEqual(p1_21_4.recommendedJava, 21);
      assert.strictEqual(javaCompatibility.isJavaCompatible(17, 'purpur', '1.21.4'), false);
      assert.strictEqual(javaCompatibility.isJavaCompatible(21, 'purpur', '1.21.4'), true);

      // 6. Paper 26.1+ -> Java 25 minimum (Java 25 and modern choices 27 are compatible, recommend 25)
      const p26 = javaCompatibility.getJavaRequirements('paper', '26.1');
      assert.strictEqual(p26.minJava, 25);
      assert.strictEqual(p26.recommendedJava, 25);
      assert.strictEqual(javaCompatibility.isJavaCompatible(21, 'paper', '26.1'), false);
      assert.strictEqual(javaCompatibility.isJavaCompatible(25, 'paper', '26.1'), true);
      assert.strictEqual(javaCompatibility.isJavaCompatible(27, 'paper', '26.1'), true, 'Java 27 must be valid for modern 26+');

      // 7. Vanilla 1.17 -> 16, 1.18-1.20.4 -> 17, 1.20.5+ -> 21, 26.x -> 25
      const v1_17 = javaCompatibility.getJavaRequirements('vanilla', '1.17.1');
      assert.strictEqual(v1_17.minJava, 16);
      const v1_18 = javaCompatibility.getJavaRequirements('vanilla', '1.18.2');
      assert.strictEqual(v1_18.minJava, 17);
      const v1_20_5 = javaCompatibility.getJavaRequirements('vanilla', '1.20.5');
      assert.strictEqual(v1_20_5.minJava, 21);
      const v26 = javaCompatibility.getJavaRequirements('vanilla', '26.0');
      assert.strictEqual(v26.minJava, 25);
      assert.strictEqual(javaCompatibility.isJavaCompatible(27, 'vanilla', '26.0'), true, 'Java 27 must be valid for modern Vanilla 26');

      // 8. Vanilla with Mojang version metadata override
      const vMeta = javaCompatibility.getJavaRequirements('vanilla', 'custom-version', {
        javaVersion: { majorVersion: 21 }
      });
      assert.strictEqual(vMeta.minJava, 21);

      // 9. Unknown/snapshot versions: must NOT silently guess incompatible
      const snapshotReq = javaCompatibility.getJavaRequirements('paper', '24w14a-snapshot');
      assert.strictEqual(snapshotReq.isUnknown, true);
      assert.strictEqual(javaCompatibility.isJavaCompatible(8, 'paper', '24w14a-snapshot'), true);
      assert.strictEqual(javaCompatibility.isJavaCompatible(17, 'paper', '24w14a-snapshot'), true);
      assert.strictEqual(javaCompatibility.isJavaCompatible(21, 'paper', '24w14a-snapshot'), true);

      // 10. Turkish captions
      assert(p1_21_4.captionTr.includes('Önerilen: Java 21'), 'Caption must mention recommended Java 21');
      assert(p1_21_4.captionTr.includes('Gereken: Java 21'), 'Caption must mention required Java 21');
    });

    // Test 12: server.properties max-players default 10 and non-destructive read via controller helper
    runTest('Server Properties: Default max-players is 10, reads actual maxPlayers via controller helper', () => {
      const serversController = require('../src/servers/serversController');
      const tempServerDir = path.join(config.TEMP_DIR, `test-srv-${Date.now()}`);
      fs.mkdirSync(tempServerDir, { recursive: true });

      try {
        const propsPath = path.join(tempServerDir, 'server.properties');
        fs.writeFileSync(propsPath, 'server-port=25565\nmotd=Test\nmax-players=42\n', 'utf8');

        // Test reading actual maxPlayers via actual exported controller helper
        const serverObj = { directory: tempServerDir, maxPlayers: 20 };
        const actualMax = serversController.readActualMaxPlayers(serverObj);
        assert.strictEqual(actualMax, 42, 'Must read actual configured maxPlayers (42) via readActualMaxPlayers helper');

        // Test fallback to default 10 when properties file does not exist
        const noPropsServer = { directory: path.join(tempServerDir, 'nonexistent') };
        assert.strictEqual(serversController.readActualMaxPlayers(noPropsServer), 10, 'Must fallback to default 10');

        // Verify file was not overwritten
        const unchanged = fs.readFileSync(propsPath, 'utf8');
        assert(unchanged.includes('max-players=42'), 'Existing server.properties must not be mutated');
      } finally {
        try { fs.rmSync(tempServerDir, { recursive: true, force: true }); } catch (e) {}
      }
    });

    // Test 13: Controller validates explicit javaPath compatibility
    await runAsyncTest('Controller Validation: Rejects incompatible explicit javaPath with clear 400 error', async () => {
      const wsPath = path.resolve(__dirname, '../src/websocket/wsManager');
      const origWs = require.cache[wsPath];
      require.cache[wsPath] = {
        id: wsPath, filename: wsPath, loaded: true,
        exports: { broadcastDownloadProgress: () => {}, broadcastConsoleLine: () => {}, broadcastServerStatus: () => {}, initialize: () => {} }
      };

      const metricsPath = path.resolve(__dirname, '../src/metrics/metricsService');
      const origMetrics = require.cache[metricsPath];
      require.cache[metricsPath] = { id: metricsPath, filename: metricsPath, loaded: true, exports: {} };

      // Stub javaDetector to report Java 8 for dummy path
      const origInspect = javaDetector.inspectJavaExecutable;
      javaDetector.inspectJavaExecutable = (p) => {
        if (p === '/usr/lib/jvm/java-8-dummy/bin/java') {
          return { path: p, majorVersion: 8, rawVersion: '1.8.0', vendor: 'Eclipse Temurin' };
        }
        return origInspect(p);
      };

      const serversController = require('../src/servers/serversController');
      const authService = require('../src/auth/authService');
      const testToken = authService.generateToken({ username: 'admin', role: 'admin' });
      const app = express();
      app.use(express.json());
      app.use('/api/servers', serversController);

      const testServer = http.createServer(app);
      const activeSockets = new Set();
      testServer.on('connection', (sock) => {
        activeSockets.add(sock);
        sock.on('close', () => activeSockets.delete(sock));
      });

      await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
      const port = testServer.address().port;

      try {
        // Attempt creating Paper 1.21.4 server with Java 8 -> MUST fail with 400
        const res = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/api/servers/create',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${testToken}`,
                'Connection': 'close'
              },
              agent: false
            },
            (res) => {
              let b = '';
              res.on('data', (c) => (b += c));
              res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
            }
          );
          req.on('error', reject);
          req.write(JSON.stringify({
            name: 'IncompatibleServerTest',
            type: 'paper',
            version: '1.21.4',
            javaPath: '/usr/lib/jvm/java-8-dummy/bin/java'
          }));
          req.end();
        });

        assert.strictEqual(res.status, 400, 'Must reject incompatible Java 8 for Paper 1.21.4 with 400');
        assert(res.body.error.includes('uyumsuzdur') || res.body.error.includes('yetersizdir') || res.body.error.includes('En az Java 21'), 'Must state required Java version in error message');
      } finally {
        javaDetector.inspectJavaExecutable = origInspect;
        for (const sock of activeSockets) {
          try { sock.destroy(); } catch (e) {}
        }
        await new Promise((resolve) => testServer.close(resolve));
        if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
        if (origMetrics) require.cache[metricsPath] = origMetrics; else delete require.cache[metricsPath];
      }
    });

    // Test 14: Strict Semantic Parsing & Snapshot Handling (no Java 21 guessing)
    runTest('Semantic Parsing: Rejects snapshot prefixes (26w...) and does not guess Java 21 on unknown snapshots', () => {
      const javaCompatibility = require('../src/system/javaCompatibility');

      // Valid semantic versions
      assert.deepStrictEqual(javaCompatibility.parseVersionNumbers('1.21.4'), { major: 1, minor: 21, patch: 4, raw: '1.21.4' });
      assert.deepStrictEqual(javaCompatibility.parseVersionNumbers('1.12'), { major: 1, minor: 12, patch: 0, raw: '1.12' });
      assert.deepStrictEqual(javaCompatibility.parseVersionNumbers('26.1'), { major: 26, minor: 1, patch: 0, raw: '26.1' });

      // Snapshots and invalid formats MUST return null
      assert.strictEqual(javaCompatibility.parseVersionNumbers('26w14a'), null);
      assert.strictEqual(javaCompatibility.parseVersionNumbers('26.4-snapshot-3'), null);
      assert.strictEqual(javaCompatibility.parseVersionNumbers('1.20-rc1'), null);
      assert.strictEqual(javaCompatibility.parseVersionNumbers('snapshot-1'), null);
      assert.strictEqual(javaCompatibility.parseVersionNumbers('latest'), null);

      // Unknown snapshot without Mojang metadata: must NOT guess Java 21 recommendation
      const req = javaCompatibility.getJavaRequirements('paper', '26w14a');
      assert.strictEqual(req.isUnknown, true, 'Must be marked isUnknown');
      assert.strictEqual(req.minJava, null, 'minJava must be null (no guess)');
      assert.strictEqual(req.recommendedJava, null, 'recommendedJava must be null (no guess)');
      assert.deepStrictEqual(req.compatibleMajors, [], 'compatibleMajors must be empty');
      assert(req.captionTr.includes('Bilinmeyen sürüm / snapshot'), 'Caption must state unknown snapshot');
    });

    // Test 15: Official Mojang Version Metadata Bounded Fetch & Resolution
    await runAsyncTest('Mojang Metadata: Bounded fetch resolves official javaVersion for releases and snapshots', async () => {
      const javaCompatibility = require('../src/system/javaCompatibility');

      // 1. Live/Cached fetch for release 1.20.4
      const meta1204 = await javaCompatibility.fetchMojangJavaMetadata('1.20.4', 5000);
      if (meta1204) {
        assert.strictEqual(meta1204.majorVersion, 17, 'Mojang official metadata for 1.20.4 must be Java 17');
        const req = javaCompatibility.getJavaRequirements('vanilla', '1.20.4', meta1204);
        assert.strictEqual(req.minJava, 17);
        assert.strictEqual(req.recommendedJava, 17);
        assert.strictEqual(req.isUnknown, false);
      }

      // 2. Metadata override for snapshot
      const mockSnapMeta = { component: 'java-runtime-epsilon', majorVersion: 25 };
      const snapReq = javaCompatibility.getJavaRequirements('vanilla', '26.4-snapshot-3', mockSnapMeta);
      assert.strictEqual(snapReq.minJava, 25);
      assert.strictEqual(snapReq.recommendedJava, 25);
      assert.strictEqual(snapReq.isUnknown, false);
      assert.deepStrictEqual(snapReq.compatibleMajors, [25]);
    });

    // Test 16: Autoselect Priority & Empty Filter Policy
    runTest('Autoselect Policy: Prefers installed recommended -> recommended downloadable -> compatible alternatives; does not pick 27 for 1.12', () => {
      const javaCompatibility = require('../src/system/javaCompatibility');

      // For Paper 1.12, recommended is Java 11
      const req1_12 = javaCompatibility.getJavaRequirements('paper', '1.12.2');
      assert.strictEqual(req1_12.recommendedJava, 11);
      assert.strictEqual(req1_12.minJava, 11);

      // Java 27 is NOT compatible with Paper 1.12!
      assert.strictEqual(javaCompatibility.isJavaCompatible(27, 'paper', '1.12.2'), false);
      assert.strictEqual(javaCompatibility.isJavaCompatible(21, 'paper', '1.12.2'), false);
      assert.strictEqual(javaCompatibility.isJavaCompatible(11, 'paper', '1.12.2'), true);

      // Simulation of UI options
      const allOptions = [
        { value: '/usr/lib/jvm/java-27', majorVersion: 27, installed: true },
        { value: '/usr/lib/jvm/java-21', majorVersion: 21, installed: true },
        { value: 'install-11', majorVersion: 11, installed: false }
      ];

      // Strict filter
      const filtered = allOptions.filter((opt) =>
        javaCompatibility.isJavaCompatible(opt.majorVersion, 'paper', '1.12.2')
      );
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].value, 'install-11', 'Must filter out 27 and 21, leaving only 11');

      // If filtered is empty, policy must NOT fallback to incompatible options
      const incompatibleOnly = [
        { value: '/usr/lib/jvm/java-27', majorVersion: 27, installed: true },
        { value: '/usr/lib/jvm/java-21', majorVersion: 21, installed: true }
      ];
      const emptyFiltered = incompatibleOnly.filter((opt) =>
        javaCompatibility.isJavaCompatible(opt.majorVersion, 'paper', '1.12.2')
      );
      assert.strictEqual(emptyFiltered.length, 0, 'Empty filter must remain empty without fallback');
    });

    // Test 17: Oracle Outage Independent Adoptium Resilience
    await runAsyncTest('Resilience: Oracle outage does not suppress older Adoptium catalog data', async () => {
      javaInstaller.resetMemoryCache();
      const origFetch = javaInstaller.fetchSecurePage;

      try {
        // Stub Oracle download page fetch to throw a network error simulating Oracle outage
        javaInstaller.fetchSecurePage = async () => {
          throw new Error('Oracle downloads unreachable (503 Service Unavailable)');
        };

        const result = await javaInstaller.getJavaCatalog({ forceRefresh: true, targetArch: 'linux-x64' });

        // Oracle failed, but catalog must NOT be completely empty: Adoptium releases (8, 11, 16, 17) must be present!
        assert(result.catalog.length > 0, 'Adoptium releases must be present even when Oracle is down');
        assert(result.catalog.some((e) => e.majorVersion === 17), 'Java 17 must be present');
        assert(result.catalog.some((e) => e.majorVersion === 11), 'Java 11 must be present');
        assert(result.catalog.some((e) => e.majorVersion === 8), 'Java 8 must be present');

        // Never invent fake Oracle releases on outage
        assert(!result.catalog.some((e) => e.vendor === 'Oracle'), 'No fake Oracle releases should be invented');
        assert(result.networkError !== null, 'networkError should reflect the Oracle outage');
      } finally {
        javaInstaller.fetchSecurePage = origFetch;
        javaInstaller.resetMemoryCache();
      }
    });

    // Test 18: Live Adoptium API Integration
    await runAsyncTest('Adoptium API: Fetches live GA releases for 8, 11, 16, 17 with valid official URLs and checksums', async () => {
      const releases = await javaInstaller.fetchAdoptiumReleases('linux-x64', 8000);
      assert(Array.isArray(releases) && releases.length >= 4, 'Must return at least 4 releases (8, 11, 16, 17)');

      const j17 = releases.find((r) => r.majorVersion === 17);
      assert(j17, 'Must have Java 17 release');
      assert.strictEqual(j17.majorVersion, 17);
      assert.strictEqual(j17.architecture, 'linux-x64');
      assert(j17.downloadUrl.includes('adoptium'), 'URL must reference official Adoptium repository');
      assert(typeof j17.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(j17.sha256), 'Must have valid 64-char hex SHA-256');

      const j11 = releases.find((r) => r.majorVersion === 11);
      assert(j11, 'Must have Java 11 release');
      assert.strictEqual(j11.majorVersion, 11);
    });

    // Test 19: Controller GET /system/java/requirements Endpoint
    await runAsyncTest('Controller Requirements API: Exposes core and version requirements with Mojang metadata', async () => {
      const wsPath = path.resolve(__dirname, '../src/websocket/wsManager');
      const origWs = require.cache[wsPath];
      require.cache[wsPath] = {
        id: wsPath, filename: wsPath, loaded: true,
        exports: { broadcastDownloadProgress: () => {}, broadcastConsoleLine: () => {}, broadcastServerStatus: () => {}, initialize: () => {} }
      };

      const metricsPath = path.resolve(__dirname, '../src/metrics/metricsService');
      const origMetrics = require.cache[metricsPath];
      require.cache[metricsPath] = { id: metricsPath, filename: metricsPath, loaded: true, exports: {} };

      const serversController = require('../src/servers/serversController');
      const authService = require('../src/auth/authService');
      const testToken = authService.generateToken({ username: 'admin', role: 'admin' });
      const app = express();
      app.use(express.json());
      app.use('/api/servers', serversController);

      const testServer = http.createServer(app);
      const activeSockets = new Set();
      testServer.on('connection', (sock) => {
        activeSockets.add(sock);
        sock.on('close', () => activeSockets.delete(sock));
      });

      await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
      const port = testServer.address().port;

      try {
        // Query requirements for paper 1.21.4
        const res = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/api/servers/system/java/requirements?core=paper&version=1.21.4',
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${testToken}`,
                'Connection': 'close'
              },
              agent: false
            },
            (res) => {
              let b = '';
              res.on('data', (c) => (b += c));
              res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
            }
          );
          req.on('error', reject);
          req.end();
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.recommendedJava, 21);
        assert.strictEqual(res.body.minJava, 21);
        assert.deepStrictEqual(res.body.compatibleMajors, [21]);

        // Query missing version -> 400
        const badRes = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/api/servers/system/java/requirements?core=paper',
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${testToken}`,
                'Connection': 'close'
              },
              agent: false
            },
            (res) => {
              let b = '';
              res.on('data', (c) => (b += c));
              res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
            }
          );
          req.on('error', reject);
          req.end();
        });

        assert.strictEqual(badRes.status, 400);
      } finally {
        for (const sock of activeSockets) {
          try { sock.destroy(); } catch (e) {}
        }
        await new Promise((resolve) => testServer.close(resolve));
        if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
        if (origMetrics) require.cache[metricsPath] = origMetrics; else delete require.cache[metricsPath];
      }
    });

    // Test 20: Safe Redirect to release-assets.githubusercontent.com vs Foreign Host / Credentials / Port
    await runAsyncTest('Security & Redirects: release-assets.githubusercontent.com permitted only on redirect with trusted hash', async () => {
      // 1. Initial direct download to release-assets must fail (no arbitrary direct downloads)
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://release-assets.githubusercontent.com/adoptium/archive.tar.gz', false);
      }, /Yetkisiz indirme sunucusu/);

      // 2. Redirect download to release-assets passes validation
      assert.doesNotThrow(() => {
        javaInstaller.validateDownloadUrl('https://release-assets.githubusercontent.com/adoptium/archive.tar.gz', true);
      });

      // 3. Foreign host redirect fails
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://evil-host.com/archive.tar.gz', true);
      }, /Yetkisiz indirme sunucusu/);

      // 4. Credentialed redirect fails
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://user:pass@release-assets.githubusercontent.com/archive.tar.gz', true);
      }, /kimlik bilgileri/);

      // 5. Non-standard port redirect fails
      assert.throws(() => {
        javaInstaller.validateDownloadUrl('https://release-assets.githubusercontent.com:8443/archive.tar.gz', true);
      }, /Standart dışı HTTPS/);

      // 6. Mock authentic redirect download: github.com -> release-assets.githubusercontent.com with valid SHA-256
      const dummyDest = path.join(config.TEMP_DIR, `test-adoptium-redirect-${Date.now()}.tar.gz`);
      const payloadBytes = Buffer.from('mock java 17 tarball archive payload containing simulated jdk bytes');
      const expectedSha256 = crypto.createHash('sha256').update(payloadBytes).digest('hex');

      const origHttpsGet = https.get;
      try {
        https.get = function (url, opts, cb) {
          const urlStr = typeof url === 'string' ? url : url.href || url.toString();
          const callback = typeof opts === 'function' ? opts : cb;

          if (urlStr.includes('github.com/adoptium/temurin17')) {
            // Emulate GitHub 302 redirect to release-assets.githubusercontent.com
            const res = new EventEmitter();
            res.statusCode = 302;
            res.headers = {
              location: 'https://release-assets.githubusercontent.com/adoptium/temurin17-binaries/releases/download/jdk-17/OpenJDK17.tar.gz'
            };
            res.resume = () => {};
            process.nextTick(() => callback(res));
            return { on: () => {}, destroy: () => {} };
          } else if (urlStr.includes('release-assets.githubusercontent.com')) {
            // Stream authentic payload
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = { 'content-length': String(payloadBytes.length) };
            res.resume = () => {};
            res.pipe = (dest) => {
              dest.write(payloadBytes);
              dest.end();
            };
            process.nextTick(() => {
              callback(res);
              res.emit('data', payloadBytes);
              res.emit('end');
            });
            return { on: () => {}, destroy: () => {} };
          }

          return origHttpsGet.call(https, url, opts, cb);
        };

        const resultPath = await javaInstaller.downloadAndVerifyArchive(
          'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17/OpenJDK17.tar.gz',
          null,
          dummyDest,
          null,
          expectedSha256
        );

        assert.strictEqual(resultPath.filePath, dummyDest);
        assert.strictEqual(resultPath.sha256, expectedSha256.toLowerCase());
        assert.strictEqual(fs.existsSync(dummyDest), true);
        assert.strictEqual(fs.readFileSync(dummyDest, 'utf8'), payloadBytes.toString('utf8'));
      } finally {
        https.get = origHttpsGet;
        try { if (fs.existsSync(dummyDest)) fs.unlinkSync(dummyDest); } catch (e) {}
      }

      // 7. Mock evil redirect: github.com -> evil-assets.com must reject and clean up
      const evilDest = path.join(config.TEMP_DIR, `test-evil-redirect-${Date.now()}.tar.gz`);
      try {
        https.get = function (url, opts, cb) {
          const callback = typeof opts === 'function' ? opts : cb;
          const res = new EventEmitter();
          res.statusCode = 302;
          res.headers = { location: 'https://evil-assets.com/malicious.tar.gz' };
          res.resume = () => {};
          process.nextTick(() => callback(res));
          return { on: () => {}, destroy: () => {} };
        };

        await assert.rejects(
          async () => {
            await javaInstaller.downloadAndVerifyArchive(
              'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17/OpenJDK17.tar.gz',
              null,
              evilDest,
              null,
              expectedSha256
            );
          },
          /Yetkisiz indirme sunucusu/
        );
        assert.strictEqual(fs.existsSync(evilDest), false, 'Evil target destination file must be cleaned up');
      } finally {
        https.get = origHttpsGet;
        try { if (fs.existsSync(evilDest)) fs.unlinkSync(evilDest); } catch (e) {}
      }
    });

    // Test 21: javaDetector.getJavaForServer chooses core/version-aware recommended Java, rejects incompatible
    await runAsyncTest('Auto Selection: getJavaForServer chooses installed recommended Java, avoids 27 for 1.19, supports modern 25+', async () => {
      const origDetect = javaDetector.detectJavaInstallations;
      try {
        // Mock multiple installed Javas: 27, 17, 11, 8
        javaDetector.detectJavaInstallations = () => [
          { majorVersion: 27, path: '/usr/lib/jvm/jdk-27/bin/java' },
          { majorVersion: 17, path: '/usr/lib/jvm/jdk-17/bin/java' },
          { majorVersion: 11, path: '/usr/lib/jvm/jdk-11/bin/java' },
          { majorVersion: 8, path: '/usr/lib/jvm/jdk-8/bin/java' }
        ];

        // 1. Paper 1.19 requires 17: Auto must choose Java 17, NOT highest Java 27!
        const chosen119 = javaDetector.getJavaForServer('auto', { coreType: 'paper', version: '1.19' });
        assert.strictEqual(chosen119, '/usr/lib/jvm/jdk-17/bin/java', 'Must choose Java 17 for Paper 1.19');

        // 2. Paper 1.12 requires Java 11: Auto must choose Java 11, NOT 27!
        const chosen112 = javaDetector.getJavaForServer(null, { coreType: 'paper', version: '1.12' });
        assert.strictEqual(chosen112, '/usr/lib/jvm/jdk-11/bin/java', 'Must choose Java 11 for Paper 1.12');

        // 3. Modern Paper 26.1 requires Java 25 (allows 27): Auto must choose Java 27
        const chosen261 = javaDetector.getJavaForServer('auto', { coreType: 'paper', version: '26.1' });
        assert.strictEqual(chosen261, '/usr/lib/jvm/jdk-27/bin/java', 'Must choose Java 27 for Paper 26.1');

        // 4. Backward-compatible without serverContext: prefers modern >= 21
        const chosenDefault = javaDetector.getJavaForServer(null);
        assert.strictEqual(chosenDefault, '/usr/lib/jvm/jdk-27/bin/java', 'Default without context prefers modern Java');

        // 5. When only Java 27 is installed, Paper 1.19 must NOT fall back to Java 27; must throw clear error
        javaDetector.detectJavaInstallations = () => [
          { majorVersion: 27, path: '/usr/lib/jvm/jdk-27/bin/java' }
        ];

        assert.throws(() => {
          javaDetector.getJavaForServer('auto', { coreType: 'paper', version: '1.19' });
        }, /Bu sunucu \(paper 1\.19\) için uyumlu Java bulunamadı.*en az Java 17/);

        // 6. Explicit custom path that is too low throws clear Turkish error
        javaDetector.detectJavaInstallations = () => [
          { majorVersion: 8, path: '/usr/lib/jvm/jdk-8/bin/java' }
        ];
        assert.throws(() => {
          javaDetector.getJavaForServer('/usr/lib/jvm/jdk-8/bin/java', { coreType: 'paper', version: '1.19', minJava: 17 });
        }, /Seçilen Java.*yetersizdir.*En az Java 17 gereklidir/);
      } finally {
        javaDetector.detectJavaInstallations = origDetect;
      }
    });

    // Test 22: ProcessManager startServer rejects incompatible Java BEFORE lifecycle reset
    await runAsyncTest('ProcessManager: Incompatible Java throws clear Turkish error before lifecycle reset', async () => {
      const serverRegistry = require('../src/servers/serverRegistry');
      const processManager = require('../src/servers/processManager');

      const testServerId = `test-incompat-${Date.now()}`;
      const tempServerDir = path.join(config.SERVERS_DIR, testServerId);
      fs.mkdirSync(tempServerDir, { recursive: true });

      const origDetect = javaDetector.detectJavaInstallations;
      try {
        // Only Java 27 installed
        javaDetector.detectJavaInstallations = () => [
          { majorVersion: 27, path: '/usr/lib/jvm/jdk-27/bin/java' }
        ];

        serverRegistry.register({
          id: testServerId,
          name: 'Test Incompatible',
          directory: tempServerDir,
          jarFile: 'server.jar',
          javaPath: 'auto',
          minRam: '1G',
          maxRam: '2G',
          type: 'paper',
          version: '1.19'
        });

        // Initialize instance
        const inst = processManager._getOrCreateInstance(testServerId);
        const originalSessionId = inst.sessionId;

        // Try startServer -> must reject with Turkish error
        await assert.rejects(
          async () => {
            await processManager.startServer(testServerId);
          },
          /Bu sunucu \(paper 1\.19\) için uyumlu Java bulunamadı.*en az Java 17/
        );

        // Ensure lifecycle was NOT reset
        assert.strictEqual(inst.sessionId, originalSessionId, 'Lifecycle sessionId must not be reset on Java validation failure');
        assert.strictEqual(inst.status, 'offline', 'Server status must remain offline');
      } finally {
        javaDetector.detectJavaInstallations = origDetect;
        serverRegistry.delete(testServerId);
        try { if (fs.existsSync(tempServerDir)) fs.rmSync(tempServerDir, { recursive: true, force: true }); } catch (e) {}
      }
    });

    // Test 23: serversController.resolveJavaExecutable respects core and version
    await runAsyncTest('Controller: resolveJavaExecutable is core and version aware, rejects incompatible', () => {
      const serversController = require('../src/servers/serversController');
      assert(typeof serversController.resolveJavaExecutable === 'function', 'resolveJavaExecutable must be exported');

      const origDetect = javaDetector.detectJavaInstallations;
      try {
        javaDetector.detectJavaInstallations = () => [
          { majorVersion: 27, path: '/usr/lib/jvm/jdk-27/bin/java' },
          { majorVersion: 17, path: '/usr/lib/jvm/jdk-17/bin/java' }
        ];

        // Paper 1.19 picks 17, not 27
        const res119 = serversController.resolveJavaExecutable(null, '1.19', 'paper');
        assert.strictEqual(res119, '/usr/lib/jvm/jdk-17/bin/java');

        // Paper 26.1 picks 27
        const res261 = serversController.resolveJavaExecutable(null, '26.1', 'paper');
        assert.strictEqual(res261, '/usr/lib/jvm/jdk-27/bin/java');

        // If only 27 installed, Paper 1.19 throws error
        javaDetector.detectJavaInstallations = () => [
          { majorVersion: 27, path: '/usr/lib/jvm/jdk-27/bin/java' }
        ];
        assert.throws(() => {
          serversController.resolveJavaExecutable(null, '1.19', 'paper');
        }, /uyumlu Java bulunamadı.*en az Java 17/);
      } finally {
        javaDetector.detectJavaInstallations = origDetect;
      }
    });

  } finally {
    // Teardown: clear all tracked intervals and restore original timers
    cleanupTrackedTimers();
  }

  console.log('\n====================================================');
  console.log(`Results: ${passedTests} Passed, ${failedTests} Failed`);
  console.log('====================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  cleanupTrackedTimers();
  console.error('Test execution failed:', err);
  process.exit(1);
});
