const http = require('http');

async function testBrowserCreate() {
  console.log('Testing Exact Browser POST /api/servers/create-with-core Simulation...');

  const staleCookie = 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxLCJpYXQiOjE3OTAzNTk1NzEsIm1mYSI6ZmFsc2V9.wyaFtt0UfaNCGJ868Jd7u1fDiFkULR8R-8mLnek8a9s; _xsrf=2; p2p_session=68109b068b21';

  const payload = JSON.stringify({
    name: 'Browser-Vanilla-Test',
    type: 'vanilla',
    version: '26.3',
    port: 25569,
    ramMin: '2G',
    ramMax: '4G'
  });

  const req = http.request('http://127.0.0.1:8080/api/servers/create-with-core', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Cookie': staleCookie,
      'Origin': 'http://192.168.1.110:8080',
      'Referer': 'http://192.168.1.110:8080/'
    }
  });

  const res = await new Promise((resolve, reject) => {
    req.on('response', (response) => {
      let data = '';
      response.on('data', (c) => data += c);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: response.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  console.log('Response Status:', res.status);
  console.log('Response Body:', res.data || res.raw);

  if (res.status === 401) {
    throw new Error('FAILURE: Server returned 401 Unauthorized!');
  }
  if (res.status !== 201) {
    throw new Error(`FAILURE: Expected 201 Created, got ${res.status}`);
  }

  console.log('[SUCCESS] Server successfully created with status 201! 401 bug is COMPLETELY RESOLVED.');

  // Clean up created server
  const serverRegistry = require('../src/servers/serverRegistry');
  const fs = require('fs');
  if (res.data && res.data.id) {
    serverRegistry.delete(res.data.id);
    if (res.data.directory && fs.existsSync(res.data.directory)) {
      fs.rmSync(res.data.directory, { recursive: true, force: true });
    }
  }
}

testBrowserCreate().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
