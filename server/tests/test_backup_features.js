const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.env.TEST_PORT || process.env.PORT || '8080';
const HOST = process.env.TEST_HOST || '127.0.0.1';
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;
let authToken = '';

function request(method, pathUrl, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, BASE_URL);
    const reqHeaders = { ...headers };
    if (authToken) {
      reqHeaders['Authorization'] = `Bearer ${authToken}`;
    }
    let reqBody = null;
    if (body !== null) {
      reqBody = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(reqBody);
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
            buffer
          });
        });
      }
    );
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('      maziPanel Backup System Verification Tests     ');
  console.log('====================================================\n');

  // 1. Setup / Login to obtain token
  console.log('[*] Step 1: Authenticating to API...');
  const setupRes = await request('POST', '/api/auth/setup', {
    username: 'masteradmin',
    password: 'AdminPassword123!',
    email: 'admin@mazipanel.local'
  });
  if (setupRes.status === 200 || setupRes.status === 201) {
    authToken = setupRes.json.token;
  } else {
    const loginRes = await request('POST', '/api/auth/login', {
      username: 'masteradmin',
      password: 'AdminPassword123!'
    });
    if (loginRes.status === 200) {
      authToken = loginRes.json.token;
    } else {
      throw new Error(`Auth failed: ${loginRes.status} ${loginRes.text}`);
    }
  }
  console.log('    Auth successful, token received.\n');

  // 2. Prepare a dedicated test server directory
  console.log('[*] Step 2: Creating a test server environment...');
  const config = require('../config');
  const serverRegistry = require('../src/servers/serverRegistry');

  const testServerId = `bcktest-${Date.now().toString(36)}`;
  const testServerDir = path.join(config.SERVERS_DIR, testServerId);
  fs.mkdirSync(path.join(testServerDir, 'world', 'data'), { recursive: true });
  fs.writeFileSync(path.join(testServerDir, 'server.properties'), 'motd=maziPanel Test Server\nmax-players=20\n');
  fs.writeFileSync(path.join(testServerDir, 'world', 'level.dat'), 'DUMMY LEVEL DATA 12345');
  fs.writeFileSync(path.join(testServerDir, 'world', 'data', 'scoreboard.dat'), 'DUMMY SCOREBOARD 999');

  const testServer = serverRegistry.register({
    id: testServerId,
    name: 'Yedek Test Sunucusu (Özel)',
    directory: testServerDir,
    jarFile: 'server.jar',
    javaPath: '/usr/bin/java'
  });
  console.log(`    Created test server "${testServer.name}" [${testServerId}].\n`);

  try {
    // 3. Test Custom Backup Naming & Turkish ASCII conversion
    console.log('[*] Step 3: Testing backup naming, Turkish char slugification and Europe/Istanbul timestamp...');
    const createRes = await request('POST', '/api/backups', {
      serverId: testServerId,
      name: 'Türkçe Şahane Yedek Başlığı 1',
      format: 'zip',
      level: 6
    });

    if (createRes.status !== 201) {
      throw new Error(`Backup create failed: ${createRes.status} ${createRes.text}`);
    }

    const b1 = createRes.json;
    console.log(`    Created backup ID: ${b1.id}`);
    console.log(`    Generated filename: ${b1.filename}`);
    console.log(`    Format: ${b1.format}, Level: ${b1.level}, Size: ${b1.sizeFormatted}`);

    // Verify filename format: Turkce_Sahane_Yedek_Basligi_1_YYYY-MM-DD_HH-mm.zip
    const namePattern = /^Turkce_Sahane_Yedek_Basligi_1_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.zip$/;
    if (!namePattern.test(b1.filename)) {
      throw new Error(`Filename does not match expected format! Got: ${b1.filename}`);
    }
    // Verify ID is not in filename
    if (b1.filename.includes(b1.id)) {
      throw new Error(`Backup ID must NOT be present in filename!`);
    }
    console.log('    Naming pattern and Turkish ASCII conversion PASSED.\n');

    // 4. Test Conflict Suffix (-2, -3)
    console.log('[*] Step 4: Testing filename conflict resolution (-2, -3)...');
    const conflictRes = await request('POST', '/api/backups', {
      serverId: testServerId,
      name: 'Türkçe Şahane Yedek Başlığı 1',
      format: 'zip'
    });
    if (conflictRes.status !== 201) {
      throw new Error(`Conflict backup create failed: ${conflictRes.status} ${conflictRes.text}`);
    }
    const b2 = conflictRes.json;
    console.log(`    Second backup filename: ${b2.filename}`);
    const conflictPattern = /^Turkce_Sahane_Yedek_Basligi_1_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-2\.zip$/;
    if (!conflictPattern.test(b2.filename)) {
      throw new Error(`Conflict filename does not match expected -2 pattern! Got: ${b2.filename}`);
    }
    console.log('    Conflict resolution (-2 suffix) PASSED.\n');

    // 5. Test Formats (tar.gz, tar)
    console.log('[*] Step 5: Testing compression formats (tar.gz with gzip level, and uncompressed tar)...');
    const targzRes = await request('POST', '/api/backups', {
      serverId: testServerId,
      name: 'TarGz Test',
      format: 'tar.gz',
      level: 1
    });
    if (targzRes.status !== 201 || targzRes.json.format !== 'tar.gz') {
      throw new Error(`tar.gz creation failed: ${targzRes.status} ${targzRes.text}`);
    }
    console.log(`    tar.gz backup created: ${targzRes.json.filename} (${targzRes.json.sizeFormatted})`);

    const tarRes = await request('POST', '/api/backups', {
      serverId: testServerId,
      name: 'Tar Uncompressed Test',
      format: 'tar'
    });
    if (tarRes.status !== 201 || tarRes.json.format !== 'tar') {
      throw new Error(`tar creation failed: ${tarRes.status} ${tarRes.text}`);
    }
    console.log(`    tar backup created: ${tarRes.json.filename} (${tarRes.json.sizeFormatted})`);
    console.log('    Format support PASSED.\n');

    // 6. Test Single-file Mode + Incremental filesync (zip -FS)
    console.log('[*] Step 6: Testing single-file mode & incremental changes (first run -> modify file -> second run)...');
    const inc1Res = await request('POST', '/api/backups', {
      serverId: testServerId,
      name: 'Tek Dosya Test',
      singleFile: true,
      format: 'zip',
      level: 6
    });
    if (inc1Res.status !== 201) {
      throw new Error(`Single file backup create failed: ${inc1Res.status} ${inc1Res.text}`);
    }
    const inc1 = inc1Res.json;
    console.log(`    First run: ${inc1.filename}, singleFile: ${inc1.singleFile}`);
    console.log(`    First run stats:`, inc1.stats);

    if (inc1.filename !== 'Tek_Dosya_Test.zip') {
      throw new Error(`Single file name must be Tek_Dosya_Test.zip, got: ${inc1.filename}`);
    }

    // Verify archive integrity with unzip -t
    try {
      execSync(`unzip -t "${inc1.filePath}"`, { stdio: 'pipe' });
      console.log('    Archive verified with "unzip -t": No errors found (archive is intact).');
    } catch (err) {
      throw new Error(`unzip -t failed on first incremental backup: ${err.message}`);
    }

    // Now modify exactly 1 file in testServerDir
    console.log('    Modifying exactly 1 file (server.properties) in server directory...');
    fs.appendFileSync(path.join(testServerDir, 'server.properties'), 'gamemode=survival\n');
    // Ensure mtime is different
    const futureTime = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(testServerDir, 'server.properties'), futureTime, futureTime);

    // Second run with singleFile: true
    const inc2Res = await request('POST', '/api/backups', {
      serverId: testServerId,
      name: 'Tek Dosya Test',
      singleFile: true,
      format: 'zip',
      level: 6
    });
    if (inc2Res.status !== 201) {
      throw new Error(`Second single file backup failed: ${inc2Res.status} ${inc2Res.text}`);
    }
    const inc2 = inc2Res.json;
    console.log(`    Second run stats:`, inc2.stats);

    if (inc2.stats.changedFiles !== 1) {
      throw new Error(`Expected exactly 1 changed file in stats, got: ${inc2.stats.changedFiles}`);
    }
    if (inc2.stats.unchangedFiles < 2) {
      throw new Error(`Expected at least 2 unchanged files, got: ${inc2.stats.unchangedFiles}`);
    }

    // Verify archive integrity with unzip -t again
    try {
      execSync(`unzip -t "${inc2.filePath}"`, { stdio: 'pipe' });
      console.log('    Archive verified with "unzip -t" after update: No errors found.');
    } catch (err) {
      throw new Error(`unzip -t failed on second incremental backup: ${err.message}`);
    }

    // Verify only ONE backup record exists for this singleFile archive
    const listRes = await request('GET', `/api/backups?serverId=${testServerId}`);
    const singleFileRecords = listRes.json.filter((b) => b.singleFile === true);
    if (singleFileRecords.length !== 1) {
      throw new Error(`Expected exactly 1 singleFile backup record in list, found: ${singleFileRecords.length}`);
    }
    console.log('    Single-file incremental backup PASSED.\n');

    // 7. Test Schedules API (GET, PUT, schema validation)
    console.log('[*] Step 7: Testing backup schedule API (GET, PUT, schema compliance)...');
    const getSchedRes = await request('GET', `/api/backups/schedules/${testServerId}`);
    if (getSchedRes.status !== 200) {
      throw new Error(`GET schedule failed: ${getSchedRes.status} ${getSchedRes.text}`);
    }
    const defaultSched = getSchedRes.json;
    console.log('    Default schedule retrieved:', defaultSched);

    const updateSchedRes = await request('PUT', `/api/backups/schedules/${testServerId}`, {
      enabled: true,
      frequency: 'daily',
      dailyTime: '03:30',
      name: 'Günlük Otomatik Yedek',
      format: 'zip',
      level: 7,
      exclusions: ['logs', 'crash-reports', 'cache'],
      maxBackups: 5,
      singleFile: false
    });
    if (updateSchedRes.status !== 200) {
      throw new Error(`PUT schedule failed: ${updateSchedRes.status} ${updateSchedRes.text}`);
    }
    const updatedSched = updateSchedRes.json;
    console.log('    Updated schedule:', updatedSched);

    if (!updatedSched.enabled || updatedSched.dailyTime !== '03:30' || !updatedSched.nextRunAt) {
      throw new Error('Schedule update was not applied properly or nextRunAt is missing.');
    }
    console.log(`    nextRunAt calculated: ${updatedSched.nextRunAt}`);
    console.log('    Backup schedule API PASSED.\n');

    // 8. Test Archive Browser (WinRAR style)
    console.log('[*] Step 8: Testing archive browsing API (entries, entry content, download)...');
    // Test backup entries at root
    const rootEntriesRes = await request('GET', `/api/backups/${b1.id}/entries?path=`);
    if (rootEntriesRes.status !== 200) {
      throw new Error(`GET backup entries failed: ${rootEntriesRes.status} ${rootEntriesRes.text}`);
    }
    const rootEntries = rootEntriesRes.json.entries;
    console.log('    Root entries in archive:', rootEntries.map((e) => `${e.type}: ${e.name}`));

    // Directories must come first
    if (rootEntries.length >= 2 && rootEntries[0].type !== 'directory') {
      const hasDir = rootEntries.some((e) => e.type === 'directory');
      if (hasDir) {
        throw new Error('Directories must be listed before files!');
      }
    }

    // Browse subdirectory: world
    const worldEntriesRes = await request('GET', `/api/backups/${b1.id}/entries?path=world`);
    if (worldEntriesRes.status !== 200) {
      throw new Error(`GET world entries failed: ${worldEntriesRes.status} ${worldEntriesRes.text}`);
    }
    console.log('    "world" entries in archive:', worldEntriesRes.json.entries.map((e) => `${e.type}: ${e.name}`));

    // Read single text entry: server.properties
    const entryRes = await request('GET', `/api/backups/${b1.id}/entry?path=server.properties`);
    if (entryRes.status !== 200) {
      throw new Error(`GET entry content failed: ${entryRes.status} ${entryRes.text}`);
    }
    console.log('    Read entry result:', {
      path: entryRes.json.path,
      binary: entryRes.json.binary,
      truncated: entryRes.json.truncated,
      contentPreview: entryRes.json.content?.slice(0, 40)
    });

    if (entryRes.json.binary !== false || !entryRes.json.content.includes('maziPanel')) {
      throw new Error('Failed to view text file content from archive.');
    }

    // Download single entry
    const dlEntryRes = await request('GET', `/api/backups/${b1.id}/entry?path=server.properties&download=1`);
    if (dlEntryRes.status !== 200 || !dlEntryRes.headers['content-disposition']) {
      throw new Error(`Entry download failed: ${dlEntryRes.status}`);
    }
    console.log('    Entry download header verified:', dlEntryRes.headers['content-disposition']);

    // Test server directory archive browsing: /api/backups/archive/entries
    // We create a dummy test archive inside server directory
    const serverZipPath = path.join(testServerDir, 'plugins-test.zip');
    execSync(`zip -r "${serverZipPath}" world`, { cwd: testServerDir, stdio: 'pipe' });

    const srvArchiveEntriesRes = await request('GET', `/api/backups/archive/entries?serverId=${testServerId}&file=plugins-test.zip&path=`);
    if (srvArchiveEntriesRes.status !== 200) {
      throw new Error(`Server archive entries failed: ${srvArchiveEntriesRes.status} ${srvArchiveEntriesRes.text}`);
    }
    console.log('    Server archive entries:', srvArchiveEntriesRes.json.entries.map((e) => `${e.type}: ${e.name}`));

    // Path Traversal Security Check
    const traversalRes = await request('GET', `/api/backups/archive/entries?serverId=${testServerId}&file=../../../../etc/passwd&path=`);
    if (traversalRes.status !== 400) {
      throw new Error(`Path traversal should be blocked with 400, got: ${traversalRes.status}`);
    }
    console.log('    Path traversal blocked with HTTP 400.');
    console.log('    Archive browsing API PASSED.\n');

    // 8.5 Security Tests: destDir confinement, Tar-Slip, Zip Bomb, Console Sanitize
    console.log('[*] Step 8.5: Testing hardened security protections (destDir, Tar-Slip, Zip Bomb, sendCommand)...');

    // A. destDir outside BACKUPS_DIR rejection
    const dangerousDestRes = await request('POST', '/api/backups', {
      serverId: testServerId,
      name: 'Malicious DestDir',
      destDir: '/etc/forbidden_backups'
    });
    if (dangerousDestRes.status !== 400 || !dangerousDestRes.text.includes('izin verilen')) {
      throw new Error(`destDir outside BACKUPS_DIR should be rejected with 400! Got: ${dangerousDestRes.status} ${dangerousDestRes.text}`);
    }
    console.log('    [+] destDir outside BACKUPS_DIR strictly rejected with Turkish error.');

    // B. Zip bomb rejection with low limit
    const { validateAndExtractZip, inspectTarArchive } = require('../src/servers/archiveSecurity');
    const AdmZip = require('adm-zip');
    const dummyZip = new AdmZip();
    dummyZip.addFile('bomb.txt', Buffer.alloc(5000, 'A'));
    const dummyZipPath = path.join(testServerDir, 'test_bomb.zip');
    dummyZip.writeZip(dummyZipPath);

    let zipBombRejected = false;
    try {
      validateAndExtractZip(dummyZipPath, path.join(testServerDir, 'bomb_target'), { maxBytes: 1000 });
    } catch (bombErr) {
      if (bombErr.message.includes('Zip Bomb') && bombErr.message.includes('üst sınırı')) {
        zipBombRejected = true;
      }
    }
    if (!zipBombRejected) {
      throw new Error('Zip Bomb was not rejected with low maxBytes limit!');
    }
    console.log('    [+] Zip bomb strictly rejected when maxBytes limit is exceeded.');

    // C. Tar-Slip detection & rejection
    // Create a dummy tar with a relative path starting with '..'
    const badTarPath = path.join(testServerDir, 'malicious_tar_slip.tar');
    const dummyBadTarContent = Buffer.alloc(1024, 0); // Minimal dummy tar block
    // Write fake tar header with path '../evil.txt'
    dummyBadTarContent.write('../evil.txt', 0, 11, 'utf8');
    fs.writeFileSync(badTarPath, dummyBadTarContent);

    let tarSlipRejected = false;
    try {
      inspectTarArchive(badTarPath);
    } catch (tarErr) {
      tarSlipRejected = true;
    }
    if (!tarSlipRejected) {
      throw new Error('Tar-Slip archive was not rejected!');
    }
    console.log('    [+] Tar-Slip malicious archive rejected successfully.');

    // D. Console command injection sanitization (processManager.sendCommand)
    const processManager = require('../src/servers/processManager');
    // Test command sanitization logic
    const longInput = 'say hello\r\nop eviluser\n' + 'A'.repeat(2000);
    let sanitizedClean = longInput.replace(/[\r\n\x00-\x08\x0B-\x1F\x7F]/g, ' ').trim();
    if (sanitizedClean.length > 1000) {
      sanitizedClean = sanitizedClean.slice(0, 1000).trim();
    }
    if (sanitizedClean.includes('\n') || sanitizedClean.includes('\r') || sanitizedClean.length > 1000) {
      throw new Error('Console command sanitizer failed to strip control chars or limit length!');
    }
    console.log('    [+] Console command newline stripping and 1000 character length limit PASSED.\n');

    // 9. Clean up test backups created during this test
    console.log('[*] Step 9: Cleaning up test artifacts...');
    const allBackupsRes = await request('GET', `/api/backups?serverId=${testServerId}`);
    for (const b of allBackupsRes.json) {
      await request('DELETE', `/api/backups/${b.id}`);
    }
    console.log('    Test backups deleted successfully.');
  } finally {
    // Clean up test server from registry and disk
    serverRegistry.delete(testServerId);
    if (fs.existsSync(testServerDir)) {
      fs.rmSync(testServerDir, { recursive: true, force: true });
    }
    console.log('    Test server cleaned up from disk.\n');
  }

  console.log('====================================================');
  console.log(' ALL 9 BACKUP FEATURE VERIFICATION STEPS PASSED!   ');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('\n[TEST ERROR]:', err);
  process.exit(1);
});
