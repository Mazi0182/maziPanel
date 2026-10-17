const http = require('http');
const assert = require('assert');

const PORT = process.env.TEST_PORT || process.env.PORT || '8080';
const HOST = process.env.TEST_HOST || 'localhost';
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;

function post(url, data, token = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, BASE_URL);
    const body = JSON.stringify(data);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(u, { method: 'POST', headers }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(d) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: d });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(url, token = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, BASE_URL);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(u, { method: 'GET', headers }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(d) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: d });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function verify() {
  console.log(`--- 1. Authenticating (port ${PORT}) ---`);
  const auth = await post(`${BASE_URL}/api/auth/login`, {
    username: 'masteradmin',
    password: 'AdminPassword123!'
  });
  assert.strictEqual(auth.status, 200, `Authentication failed: HTTP ${auth.status}`);
  assert(auth.data && typeof auth.data.token === 'string' && auth.data.token.length > 0, 'Auth response must include non-empty token string');
  const token = auth.data.token;
  console.log('Authenticated, token length:', token.length);

  console.log('\n--- 2. List Backups ---');
  const list = await get(`${BASE_URL}/api/backups`, token);
  assert.strictEqual(list.status, 200, `List backups failed: HTTP ${list.status}`);
  assert(Array.isArray(list.data), 'Backups list response must be an array');
  console.log(`Found ${list.data.length} backups:`);
  list.data.forEach((b) => {
    assert(b.id, 'Backup entry must have id');
    assert(b.filename, 'Backup entry must have filename');
    console.log(`  - [${b.id}] ${b.filename} (${b.sizeFormatted}) exists:${b.exists}`);
  });

  const zipBackup = list.data.find((b) => b.filePath && b.filePath.endsWith('.zip'));
  const tarBackup = list.data.find((b) => b.filePath && b.filePath.endsWith('.tar.gz'));

  // Ensure QA fixtures have both formats tested (no accidental all-skipped success)
  if (list.data.length > 0) {
    assert(zipBackup, 'QA fixtures / backups list must include at least one .zip backup');
    assert(tarBackup, 'QA fixtures / backups list must include at least one .tar.gz backup');
  }

  if (zipBackup) {
    console.log(`\n--- 3. Browse Archive Entries (${zipBackup.id}) Root ---`);
    const entries = await get(`${BASE_URL}/api/backups/${zipBackup.id}/entries?path=`, token);
    assert.strictEqual(entries.status, 200, `Browse zip entries failed: HTTP ${entries.status}`);
    assert(entries.data && Array.isArray(entries.data.entries), 'Zip entries response must contain entries array');
    console.log(`Direct root children count: ${entries.data.entries.length}`);
    console.log('Sample entries:', entries.data.entries.slice(0, 8));

    // Try reading a known file like server.properties
    console.log(`\n--- 4. Read Entry Content (server.properties) ---`);
    const content = await get(`${BASE_URL}/api/backups/${zipBackup.id}/entry?path=server.properties`, token);
    assert.strictEqual(content.status, 200, `Read entry failed: HTTP ${content.status}`);
    assert(content.data && typeof content.data.path === 'string', 'Entry content must include path');
    assert.strictEqual(typeof content.data.truncated, 'boolean', 'Entry content must include truncated boolean');
    console.log('server.properties preview:', {
      path: content.data.path,
      binary: content.data.binary,
      truncated: content.data.truncated,
      lines: content.data.content ? content.data.content.split('\n').slice(0, 5) : null
    });
  }

  if (tarBackup) {
    console.log(`\n--- 5. Browse tar.gz Archive Entries (${tarBackup.id}) Root ---`);
    const tarEntries = await get(`${BASE_URL}/api/backups/${tarBackup.id}/entries?path=`, token);
    assert.strictEqual(tarEntries.status, 200, `Browse tar.gz entries failed: HTTP ${tarEntries.status}`);
    assert(tarEntries.data && Array.isArray(tarEntries.data.entries), 'tar.gz entries response must contain entries array');
    console.log(`Tar.gz direct root children count: ${tarEntries.data.entries.length}`);
    console.log('Sample tar.gz entries:', tarEntries.data.entries.slice(0, 6));
  }

  console.log('\n--- 6. Test Schedules for test-mv2n0bep ---');
  const sched = await get(`${BASE_URL}/api/backups/schedules/test-mv2n0bep`, token);
  assert.strictEqual(sched.status, 200, `Get backup schedules failed: HTTP ${sched.status}`);
  assert(sched.data && typeof sched.data === 'object', 'Backup schedules response must be an object');
  console.log('Current schedule:', sched.data);

  console.log('\n--- VERIFICATION COMPLETE ---');
}

verify().catch((err) => {
  console.error('[!] VERIFICATION FAILED:', err);
  process.exit(1);
});
